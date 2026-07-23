import { pool } from "./db";
import { publishToConversation, publishToBusiness } from "./events";
import { createLead, markLeadContactedIfNew } from "./leads";
import { notifyTeamOfEscalation } from "./notifications";

export type Channel = "widget" | "whatsapp" | "telegram" | "instagram";
export type MessageRole = "customer" | "bot" | "agent";

export interface Conversation {
  id: string;
  businessId: string;
  channel: Channel;
  externalId: string;
  mode: "bot" | "human";
  claimedBy: string | null;
  leadId: string | null;
  closedAt: string | null;
}

interface ConversationRow {
  id: string;
  business_id: string;
  channel: Channel;
  external_id: string;
  mode: "bot" | "human";
  claimed_by: string | null;
  lead_id: string | null;
  closed_at: string | null;
}

function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    businessId: row.business_id,
    channel: row.channel,
    externalId: row.external_id,
    mode: row.mode,
    claimedBy: row.claimed_by,
    leadId: row.lead_id,
    closedAt: row.closed_at,
  };
}

const COLUMNS = "id, business_id, channel, external_id, mode, claimed_by, lead_id, closed_at";

export interface LeadHint {
  name?: string;
  phone?: string;
}

/** Creates a brand-new conversation's lead too (see src/leads.ts on why merging across channels is manual). */
export async function getOrCreateConversation(
  businessId: string,
  channel: Channel,
  externalId: string,
  leadHint: LeadHint = {}
): Promise<Conversation> {
  const existing = await pool.query<ConversationRow>(
    `SELECT ${COLUMNS} FROM conversations WHERE business_id = $1 AND channel = $2 AND external_id = $3`,
    [businessId, channel, externalId]
  );
  if (existing.rows.length) return toConversation(existing.rows[0]);

  const lead = await createLead(businessId, leadHint);

  const inserted = await pool.query<ConversationRow>(
    `INSERT INTO conversations (business_id, channel, external_id, lead_id) VALUES ($1, $2, $3, $4) RETURNING ${COLUMNS}`,
    [businessId, channel, externalId, lead.id]
  );
  const conversation = toConversation(inserted.rows[0]);
  publishToBusiness(businessId, { type: "new_conversation", conversationId: conversation.id, channel, externalId });
  return conversation;
}

export async function getConversationById(id: string): Promise<Conversation | null> {
  const result = await pool.query<ConversationRow>(`SELECT ${COLUMNS} FROM conversations WHERE id = $1`, [id]);
  return result.rows.length ? toConversation(result.rows[0]) : null;
}

export async function recordMessage(
  conversation: Conversation,
  role: MessageRole,
  content: string,
  wamid: string | null = null
): Promise<void> {
  await pool.query(
    "INSERT INTO conversation_messages (conversation_id, role, content, wamid) VALUES ($1, $2, $3, $4)",
    [conversation.id, role, content, wamid]
  );
  await pool.query(
    `UPDATE conversations SET updated_at = now(), unread_count = unread_count + $2 WHERE id = $1`,
    [conversation.id, role === "customer" ? 1 : 0]
  );
  publishToBusiness(conversation.businessId, {
    type: "new_message",
    conversationId: conversation.id,
    role,
    content,
  });
}

/** Opening a conversation is what marks it read — no separate "mark read" action for reps to take. */
export async function markConversationRead(conversationId: string): Promise<void> {
  await pool.query("UPDATE conversations SET unread_count = 0 WHERE id = $1", [conversationId]);
}

export interface StoredMessage {
  role: MessageRole;
  content: string;
  createdAt: string;
}

export async function getMessages(conversationId: string): Promise<StoredMessage[]> {
  const result = await pool.query<{ role: MessageRole; content: string; created_at: string }>(
    "SELECT role, content, created_at FROM conversation_messages WHERE conversation_id = $1 ORDER BY created_at ASC",
    [conversationId]
  );
  return result.rows.map((r) => ({ role: r.role, content: r.content, createdAt: r.created_at }));
}

export type ConversationFilter = "unclaimed" | "mine" | "all";

export interface ConversationSummary {
  id: string;
  channel: Channel;
  externalId: string;
  mode: "bot" | "human";
  claimedBy: string | null;
  claimedByName: string | null;
  closedAt: string | null;
  updatedAt: string;
  lastMessage: string | null;
  unreadCount: number;
}

