-- Migration 060: Decision core (the golden loop's persistent objects)
--
-- Additive only: new tables, one nullable column on ai_actions, indexes.
-- No existing row is changed or deleted. Safe to re-run (IF NOT EXISTS
-- throughout; the immutability trigger is CREATE OR REPLACE).
-- Numbered 060 to stay clear of 049-053 used by open PR #41.
--
-- Objects:
--   decisions                 the Decision: why now, window, options incl. do
--                             nothing, evidence, unknowns, recommendation.
--   decision_events           append-only audit trail (who/which agent/which
--                             model/under which policy), UPDATE/DELETE refused.
--   decision_contracts        the falsifiable commitment made when an option
--                             is chosen: expected outcomes, success/failure/
--                             abort criteria, review dates, rollback plan.
--   decision_action_runs      every execution attempt (or shadow "would have")
--                             with an idempotency key, pre/postconditions and
--                             compensation.
--   starlane_controls         kill switches (tenant, agent, decision, action
--                             class, connector). A stop blocks execution in
--                             the backend, not just the UI.
--   starlane_tenant_settings  pilot mode (SHADOW by default), autonomy ceiling
--                             and semantic definition overrides.
--   starlane_definition_versions  history of every definitions change.
--
-- Conventions followed: user_id scopes every row (REFERENCES users ON DELETE
-- CASCADE), RLS enabled (the service-role backend filters by user_id), no FK
-- to suppliers/customers ids (their id types differ between databases), so
-- entities are referenced by type + text id inside JSONB.

CREATE TABLE IF NOT EXISTS decisions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind                 TEXT NOT NULL,          -- RECEIVABLE_RISK | PROCESS_DEGRADATION | SUPPLY_STOCKOUT
  dedup_key            TEXT NOT NULL,          -- one open decision per underlying issue
  title                TEXT NOT NULL,
  description          TEXT,
  status               TEXT NOT NULL DEFAULT 'OPEN'
                         CHECK (status IN ('OPEN','NEEDS_INFORMATION','SELECTED','APPROVED','EXECUTING',
                                           'SHADOWED','EXECUTED','VERIFIED','REJECTED','EXPIRED','RESOLVED','SUPERSEDED')),
  currency             TEXT,
  as_of                TIMESTAMPTZ NOT NULL,
  discovered_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decision_window_start DATE,
  decision_deadline    DATE,
  decision_window      JSONB NOT NULL DEFAULT '{}'::jsonb,
  why_now              JSONB NOT NULL DEFAULT '[]'::jsonb,
  what_if_ignored      TEXT,
  trigger_signals      JSONB NOT NULL DEFAULT '[]'::jsonb,
  affected_entities    JSONB NOT NULL DEFAULT '[]'::jsonb,
  affected_processes   TEXT[] NOT NULL DEFAULT '{}',
  objectives           JSONB NOT NULL DEFAULT '[]'::jsonb,
  constraints          JSONB NOT NULL DEFAULT '[]'::jsonb,
  options              JSONB NOT NULL DEFAULT '[]'::jsonb,
  do_nothing_option    TEXT NOT NULL,
  evidence             JSONB NOT NULL DEFAULT '[]'::jsonb,
  unknowns             JSONB NOT NULL DEFAULT '[]'::jsonb,
  assumptions          JSONB NOT NULL DEFAULT '[]'::jsonb,
  contradictions       JSONB NOT NULL DEFAULT '[]'::jsonb,
  information_requests JSONB NOT NULL DEFAULT '[]'::jsonb,
  expected_value       NUMERIC,
  downside_risk        NUMERIC,
  upside_potential     NUMERIC,
  reversibility        TEXT,
  blast_radius         JSONB,
  urgency              NUMERIC,
  materiality          JSONB,
  confidence           JSONB,
  attention_score      NUMERIC,
  recommendation       JSONB,
  selected_option      TEXT,
  approval_policy      JSONB,
  analysis             JSONB,
  collisions           JSONB NOT NULL DEFAULT '[]'::jsonb,
  definitions          JSONB NOT NULL DEFAULT '{}'::jsonb,   -- effective semantic definitions used
  model_versions       JSONB NOT NULL DEFAULT '{}'::jsonb,
  revision             INTEGER NOT NULL DEFAULT 1,
  created_by           TEXT NOT NULL,                          -- agent key, e.g. starlane.decision_engine
  decided_by           UUID,
  resolution_reason    TEXT,
  resolved_at          TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_decisions_open_dedup
  ON decisions(user_id, dedup_key)
  WHERE status IN ('OPEN','NEEDS_INFORMATION','SELECTED','APPROVED','EXECUTING','SHADOWED','EXECUTED');
CREATE INDEX IF NOT EXISTS idx_decisions_user_status ON decisions(user_id, status, attention_score DESC);
CREATE INDEX IF NOT EXISTS idx_decisions_user_created ON decisions(user_id, created_at DESC);
ALTER TABLE IF EXISTS decisions ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS decision_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  decision_id     UUID REFERENCES decisions(id) ON DELETE CASCADE,
  event_type      TEXT NOT NULL,     -- DISCOVERED, REVISED, SIMULATED, INFORMATION_REQUESTED, HUMAN_OBSERVATION, OPTION_SELECTED, APPROVED, REJECTED, EXECUTION_*, VERIFIED, CONTROL_*, ...
  actor_type      TEXT NOT NULL CHECK (actor_type IN ('human','agent','system')),
  actor_id        TEXT NOT NULL,     -- user id, agent key, or 'system'
  on_behalf_of    UUID,              -- delegating human, when an agent acts
  agent_key       TEXT,
  agent_version   TEXT,
  model           TEXT,              -- 'deterministic' when no LLM was used
  policy          JSONB,             -- policy checks applied and their verdicts
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
  correlation_id  TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_decision_events_decision ON decision_events(decision_id, created_at);
CREATE INDEX IF NOT EXISTS idx_decision_events_user ON decision_events(user_id, created_at DESC);
ALTER TABLE IF EXISTS decision_events ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION decision_events_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- ON DELETE CASCADE from users/decisions still works: that path deletes
  -- via the FK, which fires this trigger too, so allow deletes only when the
  -- parent row is already gone.
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM decisions WHERE id = OLD.decision_id)
       OR NOT EXISTS (SELECT 1 FROM users WHERE id = OLD.user_id) THEN RETURN OLD; END IF;
  END IF;
  RAISE EXCEPTION 'decision_events is append-only';
