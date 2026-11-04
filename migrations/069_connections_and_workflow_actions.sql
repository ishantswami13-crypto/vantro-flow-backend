-- Migration 069: connect any software, and let workflows act through it.
--
--   starlane_connections          one row per connection a tenant adds:
--                                 an incoming webhook (any tool that can
--                                 POST JSON) or an outgoing HTTP API (REST
--                                 with an API key, bearer token, basic auth
--                                 or OAuth2 client credentials; Slack
--                                 incoming webhooks are a preset). Secrets
--                                 are AES-256-GCM encrypted
--                                 (OUTBOUND_CREDENTIALS_KEY); an incoming
--                                 webhook's token is stored only as a hash.
--   starlane_connection_events    what arrived from outside (a webhook POST,
--                                 a Gmail message). The trigger bus for
--                                 workflows; (user_id, source, external_id)
--                                 is unique so a retry never runs twice.
--   starlane_workflow_approvals   emails a workflow drafted. Nothing leaves
--                                 Starlane until the owner approves one, and
--                                 even then only with
--                                 FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED.
--   starlane_workflow_tasks       tasks a workflow created for the team.
--
-- Additive only. user_id scopes every row (REFERENCES users ON DELETE
-- CASCADE); RLS enabled, the service-role backend filters by user_id.

CREATE TABLE IF NOT EXISTS starlane_connections (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind                TEXT NOT NULL CHECK (kind IN ('webhook_in', 'http_api')),
  name                TEXT NOT NULL,
  config              JSONB NOT NULL DEFAULT '{}'::jsonb,   -- non-secret: base URL, auth type, header name, preset
  secret_enc          TEXT,                                  -- encrypted API key / token / client secret; never returned
  inbound_token_hash  TEXT UNIQUE,                           -- sha256 of an incoming webhook's URL token
  status              TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
  last_used_at        TIMESTAMPTZ,
  last_error          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_starlane_connections_user ON starlane_connections (user_id, created_at DESC);
ALTER TABLE starlane_connections ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS starlane_connection_events (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connection_id  UUID REFERENCES starlane_connections(id) ON DELETE SET NULL,
  source         TEXT NOT NULL CHECK (source IN ('webhook', 'gmail')),
  external_id    TEXT NOT NULL,
  payload        JSONB NOT NULL,
  received_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  dispatched_at  TIMESTAMPTZ,
  UNIQUE (user_id, source, external_id)
);
CREATE INDEX IF NOT EXISTS idx_connection_events_user ON starlane_connection_events (user_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_connection_events_pending ON starlane_connection_events (received_at) WHERE dispatched_at IS NULL;
ALTER TABLE starlane_connection_events ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS starlane_workflow_approvals (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workflow_id      UUID REFERENCES starlane_custom_workflows(id) ON DELETE SET NULL,
  run_id           UUID REFERENCES starlane_custom_workflow_runs(id) ON DELETE SET NULL,
  step_id          TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('send_email')),
  payload          JSONB NOT NULL,
  status           TEXT NOT NULL DEFAULT 'PENDING'
                   CHECK (status IN ('PENDING', 'SENDING', 'SENT', 'REJECTED', 'BLOCKED', 'FAILED')),
  status_reason    TEXT,
  result           JSONB,
  decided_by       UUID,
  decided_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, step_id)
);
CREATE INDEX IF NOT EXISTS idx_workflow_approvals_user ON starlane_workflow_approvals (user_id, status, created_at DESC);
ALTER TABLE starlane_workflow_approvals ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS starlane_workflow_tasks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workflow_id   UUID REFERENCES starlane_custom_workflows(id) ON DELETE SET NULL,
  run_id        UUID REFERENCES starlane_custom_workflow_runs(id) ON DELETE SET NULL,
  step_id       TEXT NOT NULL,
  title         TEXT NOT NULL,
  detail        TEXT,
  due_on        DATE,
  status        TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'DONE')),
  done_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, step_id)
);
CREATE INDEX IF NOT EXISTS idx_workflow_tasks_user ON starlane_workflow_tasks (user_id, status, created_at DESC);
ALTER TABLE starlane_workflow_tasks ENABLE ROW LEVEL SECURITY;
