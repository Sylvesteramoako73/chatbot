# Website Chatbot

A RAG (retrieval-augmented generation) chatbot you embed on your website. It's fed with your
site's content (crawled automatically, or via manually-uploaded docs), stores it as embeddings
in Postgres/pgvector, and answers visitor questions through the Claude API — grounded in your
actual content instead of guessing.

## Architecture

```
Website / docs --(crawl or upload)--> chunk --> Voyage embeddings --> pgvector (Postgres)
                                                                            |
Visitor message --(widget.js)--> POST /api/chat --> embed query --> retrieve top-k chunks
                                                                            |
                                                              Claude (claude-opus-4-8) + context --> streamed answer
```

- **Backend**: Node.js + TypeScript + Express
- **Embeddings**: Voyage AI (`voyage-3`)
- **Vector store**: Postgres with the `pgvector` extension (Supabase and Neon both support it out of the box on their free tiers)
- **Chat model**: Claude API (`claude-opus-4-8`), streamed to the browser
- **Widget**: a single vanilla-JS `<script>` tag, no framework required

## Setup

1. **Provision Postgres with pgvector.** Easiest options: a free [Supabase](https://supabase.com) or [Neon](https://neon.tech) project — both ship pgvector pre-installed. Grab the connection string.

2. **Apply the schema:**

   ```bash
   psql "$DATABASE_URL" -f sql/schema.sql
   ```

3. **Configure environment variables:**

   ```bash
   cp .env.example .env
   ```

   Fill in:
   - `ANTHROPIC_API_KEY` — from [console.anthropic.com](https://console.anthropic.com)
   - `VOYAGE_API_KEY` — from [dash.voyageai.com](https://dash.voyageai.com)
   - `DATABASE_URL` — your Postgres connection string
   - `COMPANY_SYSTEM_PROMPT` — optional; describe your company/tone here

4. **Install dependencies:**

   ```bash
   npm install
   ```

5. **Feed it your website:**

   ```bash
   npm run ingest:crawl -- https://yourcompany.com 50
   ```

   This crawls up to 50 same-origin pages, strips nav/footer boilerplate, chunks the text,
   embeds each chunk, and stores it. Re-run any time your site content changes.

   To add a document that isn't on the public site (an internal FAQ, a PDF you've converted
   to text, pricing sheet, etc.):

   ```bash
   npm run ingest:doc -- ./docs/faq.txt
   ```

   Or programmatically via `POST /api/ingest/document` (see below).

6. **Run the server:**

   ```bash
   npm run dev
   ```

7. **Try the widget:** open `http://localhost:3000/widget/widget-demo.html` — the chat bubble
   in the bottom-right corner is live against your ingested content.

## Embedding on your real site

Add one line before `</body>`:

```html
<script src="https://your-server.example.com/widget/widget.js"
        data-api-url="https://your-server.example.com/api/chat"></script>
```

## API

- `POST /api/chat` — `{ message: string, history?: {role, content}[] }` → streamed plain-text response
- `POST /api/ingest/document` — `{ title: string, content: string }` → `{ documentId, chunkCount }`
- `POST /api/ingest/crawl` — `{ url: string, maxPages?: number }` → starts a background crawl
- `GET /health` — liveness check

## Notes / next steps

- **Re-ingesting** doesn't currently dedupe against previously-crawled pages — running the
  crawler twice will store duplicate documents. For a production setup, key documents by
  `source_url` and upsert instead of insert.
- **Auth**: `/api/ingest/*` has no auth in this scaffold — put it behind your admin auth or an
  internal network before deploying, so the public can't rewrite your knowledge base.
- **Conversation persistence**: the widget keeps history in memory (lost on page reload). Add
  a session ID + a `conversations` table if you want cross-visit history.
- **Model**: uses `claude-opus-4-8` by default. Swap the `MODEL` constant in `src/chat.ts` for
  `claude-sonnet-5` if you want lower cost/latency at slightly less capability for high-volume traffic.