END $$;
DROP TRIGGER IF EXISTS trg_decision_events_immutable ON decision_events;
CREATE TRIGGER trg_decision_events_immutable BEFORE UPDATE OR DELETE ON decision_events
  FOR EACH ROW EXECUTE FUNCTION decision_events_immutable();

CREATE TABLE IF NOT EXISTS decision_contracts (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  decision_id        UUID NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  selected_option    TEXT NOT NULL,
  mode               TEXT NOT NULL CHECK (mode IN ('SHADOW','LIVE')),
  status             TEXT NOT NULL DEFAULT 'DRAFT'
                       CHECK (status IN ('DRAFT','ACTIVE','ON_TRACK','OFF_TRACK','MET','NOT_MET','ABORTED','UNKNOWN','SUPERSEDED')),
  rationale          JSONB NOT NULL,
  evidence_snapshot  JSONB NOT NULL DEFAULT '[]'::jsonb,
  assumptions        JSONB NOT NULL DEFAULT '[]'::jsonb,
  expected_outcomes  JSONB NOT NULL DEFAULT '[]'::jsonb,
  success_criteria   JSONB NOT NULL DEFAULT '[]'::jsonb,
  failure_criteria   JSONB NOT NULL DEFAULT '[]'::jsonb,
  abort_conditions   JSONB NOT NULL DEFAULT '[]'::jsonb,
  review_at          JSONB NOT NULL DEFAULT '[]'::jsonb,
  owner_user_id      UUID NOT NULL,
  approvers          JSONB NOT NULL DEFAULT '[]'::jsonb,
  allowed_actions    JSONB NOT NULL DEFAULT '[]'::jsonb,
  rollback_plan      JSONB NOT NULL DEFAULT '[]'::jsonb,
  baseline           JSONB,             -- observed state at activation, for verification
  activated_at       TIMESTAMPTZ,
  last_checked_at    TIMESTAMPTZ,
  verified_at        TIMESTAMPTZ,
  verification       JSONB,
  regret             JSONB,
  attribution        TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_decision_contracts_live
  ON decision_contracts(decision_id) WHERE status NOT IN ('SUPERSEDED','ABORTED');
CREATE INDEX IF NOT EXISTS idx_decision_contracts_user_status ON decision_contracts(user_id, status);
ALTER TABLE IF EXISTS decision_contracts ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS decision_action_runs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  decision_id       UUID NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  contract_id       UUID REFERENCES decision_contracts(id) ON DELETE CASCADE,
  step_index        INTEGER NOT NULL DEFAULT 0,
  intent_type       TEXT NOT NULL,
  adapter           TEXT NOT NULL,
  connector         TEXT NOT NULL,
  idempotency_key   TEXT NOT NULL,
  mode              TEXT NOT NULL CHECK (mode IN ('SHADOW','LIVE')),
  status            TEXT NOT NULL CHECK (status IN ('BLOCKED','SHADOWED','EXECUTING','SUCCEEDED','PREPARED','FAILED','UNKNOWN','COMPENSATED')),
  preconditions     JSONB NOT NULL DEFAULT '[]'::jsonb,
  would_have        JSONB,             -- shadow mode: exactly what would have been done
  result            JSONB,
  postcondition     JSONB,             -- did the target system actually change?
  rollback          JSONB,             -- how to undo, with the prior values captured
  ai_action_id      UUID,
  delegation_chain  JSONB NOT NULL DEFAULT '[]'::jsonb,
  error             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_decision_action_runs_idem ON decision_action_runs(user_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_decision_action_runs_decision ON decision_action_runs(decision_id, step_index);
ALTER TABLE IF EXISTS decision_action_runs ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS starlane_controls (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope       TEXT NOT NULL CHECK (scope IN ('TENANT','AGENT','DECISION','ACTION_CLASS','CONNECTOR')),
  scope_key   TEXT NOT NULL,
  stopped     BOOLEAN NOT NULL DEFAULT TRUE,
  reason      TEXT,
  set_by      UUID,
  set_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cleared_at  TIMESTAMPTZ,
  UNIQUE (user_id, scope, scope_key)
);
ALTER TABLE IF EXISTS starlane_controls ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS starlane_tenant_settings (
  user_id              UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  pilot_mode           TEXT NOT NULL DEFAULT 'SHADOW' CHECK (pilot_mode IN ('SHADOW','LIVE')),
  autonomy_ceiling     TEXT NOT NULL DEFAULT 'L2' CHECK (autonomy_ceiling IN ('L0','L1','L2')),
  definitions          JSONB NOT NULL DEFAULT '{}'::jsonb,
  definitions_version  INTEGER NOT NULL DEFAULT 0,
  updated_by           UUID,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE IF EXISTS starlane_tenant_settings ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS starlane_definition_versions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  version      INTEGER NOT NULL,
  definitions  JSONB NOT NULL,
  created_by   UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, version)
);
ALTER TABLE IF EXISTS starlane_definition_versions ENABLE ROW LEVEL SECURITY;

-- Link recommendations the decision engine prepares into the existing
-- ai_actions approval/send pipeline.
ALTER TABLE IF EXISTS ai_actions ADD COLUMN IF NOT EXISTS decision_id UUID;
CREATE INDEX IF NOT EXISTS idx_ai_actions_decision_id ON ai_actions(decision_id) WHERE decision_id IS NOT NULL;

-- Expected outcomes of a contract are written as predictions rows
-- (entity_type='decision_contract'); this index serves calibration queries.
CREATE INDEX IF NOT EXISTS idx_predictions_user_entity_type ON predictions(user_id, entity_type, evaluation_status);

COMMENT ON TABLE decisions IS 'First-class Decision objects discovered by the deterministic decision engine (lib/domain/decisions). Numbers come from snapshot + simulation, never from an LLM.';
COMMENT ON TABLE decision_events IS 'Append-only audit trail for decisions: actor, agent identity, model, policy verdicts. UPDATE/DELETE are refused by trigger.';
COMMENT ON TABLE starlane_tenant_settings IS 'pilot_mode SHADOW (default) blocks every side effect: executions are recorded as what Starlane WOULD have done.';
