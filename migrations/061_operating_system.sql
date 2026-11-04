-- Migration 061: Seven-surface operating system objects
--
-- NOT APPLIED to any shared database. Additive only: new tables, indexes and
-- a widened CHECK on starlane_controls (created by 060, also unapplied).
-- Safe to re-run (IF NOT EXISTS throughout).
--
-- Objects and the surface they live in (prefixed starlane_ because older
-- migrations already own "workflow_runs", "workflow_registry" and similar):
--   starlane_objectives             WATCH: persistent targets (e.g. overdue
--                                   share <= 8%) with an autopilot mode.
--   starlane_objective_evaluations  WATCH: append-only history of every
--                                   evaluation (value, forecast, health).
--   starlane_workflows              SCAN -> PREPARED -> MISSIONS: the
--                                   automation manifest. A workflow found by
--                                   Scan starts as PROPOSED (shown in
--                                   Prepared) and runs only after a human
--                                   deploys it in SHADOW or WITH_APPROVAL.
--   starlane_workflow_runs          MISSIONS: every run, its trigger, counts
--                                   and stop reason.
--   starlane_workflow_items         MISSIONS -> MEMORY: one unit of work per
--                                   target, with an idempotency key, the
--                                   draft, approval, what was (or would have
--                                   been) done, the acting agent's identity
--                                   and the verified business outcome.
--   starlane_knowledge              BRIDGE / MEMORY: typed knowledge (observed
--                                   fact, source claim, human observation,
--                                   inference, hypothesis, learned pattern,
--                                   policy, semantic definition), never
--                                   collapsed into one "memory".
--
-- Conventions: user_id scopes every row (REFERENCES users ON DELETE CASCADE),
-- RLS enabled (the service-role backend filters by user_id).

