-- ============================================================
-- VANTRO CORTEX — Migration 014: receivables execution records
-- ============================================================
-- Additive only — no destructive change, no data touched.
-- Phase A of the "Verified Execution Loop V1 — Receivables" initiative.
--
-- execution_records:
-- ai_actions already tracks the lifecycle of a *suggested* action (status,
-- requires_approval, approved_by/approved_at, outcome/outcome_at/outcome_notes
-- — the latter three confirmed present on the live ai_actions table via a
-- direct information_schema check against the local dev DATABASE_URL before
-- writing this migration). What ai_actions does NOT track is the mechanics of
-- an approved action actually being *sent* through a real channel: which
-- provider message id came back, whether delivery was confirmed, how many
-- times a send was attempted, and why a send failed. This table is that
-- record — one row per execution attempt of an approved ai_actions row,
-- append-only from the executor's point of view (a retry adds attempt_count
-- rather than mutating history away).
--
-- Deliberately scoped to Phase A concerns only: no LLM calls, no channel
-- integration, and channel is constrained to ('whatsapp','test') so a later
-- phase cannot silently widen the surface without an explicit migration.
--
-- FK is ON DELETE CASCADE on both user_id and ai_action_id: an execution
-- record has no meaning of its own once the tenant or the underlying action
-- it executed is gone, matching the cascade convention already used for
-- customer_score_history in migration 011.
--
-- Idempotency: matches the (user_id, idem_key)-style unique-constraint
-- pattern already established by idempotency_keys in migration 001 — here
-- scoped additionally to ai_action_id so the same idempotency_key cannot
-- collide across two different actions for the same tenant. This lets a
-- later phase safely retry "execute this approved action" without ever
-- creating two execution_records for the same approved action + attempt.
CREATE TABLE IF NOT EXISTS execution_records (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ai_action_id          UUID NOT NULL REFERENCES ai_actions(id) ON DELETE CASCADE,
  channel               TEXT NOT NULL CHECK (channel IN ('whatsapp', 'test')),
  provider_message_id   TEXT,
  status                TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'delivered', 'failed', 'read')),
  sent_at               TIMESTAMPTZ,
  delivered_at          TIMESTAMPTZ,
  failed_reason         TEXT,
  attempt_count         INTEGER NOT NULL DEFAULT 1,
  idempotency_key       TEXT,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, ai_action_id, idempotency_key)
);

-- "give me every execution attempt for this tenant's action" (approval UI,
-- delivery-status polling, retry logic).
CREATE INDEX IF NOT EXISTS idx_execution_records_user_action ON execution_records(user_id, ai_action_id);

ALTER TABLE execution_records DISABLE ROW LEVEL SECURITY;

SELECT 'Migration 014_receivables_execution complete' AS status;
