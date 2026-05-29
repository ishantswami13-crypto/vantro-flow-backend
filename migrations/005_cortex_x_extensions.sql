-- ============================================================
-- VANTRO CORTEX X — Extension Migration 005
-- Adds workflow_runs + extends customers / ai_actions / ai_plans.
-- 100% additive. Safe to run multiple times (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).
-- Tenant key: user_id (business_id rename deferred to a separate milestone).
-- Run: Supabase Dashboard → SQL Editor → paste and execute
-- ============================================================

-- ─── WORKFLOW_RUNS ─────────────────────────────────────────
-- Durable tracking for multi-step Cortex workflows.
-- Lightweight by design — we are not building Temporal here.
CREATE TABLE IF NOT EXISTS workflow_runs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workflow_type     TEXT NOT NULL,                           -- daily_owner_briefing | overdue_invoice_checker | etc.
  trigger_event_id  UUID,                                    -- nullable; references business_events(id) logically
  status            TEXT NOT NULL DEFAULT 'running',         -- running | completed | failed | cancelled
  step_json         JSONB DEFAULT '{}'::jsonb,               -- last completed step + cursor
  result_json       JSONB DEFAULT '{}'::jsonb,               -- final result summary
  error_message     TEXT,
  started_at        TIMESTAMPTZ DEFAULT NOW(),
  completed_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_user_id        ON workflow_runs(user_id);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_status         ON workflow_runs(status);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow_type  ON workflow_runs(user_id, workflow_type);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_started_at     ON workflow_runs(started_at DESC);

-- ─── CUSTOMERS EXTENSIONS ──────────────────────────────────
-- Credit limit + advance + risk override columns used by simulationEngine
-- and the new credit-sale warning flow.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS credit_limit            NUMERIC      DEFAULT 0;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS advance_required        BOOLEAN      DEFAULT FALSE;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS default_payment_terms   INTEGER      DEFAULT 0;   -- days
ALTER TABLE customers ADD COLUMN IF NOT EXISTS risk_override           TEXT;                     -- e.g. 'force_low' | 'force_high'
ALTER TABLE customers ADD COLUMN IF NOT EXISTS cortex_notes            TEXT;                     -- owner-only notes for AI context

-- ─── AI_ACTIONS EXTENSIONS ─────────────────────────────────
-- Expiry, retry, policy/simulation/learning hooks. All optional.
ALTER TABLE ai_actions ADD COLUMN IF NOT EXISTS expires_at              TIMESTAMPTZ;
ALTER TABLE ai_actions ADD COLUMN IF NOT EXISTS execution_attempts      INTEGER      DEFAULT 0;
ALTER TABLE ai_actions ADD COLUMN IF NOT EXISTS last_execution_error    TEXT;
ALTER TABLE ai_actions ADD COLUMN IF NOT EXISTS policy_status           TEXT         DEFAULT 'pending';   -- pending | allow | block | require_approval
ALTER TABLE ai_actions ADD COLUMN IF NOT EXISTS simulation_json         JSONB        DEFAULT '{}'::jsonb;
ALTER TABLE ai_actions ADD COLUMN IF NOT EXISTS learning_outcome_json   JSONB        DEFAULT '{}'::jsonb;

-- ─── AI_PLANS EXTENSIONS ───────────────────────────────────
ALTER TABLE ai_plans   ADD COLUMN IF NOT EXISTS context_hash            TEXT;
ALTER TABLE ai_plans   ADD COLUMN IF NOT EXISTS prompt_version          TEXT;
ALTER TABLE ai_plans   ADD COLUMN IF NOT EXISTS validation_status       TEXT         DEFAULT 'pending';   -- pending | valid | invalid
ALTER TABLE ai_plans   ADD COLUMN IF NOT EXISTS policy_status           TEXT         DEFAULT 'pending';
ALTER TABLE ai_plans   ADD COLUMN IF NOT EXISTS simulation_status       TEXT         DEFAULT 'pending';

-- ─── INDEX HARDENING ───────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_ai_actions_user_status        ON ai_actions(user_id, status);
CREATE INDEX IF NOT EXISTS idx_ai_actions_user_priority      ON ai_actions(user_id, priority);
CREATE INDEX IF NOT EXISTS idx_ai_actions_user_risk          ON ai_actions(user_id, risk_level);
CREATE INDEX IF NOT EXISTS idx_ai_actions_expires_at         ON ai_actions(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_promises_user_status          ON promises(user_id, status);
CREATE INDEX IF NOT EXISTS idx_customer_scores_user_customer ON customer_scores(user_id, customer_id);
-- business_events index already exists from 001, leave alone.

-- ============================================================
-- Verification queries (run manually after applying):
--   SELECT COUNT(*) FROM information_schema.columns
--     WHERE table_name = 'customers' AND column_name = 'credit_limit';
--   SELECT COUNT(*) FROM information_schema.tables
--     WHERE table_name = 'workflow_runs';
-- ============================================================
