-- Complete the sync-run schema used by the Tally connector lifecycle.
-- Older production tables may predate these result fields; keep the repair
-- additive so existing sync history and row-level security remain intact.
ALTER TABLE connector_sync_runs
  ADD COLUMN IF NOT EXISTS records_imported INTEGER NOT NULL DEFAULT 0;
ALTER TABLE connector_sync_runs
  ADD COLUMN IF NOT EXISTS records_rejected INTEGER NOT NULL DEFAULT 0;
ALTER TABLE connector_sync_runs
  ADD COLUMN IF NOT EXISTS error TEXT;
