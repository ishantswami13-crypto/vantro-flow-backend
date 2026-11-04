-- Repair legacy connector_sync_runs tables which existed before migration 051.
-- CREATE TABLE IF NOT EXISTS in 051 does not add columns to an existing table.
-- Production symptom: POST /connectors/device/sync-runs returns 503 because
-- device_id is absent. Preserve history, RLS and the migration ledger.
-- Unknown historical device/version values intentionally remain NULL.
ALTER TABLE connector_sync_runs
  ADD COLUMN IF NOT EXISTS device_id UUID REFERENCES connector_devices(id) ON DELETE SET NULL;
ALTER TABLE connector_sync_runs
  ADD COLUMN IF NOT EXISTS client_version TEXT;
