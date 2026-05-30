-- =============================================================================
-- db/sqlx-test-schema.sql
-- SQLx compile-time validation schema -- CI only, NOT a production migration.
-- =============================================================================
--
-- Purpose
-- -------
-- cargo sqlx prepare --workspace needs a live Postgres connection to introspect
-- table/column types and validate every sqlx::query! macro at compile time.
-- This file creates the minimal set of tables and columns required by
-- vantro-automation-rs/src/db/queries.rs so the ephemeral Postgres instance
-- in GitHub Actions satisfies that introspection.
--
-- What this file IS:
--   - A safe, minimal DDL for CI SQLx validation.
--   - Applied once to an ephemeral postgres:16 container that is destroyed
--     after the CI job.
--   - The source of truth for the column types that Rust sqlx macros resolve
--     against.
--
-- What this file IS NOT:
--   - A production migration.  Production schema is managed through
--     supabase-schema.sql and migrations/001-006_*.sql applied via Supabase.
--   - A complete copy of the production schema.  Only the tables and columns
--     referenced by vantro-automation-rs/src/db/queries.rs are included.
--   - Authoritative for RLS, indexes, triggers, or FK cascade rules.
--
-- Maintenance
-- -----------
-- If a new sqlx::query! macro is added to queries.rs that references a column
-- not listed here, `cargo sqlx prepare` will fail in CI with a clear error
-- naming the missing table/column.  Add the column here and re-run the
-- sqlx-validation workflow to regenerate .sqlx/ offline cache.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- users  -- required as a FK target for all other tables
-- ---------------------------------------------------------------------------
CREATE TABLE users (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email      TEXT UNIQUE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- customers  -- core entity; FK target for invoices, promises, call_logs
--
-- Columns sourced from:
--   migrations/001_cortex_foundation.sql  (base table)
--   migrations/005_cortex_x_extensions.sql (credit_limit, advance_required)
--
-- Rust query usage:
--   customer_metrics CTE  →  credit_limit, advance_required, name
-- ---------------------------------------------------------------------------
CREATE TABLE customers (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name             TEXT NOT NULL,
    phone            TEXT,
    credit_limit     NUMERIC    NOT NULL DEFAULT 0,
    advance_required BOOLEAN    NOT NULL DEFAULT FALSE,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- invoices  -- used by dashboard_bootstrap, collections_bootstrap,
--             and the customer_metrics CTE
--
-- Columns sourced from:
--   supabase-schema.sql       (invoice_amount, payment_status, days_overdue,
--                              due_date, created_at)
--   queries.rs COALESCE usage (total_amount -- optional, may be NULL)
--   queries.rs COALESCE usage (amount_paid  -- optional, may be NULL)
--   customer FK               (customer_id  -- added in production by
--                              migrations/001_cortex_foundation.sql)
--
-- Type notes:
--   total_amount   NUMERIC NULL -- COALESCE(total_amount, invoice_amount, 0)
--   amount_paid    NUMERIC NULL -- COALESCE(... - COALESCE(amount_paid, 0) ...)
--   due_date       TEXT         -- stored as ISO string in production DB
--   payment_status TEXT         -- 'Pending' | 'Overdue' | 'Paid' | 'Partial'
--   days_overdue   INTEGER      -- computed / synced by application layer
-- ---------------------------------------------------------------------------
CREATE TABLE invoices (
    id             UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        UUID    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    customer_id    UUID    REFERENCES customers(id) ON DELETE SET NULL,
    invoice_amount NUMERIC NOT NULL DEFAULT 0,
    total_amount   NUMERIC,                        -- nullable; see COALESCE
    amount_paid    NUMERIC,                        -- nullable; see COALESCE
    payment_status TEXT    NOT NULL DEFAULT 'Pending',
    days_overdue   INTEGER NOT NULL DEFAULT 0,
    due_date       TEXT,                           -- ISO string e.g. '2026-06-01'
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- purchases  -- used by dashboard_bootstrap (count of today's purchases)
--
-- This table is NOT present in supabase-schema.sql or any migration.
-- It is implied by the Node backend purchase-recording routes and is
-- created in production by a separate, untracked creation step.
-- For SQLx validation we only need user_id + created_at.
-- ---------------------------------------------------------------------------
CREATE TABLE purchases (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- products  -- used by dashboard_bootstrap (low-stock count)
--
-- Columns sourced from supabase-schema.sql.
-- Rust query: WHERE current_stock < COALESCE(low_stock_alert, 5)
-- ---------------------------------------------------------------------------
CREATE TABLE products (
    id              UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name            TEXT    NOT NULL,
    current_stock   NUMERIC NOT NULL DEFAULT 0,
    low_stock_alert NUMERIC,                       -- nullable; fallback to 5
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- ai_actions  -- used by dashboard_bootstrap (top 3 pending actions)
--
-- Columns sourced from migrations/001_cortex_foundation.sql.
-- Rust query: SELECT id, title, COALESCE(priority,'medium') WHERE status='pending'
-- ---------------------------------------------------------------------------
CREATE TABLE ai_actions (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title      TEXT NOT NULL,
    priority   TEXT,                               -- nullable; COALESCE to 'medium'
    status     TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- promises  -- used by collections_bootstrap and customer_metrics CTE
--
-- Columns sourced from migrations/001_cortex_foundation.sql.
-- Rust queries:
--   COUNT(*) WHERE status = 'broken'              (collections_bootstrap)
--   COUNT(*) FILTER (WHERE status='broken'/'kept') (customer_metrics CTE)
-- ---------------------------------------------------------------------------
CREATE TABLE promises (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    status      TEXT NOT NULL,                     -- 'broken' | 'kept' | 'pending'
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- call_logs  -- used by customer_metrics CTE (call response rate)
--
-- Columns sourced from supabase-schema.sql + customer_id FK.
-- Rust query: COUNT(*) total, COUNT(*) FILTER (WHERE did_pick_up)
-- Note: supabase-schema.sql does NOT include customer_id on call_logs;
--       it is added in production separately.  Required here for SQLx.
-- ---------------------------------------------------------------------------
CREATE TABLE call_logs (
    id          UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    customer_id UUID    REFERENCES customers(id) ON DELETE SET NULL,
    did_pick_up BOOLEAN,                           -- nullable; FILTER ignores NULL
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
