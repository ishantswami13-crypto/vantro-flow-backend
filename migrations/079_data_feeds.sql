-- Migration 079: data feeds — keep operational data flowing in from the
-- software a business already uses, through the same checked import.
--
--   data_feeds      one row per saved feed: which records it brings in
--                   (kind: products | components | orders | purchase_lines),
--                   where they come from (source_type), the column mapping
--                   and options the owner confirmed once, and when it runs.
--                   Every run hands the source's rows to the operational
--                   import (lib/domain/operations/operationalImport.js), so
--                   a feed gets exactly the validation, row identity, dedup,
--                   review rules and audit trail of a file upload.
--
--     source_type   sheet_link  a Google Sheet share link
--                   file_url    an https address that serves CSV, Excel or JSON
--                               (an ERP's scheduled export, a shared file link)
--                   push        any software sends rows to Starlane with the
--                               feed's own key (POST /api/feeds/in/<key>)
--                   app         a connected app (Shopify, WooCommerce,
--                               Zoho Inventory, QuickBooks Online)
--
--   data_feed_runs  one row per attempt, with counts, so the page shows what
--                   really happened.
--
-- Secrets: a push key is stored only as its SHA-256 hash. A file_url's
-- optional request header (e.g. an API token) is AES-256-GCM encrypted with
-- OUTBOUND_CREDENTIALS_KEY and never returned. App credentials stay in
-- app_connector_accounts (migration 070).
--
-- Additive only. user_id scopes every row (REFERENCES users ON DELETE
-- CASCADE); RLS enabled, the service-role backend filters by user_id.

CREATE TABLE IF NOT EXISTS data_feeds (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name              TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  kind              TEXT NOT NULL CHECK (kind IN ('products', 'components', 'orders', 'purchase_lines')),
  source_type       TEXT NOT NULL CHECK (source_type IN ('sheet_link', 'file_url', 'push', 'app')),
  source_config     JSONB NOT NULL DEFAULT '{}'::jsonb,   -- non-secret: url, connector id, object
  secret_enc        TEXT,                                  -- encrypted request header for file_url
  push_token_hash   TEXT UNIQUE,                           -- sha256 of the push key
  mapping           JSONB NOT NULL,                        -- the confirmed import options
  interval_minutes  INT CHECK (interval_minutes IS NULL OR interval_minutes BETWEEN 15 AND 10080),
  status            TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'PAUSED', 'NEEDS_ATTENTION')),
  status_reason     TEXT,
  next_run_at       TIMESTAMPTZ,
  last_run_at       TIMESTAMPTZ,
  last_success_at   TIMESTAMPTZ,
  last_batch_id     UUID,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_data_feeds_user ON data_feeds (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_data_feeds_due ON data_feeds (next_run_at) WHERE status = 'ACTIVE' AND interval_minutes IS NOT NULL;
ALTER TABLE data_feeds ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS data_feed_runs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feed_id           UUID NOT NULL REFERENCES data_feeds(id) ON DELETE CASCADE,
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trigger           TEXT NOT NULL CHECK (trigger IN ('manual', 'schedule', 'push', 'setup')),
  status            TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'imported', 'unchanged', 'needs_attention', 'failed')),
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at       TIMESTAMPTZ,
  rows_received     INT NOT NULL DEFAULT 0,
  rows_accepted     INT NOT NULL DEFAULT 0,
  rows_rejected     INT NOT NULL DEFAULT 0,
  rows_review       INT NOT NULL DEFAULT 0,
  batch_id          UUID,
  error             TEXT,
  details           JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_data_feed_runs_feed ON data_feed_runs (feed_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_data_feed_runs_user ON data_feed_runs (user_id, started_at DESC);
ALTER TABLE data_feed_runs ENABLE ROW LEVEL SECURITY;
