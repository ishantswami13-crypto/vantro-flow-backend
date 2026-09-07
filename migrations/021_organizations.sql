-- Migration 021: Organizations (Global Context, Part A)
--
-- ADDITIVE ONLY. Does not replace, rename, or migrate the existing tenant
-- key (`user_id`, used identically across every table since migration 001).
-- `organizations` is a small, optional contextual layer that existing code
-- can ignore entirely. `owner_user_id` is an EXPLICIT bridge column back to
-- `users.id` — never implicit, never inferred.
--
-- Design decision (documented per Part A instructions): we did NOT extend
-- `users` in place, even though `users` already carries some overlapping
-- fields (business_name, gstin, address, industry, city). Reasoning:
--   1. `users` is the AUTH/tenant-identity table (email, password_hash,
--      phone_verified, whatsapp tokens) — mixing a "business profile"
--      concept into it further overloads an already-overloaded table.
--   2. A separate table lets `home_country`/`base_currency` be nullable
--      contextual facts with their own created_at/updated_at lifecycle,
--      without touching the `users` row shape at all (zero risk to any
--      existing `users` query/insert/update statement in server.js).
--   3. It leaves room (future, NOT built now) for one user to eventually
--      own >1 organization without another migration — though today the
--      relationship is enforced 1:1 via a UNIQUE constraint on
--      owner_user_id, matching the current one-user-equals-one-business
--      reality documented in STARLANE_GLOBAL_MULTIDIMENSIONAL_ARCHITECTURE.md
--      section 3.3. Widening 1:1 -> 1:many later only requires dropping the
--      UNIQUE constraint, not a schema rewrite.
-- industry is NOT backfilled from users.industry here — see
-- getOrCreateOrganizationContext() in lib/domain/globalContext/organization.js
-- for the one place that reads users.industry as a real existing fact.

CREATE TABLE IF NOT EXISTS organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  legal_name TEXT,
  display_name TEXT,
  home_country TEXT,   -- ISO 3166-1 alpha-2, nullable, never guessed
  base_currency TEXT,  -- ISO 4217, nullable, never guessed
  timezone TEXT,
  industry TEXT,        -- nullable; only populated from a real existing fact (users.industry)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_organizations_owner_user_id ON organizations(owner_user_id);

COMMENT ON TABLE organizations IS
  'Additive contextual layer over users. owner_user_id is the explicit bridge to the existing user_id tenant key. Nothing existing is forced to read this table.';
COMMENT ON COLUMN organizations.home_country IS 'ISO 3166-1 alpha-2. NULL means genuinely unknown -- never inferred/guessed.';
COMMENT ON COLUMN organizations.base_currency IS 'ISO 4217. NULL means genuinely unknown -- never inferred/guessed.';
