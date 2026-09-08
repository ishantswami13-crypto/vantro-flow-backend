-- FILE: migrations/029_reality_acquisition_observations.sql
-- STARLANE — Reality Acquisition, Organizational Sensor Network & Context
-- Enrichment. Part 3 (Universal Observation Contract) + Part 36 (import
-- idempotency) + Part 37/38 (received_at vs event_time discipline).
--
-- Purely additive: one new table, no changes to any existing table/column.
-- Preserves provenance for every row a CSV/manual import writes into
-- purchase_line_items / product_suppliers (or any future ingested table),
-- independent of whether the import is REAL business data or a clearly
-- labeled SEEDED/demo import — the `source_quality` column is what makes
-- that distinction machine-checkable later, not a comment.

CREATE TABLE IF NOT EXISTS raw_observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  source_system TEXT NOT NULL,           -- e.g. 'csv_import'
  source_record_id TEXT,                 -- natural id from the source row, if any
  content_hash TEXT NOT NULL,            -- sha256 of normalized row content; used when no natural id exists
  entity_type TEXT NOT NULL,             -- 'purchase_line_item' | 'product_supplier' | ...
  observed_at TIMESTAMPTZ,               -- event_time: when the fact happened, per the source row
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(), -- knowledge_time: when Starlane learned it
  source_quality TEXT NOT NULL DEFAULT 'SEEDED', -- 'REAL' | 'SEEDED' — never inferred, set explicitly by the importer caller
  fields JSONB NOT NULL,                 -- the normalized {sourceField: value} payload actually imported
  raw_reference JSONB,                   -- the original raw row, verbatim, for audit
  ingestion_version TEXT NOT NULL DEFAULT 'csvImport.v1',
  resulting_table TEXT,                  -- table the observation was materialized into
  resulting_row_id TEXT,                 -- id of the row created/updated in resulting_table
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, source_system, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_raw_observations_user ON raw_observations(user_id);
CREATE INDEX IF NOT EXISTS idx_raw_observations_entity_type ON raw_observations(entity_type);
CREATE INDEX IF NOT EXISTS idx_raw_observations_source ON raw_observations(source_system, source_record_id);

-- No RLS changes, no defaults that fabricate data, no backfill INSERTs.
