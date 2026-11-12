-- Migration 073: organization invitations.
--
-- NOT APPLIED TO PRODUCTION BY THIS CHANGE. Depends on 072. Apply with
-- `npm run db:migrate` against staging first.
--
-- An admin invites someone by email, including a person who has no Starlane
-- account yet. Only a SHA-256 hash of the invite token is stored; the link
-- is shown once to the admin (and emailed if they ask and email is set up).
-- Accepting requires signing in with the invited email address. Invitations
-- expire after 7 days and can be revoked.

CREATE TABLE IF NOT EXISTS platform_invitations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email           TEXT NOT NULL CHECK (email = lower(email) AND length(email) <= 254),
  role            TEXT NOT NULL CHECK (role IN ('admin', 'member', 'viewer')),
  token_hash      TEXT NOT NULL UNIQUE,
  invited_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT NOW() + interval '7 days',
  accepted_at     TIMESTAMPTZ,
  accepted_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  revoked_at      TIMESTAMPTZ,
  email_sent      BOOLEAN NOT NULL DEFAULT FALSE
);
-- One open invitation per person per organization.
CREATE UNIQUE INDEX IF NOT EXISTS uq_platform_invitations_open
  ON platform_invitations (organization_id, email) WHERE accepted_at IS NULL AND revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_platform_invitations_org ON platform_invitations (organization_id, created_at DESC);
ALTER TABLE platform_invitations ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE platform_invitations IS 'Invitations to join an organization. Only the token hash is stored; accepting requires the invited email.';
