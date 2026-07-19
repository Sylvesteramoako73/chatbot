const VOYAGE_API_URL = "https://api.voyageai.com/v1/embeddings";
const EMBEDDING_MODEL = "voyage-3";

interface VoyageEmbeddingResponse {
    data: { embedding: number[] }[];
}

// Free-tier Voyage accounts (no billing on file) are limited to 3 requests/minute.
// Space calls out so we don't get rate-limited mid-crawl, and retry with backoff if we do.
const MIN_INTERVAL_MS = 21000;
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