CREATE TABLE IF NOT EXISTS starlane_objectives (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  metric_key         TEXT NOT NULL,
  operator           TEXT NOT NULL CHECK (operator IN ('<=', '>=')),
  target             NUMERIC NOT NULL,
  horizon_days       INTEGER NOT NULL DEFAULT 30 CHECK (horizon_days BETWEEN 1 AND 180),
  autopilot_mode     TEXT NOT NULL DEFAULT 'WATCH'
                       CHECK (autopilot_mode IN ('WATCH','RECOMMEND','PREPARE','EXECUTE_WITH_APPROVAL','EXECUTE_WITHIN_POLICY')),
  template_key       TEXT,
  workflow_id        UUID,
  status             TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','PAUSED','ARCHIVED')),
  last_health        TEXT CHECK (last_health IN ('ON_TRACK','AT_RISK','OFF_TRACK','UNKNOWN')),
  last_evaluated_at  TIMESTAMPTZ,
  created_by         UUID NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_starlane_objectives_user ON starlane_objectives(user_id, status);
ALTER TABLE IF EXISTS starlane_objectives ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS starlane_objective_evaluations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  objective_id    UUID NOT NULL REFERENCES starlane_objectives(id) ON DELETE CASCADE,
  health          TEXT NOT NULL CHECK (health IN ('ON_TRACK','AT_RISK','OFF_TRACK','UNKNOWN')),
  current_value   NUMERIC,
  forecast        JSONB,
  confidence      JSONB,
  evidence        JSONB NOT NULL DEFAULT '[]'::jsonb,
  evaluated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_starlane_objective_evaluations ON starlane_objective_evaluations(objective_id, evaluated_at DESC);
ALTER TABLE IF EXISTS starlane_objective_evaluations ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS starlane_workflows (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  template_key      TEXT NOT NULL,           -- e.g. receivables_followup
  name              TEXT NOT NULL,
  objective         TEXT NOT NULL,
  objective_id      UUID REFERENCES starlane_objectives(id) ON DELETE SET NULL,
  trigger           JSONB NOT NULL,
  conditions        JSONB NOT NULL DEFAULT '[]'::jsonb,
  steps             JSONB NOT NULL,          -- each: key, label, performer (SYSTEM|AGENT|HUMAN), capability
  approvals         JSONB NOT NULL DEFAULT '[]'::jsonb,
  policies          JSONB NOT NULL DEFAULT '[]'::jsonb,
  agent_permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
  budget            JSONB NOT NULL DEFAULT '{}'::jsonb,
  success_metric    JSONB NOT NULL,
  expected_outcome  JSONB NOT NULL,
  fallback          JSONB NOT NULL DEFAULT '[]'::jsonb,
  stop_conditions   JSONB NOT NULL DEFAULT '[]'::jsonb,
  status            TEXT NOT NULL DEFAULT 'PROPOSED'
                      CHECK (status IN ('PROPOSED','SHADOW','WITH_APPROVAL','PAUSED','REJECTED','RETIRED')),
  automation_level  INTEGER NOT NULL DEFAULT 2 CHECK (automation_level BETWEEN 0 AND 5),
  source            TEXT NOT NULL CHECK (source IN ('SCAN','TEXT','TEMPLATE')),
  source_ref        JSONB,
  discovery         JSONB,                   -- the evidence Scan used to propose it
  simulation        JSONB,                   -- last historical replay
  version           INTEGER NOT NULL DEFAULT 1,
  created_by        TEXT NOT NULL,
  deployed_by       UUID,
  deployed_at       TIMESTAMPTZ,
  decided_reason    TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- One live workflow per template per tenant, so Scan never proposes a duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS uq_starlane_workflows_live_template
  ON starlane_workflows(user_id, template_key) WHERE status IN ('PROPOSED','SHADOW','WITH_APPROVAL','PAUSED');
CREATE INDEX IF NOT EXISTS idx_starlane_workflows_user ON starlane_workflows(user_id, status);
ALTER TABLE IF EXISTS starlane_workflows ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS starlane_workflow_runs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workflow_id       UUID NOT NULL REFERENCES starlane_workflows(id) ON DELETE CASCADE,
  workflow_version  INTEGER NOT NULL,
  mode              TEXT NOT NULL,
  trigger_source    TEXT NOT NULL CHECK (trigger_source IN ('MANUAL','SCHEDULE','OBJECTIVE')),
  status            TEXT NOT NULL CHECK (status IN ('RUNNING','COMPLETED','PARTIAL','STOPPED','FAILED')),
  as_of             TIMESTAMPTZ NOT NULL,
  counts            JSONB NOT NULL DEFAULT '{}'::jsonb,
  stopped_reason    JSONB,
  started_by        TEXT NOT NULL,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_starlane_workflow_runs ON starlane_workflow_runs(workflow_id, started_at DESC);
ALTER TABLE IF EXISTS starlane_workflow_runs ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS starlane_workflow_items (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workflow_id       UUID NOT NULL REFERENCES starlane_workflows(id) ON DELETE CASCADE,
  workflow_version  INTEGER NOT NULL,
  run_id            UUID REFERENCES starlane_workflow_runs(id) ON DELETE SET NULL,
  idempotency_key   TEXT NOT NULL,
  target_type       TEXT NOT NULL,
  target_key        TEXT NOT NULL,
  target_label      TEXT NOT NULL,
  invoice_ids       TEXT[] NOT NULL DEFAULT '{}',
  amount            NUMERIC NOT NULL,
  currency          TEXT NOT NULL,
  priority          NUMERIC,
  context           JSONB NOT NULL DEFAULT '{}'::jsonb,
  draft             JSONB,
  status            TEXT NOT NULL
                      CHECK (status IN ('AWAITING_APPROVAL','SHADOWED','PREPARED_MANUAL','REJECTED','CANCELLED','EXPIRED','FAILED')),
  status_reason     TEXT,
  approval          JSONB,
  action            JSONB,
  agent             JSONB NOT NULL,
  policy            JSONB NOT NULL DEFAULT '[]'::jsonb,
  attempts          INTEGER NOT NULL DEFAULT 1,
  expected_outcome  JSONB NOT NULL,
  acted_at          TIMESTAMPTZ,
  verify_after      DATE,
  outcome_status    TEXT NOT NULL DEFAULT 'PENDING' CHECK (outcome_status IN ('PENDING','MET','NOT_MET','UNKNOWN','NOT_APPLICABLE')),
  outcome           JSONB,
  verified_at       TIMESTAMPTZ,
  expires_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_starlane_workflow_items_idem ON starlane_workflow_items(user_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_starlane_workflow_items_workflow ON starlane_workflow_items(workflow_id, status);
CREATE INDEX IF NOT EXISTS idx_starlane_workflow_items_user_status ON starlane_workflow_items(user_id, status);
ALTER TABLE IF EXISTS starlane_workflow_items ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS starlane_knowledge (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL CHECK (kind IN ('OBSERVED_FACT','SOURCE_CLAIM','HUMAN_OBSERVATION','INFERENCE',
                                                  'HYPOTHESIS','LEARNED_PATTERN','POLICY','SEMANTIC_DEFINITION')),
  statement         TEXT NOT NULL,
  scope             JSONB NOT NULL DEFAULT '{}'::jsonb,
  source            JSONB NOT NULL,          -- {type: HUMAN|DOCUMENT|SYSTEM|ENGINE, ref, person}
  confidence        NUMERIC CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  authority         TEXT,
  valid_from        TIMESTAMPTZ,
  valid_until       TIMESTAMPTZ,
  evidence          JSONB NOT NULL DEFAULT '[]'::jsonb,
  sample_count      INTEGER,
  last_verified_at  TIMESTAMPTZ,
  pattern_key       TEXT,
  safety            JSONB,                   -- prompt-injection screening result
  status            TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','QUARANTINED','RETIRED')),
  created_by        TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_starlane_knowledge_pattern ON starlane_knowledge(user_id, pattern_key) WHERE pattern_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_starlane_knowledge_user_kind ON starlane_knowledge(user_id, kind, created_at DESC);
ALTER TABLE IF EXISTS starlane_knowledge ENABLE ROW LEVEL SECURITY;

-- Kill switches for workflows and objective autopilots, next to the existing
-- tenant / agent / decision / action class / connector stops.
ALTER TABLE IF EXISTS starlane_controls DROP CONSTRAINT IF EXISTS starlane_controls_scope_check;
ALTER TABLE IF EXISTS starlane_controls ADD CONSTRAINT starlane_controls_scope_check
  CHECK (scope IN ('TENANT','AGENT','DECISION','ACTION_CLASS','CONNECTOR','WORKFLOW','OBJECTIVE'));

COMMENT ON TABLE starlane_workflows IS 'Automation manifests. PROPOSED rows come from Scan and run only after a human deploys them (SHADOW or WITH_APPROVAL). Full autonomy (level 5) is never set automatically.';
COMMENT ON TABLE starlane_workflow_items IS 'One unit of workflow work per target. idempotency_key makes a repeated trigger a no-op. Success is the verified business outcome, not the step completing.';
COMMENT ON TABLE starlane_knowledge IS 'Typed organisational knowledge. Human observations and document claims are evidence, never ground truth, and never flow into drafts or policy.';
