-- Migration 022: Entity geographic/currency context (Global Context, Part B)
--
-- ADDITIVE ONLY. Every column is nullable, added via ADD COLUMN IF NOT
-- EXISTS, with NO backfill and NO inference/guessing. Existing rows get
-- NULL, meaning "unknown" -- never a default of 'IN'/'INR'. Part C's test
-- suite asserts this directly against the real database.

ALTER TABLE customers ADD COLUMN IF NOT EXISTS country TEXT;   -- ISO 3166-1 alpha-2
ALTER TABLE customers ADD COLUMN IF NOT EXISTS currency TEXT;  -- ISO 4217

ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS country TEXT;   -- ISO 3166-1 alpha-2
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS currency TEXT;  -- ISO 4217

-- purchases/sales/invoices had no currency column at all prior to this
-- migration (confirmed via information_schema.columns query against the
-- real DB before writing this file). Transaction currency, once known, is
-- preserved distinctly from the (already-existing, India-oriented) numeric
-- amount columns -- it is never used to convert/normalize those amounts.
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS currency TEXT;  -- ISO 4217
ALTER TABLE sales ADD COLUMN IF NOT EXISTS currency TEXT;      -- ISO 4217
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS currency TEXT;   -- ISO 4217

COMMENT ON COLUMN customers.country IS 'ISO 3166-1 alpha-2. NULL = unknown. Never inferred from name/address/GSTIN by this migration.';
COMMENT ON COLUMN customers.currency IS 'ISO 4217. NULL = unknown.';
COMMENT ON COLUMN suppliers.country IS 'ISO 3166-1 alpha-2. NULL = unknown. Never inferred from name/address/GSTIN by this migration.';
COMMENT ON COLUMN suppliers.currency IS 'ISO 4217. NULL = unknown.';
COMMENT ON COLUMN purchases.currency IS 'ISO 4217. NULL = unknown transaction currency (NOT assumed INR).';
COMMENT ON COLUMN sales.currency IS 'ISO 4217. NULL = unknown transaction currency (NOT assumed INR).';
COMMENT ON COLUMN invoices.currency IS 'ISO 4217. NULL = unknown transaction currency (NOT assumed INR).';
