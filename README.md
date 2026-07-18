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

- `POST /api/chat` — `{ message: string, history?: {role, content}[], sessionId?: string }` → streamed plain-text response.
  Pass `sessionId` to get persistence and WhatsApp handoff; omit it for a stateless one-off call.
- `POST /api/chat/handoff` — `{ sessionId: string }` → flips that session into WhatsApp handoff mode and
  notifies the owner
- `GET /api/chat/stream/:sessionId` — Server-Sent Events stream; pushes the owner's WhatsApp replies
  back to the widget live
- `POST /api/webhooks/whatsapp` / `GET /api/webhooks/whatsapp` — Meta Cloud API webhook (inbound
  messages / verification handshake)
- `POST /api/ingest/document` — `{ title: string, content: string }` → `{ documentId, chunkCount }`
- `POST /api/ingest/crawl` — `{ url: string, maxPages?: number }` → starts a background crawl
- `GET /health` — liveness check

## WhatsApp handoff

The widget has a "Talk to a person" button. Clicking it marks that visitor's conversation as
`handoff` and sends the owner a WhatsApp message with the recent transcript. From then on:

- The visitor's further messages are relayed straight to the owner's WhatsApp as plain text (the bot
  stops answering for that conversation).
- The owner's WhatsApp replies are pushed live into the widget via Server-Sent Events — the visitor
  never leaves the website.

**Setup (Meta Cloud API):**

1. In the Meta Business dashboard, note your app's permanent access token and phone number ID —
   set `WHATSAPP_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID`.
2. Set `OWNER_WHATSAPP_NUMBER` to the phone number (E.164, e.g. `233241234567`) that should receive
   handoff notifications and reply on behalf of the business.
3. Pick a `WHATSAPP_VERIFY_TOKEN` (any string you choose) and register the webhook in the Meta App
   dashboard as `https://your-server.example.com/api/webhooks/whatsapp`, subscribed to the
   `messages` field.

**Two things Meta's API requires that this doesn't paper over:**

- **24-hour window.** Free-form text to a WhatsApp number only works within 24h of that number's
  last message *to* your business number. Have the owner send your business WhatsApp number a "hi"
  once to open the window (and again if 24h passes with no messages). For fully hands-off operation
  across that gap, set `WHATSAPP_TEMPLATE_NAME` to a pre-approved message template — it's used
  automatically as a fallback when a free-form send is rejected.
- **Routing replies to the right visitor.** Multiple visitors can be in handoff mode at once, all
  messaging the same owner number. When the owner **swipe-replies** to a specific notification,
  the reply is routed to that exact visitor (via WhatsApp's `context.id` on the reply). A plain,
  non-quoted reply falls back to "most recently active handoff conversation" — fine with one
  conversation at a time, ambiguous with several. Tell the owner to swipe-reply when more than one
  visitor is waiting.

This also assumes a single server instance — the live SSE relay is in-process. Running multiple
instances behind a load balancer would need a shared pub/sub (e.g. Redis) instead.

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
