-- Migration 047: Connector device enrollment (Tally local connector auth)
--
-- Documents schema that ALREADY EXISTS live in the production Neon DB
-- (confirmed by direct inspection during this session: connector_enrollments
-- has 2 rows, connector_devices has 1 row, both scoped to a real tenant).
-- It was evidently created directly against the DB in an earlier session
-- and never committed as a migration file — this migration closes that gap
-- so the schema is tracked, reviewable, and reproducible on a fresh DB,
-- using IF NOT EXISTS throughout so it is a no-op against the existing
-- production tables.
--
-- Purpose: re-enable the 4 previously-disabled /api/connectors/tally/*
-- routes (see server.js "DISABLED 2026-09-20" comment, now removed) with a
-- real device-pairing model. The local Tally connector tool
-- (vantro-flow-backend/tally-connector or the standalone
-- vantro-tally-live-connector app, paired via the vantro-tally://pair
-- OS protocol handler already wired in app/sources/page.tsx) needs a
-- durable credential to call protected routes as a specific tenant's
-- device, without the user's own password/JWT living in a config file on
-- their machine forever.
--
-- Flow: user clicks "Connect Tally" in the app (authenticated) ->
-- POST /api/connectors/tally/enrollment creates a short-lived enrollment
-- code -> the local connector tool calls POST /api/connectors/tally/claim
-- with that code, unauthenticated (the code IS the proof of authorization,
-- like an OAuth device-flow user code) -> server mints a device credential
-- of the form "VantroDevice <uuid>.<secret>" (see connectorOrUserAuth in
-- server.js, which parses this exact shape) -> the connector stores that
-- and uses it as the Authorization header on later requests.
--
-- Design decisions (matching the schema already live in production):
--   1. user_id (not tenant_id) — matches every other table in this schema.
--   2. Two tables: connector_enrollments (short-lived, pre-claim) and
--      connector_devices (long-lived, post-claim) — different lifecycles.
--   3. code_hash / token_hash, both UNIQUE, both SHA-256 hex digests (NOT
--      bcrypt) — deterministic hashing is required here because the claim
--      route must look a row up BY the hash of the caller-supplied
--      plaintext code/secret (bcrypt's per-call salt makes that lookup
--      impossible; bcrypt is used elsewhere in this codebase only where
--      the plaintext is compared against one already-known row, e.g.
--      users.password_hash checked after finding the row by email). The
--      cleartext code/secret is generated once, returned once in the
--      response body, and never persisted or logged again.
--   4. claimed_device_id + claimed_at on connector_enrollments enforces
--      claim-once: claimEnrollment() must do a conditional UPDATE ...
--      WHERE claimed_at IS NULL, not a separate read-then-write race.
--   5. connector_devices.status ('ACTIVE'/'REVOKED', CHECK-constrained)
--      plus revoked_at timestamp — soft-revoke, not delete, matching the
--      audit-trail-preferring convention elsewhere in this schema.

CREATE TABLE IF NOT EXISTS connector_enrollments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_type         TEXT NOT NULL DEFAULT 'TALLY',
  code_hash           TEXT NOT NULL UNIQUE,
  expires_at          TIMESTAMPTZ NOT NULL,
  claimed_at          TIMESTAMPTZ,
  claimed_device_id   UUID,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_connector_enrollments_user ON connector_enrollments(user_id, created_at DESC);

ALTER TABLE IF EXISTS connector_enrollments ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE connector_enrollments IS
  'Short-lived pairing codes created by an authenticated user (POST /api/connectors/tally/enrollment) and claimed once, unauthenticated, by a local connector tool (POST /api/connectors/tally/claim) to mint a connector_devices row. code_hash is SHA-256(code) so the claim route can look the row up by the caller-supplied plaintext code. TTL enforced in application code (deviceEnrollment.js) against expires_at.';

CREATE TABLE IF NOT EXISTS connector_devices (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_type         TEXT NOT NULL DEFAULT 'TALLY',
  device_name         TEXT NOT NULL,
  token_hash          TEXT NOT NULL UNIQUE,
  status              TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVOKED')),
  last_seen_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_connector_devices_user ON connector_devices(user_id, created_at DESC);

ALTER TABLE IF EXISTS connector_devices ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  ALTER TABLE connector_enrollments
    ADD CONSTRAINT connector_enrollments_claimed_device_id_fkey
    FOREIGN KEY (claimed_device_id) REFERENCES connector_devices(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON TABLE connector_devices IS
  'Long-lived device credentials for local connector tools (e.g. the Tally XML-pulling connector). token_hash is SHA-256(secret) — a random secret generated once at claim time, never stored/logged in cleartext again; authenticateDevice() looks the device up by id (from the Authorization header) then compares SHA-256(supplied secret) == token_hash. Bearer scheme: "VantroDevice <id>.<secret>", parsed by connectorOrUserAuth in server.js.';
COMMENT ON COLUMN connector_devices.status IS
  'ACTIVE or REVOKED. authenticateDevice() must reject any device with status != ACTIVE. Set to REVOKED (with revoked_at) by POST /api/connectors/tally/devices/:deviceId/revoke.';
