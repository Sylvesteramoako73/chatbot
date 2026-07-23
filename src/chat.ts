import { retrieveContext } from "./retrieve";

const MODEL = "llama-3.3-70b-versatile";
const TOP_K = 5;
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

function defaultTone(businessName: string): string {
  return `Be warm, direct, and helpful — the way a knowledgeable staff member at ${businessName} would talk to a visitor. Keep answers concise.`;
}

// When the bot can't confidently answer from the reference notes, it ends its reply with this
// exact token so the caller can flag the conversation for the sales team — stripped before the
// customer ever sees it, in both the streamed widget response and the WhatsApp reply.
export const NEEDS_HUMAN_MARKER = "[[NEEDS_HUMAN]]";

function buildSystemPrompt(businessName: string, persona: string | null, notesBlock: string): string {
  return `You are chatting directly with a visitor on ${businessName}'s own website or messaging channel. You ARE ${businessName}'s assistant — speak as ${businessName} itself, in first person plural ("we", "our", "us"), the way a staff member would. Never describe ${businessName} the way an outside observer or a Wikipedia article would (never say "${businessName} is a..." — say "We're a...").

${persona ?? defaultTone(businessName)}

You have some reference notes below about the business, drawn from its own website/documents. Use them to answer naturally — but never mention "context," "the provided information," "documents," "sources," or that you're an AI retrieving anything. The visitor should never see any of that — you just know this because you work here. If the notes don't cover something, say so plainly and naturally ("I don't have that on hand" / "I'm not sure about that one"), not in a way that references how you're generating the answer.

If the visitor's message is just a greeting or has no real question in it (e.g. "hi", "hello"), respond with a short, warm welcome and invite them to ask something — don't comment on the fact that they didn't ask a specific question.

Do not invent information that isn't in the reference notes.

Reserve the token below for when you genuinely could not answer the core of the visitor's
question from these notes (for example, real-time pricing, live availability, order status, or
anything else they simply don't cover). In that case only: do not guess, share anything relevant
you do know first, then honestly say you don't have that specific detail, and end your reply with
this exact token on its own line, nothing after it: ${NEEDS_HUMAN_MARKER}

Do NOT add that token just because you're being helpful by suggesting the visitor contact sales
or check the website for more detail — a routine "reach out for the latest info" courtesy line
after an otherwise complete, grounded answer does not count as needing a human. Only use the
token when the answer itself was missing.

<reference-notes>
${notesBlock}
</reference-notes>`;
}

export async function* streamChatResponse(
  businessId: string,
  businessName: string,
  persona: string | null,
  userMessage: string,
  history: ChatMessage[]
): AsyncGenerator<string> {
  const chunks = await retrieveContext(businessId, userMessage, TOP_K);

  const notesBlock = chunks.length
    ? chunks.map((c) => `- (from ${c.sourceUrl ?? c.title}) ${c.content}`).join("\n\n")
    : "No relevant notes found for this question.";

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error("GROQ_API_KEY is not set — copy .env.example to .env and fill it in.");
  }

  const response = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      stream: true,
      messages: [
        { role: "system", content: buildSystemPrompt(businessName, persona, notesBlock) },
        ...history.map((m) => ({ role: m.role, content: m.content })),
        { role: "user", content: userMessage },
      ],
    }),
  });

  if (!response.ok || !response.body) {
    const errText = response.body ? await response.text() : "no response body";
    throw new Error(`Groq request failed: ${response.status} ${errText}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line.startsWith("data:")) continue;

      const payload = line.slice("data:".length).trim();
      if (payload === "[DONE]") return;

      try {
        const parsed = JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] };
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch {
        // ignore malformed/keep-alive lines
      }
    }
  }
}
