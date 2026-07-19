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
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

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

-- One row per customer thread, whichever channel it started on. external_id
-- is the widget's sessionId for channel='widget', or the customer's WhatsApp
-- number (E.164) for channel='whatsapp'.
CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  channel TEXT NOT NULL, -- 'widget' | 'whatsapp'
  external_id TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'bot', -- 'bot' | 'human'
  claimed_by UUID REFERENCES team_members(id),
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, channel, external_id)
);
CREATE INDEX IF NOT EXISTS conversations_business_id_idx ON conversations (business_id);

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

-- express-session's connect-pg-simple store creates/manages its own "session"
-- table automatically on first connect — no DDL needed here.
