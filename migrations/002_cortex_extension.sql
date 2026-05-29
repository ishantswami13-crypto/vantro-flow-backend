-- ============================================================
-- Migration 002: Cortex Extension — Memory, Plans, Tool Calls, Policy
-- Safe to run multiple times (IF NOT EXISTS throughout)
-- ============================================================

-- ─── BUSINESS MEMORY ────────────────────────────────────────
-- Learned facts about customers, suppliers, or the business itself.
-- Source of truth for agent context that doesn't fit in structured fields.
-- Examples: "prefers_morning_calls", "always_pays_late", "responds_to_firm_tone"
CREATE TABLE IF NOT EXISTS business_memory (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity_type   TEXT NOT NULL CHECK (entity_type IN ('customer', 'supplier', 'global')),
  entity_id     UUID,            -- NULL for global memories
  memory_key    TEXT NOT NULL,   -- e.g. 'prefers_morning_calls'
  memory_value  JSONB NOT NULL,  -- flexible payload
  confidence    FLOAT DEFAULT 1.0 CHECK (confidence >= 0 AND confidence <= 1),
  source        TEXT DEFAULT 'rule_engine', -- rule_engine | user_confirmed | observed
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, entity_type, entity_id, memory_key)
);
CREATE INDEX IF NOT EXISTS idx_bmem_user_entity  ON business_memory(user_id, entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_bmem_user_key     ON business_memory(user_id, memory_key);

-- ─── AI PLANS ───────────────────────────────────────────────
-- Multi-step orchestration plans. Each plan has a type and an ordered
-- list of steps tracked as JSONB. Agents create and advance these.
CREATE TABLE IF NOT EXISTS ai_plans (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trigger_event_id UUID REFERENCES business_events(id) ON DELETE SET NULL,
  plan_type        TEXT NOT NULL, -- collections_recovery | credit_review | cashflow_rescue
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'abandoned')),
  steps            JSONB NOT NULL DEFAULT '[]',
  -- Each step: { step: number, action_id: uuid, status: pending|done|skipped, result: any }
  context          JSONB DEFAULT '{}',
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW(),
  completed_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_plans_user_status ON ai_plans(user_id, status);
CREATE INDEX IF NOT EXISTS idx_plans_user_type   ON ai_plans(user_id, plan_type);

-- ─── TOOL CALLS ─────────────────────────────────────────────
-- Immutable audit log of every tool invocation by the runtime.
-- Used for observability, debugging, and agent self-improvement.
CREATE TABLE IF NOT EXISTS tool_calls (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tool_name      TEXT NOT NULL,
  input_params   JSONB,
  output_result  JSONB,
  duration_ms    INTEGER,
  status         TEXT NOT NULL DEFAULT 'success' CHECK (status IN ('success', 'error', 'timeout')),
  error_message  TEXT,
  called_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_toolcalls_user_time ON tool_calls(user_id, called_at DESC);
CREATE INDEX IF NOT EXISTS idx_toolcalls_tool      ON tool_calls(tool_name, called_at DESC);

-- ─── POLICY DECISIONS ───────────────────────────────────────
-- Every time policyGuard evaluates an action, the decision is logged here.
-- Enables audit trails, compliance checks, and learning which phrases get blocked.
CREATE TABLE IF NOT EXISTS policy_decisions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action_type     TEXT NOT NULL,
  action_payload  JSONB,
  decision        TEXT NOT NULL CHECK (decision IN ('allow', 'block', 'modify')),
  reason          TEXT,
  blocked_phrase  TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_policy_user_time    ON policy_decisions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_policy_decision     ON policy_decisions(user_id, decision);

-- ─── RLS (disabled — app-level user_id filtering) ────────────
ALTER TABLE business_memory   DISABLE ROW LEVEL SECURITY;
ALTER TABLE ai_plans          DISABLE ROW LEVEL SECURITY;
ALTER TABLE tool_calls        DISABLE ROW LEVEL SECURITY;
ALTER TABLE policy_decisions  DISABLE ROW LEVEL SECURITY;

SELECT 'Migration 002_cortex_extension complete' AS status;
