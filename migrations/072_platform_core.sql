-- Migration 072: Starlane platform core.
--
-- NOT APPLIED TO PRODUCTION BY THIS CHANGE. Review, then apply with
-- `npm run db:migrate` against staging first. See
-- docs/STARLANE_PLATFORM_ARCHITECTURE.md and docs/PLATFORM_MIGRATION_072.md.
--
-- Turns the organization into the tenant for the universal platform
-- (agents, knowledge, approvals, executions) WITHOUT moving any existing
-- finance table off user_id:
--
--   organization_members        who belongs to an organization, with a role
--   organization_apps           which business applications it activated
--   platform_teams (+members)   teams inside an organization
--   platform_org_policies       organization-wide agent policy and limits
--   platform_audit_events       administrative and execution audit trail
--   platform_agents             agent definitions (editable draft)
--   platform_agent_versions     immutable published versions
--   platform_agent_executions   durable execution queue and lifecycle
--   platform_execution_steps    per-step trace (model calls, tool calls)
--   platform_approval_requests  human approval checkpoints
--   platform_knowledge_*        collections, documents and searchable chunks
--
-- Additive only, with two data backfills that preserve current access:
--   1. every user without an organization gets one (as getOrCreate would),
--      and every organization owner gets an 'owner' membership row;
--   2. every organization that exists when this runs gets the Finance and
--      Procurement apps enabled, so no current user loses a screen.
-- Rollback: docs/PLATFORM_MIGRATION_072.md (drop the new tables; nothing
-- existing is altered except two nullable columns on organizations).

-- ── Organizations: identity and setup state ──────────────────────────────
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS operating_context TEXT
  CHECK (operating_context IS NULL OR length(operating_context) <= 2000);
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS preferences JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS onboarded_at TIMESTAMPTZ;

INSERT INTO organizations (owner_user_id, display_name, industry, onboarded_at)
SELECT u.id, NULLIF(btrim(u.business_name), ''), NULLIF(btrim(u.industry), ''), NOW()
  FROM users u
 WHERE NOT EXISTS (SELECT 1 FROM organizations o WHERE o.owner_user_id = u.id)
ON CONFLICT (owner_user_id) DO NOTHING;

-- Organizations that existed before the platform were set up through the
-- finance onboarding; they are not shown the new setup again.
UPDATE organizations SET onboarded_at = COALESCE(onboarded_at, created_at, NOW()) WHERE onboarded_at IS NULL;

