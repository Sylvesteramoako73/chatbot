import crypto from "crypto";
import { pool } from "./db";

export interface Business {
  id: string;
  name: string;
  siteKey: string;
  allowedOrigin: string | null;
  systemPrompt: string | null;
  whatsappToken: string | null;
  whatsappPhoneNumberId: string | null;
  whatsappTemplateName: string | null;
  telegramBotToken: string | null;
  instagramPageId: string | null;
  instagramToken: string | null;
}

interface BusinessRow {
  id: string;
  name: string;
  site_key: string;
  allowed_origin: string | null;
  system_prompt: string | null;
  whatsapp_token: string | null;
  whatsapp_phone_number_id: string | null;
  whatsapp_template_name: string | null;
  telegram_bot_token: string | null;
  instagram_page_id: string | null;
  instagram_token: string | null;
}

const COLUMNS =
  "id, name, site_key, allowed_origin, system_prompt, whatsapp_token, whatsapp_phone_number_id, " +
  "whatsapp_template_name, telegram_bot_token, instagram_page_id, instagram_token";

function toBusiness(row: BusinessRow): Business {
  return {
    id: row.id,
    name: row.name,
    siteKey: row.site_key,
    allowedOrigin: row.allowed_origin,
    systemPrompt: row.system_prompt,
    whatsappToken: row.whatsapp_token,
    whatsappPhoneNumberId: row.whatsapp_phone_number_id,
    whatsappTemplateName: row.whatsapp_template_name,
    telegramBotToken: row.telegram_bot_token,
    instagramPageId: row.instagram_page_id,
    instagramToken: row.instagram_token,
  };
}

export function generateSiteKey(): string {
  return "sk_live_" + crypto.randomBytes(16).toString("hex");
}

export async function createBusiness(name: string): Promise<Business> {
  const result = await pool.query<BusinessRow>(
    `INSERT INTO businesses (name, site_key) VALUES ($1, $2) RETURNING ${COLUMNS}`,
    [name, generateSiteKey()]
  );
  return toBusiness(result.rows[0]);
}

export async function getBusinessById(id: string): Promise<Business | null> {
  const result = await pool.query<BusinessRow>(`SELECT ${COLUMNS} FROM businesses WHERE id = $1`, [id]);
  return result.rows.length ? toBusiness(result.rows[0]) : null;
}

export async function getBusinessBySiteKey(siteKey: string): Promise<Business | null> {
  const result = await pool.query<BusinessRow>(`SELECT ${COLUMNS} FROM businesses WHERE site_key = $1`, [siteKey]);
  return result.rows.length ? toBusiness(result.rows[0]) : null;
}

export async function getBusinessByWhatsAppPhoneNumberId(phoneNumberId: string): Promise<Business | null> {
  const result = await pool.query<BusinessRow>(
    `SELECT ${COLUMNS} FROM businesses WHERE whatsapp_phone_number_id = $1`,
    [phoneNumberId]
  );
  return result.rows.length ? toBusiness(result.rows[0]) : null;
}

export async function getBusinessByInstagramPageId(pageId: string): Promise<Business | null> {
  const result = await pool.query<BusinessRow>(`SELECT ${COLUMNS} FROM businesses WHERE instagram_page_id = $1`, [
    pageId,
  ]);
  return result.rows.length ? toBusiness(result.rows[0]) : null;
}

export interface BusinessSettingsUpdate {
  systemPrompt?: string | null;
  allowedOrigin?: string | null;
  whatsappToken?: string | null;
  whatsappPhoneNumberId?: string | null;
  whatsappTemplateName?: string | null;
  telegramBotToken?: string | null;
  instagramPageId?: string | null;
  instagramToken?: string | null;
}

export async function updateBusinessSettings(id: string, updates: BusinessSettingsUpdate): Promise<Business> {
  const result = await pool.query<BusinessRow>(
    `UPDATE businesses SET
       system_prompt = COALESCE($2, system_prompt),
       allowed_origin = COALESCE($3, allowed_origin),
       whatsapp_token = COALESCE($4, whatsapp_token),
       whatsapp_phone_number_id = COALESCE($5, whatsapp_phone_number_id),
       whatsapp_template_name = COALESCE($6, whatsapp_template_name),
       telegram_bot_token = COALESCE($7, telegram_bot_token),
       instagram_page_id = COALESCE($8, instagram_page_id),
       instagram_token = COALESCE($9, instagram_token)
     WHERE id = $1
     RETURNING ${COLUMNS}`,
    [
      id,
      updates.systemPrompt,
      updates.allowedOrigin,
      updates.whatsappToken,
      updates.whatsappPhoneNumberId,
      updates.whatsappTemplateName,
      updates.telegramBotToken,
      updates.instagramPageId,
      updates.instagramToken,
    ]
  );
  return toBusiness(result.rows[0]);
}
