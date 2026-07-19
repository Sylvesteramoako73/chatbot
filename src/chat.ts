import { retrieveContext } from "./retrieve";

const MODEL = "llama-3.3-70b-versatile";
const TOP_K = 5;

export interface ChatMessage {
        role: "user" | "assistant";
        content: string;
}

const DEFAULT_PERSONA =
        "You are a helpful assistant for this company's website. Answer questions using only the provided context. If the answer isn't in the context, say you don't know and suggest contacting support.";

// When the model can't fully answer from the context, it's instructed to end its reply with this
// exact token so the server can strip it out and automatically hand the conversation off to the
// sales team over WhatsApp, instead of leaving the visitor stuck with an unhelpful dead end.
export const HANDOFF_MARKER = "[[HANDOFF_TO_SALES]]";

function buildSystemPrompt(contextBlock: string): string {
        const persona = process.env.COMPANY_SYSTEM_PROMPT ?? DEFAULT_PERSONA;
        return `${persona}
        Use the following context retrieved from the company website to answer the user's question. Cite sources by their bracketed number when relevant. Do not invent information that isn't in the context.

        If the context above does not fully and confidently answer the visitor's question (for example, current pricing, availability, order status, or anything else not covered), do not guess or make anything up. Instead: briefly share anything relevant you do know from the context (if any), then honestly say you don't have that specific detail. End your reply with this exact token on its own line, and nothing after it: ${HANDOFF_MARKER}
        <context>
        ${contextBlock}
        </context>`;
}

export async function* streamChatResponse(
        userMessage: string,
        history: ChatMessage[]
      ): AsyncGenerator<string> {
        const chunks = await retrieveContext(userMessage, TOP_K);

  const contextBlock = chunks.length
          ? chunks.map((c, i) => `[${i + 1}] (source: ${c.sourceUrl ?? c.title})\n${c.content}`).join("\n\n")
            : "No relevant context was found in the knowledge base.";

  const systemPrompt = buildSystemPrompt(contextBlock);

  const messages = [
        { role: "system", content: systemPrompt },
            ...history.map((m) => ({ role: m.role, content: m.content })),
        { role: "user", content: userMessage },
          ];

  const apiKey = process.env.GROQ_API_KEY;
        const url = "https://api.groq.com/openai/v1/chat/completions";

  const response = await fetch(url, {
            method: "POST",
            headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                        model: MODEL,
                        messages,
            }),
  });

  if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Groq request failed: ${response.status} ${errText}`);
  }

  const data = (await response.json()) as any;
        const text = data.choices?.[0]?.message?.content ?? "";
        yield text;
}