-- ── Membership ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS organization_members (
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  invited_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (organization_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_org_members_user ON organization_members(user_id);
ALTER TABLE organization_members ENABLE ROW LEVEL SECURITY;

INSERT INTO organization_members (organization_id, user_id, role)
SELECT o.id, o.owner_user_id, 'owner' FROM organizations o
ON CONFLICT (organization_id, user_id) DO NOTHING;

-- ── Applications ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS organization_apps (
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  app_key         TEXT NOT NULL CHECK (app_key ~ '^[a-z][a-z0-9_]{1,40}$'),
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  enabled_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (organization_id, app_key)
);
ALTER TABLE organization_apps ENABLE ROW LEVEL SECURITY;

INSERT INTO organization_apps (organization_id, app_key, enabled)
SELECT o.id, a.k, TRUE FROM organizations o CROSS JOIN (VALUES ('finance'), ('procurement')) AS a(k)
ON CONFLICT (organization_id, app_key) DO NOTHING;

-- ── Teams ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS platform_teams (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  description     TEXT CHECK (description IS NULL OR length(description) <= 500),
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_platform_teams_name ON platform_teams(organization_id, lower(btrim(name)));
ALTER TABLE platform_teams ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS platform_team_members (
  organization_id UUID NOT NULL,
  team_id         UUID NOT NULL,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (team_id, user_id),
  FOREIGN KEY (organization_id, team_id) REFERENCES platform_teams(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, user_id) REFERENCES organization_members(organization_id, user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_platform_team_members_user ON platform_team_members(organization_id, user_id);
ALTER TABLE platform_team_members ENABLE ROW LEVEL SECURITY;

-- ── Organization policy ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS platform_org_policies (
  organization_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  policy          JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE platform_org_policies ENABLE ROW LEVEL SECURITY;

-- ── Audit ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS platform_audit_events (
  id              BIGSERIAL PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_kind      TEXT NOT NULL DEFAULT 'user' CHECK (actor_kind IN ('user', 'agent', 'system')),
  action          TEXT NOT NULL CHECK (action ~ '^[a-z][a-z0-9_.]{2,80}$'),
  resource_type   TEXT NOT NULL,
  resource_id     TEXT,
  detail          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_platform_audit_org ON platform_audit_events(organization_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_platform_audit_resource ON platform_audit_events(organization_id, resource_type, resource_id);
ALTER TABLE platform_audit_events ENABLE ROW LEVEL SECURITY;

-- ── Agents ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS platform_agents (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  owner_user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id              UUID,
  visibility           TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'team', 'organization')),
  name                 TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  description          TEXT,
  template_key         TEXT,
  draft_definition     JSONB NOT NULL,
  draft_checksum       TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'ready', 'active', 'disabled', 'archived')),
  published_version    INTEGER,
  webhook_token_hash   TEXT UNIQUE,
  next_scheduled_at    TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, id),
  CHECK (visibility <> 'team' OR team_id IS NOT NULL),
  FOREIGN KEY (organization_id, team_id) REFERENCES platform_teams(organization_id, id)
);
CREATE INDEX IF NOT EXISTS idx_platform_agents_org ON platform_agents(organization_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_agents_owner ON platform_agents(organization_id, owner_user_id);
CREATE INDEX IF NOT EXISTS idx_platform_agents_schedule ON platform_agents(next_scheduled_at) WHERE status = 'active' AND next_scheduled_at IS NOT NULL;
ALTER TABLE platform_agents ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS platform_agent_versions (
  organization_id UUID NOT NULL,
  agent_id        UUID NOT NULL,
  version         INTEGER NOT NULL CHECK (version >= 1),
  definition      JSONB NOT NULL,
  checksum        TEXT NOT NULL,
  notes           TEXT,
  published_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  published_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (agent_id, version),
  FOREIGN KEY (organization_id, agent_id) REFERENCES platform_agents(organization_id, id) ON DELETE CASCADE
);
ALTER TABLE platform_agent_versions ENABLE ROW LEVEL SECURITY;

-- Published versions are immutable.
-- The only permitted change is published_by becoming NULL when that user is
-- deleted (ON DELETE SET NULL).
CREATE OR REPLACE FUNCTION platform_agent_versions_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.definition IS DISTINCT FROM OLD.definition OR NEW.checksum IS DISTINCT FROM OLD.checksum
     OR NEW.version IS DISTINCT FROM OLD.version OR NEW.agent_id IS DISTINCT FROM OLD.agent_id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.notes IS DISTINCT FROM OLD.notes
     OR NEW.published_at IS DISTINCT FROM OLD.published_at
     OR (NEW.published_by IS NOT NULL AND NEW.published_by IS DISTINCT FROM OLD.published_by) THEN
    RAISE EXCEPTION 'platform_agent_versions rows are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_platform_agent_versions_immutable ON platform_agent_versions;
CREATE TRIGGER trg_platform_agent_versions_immutable BEFORE UPDATE ON platform_agent_versions
  FOR EACH ROW EXECUTE FUNCTION platform_agent_versions_immutable();

-- ── Executions ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS platform_agent_executions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL,
  agent_id          UUID NOT NULL,
  agent_version     INTEGER,                    -- NULL for a test of the draft
  definition        JSONB NOT NULL,             -- the exact definition this run executes
  definition_checksum TEXT NOT NULL,
  mode              TEXT NOT NULL CHECK (mode IN ('test', 'live')),
  trigger_kind      TEXT NOT NULL DEFAULT 'manual' CHECK (trigger_kind IN ('manual', 'schedule', 'webhook', 'handoff', 'retry')),
  requested_by      UUID REFERENCES users(id) ON DELETE SET NULL,  -- the identity the run executes as
  parent_execution_id UUID REFERENCES platform_agent_executions(id) ON DELETE SET NULL,
  idempotency_key   TEXT,
  status            TEXT NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued', 'running', 'awaiting_approval', 'completed', 'failed', 'cancelled')),
  input             JSONB NOT NULL DEFAULT '{}'::jsonb,
  output            JSONB,
  error_class       TEXT,
  error_message     TEXT,
  state             JSONB NOT NULL DEFAULT '{}'::jsonb,   -- resumable conversation state
  attempts          INTEGER NOT NULL DEFAULT 0,
  max_attempts      INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  timeout_seconds   INTEGER NOT NULL DEFAULT 120 CHECK (timeout_seconds BETWEEN 5 AND 3600),
  run_after         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_until       TIMESTAMPTZ,
  cancel_requested  BOOLEAN NOT NULL DEFAULT FALSE,
  model_calls       INTEGER NOT NULL DEFAULT 0,
  tool_calls        INTEGER NOT NULL DEFAULT 0,
  input_tokens      INTEGER NOT NULL DEFAULT 0,
  output_tokens     INTEGER NOT NULL DEFAULT 0,
  model_used        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at        TIMESTAMPTZ,
  finished_at       TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, agent_id) REFERENCES platform_agents(organization_id, id) ON DELETE CASCADE,
  CHECK ((status IN ('completed', 'failed', 'cancelled')) = (finished_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_platform_exec_idem ON platform_agent_executions(organization_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_platform_exec_queue ON platform_agent_executions(run_after) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS idx_platform_exec_lease ON platform_agent_executions(lease_until) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS idx_platform_exec_org ON platform_agent_executions(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_exec_agent ON platform_agent_executions(agent_id, created_at DESC);
ALTER TABLE platform_agent_executions ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS platform_execution_steps (
  id              BIGSERIAL PRIMARY KEY,
  organization_id UUID NOT NULL,
  execution_id    UUID NOT NULL,
  step_key        TEXT NOT NULL,                -- stable across retries: 'model:3', 'tool:3:0'
  kind            TEXT NOT NULL CHECK (kind IN ('model', 'tool', 'approval', 'system')),
  name            TEXT,
  status          TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'blocked', 'skipped', 'dry_run')),
  input           JSONB,
  output          JSONB,
  error           TEXT,
  duration_ms     INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (execution_id, step_key),
  FOREIGN KEY (organization_id, execution_id) REFERENCES platform_agent_executions(organization_id, id) ON DELETE CASCADE
);
ALTER TABLE platform_execution_steps ENABLE ROW LEVEL SECURITY;

-- ── Approvals ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS platform_approval_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  execution_id    UUID NOT NULL,
  agent_id        UUID NOT NULL,
  step_key        TEXT NOT NULL,
  tool            TEXT NOT NULL,
  arguments       JSONB NOT NULL,
  summary         TEXT NOT NULL,
  risk            TEXT NOT NULL CHECK (risk IN ('read', 'internal_write', 'external', 'financial')),
  evidence        JSONB NOT NULL DEFAULT '[]'::jsonb,
  approver_role   TEXT NOT NULL DEFAULT 'admin' CHECK (approver_role IN ('owner', 'admin', 'member')),
  requested_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  decided_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  decided_at      TIMESTAMPTZ,
  decision_note   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (execution_id, step_key),
  FOREIGN KEY (organization_id, execution_id) REFERENCES platform_agent_executions(organization_id, id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  CHECK ((status = 'pending') = (decided_at IS NULL) OR status = 'cancelled')
);
CREATE INDEX IF NOT EXISTS idx_platform_approvals_org ON platform_approval_requests(organization_id, status, created_at DESC);
ALTER TABLE platform_approval_requests ENABLE ROW LEVEL SECURITY;

-- ── Knowledge ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS platform_knowledge_collections (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  owner_user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope           TEXT NOT NULL CHECK (scope IN ('personal', 'team', 'organization')),
  team_id         UUID,
  name            TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  description     TEXT CHECK (description IS NULL OR length(description) <= 1000),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, id),
  CHECK (scope <> 'team' OR team_id IS NOT NULL),
  FOREIGN KEY (organization_id, team_id) REFERENCES platform_teams(organization_id, id)
);
CREATE INDEX IF NOT EXISTS idx_platform_kc_org ON platform_knowledge_collections(organization_id, scope);
ALTER TABLE platform_knowledge_collections ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS platform_knowledge_documents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  collection_id   UUID NOT NULL,
  title           TEXT NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  source_kind     TEXT NOT NULL DEFAULT 'upload' CHECK (source_kind IN ('upload', 'paste', 'url_reference')),
  source_name     TEXT,
  mime_type       TEXT,
  byte_size       INTEGER,
  content_sha256  TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('processing', 'ready', 'failed')),
  status_detail   TEXT,
  chunk_count     INTEGER NOT NULL DEFAULT 0,
  uploaded_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, id),
  UNIQUE (collection_id, content_sha256),
  FOREIGN KEY (organization_id, collection_id) REFERENCES platform_knowledge_collections(organization_id, id) ON DELETE CASCADE
);
ALTER TABLE platform_knowledge_documents ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS platform_knowledge_chunks (
  id              BIGSERIAL PRIMARY KEY,
  organization_id UUID NOT NULL,
  collection_id   UUID NOT NULL,
  document_id     UUID NOT NULL,
  ordinal         INTEGER NOT NULL,
  content         TEXT NOT NULL,
  tsv             TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
  UNIQUE (document_id, ordinal),
  FOREIGN KEY (organization_id, document_id) REFERENCES platform_knowledge_documents(organization_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_platform_chunks_tsv ON platform_knowledge_chunks USING GIN (tsv);
CREATE INDEX IF NOT EXISTS idx_platform_chunks_collection ON platform_knowledge_chunks(organization_id, collection_id);
ALTER TABLE platform_knowledge_chunks ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE organization_members IS 'Who belongs to an organization and with which role. The server checks this on every platform request.';
COMMENT ON TABLE organization_apps IS 'Business applications an organization activated. Existing organizations were backfilled with finance and procurement.';
COMMENT ON TABLE platform_agent_versions IS 'Immutable published agent definitions (UPDATE is refused by trigger).';
COMMENT ON TABLE platform_agent_executions IS 'Durable agent execution queue and lifecycle. Workers claim rows with FOR UPDATE SKIP LOCKED and a lease.';
