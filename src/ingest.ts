import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { pool } from "./db";
import { crawlSite } from "./crawler";
import { chunkText } from "./chunk";
import { embedTexts } from "./embeddings";

const EMBED_BATCH_SIZE = 32;

export async function ingestDocument(
  businessId: string,
  title: string,
  content: string,
  sourceUrl?: string
) {
  const docResult = await pool.query<{ id: number }>(
    "INSERT INTO documents (business_id, source_url, title, content) VALUES ($1, $2, $3, $4) RETURNING id",
    [businessId, sourceUrl ?? null, title, content]
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

export async function ingestWebsite(businessId: string, startUrl: string, maxPages = 50) {
  const pages = await crawlSite(startUrl, maxPages);
  const results = [];
  for (const page of pages) {
    try {
      const result = await ingestDocument(businessId, page.title, page.text, page.url);
      results.push({ url: page.url, ...result });
      console.log(`Ingested ${page.url} -> ${result.chunkCount} chunks`);
    } catch (err) {
      console.error(`Failed to ingest ${page.url}:`, err);
    }
  }
  console.log(`Crawl finished: ${results.length}/${pages.length} pages ingested successfully.`);
  return results;
}

async function findBusinessIdBySiteKey(siteKey: string): Promise<string> {
  const result = await pool.query<{ id: string }>("SELECT id FROM businesses WHERE site_key = $1", [siteKey]);
  if (!result.rows.length) {
    throw new Error(`No business found with site key "${siteKey}" — check settings.html for the right key.`);
  }
  return result.rows[0].id;
}

async function main() {
  const [, , mode, siteKey, arg] = process.argv;

  if (mode === "crawl" && siteKey && arg) {
    const businessId = await findBusinessIdBySiteKey(siteKey);
    await ingestWebsite(businessId, arg);
  } else if (mode === "doc" && siteKey && arg) {
    const businessId = await findBusinessIdBySiteKey(siteKey);
    const content = fs.readFileSync(arg, "utf-8");
    const result = await ingestDocument(businessId, path.basename(arg), content, arg);
    console.log(`Ingested ${arg} -> ${result.chunkCount} chunks`);
  } else {
    console.log("Usage:");
    console.log("  npm run ingest:crawl -- <siteKey> <url> [maxPages]");
    console.log("  npm run ingest:doc -- <siteKey> <file>");
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
