const VOYAGE_API_URL = "https://api.voyageai.com/v1/embeddings";
const EMBEDDING_MODEL = "voyage-3";

interface VoyageEmbeddingResponse {
  data: { embedding: number[] }[];
}

export async function embedTexts(
  texts: string[],
  inputType: "query" | "document"
): Promise<number[][]> {
  if (!process.env.VOYAGE_API_KEY) {
    throw new Error("VOYAGE_API_KEY is not set — copy .env.example to .env and fill it in.");
  }
  if (texts.length === 0) return [];

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

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Voyage embeddings request failed: ${res.status} ${body}`);
  }

  const data = (await res.json()) as VoyageEmbeddingResponse;
  return data.data.map((d) => d.embedding);
}
