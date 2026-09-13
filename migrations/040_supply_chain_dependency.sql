-- FILE: migrations/040_supply_chain_dependency.sql
-- 2xA demo vertical slice — smallest additive schema needed to trace
-- SUPPLIER -> COMPONENT -> INVENTORY -> PRODUCT -> ORDER -> CUSTOMER -> REVENUE.
-- Safe to run multiple times (IF NOT EXISTS everywhere). No destructive
-- changes. Builds on the existing `products` (component AND finished-good
-- catalog — one table, self-referencing BOM) and `orders` tables rather
-- than inventing parallel ones.

-- ─── Bill of materials: which products are made of which other products ───
-- Self-referencing on `products` deliberately: this codebase already treats
-- `products` as the universal item catalog (products.current_stock is used
-- for both raw materials and finished goods elsewhere, e.g.
-- product_suppliers). A separate "components" table would duplicate that
-- catalog for no real gain.
CREATE TABLE IF NOT EXISTS product_components (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  finished_product_id   UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  component_product_id  UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  quantity_per_unit      NUMERIC NOT NULL DEFAULT 1,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT product_components_no_self_reference CHECK (finished_product_id <> component_product_id),
  CONSTRAINT product_components_unique UNIQUE (user_id, finished_product_id, component_product_id)
);
CREATE INDEX IF NOT EXISTS idx_product_components_user ON product_components(user_id);
CREATE INDEX IF NOT EXISTS idx_product_components_component ON product_components(component_product_id);
CREATE INDEX IF NOT EXISTS idx_product_components_finished ON product_components(finished_product_id);

-- ─── Order line items: which products a customer order actually needs ─────
-- `orders.items` is a JSONB blob today with no queryable product_id, so
-- "which open orders depend on component C" cannot be answered without
-- this. Mirrors the existing purchase_line_items pattern (migration 024) —
-- same shape, sell-side instead of buy-side.
CREATE TABLE IF NOT EXISTS order_line_items (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  order_id     UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id   UUID REFERENCES products(id) ON DELETE SET NULL,
  quantity     NUMERIC NOT NULL,
  unit_price   NUMERIC NOT NULL DEFAULT 0,
  needed_by    DATE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_order_line_items_user ON order_line_items(user_id);
CREATE INDEX IF NOT EXISTS idx_order_line_items_product ON order_line_items(product_id);
CREATE INDEX IF NOT EXISTS idx_order_line_items_order ON order_line_items(order_id);

-- ─── Supply-planning fields on products ────────────────────────────────────
-- `low_stock_alert` already exists but is a bare reorder trigger, not enough
-- for a stockout-date forecast (needs lead time) or an honest "is this an
-- observed or assumed number" distinction (needs a demand rate to compare
-- against). All nullable: absence must degrade to "insufficient data", never
-- a fabricated default.
ALTER TABLE products ADD COLUMN IF NOT EXISTS lead_time_days      INTEGER;
ALTER TABLE products ADD COLUMN IF NOT EXISTS safety_stock        NUMERIC;
ALTER TABLE products ADD COLUMN IF NOT EXISTS avg_daily_demand    NUMERIC;
ALTER TABLE products ADD COLUMN IF NOT EXISTS is_alternate_for_id UUID REFERENCES products(id);

COMMENT ON TABLE product_components IS '2xA demo: bill-of-materials, self-referencing on products.';
COMMENT ON TABLE order_line_items IS '2xA demo: per-product order lines, sell-side mirror of purchase_line_items.';
COMMENT ON COLUMN products.avg_daily_demand IS 'Owner-recorded or derived average daily consumption; NULL means insufficient data for coverage/stockout calculations — never assume a value.';
COMMENT ON COLUMN products.is_alternate_for_id IS 'If set, this product is a substitute/alternate source for the referenced product (e.g. same component from a different supplier).';
