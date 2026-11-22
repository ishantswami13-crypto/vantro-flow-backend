-- 077: SAML single sign-on, passkeys (WebAuthn) and revocable web sessions.
--
-- Additive only. The code reads every new table and column defensively, so
-- it runs before this is applied: SAML cannot be saved, passkeys are off,
-- and web sessions stay the old 30-day tokens without a revocation list.
--
-- Rollback (in this order):
--   DROP TABLE IF EXISTS webauthn_challenges;
--   DROP TABLE IF EXISTS user_passkeys;
--   DROP TABLE IF EXISTS web_sessions;
--   ALTER TABLE users DROP COLUMN IF EXISTS sessions_valid_after;
--   ALTER TABLE organizations DROP COLUMN IF EXISTS session_max_hours;
--   ALTER TABLE platform_sso_connections DROP COLUMN IF EXISTS saml;
--   DELETE FROM platform_sso_connections WHERE protocol = 'saml';
--   ALTER TABLE platform_sso_connections DROP CONSTRAINT IF EXISTS platform_sso_connections_protocol_check;
--   ALTER TABLE platform_sso_connections ADD CONSTRAINT platform_sso_connections_protocol_check CHECK (protocol IN ('oidc'));
--   ALTER TABLE platform_sso_connections ALTER COLUMN client_id SET NOT NULL;
--   (platform_sso_states.code_verifier may stay nullable.)

BEGIN;

-- ── SAML 2.0 ────────────────────────────────────────────────────────────
-- For a SAML connection: issuer holds the IdP entity ID, client_id is NULL,
-- saml holds { ssoUrl, certs: [PEM...], emailAttribute }.
ALTER TABLE platform_sso_connections ALTER COLUMN client_id DROP NOT NULL;
ALTER TABLE platform_sso_connections ADD COLUMN IF NOT EXISTS saml JSONB;
ALTER TABLE platform_sso_connections DROP CONSTRAINT IF EXISTS platform_sso_connections_protocol_check;
ALTER TABLE platform_sso_connections ADD CONSTRAINT platform_sso_connections_protocol_check CHECK (protocol IN ('oidc', 'saml'));
-- For SAML the state row's nonce holds the AuthnRequest ID; there is no PKCE verifier.
ALTER TABLE platform_sso_states ALTER COLUMN code_verifier DROP NOT NULL;

-- ── Passkeys ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_passkeys (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id  TEXT NOT NULL UNIQUE,          -- base64url
  public_key     BYTEA NOT NULL,                -- COSE key
  counter        BIGINT NOT NULL DEFAULT 0,
  transports     TEXT[] NOT NULL DEFAULT '{}',
  device_type    TEXT,                          -- singleDevice | multiDevice
  backed_up      BOOLEAN NOT NULL DEFAULT FALSE,
  name           TEXT NOT NULL DEFAULT 'Passkey',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_user_passkeys_user ON user_passkeys(user_id);
ALTER TABLE user_passkeys ENABLE ROW LEVEL SECURITY;

-- Single-use challenges, stored by hash, 5 minutes.
CREATE TABLE IF NOT EXISTS webauthn_challenges (
  challenge_hash  TEXT PRIMARY KEY,
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
  purpose         TEXT NOT NULL CHECK (purpose IN ('register', 'signin', 'second_step')),
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_expiry ON webauthn_challenges(expires_at);
ALTER TABLE webauthn_challenges ENABLE ROW LEVEL SECURITY;

-- ── Revocable web sessions ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS web_sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  method        TEXT NOT NULL DEFAULT 'password',
  mfa           BOOLEAN NOT NULL DEFAULT FALSE,
  sso_org       UUID,
  user_agent    TEXT,
  ip_prefix     TEXT,                           -- /24 for IPv4, /48 for IPv6; never the full address
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_web_sessions_user ON web_sessions(user_id, created_at DESC);
ALTER TABLE web_sessions ENABLE ROW LEVEL SECURITY;

-- Tokens issued before this time are refused ("sign out everywhere", password changes).
ALTER TABLE users ADD COLUMN IF NOT EXISTS sessions_valid_after TIMESTAMPTZ;

-- An organization can cap how old a session may be for its workspace (hours).
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS session_max_hours INTEGER;
DO $$ BEGIN
  ALTER TABLE organizations ADD CONSTRAINT organizations_session_max_hours_check CHECK (session_max_hours IS NULL OR session_max_hours BETWEEN 1 AND 720);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMIT;
