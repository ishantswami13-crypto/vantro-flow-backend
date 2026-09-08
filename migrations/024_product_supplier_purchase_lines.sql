-- FILE: migrations/024_product_supplier_purchase_lines.sql
-- STARLANE Day 3 — Part 7: Inventory/supplier data foundation.
--
-- Audit finding (direct information_schema query against the real local dev
-- DATABASE_URL, 2026-09-08): products has NO supplier_id column;
-- purchases.items and purchase_orders.items are unstructured JSONB and are
-- 100% NULL/empty across every real row in this database (purchase_orders
-- has zero rows at all). There is currently NO real way to know which
-- products come from which suppliers, or what line items make up a purchase.
--
-- This migration adds two new, purely additive, nullable tables to
-- REPRESENT that relationship once real data exists. It does NOT backfill
-- any historical data (there is none to honestly backfill) and does NOT
-- touch any existing table/column. Both tables are empty immediately after
-- this migration — any capability built on top of them (e.g. stockout
-- projection) must report NOT IMPLEMENTED / DATA MISSING until real rows
-- are actually inserted by real purchasing/receiving activity.

CREATE TABLE IF NOT EXISTS product_suppliers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  evidence TEXT, -- how this relationship was established (e.g. 'manually linked', 'inferred from purchase line item <id>')
  source TEXT,   -- e.g. 'manual', 'purchase_line_item'
  first_seen_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, product_id, supplier_id)
);

CREATE INDEX IF NOT EXISTS idx_product_suppliers_user ON product_suppliers(user_id);
CREATE INDEX IF NOT EXISTS idx_product_suppliers_product ON product_suppliers(product_id);
CREATE INDEX IF NOT EXISTS idx_product_suppliers_supplier ON product_suppliers(supplier_id);

CREATE TABLE IF NOT EXISTS purchase_line_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  purchase_id BIGINT NOT NULL REFERENCES purchases(id) ON DELETE CASCADE, -- purchases.id is bigint, not uuid, per real schema audit
  product_id UUID REFERENCES products(id) ON DELETE SET NULL, -- nullable: a real line item may not yet be matched to a product row
  quantity NUMERIC,
  unit_price NUMERIC,
  currency TEXT,
  expected_at TIMESTAMPTZ,
  received_quantity NUMERIC,
  received_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_purchase_line_items_user ON purchase_line_items(user_id);
CREATE INDEX IF NOT EXISTS idx_purchase_line_items_purchase ON purchase_line_items(purchase_id);
CREATE INDEX IF NOT EXISTS idx_purchase_line_items_product ON purchase_line_items(product_id);

-- No RLS policy changes, no defaults that fabricate data, no backfill INSERTs.
-- These tables are intentionally empty after this migration.
