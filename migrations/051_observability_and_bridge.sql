-- Migration 051: product events, connector sync runs, bridge device metadata
--
-- 1. product_events — an append-only record of the moments that matter when
--    onboarding the first real companies (application submitted, access link
--    opened, device paired, sync succeeded/failed, recommendation generated,
--    approval completed, action executed, …). Identifiers only: no secrets,
--    no free-text customer content. Written by lib/observability/productEvents.js
--    alongside a structured log line, so the same facts are queryable in SQL
--    and visible in Railway logs.
-- 2. connector_sync_runs — one row per bridge sync attempt, so connector health
--    is computed from real attempts (started / succeeded / failed, records
--    received/imported/rejected, error) instead of a single last_sync_at.
-- 3. connector_devices gains client_version, platform, bound_env and
--    last_token_at, for the short-lived device tokens and device identity.
--
-- Additive only. Safe to re-run.

CREATE TABLE IF NOT EXISTS product_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  event           TEXT NOT NULL,
  request_id      TEXT,
  user_id         UUID,
  application_id  UUID,
  connector_id    TEXT,
  device_id       UUID,
  sync_run_id     UUID,
  action_id       UUID,
  props           JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_product_events_event_time ON product_events (event, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_product_events_user_time ON product_events (user_id, occurred_at DESC);
ALTER TABLE product_events ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS connector_sync_runs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connector_id      TEXT NOT NULL,
  device_id         UUID REFERENCES connector_devices(id) ON DELETE SET NULL,
  status            TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed')),
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at       TIMESTAMPTZ,
  records_received  INT NOT NULL DEFAULT 0,
  records_imported  INT NOT NULL DEFAULT 0,
  records_rejected  INT NOT NULL DEFAULT 0,
  error             TEXT,
  client_version    TEXT
);
CREATE INDEX IF NOT EXISTS idx_connector_sync_runs_user_conn ON connector_sync_runs (user_id, connector_id, started_at DESC);
ALTER TABLE connector_sync_runs ENABLE ROW LEVEL SECURITY;

ALTER TABLE connector_devices ADD COLUMN IF NOT EXISTS client_version TEXT;
ALTER TABLE connector_devices ADD COLUMN IF NOT EXISTS platform TEXT;
ALTER TABLE connector_devices ADD COLUMN IF NOT EXISTS bound_env TEXT;
ALTER TABLE connector_devices ADD COLUMN IF NOT EXISTS last_token_at TIMESTAMPTZ;