export async function listConversations(
  businessId: string,
  filter: ConversationFilter,
  teamMemberId: string
): Promise<ConversationSummary[]> {
  const conditions = ["c.business_id = $1"];
  const params: unknown[] = [businessId];

  if (filter === "unclaimed") {
    conditions.push("c.claimed_by IS NULL", "c.closed_at IS NULL");
  } else if (filter === "mine") {
    params.push(teamMemberId);
    conditions.push(`c.claimed_by = $${params.length}`);
  }

  const result = await pool.query(
    `SELECT c.id, c.channel, c.external_id, c.mode, c.claimed_by, tm.name AS claimed_by_name,
            c.closed_at, c.updated_at, c.unread_count,
            (SELECT content FROM conversation_messages m
             WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_message
     FROM conversations c
     LEFT JOIN team_members tm ON tm.id = c.claimed_by
     WHERE ${conditions.join(" AND ")}
     ORDER BY c.updated_at DESC
     LIMIT 100`,
    params
  );

  return result.rows.map((r) => ({
    id: r.id,
    channel: r.channel,
    externalId: r.external_id,
    mode: r.mode,
    claimedBy: r.claimed_by,
    claimedByName: r.claimed_by_name,
    closedAt: r.closed_at,
    updatedAt: r.updated_at,
    lastMessage: r.last_message,
    unreadCount: r.unread_count,
  }));
}

/** Atomic — returns null if someone else already claimed it first. */
export async function claimConversation(conversationId: string, teamMemberId: string): Promise<Conversation | null> {
  const result = await pool.query<ConversationRow>(
    `UPDATE conversations SET claimed_by = $1, mode = 'human', updated_at = now()
     WHERE id = $2 AND claimed_by IS NULL
     RETURNING ${COLUMNS}`,
    [teamMemberId, conversationId]
  );
  if (!result.rows.length) return null;

  const conversation = toConversation(result.rows[0]);
  publishToBusiness(conversation.businessId, {
    type: "claimed",
    conversationId: conversation.id,
    claimedBy: teamMemberId,
  });
  if (conversation.leadId) void markLeadContactedIfNew(conversation.leadId);
  return conversation;
}

/** Admin override — unlike claimConversation, reassigns even if it's already claimed by someone else. */
export async function assignConversation(conversationId: string, teamMemberId: string): Promise<Conversation> {
  const result = await pool.query<ConversationRow>(
    `UPDATE conversations SET claimed_by = $1, mode = 'human', updated_at = now()
     WHERE id = $2
     RETURNING ${COLUMNS}`,
    [teamMemberId, conversationId]
  );

  const conversation = toConversation(result.rows[0]);
  publishToBusiness(conversation.businessId, {
    type: "claimed",
    conversationId: conversation.id,
    claimedBy: teamMemberId,
  });
  if (conversation.leadId) void markLeadContactedIfNew(conversation.leadId);
  return conversation;
}

/** Visitor/customer asked for a person — stops the bot from answering, without claiming it to any rep. */
export async function requestHuman(conversationId: string): Promise<void> {
  await pool.query("UPDATE conversations SET mode = 'human', updated_at = now() WHERE id = $1", [conversationId]);
  const conversation = await getConversationById(conversationId);
  if (conversation) {
    publishToBusiness(conversation.businessId, { type: "mode_changed", conversationId, mode: "human" });
    void notifyTeamOfEscalation(conversation);
  }
}

export async function closeConversation(conversationId: string): Promise<Conversation> {
  const result = await pool.query<ConversationRow>(
    `UPDATE conversations SET closed_at = now(), mode = 'bot', updated_at = now()
     WHERE id = $1
     RETURNING ${COLUMNS}`,
    [conversationId]
  );
  const conversation = toConversation(result.rows[0]);
  publishToBusiness(conversation.businessId, { type: "closed", conversationId: conversation.id });
  return conversation;
}

/** Pushes a reply to the widget's live SSE stream. WhatsApp delivery is handled separately by the caller,
 * since it needs that business's credentials (see src/whatsapp.ts) and returns a wamid to persist. */
export function relayReplyToWidget(
  conversation: Conversation,
  text: string,
  options: { type?: "message" | "handoff"; role?: "agent" | "bot" | "system" } = {}
): void {
  publishToConversation(conversation.id, {
    type: options.type ?? "message",
    role: options.role ?? "agent",
    content: text,
  });
}
