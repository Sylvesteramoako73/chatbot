-- Requires the pgvector extension (available by default on Supabase and Neon).
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- One row per tenant. site_key is the public identifier embedded in that
-- business's widget <script> tag; whatsapp_* columns hold that business's own
-- Cloud API credentials (plaintext — see README's security note on this).
CREATE TABLE IF NOT EXISTS businesses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  site_key TEXT UNIQUE NOT NULL,
  allowed_origin TEXT,
  system_prompt TEXT,
  whatsapp_token TEXT,
  whatsapp_phone_number_id TEXT UNIQUE,
  whatsapp_template_name TEXT,
  telegram_bot_token TEXT UNIQUE,
  instagram_page_id TEXT UNIQUE,
  instagram_token TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- migrate.ts runs this file with CREATE TABLE IF NOT EXISTS, which no-ops on a table that already
-- exists — these ALTERs are what actually add the columns above to a pre-existing businesses table.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS telegram_bot_token TEXT UNIQUE;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS instagram_page_id TEXT UNIQUE;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS instagram_token TEXT;

CREATE TABLE IF NOT EXISTS team_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin', -- 'admin' | 'agent'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS documents (
  id SERIAL PRIMARY KEY,
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  source_url TEXT,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS documents_business_id_idx ON documents (business_id);

-- voyage-3 embeddings are 1024-dimensional. If you switch embedding models,
-- update this dimension to match (voyage-3-lite = 512, voyage-3-large = 1024/2048).
CREATE TABLE IF NOT EXISTS chunks (
  id SERIAL PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  embedding VECTOR(1024) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chunks_embedding_idx
  ON chunks USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

CREATE INDEX IF NOT EXISTS chunks_document_id_idx ON chunks (document_id);

-- One row per lead (a real person), independent of which channel(s) they've messaged on. There's
-- no reliable shared identifier across a phone number / Telegram chat id / Instagram-scoped id, so
-- each new conversation gets its own new lead by default — merging across channels is a manual
-- action a rep takes in the dashboard when they recognize it's the same person (see conversations.ts).
CREATE TABLE IF NOT EXISTS leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT,
  phone TEXT,
  email TEXT,
  stage TEXT NOT NULL DEFAULT 'new', -- new | contacted | qualified | negotiating | won | lost
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS leads_business_id_idx ON leads (business_id);

-- One row per customer thread, whichever channel it started on. external_id is the widget's
-- sessionId for channel='widget', the customer's WhatsApp number for channel='whatsapp', the chat
-- id for channel='telegram', or the Instagram-scoped user id for channel='instagram'.
CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  channel TEXT NOT NULL, -- 'widget' | 'whatsapp' | 'telegram' | 'instagram'
  external_id TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'bot', -- 'bot' | 'human'
  claimed_by UUID REFERENCES team_members(id),
  lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
  unread_count INTEGER NOT NULL DEFAULT 0,
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, channel, external_id)
);
CREATE INDEX IF NOT EXISTS conversations_business_id_idx ON conversations (business_id);

-- Same reasoning as the businesses ALTERs above — adds lead_id/unread_count to a conversations
-- table that already exists in production without them. Must run before the index below, since
-- CREATE TABLE IF NOT EXISTS is a no-op on that pre-existing table and never adds columns itself.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS lead_id UUID REFERENCES leads(id) ON DELETE SET NULL;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS unread_count INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS conversations_lead_id_idx ON conversations (lead_id);

CREATE TABLE IF NOT EXISTS conversation_messages (
  id SERIAL PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL, -- 'customer' | 'bot' | 'agent'
  content TEXT NOT NULL,
  wamid TEXT, -- WhatsApp message id, set on messages we send out over WhatsApp
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS conversation_messages_conversation_id_idx
  ON conversation_messages (conversation_id);
CREATE INDEX IF NOT EXISTS conversation_messages_wamid_idx
  ON conversation_messages (wamid);

-- Browser push subscriptions, one row per device a team member enabled notifications on.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_member_id UUID NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS push_subscriptions_team_member_id_idx ON push_subscriptions (team_member_id);

-- express-session's connect-pg-simple store creates/manages its own "session"
-- table automatically on first connect — no DDL needed here.
