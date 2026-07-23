function apiUrl(botToken: string, method: string): string {
  return `https://api.telegram.org/bot${botToken}/${method}`;
}

export async function sendTelegramMessage(botToken: string, chatId: string, text: string): Promise<string> {
  const res = await fetch(apiUrl(botToken, "sendMessage"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  const data = (await res.json()) as { ok: boolean; result?: { message_id: number }; description?: string };
  if (!res.ok || !data.ok) {
    throw new Error(`Telegram send failed: ${data.description ?? res.status}`);
  }
  return String(data.result!.message_id);
}

/**
 * Points this bot's webhook at our server — called automatically when a business saves their bot
 * token in Settings, so unlike WhatsApp/Instagram there's no manual dashboard step for them to do.
 */
export async function setTelegramWebhook(botToken: string, webhookUrl: string): Promise<void> {
  const res = await fetch(apiUrl(botToken, "setWebhook"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: webhookUrl }),
  });
  const data = (await res.json()) as { ok: boolean; description?: string };
  if (!res.ok || !data.ok) {
    throw new Error(`Telegram setWebhook failed: ${data.description ?? res.status}`);
  }
}
