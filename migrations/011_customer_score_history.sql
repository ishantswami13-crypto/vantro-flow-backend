-- Customer risk score history.
-- Additive and idempotent: preserves the temporal evidence used by
-- credit-risk, receivables-risk, and revenue-intelligence modules.
CREATE TABLE IF NOT EXISTS customer_score_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  credit_risk_score NUMERIC NOT NULL,
  promise_reliability_score NUMERIC NOT NULL,
  broken_promise_count INTEGER NOT NULL DEFAULT 0,
  collection_priority_score NUMERIC NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_customer_score_history_user_customer
  ON customer_score_history(user_id, customer_id, recorded_at DESC);
