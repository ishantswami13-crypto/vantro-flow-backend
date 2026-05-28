-- supabase-performance-indexes-staging.sql
-- DO NOT APPLY TO PRODUCTION UNTIL TESTED IN STAGING

-- Users & Businesses
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_business_id ON users(business_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_email ON users(email);

-- Invoices
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_invoices_business_id ON invoices(business_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_invoices_user_id ON invoices(user_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_invoices_status ON invoices(status);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_invoices_due_date ON invoices(due_date);

-- Payments
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payments_invoice_id ON payments(invoice_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payments_business_id ON payments(business_id);

-- Ledger Transactions
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transactions_business_id_date ON transactions(business_id, transaction_date DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transactions_user_id ON transactions(user_id);

-- Inventory & Stock
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_inventory_business_id ON inventory(business_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_stock_movements_product_id ON stock_movements(product_id);

-- Collections & Dunning
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_collections_status ON collections(status);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_collections_business_id ON collections(business_id);
