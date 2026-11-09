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

export interface CapturedLeadDetails {
  name?: string;
  phone?: string;
  email?: string;
  interest?: string;
  unit?: string;
  location?: string;
  preferredTime?: string;
}

/** One dated line for the lead's notes, e.g. "2026-11-09: Interested in: Serenity Estate | Unit: 3 bedroom villa". */
export function describeLeadExtras(details: CapturedLeadDetails): string | null {
  const parts = [
    details.interest && `Interested in: ${details.interest}`,
    details.unit && `Unit: ${details.unit}`,
    details.location && `Location: ${details.location}`,
    details.preferredTime && `Preferred time: ${details.preferredTime}`,
  ].filter(Boolean);
  return parts.length ? parts.join(" | ") : null;
}

/**
 * Applies details the bot captured mid-conversation to the lead. Contact fields from the customer's
 * own words win over whatever was there (they may have corrected a number). Each new enquiry is added
 * to the notes as a dated line, so the team sees the client's history; a repeat of an enquiry that's
 * already recorded isn't added again.
 */
export async function applyCapturedLeadDetails(leadId: string, details: CapturedLeadDetails, today = new Date()): Promise<Lead> {
  const extras = describeLeadExtras(details);
  const entry = extras ? `${today.toISOString().slice(0, 10)}: ${extras}` : null;
  const result = await pool.query<LeadRow>(
    `UPDATE leads SET
       name = COALESCE($2, name),
       phone = COALESCE($3, phone),
       email = COALESCE($4, email),
       notes = CASE
         WHEN $5::text IS NULL THEN notes
         WHEN position($5 in COALESCE(notes, '')) > 0 THEN notes
         WHEN notes IS NULL OR notes = '' THEN $6
         ELSE notes || E'\n' || $6
       END,
       updated_at = now()
     WHERE id = $1
     RETURNING ${COLUMNS}`,
    [leadId, details.name ?? null, details.phone ?? null, details.email ?? null, extras, entry]
  );
  return toLead(result.rows[0]);
}

export interface LeadAlertState {
  alertedAt: Date | null;
  lastAlertInterest: string | null;
  lastAlertPhone: string | null;
  lastAlertEmail: string | null;
  lastClientConfirmationAt: Date | null;
}

export async function getLeadAlertState(leadId: string): Promise<LeadAlertState> {
  const { rows } = await pool.query(
    `SELECT alerted_at, last_alert_interest, last_alert_phone, last_alert_email, last_client_confirmation_at
     FROM leads WHERE id = $1`,
    [leadId]
  );
  const r = rows[0] ?? {};
  return {
    alertedAt: r.alerted_at ?? null,
    lastAlertInterest: r.last_alert_interest ?? null,
    lastAlertPhone: r.last_alert_phone ?? null,
    lastAlertEmail: r.last_alert_email ?? null,
    lastClientConfirmationAt: r.last_client_confirmation_at ?? null,
  };
}

/**
 * Atomically records that the sales team has just been alerted, and what they were told. Only
 * succeeds if nobody else alerted since `expectedAlertedAt` was read, so two replies landing at once
 * can never send the same alert twice. Compared at millisecond precision because Postgres keeps
 * microseconds but the value read back into JavaScript only has milliseconds.
 */
export async function claimLeadAlert(
  leadId: string,
  expectedAlertedAt: Date | null,
  snapshot: { interest: string | null; phone: string | null; email: string | null }
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE leads SET alerted_at = now(),
       last_alert_interest = COALESCE($3, last_alert_interest),
       last_alert_phone = $4,
       last_alert_email = $5
     WHERE id = $1 AND date_trunc('milliseconds', alerted_at) IS NOT DISTINCT FROM $2::timestamptz
     RETURNING id`,
    [leadId, expectedAlertedAt, snapshot.interest, snapshot.phone, snapshot.email]
  );
  return (result.rowCount ?? 0) > 0;
}

/** Same idea for the client confirmation, which is limited to one a day. */
export async function claimClientConfirmation(leadId: string, expectedAt: Date | null): Promise<boolean> {
  const result = await pool.query(
    `UPDATE leads SET last_client_confirmation_at = now()
     WHERE id = $1 AND date_trunc('milliseconds', last_client_confirmation_at) IS NOT DISTINCT FROM $2::timestamptz
     RETURNING id`,
    [leadId, expectedAt]
  );
  return (result.rowCount ?? 0) > 0;
}
