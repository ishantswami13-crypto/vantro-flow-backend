-- ============================================================
-- Migration 003: Evaluation + Agent Run Tracking
-- Applied to Supabase production on 2026-05-29.
-- Safe to run again (IF NOT EXISTS throughout).
-- ============================================================

-- ─── OUTCOME TRACKING on ai_actions ─────────────────────────
ALTER TABLE ai_actions
  ADD COLUMN IF NOT EXISTS outcome       TEXT CHECK (outcome IN ('effective', 'ineffective', 'unknown')),
  ADD COLUMN IF NOT EXISTS outcome_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS outcome_notes TEXT;

CREATE INDEX IF NOT EXISTS idx_ai_actions_outcome
  ON ai_actions(user_id, outcome, completed_at);

-- ─── AGENT RUN LOG ───────────────────────────────────────────
-- Tracks the last successful run of each agent per user.
-- Used by GET /api/cortex/health to report agent health.
CREATE TABLE IF NOT EXISTS agent_run_log (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_name       TEXT NOT NULL,
  ran_at           TIMESTAMPTZ DEFAULT NOW(),
  actions_created  INTEGER DEFAULT 0,
  error_message    TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_run_log_user
  ON agent_run_log(user_id, agent_name, ran_at DESC);
ALTER TABLE agent_run_log DISABLE ROW LEVEL SECURITY;

SELECT 'Migration 003_evaluation complete' AS status;
