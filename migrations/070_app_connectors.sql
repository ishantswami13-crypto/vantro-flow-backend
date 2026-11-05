-- Migration 070: live app connectors (Zoho Books, QuickBooks Online, Razorpay,
-- WhatsApp Business).
--
--   app_connector_accounts   one row per app a tenant connects. Holds the
--                            OAuth refresh token or the API key, AES-256-GCM
--                            encrypted with OUTBOUND_CREDENTIALS_KEY and never
--                            returned. config keeps non-secret facts the
--                            calls need (Zoho API domain and organization,
--                            QuickBooks realm, WhatsApp phone number id).
--                            Every connector is read-only: Starlane only ever
--                            sends GET requests to these apps.
--
-- Sync attempts reuse connector_sync_runs (connector_id = the app id), and
-- inbound WhatsApp messages reuse starlane_connection_events with
-- source = 'whatsapp'.
--
-- Additive only. user_id scopes every row (REFERENCES users ON DELETE
-- CASCADE); RLS enabled, the service-role backend filters by user_id.

CREATE TABLE IF NOT EXISTS app_connector_accounts (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connector_id         TEXT NOT NULL CHECK (connector_id ~ '^[a-z0-9_]{2,40}$'),
  status               TEXT NOT NULL DEFAULT 'CONNECTED' CHECK (status IN ('CONNECTED', 'AUTH_REQUIRED')),
  status_reason        TEXT,
  account_label        TEXT,                                -- "Acme Traders (Zoho Books, India)"
  external_account_id  TEXT,                                -- Zoho org id, QuickBooks realm id, WhatsApp phone number id
  config               JSONB NOT NULL DEFAULT '{}'::jsonb,  -- non-secret
  credentials_enc      TEXT NOT NULL,                       -- encrypted; never returned
  last_sync_at         TIMESTAMPTZ,
  last_success_at      TIMESTAMPTZ,
  last_error           TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, connector_id)
);
CREATE INDEX IF NOT EXISTS idx_app_connector_accounts_connector ON app_connector_accounts (connector_id, status);
-- Meta delivers every business's WhatsApp messages to one address and names
-- the phone number; one number belongs to one tenant.
CREATE UNIQUE INDEX IF NOT EXISTS uq_app_connector_whatsapp_number
  ON app_connector_accounts (external_account_id) WHERE connector_id = 'whatsapp_business';
ALTER TABLE app_connector_accounts ENABLE ROW LEVEL SECURITY;

ALTER TABLE starlane_connection_events DROP CONSTRAINT IF EXISTS starlane_connection_events_source_check;
ALTER TABLE starlane_connection_events
  ADD CONSTRAINT starlane_connection_events_source_check CHECK (source IN ('webhook', 'gmail', 'whatsapp'));
