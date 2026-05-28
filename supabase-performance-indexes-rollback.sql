-- supabase-performance-indexes-rollback.sql
-- Drops the indexes created in staging

DROP INDEX CONCURRENTLY IF EXISTS idx_users_business_id;
DROP INDEX CONCURRENTLY IF EXISTS idx_users_email;
DROP INDEX CONCURRENTLY IF EXISTS idx_invoices_business_id;
DROP INDEX CONCURRENTLY IF EXISTS idx_invoices_user_id;
DROP INDEX CONCURRENTLY IF EXISTS idx_invoices_status;
DROP INDEX CONCURRENTLY IF EXISTS idx_invoices_due_date;
DROP INDEX CONCURRENTLY IF EXISTS idx_payments_invoice_id;
DROP INDEX CONCURRENTLY IF EXISTS idx_payments_business_id;
DROP INDEX CONCURRENTLY IF EXISTS idx_transactions_business_id_date;
DROP INDEX CONCURRENTLY IF EXISTS idx_transactions_user_id;
DROP INDEX CONCURRENTLY IF EXISTS idx_inventory_business_id;
DROP INDEX CONCURRENTLY IF EXISTS idx_stock_movements_product_id;
DROP INDEX CONCURRENTLY IF EXISTS idx_collections_status;
DROP INDEX CONCURRENTLY IF EXISTS idx_collections_business_id;
