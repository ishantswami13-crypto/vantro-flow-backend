-- 092_read_models.sql
-- L3 read models (lib/data/readModels): receivables precomputed per tenant and
-- per customer, so Home and the customer list read a few rows instead of
-- scanning every invoice on each request.
--
-- These tables are derived. They can be emptied and rebuilt from invoices at
-- any time (npm run data:rebuild). Nothing writes to them except the refresh
-- code, and nothing treats them as a source of truth.
--
-- Additive and idempotent. Rollback:
--   DROP TABLE IF EXISTS rm_receivables_customer, rm_receivables_tenant, rm_refresh_state;
--   DROP FUNCTION IF EXISTS starlane_try_date(text);

-- invoices.due_date / payment_date are TEXT. Read the leading YYYY-MM-DD and
-- return NULL for anything that is not a real calendar date, instead of failing
-- the whole refresh on one bad row.
CREATE OR REPLACE FUNCTION starlane_try_date(v text) RETURNS date
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF v IS NULL OR v !~ '^\s*\d{4}-\d{2}-\d{2}' THEN RETURN NULL; END IF;
  RETURN substring(btrim(v) from 1 for 10)::date;
EXCEPTION WHEN others THEN
  RETURN NULL;
END $$;

-- One row per tenant and currency. currency '' = the account's base currency
-- (invoices with no currency set).
CREATE TABLE IF NOT EXISTS rm_receivables_tenant (
  user_id           UUID NOT NULL,
  currency          TEXT NOT NULL DEFAULT '',
  open_amount       NUMERIC NOT NULL DEFAULT 0,
  overdue_amount    NUMERIC NOT NULL DEFAULT 0,
  bucket_current    NUMERIC NOT NULL DEFAULT 0,
  bucket_1_30       NUMERIC NOT NULL DEFAULT 0,
  bucket_31_60      NUMERIC NOT NULL DEFAULT 0,
  bucket_61_90      NUMERIC NOT NULL DEFAULT 0,
  bucket_90_plus    NUMERIC NOT NULL DEFAULT 0,
  open_invoices     INTEGER NOT NULL DEFAULT 0,
  overdue_invoices  INTEGER NOT NULL DEFAULT 0,
  customers_open    INTEGER NOT NULL DEFAULT 0,
  customers_overdue INTEGER NOT NULL DEFAULT 0,
  undated_invoices  INTEGER NOT NULL DEFAULT 0,
  as_of             DATE NOT NULL,
  refreshed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, currency)
);

-- One row per tenant, customer and currency.
CREATE TABLE IF NOT EXISTS rm_receivables_customer (
  user_id           UUID NOT NULL,
  customer_key      TEXT NOT NULL,
  currency          TEXT NOT NULL DEFAULT '',
  customer_id       UUID,
  customer_name     TEXT NOT NULL,
  open_amount       NUMERIC NOT NULL DEFAULT 0,
  overdue_amount    NUMERIC NOT NULL DEFAULT 0,
  bucket_current    NUMERIC NOT NULL DEFAULT 0,
  bucket_1_30       NUMERIC NOT NULL DEFAULT 0,
  bucket_31_60      NUMERIC NOT NULL DEFAULT 0,
  bucket_61_90      NUMERIC NOT NULL DEFAULT 0,
  bucket_90_plus    NUMERIC NOT NULL DEFAULT 0,
  open_invoices     INTEGER NOT NULL DEFAULT 0,
  overdue_invoices  INTEGER NOT NULL DEFAULT 0,
  oldest_due_date   DATE,
  max_days_overdue  INTEGER NOT NULL DEFAULT 0,
  last_payment_date DATE,
  as_of             DATE NOT NULL,
  refreshed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, customer_key, currency)
);
CREATE INDEX IF NOT EXISTS idx_rm_recv_customer_overdue ON rm_receivables_customer (user_id, overdue_amount DESC);

-- What each read model was last built from, per tenant: a fingerprint of the
-- tenant's invoice rows and their row count, and the as-of date, so ageing
-- rolls over at midnight. The fingerprint is an order-independent sum over
-- md5(id, xmin): every INSERT, UPDATE or DELETE changes it, including updates
-- that do not touch updated_at (invoices has no updated_at trigger).
CREATE TABLE IF NOT EXISTS rm_refresh_state (
  user_id           UUID NOT NULL,
  model             TEXT NOT NULL,
  source_fingerprint TEXT,
  source_rows       BIGINT NOT NULL DEFAULT 0,
  as_of             DATE NOT NULL,
  refreshed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  duration_ms       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, model)
);

ALTER TABLE rm_receivables_tenant   ENABLE ROW LEVEL SECURITY;
ALTER TABLE rm_receivables_customer ENABLE ROW LEVEL SECURITY;
ALTER TABLE rm_refresh_state        ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON rm_receivables_tenant, rm_receivables_customer, rm_refresh_state FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON rm_receivables_tenant, rm_receivables_customer, rm_refresh_state FROM authenticated';
  END IF;
END $$;
