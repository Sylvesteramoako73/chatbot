import Anthropic from "@anthropic-ai/sdk";
import { retrieveContext } from "./retrieve";

const anthropic = new Anthropic();
const MODEL = "claude-opus-4-8";
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

Use the following context retrieved from the company website to answer the user's question. Cite sources by their bracketed number when relevant (e.g. "[1]"). Do not invent information that isn't in the context — if the context doesn't cover the question, say so.

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

  const stream = anthropic.messages.stream({
    model: MODEL,
    max_tokens: 1024,
    system: buildSystemPrompt(contextBlock),
    thinking: { type: "adaptive" },
    messages: [
      ...history.map((m) => ({ role: m.role, content: m.content })),
      { role: "user" as const, content: userMessage },
    ],
  });

  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      yield event.delta.text;
    }
  }
}
