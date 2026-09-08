-- FILE: migrations/027_tenant_review_checkpoints.sql
-- STARLANE — Irresistible Value Engine, Capability B: "What Changed Since
-- Last Look". Additive only — new table, no changes to any existing table.
--
-- One checkpoint row per tenant (user_id) recording the last reviewed
-- snapshot (Business Pulse + revelations + cash forecast, as a jsonb blob)
-- and when it was taken. whatChangedSinceLastLook.js diffs the current
-- computed state against this stored snapshot, then upserts it.

CREATE TABLE IF NOT EXISTS tenant_review_checkpoints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE,
  last_reviewed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tenant_review_checkpoints_user ON tenant_review_checkpoints (user_id);
