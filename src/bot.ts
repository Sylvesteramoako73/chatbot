import { Business } from "./businesses";
import { streamChatResponse, parseBotReply, visitorNamedProject } from "./chat";
import { handleCapturedLead } from "./leadAlerts";
import { getLeadById } from "./leads";
import { getOrCreateConversation, recordMessage, requestHuman, getMessages, Channel, LeadHint } from "./conversations";

const HISTORY_LIMIT = 20;

/**
 * Shared inbound-message handling for every non-widget channel (WhatsApp, Telegram, Instagram —
 * the widget has its own path in server.ts since it streams token-by-token to an HTTP response).
 * Records the customer's message, and if the bot is still driving the conversation, runs the RAG
 * reply, strips the escalation marker before it's sent out, and flags the conversation for the
 * sales team if the bot couldn't fully answer.
 */
export async function handleInboundMessage(
  business: Business,
  channel: Channel,
  externalId: string,
  text: string,
  leadHint: LeadHint,
  send: (replyText: string) => Promise<string | null>
): Promise<void> {
  const conversation = await getOrCreateConversation(business.id, channel, externalId, leadHint);
  // Fetch history before recording this turn's message so it isn't duplicated — the model needs
  // to see its own prior "want me to connect you?" offer to recognize a "yes" as confirmation.
  const priorMessages = await getMessages(conversation.id);
  const history = priorMessages.slice(-HISTORY_LIMIT).map((m) => ({
    role: (m.role === "customer" ? "user" : "assistant") as "user" | "assistant",
    content: m.content,
  }));

  await recordMessage(conversation, "customer", text);
  if (conversation.mode !== "bot") return; // claimed by a rep — they'll see it live in the dashboard

  let full = "";
  const lead = conversation.leadId ? await getLeadById(conversation.leadId) : null;
  const context = {
    visitorName: lead?.name ?? null,
    contactPhone: business.contactPhone,
    contactEmail: business.contactEmail,
    projectOptions: business.projectOptions,
    visitorHasContact: !!(lead?.phone || lead?.email),
  };
  for await (const token of streamChatResponse(business.id, business.name, business.systemPrompt, text, history, context)) {
    full += token;
  }

  const parsed = parseBotReply(full);
  const { needsHuman, lead: captured } = parsed;
  // No tick boxes outside the website widget, so list the projects as plain lines instead.
  const visible =
    parsed.showOptions &&
    business.projectOptions.length &&
    !visitorNamedProject([text, ...history.filter((m) => m.role === "user").map((m) => m.content)], business.projectOptions)
      ? `${parsed.visible}\n\n${business.projectOptions.join("\n")}`
      : parsed.visible;

  const messageId = await send(visible);
  await recordMessage(conversation, "bot", visible, messageId);
  if (captured) {
    // WhatsApp's sender number is the customer's real phone even if they didn't type it in chat.
    if (!captured.phone && channel === "whatsapp") captured.phone = externalId;
    void handleCapturedLead(business, conversation, captured);
  }
  if (needsHuman) await requestHuman(conversation.id);
}
