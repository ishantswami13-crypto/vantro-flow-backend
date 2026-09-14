-- Migration 043: Agent runs
--
-- NOT YET APPLIED. Written for review — do not run against any database
-- without a human reviewing this file first.
--
-- Purpose: today's "automation" surfaces (dunning rules, ai_actions,
-- the owner-briefing agent call, cortex evaluation runs) execute as
-- stateless request/response calls with no persisted run history — there is
-- no real answer today to "when did this last run, and what happened."
-- This table is a single, generic run ledger so that becomes true, without
-- inventing a governed multi-agent framework (schedules, approval policies,
-- tool permissions) that doesn't exist and isn't being built here.
--
-- Design decisions:
--   1. agent_key is a free text identifier ('dunning', 'ai_actions',
--      'owner_briefing', 'cortex_evaluation', ...) rather than a foreign key
--      to a new "agents" definition table. There is no real, product-owned
--      registry of "what agents exist" yet — each of today's automations
--      lives as its own route/service in server.js. A definitions table
--      would need to be kept in sync with code by hand and would drift.
--      agent_key stays a plain string until a real registry exists.
--   2. status is the honest small set this system can actually report:
--      running / completed / failed. No "waiting for approval" state,
--      because none of today's automations pause for human approval before
--      running — ai_actions are approved/rejected AFTER creation, which is
--      already modeled on ai_actions.status, not here.
--   3. input_json/output_json/error_text are nullable JSONB/text so a run
--      can be recorded even when it fails before producing output.
--   4. No foreign key to a specific object (e.g. dunning_rules.id) because
--      agent_key spans several unrelated tables. If a run relates to a
--      specific object, that belongs in output_json (e.g.
--      {"dunning_rule_id": "..."}), not a schema-level FK to one specific
--      table that other agent_key values would never populate.

CREATE TABLE IF NOT EXISTS agent_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status = ANY (ARRAY['running'::text, 'completed'::text, 'failed'::text])),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  input_json JSONB,
  output_json JSONB,
  error_text TEXT,
  CONSTRAINT agent_runs_finished_consistency
    CHECK (
      (status = 'running' AND finished_at IS NULL)
      OR (status IN ('completed', 'failed') AND finished_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_user_id ON agent_runs(user_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_agent_key ON agent_runs(user_id, agent_key, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs(user_id, status) WHERE status = 'running';

ALTER TABLE IF EXISTS agent_runs ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE agent_runs IS
  'Generic run ledger for existing stateless automations (dunning, ai_actions, owner briefing, cortex evaluation). Not a governed multi-agent framework — no schedule/approval/tool-permission model exists here. NOT YET APPLIED — review before running.';
COMMENT ON COLUMN agent_runs.agent_key IS 'Free-text identifier for which automation ran, e.g. dunning / ai_actions / owner_briefing / cortex_evaluation. No definitions table exists yet.';
