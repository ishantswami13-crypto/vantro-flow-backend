-- supabase-performance-indexes.sql
-- Safely applies high-performance indexes using CONCURRENTLY to avoid locking tables in production.

-- CUSTOMERS
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_customers_user_created ON customers(user_id, created_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_customers_user_name ON customers(user_id, name);

-- SALES / INVOICES
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_invoices_user_created ON invoices(user_id, created_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_invoices_user_customer ON invoices(user_id, customer_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_invoices_user_status_due ON invoices(user_id, payment_status, due_date);

-- PURCHASES
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_purchases_user_created ON purchases(user_id, created_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_purchases_user_supplier ON purchases(user_id, supplier_id);

-- PRODUCTS & INVENTORY
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_products_user ON products(user_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_products_user_name ON products(user_id, name);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_stock_movements_user_product ON stock_movements(user_id, product_id, created_at DESC);

-- PAYMENTS
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payments_user_customer ON payments(user_id, customer_id, created_at DESC);

-- PROMISES (assuming they exist on a table or are joined. Adjust if part of invoices)
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_promises_user_status ON promises(user_id, status, promised_date);

-- AI ACTIONS
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ai_actions_user_status ON ai_actions(user_id, status, priority);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ai_actions_user_req_approval ON ai_actions(user_id, requires_approval, status);

-- ERROR LOGS (for high-volume inserts)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_error_events_user_created ON error_events(user_id, created_at DESC);
