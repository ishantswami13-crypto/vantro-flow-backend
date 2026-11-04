-- Migration 052: native client sessions, canonical notifications, push devices
--
-- 1. auth_sessions — refresh-token sessions for the desktop and mobile apps.
--    Access tokens are 15-minute JWTs carrying the session family id (sid);
--    refresh tokens rotate on every use and are stored only as SHA-256.
--    Presenting an already-rotated refresh token revokes the whole family
--    (token theft detection). The web app's existing 30-day tokens are
--    unaffected.
-- 2. notification_events — ONE canonical notification object per event,
--    read by web, desktop and mobile alike (no per-client notification
--    logic). dedupe_key stops repeats (e.g. one "connector offline" per
--    device per day).
-- 3. push_devices — where to deliver a notification outside the app
--    (Expo push tokens for iOS/Android today).
-- Additive. Safe to re-run.

CREATE TABLE IF NOT EXISTS auth_sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     UUID NOT NULL,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_hash  TEXT NOT NULL UNIQUE,
  client        TEXT NOT NULL CHECK (client IN ('desktop', 'mobile', 'web', 'cli')),
  platform      TEXT,
  device_name   TEXT,
  app_version   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ,
  replaced_by   UUID
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_family ON auth_sessions (family_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions (user_id, created_at DESC);
ALTER TABLE auth_sessions ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS notification_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type         TEXT NOT NULL,          -- approval_required | action_completed | action_failed | connector_offline | connector_error | business_change | discovery
  severity     TEXT NOT NULL DEFAULT 'normal' CHECK (severity IN ('low', 'normal', 'high', 'critical')),
  title        TEXT NOT NULL,
  body         TEXT,
  entity_type  TEXT,
  entity_id    TEXT,
  action_id    UUID,
  route        TEXT NOT NULL,          -- client-agnostic deep link, e.g. /actions/<id>, /sources/tally
  dedupe_key   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at      TIMESTAMPTZ,
  push_status  TEXT                    -- null | sent | failed | none
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_notification_events_dedupe ON notification_events (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notification_events_user ON notification_events (user_id, created_at DESC);
ALTER TABLE notification_events ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS push_devices (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider     TEXT NOT NULL CHECK (provider IN ('expo')),
  token        TEXT NOT NULL,
  platform     TEXT,
  device_name  TEXT,
  session_id   UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  disabled_at  TIMESTAMPTZ,
  UNIQUE (provider, token)
);
CREATE INDEX IF NOT EXISTS idx_push_devices_user ON push_devices (user_id) WHERE disabled_at IS NULL;
ALTER TABLE push_devices ENABLE ROW LEVEL SECURITY;
