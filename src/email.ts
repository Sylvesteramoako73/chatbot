const RESEND_URL = "https://api.resend.com/emails";

/**
 * Plain fetch to Resend, same dependency-free style as the Groq/Voyage/WhatsApp integrations.
 * No-ops (with a warning) if RESEND_API_KEY isn't set, so push notifications alone still work for
 * anyone who hasn't configured email yet — the two mechanisms are independent.
 */
export async function sendEmail(to: string, subject: string, body: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn("Email skipped — RESEND_API_KEY not set.");
    return;
  }

  const from = process.env.RESEND_FROM_EMAIL ?? "onboarding@resend.dev";
  const res = await fetch(RESEND_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to, subject, text: body }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Resend send failed: ${res.status} ${errText}`);
  }
}
