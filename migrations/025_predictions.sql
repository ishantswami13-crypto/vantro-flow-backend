-- FILE: migrations/025_predictions.sql
-- STARLANE Forecasting Core — Part 2: Prediction registry.
-- Additive only. Every real forecast() call can persist one row here, and a
-- later resolution step fills actual_value/resolved_at/errors without ever
-- deleting or overwriting the original prediction row (model versioning /
-- audit trail requirement).

CREATE TABLE IF NOT EXISTS predictions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  entity_type TEXT NOT NULL,           -- e.g. 'tenant_cash', 'customer', 'invoice', 'product'
  entity_id TEXT,                      -- nullable: some targets (tenant-wide cash) have no single entity row
  target TEXT NOT NULL,                -- e.g. 'cash_position_30d', 'invoice_payment_date', 'sales_units_7d'
  prediction_type TEXT NOT NULL,       -- 'point' | 'interval' | 'window'
  as_of TIMESTAMPTZ NOT NULL,          -- the cutoff the prediction was made AT (never uses data after this)
  horizon_days INTEGER NOT NULL,
  point_estimate NUMERIC,
  lower_bound NUMERIC,
  upper_bound NUMERIC,
  model_name TEXT NOT NULL,
  model_version TEXT NOT NULL,
  baseline_model TEXT,
  context_snapshot_hash TEXT,
  assumptions JSONB DEFAULT '[]'::jsonb,
  evidence JSONB DEFAULT '[]'::jsonb,
  uncertainty_band TEXT,               -- reuses uncertainty.js bands: VERIFIED/STRONG/MODERATE/WEAK/INSUFFICIENT
  data_quality TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Resolution / evaluation (filled later, never overwritten — a new logic
  -- version creates a NEW row rather than mutating an old prediction's model
  -- fields; only these evaluation columns are ever updated post-creation).
  actual_value NUMERIC,
  resolved_at TIMESTAMPTZ,
  absolute_error NUMERIC,
  percentage_error NUMERIC,
  coverage_hit BOOLEAN,               -- did actual fall within [lower_bound, upper_bound]?
  evaluation_status TEXT NOT NULL DEFAULT 'PENDING'  -- PENDING | RESOLVED | INVALIDATED
);

CREATE INDEX IF NOT EXISTS idx_predictions_user_target ON predictions (user_id, target, as_of DESC);
CREATE INDEX IF NOT EXISTS idx_predictions_entity ON predictions (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_predictions_eval_status ON predictions (evaluation_status);
