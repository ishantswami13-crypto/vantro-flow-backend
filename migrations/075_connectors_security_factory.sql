-- Migration 075: connect any software, security controls, agent factory.
--
-- Builds on 072_platform_core (organizations, members, roles, agents,
-- platform_audit_events). Additive except two triggers on the existing
-- platform_audit_events table (hash chain + append-only), described below.
--
--   platform_app_connections   one row per piece of software an organization
--                              connects: imported from an OpenAPI/Swagger
--                              spec, picked from the catalog, or a remote MCP
--                              server. Holds the operations Starlane may call.
--                              Credentials are AES-256-GCM encrypted
--                              (OUTBOUND_CREDENTIALS_KEY) and never returned.
--   platform_oauth_states      one-time state for the OAuth 2.0 authorization
--                              code flow (PKCE). Only a hash of the state is
--                              stored; it expires after 10 minutes.
--   platform_connector_calls   a log of every call made through a connection
--                              (who, which operation, status, duration). No
--                              request or response bodies are kept.
--   platform_privacy_requests  GDPR / CCPA data export and erasure requests.
--                              No foreign key to organizations, so the receipt
--                              of a completed erasure survives the erasure.
--   platform_retention_policies  how long each class of operational data is
--                              kept before the retention job removes it.
--   platform_factory_builds    each agent factory build: what was asked for,
--                              which draft agents it created, what it skipped.
--
-- Audit log hardening (platform_audit_events):
--   * hash chain: every new row stores the SHA-256 of the previous row's hash
--     plus its own content, per organization. Editing or deleting a past row
--     breaks the chain, which GET /api/platform/security/audit/verify reports.
--     Rows written before this migration have no hash and are reported as
--     "before the chain started".
--   * the actor is hashed as actor_hash (sha256 of the user id) and the chain
--     covers actor_hash, not actor_user_id. When a person's account is erased
--     their id on past rows becomes NULL (ON DELETE SET NULL), which is the
--     pseudonymisation GDPR expects, and the chain still verifies.
--   * append-only: UPDATE is refused except that one change (actor_user_id
--     to NULL). DELETE is refused unless the organization itself is being
--     deleted (account erasure cascades) or the session sets
--     starlane.audit_purge = 'on'.
--
-- Rollback: DROP the six new tables, DROP TRIGGER trg_platform_audit_chain
-- and trg_platform_audit_append_only ON platform_audit_events, DROP FUNCTION
-- platform_audit_chain() and platform_audit_append_only(), and ALTER TABLE
-- platform_audit_events DROP COLUMN prev_hash, DROP COLUMN hash, DROP COLUMN actor_hash.

