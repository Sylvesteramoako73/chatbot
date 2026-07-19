import { pool } from "./db";
import { embedTexts } from "./embeddings";

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
  const [embedding] = await embedTexts([query], "query");
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
