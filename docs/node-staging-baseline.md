# Node Staging Baseline — Honest Node-vs-Rust Comparison

**Purpose:** Measure the Node.js dashboard/bootstrap and collections/bootstrap
endpoints from a non-production staging service so the Performance Lab can
produce an honest Rust p50 vs Node p50 comparison.

**This doc does NOT use the production Node backend. Production traffic is
never touched. `RUST_AUTOMATION_API_ENABLED` stays `false` everywhere.**

---

## Why a Separate Node Staging Service Is Needed

The Rust staging service is already live at:
```
https://vantro-automation-staging-production.up.railway.app
```

To compare Rust vs Node honestly, the Node backend must also be a staging
service — not the production deployment at
`vantro-flow-backend-production.up.railway.app`.

Reasons:
1. The production Node URL is blocked by the perf lab guard
   (`PRODUCTION_HOSTNAMES` in `performance-lab/config.js`).
2. Running load iterations against production could affect real users.
3. The test JWT (`ownerA@harness.test`) does not exist in the production DB,
   so auth-gated endpoints would return 401 regardless.

---

## Supabase Dependency — Read This First

The Node backend (`server.js`) uses the Supabase JS client for most data
operations. The dashboard/bootstrap and collections routes call Supabase
directly. This means a staging Node service requires one of:

| Option | What it gives you | Effort |
|---|---|---|
| **A. Free non-prod Supabase project** | True like-for-like Node baseline | ~20 min setup |
| **B. Railway Postgres + Supabase URL pointing at it** | Not compatible — Supabase client uses Supabase-specific APIs | ✗ Won't work |
| **C. Measure Node endpoints without DB data** | Only unauthenticated or empty-result paths | Partial at best |

