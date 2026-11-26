-- 093_analytics_cube.sql
-- L4 analytics (lib/data/analytics): two fact tables the cube API slices by
-- time, customer, currency and status.
--
--   fact_invoices             one row per invoice (accumulating snapshot):
--                             invoiced, collected, outstanding, days to pay,
--                             days late. Rebuilt per tenant from invoices.
--   fact_receivables_daily    one row per tenant, customer, currency and day
--                             (periodic snapshot of rm_receivables_customer):
--                             history of open and overdue amounts, which the
--                             invoices table cannot answer once things are paid.
--                             Range-partitioned by month.
--
-- Both are derived; fact_receivables_daily is the only one that cannot be
-- rebuilt for past days, because it records how things stood on each day.
--
-- Additive and idempotent. Rollback:
--   DROP TABLE IF EXISTS fact_receivables_daily, fact_snapshot_days, fact_invoices;
--   DROP FUNCTION IF EXISTS starlane_ensure_month_partition(date);
--   DROP FUNCTION IF EXISTS starlane_lock_down_table(text);

CREATE TABLE IF NOT EXISTS fact_invoices (
  user_id        UUID NOT NULL,
  invoice_id     UUID NOT NULL,
  customer_key   TEXT NOT NULL,
  customer_name  TEXT NOT NULL,
  currency       TEXT NOT NULL DEFAULT '',
  status_group   TEXT NOT NULL CHECK (status_group IN ('open', 'paid', 'cancelled')),
  invoice_date   DATE,
  due_date       DATE,
  paid_date      DATE,
  amount         NUMERIC NOT NULL DEFAULT 0,
  paid_amount    NUMERIC NOT NULL DEFAULT 0,
  open_amount    NUMERIC NOT NULL DEFAULT 0,
  days_to_pay    INTEGER,
  days_late      INTEGER,
  loaded_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, invoice_id)
);
CREATE INDEX IF NOT EXISTS idx_fact_invoices_tenant_date ON fact_invoices (user_id, invoice_date);
CREATE INDEX IF NOT EXISTS idx_fact_invoices_tenant_customer ON fact_invoices (user_id, customer_key);

CREATE TABLE IF NOT EXISTS fact_receivables_daily (
  user_id           UUID NOT NULL,
  snapshot_date     DATE NOT NULL,
  customer_key      TEXT NOT NULL,
  currency          TEXT NOT NULL DEFAULT '',
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
  max_days_overdue  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, snapshot_date, customer_key, currency)
) PARTITION BY RANGE (snapshot_date);

-- Which days have a snapshot, per tenant. A day with nothing open has no fact
-- rows, so this is how the cube tells "zero that day" from "no snapshot".
CREATE TABLE IF NOT EXISTS fact_snapshot_days (
  user_id        UUID NOT NULL,
  snapshot_date  DATE NOT NULL,
  PRIMARY KEY (user_id, snapshot_date)
);

-- Catches any day without a monthly partition, so a snapshot never fails.
CREATE TABLE IF NOT EXISTS fact_receivables_daily_default PARTITION OF fact_receivables_daily DEFAULT;

-- RLS on with no policy, and no grants for the PostgREST roles: server-side only.
CREATE OR REPLACE FUNCTION starlane_lock_down_table(t text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE format('REVOKE ALL ON %I FROM anon', t);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE format('REVOKE ALL ON %I FROM authenticated', t);
  END IF;
END $$;

-- Creates the month's partition if missing. Called by the loader before it
-- writes. Old months can later be detached and archived without touching the
-- rest of the table.
CREATE OR REPLACE FUNCTION starlane_ensure_month_partition(d date) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  start_d date := date_trunc('month', d)::date;
  end_d   date := (date_trunc('month', d) + interval '1 month')::date;
  part    text := 'fact_receivables_daily_' || to_char(start_d, 'YYYYMM');
BEGIN
  IF to_regclass(part) IS NOT NULL THEN RETURN part; END IF;
  -- Two loaders creating the same month at once would collide.
  PERFORM pg_advisory_xact_lock(hashtext('starlane_ensure_month_partition'));
  IF to_regclass(part) IS NULL THEN
    -- Rows for this month that landed in the default partition must move first,
    -- or attaching the new partition fails.
    IF EXISTS (SELECT 1 FROM fact_receivables_daily_default WHERE snapshot_date >= start_d AND snapshot_date < end_d) THEN
      EXECUTE format('CREATE TABLE %I (LIKE fact_receivables_daily INCLUDING DEFAULTS)', part);
      EXECUTE format('INSERT INTO %I SELECT * FROM fact_receivables_daily_default WHERE snapshot_date >= %L AND snapshot_date < %L', part, start_d, end_d);
      DELETE FROM fact_receivables_daily_default WHERE snapshot_date >= start_d AND snapshot_date < end_d;
      EXECUTE format('ALTER TABLE fact_receivables_daily ATTACH PARTITION %I FOR VALUES FROM (%L) TO (%L)', part, start_d, end_d);
    ELSE
      EXECUTE format('CREATE TABLE %I PARTITION OF fact_receivables_daily FOR VALUES FROM (%L) TO (%L)', part, start_d, end_d);
    END IF;
    -- A partition is a table of its own. On Supabase, new tables are granted to
    -- the API roles by default, so lock each one down like its parent.
    PERFORM starlane_lock_down_table(part);
  END IF;
  RETURN part;
END $$;

SELECT starlane_lock_down_table('fact_invoices');
SELECT starlane_lock_down_table('fact_receivables_daily');
SELECT starlane_lock_down_table('fact_receivables_daily_default');
SELECT starlane_lock_down_table('fact_snapshot_days');
