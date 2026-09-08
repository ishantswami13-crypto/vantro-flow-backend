-- FILE: migrations/030_import_batches.sql
-- STARLANE — Real Customer Bootstrap & File Ingestion, Part 4.
--
-- Additive, nullable-where-appropriate table recording one row per file
-- import attempt (CSV or XLSX), independent of migration 029's
-- raw_observations (which is per-ROW provenance). This table is per-FILE:
-- it lets the importer detect "this exact file was already uploaded" via
-- file_content_hash, even before any row-level content hash is computed,
-- and gives an honest audit trail of what a given upload did (accepted /
-- rejected / needs_review counts, entities created vs matched).
--
-- NOTE: an UNRELATED pre-existing table named "import_batches" already
-- exists in this real dev DB (columns: entity_type, total_records,
-- successful_records, failed_records — a different, older feature not
-- touched by this phase). To avoid any collision with that table this
-- phase's table is named file_import_batches instead — additive only,
-- no existing table touched or altered.

CREATE TABLE IF NOT EXISTS file_import_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  source_system TEXT NOT NULL DEFAULT 'file_import',
  filename TEXT,
  file_type TEXT, -- 'CSV' | 'XLSX'
  file_content_hash TEXT NOT NULL, -- sha256 of the raw file bytes, for file-level idempotency
  mapping_profile TEXT, -- e.g. 'core', 'tally'
  status TEXT NOT NULL DEFAULT 'STARTED', -- STARTED | COMPLETED | FAILED
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  rows_total INT DEFAULT 0,
  rows_accepted INT DEFAULT 0,
  rows_rejected INT DEFAULT 0,
  rows_review_required INT DEFAULT 0,
  rows_duplicate INT DEFAULT 0,
  entities_created INT DEFAULT 0,
  entities_matched INT DEFAULT 0,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- File-level idempotency: the same tenant uploading byte-identical
  -- content twice is recognized as a duplicate batch, not silently
  -- re-imported. A DIFFERENT tenant may upload the same bytes (e.g. a
  -- shared vendor template) without collision, per tenant-isolation.
  UNIQUE (user_id, file_content_hash)
);

CREATE INDEX IF NOT EXISTS idx_file_import_batches_user ON file_import_batches(user_id);
CREATE INDEX IF NOT EXISTS idx_file_import_batches_hash ON file_import_batches(file_content_hash);

-- No RLS policy changes, no defaults that fabricate data.
