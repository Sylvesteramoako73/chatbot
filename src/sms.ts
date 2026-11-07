const MNOTIFY_URL = "https://api.mnotify.com/api/sms/quick";

/**
 * Normalises a phone number into the digits-only international form mNotify expects
 * (e.g. "0244 123 456" or "+233 24 412 3456" -> "233244123456"). Local Ghana numbers starting
 * with 0 get the 233 country code; anything already international is just stripped of symbols.
 * Returns null for something that clearly isn't a phone number.
 */
export function normalisePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let digits = raw.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) digits = digits.slice(1);
  else if (digits.startsWith("00")) digits = digits.slice(2);
  else if (digits.startsWith("0") && digits.length === 10) digits = "233" + digits.slice(1);
  digits = digits.replace(/\D/g, "");
  return digits.length >= 9 && digits.length <= 15 ? digits : null;
}

/** Splits a comma/newline separated list of phone numbers from the settings page. */
export function parsePhoneList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const out = new Set<string>();
  for (const part of raw.split(/[,\n;]+/)) {
    const phone = normalisePhone(part.trim());
    if (phone) out.add(phone);
  }
  return [...out];
}

/**
 * Plain fetch to mNotify's quick SMS endpoint, same dependency-free style as the Resend/WhatsApp
 * integrations. No-ops (with a warning) if MNOTIFY_API_KEY or a sender ID isn't set, so the rest of
 * the lead-alert flow (email, push) keeps working for anyone who hasn't configured SMS yet.
 */
export async function sendSms(recipients: string[], message: string, senderId: string | null): Promise<void> {
  const apiKey = process.env.MNOTIFY_API_KEY;
  const sender = senderId || process.env.MNOTIFY_SENDER_ID;
  if (!apiKey || !sender) {
    console.warn("SMS skipped — MNOTIFY_API_KEY or sender ID not set.");
    return;
  }

  const to = recipients.map((r) => normalisePhone(r)).filter((r): r is string => !!r);
  if (!to.length) return;

  const res = await fetch(`${MNOTIFY_URL}?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      recipient: to,
      sender,
      message,
      is_schedule: false,
      schedule_date: "",
    }),
  });

  const text = await res.text();
  let data: { status?: string; code?: string | number; message?: string } = {};
  try {
    data = JSON.parse(text);
  } catch {
    // non-JSON error page — fall through to the status check below
  }

  if (!res.ok || (data.status && data.status !== "success")) {
    throw new Error(`mNotify send failed: ${res.status} ${data.code ?? ""} ${data.message ?? text.slice(0, 200)}`);
  }
}
