-- ============================================================
-- VANTRO CORTEX — Migration 013: orders and workers
-- ============================================================
-- Additive only — no destructive change, no existing table altered.
--
-- Why: the Orders feature (voice + manual order intake, REST endpoints,
-- the frontend /orders nav page, and the AI-copilot tool functions
-- get_top_customers/get_orders_by_date/search_customer) is fully built
-- and wired in server.js, but its backing tables `orders` and `workers`
-- were never created in any schema file (supabase-schema.sql, migrations,
-- or scripts/supabase ad-hoc files) — confirmed by a direct grep audit
-- of server.js and a live information_schema check against the local
-- dev DB. Every orders-related call currently fails with
-- `relation "orders" does not exist`. This migration creates both
-- tables with exactly the columns server.js reads/writes, derived from:
--   - GET/POST/PATCH/DELETE /api/orders            (~line 8292-8345)
--   - GET/POST/PATCH/DELETE /api/workers            (~line 8351-8388)
--   - AI-voice order-intake insert path             (~line 8588-8603)
--   - Auto-call-worker lookup                       (~line 8616-8617)
--   - AI-copilot tools get_orders_by_date /
--     search_customer / get_top_customers(ranked_by:'orders') (~8944-9072)
--   - Attendance/salary routes reading workers.monthly_salary /
--     workers.advance_balance                       (~9858-9919)
--
-- items is JSONB (not TEXT like `sales.items`) because the live insert
-- paths (POST /api/orders and the AI-call intake) write a raw JS array
-- of item objects directly, never JSON.stringify-ing it first — matching
-- JSONB's native array-of-objects storage rather than sales' stringified
-- TEXT convention.
--
-- id/user_id FK pattern and DISABLE ROW LEVEL SECURITY follow the same
-- convention established in migration 011 (customer_score_history):
-- app-level user_id scoping on every query, RLS not used in this
-- codebase for tenant isolation.
CREATE TABLE IF NOT EXISTS workers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  phone           TEXT,
  role            TEXT DEFAULT 'delivery',
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  monthly_salary  NUMERIC(14,2) DEFAULT 0,
  advance_balance NUMERIC(14,2) DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workers_user_id ON workers(user_id);
CREATE INDEX IF NOT EXISTS idx_workers_user_active ON workers(user_id, is_active);

ALTER TABLE workers DISABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS orders (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  worker_id             UUID REFERENCES workers(id) ON DELETE SET NULL,
  customer_name         TEXT,
  customer_phone        TEXT,
  delivery_address      TEXT,
  items                 JSONB DEFAULT '[]',
  total_amount          NUMERIC(14,2),
  delivery_time         TEXT,
  special_instructions  TEXT,
  status                TEXT NOT NULL DEFAULT 'new'
                          CHECK (status IN ('new', 'confirmed', 'dispatched', 'delivered', 'cancelled')),
  source                TEXT NOT NULL DEFAULT 'manual'
                          CHECK (source IN ('manual', 'ai_call')),
  order_date            DATE NOT NULL DEFAULT CURRENT_DATE,
  call_recording_url    TEXT,
  call_transcript       TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

-- "give me this tenant's orders" (every route filters by user_id first)
CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);
-- GET /api/orders default/date-range filtering
CREATE INDEX IF NOT EXISTS idx_orders_user_date ON orders(user_id, order_date DESC);
-- GET /api/orders ?status= filter
CREATE INDEX IF NOT EXISTS idx_orders_user_status ON orders(user_id, status);
-- worker-merge follow-up lookups in the GET /api/orders rewrite
CREATE INDEX IF NOT EXISTS idx_orders_worker_id ON orders(worker_id) WHERE worker_id IS NOT NULL;

ALTER TABLE orders DISABLE ROW LEVEL SECURITY;

SELECT 'Migration 013_orders_and_workers complete' AS status;
