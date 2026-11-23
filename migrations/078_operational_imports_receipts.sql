-- 078_operational_imports_receipts.sql
-- Real-data pilot for supplier-delay intelligence:
--   1. Customer order lines and inbound purchase lines imported from a
--      customer's own ERP / accounting / spreadsheet export, with stable
--      source identifiers so a repeat or newer export updates the same rows
--      instead of duplicating them.
--   2. Goods receipts recorded against a purchase line, one immutable row per
--      receipt, keyed by an idempotency key so a retry never books stock twice.
--
-- Additive only. Every new column is nullable or has a default that matches
-- what existing code already assumes, so readers that do not know about these
-- columns behave exactly as before:
--   * purchase_line_items.received_before_tracking DEFAULT 0 and
--     stock_follows DEFAULT 'STARLANE' reproduce today's reconcile behaviour
--     (every received unit on a tracked line is booked into stock once).
--   * order_line_items.unit_price loses NOT NULL so an imported line without a
--     price is stored as "price unknown" instead of a fabricated 0. Its default
--     stays 0, so existing inserts are unchanged.
-- Number 078 because 073-077 are taken by other open branches.

-- ── Provenance + identity on the operational tables ──────────────────────
ALTER TABLE orders ADD COLUMN IF NOT EXISTS source_system          TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS external_ref           TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_external_ref  TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS import_key             TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_user_import_key ON orders(user_id, import_key) WHERE import_key IS NOT NULL;

ALTER TABLE order_line_items ADD COLUMN IF NOT EXISTS source_system         TEXT;
ALTER TABLE order_line_items ADD COLUMN IF NOT EXISTS external_ref          TEXT;
ALTER TABLE order_line_items ADD COLUMN IF NOT EXISTS import_key            TEXT;
ALTER TABLE order_line_items ADD COLUMN IF NOT EXISTS sku_as_imported       TEXT;
ALTER TABLE order_line_items ADD COLUMN IF NOT EXISTS product_name_as_imported TEXT;
ALTER TABLE order_line_items ADD COLUMN IF NOT EXISTS outstanding_quantity  NUMERIC;
ALTER TABLE order_line_items ADD COLUMN IF NOT EXISTS currency              TEXT;
ALTER TABLE order_line_items ADD COLUMN IF NOT EXISTS line_status           TEXT;
ALTER TABLE order_line_items ADD COLUMN IF NOT EXISTS last_import_batch_id  UUID;
ALTER TABLE order_line_items ADD COLUMN IF NOT EXISTS source_updated_at     TIMESTAMPTZ;
ALTER TABLE order_line_items ALTER COLUMN unit_price DROP NOT NULL;
DO $$ BEGIN
  ALTER TABLE order_line_items ADD CONSTRAINT order_line_items_outstanding_nonneg CHECK (outstanding_quantity IS NULL OR outstanding_quantity >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE order_line_items ADD CONSTRAINT order_line_items_currency_iso CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_order_line_items_user_import_key ON order_line_items(user_id, import_key) WHERE import_key IS NOT NULL;

ALTER TABLE purchases ADD COLUMN IF NOT EXISTS source_system TEXT;
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS external_ref  TEXT;
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS import_key    TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_purchases_user_import_key ON purchases(user_id, import_key) WHERE import_key IS NOT NULL;

ALTER TABLE purchase_line_items ADD COLUMN IF NOT EXISTS source_system            TEXT;
ALTER TABLE purchase_line_items ADD COLUMN IF NOT EXISTS external_ref             TEXT;
ALTER TABLE purchase_line_items ADD COLUMN IF NOT EXISTS import_key               TEXT;
ALTER TABLE purchase_line_items ADD COLUMN IF NOT EXISTS sku_as_imported          TEXT;
ALTER TABLE purchase_line_items ADD COLUMN IF NOT EXISTS product_name_as_imported TEXT;
ALTER TABLE purchase_line_items ADD COLUMN IF NOT EXISTS line_status              TEXT;
ALTER TABLE purchase_line_items ADD COLUMN IF NOT EXISTS last_import_batch_id     UUID;
ALTER TABLE purchase_line_items ADD COLUMN IF NOT EXISTS source_updated_at        TIMESTAMPTZ;
-- Units the source system already showed as received when Starlane started
-- tracking the line. They are already in the business's stock count, so the
-- reconcile never books them again (lib/domain/inventory/stockLedger.js).
ALTER TABLE purchase_line_items ADD COLUMN IF NOT EXISTS received_before_tracking NUMERIC NOT NULL DEFAULT 0;
-- Who books received goods into stock: STARLANE (a receipt recorded here posts
-- a stock movement) or EXTERNAL (an accounting system such as Tally books the
-- stock when the purchase voucher syncs; a receipt here only reduces what is
-- outstanding). Prevents counting the same goods twice.
ALTER TABLE purchase_line_items ADD COLUMN IF NOT EXISTS stock_follows TEXT NOT NULL DEFAULT 'STARLANE';
DO $$ BEGIN
  ALTER TABLE purchase_line_items ADD CONSTRAINT purchase_line_items_stock_follows_check CHECK (stock_follows IN ('STARLANE', 'EXTERNAL'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE purchase_line_items ADD CONSTRAINT purchase_line_items_received_before_nonneg CHECK (received_before_tracking >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_purchase_line_items_user_import_key ON purchase_line_items(user_id, import_key) WHERE import_key IS NOT NULL;

-- ── Goods receipts ───────────────────────────────────────────────────────
-- One row per receipt or correction. Never updated or deleted by the app: a
-- mistaken receipt is reversed with a CORRECTION row (negative quantity), so
-- the history always shows what was recorded and when.
CREATE TABLE IF NOT EXISTS purchase_line_receipts (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purchase_line_id      UUID NOT NULL REFERENCES purchase_line_items(id) ON DELETE CASCADE,
  kind                  TEXT NOT NULL CHECK (kind IN ('RECEIPT', 'CORRECTION')),
  quantity              NUMERIC NOT NULL CHECK (quantity <> 0),
  received_on           DATE NOT NULL,
  reference             TEXT,
  notes                 TEXT,
  idempotency_key       TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  request_hash          TEXT NOT NULL,
  stock_posted          BOOLEAN NOT NULL,
  stock_movement_id     UUID REFERENCES stock_movements(id) ON DELETE SET NULL,
  received_before       NUMERIC NOT NULL,
  received_after        NUMERIC NOT NULL,
  ordered_quantity      NUMERIC NOT NULL,
  recorded_by           UUID,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT purchase_line_receipts_receipt_positive CHECK (kind <> 'RECEIPT' OR quantity > 0),
  CONSTRAINT purchase_line_receipts_after_nonneg CHECK (received_after >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_purchase_line_receipts_idem ON purchase_line_receipts(user_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_purchase_line_receipts_line ON purchase_line_receipts(purchase_line_id, created_at);
CREATE INDEX IF NOT EXISTS idx_purchase_line_receipts_user ON purchase_line_receipts(user_id, created_at DESC);

COMMENT ON TABLE purchase_line_receipts IS 'Goods received against a purchase line. Append-only; corrections are negative CORRECTION rows. Tenant key is user_id.';
COMMENT ON COLUMN purchase_line_items.stock_follows IS 'STARLANE: receipts recorded in Starlane post stock. EXTERNAL: an accounting system (e.g. Tally) books the stock; receipts only reduce outstanding.';
COMMENT ON COLUMN order_line_items.outstanding_quantity IS 'Quantity still to deliver, as reported by the source system. NULL = not reported; planning then uses the ordered quantity and says so.';
