-- 072_sales_reps.sql — Team dashboard: the people who own customer accounts.
--
-- An account (users.id) stays the tenant. A sales rep is a person on the
-- owner's sales or collections team (name, optional email and region). Each
-- customer is assigned to at most one rep by name, the same way Spaces
-- assigns customers to a company (071), so invoices follow their customer
-- without rewriting any synced row.
--
-- Additive only. Every row carries user_id and every route scopes by the
-- verified JWT's user id.

CREATE TABLE IF NOT EXISTS sales_reps (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  email       TEXT CHECK (email IS NULL OR (length(email) <= 200 AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  region      TEXT CHECK (region IS NULL OR length(btrim(region)) BETWEEN 1 AND 60),
  color       TEXT CHECK (color IS NULL OR color ~ '^#[0-9A-Fa-f]{6}$'),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_reps_user_name ON sales_reps(user_id, lower(name));
CREATE INDEX IF NOT EXISTS idx_sales_reps_user ON sales_reps(user_id);

CREATE TABLE IF NOT EXISTS sales_rep_customers (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rep_id      UUID NOT NULL REFERENCES sales_reps(id) ON DELETE CASCADE,
  name        TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- A customer has one rep at a time.
CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_rep_customers_name ON sales_rep_customers(user_id, lower(btrim(name)));
CREATE INDEX IF NOT EXISTS idx_sales_rep_customers_rep ON sales_rep_customers(rep_id);

COMMENT ON TABLE sales_reps IS 'People on the owner''s sales / collections team (Team dashboard). Tenant key is user_id.';
COMMENT ON TABLE sales_rep_customers IS 'Which rep owns each customer (by name). Invoices follow their customer.';
