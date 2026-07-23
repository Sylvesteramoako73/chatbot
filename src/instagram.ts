const API_VERSION = "v20.0";

export interface InstagramCredentials {
  pageId: string;
  token: string;
}

/** Same Graph API family as WhatsApp (src/whatsapp.ts) — Instagram DMs go through a connected Page. */
export async function sendInstagramMessage(creds: InstagramCredentials, igsid: string, text: string): Promise<string> {
  const res = await fetch(
    `https://graph.facebook.com/${API_VERSION}/${creds.pageId}/messages?access_token=${encodeURIComponent(creds.token)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: igsid },
        message: { text },
      }),
    }
  );

  const data = (await res.json()) as { message_id?: string; error?: { message: string } };
  if (!res.ok || !data.message_id) {
    throw new Error(`Instagram send failed: ${data.error?.message ?? res.status}`);
  }
  return data.message_id;
}
