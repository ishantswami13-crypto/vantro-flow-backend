-- ============================================================
-- Migration 004: Schema Repair — missing columns on invoices + activity_logs
-- Applied to Supabase production on 2026-05-29.
-- Non-destructive — ADD COLUMN IF NOT EXISTS throughout.
-- ============================================================

-- ─── invoices: add Cortex-required columns ───────────────────
-- The pre-Cortex invoices table was missing columns that
-- syncReceivableFromSale() and deleteReceivableForSale() need.
-- Without these, all credit sale → receivable sync calls silently failed.
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS invoice_number      TEXT,
  ADD COLUMN IF NOT EXISTS source_type         TEXT,    -- 'sales' | 'manual' | 'import'
  ADD COLUMN IF NOT EXISTS source_id           TEXT,    -- FK to sales.id (as string)
  ADD COLUMN IF NOT EXISTS notes               TEXT,
  ADD COLUMN IF NOT EXISTS items               JSONB,
  ADD COLUMN IF NOT EXISTS customer_gstin      TEXT,
  ADD COLUMN IF NOT EXISTS last_reminder_sent  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reminder_count      INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS payment_link        TEXT;

CREATE INDEX IF NOT EXISTS idx_invoices_source
  ON invoices(user_id, source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_invoices_invoice_number
  ON invoices(user_id, invoice_number);

-- ─── activity_logs: create table ─────────────────────────────
-- createActivityLog() in server.js has always written to this table.
-- The table was missing from production — all writes silently failed.
CREATE TABLE IF NOT EXISTS activity_logs (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
  action     TEXT NOT NULL,
  metadata   JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_activity_logs_user
  ON activity_logs(user_id, created_at DESC);
ALTER TABLE activity_logs DISABLE ROW LEVEL SECURITY;

SELECT 'Migration 004_schema_repair complete' AS status;
