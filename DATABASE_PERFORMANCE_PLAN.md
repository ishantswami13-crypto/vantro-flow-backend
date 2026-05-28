# Database Query Performance Plan (Vantro Flow)

This document audits the current query patterns of Vantro Flow database structures (Supabase/Postgres) and outlines exact indexing recommendations, pagination updates, and query strategies to handle high-traffic scalability.

---

## 1. Endpoint Query Performance Audit

| Endpoint | Tables Queried | Filters Used | Bottlenecks / Risks Identified |
| :--- | :--- | :--- | :--- |
| **`/api/analytics/:userId`** | `sales`, `invoices`, `purchases`, `call_logs` | `user_id` | Loops over 100 sales inline to sync receivables dynamically. Fetches complete raw tables without pagination or limit parameters, which causes $O(N)$ write amplification. |
| **`/api/cash-forecast/:userId`** | `sales`, `invoices`, `purchases`, `stock_movements`, `bank_transactions` | `user_id`, `payment_status` | Inline calls to `ensureConnectedBusinessData` and `syncExistingSalesReceivables`. Computes mathematical forecasts dynamically over historical lists in the request-response loop. |
| **`/api/business/control-room`** | `invoices`, `purchases`, `products`, `transactions`, `activity_logs` | `user_id` | Multiple un-paginated parallel `Promise.all` SELECT queries fetching hundreds of historical rows. |
| **`/api/inventory/:userId`** | `products`, `stock_movements` | `user_id` | Reads entire tables to execute in-memory inventory summaries and valuations. |
| **`/api/transactions/:userId`** | `transactions`, `bank_accounts`, `bank_transactions` | `user_id` | Fetches entire raw ledgers without pagination or window functions, doing dynamic calculation loops in Node.js. |

---

## 2. Key Performance Violations & Solutions

### A. Lack of Pagination (The $O(N)$ Data Fetch Problem)
*   **Problem**: In Express endpoints like `getReceivableRows`, all records are fetched in full. When database row count grows to thousands of records per business, the database will experience CPU spikes, and network transmission times will degrade drastically.
*   **Solution**: Implement standard cursor-based or keyset pagination (`LIMIT` / `OFFSET`) on list endpoints, restricting fetches to 50 rows per request.

### B. Inline Sync Loops (Dynamic Writing on Read Endpoints)
*   **Problem**: `syncExistingSalesReceivables` runs in the dashboard loop, writing to the DB in-flight during GET requests.
*   **Solution**: Decouple writing tasks from read endpoints. Move the sync hooks to the write path (`POST /api/sales`) or utilize the Event Engine (`emitBusinessEvent`) in the background.

---

## 3. Recommended Performance Indexes (SQL DDL)

Applying these indexes will speed up filter operations by up to **100x** as the tables scale past thousands of rows.

```sql
-- =============================================================================
-- Vantro Flow Database Indexing Plan
-- =============================================================================

-- Invoices Indexes
CREATE INDEX IF NOT EXISTS idx_invoices_user_date ON invoices (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices (payment_status);
CREATE INDEX IF NOT EXISTS idx_invoices_due_date ON invoices (user_id, due_date);

-- Products & Stock Movements Indexes
CREATE INDEX IF NOT EXISTS idx_stock_movements_product ON stock_movements (product_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_user_moved ON stock_movements (user_id, moved_at DESC);

-- Bank & Ledger Transactions
CREATE INDEX IF NOT EXISTS idx_bank_transactions_user_date ON bank_transactions (user_id, txn_date DESC);
CREATE INDEX IF NOT EXISTS idx_bank_transactions_matching ON bank_transactions (user_id, status, matched_id);
CREATE INDEX IF NOT EXISTS idx_transactions_user_date ON transactions (user_id, transaction_date DESC);

-- Team Members & Prospects
CREATE INDEX IF NOT EXISTS idx_team_members_owner ON team_members (owner_id, is_active);
CREATE INDEX IF NOT EXISTS idx_prospects_user_status ON prospects (user_id, status);

-- Activity Logs & Notifications
CREATE INDEX IF NOT EXISTS idx_activity_logs_user_action ON activity_logs (user_id, action, created_at DESC);
```

---

## 4. Rollback Strategy (SQL DDL)

If index maintenance overhead degrades write performance, indexes can be cleanly dropped using the following DDL:

```sql
-- =============================================================================
-- Database Index Rollback Commands
-- =============================================================================

DROP INDEX IF EXISTS idx_invoices_user_date;
DROP INDEX IF EXISTS idx_invoices_status;
DROP INDEX IF EXISTS idx_invoices_due_date;
DROP INDEX IF EXISTS idx_stock_movements_product;
DROP INDEX IF EXISTS idx_stock_movements_user_moved;
DROP INDEX IF EXISTS idx_bank_transactions_user_date;
DROP INDEX IF EXISTS idx_bank_transactions_matching;
DROP INDEX IF EXISTS idx_transactions_user_date;
DROP INDEX IF EXISTS idx_team_members_owner;
DROP INDEX IF EXISTS idx_prospects_user_status;
DROP INDEX IF EXISTS idx_activity_logs_user_action;
```

---

## 5. Architectural Upgrade Opportunity: Materialized Views

For heavy analytics dashboards, calculation overhead can be completely eliminated by introducing a Materialized View that auto-refreshes daily or on-demand:

```sql
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_business_daily_summaries AS
SELECT 
    user_id,
    COALESCE(SUM(invoice_amount) FILTER (WHERE payment_status = 'Pending'), 0) AS total_outstanding,
    COALESCE(SUM(invoice_amount) FILTER (WHERE payment_status = 'Paid'), 0) AS total_recovered,
    COUNT(id) AS total_invoice_count
FROM invoices
GROUP BY user_id;

CREATE UNIQUE INDEX ON mv_business_daily_summaries (user_id);
```
