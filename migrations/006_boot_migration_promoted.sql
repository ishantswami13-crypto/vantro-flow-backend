-- migrations/006_boot_migration_promoted.sql
--
-- Promotes the DDL that used to live only inside runAutoMigrations() in
-- server.js, which runs at process boot but only when DATABASE_URL is set —
-- a variable separate from the SUPABASE_* ones the rest of the app runs on.
-- npm run security:schema-drift reported khata_entries, purchases, sales,
-- inventory, purchase_orders and notifications as existing "only when
-- DATABASE_URL is set", covering 46 query call sites between them; on a
-- deployment that never set it, those tables and columns never existed and
-- the affected endpoints returned a generic 500.
--
-- runAutoMigrations() itself is left in place rather than removed: it is
-- still the only thing patching a long-running deployment that was started
-- before this file existed and has not re-run setup:database since. Running
-- both is safe — every statement here is CREATE TABLE/COLUMN IF NOT EXISTS,
-- nothing destructive, so whichever runs second is a no-op.
--
-- Depends on customers and ai_actions (migrations/001_cortex_foundation.sql),
-- so this file must run after it — placed last in SQL_FILES.

-- ── khata_entries ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS khata_entries (
  id             BIGSERIAL PRIMARY KEY,
  user_id        UUID NOT NULL,
  customer_name  TEXT NOT NULL,
  customer_phone TEXT,
  type           TEXT NOT NULL,
  amount         NUMERIC(14,2) NOT NULL DEFAULT 0,
  payment_mode   TEXT DEFAULT 'cash',
  notes          TEXT,
  entry_date     DATE DEFAULT CURRENT_DATE,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_khata_user ON khata_entries(user_id);
CREATE INDEX IF NOT EXISTS idx_khata_customer ON khata_entries(user_id, customer_name);

-- ── purchases ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS purchases (
  id             BIGSERIAL PRIMARY KEY,
  user_id        UUID        NOT NULL,
  supplier_name  TEXT        NOT NULL,
  amount         NUMERIC(14,2) NOT NULL DEFAULT 0,
  paid_amount    NUMERIC(14,2) NOT NULL DEFAULT 0,
  status         TEXT        NOT NULL DEFAULT 'unpaid',
  purchase_date  DATE        NOT NULL DEFAULT CURRENT_DATE,
  due_date       DATE,
  notes          TEXT,
  description    TEXT,
  category       TEXT        DEFAULT 'material',
  supplier_gstin TEXT,
  bill_number    TEXT,
  supplier_phone TEXT,
  items          JSONB,
  gst_type       TEXT,
  gst_rate       NUMERIC(6,2),
  gst_amount     NUMERIC(14,2),
  cgst_amount    NUMERIC(14,2),
  sgst_amount    NUMERIC(14,2),
  igst_amount    NUMERIC(14,2),
  subtotal       NUMERIC(14,2),
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_purchases_user ON purchases(user_id);
CREATE INDEX IF NOT EXISTS idx_purchases_status ON purchases(user_id, status);

-- ── sales ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sales (
  id              BIGSERIAL PRIMARY KEY,
  user_id         UUID NOT NULL,
  customer_name   TEXT NOT NULL,
  amount          NUMERIC(14,2) NOT NULL DEFAULT 0,
  paid_amount     NUMERIC(14,2) NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'unpaid',
  sale_date       DATE NOT NULL DEFAULT CURRENT_DATE,
  due_date        DATE,
  notes           TEXT,
  customer_phone  TEXT,
  customer_gstin  TEXT,
  invoice_number  TEXT,
  items           JSONB,
  gst_type        TEXT,
  gst_rate        NUMERIC(6,2),
  gst_amount      NUMERIC(14,2),
  cgst_amount     NUMERIC(14,2),
  sgst_amount     NUMERIC(14,2),
  igst_amount     NUMERIC(14,2),
  subtotal        NUMERIC(14,2),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sales_user ON sales(user_id);
CREATE INDEX IF NOT EXISTS idx_sales_status ON sales(user_id, status);

-- ── invoices: automation + creation fields ──────────────────────────────
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS snooze_until       TIMESTAMPTZ;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS last_reminder_sent TIMESTAMPTZ;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS reminder_count     INTEGER DEFAULT 0;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_link       TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_link_id    TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS invoice_number     TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS due_date           DATE;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS items              JSONB;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS notes              TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS customer_email     TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS customer_gstin     TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS source_type        TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS source_id          TEXT;

CREATE INDEX IF NOT EXISTS idx_inv_snooze        ON invoices(snooze_until)        WHERE snooze_until IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_inv_user_status   ON invoices(user_id, payment_status);
CREATE INDEX IF NOT EXISTS idx_inv_phone         ON invoices(customer_phone)      WHERE customer_phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_inv_source        ON invoices(user_id, source_type, source_id) WHERE source_type IS NOT NULL;

-- ── suppliers: purchase sync field ──────────────────────────────────────
-- suppliers itself is created in supabase-schema.sql; this column was only
-- ever added by the DATABASE_URL-gated path.
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS gstin TEXT;

-- ── bank_transactions: reconciliation metadata ──────────────────────────
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'manual';
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS match_confidence NUMERIC(4,3);
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS match_method TEXT;

-- ── inventory: supplier linkage for auto-PO drafting ────────────────────
CREATE TABLE IF NOT EXISTS inventory (
  id             BIGSERIAL PRIMARY KEY,
  user_id        UUID NOT NULL,
  item_name      TEXT NOT NULL,
  quantity       NUMERIC(14,2) NOT NULL DEFAULT 0,
  reorder_level  NUMERIC(14,2) DEFAULT 0,
  unit           TEXT DEFAULT 'units',
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS supplier_name  TEXT;
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS supplier_phone TEXT;
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS default_order_qty NUMERIC(14,2);
CREATE INDEX IF NOT EXISTS idx_inventory_user ON inventory(user_id);

-- ── purchase_orders: drafts awaiting supplier confirmation ──────────────
-- Distinct from purchases, which records completed/paid purchases.
-- status: draft -> sent -> confirmed / declined / expired.
CREATE TABLE IF NOT EXISTS purchase_orders (
  id                    BIGSERIAL PRIMARY KEY,
  user_id               UUID NOT NULL,
  supplier_name         TEXT NOT NULL,
  supplier_phone        TEXT,
  items                 JSONB NOT NULL DEFAULT '[]',
  estimated_amount      NUMERIC(14,2),
  status                TEXT NOT NULL DEFAULT 'draft',
  related_ai_action_id  UUID,
  sent_at               TIMESTAMPTZ,
  created_at            TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_user ON purchase_orders(user_id);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_status ON purchase_orders(user_id, status);

-- ── customers: per-customer escalation pause (closing-the-loop guardrail) ──
ALTER TABLE customers ADD COLUMN IF NOT EXISTS escalation_paused BOOLEAN DEFAULT FALSE;

-- ── ai_actions: one-tap approval token bookkeeping ──────────────────────
ALTER TABLE ai_actions ADD COLUMN IF NOT EXISTS approval_token_hash TEXT;
ALTER TABLE ai_actions ADD COLUMN IF NOT EXISTS approval_expires_at TIMESTAMPTZ;
ALTER TABLE ai_actions ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ;

-- ── notifications ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  message     TEXT NOT NULL,
  read        BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(user_id, created_at DESC);

-- ── prospect_notes ────────────────────────────────────────────────────────
-- Not from runAutoMigrations() — this one is only created by the admin-only,
-- DATABASE_URL-gated POST /api/migrate endpoint, which nothing calls
-- automatically. prospects itself is already in supabase-schema.sql; only its
-- notes child table was missing everywhere setup:database actually runs.
CREATE TABLE IF NOT EXISTS prospect_notes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id UUID NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  text        TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_prospect_notes_prospect_id ON prospect_notes(prospect_id);

-- users.phone_verified/email_verified were already promoted to
-- supabase-schema.sql in an earlier change; not repeated here.
