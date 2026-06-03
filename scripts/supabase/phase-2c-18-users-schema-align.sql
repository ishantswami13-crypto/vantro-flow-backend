-- Phase 2C.18 — staging `users` schema alignment
-- STAGING ONLY. Idempotent, non-destructive (ADD COLUMN IF NOT EXISTS only).
--
-- Why: scripts/staging-migrate.js BASE_SCHEMA created `users` as a minimal FK-target
-- stub (id, email, name, password, created_at). The Node backend's /api/auth/me,
-- /api/settings, and /api/auth/login expect the full production-shaped `users` table.
-- With the stub, /api/auth/me 500s on `column users.phone does not exist` (the
-- core-columns fallback also references phone). This file brings staging in line.
--
-- Safe to re-run. apply-sql-file.js blocks the production Supabase ref, so this can
-- never touch production.

-- ── Canonical columns (verbatim types from supabase-schema.sql) ───────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash   TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone           TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS business_name   TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS plan            TEXT DEFAULT 'free';
ALTER TABLE users ADD COLUMN IF NOT EXISTS gstin           TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS address         TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS logo_url        TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS whatsapp_phone  TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS whatsapp_token  TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS industry        TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS language        TEXT DEFAULT 'hinglish';
ALTER TABLE users ADD COLUMN IF NOT EXISTS contact_time    TEXT DEFAULT 'morning';
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ DEFAULT NOW();

-- ── Extra columns referenced by server.js /api/auth/me `fullColumns` ──────────
-- (not present in supabase-schema.sql; added so fullColumns succeeds without falling back)
ALTER TABLE users ADD COLUMN IF NOT EXISTS owner_name      TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS city            TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS business_size   TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS gst_registered  BOOLEAN;
ALTER TABLE users ADD COLUMN IF NOT EXISTS has_workers     BOOLEAN;
ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_done BOOLEAN DEFAULT FALSE;

-- ── Light, non-clobbering backfill for the two deterministic harness owners ───
UPDATE users SET
  business_name   = COALESCE(business_name, 'Harness Owner A'),
  owner_name      = COALESCE(owner_name, 'Owner A'),
  plan            = COALESCE(plan, 'pro'),
  onboarding_done = COALESCE(onboarding_done, TRUE)
WHERE id = '11111111-1111-1111-1111-111111111111';

UPDATE users SET
  business_name   = COALESCE(business_name, 'Harness Owner B'),
  owner_name      = COALESCE(owner_name, 'Owner B'),
  plan            = COALESCE(plan, 'free'),
  onboarding_done = COALESCE(onboarding_done, TRUE)
WHERE id = '22222222-2222-2222-2222-222222222222';

SELECT 'phase-2c-18 users schema align applied' AS status;
