const API_VERSION = process.env.WHATSAPP_API_VERSION ?? "v20.0";

export interface WhatsAppCredentials {
  token: string;
  phoneNumberId: string;
}

function graphUrl(phoneNumberId: string): string {
  return `https://graph.facebook.com/${API_VERSION}/${phoneNumberId}/messages`;
}

async function postToGraph(creds: WhatsAppCredentials, body: Record<string, unknown>): Promise<string> {
  const res = await fetch(graphUrl(creds.phoneNumberId), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${creds.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = (await res.json()) as { messages?: { id: string }[] };
  if (!res.ok) {
    throw new Error(`WhatsApp send failed (${res.status}): ${JSON.stringify(data)}`);
  }
  return data.messages![0].id;
}

/**
 * Sends free-form text. Only works within 24h of the recipient's last
 * inbound message to this business number — otherwise Meta rejects it
 * (error code 131047) and sendWhatsAppTemplate must be used instead.
 */
export async function sendWhatsAppText(creds: WhatsAppCredentials, to: string, body: string): Promise<string> {
  return postToGraph(creds, {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body },
  });
}

/**
 * Sends a pre-approved template message — required to open/re-open the 24h
 * window when the recipient hasn't messaged the business number recently.
 * The template must exist and be approved in the Meta Business dashboard;
 * bodyParams fill its {{1}}, {{2}}, ... placeholders in order.
 */
export async function sendWhatsAppTemplate(
  creds: WhatsAppCredentials,
  to: string,
  templateName: string,
  bodyParams: string[]
): Promise<string> {
  return postToGraph(creds, {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: templateName,
      language: { code: "en_US" },
      components: bodyParams.length
        ? [{ type: "body", parameters: bodyParams.map((text) => ({ type: "text", text })) }]
        : [],
    },
  });
}
