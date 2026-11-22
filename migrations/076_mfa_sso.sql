-- Migration 076: multi-factor sign-in and organization single sign-on (OIDC).
--
-- Additive only. Builds on 072 (organizations) and 075 (credentials key use).
--
--   user_mfa                     one row per account that has started or turned
--                                on an authenticator app (TOTP, RFC 6238). The
--                                secret is AES-256-GCM encrypted with
--                                OUTBOUND_CREDENTIALS_KEY. Recovery codes are
--                                stored only as SHA-256 hashes. last_step stops
--                                a code being used twice; failed_count and
--                                locked_until slow down guessing.
--   organizations.mfa_required_for  'none', 'admins' or 'everyone': who in the
--                                organization must have signed in with a
--                                second factor (or the organization's SSO) to
--                                use the workspace.
--   platform_sso_connections     an organization's OpenID Connect identity
--                                provider (Okta, Microsoft Entra ID, Google
--                                Workspace, Auth0, …). The client secret is
--                                encrypted. 'draft' until a test sign-in
--                                succeeds; only then can it be enforced.
--   platform_sso_domains         email domains an organization claims for SSO.
--                                A domain counts only once a DNS TXT record
--                                proves the organization controls it, and a
--                                verified domain belongs to one organization.
--   platform_sso_states          one-time state for an SSO sign-in (PKCE and
--                                nonce), stored by hash, 10-minute expiry.
--
-- Rollback (nothing else references these):
--   DROP TABLE IF EXISTS platform_sso_states, platform_sso_domains, platform_sso_connections, user_mfa;
--   ALTER TABLE organizations DROP COLUMN IF EXISTS mfa_required_for;

BEGIN;

CREATE TABLE IF NOT EXISTS user_mfa (
  user_id             UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret_enc          TEXT,
  pending_secret_enc  TEXT,
  pending_created_at  TIMESTAMPTZ,
  enabled_at          TIMESTAMPTZ,
  last_step           BIGINT NOT NULL DEFAULT 0,
  recovery_hashes     TEXT[] NOT NULL DEFAULT '{}',
  failed_count        INTEGER NOT NULL DEFAULT 0,
  locked_until        TIMESTAMPTZ,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE user_mfa ENABLE ROW LEVEL SECURITY;

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS mfa_required_for TEXT NOT NULL DEFAULT 'none';
DO $$ BEGIN
  ALTER TABLE organizations ADD CONSTRAINT organizations_mfa_required_for_check CHECK (mfa_required_for IN ('none', 'admins', 'everyone'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS platform_sso_connections (
  organization_id    UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  protocol           TEXT NOT NULL DEFAULT 'oidc' CHECK (protocol IN ('oidc')),
  issuer             TEXT NOT NULL,
  client_id          TEXT NOT NULL,
  client_secret_enc  TEXT,
  scopes             TEXT[] NOT NULL DEFAULT '{openid,email,profile}',
  discovery          JSONB NOT NULL DEFAULT '{}'::jsonb,
  jit_role           TEXT NOT NULL DEFAULT 'member' CHECK (jit_role IN ('viewer', 'member', 'admin')),
  enforce            BOOLEAN NOT NULL DEFAULT FALSE,
  status             TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active')),
  tested_at          TIMESTAMPTZ,
  created_by         UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE platform_sso_connections ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS platform_sso_domains (
  organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  domain              TEXT NOT NULL CHECK (domain = lower(domain)),
  verification_token  TEXT NOT NULL,
  verified_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (organization_id, domain)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_platform_sso_domains_verified ON platform_sso_domains(domain) WHERE verified_at IS NOT NULL;
ALTER TABLE platform_sso_domains ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS platform_sso_states (
  state_hash       TEXT PRIMARY KEY,
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  nonce            TEXT NOT NULL,
  code_verifier    TEXT NOT NULL,
  mode             TEXT NOT NULL DEFAULT 'signin' CHECK (mode IN ('signin', 'test')),
  started_by       UUID REFERENCES users(id) ON DELETE CASCADE,
  expires_at       TIMESTAMPTZ NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_platform_sso_states_expiry ON platform_sso_states(expires_at);
ALTER TABLE platform_sso_states ENABLE ROW LEVEL SECURITY;

COMMIT;
