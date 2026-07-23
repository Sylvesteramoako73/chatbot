import { pool } from "./db";

export type LeadStage = "new" | "contacted" | "qualified" | "negotiating" | "won" | "lost";

export interface Lead {
  id: string;
  businessId: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  stage: LeadStage;
  notes: string | null;
  updatedAt: string;
}

interface LeadRow {
  id: string;
  business_id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  stage: LeadStage;
  notes: string | null;
  updated_at: string;
}

const COLUMNS = "id, business_id, name, phone, email, stage, notes, updated_at";

function toLead(row: LeadRow): Lead {
  return {
    id: row.id,
    businessId: row.business_id,
    name: row.name,
    phone: row.phone,
    email: row.email,
    stage: row.stage,
    notes: row.notes,
    updatedAt: row.updated_at,
  };
}

export async function createLead(
  businessId: string,
  details: { name?: string; phone?: string; email?: string } = {}
): Promise<Lead> {
  const result = await pool.query<LeadRow>(
    `INSERT INTO leads (business_id, name, phone, email) VALUES ($1, $2, $3, $4) RETURNING ${COLUMNS}`,
    [businessId, details.name ?? null, details.phone ?? null, details.email ?? null]
  );
  return toLead(result.rows[0]);
}

export async function getLeadById(leadId: string): Promise<Lead | null> {
  const result = await pool.query<LeadRow>(`SELECT ${COLUMNS} FROM leads WHERE id = $1`, [leadId]);
  return result.rows.length ? toLead(result.rows[0]) : null;
}

export async function listLeads(businessId: string): Promise<Lead[]> {
  const result = await pool.query<LeadRow>(
    `SELECT ${COLUMNS} FROM leads WHERE business_id = $1 ORDER BY updated_at DESC`,
    [businessId]
  );
  return result.rows.map(toLead);
}

export interface LeadWithConversations extends Lead {
  conversations: { id: string; channel: string; externalId: string; updatedAt: string }[];
}

export async function getLeadWithConversations(leadId: string): Promise<LeadWithConversations | null> {
  const lead = await getLeadById(leadId);
  if (!lead) return null;

  const result = await pool.query<{ id: string; channel: string; external_id: string; updated_at: string }>(
    "SELECT id, channel, external_id, updated_at FROM conversations WHERE lead_id = $1 ORDER BY updated_at DESC",
    [leadId]
  );

  return {
    ...lead,
    conversations: result.rows.map((r) => ({
      id: r.id,
      channel: r.channel,
      externalId: r.external_id,
      updatedAt: r.updated_at,
    })),
  };
}

export async function updateLeadStage(leadId: string, stage: LeadStage): Promise<Lead> {
  const result = await pool.query<LeadRow>(
    `UPDATE leads SET stage = $2, updated_at = now() WHERE id = $1 RETURNING ${COLUMNS}`,
    [leadId, stage]
  );
  return toLead(result.rows[0]);
}

export async function updateLeadDetails(
  leadId: string,
  details: { name?: string | null; phone?: string | null; email?: string | null; notes?: string | null }
): Promise<Lead> {
  const result = await pool.query<LeadRow>(
    `UPDATE leads SET
       name = COALESCE($2, name),
       phone = COALESCE($3, phone),
       email = COALESCE($4, email),
       notes = COALESCE($5, notes),
       updated_at = now()
     WHERE id = $1
     RETURNING ${COLUMNS}`,
    [leadId, details.name, details.phone, details.email, details.notes]
  );
  return toLead(result.rows[0]);
}

/** Re-points a conversation at a different (existing) lead — the manual cross-channel merge action. */
export async function mergeConversationIntoLead(conversationId: string, leadId: string): Promise<void> {
  await pool.query("UPDATE conversations SET lead_id = $2, updated_at = now() WHERE id = $1", [
    conversationId,
    leadId,
  ]);
}

/**
 * A rep picking up a conversation is real sales activity — advances a fresh lead out of "new"
 * automatically. Only touches leads still at "new", so it never downgrades one that's already
 * further along (e.g. a returning customer's already-"won" lead starting a new conversation).
 */
export async function markLeadContactedIfNew(leadId: string): Promise<void> {
  await pool.query("UPDATE leads SET stage = 'contacted', updated_at = now() WHERE id = $1 AND stage = 'new'", [
    leadId,
  ]);
}

const ALL_STAGES: LeadStage[] = ["new", "contacted", "qualified", "negotiating", "won", "lost"];

export interface LeadStageCounts {
  total: number;
  byStage: Record<LeadStage, number>;
}

export async function getLeadStageCounts(businessId: string): Promise<LeadStageCounts> {
  const result = await pool.query<{ stage: LeadStage; count: string }>(
    "SELECT stage, count(*) AS count FROM leads WHERE business_id = $1 GROUP BY stage",
    [businessId]
  );

  const byStage = ALL_STAGES.reduce((acc, stage) => {
    acc[stage] = 0;
    return acc;
  }, {} as Record<LeadStage, number>);

  let total = 0;
  for (const row of result.rows) {
    const count = Number(row.count);
    byStage[row.stage] = count;
    total += count;
  }

  return { total, byStage };
}
