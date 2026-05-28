# Database Security Checklist

## 1. Parameterized Queries
- All SQL queries must use parameterized execution (e.g., `pool.query('SELECT * FROM users WHERE id = $1', [userId])`).
- **NEVER** use string interpolation (`${value}`) for SQL queries.

## 2. Authorization Boundaries
- Every query modifying or reading tenant data (Invoices, Purchases, Sales, Transactions) MUST include an equality check for `user_id = $1` or `business_id = $1`.
- Never trust `user_id` from the request body; rely strictly on `req.user.userId` attached by the auth middleware.

## 3. RLS (Row Level Security)
- Supabase Row Level Security must be enabled on all tables exposed to the client APIs (if using Supabase client).
- Currently, Vantro uses a custom Node.js backend to bypass RLS safely via `SERVICE_ROLE_KEY`. Ensure the backend enforces the RLS equivalent in logic.

## 4. Connection Pooling
- Ensure PgBouncer or Supabase connection pooling (port 6543) is used to prevent max connection limits during traffic spikes.
