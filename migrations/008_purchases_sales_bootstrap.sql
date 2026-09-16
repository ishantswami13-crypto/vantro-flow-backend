-- ============================================================
-- VANTRO STARLANE — Migration 008: purchases/sales bootstrap
-- ============================================================
-- "Close the Loop" mission, part B: fresh-database verification
-- (scripts/verify-fresh-database.js) found that migrations 009, 010, 011,
-- 012, 020, 022, and 024 all fail on a genuinely empty database with
-- "relation purchases/sales does not exist". Root cause, confirmed by
-- reading server.js directly: `purchases` and `sales` are created by
-- server.js's own inline runAutoMigrations() function at process startup,
-- never by any file in this migrations/ directory — this chain has never
-- been a complete, standalone bootstrap of this schema independent of the
-- app having run at least once first.
--
-- Fix: this migration creates the exact same `purchases`/`sales` shape
-- server.js's runAutoMigrations() creates (column-for-column, copied
-- deliberately rather than redesigned, so a database that already has these
-- tables from the old bootstrap path sees an idempotent no-op via
-- IF NOT EXISTS/ADD COLUMN IF NOT EXISTS — never a conflicting definition).
-- server.js's inline bootstrap is intentionally left in place, unmodified —
-- per this mission's explicit requirement, server startup must not be the
-- ONLY mechanism creating this schema, not that it must stop being A
-- mechanism. Both paths are idempotent and now agree byte-for-byte on shape,
-- so running both (migration chain, then app startup, or vice versa) is
-- always safe.
--
-- Scope is deliberately narrow: only `purchases` and `sales`, the two tables
-- fresh-database verification actually proved later migrations depend on.
-- suppliers/khata_entries/activity_logs/notifications are also created
-- inline by server.js but nothing in migrations/ was found to require them
-- pre-existing — copying them here without that evidence would be exactly
-- the "blind bootstrap copy" this mission explicitly warned against.
-- migration 000 (suppliers_and_party_fk) already independently replaces
-- server.js's BIGSERIAL suppliers with the UUID-keyed suppliers table this
-- chain actually needs, and runs before this file in migration order.

CREATE TABLE IF NOT EXISTS public.purchases (
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
CREATE INDEX IF NOT EXISTS idx_purchases_user ON public.purchases(user_id);
CREATE INDEX IF NOT EXISTS idx_purchases_status ON public.purchases(user_id, status);

CREATE TABLE IF NOT EXISTS public.sales (
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
CREATE INDEX IF NOT EXISTS idx_sales_user ON public.sales(user_id);
CREATE INDEX IF NOT EXISTS idx_sales_status ON public.sales(user_id, status);

-- Same columns server.js's inline bootstrap adds defensively to an
-- already-existing table — kept here too so a database seeded ONLY by this
-- migration chain (never having run the app) ends up with the identical
-- shape as one seeded by the app, byte-for-byte.
ALTER TABLE public.purchases ADD COLUMN IF NOT EXISTS bill_number    TEXT;
ALTER TABLE public.purchases ADD COLUMN IF NOT EXISTS supplier_phone TEXT;
ALTER TABLE public.purchases ADD COLUMN IF NOT EXISTS description    TEXT;
ALTER TABLE public.purchases ADD COLUMN IF NOT EXISTS supplier_gstin TEXT;
ALTER TABLE public.purchases ADD COLUMN IF NOT EXISTS items          JSONB;
ALTER TABLE public.purchases ADD COLUMN IF NOT EXISTS gst_type       TEXT;
ALTER TABLE public.purchases ADD COLUMN IF NOT EXISTS gst_rate       NUMERIC(6,2);
ALTER TABLE public.purchases ADD COLUMN IF NOT EXISTS gst_amount     NUMERIC(14,2);
ALTER TABLE public.purchases ADD COLUMN IF NOT EXISTS cgst_amount    NUMERIC(14,2);
ALTER TABLE public.purchases ADD COLUMN IF NOT EXISTS sgst_amount    NUMERIC(14,2);
ALTER TABLE public.purchases ADD COLUMN IF NOT EXISTS igst_amount    NUMERIC(14,2);
ALTER TABLE public.purchases ADD COLUMN IF NOT EXISTS subtotal       NUMERIC(14,2);

ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS customer_phone TEXT;
ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS customer_gstin TEXT;
ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS invoice_number TEXT;
ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS items          JSONB;
ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS gst_type       TEXT;
ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS gst_rate       NUMERIC(6,2);
ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS gst_amount     NUMERIC(14,2);
ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS cgst_amount    NUMERIC(14,2);
ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS sgst_amount    NUMERIC(14,2);
ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS igst_amount    NUMERIC(14,2);
ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS subtotal       NUMERIC(14,2);
