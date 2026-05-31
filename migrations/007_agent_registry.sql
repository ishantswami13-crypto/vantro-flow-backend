-- ============================================================
-- VANTRO ATLAS — Agent Registry Migration 007
-- Creates the agent_registry metadata table for Atlas Agent Mesh 216.
-- Safe to run multiple times (IF NOT EXISTS everywhere).
-- No FKs to user tables — agent_registry is system-global metadata.
-- All agents default is_active=false — no runtime execution enabled yet.
-- Apply: Supabase Dashboard → SQL Editor → paste and execute
--   OR:  DATABASE_URL=<staging-url> node scripts/staging-migrate.js
-- ============================================================

-- Ensure pgcrypto is available for gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ─── AGENT REGISTRY ──────────────────────────────────────────────────────────
-- Stores the definition and metadata for every agent in the Atlas Agent Mesh.
-- This is registry metadata only — not runtime execution state.
-- Phase 0: design-only. Phase 1: 12 core agents seeded with is_active=false.
-- Agents become executable only when: feature_flag is enabled AND is_active=true.
CREATE TABLE IF NOT EXISTS agent_registry (
  id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id               TEXT        NOT NULL,         -- stable domain.name ID, e.g. core.collections
  name                   TEXT        NOT NULL,
  layer                  SMALLINT    NOT NULL CHECK (layer BETWEEN 1 AND 6),
  squad                  TEXT        NOT NULL,
  mission                TEXT        NOT NULL,
  business_function      TEXT        NOT NULL,
  trigger_events         JSONB       NOT NULL DEFAULT '[]',
  input_schema           JSONB       NOT NULL DEFAULT '{}',
  tools_required         JSONB       NOT NULL DEFAULT '[]',
  output_schema          JSONB       NOT NULL DEFAULT '{}',
  risk_level             TEXT        NOT NULL
                           CHECK (risk_level IN ('low','medium','high','critical')),
  policy_rules           JSONB       NOT NULL DEFAULT '[]',
  approval_required      BOOLEAN     NOT NULL DEFAULT FALSE,
  audit_events           JSONB       NOT NULL DEFAULT '[]',
  success_metric         TEXT,
  cost_budget            JSONB       NOT NULL DEFAULT '{}',
  harness_scenarios      JSONB       NOT NULL DEFAULT '[]',
  feature_flag           TEXT,
  status                 TEXT        NOT NULL DEFAULT 'registry'
                           CHECK (status IN ('planned','registry','dry-run','staging','production','deprecated')),
  fallback_behavior      TEXT        NOT NULL DEFAULT 'return_error',
  public_claim_status    TEXT        NOT NULL DEFAULT 'hidden'
                           CHECK (public_claim_status IN ('hidden','core_public','future_public')),
  is_active              BOOLEAN     NOT NULL DEFAULT FALSE,  -- TRUE only after feature flag + harness gate
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Unique constraint: one canonical definition per agent_id
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_registry_agent_id  ON agent_registry(agent_id);

-- Lookup indexes for registry API and Cortex routing
CREATE INDEX IF NOT EXISTS idx_agent_registry_squad             ON agent_registry(squad);
CREATE INDEX IF NOT EXISTS idx_agent_registry_risk_level        ON agent_registry(risk_level);
CREATE INDEX IF NOT EXISTS idx_agent_registry_status            ON agent_registry(status);
CREATE INDEX IF NOT EXISTS idx_agent_registry_public_claim      ON agent_registry(public_claim_status);
CREATE INDEX IF NOT EXISTS idx_agent_registry_is_active         ON agent_registry(is_active);
CREATE INDEX IF NOT EXISTS idx_agent_registry_layer             ON agent_registry(layer, status);

-- ─── UPDATED_AT TRIGGER ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_agent_registry_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_agent_registry_updated_at ON agent_registry;
CREATE TRIGGER trg_agent_registry_updated_at
  BEFORE UPDATE ON agent_registry
  FOR EACH ROW EXECUTE FUNCTION set_agent_registry_updated_at();

-- ============================================================
-- Verification queries (run manually after applying):
--   SELECT COUNT(*) FROM agent_registry;
--   SELECT table_name FROM information_schema.tables
--     WHERE table_schema = 'public' AND table_name = 'agent_registry';
--   SELECT column_name, data_type FROM information_schema.columns
--     WHERE table_name = 'agent_registry' ORDER BY ordinal_position;
-- ============================================================
