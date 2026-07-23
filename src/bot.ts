import { Business } from "./businesses";
import { streamChatResponse, NEEDS_HUMAN_MARKER } from "./chat";
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
  for await (const token of streamChatResponse(business.id, business.name, business.systemPrompt, text, history)) {
    full += token;
  }

  const needsHuman = full.includes(NEEDS_HUMAN_MARKER);
  const visible = needsHuman ? full.replace(NEEDS_HUMAN_MARKER, "").replace(/\s+$/, "") : full;

  const messageId = await send(visible);
  await recordMessage(conversation, "bot", visible, messageId);
  if (needsHuman) await requestHuman(conversation.id);
}
