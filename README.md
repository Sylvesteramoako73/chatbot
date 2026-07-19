# Website Chatbot

A multi-tenant RAG (retrieval-augmented generation) chatbot platform. Each business signs up, feeds
it their site content (crawled automatically, or via manually-uploaded docs), embeds a widget on
their own website, and optionally connects their own WhatsApp Business number. A bot answers
visitor questions automatically — grounded in that business's own content — and a team inbox
dashboard lets reps pick up any conversation (from the widget *or* WhatsApp) and reply directly,
live, from one screen.

## Architecture

```
Business signs up --> gets a site key + a team dashboard
Website / docs --(crawl or upload, scoped to that business)--> chunk --> Voyage embeddings --> pgvector
                                                                                   |
Visitor message --(widget.js, data-site-key)--> POST /api/chat --> retrieve --> bot answers (Groq)
Customer WhatsApp message --> webhook (routed by phone_number_id) --> same retrieval --> bot answers
                                                                                   |
                                              Rep "picks up" the conversation in the dashboard
                                                                                   |
                                    Rep reply --> widget (Server-Sent Events) or WhatsApp (Cloud API)
```

- **Backend**: Node.js + TypeScript + Express
- **Auth**: cookie sessions (`express-session` + `connect-pg-simple`), `bcryptjs` for passwords
- **Embeddings**: Voyage AI (`voyage-3`)
- **Vector store**: Postgres with the `pgvector` extension (Supabase and Neon both support it out of the box on their free tiers)
- **Chat model**: Groq (`llama-3.3-70b-versatile`), streamed to the browser
- **Widget**: a single vanilla-JS `<script>` tag, no framework required
- **Dashboard**: plain HTML/CSS/vanilla JS, no build step — served from `public/dashboard/`

## Setup

