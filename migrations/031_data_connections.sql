-- FILE: migrations/031_data_connections.sql
-- STARLANE — Data Connections model (Tally-brain heartbeat foundation).
--
-- Additive only: new table, no existing table touched or altered.
-- Tracks, per tenant (user), the connection status of each ingestion
-- source (Tally, file import, and future accounting integrations).
-- The local Tally connector reports itself alive by calling
-- POST /api/connections/heartbeat, which upserts a row here.

CREATE TABLE IF NOT EXISTS data_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL, -- 'TALLY' | 'FILE_IMPORT' | 'QUICKBOOKS' | 'ZOHO_BOOKS' | 'XERO'
  status TEXT NOT NULL DEFAULT 'NOT_CONNECTED', -- NOT_CONNECTED | PENDING_PERMISSION | CONNECTED | ERROR | DISCONNECTED
  connected_at TIMESTAMPTZ,
  last_sync_at TIMESTAMPTZ,
  last_sync_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One connection record per tenant per source type.
  UNIQUE (user_id, source_type)
);

CREATE INDEX IF NOT EXISTS idx_data_connections_user ON data_connections(user_id);

-- No RLS policy changes, no defaults that fabricate data.