**Recommendation: Option A.** Create a free Supabase project at
[supabase.com](https://supabase.com), apply the Vantro schema, seed the
harness data, then use those credentials in the staging Node service.

The staging Postgres (Railway) is the right DB for the **Rust** service.
The non-prod Supabase project is the right DB for the **Node** service.

---

## Step 1 — Create a Non-Prod Supabase Project

1. Go to [supabase.com](https://supabase.com) → New Project
2. Name it `vantro-node-staging` (or similar)
3. Note the **Project URL**, **Anon Key**, and **Service Role Key**
4. In the Supabase SQL editor, run:
   - `db/sqlx-test-schema.sql` — creates the base tables
   - `migrations/001_cortex_foundation.sql`
   - `migrations/002_cortex_extension.sql`
   - `migrations/003_evaluation.sql`
   - `migrations/004_schema_repair.sql`
   - `migrations/005_cortex_x_extensions.sql`
   - Skip `migrations/006_cortex_rls.sql` (RLS requires auth bridge — not needed for staging)
5. Run the seed data from `db/harness-seed.sql` — creates the harness test
   users (`11111111-...` and `22222222-...`) and their associated data

---

## Step 2 — Create the Node Staging Service in Railway

1. Railway dashboard → Project `handsome-stillness` → **New Service → GitHub Repo**
2. Select `vantro-flow-backend`
3. Service settings:
   - **Service name:** `vantro-node-staging`
   - **Root Directory:** `/` (repo root — same as production Node)
   - **Start command:** `node server.js` (Railway autodetects from package.json)
4. Set env vars (see table below)
5. Deploy

### Required env vars for `vantro-node-staging`

| Variable | Value | Notes |
|---|---|---|
| `NODE_ENV` | `production` | Enables production auth middleware |
| `PORT` | `3000` | Express bind port |
| `JWT_SECRET` | Same value as staging Rust service | Must match — both sign/verify with the same secret |
| `SUPABASE_URL` | Non-prod Supabase project URL | e.g. `https://abcxyz.supabase.co` |
| `SUPABASE_KEY` | Non-prod anon key | Public key — used for client queries |
| `SUPABASE_SERVICE_ROLE_KEY` | Non-prod service role key | Server-side admin key |
| `DATABASE_URL` | Non-prod Supabase postgres URL | For Cortex pg.js queries |
| `RUST_AUTOMATION_API_ENABLED` | `false` | Keep Rust flag off on Node staging |
| `RUST_AUTOMATION_BASE_URL` | `https://vantro-automation-staging-production.up.railway.app` | For when the flag is eventually enabled on staging |
| `FEATURE_CORTEX_ENABLED` | `true` | Enable Cortex routes |

Leave all other feature flags at their defaults or match the production
Railway values — this is a baseline measurement, not a new feature test.

> **Security note:** The non-prod Supabase project contains only fake harness
> data. Its service role key is low-risk by design. Still treat it as a secret
> — do not commit it to the repo.

---

## Step 3 — Add the Node Staging URL to the Production Guard

Once the staging Node service deploys, confirm its URL follows the pattern:
```
https://vantro-node-staging-production.up.railway.app
```

This URL is **not** in `PRODUCTION_HOSTNAMES` (it's staging), so the perf
lab will allow it automatically. No config change needed.

If a custom domain is assigned, add it to `PRODUCTION_HOSTNAMES` in
`performance-lab/config.js` to keep the guard current.

---

## Step 4 — Run the Live Baseline Measurement

```bash
# Generate a fresh non-prod JWT if .staging-token has expired (2h TTL)
JWT_SECRET=<staging-secret> npm run staging:jwt

# Run full live perf lab — Rust + Node in one shot
PERF_RUN_LIVE=true \
PERF_RUST_BASE_URL=https://vantro-automation-staging-production.up.railway.app \
PERF_NODE_BASE_URL=https://vantro-node-staging-production.up.railway.app \
PERF_TEST_TOKEN=$(cat .staging-token) \
PERF_ITERATIONS=10 \
PERF_TIMEOUT_MS=5000 \
PERF_REQUIRE_NON_PROD=true \
npm run perf:test
```

### Expected output

```
PASS  Rust dashboard/bootstrap     0ms svr   [server-compute] ✓ | wall p50 ~350ms
PASS  Rust collections/bootstrap   0ms svr   [server-compute] ✓ | wall p50 ~330ms
PASS  Node dashboard/bootstrap     Xms p50   [wall-clock]     ✓ or ⚠
PASS  Node collections/bootstrap   Xms p50   [wall-clock]     ✓ or ⚠
```

Wall-clock for both Rust and Node will reflect public-internet RTT (~300–500ms
from most locations to Railway US-East). The meaningful comparison is:
- **Rust server-compute** (durationMs in response body) vs
- **Node wall-clock** (Node does not report server-compute time)

For a true apples-to-apples in-region comparison, use the Railway private
network (`vantro-automation-staging.railway.internal`) from within a Railway
service, not from a local machine.

---

## What the Baseline Proves

| Measurement | Proves |
|---|---|
| Rust server-compute = 0ms | Rust compute overhead is sub-millisecond |
| Node wall-clock p50 | Node latency from same remote vantage point |
| Rust wall-clock p50 | Network RTT (same for both) |
| safe_to_enable_rust result | Whether Rust meets budget on a live DB-backed path |

The baseline does **not** prove production readiness. That requires the
24-hour soak (`docs/rust-staging-soak.md`) and a canary rollout.

---

## If Node Staging DB Isn't Ready Yet

Run with `PERF_SKIP_DB=false` but without `PERF_NODE_BASE_URL`. The Node
tests will be marked `SKIPPED` (not `FAIL`) and the report will note:

```
SKIP  Node dashboard/bootstrap (auth)    PERF_NODE_BASE_URL not set
SKIP  Node collections/bootstrap (auth)  PERF_NODE_BASE_URL not set
```

`safe_to_enable_rust` will remain `YES (staging only)` as long as all
measured Rust tests pass — the Node skip does not block the Rust verdict.
