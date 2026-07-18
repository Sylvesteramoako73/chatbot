import { pool } from "./db";
import { sendWhatsAppText, sendWhatsAppTemplate } from "./whatsapp";
import { publishOwnerReply } from "./events";

export interface Conversation {
  id: string;
  sessionId: string;
  status: "bot" | "handoff";
}

interface ConversationRow {
  id: string;
  session_id: string;
  status: "bot" | "handoff";
}

function toConversation(row: ConversationRow): Conversation {
  return { id: row.id, sessionId: row.session_id, status: row.status };
}

export async function getOrCreateConversation(sessionId: string): Promise<Conversation> {
  const existing = await pool.query<ConversationRow>(
    "SELECT id, session_id, status FROM conversations WHERE session_id = $1",
    [sessionId]
  );
  if (existing.rows.length) return toConversation(existing.rows[0]);

  const inserted = await pool.query<ConversationRow>(
    "INSERT INTO conversations (session_id) VALUES ($1) RETURNING id, session_id, status",
    [sessionId]
  );
  return toConversation(inserted.rows[0]);
}

async function recordMessage(
  conversationId: string,
  role: "visitor" | "bot" | "owner",
  content: string,
  wamid: string | null = null
): Promise<void> {
  await pool.query(
    "INSERT INTO conversation_messages (conversation_id, role, content, wamid) VALUES ($1, $2, $3, $4)",
    [conversationId, role, content, wamid]
  );
  await pool.query("UPDATE conversations SET updated_at = now() WHERE id = $1", [conversationId]);
}

async function getRecentTranscript(conversationId: string, limit = 10): Promise<string> {
  const result = await pool.query<{ role: string; content: string }>(
    "SELECT role, content FROM conversation_messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT $2",
    [conversationId, limit]
  );
  return result.rows
    .reverse()
    .map((r) => `${r.role === "visitor" ? "Visitor" : "Bot"}: ${r.content}`)
    .join("\n");
}

async function findConversationIdByWamid(wamid: string): Promise<string | null> {
  const result = await pool.query<{ conversation_id: string }>(
    "SELECT conversation_id FROM conversation_messages WHERE wamid = $1 LIMIT 1",
    [wamid]
  );
  return result.rows[0]?.conversation_id ?? null;
}

async function findMostRecentHandoffConversation(): Promise<Conversation | null> {
  const result = await pool.query<ConversationRow>(
    "SELECT id, session_id, status FROM conversations WHERE status = 'handoff' ORDER BY updated_at DESC LIMIT 1"
  );
  return result.rows.length ? toConversation(result.rows[0]) : null;
}

async function getConversationById(conversationId: string): Promise<Conversation | null> {
  const result = await pool.query<ConversationRow>(
    "SELECT id, session_id, status FROM conversations WHERE id = $1",
    [conversationId]
  );
  return result.rows.length ? toConversation(result.rows[0]) : null;
}

/** Sends a WhatsApp text to the owner, falling back to the configured template if the 24h window is closed. */
async function notifyOwner(body: string): Promise<string> {
  const ownerNumber = process.env.OWNER_WHATSAPP_NUMBER;
  if (!ownerNumber) {
    throw new Error("OWNER_WHATSAPP_NUMBER is not set");
  }

  try {
    return await sendWhatsAppText(ownerNumber, body);
  } catch (err) {
    const templateName = process.env.WHATSAPP_TEMPLATE_NAME;
    if (!templateName) throw err;
    console.warn("Free-form WhatsApp send failed, falling back to template:", err);
    return sendWhatsAppTemplate(ownerNumber, templateName, [body]);
  }
}

/** Flips a conversation into handoff mode and sends the owner a WhatsApp notification with the recent transcript. */
export async function startHandoff(sessionId: string): Promise<void> {
  const conversation = await getOrCreateConversation(sessionId);
  await pool.query("UPDATE conversations SET status = 'handoff', updated_at = now() WHERE id = $1", [
    conversation.id,
  ]);

  const transcript = await getRecentTranscript(conversation.id);
  const notification = `New live chat from your website${
    transcript ? `:\n\n${transcript}` : " — the visitor wants to talk to you."
  }\n\nSwipe-reply to this message so I know which visitor to send your reply to.`;

  const wamid = await notifyOwner(notification);
  await recordMessage(conversation.id, "bot", notification, wamid);
}

/** During handoff mode, forwards a visitor's message straight to the owner over WhatsApp. */
export async function relayVisitorMessage(conversationId: string, text: string): Promise<void> {
  await recordVisitorMessage(conversationId, text);
  const wamid = await notifyOwner(`Visitor: ${text}`);
  await recordMessage(conversationId, "bot", `Visitor: ${text}`, wamid);
}

/** Resolves an inbound WhatsApp message (owner's reply) to a conversation, records it, and pushes it to the widget. */
export async function handleOwnerReply(text: string, contextWamid: string | null): Promise<void> {
  let conversation: Conversation | null = null;

  if (contextWamid) {
    const conversationId = await findConversationIdByWamid(contextWamid);
    if (conversationId) conversation = await getConversationById(conversationId);
  }

  if (!conversation) {
    conversation = await findMostRecentHandoffConversation();
  }

  if (!conversation) {
    console.warn("Received an owner WhatsApp reply with no open handoff conversation to route it to");
    return;
  }

  await recordMessage(conversation.id, "owner", text);
  publishOwnerReply({ sessionId: conversation.sessionId, content: text });
}

export async function recordVisitorMessage(conversationId: string, text: string): Promise<void> {
  await recordMessage(conversationId, "visitor", text);
}

export async function recordBotReply(conversationId: string, text: string): Promise<void> {
  await recordMessage(conversationId, "bot", text);
}
