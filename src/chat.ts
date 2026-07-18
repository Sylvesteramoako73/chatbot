import { retrieveContext } from "./retrieve";

const MODEL = "gemini-2.0-flash";
const TOP_K = 5;

export interface ChatMessage {
    role: "user" | "assistant";
    content: string;
}

const DEFAULT_PERSONA =
    "You are a helpful assistant for this company's website. Answer questions using only the provided context. If the answer isn't in the context, say you don't know and suggest contacting support.";

function buildSystemPrompt(contextBlock: string): string {
    const persona = process.env.COMPANY_SYSTEM_PROMPT ?? DEFAULT_PERSONA;
    return `${persona}

    Use the following context retrieved from the company website to answer the user's question. Cite sources by their bracketed number when relevant. Do not invent information that isn't in the context.

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

  const contents = [
        ...history.map((m) => ({
                role: m.role === "assistant" ? "model" : "user",
                parts: [{ text: m.content }],
        })),
    { role: "user", parts: [{ text: userMessage }] },
      ];

  const apiKey = process.env.GEMINI_API_KEY;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`;

  const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
                contents,
                systemInstruction: { parts: [{ text: systemPrompt }] },
        }),
  });

  if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Gemini request failed: ${response.status} ${errText}`);
  }

  const data = await response.json();
    const parts = data.candidates?.[0]?.content?.parts ?? [];
    const text = parts.map((p: { text: string }) => p.text).join("");
    yield text;
}
