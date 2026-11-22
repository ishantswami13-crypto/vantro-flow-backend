-- 072_shipment_delays.sql
-- Supplier-delay workflow: lets an inbound purchase line record that its
-- expected date moved, without losing the date the business was relying on.
--
-- Additive and idempotent: three nullable columns, no backfill, no default
-- that invents data. `expected_at` stays the single "current best estimate"
-- every existing reader already uses; `original_expected_at` is written once,
-- the first time a delay is reported, and never overwritten after that.
-- Nothing reads these columns until a delay is reported.

ALTER TABLE purchase_line_items ADD COLUMN IF NOT EXISTS original_expected_at TIMESTAMPTZ;
ALTER TABLE purchase_line_items ADD COLUMN IF NOT EXISTS delay_reported_at    TIMESTAMPTZ;
ALTER TABLE purchase_line_items ADD COLUMN IF NOT EXISTS delay_reason         TEXT;

CREATE INDEX IF NOT EXISTS idx_purchase_line_items_delayed
  ON purchase_line_items(user_id)
  WHERE original_expected_at IS NOT NULL;

COMMENT ON COLUMN purchase_line_items.original_expected_at IS 'Expected date before the first reported delay. NULL = never delayed.';
COMMENT ON COLUMN purchase_line_items.delay_reported_at IS 'When the most recent delay for this line was reported to Starlane.';
COMMENT ON COLUMN purchase_line_items.delay_reason IS 'Reason given for the most recent delay (free text from the owner or supplier).';
