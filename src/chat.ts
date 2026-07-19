import { retrieveContext } from "./retrieve";

const MODEL = "llama-3.3-70b-versatile";
const TOP_K = 5;
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

const DEFAULT_PERSONA =
  "You are a helpful assistant for this company's website. Answer questions using only the provided context. If the answer isn't in the context, say you don't know and suggest contacting support.";

// When the bot can't confidently answer from the context, it ends its reply with this exact
// token so the caller can flag the conversation for the sales team — stripped before the
// customer ever sees it, in both the streamed widget response and the WhatsApp reply.
export const NEEDS_HUMAN_MARKER = "[[NEEDS_HUMAN]]";

function buildSystemPrompt(persona: string | null, contextBlock: string): string {
  return `${persona ?? DEFAULT_PERSONA}

Use the following context retrieved from the company website to answer the user's question. Cite sources by their bracketed number when relevant (e.g. "[1]"). Do not invent information that isn't in the context — if the context doesn't cover the question, say so.

Reserve the token below for when you genuinely could not answer the core of the visitor's
question from the context (for example, real-time pricing, live availability, order status, or
anything else the context simply doesn't cover). In that case only: do not guess, share anything
relevant you do know first, then honestly say you don't have that specific detail, and end your
reply with this exact token on its own line, nothing after it: ${NEEDS_HUMAN_MARKER}

Do NOT add that token just because you're being helpful by suggesting the visitor contact sales
or check the website for more detail — a routine "reach out for the latest info" courtesy line
after an otherwise complete, grounded answer does not count as needing a human. Only use the
token when the answer itself was missing.

<context>
${contextBlock}
</context>`;
}

export async function* streamChatResponse(
  businessId: string,
  persona: string | null,
  userMessage: string,
  history: ChatMessage[]
): AsyncGenerator<string> {
  const chunks = await retrieveContext(businessId, userMessage, TOP_K);

  const contextBlock = chunks.length
    ? chunks.map((c, i) => `[${i + 1}] (source: ${c.sourceUrl ?? c.title})\n${c.content}`).join("\n\n")
    : "No relevant context was found in the knowledge base.";

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
        { role: "system", content: buildSystemPrompt(persona, contextBlock) },
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