1. **Provision Postgres with pgvector.** Easiest options: a free [Supabase](https://supabase.com) or [Neon](https://neon.tech) project — both ship pgvector pre-installed. Grab the connection string.

2. **Configure environment variables:**

   ```bash
   cp .env.example .env
   ```

   Fill in:
   - `GROQ_API_KEY` — from [console.groq.com](https://console.groq.com)
   - `VOYAGE_API_KEY` — from [dash.voyageai.com](https://dash.voyageai.com)
   - `DATABASE_URL` — your Postgres connection string
   - `SESSION_SECRET` — any long random string (`openssl rand -hex 32`)
   - `WHATSAPP_VERIFY_TOKEN` — any string you pick; every business's Meta App uses this same value (see [WhatsApp connection](#whatsapp-connection) below)

3. **Install dependencies and run:**

   ```bash
   npm install
   npm run dev
   ```

   `npm start` (used in production) runs `src/migrate.ts` first, which applies `sql/schema.sql`
   automatically — no manual `psql` step needed.

4. **Sign up.** Open `http://localhost:3000/dashboard/signup.html`, create a business + admin
   account. You land on Settings, which shows your embed snippet (with your real, generated site key)
   and lets you crawl a site or paste a document to feed the bot.

5. **Embed the widget** on your actual site using the snippet from Settings:

   ```html
   <script src="https://your-server.example.com/widget/widget.js"
           data-api-url="https://your-server.example.com/api/chat"
           data-site-key="sk_live_..."></script>
   ```

6. **Try it locally:** `public/widget-demo.html` has a placeholder — swap in your real site key and
   open it via the running server (`http://localhost:3000/widget/widget-demo.html`).

## Team inbox dashboard

`http://localhost:3000/dashboard/index.html` — a live inbox across both channels (widget + WhatsApp):

- **Unclaimed / Mine / All** tabs filter the conversation list.
- Clicking a conversation shows the full thread and, if unclaimed, a **Pick up** button. Claiming is
  atomic — if two reps click at once, only one wins.
- Once claimed, replies are typed directly in the dashboard. They relay out live over whichever
  channel the customer used: **Server-Sent Events** back into the widget (no page reload on the
  visitor's end), or the **WhatsApp Cloud API** if the customer messaged the connected number.
- **Closing** a conversation hands it back to the bot, so if that same customer writes again later
  the bot answers automatically until someone picks it up again.
- The widget also has a **"Talk to a person"** button the visitor can click to flag their own
  conversation as needing a human, without waiting for the bot to fail first.

There are two ways a conversation reaches the sales team:

1. **Manual** — the visitor clicks "Talk to a person" (or messages asking for one on WhatsApp).
2. **Automatic** — the bot's system prompt (`src/chat.ts`) instructs it to end its reply with a
   hidden marker whenever the retrieved context doesn't fully answer the question. The server
   strips that marker before the customer ever sees it (in both the streamed widget response and
   the WhatsApp message), flags the conversation the same way the manual button does, and — for
   the widget — pushes a short "I've flagged this for our team" notice into the chat live so the
   visitor knows what happened. Either way, the conversation just shows up unclaimed in the
   dashboard for any rep to pick up.

## WhatsApp connection

Each business connects **their own** WhatsApp number from their Settings page (access token + phone
number ID from the Meta Cloud API) — this app is multi-tenant, so there's no single global WhatsApp
account.

**Setup, per business:**

1. In the Meta Business dashboard, create/use a WhatsApp Business app, grab its permanent access
   token and phone number ID, and paste them into Settings → WhatsApp connection.
2. Register a webhook in **that same Meta App** pointing at
   `https://your-server.example.com/api/webhooks/whatsapp`, subscribed to the `messages` field, using
   the verify token from this deployment's `WHATSAPP_VERIFY_TOKEN` env var (same value for every
   business — Meta's verify handshake has no way to carry per-tenant info, so incoming *messages* are
   instead routed to the right business by matching `phone_number_id`, not by the verify token or the
   webhook URL).

**Two things Meta's API requires that this doesn't paper over:**

- **24-hour window.** Free-form text to a WhatsApp number only works within 24h of that number's
  last message *to* the connected business number — a customer messaging in starts the bot's reply
  window; if a rep or the bot needs to message first after 24h of silence, Meta requires a
  pre-approved message template instead (`whatsappTemplateName` in Settings).
- **Full "Embedded Signup"** (connecting WhatsApp via an OAuth popup instead of pasting credentials)
  requires Meta Tech Provider approval, an external business-verification process. Not built —
  businesses paste their own credentials for now.

## API

- `POST /api/chat` — `{ siteKey, sessionId, message, history? }` → streamed plain-text bot response,
  or an empty response if the conversation is already claimed by a rep (their reply arrives over SSE)
- `POST /api/chat/handoff` — `{ siteKey, sessionId }` → flags the conversation as needing a human
- `GET /api/chat/stream?siteKey=...&sessionId=...` — Server-Sent Events; pushes a rep's reply live
- `POST /api/webhooks/whatsapp` / `GET /api/webhooks/whatsapp` — Meta Cloud API webhook
- `POST /api/auth/signup` / `login` / `logout`, `GET /api/auth/me`
- `GET /api/dashboard/conversations?filter=unclaimed|mine|all`
- `GET /api/dashboard/conversations/:id/messages`
- `POST /api/dashboard/conversations/:id/claim` / `close` / `reply`
- `GET /api/dashboard/stream` — SSE, live updates for the whole inbox
- `GET`/`PUT /api/dashboard/settings` — system prompt, WhatsApp credentials, site key (admin only)
- `GET`/`POST /api/dashboard/team` — team members (adding one is admin only)
- `POST /api/ingest/document` — `{ title, content }` → `{ documentId, chunkCount }` (signed-in business)
- `POST /api/ingest/crawl` — `{ url, maxPages? }` → starts a background crawl (signed-in business)
- `GET /health` — liveness check

CLI equivalents for ingest (useful for scripting): `npm run ingest:crawl -- <siteKey> <url> [maxPages]`,
`npm run ingest:doc -- <siteKey> <file>`.

## Notes / next steps

- **WhatsApp credentials are stored in plaintext** in the `businesses` table. Fine for an MVP with a
  small number of tenants, but a real gap — a database compromise would leak every tenant's WhatsApp
  access token at once. A production hardening pass should encrypt these columns (e.g. pgcrypto) or
  move them to a secrets manager.
- **No invite emails yet.** An admin adds a teammate directly from Settings with a temporary password
  they share out-of-band — there's no email-sending infrastructure in this project yet.
- **Re-ingesting** doesn't currently dedupe against previously-crawled pages — running the crawler
  twice will store duplicate documents. For a production setup, key documents by `source_url` and
  upsert instead of insert.
- **Single-instance only.** The SSE relay (both widget and dashboard) is in-process — running this
  behind a load balancer with more than one instance would need a shared pub/sub (e.g. Redis) instead
  of `src/events.ts`'s in-memory `EventEmitter`.
- **Model**: uses `llama-3.3-70b-versatile` via Groq by default. Swap the `MODEL` constant in
  `src/chat.ts` for a different Groq-hosted model if you want a different cost/latency/quality trade-off.
