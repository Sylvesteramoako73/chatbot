import "dotenv/config";
import express, { Request, Response } from "express";
import cors from "cors";
import path from "path";
import { streamChatResponse, ChatMessage, NEEDS_HUMAN_MARKER } from "./chat";
import { ingestDocument, ingestWebsite } from "./ingest";
import {
  createSessionMiddleware,
  signup,
  login,
  logout,
  requireAuth,
  requireAdmin,
  listTeamMembers,
  addTeamMember,
} from "./auth";
import {
  getBusinessById,
  getBusinessBySiteKey,
  getBusinessByWhatsAppPhoneNumberId,
  getBusinessByInstagramPageId,
  updateBusinessSettings,
} from "./businesses";
import {
  Conversation,
  getOrCreateConversation,
  getConversationById,
  recordMessage,
  getMessages,
  markConversationRead,
  listConversations,
  ConversationFilter,
  claimConversation,
  assignConversation,
  closeConversation,
  requestHuman,
  relayReplyToWidget,
} from "./conversations";
import { subscribeToConversation, subscribeToBusiness } from "./events";
import { sendWhatsAppText } from "./whatsapp";
import { sendTelegramMessage, setTelegramWebhook } from "./telegram";
import { sendInstagramMessage } from "./instagram";
import { handleInboundMessage } from "./bot";
import { savePushSubscription, deletePushSubscription, PushSubscriptionJSON } from "./push";
import { notifyTeamMemberOfAssignment } from "./notifications";
import {
  listLeads,
  getLeadWithConversations,
  updateLeadStage,
  updateLeadDetails,
  mergeConversationIntoLead,
  LeadStage,
} from "./leads";
import { getAnalyticsSummary } from "./analytics";

const app = express();
app.set("trust proxy", true); // needed so req.protocol reflects https behind Render's proxy
app.use(cors({ origin: true })); // public widget API — see README for why this is intentionally open
app.use(express.json({ limit: "2mb" }));
app.use(createSessionMiddleware());
app.use("/widget", express.static(path.join(__dirname, "..", "public")));
app.use("/dashboard", express.static(path.join(__dirname, "..", "public", "dashboard")));
app.use(express.static(path.join(__dirname, "..", "public", "site"))); // marketing landing page at "/"

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

app.post("/api/auth/signup", (req, res) => void signup(req, res));
app.post("/api/auth/login", (req, res) => void login(req, res));
app.post("/api/auth/logout", logout);

app.get("/api/auth/me", requireAuth, async (req: Request, res: Response) => {
  const business = await getBusinessById(req.session.businessId!);
  res.json({ businessId: req.session.businessId, teamMemberId: req.session.teamMemberId, role: req.session.role, business });
});

// ---------------------------------------------------------------------------
// Public widget chat API — access is scoped by siteKey, not by CORS origin
// (a JSON POST triggers a CORS preflight before the body/siteKey is ever
// sent, so origin-based gating can't happen at the cors() layer here).
// ---------------------------------------------------------------------------

// Held back from the live stream so we can detect (and strip) NEEDS_HUMAN_MARKER (15 chars) before
// it ever reaches the customer. Kept small — for short replies, a big reserve here would withhold
// a large fraction of the message until the very end, making fast responses look like they arrived
// in one dump instead of streaming.
const MARKER_TAIL_BUFFER = 24;

async function runBotReplyForWidget(
  conversation: Conversation,
  business: Awaited<ReturnType<typeof getBusinessById>>,
  message: string,
  history: ChatMessage[],
  res: Response
): Promise<void> {
  let full = "";
  let tail = "";
  for await (const token of streamChatResponse(conversation.businessId, business?.name ?? "the business", business?.systemPrompt ?? null, message, history)) {
    full += token;
    tail += token;
    if (tail.length > MARKER_TAIL_BUFFER) {
      const flushLength = tail.length - MARKER_TAIL_BUFFER;
      res.write(tail.slice(0, flushLength));
      tail = tail.slice(flushLength);
    }
  }

  const needsHuman = full.includes(NEEDS_HUMAN_MARKER);
  res.write(needsHuman ? tail.replace(NEEDS_HUMAN_MARKER, "").replace(/\s+$/, "") : tail);
  res.end();

  const visibleFull = needsHuman ? full.replace(NEEDS_HUMAN_MARKER, "").replace(/\s+$/, "") : full;
  await recordMessage(conversation, "bot", visibleFull);

  if (needsHuman) {
    await requestHuman(conversation.id);
    relayReplyToWidget(conversation, "I've flagged this for our team — they'll jump in here shortly.", {
      type: "handoff",
      role: "system",
    });
  }
}

