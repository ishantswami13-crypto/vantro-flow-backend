-- =============================================================================
-- db/harness-seed.sql
-- CI-ONLY seed data for the Rust live harness. NON-PRODUCTION.
-- =============================================================================
--
-- Applied to the SAME ephemeral postgres:16 + db/sqlx-test-schema.sql that the
-- SQLx validation uses, then the in-CI Rust service is started against it.
-- Two isolated tenants prove cross-user data isolation end to end:
--
--   ownerA = 11111111-1111-1111-1111-111111111111  (risky customer, rich data)
--   ownerB = 22222222-2222-2222-2222-222222222222  (separate business)
--
-- This file is never applied to any real database. The harness workflow tears
-- the container down after the run.
-- =============================================================================

-- -- Tenants ------------------------------------------------------------------
INSERT INTO users (id, email) VALUES
  ('11111111-1111-1111-1111-111111111111', 'ownerA@harness.test'),
  ('22222222-2222-2222-2222-222222222222', 'ownerB@harness.test');

-- -- Customers (one per tenant) -----------------------------------------------
INSERT INTO customers (id, user_id, name, phone, credit_limit, advance_required) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   '11111111-1111-1111-1111-111111111111', 'Risky Traders', '9990001111', 100000, false),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
   '22222222-2222-2222-2222-222222222222', 'Other Biz', '8880002222', 50000, false);

-- -- ownerA invoices: one overdue (with delay), one pending due today ---------
INSERT INTO invoices
  (user_id, customer_id, invoice_amount, total_amount, amount_paid, payment_status, days_overdue, due_date) VALUES
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   40000, 40000, 0, 'Overdue', 21, '2026-05-01'),
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   32000, 32000, 0, 'Pending', 0, '2026-05-30');

-- -- ownerB invoice: small, current (distinct from ownerA) --------------------
INSERT INTO invoices
  (user_id, customer_id, invoice_amount, total_amount, amount_paid, payment_status, days_overdue, due_date) VALUES
  ('22222222-2222-2222-2222-222222222222', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
   5000, 5000, 0, 'Pending', 0, '2026-06-10');

-- -- ownerA promises: 2 broken + 1 kept (drives collection risk) --------------
INSERT INTO promises (user_id, customer_id, status) VALUES
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'broken'),
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'broken'),
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'kept');

-- -- ownerA call logs: 1 picked up, 1 not -------------------------------------
INSERT INTO call_logs (user_id, customer_id, did_pick_up) VALUES
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', true),
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', false);

-- -- ownerA dashboard signals: low stock, a purchase today, a pending action --
INSERT INTO products (user_id, name, current_stock, low_stock_alert) VALUES
  ('11111111-1111-1111-1111-111111111111', 'Widget', 2, 10);

INSERT INTO purchases (user_id) VALUES
  ('11111111-1111-1111-1111-111111111111');

INSERT INTO ai_actions (user_id, title, priority, status) VALUES
  ('11111111-1111-1111-1111-111111111111', 'Call Risky Traders', 'high', 'pending');
