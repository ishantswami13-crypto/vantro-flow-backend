# Database Connection Pooling & PgBouncer Strategy (Vantro Flow)

This document establishes the architecture for database connection limit protections as Vantro Flow transitions from low-concurrency usage to high-concurrency scaling.

---

## 1. Current DB Connection Architecture & Connection Churn
*   **Direct Connection**: The Node.js Express server runs a persistent `pg` Pool (`pgPool = new Pool(...)`) initialized at startup with `max: 10`.
*   **Supabase Client**: Direct REST queries made via the `@supabase/supabase-js` client use standard HTTP REST routes. Supabase translates these inside its PostgREST layer into PG connections.
*   **The Issue**: Under high concurrency (especially if we auto-scale the backend server to 3-5 instances on Railway), each instance running a `max: 10` direct Pool will easily saturate standard PG database backend connection limits (defaulting to 100-200 limits for Supabase starter tiers).

---

## 2. PgBouncer / Supabase Pooler Recommendation
To prevent connection exhaustion under high loads, Vantro Flow must transition its direct backend connections to use **Supabase Pooler**.

Supabase provides two port configurations for database URLs:
1.  **Direct Connection (Port `5432`)**: Used for one-off tasks, database migrations, and schema modifications.
2.  **Pooler Connection (Port `6543`)**: Used for application runtime connections. 
    *   *Transaction Mode* (highly recommended for serverless/edge and high-load REST APIs): Reuses a small pool of database connections across hundreds of active client transactions.

---

## 3. Recommended DATABASE_URL Strategy

Configure your system environment variables with two distinct connection strings:

```env
# Port 6543 (Transaction mode - PgBouncer) for application traffic
DATABASE_URL="postgres://postgres.xxxxxx:[PASSWORD]@aws-0-us-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true"

# Port 5432 (Direct connection) strictly for running migrations
DIRECT_URL="postgres://postgres.xxxxxx:[PASSWORD]@db.xxxxxx.supabase.co:5432/postgres"
```

---

## 4. Connection Pooling Configuration Settings

In `server.js`, configure the PostgreSQL client pool options to align with the transaction pooler capabilities:

```javascript
const pgPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 15,                  // Maximum connection limit per backend instance
  idleTimeoutMillis: 10000, // Close idle connections quickly to release backend slots
  connectionTimeoutMillis: 2000, // Timeout fast on database saturation
});
```

---

## 5. Rollout & Migration Plan

### Step A: Staging Validation
1.  Add `DATABASE_URL` (pointing to port `6543` with `?pgbouncer=true`) to the staging environment configuration.
2.  Run baseline API verification to verify that simple reads, writes, and complex analytics do not experience performance degradation.

### Step B: Production Rollout
1.  Update the Railway production container configuration variables.
2.  Ensure that direct migrations (if run on startup) run using the `DIRECT_URL` (Port `5432`) as PgBouncer's Transaction Mode does not support running DDL migrations containing prepared statements.

### Step C: Rollback Strategy
If transaction pooler mode experiences errors (such as unexpected session state leakage or syntax mismatches with parameterized SQL):
1.  Revert the Railway production `DATABASE_URL` environment variable back to the direct Supabase URL (Port `5432`).
2.  Trigger a production redeployment to instantly re-establish direct session-mode connections.
