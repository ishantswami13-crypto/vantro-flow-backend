-- Migration 046: Watch conditions
--
-- NOT YET APPLIED. Written for review — do not run against any database
-- until write access is confirmed and a human has reviewed this file.
--
-- Purpose: app/watch/page.tsx (V32 redesign) is currently an honest empty
-- shell with no persisted watch-condition table/API behind it. This adds
-- a real, minimal "run this existing real query periodically, compare to
-- a threshold" model, reusing the query logic already exposed as tools in
-- the /api/ai-chat pipeline (get_overdue, get_invoices, get_cash_forecast,
-- etc. — see lib/services/... tool definitions) rather than duplicating
-- data access in a parallel system.
--
-- Design decisions:
--   1. user_id (not tenant_id) — every existing table in this schema
--      (agent_runs, ai_actions, action_outcomes, investigations, ...)
--      scopes by user_id NOT NULL REFERENCES users(id) ON DELETE CASCADE.
--      Following that convention exactly for tenant isolation.
--   2. condition_config JSONB holds {entity/scope, metric, comparison
--      operator, threshold} rather than dedicated columns — mirrors how
--      ai_actions.reason_json/parameters store structured-but-flexible
--      condition payloads elsewhere in this schema, and avoids a rigid
--      column set before real usage patterns are known.
--   3. metric_key is a free TEXT identifier naming which existing
--      /api/ai-chat tool query backs this watch (e.g. 'get_overdue',
--      'get_cash_forecast'), same free-text-identifier pattern as
--      agent_runs.agent_key (migration 043) — there is no registry table
--      of "queries that exist" and one is not being invented here.
--   4. No scheduler-owned status; last_evaluated_at/last_triggered_at are
--      written by whatever evaluates the watch (cron job or on-demand
--      evaluate-now route — see server.js's existing `node-cron` require
--      at server.js:11, which should own recurring evaluation once wired).
--   5. watch_evaluations is an append-only history table (evaluated_at,
--      result_value, triggered boolean) — same audit-trail shape as
--      action_outcomes (migration 045): one watch can have many
--      evaluation rows, never collapsed into a single mutable "last
--      result" string on the parent.

CREATE TABLE IF NOT EXISTS watches (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  description        TEXT,
  metric_key         TEXT NOT NULL,   -- e.g. 'get_overdue', 'get_cash_forecast', 'get_inventory'
  condition_config   JSONB NOT NULL,  -- {entity, scope, metric, operator, threshold, ...}
  status             TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'paused', 'archived')),
  severity           TEXT NOT NULL DEFAULT 'medium'
                        CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_evaluated_at  TIMESTAMPTZ,
  last_triggered_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_watches_user_id ON watches(user_id);
CREATE INDEX IF NOT EXISTS idx_watches_user_status ON watches(user_id, status);
CREATE INDEX IF NOT EXISTS idx_watches_user_created ON watches(user_id, created_at DESC);

ALTER TABLE IF EXISTS watches ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE watches IS
  'User-defined watch conditions: "run this existing real /api/ai-chat tool query periodically, compare to a threshold." Not a continuous background-monitoring system unless/until wired to the existing node-cron mechanism in server.js — see evaluation route comments.';
COMMENT ON COLUMN watches.metric_key IS
  'Free-text identifier for which existing tool/query backs this watch (mirrors agent_runs.agent_key convention). No query-registry table exists; the evaluator route maps known metric_key values to real handler functions and must reject unknown ones.';
COMMENT ON COLUMN watches.condition_config IS
  'Structured condition, e.g. {"entity":"invoices","scope":"all","metric":"days_overdue","operator":"gte","threshold":30}. Evaluator route is the single source of truth for which operators/metrics are actually implemented per metric_key.';

CREATE TABLE IF NOT EXISTS watch_evaluations (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  watch_id       UUID NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  evaluated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  result_value   JSONB,        -- raw snapshot of the value(s) the condition was checked against
  triggered      BOOLEAN NOT NULL DEFAULT FALSE,
  error_text     TEXT          -- set if evaluation failed (e.g. metric_key handler error); triggered remains false
);

CREATE INDEX IF NOT EXISTS idx_watch_evaluations_watch ON watch_evaluations(watch_id, evaluated_at DESC);
CREATE INDEX IF NOT EXISTS idx_watch_evaluations_user ON watch_evaluations(user_id);

ALTER TABLE IF EXISTS watch_evaluations ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE watch_evaluations IS
  'Append-only evaluation history for a watch (one row per evaluation run), same audit-trail shape as action_outcomes (migration 045). Powers the Watch page''s History tab.';
