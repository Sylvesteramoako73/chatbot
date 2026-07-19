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
  updateBusinessSettings,
} from "./businesses";
import {
  Conversation,
  getOrCreateConversation,
  getConversationById,
  recordMessage,
  getMessages,
  listConversations,
  ConversationFilter,
  claimConversation,
  closeConversation,
  requestHuman,
  relayReplyToWidget,
} from "./conversations";
import { subscribeToConversation, subscribeToBusiness } from "./events";
import { sendWhatsAppText } from "./whatsapp";

const app = express();
app.use(cors({ origin: true })); // public widget API — see README for why this is intentionally open
app.use(express.json({ limit: "2mb" }));
app.use(createSessionMiddleware());
app.use("/widget", express.static(path.join(__dirname, "..", "public")));
app.use("/dashboard", express.static(path.join(__dirname, "..", "public", "dashboard")));

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

// Held back from the live stream so we can detect (and strip) NEEDS_HUMAN_MARKER before it ever
// reaches the customer — it's longer than the marker itself to leave margin for trailing whitespace.
const MARKER_TAIL_BUFFER = 64;

async function runBotReplyForWidget(
  conversation: Conversation,
  business: Awaited<ReturnType<typeof getBusinessById>>,
  message: string,
  history: ChatMessage[],
  res: Response
): Promise<void> {
  let full = "";
  let tail = "";
  for await (const token of streamChatResponse(conversation.businessId, business?.systemPrompt ?? null, message, history)) {
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

        for (const message of change.value?.messages ?? []) {
          if (message.type !== "text") continue;
          const conversation = await getOrCreateConversation(business.id, "whatsapp", message.from);
          await recordMessage(conversation, "customer", message.text.body);

          if (conversation.mode !== "bot") continue; // claimed by a rep — they'll see it live in the dashboard

          let full = "";
          for await (const token of streamChatResponse(business.id, business.systemPrompt, message.text.body, [])) {
            full += token;
          }
          const needsHuman = full.includes(NEEDS_HUMAN_MARKER);
          const visibleFull = needsHuman ? full.replace(NEEDS_HUMAN_MARKER, "").replace(/\s+$/, "") : full;

          if (!business.whatsappToken || !business.whatsappPhoneNumberId) continue;
          const wamid = await sendWhatsAppText(
            { token: business.whatsappToken, phoneNumberId: business.whatsappPhoneNumberId },
            message.from,
            visibleFull
          );
          await recordMessage(conversation, "bot", visibleFull, wamid);
          if (needsHuman) await requestHuman(conversation.id);
        }
      }
    }
  } catch (err) {
    console.error("WhatsApp webhook error:", err);
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
  res.json({ conversation, messages: await getMessages(conversation.id) });
});

app.post("/api/dashboard/conversations/:id/claim", requireAuth, async (req: Request, res: Response) => {
  const conversation = await loadOwnedConversation(req, res);
  if (!conversation) return;
  const claimed = await claimConversation(conversation.id, req.session.teamMemberId!);
  if (!claimed) return res.status(409).json({ error: "Already claimed by someone else" });
  res.json({ conversation: claimed });
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
    let wamid: string | null = null;
    if (conversation.channel === "widget") {
      relayReplyToWidget(conversation, text);
    } else {
      const business = await getBusinessById(conversation.businessId);
      if (!business?.whatsappToken || !business.whatsappPhoneNumberId) {
        return res.status(400).json({ error: "This business hasn't connected WhatsApp credentials yet" });
      }
      wamid = await sendWhatsAppText(
        { token: business.whatsappToken, phoneNumberId: business.whatsappPhoneNumberId },
        conversation.externalId,
        text
      );
    }
    await recordMessage(conversation, "agent", text, wamid);
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
  const { systemPrompt, allowedOrigin, whatsappToken, whatsappPhoneNumberId, whatsappTemplateName } = req.body;
  const business = await updateBusinessSettings(req.session.businessId!, {
    systemPrompt,
    allowedOrigin,
    whatsappToken,
    whatsappPhoneNumberId,
    whatsappTemplateName,
  });
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
