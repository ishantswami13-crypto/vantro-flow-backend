-- Migration 068: custom workflows.
--
-- Owners build their own automations: a trigger (manual or a schedule), then
-- a chain of steps (run an agent, check a condition, take an action). The
-- definition is JSON validated in lib/domain/workflows/customWorkflows.js;
-- each run records every step's input, result and timing.
--
-- Additive only. user_id scopes every row (REFERENCES users ON DELETE
-- CASCADE); RLS enabled, the service-role backend filters by user_id.
-- (workflow_id, slot) is unique so one schedule firing runs at most once,
-- whichever server instance gets there first.

CREATE TABLE IF NOT EXISTS starlane_custom_workflows (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  description   TEXT,
  definition    JSONB NOT NULL,
  status        TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'ACTIVE', 'PAUSED')),
  version       INTEGER NOT NULL DEFAULT 1,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_custom_workflows_user ON starlane_custom_workflows (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_custom_workflows_active ON starlane_custom_workflows (status) WHERE status = 'ACTIVE';
ALTER TABLE starlane_custom_workflows ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS starlane_custom_workflow_runs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id       UUID NOT NULL REFERENCES starlane_custom_workflows(id) ON DELETE CASCADE,
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workflow_version  INTEGER NOT NULL,
  trigger           TEXT NOT NULL,
  slot              TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'RUNNING'
                    CHECK (status IN ('RUNNING', 'COMPLETED', 'ENDED_BY_CONDITION', 'FAILED', 'BLOCKED')),
  steps             JSONB NOT NULL DEFAULT '[]'::jsonb,
  summary           TEXT,
  error             TEXT,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at       TIMESTAMPTZ,
  UNIQUE (workflow_id, slot)
);
CREATE INDEX IF NOT EXISTS idx_custom_workflow_runs_wf ON starlane_custom_workflow_runs (workflow_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_custom_workflow_runs_user ON starlane_custom_workflow_runs (user_id, started_at DESC);
ALTER TABLE starlane_custom_workflow_runs ENABLE ROW LEVEL SECURITY;