app.post("/api/chat", async (req: Request, res: Response) => {
  const { siteKey, message, history, sessionId } = req.body as {
    siteKey?: string;
    message?: string;
    history?: ChatMessage[];
    sessionId?: string;
  };
  if (!siteKey || !message || !sessionId) {
    return res.status(400).json({ error: "siteKey, sessionId, and message are required" });
  }

  const business = await getBusinessBySiteKey(siteKey);
  if (!business) return res.status(404).json({ error: "Unknown site key" });

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Transfer-Encoding", "chunked");

  try {
    const conversation = await getOrCreateConversation(business.id, "widget", sessionId);
    await recordMessage(conversation, "customer", message);

    if (conversation.mode === "human") {
      res.end(); // an agent will reply from the dashboard; delivered over the SSE stream below
      return;
    }

    await runBotReplyForWidget(conversation, business, message, Array.isArray(history) ? history : [], res);
  } catch (err) {
    console.error("Chat error:", err);
    if (!res.headersSent) res.status(500).json({ error: "Internal error" });
    else res.end();
  }
});

app.post("/api/chat/handoff", async (req: Request, res: Response) => {
  const { siteKey, sessionId } = req.body as { siteKey?: string; sessionId?: string };
  if (!siteKey || !sessionId) return res.status(400).json({ error: "siteKey and sessionId are required" });

  const business = await getBusinessBySiteKey(siteKey);
  if (!business) return res.status(404).json({ error: "Unknown site key" });

  try {
    const conversation = await getOrCreateConversation(business.id, "widget", sessionId);
    await requestHuman(conversation.id);
    res.json({ status: "requested" });
  } catch (err) {
    console.error("Handoff error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

app.post("/api/chat/name", async (req: Request, res: Response) => {
  const { siteKey, sessionId, name } = req.body as { siteKey?: string; sessionId?: string; name?: string };
  if (!siteKey || !sessionId || !name) {
    return res.status(400).json({ error: "siteKey, sessionId, and name are required" });
  }

  const business = await getBusinessBySiteKey(siteKey);
  if (!business) return res.status(404).json({ error: "Unknown site key" });

  try {
    // leadHint only applies when this call is what creates the conversation/lead — if the visitor
    // already said something before naming themselves, the lead already exists, so also update it
    // directly (updateLeadDetails only fills in a still-blank name, never overwrites one already set).
    const conversation = await getOrCreateConversation(business.id, "widget", sessionId, { name });
    await recordMessage(conversation, "customer", name);
    if (conversation.leadId) await updateLeadDetails(conversation.leadId, { name });
    res.json({ name });
  } catch (err) {
    console.error("Name capture error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

app.get("/api/chat/stream", (req: Request, res: Response) => {
  const { siteKey, sessionId } = req.query as { siteKey?: string; sessionId?: string };
  if (!siteKey || !sessionId) return res.status(400).end();

  void (async () => {
    const business = await getBusinessBySiteKey(siteKey);
    if (!business) return res.status(404).end();
    const conversation = await getOrCreateConversation(business.id, "widget", sessionId);

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const unsubscribe = subscribeToConversation(conversation.id, (event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 30000);

    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  })();
});

// ---------------------------------------------------------------------------
// WhatsApp webhook — shared URL and verify token across all tenants; the
// specific business is resolved per-message from Meta's phone_number_id.
// ---------------------------------------------------------------------------

app.get("/api/webhooks/whatsapp", (req: Request, res: Response) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post("/api/webhooks/whatsapp", async (req: Request, res: Response) => {
  // Acknowledge immediately — Meta retries aggressively on non-200s/timeouts.
  res.sendStatus(200);

  try {
    const entries = req.body?.entry ?? [];
    for (const entry of entries) {
      for (const change of entry.changes ?? []) {
        const phoneNumberId = change.value?.metadata?.phone_number_id;
        if (!phoneNumberId) continue;
        const business = await getBusinessByWhatsAppPhoneNumberId(phoneNumberId);
        if (!business) {
          console.warn(`WhatsApp webhook: no business registered for phone_number_id ${phoneNumberId}`);
          continue;
        }
        if (!business.whatsappToken || !business.whatsappPhoneNumberId) continue;

        for (const message of change.value?.messages ?? []) {
          if (message.type !== "text") continue;
          const profileName = change.value?.contacts?.[0]?.profile?.name;
          await handleInboundMessage(business, "whatsapp", message.from, message.text.body, { name: profileName }, (replyText) =>
            sendWhatsAppText(
              { token: business.whatsappToken!, phoneNumberId: business.whatsappPhoneNumberId! },
              message.from,
              replyText
            )
          );
        }
      }
    }
  } catch (err) {
    console.error("WhatsApp webhook error:", err);
  }
});

// ---------------------------------------------------------------------------
// Telegram webhook — each business gets its own bot (from @BotFather), so
// unlike Meta's products there's no shared identifier to route by; the
// business is resolved straight from the URL path instead. Setting the
// webhook itself is automatic (see setTelegramWebhook, called from the
// settings route below) rather than a manual dashboard step.
// ---------------------------------------------------------------------------

app.post("/api/webhooks/telegram/:businessId", async (req: Request, res: Response) => {
  res.sendStatus(200); // acknowledge immediately, same reasoning as the WhatsApp webhook

  try {
    const business = await getBusinessById(req.params.businessId);
    if (!business || !business.telegramBotToken) return;

    const message = req.body?.message;
    if (!message?.text || !message?.chat?.id) return;

    const chatId = String(message.chat.id);
    const name = message.from?.first_name ?? message.from?.username;

    await handleInboundMessage(business, "telegram", chatId, message.text, { name }, (replyText) =>
      sendTelegramMessage(business.telegramBotToken!, chatId, replyText)
    );
  } catch (err) {
    console.error("Telegram webhook error:", err);
  }
});

// ---------------------------------------------------------------------------
// Instagram webhook — same Meta Graph API family as WhatsApp, shared verify
// token, business resolved by the Instagram-scoped Page id in the payload.
// ---------------------------------------------------------------------------

app.get("/api/webhooks/instagram", (req: Request, res: Response) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post("/api/webhooks/instagram", async (req: Request, res: Response) => {
  res.sendStatus(200);

  try {
    const entries = req.body?.entry ?? [];
    for (const entry of entries) {
      const pageId = entry.id;
      if (!pageId) continue;
      const business = await getBusinessByInstagramPageId(pageId);
      if (!business) {
        console.warn(`Instagram webhook: no business registered for page id ${pageId}`);
        continue;
      }
      if (!business.instagramToken || !business.instagramPageId) continue;

      for (const event of entry.messaging ?? []) {
        const igsid = event.sender?.id;
        const text = event.message?.text;
        if (!igsid || !text) continue;

        await handleInboundMessage(business, "instagram", igsid, text, {}, (replyText) =>
          sendInstagramMessage(
            { pageId: business.instagramPageId!, token: business.instagramToken! },
            igsid,
            replyText
          )
        );
      }
    }
  } catch (err) {
    console.error("Instagram webhook error:", err);
  }
});

// ---------------------------------------------------------------------------
// Dashboard API — team-inbox for picking up and replying to conversations
// ---------------------------------------------------------------------------

async function loadOwnedConversation(req: Request, res: Response): Promise<Conversation | null> {
  const conversation = await getConversationById(req.params.id);
  if (!conversation || conversation.businessId !== req.session.businessId) {
    res.status(404).json({ error: "Conversation not found" });
    return null;
  }
  return conversation;
}

app.get("/api/dashboard/conversations", requireAuth, async (req: Request, res: Response) => {
  const filter = (req.query.filter as ConversationFilter) ?? "all";
  const conversations = await listConversations(req.session.businessId!, filter, req.session.teamMemberId!);
  res.json({ conversations });
});

app.get("/api/dashboard/conversations/:id/messages", requireAuth, async (req: Request, res: Response) => {
  const conversation = await loadOwnedConversation(req, res);
  if (!conversation) return;
  const messages = await getMessages(conversation.id);
  await markConversationRead(conversation.id); // opening a conversation is what marks it read
  res.json({ conversation, messages });
});

app.post("/api/dashboard/conversations/:id/claim", requireAuth, async (req: Request, res: Response) => {
  const conversation = await loadOwnedConversation(req, res);
  if (!conversation) return;
  const claimed = await claimConversation(conversation.id, req.session.teamMemberId!);
  if (!claimed) return res.status(409).json({ error: "Already claimed by someone else" });
  res.json({ conversation: claimed });
});

app.post("/api/dashboard/conversations/:id/assign", requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const conversation = await loadOwnedConversation(req, res);
  if (!conversation) return;

  const { teamMemberId } = req.body as { teamMemberId?: string };
  if (!teamMemberId) return res.status(400).json({ error: "teamMemberId is required" });

  const team = await listTeamMembers(req.session.businessId!);
  const target = team.find((member) => member.id === teamMemberId);
  if (!target) return res.status(400).json({ error: "That person isn't on this business's team" });

  const assigned = await assignConversation(conversation.id, teamMemberId);
  void notifyTeamMemberOfAssignment(teamMemberId, target.email, assigned);
  res.json({ conversation: assigned });
});

app.post("/api/dashboard/conversations/:id/close", requireAuth, async (req: Request, res: Response) => {
  const conversation = await loadOwnedConversation(req, res);
  if (!conversation) return;
  res.json({ conversation: await closeConversation(conversation.id) });
});

app.post("/api/dashboard/conversations/:id/reply", requireAuth, async (req: Request, res: Response) => {
  const conversation = await loadOwnedConversation(req, res);
  if (!conversation) return;

  const { text } = req.body as { text?: string };
  if (!text) return res.status(400).json({ error: "text is required" });

  try {
    let messageId: string | null = null;

    if (conversation.channel === "widget") {
      relayReplyToWidget(conversation, text);
    } else if (conversation.channel === "whatsapp") {
      const business = await getBusinessById(conversation.businessId);
      if (!business?.whatsappToken || !business.whatsappPhoneNumberId) {
        return res.status(400).json({ error: "This business hasn't connected WhatsApp credentials yet" });
      }
      messageId = await sendWhatsAppText(
        { token: business.whatsappToken, phoneNumberId: business.whatsappPhoneNumberId },
        conversation.externalId,
        text
      );
    } else if (conversation.channel === "telegram") {
      const business = await getBusinessById(conversation.businessId);
      if (!business?.telegramBotToken) {
        return res.status(400).json({ error: "This business hasn't connected Telegram yet" });
      }
      messageId = await sendTelegramMessage(business.telegramBotToken, conversation.externalId, text);
    } else if (conversation.channel === "instagram") {
      const business = await getBusinessById(conversation.businessId);
      if (!business?.instagramToken || !business.instagramPageId) {
        return res.status(400).json({ error: "This business hasn't connected Instagram yet" });
      }
      messageId = await sendInstagramMessage(
        { pageId: business.instagramPageId, token: business.instagramToken },
        conversation.externalId,
        text
      );
    }

    await recordMessage(conversation, "agent", text, messageId);
    res.json({ status: "sent" });
  } catch (err) {
    console.error("Dashboard reply error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

app.get("/api/dashboard/stream", requireAuth, (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const unsubscribe = subscribeToBusiness(req.session.businessId!, (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 30000);

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

app.get("/api/dashboard/settings", requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const business = await getBusinessById(req.session.businessId!);
  res.json({ business });
});

app.put("/api/dashboard/settings", requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const {
    systemPrompt,
    allowedOrigin,
    whatsappToken,
    whatsappPhoneNumberId,
    whatsappTemplateName,
    telegramBotToken,
    instagramPageId,
    instagramToken,
  } = req.body;

  const business = await updateBusinessSettings(req.session.businessId!, {
    systemPrompt,
    allowedOrigin,
    whatsappToken,
    whatsappPhoneNumberId,
    whatsappTemplateName,
    telegramBotToken,
    instagramPageId,
    instagramToken,
  });

  // Telegram has no separate "register this webhook in a dashboard" step like WhatsApp/Instagram —
  // saving the token here is the whole setup, so we register it with Telegram ourselves.
  if (telegramBotToken) {
    try {
      const webhookUrl = `${req.protocol}://${req.get("host")}/api/webhooks/telegram/${business.id}`;
      await setTelegramWebhook(telegramBotToken, webhookUrl);
    } catch (err) {
      console.error("Telegram webhook registration failed:", err);
      return res.status(400).json({ error: "Saved, but registering the Telegram webhook failed — check the bot token" });
    }
  }

  res.json({ business });
});

app.get("/api/dashboard/team", requireAuth, async (req: Request, res: Response) => {
  res.json({ team: await listTeamMembers(req.session.businessId!) });
});

app.post("/api/dashboard/team", requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const { email, password, name, role } = req.body as {
    email?: string;
    password?: string;
    name?: string;
    role?: "admin" | "agent";
  };
  if (!email || !password || !name) {
    return res.status(400).json({ error: "email, password, and name are required" });
  }
  const id = await addTeamMember(req.session.businessId!, email, password, name, role ?? "agent");
  res.json({ id });
});

// ---------------------------------------------------------------------------
// Push notifications — so a rep gets pinged even when the dashboard tab isn't open
// ---------------------------------------------------------------------------

app.get("/api/dashboard/push/public-key", requireAuth, (_req: Request, res: Response) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY ?? null });
});

app.post("/api/dashboard/push/subscribe", requireAuth, async (req: Request, res: Response) => {
  const subscription = req.body as PushSubscriptionJSON;
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    return res.status(400).json({ error: "A valid push subscription object is required" });
  }
  await savePushSubscription(req.session.teamMemberId!, subscription);
  res.json({ status: "subscribed" });
});

app.post("/api/dashboard/push/unsubscribe", requireAuth, async (req: Request, res: Response) => {
  const { endpoint } = req.body as { endpoint?: string };
  if (!endpoint) return res.status(400).json({ error: "endpoint is required" });
  await deletePushSubscription(endpoint);
  res.json({ status: "unsubscribed" });
});

// ---------------------------------------------------------------------------
// Leads / CRM pipeline
// ---------------------------------------------------------------------------

app.get("/api/dashboard/leads", requireAuth, async (req: Request, res: Response) => {
  res.json({ leads: await listLeads(req.session.businessId!) });
});

app.get("/api/dashboard/leads/:id", requireAuth, async (req: Request, res: Response) => {
  const lead = await getLeadWithConversations(req.params.id);
  if (!lead || lead.businessId !== req.session.businessId) {
    return res.status(404).json({ error: "Lead not found" });
  }
  res.json({ lead });
});

app.put("/api/dashboard/leads/:id", requireAuth, async (req: Request, res: Response) => {
  const lead = await getLeadWithConversations(req.params.id);
  if (!lead || lead.businessId !== req.session.businessId) {
    return res.status(404).json({ error: "Lead not found" });
  }

  const { stage, name, phone, email, notes } = req.body as {
    stage?: LeadStage;
    name?: string;
    phone?: string;
    email?: string;
    notes?: string;
  };

  if (stage) await updateLeadStage(lead.id, stage);
  if (name !== undefined || phone !== undefined || email !== undefined || notes !== undefined) {
    await updateLeadDetails(lead.id, { name, phone, email, notes });
  }

  res.json({ lead: await getLeadWithConversations(lead.id) });
});

app.post("/api/dashboard/leads/:id/merge", requireAuth, async (req: Request, res: Response) => {
  const lead = await getLeadWithConversations(req.params.id);
  if (!lead || lead.businessId !== req.session.businessId) {
    return res.status(404).json({ error: "Lead not found" });
  }

  const { conversationId } = req.body as { conversationId?: string };
  if (!conversationId) return res.status(400).json({ error: "conversationId is required" });

  const conversation = await getConversationById(conversationId);
  if (!conversation || conversation.businessId !== req.session.businessId) {
    return res.status(404).json({ error: "Conversation not found" });
  }

  await mergeConversationIntoLead(conversationId, lead.id);
  res.json({ lead: await getLeadWithConversations(lead.id) });
});

app.get("/api/dashboard/analytics", requireAuth, async (req: Request, res: Response) => {
  res.json(await getAnalyticsSummary(req.session.businessId!));
});

// ---------------------------------------------------------------------------
// Ingest — behind auth, scoped to the signed-in business
// ---------------------------------------------------------------------------

app.post("/api/ingest/document", requireAuth, async (req: Request, res: Response) => {
  const { title, content } = req.body as { title?: string; content?: string };
  if (!title || !content) {
    return res.status(400).json({ error: "title and content are required" });
  }
  try {
    const result = await ingestDocument(req.session.businessId!, title, content);
    res.json(result);
  } catch (err) {
    console.error("Ingest error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

app.post("/api/ingest/crawl", requireAuth, (req: Request, res: Response) => {
  const { url, maxPages } = req.body as { url?: string; maxPages?: number };
  if (!url) {
    return res.status(400).json({ error: "url is required" });
  }
  // Crawling a site can take a while — acknowledge immediately and run in the background.
  res.json({ status: "started", url });
  ingestWebsite(req.session.businessId!, url, maxPages ?? 50).catch((err) => console.error("Crawl error:", err));
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`Server listening on port ${port}`));
