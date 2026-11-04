-- Migration 050: Access applications, download entitlements, download events
--
-- Starlane is in a selective rollout: visitors apply, a deterministic,
-- versioned rule set (lib/access/eligibility.js — no model involved) assesses
-- compatibility, and an admin decides. Approval issues a download entitlement:
-- a random bearer token (stored only as a SHA-256 hash) that unlocks the
-- download page for a limited time. Every status change and every download is
-- recorded.
--
-- Not tenant data: an application exists before any user account does, so
-- these tables are keyed by application, not user_id. They are only ever
-- read by (a) the applicant holding their status token, (b) admins
-- (ADMIN_EMAILS), (c) an entitlement-token holder for the download page.
-- RLS is enabled with no policies, so anon/authenticated roles can read
-- nothing; the backend's service role is the only accessor. Safe to re-run.

CREATE TABLE IF NOT EXISTS access_applications (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email                TEXT NOT NULL,
  name                 TEXT NOT NULL,
  company              TEXT NOT NULL,
  website              TEXT,
  role                 TEXT NOT NULL,
  company_size         TEXT NOT NULL CHECK (company_size IN ('1-10','11-50','51-200','201-1000','1000+')),
  industry             TEXT NOT NULL,
  country              TEXT NOT NULL,
  systems              TEXT[] NOT NULL DEFAULT '{}',   -- connector ids from lib/connectors/registry.js
  other_systems        TEXT,                           -- free text: anything not in the registry
  problem              TEXT NOT NULL,
  desired_outcome      TEXT NOT NULL,
  will_connect_systems BOOLEAN NOT NULL,
  notes                TEXT,
  status               TEXT NOT NULL DEFAULT 'submitted'
                       CHECK (status IN ('submitted','reviewing','approved','waitlisted','rejected','expired')),
  eligibility          JSONB NOT NULL,                 -- {tier, rules_version, reasons[]} at submission time
  status_token_hash    TEXT NOT NULL UNIQUE,
  review_note          TEXT,                           -- shown to the applicant
  reviewed_by          TEXT,                           -- admin email
  reviewed_at          TIMESTAMPTZ,
  source_ip_hash       TEXT,                           -- salted hash, abuse analysis only
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One application per email address (case-insensitive).
CREATE UNIQUE INDEX IF NOT EXISTS uq_access_applications_email ON access_applications (lower(email));
CREATE INDEX IF NOT EXISTS idx_access_applications_status ON access_applications (status, created_at DESC);

CREATE TABLE IF NOT EXISTS access_application_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id  UUID NOT NULL REFERENCES access_applications(id) ON DELETE CASCADE,
  from_status     TEXT,
  to_status       TEXT NOT NULL,
  actor           TEXT NOT NULL,          -- 'applicant' | 'system' | admin email
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_access_application_events_app ON access_application_events (application_id, created_at);

CREATE TABLE IF NOT EXISTS access_entitlements (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id   UUID NOT NULL REFERENCES access_applications(id) ON DELETE CASCADE,
  token_hash       TEXT NOT NULL UNIQUE,
  expires_at       TIMESTAMPTZ NOT NULL,
  revoked_at       TIMESTAMPTZ,
  created_by       TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_access_entitlements_app ON access_entitlements (application_id, created_at DESC);

CREATE TABLE IF NOT EXISTS access_download_events (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entitlement_id   UUID NOT NULL REFERENCES access_entitlements(id) ON DELETE CASCADE,
  artifact         TEXT NOT NULL,
  source_ip_hash   TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_access_download_events_ent ON access_download_events (entitlement_id, created_at DESC);

ALTER TABLE access_applications       ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_application_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_entitlements       ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_download_events    ENABLE ROW LEVEL SECURITY;
