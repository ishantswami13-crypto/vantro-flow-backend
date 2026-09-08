-- FILE: migrations/028_temporal_intelligence.sql
-- STARLANE — Temporal Intelligence, Evidence Drift & Organizational Memory.
-- Additive only. Two new tables:
--
-- 1) tenant_review_checkpoint_history — append-only history of review
--    checkpoints. This SUPERSEDES the one-row-per-tenant UNIQUE(user_id)
--    model in migrations/027_tenant_review_checkpoints.sql for anything that
--    needs "N days ago" or "7/30/90-day comparison" queries. The original
--    027 table is left completely untouched (no ALTER, no data migration) —
--    existing callers of whatChangedSinceLastLook's single-checkpoint
--    contract keep working unmodified. New code (this phase) writes to BOTH
--    027 (unchanged behavior) and this new history table (additive).
--
-- 2) tenant_issue_lifecycle — stable identity + state machine for a
--    recurring insight/issue across checkpoints (Part 16-18), so Morning
--    Revelations can say "still open, day 4" or "resolved, then recurred"
--    instead of re-announcing the same issue as new every time.

CREATE TABLE IF NOT EXISTS tenant_review_checkpoint_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  checkpoint_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- No UNIQUE(user_id) here by design — this table is append-only history.
CREATE INDEX IF NOT EXISTS idx_checkpoint_history_user_time
  ON tenant_review_checkpoint_history (user_id, checkpoint_at DESC);

CREATE TABLE IF NOT EXISTS tenant_issue_lifecycle (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  issue_key TEXT NOT NULL,          -- deterministic stable identity, e.g. CUSTOMER_{id}_PAYMENT_RISK
  status TEXT NOT NULL,             -- DETECTED / WORSENING / STABLE / IMPROVING / RESOLVED / RECURRED
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  recurrence_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, issue_key)
);

CREATE INDEX IF NOT EXISTS idx_issue_lifecycle_user_status
  ON tenant_issue_lifecycle (user_id, status);
