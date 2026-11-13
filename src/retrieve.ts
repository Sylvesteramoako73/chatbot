import { pool } from "./db";
import { embedQueryFast } from "./embeddings";

export interface RetrievedChunk {
  content: string;
  sourceUrl: string | null;
  title: string;
  similarity: number;
}

interface ChunkRow {
  content: string;
  source_url: string | null;
  title: string;
  similarity: string;
}

export async function retrieveContext(
  businessId: string,
  query: string,
  topK = 5
): Promise<RetrievedChunk[]> {
  let embedding: number[];
  try {
    embedding = await embedQueryFast(query);
  } catch (err) {
    console.warn("Query embedding unavailable, using keyword search:", (err as Error).message);
    return keywordSearch(businessId, query, topK);
  }
  const vectorLiteral = JSON.stringify(embedding);

  const result = await pool.query<ChunkRow>(
    `SELECT c.content, d.source_url, d.title, 1 - (c.embedding <=> $1) AS similarity
     FROM chunks c
     JOIN documents d ON d.id = c.document_id
     WHERE d.business_id = $3
     ORDER BY c.embedding <=> $1
     LIMIT $2`,
    [vectorLiteral, topK, businessId]
  );

  return result.rows.map((r) => ({
    content: r.content,
    sourceUrl: r.source_url,
    title: r.title,
    similarity: Number(r.similarity),
  }));
}

/**
 * Fallback when the embedding service is rate limited: Postgres full text search over the same
 * chunks, matching any of the question's words and ranking by relevance.
 */
async function keywordSearch(businessId: string, query: string, topK: number): Promise<RetrievedChunk[]> {
  const words = (query.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 2).slice(0, 12);
  if (!words.length) return [];
  const tsquery = words.join(" | ");
  try {
    const result = await pool.query<ChunkRow>(
      `SELECT c.content, d.source_url, d.title,
              ts_rank(to_tsvector('english', c.content), to_tsquery('english', $1)) AS similarity
       FROM chunks c
       JOIN documents d ON d.id = c.document_id
       WHERE d.business_id = $3
         AND to_tsvector('english', c.content) @@ to_tsquery('english', $1)
       ORDER BY similarity DESC
       LIMIT $2`,
      [tsquery, topK, businessId]
    );
    return result.rows.map((r) => ({
      content: r.content,
      sourceUrl: r.source_url,
      title: r.title,
      similarity: Number(r.similarity),
    }));
  } catch (err) {
    console.error("Keyword search failed:", err);
    return [];
  }
}
