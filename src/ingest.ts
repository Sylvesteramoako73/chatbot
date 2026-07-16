import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { pool } from "./db";
import { crawlSite } from "./crawler";
import { chunkText } from "./chunk";
import { embedTexts } from "./embeddings";

const EMBED_BATCH_SIZE = 32;

export async function ingestDocument(title: string, content: string, sourceUrl?: string) {
  const docResult = await pool.query<{ id: number }>(
    "INSERT INTO documents (source_url, title, content) VALUES ($1, $2, $3) RETURNING id",
    [sourceUrl ?? null, title, content]
  );
  const documentId = docResult.rows[0].id;

  const chunks = chunkText(content);
  if (chunks.length === 0) return { documentId, chunkCount: 0 };

  let chunkCount = 0;
  for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
    const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
    const embeddings = await embedTexts(batch, "document");
    for (let j = 0; j < batch.length; j++) {
      // pgvector accepts a bracketed literal like "[0.1,0.2,...]" as text input.
      await pool.query("INSERT INTO chunks (document_id, content, embedding) VALUES ($1, $2, $3)", [
        documentId,
        batch[j],
        JSON.stringify(embeddings[j]),
      ]);
      chunkCount++;
    }
  }

  return { documentId, chunkCount };
}

export async function ingestWebsite(startUrl: string, maxPages = 50) {
  const pages = await crawlSite(startUrl, maxPages);
  const results = [];
  for (const page of pages) {
    const result = await ingestDocument(page.title, page.text, page.url);
    results.push({ url: page.url, ...result });
    console.log(`Ingested ${page.url} -> ${result.chunkCount} chunks`);
  }
  return results;
}

async function main() {
  const [, , mode, arg] = process.argv;

  if (mode === "crawl" && arg) {
    await ingestWebsite(arg);
  } else if (mode === "doc" && arg) {
    const content = fs.readFileSync(arg, "utf-8");
    const result = await ingestDocument(path.basename(arg), content, arg);
    console.log(`Ingested ${arg} -> ${result.chunkCount} chunks`);
  } else {
    console.log("Usage:");
    console.log("  npm run ingest:crawl -- <url> [maxPages]");
    console.log("  npm run ingest:doc -- <file>");
    process.exitCode = 1;
    return;
  }

  await pool.end();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