-- ── Connections to any software ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS platform_app_connections (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  name             TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  source           TEXT NOT NULL CHECK (source IN ('openapi', 'catalog', 'mcp')),
  catalog_key      TEXT,
  base_url         TEXT NOT NULL,
  auth_type        TEXT NOT NULL CHECK (auth_type IN ('none', 'api_key', 'bearer', 'basic', 'oauth2_client_credentials', 'oauth2_authorization_code')),
  auth_config      JSONB NOT NULL DEFAULT '{}'::jsonb,   -- non-secret: header/query name, token and authorize URLs, client id, scopes
  credentials_enc  TEXT,                                  -- encrypted; never returned
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'authorization_required')),
  operations       JSONB NOT NULL DEFAULT '[]'::jsonb,    -- [{id, method, path, summary, risk, parameters, body}]
  spec_meta        JSONB NOT NULL DEFAULT '{}'::jsonb,    -- title, version, source format, operation counts
  last_used_at     TIMESTAMPTZ,
  last_error       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, name)
);
CREATE INDEX IF NOT EXISTS idx_platform_app_connections_org ON platform_app_connections(organization_id, created_at DESC);
ALTER TABLE platform_app_connections ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS platform_oauth_states (
  state_hash         TEXT PRIMARY KEY,
  organization_id    UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  connection_id      UUID NOT NULL REFERENCES platform_app_connections(id) ON DELETE CASCADE,
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_verifier_enc  TEXT NOT NULL,
  redirect_uri       TEXT NOT NULL,
  return_to          TEXT,
  expires_at         TIMESTAMPTZ NOT NULL,
  used_at            TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_platform_oauth_states_exp ON platform_oauth_states(expires_at);
ALTER TABLE platform_oauth_states ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS platform_connector_calls (
  id               BIGSERIAL PRIMARY KEY,
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  connection_id    UUID REFERENCES platform_app_connections(id) ON DELETE SET NULL,
  operation_id     TEXT NOT NULL,
  method           TEXT NOT NULL,
  risk             TEXT NOT NULL CHECK (risk IN ('read', 'external')),
  actor_kind       TEXT NOT NULL CHECK (actor_kind IN ('user', 'agent')),
  actor_user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  execution_id     UUID,
  status_code      INTEGER,
  ok               BOOLEAN NOT NULL DEFAULT FALSE,
  duration_ms      INTEGER,
  error            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_platform_connector_calls_org ON platform_connector_calls(organization_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_platform_connector_calls_conn ON platform_connector_calls(connection_id, id DESC);
ALTER TABLE platform_connector_calls ENABLE ROW LEVEL SECURITY;

-- ── Privacy requests (GDPR / CCPA) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS platform_privacy_requests (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    UUID NOT NULL,               -- no FK: the receipt outlives an erasure
  requested_by       UUID,                        -- no FK for the same reason
  kind               TEXT NOT NULL CHECK (kind IN ('export', 'erasure')),
  scope              TEXT NOT NULL CHECK (scope IN ('me', 'organization')),
  status             TEXT NOT NULL CHECK (status IN ('scheduled', 'completed', 'cancelled', 'failed')),
  scheduled_for      TIMESTAMPTZ,
  completed_at       TIMESTAMPTZ,
  subject_email_hash TEXT,                        -- sha256 of the requester's email, for proof of who asked
  result             JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_platform_privacy_requests_org ON platform_privacy_requests(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_privacy_requests_due ON platform_privacy_requests(scheduled_for) WHERE status = 'scheduled';
ALTER TABLE platform_privacy_requests ENABLE ROW LEVEL SECURITY;

-- ── Retention policy ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS platform_retention_policies (
  organization_id  UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  policy           JSONB NOT NULL DEFAULT '{}'::jsonb,   -- days per data class, see lib/platform/security/retention.js
  updated_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE platform_retention_policies ENABLE ROW LEVEL SECURITY;

-- ── Agent factory ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS platform_factory_builds (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  requested_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  source           TEXT NOT NULL CHECK (source IN ('pack', 'templates', 'connection', 'objectives')),
  request          JSONB NOT NULL DEFAULT '{}'::jsonb,
  agent_ids        UUID[] NOT NULL DEFAULT '{}',
  test_execution_ids UUID[] NOT NULL DEFAULT '{}',
  skipped          JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_platform_factory_builds_org ON platform_factory_builds(organization_id, created_at DESC);
ALTER TABLE platform_factory_builds ENABLE ROW LEVEL SECURITY;

-- ── Audit log: hash chain and append-only ───────────────────────────────
ALTER TABLE platform_audit_events ADD COLUMN IF NOT EXISTS prev_hash TEXT;
ALTER TABLE platform_audit_events ADD COLUMN IF NOT EXISTS hash TEXT;
ALTER TABLE platform_audit_events ADD COLUMN IF NOT EXISTS actor_hash TEXT;

-- The canonical text hashed for a row. lib/platform/security/auditChain.js
-- recomputes exactly this to verify, so the two must stay identical.
CREATE OR REPLACE FUNCTION platform_audit_canonical(e platform_audit_events) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT concat_ws('|',
    e.organization_id::text,
    COALESCE(e.actor_hash, ''),
    e.actor_kind,
    e.action,
    e.resource_type,
    COALESCE(e.resource_id, ''),
    e.detail::text,
    to_char(e.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
$$;

CREATE OR REPLACE FUNCTION platform_audit_chain() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  prev TEXT;
BEGIN
  -- One writer per organization at a time, held until the transaction ends,
  -- so two concurrent inserts cannot both chain onto the same row.
  PERFORM pg_advisory_xact_lock(hashtext('platform_audit:' || NEW.organization_id::text));
  SELECT hash INTO prev FROM platform_audit_events
   WHERE organization_id = NEW.organization_id AND hash IS NOT NULL
   ORDER BY id DESC LIMIT 1;
  NEW.created_at := COALESCE(NEW.created_at, NOW());
  NEW.actor_hash := CASE WHEN NEW.actor_user_id IS NULL THEN NULL
                         ELSE encode(sha256(convert_to(NEW.actor_user_id::text, 'UTF8')), 'hex') END;
  NEW.prev_hash := COALESCE(prev, 'genesis');
  NEW.hash := encode(sha256(convert_to(NEW.prev_hash || '|' || platform_audit_canonical(NEW), 'UTF8')), 'hex');
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_platform_audit_chain ON platform_audit_events;
CREATE TRIGGER trg_platform_audit_chain BEFORE INSERT ON platform_audit_events
  FOR EACH ROW EXECUTE FUNCTION platform_audit_chain();

CREATE OR REPLACE FUNCTION platform_audit_append_only() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('starlane.audit_purge', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'DELETE' THEN
    -- The organization is being deleted (account erasure cascades here).
    IF NOT EXISTS (SELECT 1 FROM organizations WHERE id = OLD.organization_id) THEN
      RETURN OLD;
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    -- Pseudonymisation only: the actor's id becomes NULL, nothing else moves.
    IF NEW.actor_user_id IS NULL AND OLD.actor_user_id IS NOT NULL
       AND (to_jsonb(NEW) - 'actor_user_id') = (to_jsonb(OLD) - 'actor_user_id') THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'platform_audit_events is append-only' USING ERRCODE = 'insufficient_privilege';
END $$;

DROP TRIGGER IF EXISTS trg_platform_audit_append_only ON platform_audit_events;
CREATE TRIGGER trg_platform_audit_append_only BEFORE UPDATE OR DELETE ON platform_audit_events
  FOR EACH ROW EXECUTE FUNCTION platform_audit_append_only();
