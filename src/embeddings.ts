const VOYAGE_API_URL = "https://api.voyageai.com/v1/embeddings";
const EMBEDDING_MODEL = "voyage-3";

interface VoyageEmbeddingResponse {
    data: { embedding: number[] }[];
}

// Free-tier Voyage accounts (no billing on file) are limited to 3 requests/minute.
// Space calls out so we don't get rate-limited mid-crawl, and retry with backoff if we do.
// Set VOYAGE_MIN_INTERVAL_MS=0 once billing is added to the Voyage account (limits then go way up).
const MIN_INTERVAL_MS = Number(process.env.VOYAGE_MIN_INTERVAL_MS ?? 21000);
let lastCallAt = 0;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRateLimit() {
    const elapsed = Date.now() - lastCallAt;
    if (elapsed < MIN_INTERVAL_MS) {
          await sleep(MIN_INTERVAL_MS - elapsed);
    }
    lastCallAt = Date.now();
}

/**
 * One quick embedding for a visitor's question. Never queues behind the crawl throttle and never
 * retries: a chat reply can't wait 20+ seconds, so on a rate limit or slow response this throws
 * and the caller falls back to keyword search.
 */
export async function embedQueryFast(text: string, timeoutMs = 6000): Promise<number[]> {
  if (!process.env.VOYAGE_API_KEY) throw new Error("VOYAGE_API_KEY is not set");
  const res = await fetch(VOYAGE_API_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ input: [text], model: EMBEDDING_MODEL, input_type: "query" }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Voyage query embedding failed: ${res.status}`);
  const data = (await res.json()) as VoyageEmbeddingResponse;
  return data.data[0].embedding;
}

export async function embedTexts(
    texts: string[],
    inputType: "query" | "document"
  ): Promise<number[][]> {
    if (!process.env.VOYAGE_API_KEY) {
          throw new Error("VOYAGE_API_KEY is not set — copy .env.example to .env and fill it in.");
    }
    if (texts.length === 0) return [];

  const maxRetries = 6;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
          await waitForRateLimit();

      const res = await fetch(VOYAGE_API_URL, {
              method: "POST",
              headers: {
                        Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
                        "Content-Type": "application/json",
              },
              body: JSON.stringify({
                        input: texts,
                        model: EMBEDDING_MODEL,
                        input_type: inputType,
              }),
      });

      if (res.status === 429 && attempt < maxRetries) {
              const retryAfterHeader = res.headers.get("retry-after");
              const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : 30000;
              console.warn(
                        `Voyage rate limit hit, retrying in ${retryAfterMs}ms (attempt ${attempt + 1}/${maxRetries})`
                      );
              await sleep(retryAfterMs);
              continue;
      }

      if (!res.ok) {
              const body = await res.text();
              throw new Error(`Voyage embeddings request failed: ${res.status} ${body}`);
      }

      const data = (await res.json()) as VoyageEmbeddingResponse;
          return data.data.map((d) => d.embedding);
    }

  throw new Error("Voyage embeddings request failed after retries due to rate limiting");
}
