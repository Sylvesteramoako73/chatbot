import webpush from "web-push";
import { pool } from "./db";

export interface PushSubscriptionJSON {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushPayload {
  title: string;
  body: string;
  conversationId: string;
}

let vapidConfigured = false;

function ensureVapidConfigured(): boolean {
  if (vapidConfigured) return true;
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY || !VAPID_SUBJECT) return false;
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  vapidConfigured = true;
  return true;
}

export async function savePushSubscription(teamMemberId: string, subscription: PushSubscriptionJSON): Promise<void> {
  await pool.query(
    `INSERT INTO push_subscriptions (team_member_id, endpoint, p256dh, auth)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (endpoint) DO UPDATE SET team_member_id = $1`,
    [teamMemberId, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth]
  );
}

export async function deletePushSubscription(endpoint: string): Promise<void> {
  await pool.query("DELETE FROM push_subscriptions WHERE endpoint = $1", [endpoint]);
}

export async function sendPushToTeamMember(teamMemberId: string, payload: PushPayload): Promise<void> {
  if (!ensureVapidConfigured()) {
    console.warn("Push notification skipped — VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY/VAPID_SUBJECT not set.");
    return;
  }

  const result = await pool.query<{ endpoint: string; p256dh: string; auth: string }>(
    "SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE team_member_id = $1",
    [teamMemberId]
  );

  for (const row of result.rows) {
    try {
      await webpush.sendNotification(
        { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
        JSON.stringify(payload)
      );
    } catch (err) {
      const statusCode = (err as { statusCode?: number }).statusCode;
      if (statusCode === 404 || statusCode === 410) {
        // Subscription expired/revoked on the browser side — stop trying to send to it.
        await deletePushSubscription(row.endpoint);
      } else {
        console.error("Push send failed:", err);
      }
    }
  }
}
