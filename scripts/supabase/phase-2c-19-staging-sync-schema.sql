-- Phase 2C.19 — STAGING-ONLY sync schema for the Neon -> Cortex load proof.
-- ─────────────────────────────────────────────────────────────────────────────
-- STAGING CORTEX ONLY. NOT a production migration. NOT production truth.
-- Fully idempotent + non-destructive:
--   CREATE TABLE IF NOT EXISTS / ALTER TABLE ADD COLUMN IF NOT EXISTS /
--   CREATE [UNIQUE] INDEX IF NOT EXISTS. No DROP. No data mutation. No deletes.
-- Apply ONLY via staging-safe tooling that blocks the production Supabase ref
-- (scripts/apply-sql-file.js or staging-migrate.js, which reject project
-- 'alepdpyqesevldobjxbo' and 'vantro.in'). NEVER apply to production or to Neon.
--
-- Derived from the 2026-06-04 read-only REST preflight of staging Cortex:
--   * sync_batches: MISSING
--   * customers : source_type, source_id, sync_source, sync_batch_id  -> MISSING
--   * invoices  : source_type, source_id PRESENT; sync_source, sync_batch_id MISSING
--   * followups : source_type, source_id, sync_source, sync_batch_id  -> MISSING
-- ─────────────────────────────────────────────────────────────────────────────

-- 1) sync_batches ledger ──────────────────────────────────────────────────────
-- user_id FK -> public.users(id) is SAFE in staging (users exists; OWNER_A/OWNER_B present).
-- NULL allowed so a batch-level row can exist before per-tenant attribution; per-tenant
-- ledger rows set user_id to the resolved Cortex owner.
CREATE TABLE IF NOT EXISTS public.sync_batches (
  sync_batch_id    UUID        PRIMARY KEY,
  sync_source      TEXT        NOT NULL,
  user_id          UUID        NULL REFERENCES public.users(id),
  status           TEXT        NOT NULL,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at      TIMESTAMPTZ NULL,
  source_watermark TEXT        NULL,
  counts           JSONB       NOT NULL DEFAULT '{}'::jsonb,
  notes            TEXT        NULL
);

-- 2) provenance columns ───────────────────────────────────────────────────────
-- customers: all four missing
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS source_type   TEXT;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS source_id     TEXT;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS sync_source   TEXT;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS sync_batch_id UUID;

-- invoices: source_type / source_id already exist (prior evidence work) -> add only the two missing
ALTER TABLE public.invoices  ADD COLUMN IF NOT EXISTS sync_source   TEXT;
ALTER TABLE public.invoices  ADD COLUMN IF NOT EXISTS sync_batch_id UUID;

-- followups: all four missing
ALTER TABLE public.followups ADD COLUMN IF NOT EXISTS source_type   TEXT;
ALTER TABLE public.followups ADD COLUMN IF NOT EXISTS source_id     TEXT;
ALTER TABLE public.followups ADD COLUMN IF NOT EXISTS sync_source   TEXT;
ALTER TABLE public.followups ADD COLUMN IF NOT EXISTS sync_batch_id UUID;

-- 3) idempotency unique indexes (PARTIAL: synced rows only) ────────────────────
-- Predicate `WHERE source_id IS NOT NULL` scopes uniqueness to SYNCED rows only, so:
--   * native/app rows (source_id NULL) are NOT constrained and can never collide;
--   * re-running an UPSERT on the same (user_id, sync_source, source_type, source_id)
--     converges instead of duplicating (this is the ON CONFLICT / merge-duplicates anchor).
-- No sync has run yet -> 0 synced rows -> index creation cannot fail on existing data.
-- If a future apply errors here on existing data, STOP and report duplicate counts only
-- (do not delete/mutate rows).
CREATE UNIQUE INDEX IF NOT EXISTS uq_customers_sync_src
  ON public.customers (user_id, sync_source, source_type, source_id)
  WHERE source_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_sync_src
  ON public.invoices  (user_id, sync_source, source_type, source_id)
  WHERE source_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_followups_sync_src
  ON public.followups (user_id, sync_source, source_type, source_id)
  WHERE source_id IS NOT NULL;

-- 4) helper (non-unique) indexes ──────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS ix_sync_batches_src_user_started
  ON public.sync_batches (sync_source, user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS ix_customers_sync_batch ON public.customers (sync_batch_id);
CREATE INDEX IF NOT EXISTS ix_invoices_sync_batch  ON public.invoices  (sync_batch_id);
CREATE INDEX IF NOT EXISTS ix_followups_sync_batch ON public.followups (sync_batch_id);

SELECT 'phase-2c-19 staging sync schema applied (staging-only, no data load)' AS status;
