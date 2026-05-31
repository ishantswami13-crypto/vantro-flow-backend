-- db/supabase-staging-base.sql
-- Minimal FK-target tables for running Cortex migrations on a fresh Supabase project.
-- DO NOT apply to Railway Postgres (use db/sqlx-test-schema.sql there).
-- Only creates tables that migrations 001-005 reference as FK targets.
-- Does NOT create ai_actions, promises, customers, customer_scores — migration 001 does.

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT UNIQUE NOT NULL,
  name          TEXT,
  password      TEXT,
  phone         TEXT,
  business_name TEXT,
  plan          TEXT DEFAULT 'free',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Stub for ai_actions.supplier_id FK target
CREATE TABLE IF NOT EXISTS suppliers (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- invoices: FK target for promises.receivable_id and followups.receivable_id in migration 001
-- Also used by Rust dashboard/collections bootstrap queries and perf seed
CREATE TABLE IF NOT EXISTS invoices (
  id             UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invoice_amount NUMERIC NOT NULL DEFAULT 0,
  total_amount   NUMERIC,
  amount_paid    NUMERIC,
  payment_status TEXT    NOT NULL DEFAULT 'Pending',
  days_overdue   INTEGER NOT NULL DEFAULT 0,
  due_date       TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- purchases: used by Rust dashboard_bootstrap and perf seed
CREATE TABLE IF NOT EXISTS purchases (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount     NUMERIC DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- products: used by Rust dashboard_bootstrap low-stock query and perf seed
CREATE TABLE IF NOT EXISTS products (
  id              UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT    NOT NULL,
  current_stock   NUMERIC NOT NULL DEFAULT 0,
  low_stock_alert NUMERIC,
  reorder_level   NUMERIC,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- call_logs: used by Rust customer_metrics CTE and perf seed
CREATE TABLE IF NOT EXISTS call_logs (
  id          UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  did_pick_up BOOLEAN,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
