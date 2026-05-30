# Rust Staging Live Measurement Runbook

**Purpose:** Deploy Vantro Automation RS as a separate Railway staging service
with `RUST_AUTOMATION_API_ENABLED=false`, then run the Performance Lab in live
mode to produce real p50/p95 numbers for every Rust endpoint.

**This doc does NOT deploy Rust to production. The production flag stays off.**

For Railway dashboard setup, nixpacks wiring, and the rollout gate sequence
see [rust-railway-deploy.md](./rust-railway-deploy.md). This doc covers only
the staging deploy + live measurement steps.

---

## Pre-conditions (confirm before starting)

- [ ] `npm run test:rust-fallback` → 8/8 PASS on current branch
- [ ] `npm run perf:test` → exit 0 (offline mode, 5/5 wrapper PASS)
- [ ] `npm run cortex:test` → 100/100 PASS
- [ ] `node-fallback-ci.yml` is green in GitHub Actions
- [ ] `rust-automation-ci.yml` is green in GitHub Actions
- [ ] You have access to Railway dashboard for the `vantro-flow` project
- [ ] You have a **non-production** Postgres URL to use as the staging DB

---

## Step 1 — Create the Rust staging service in Railway

Follow [rust-railway-deploy.md § One-time Railway dashboard setup](./rust-railway-deploy.md#one-time-railway-dashboard-setup-rust-service) exactly.

Summary:
1. Railway dashboard → `vantro-flow` project → **New Service → GitHub Repo**
2. Select `vantro-flow-backend` repo
3. Service settings:
   - **Service name:** `vantro-automation-staging`
   - **Root Directory:** `/` (repo root — `Cargo.lock` and `.sqlx/` live here)
   - **Config-as-code / Railway Config File:** `vantro-automation-rs/railway.toml`
4. Do NOT add a public domain unless needed for external testing. The internal
   hostname (`vantro-automation-staging.railway.internal`) is enough for
   Node→Rust calls on the private network.

---

## Step 2 — Set env vars on the Rust staging service

Set these in the Railway dashboard on the **`vantro-automation-staging`** service:

| Variable | Value | Notes |
|---|---|---|
| `SQLX_OFFLINE` | `true` | Build reads committed `.sqlx/` cache. Required. |
| `DATABASE_URL` | non-prod Postgres URL | Staging DB only. Never use the production Supabase URL here. |
| `JWT_SECRET` | same value as Node staging service | Must match exactly so Rust validates the same tokens. |
| `RUST_AUTOMATION_PORT` | `3002` | Axum bind port. |
| `NODE_ENV` | `production` | Disables the `x-user-id` dev-auth bypass in `src/auth.rs`. |
| `REDIS_URL` | (optional) Redis URL | L2 cache. Omit to run L1 (in-memory DashMap) only. |

Do NOT set `DATABASE_URL` to the production Supabase URL. Create a
separate staging schema or use a local Postgres instance.

---

## Step 3 — Deploy and verify health

1. Trigger a deploy on the `vantro-automation-staging` service.
2. Watch build logs. Expect:
   - `cargo build --release --features server -p vantro-automation-rs`
   - Successful link, binary at `target/release/vantro-automation`
3. Railway runs the health check: `GET /health` → `{"ok": true, ...}`
4. Deploy goes green.

If the build fails, check:
- `SQLX_OFFLINE=true` is set
- The committed `.sqlx/` query cache exists (`ls .sqlx/*.json | wc -l` → 8)
- `.cargo/config.toml` override is in `vantro-automation-rs/nixpacks.toml` (it is)

---

## Step 4 — Set Node staging env vars (flag stays OFF)

On the **Node backend staging service** (NOT production):

```
RUST_AUTOMATION_API_ENABLED=false          # stays false — no production traffic
RUST_AUTOMATION_BASE_URL=https://<your-rust-staging-public-url>
```

If testing over Railway internal network (no public domain), use:
```
RUST_AUTOMATION_BASE_URL=http://vantro-automation-staging.railway.internal:3002
```

The Node client short-circuits on `RUST_AUTOMATION_API_ENABLED=false`. Setting
`RUST_AUTOMATION_BASE_URL` here is only to document the target; the client
ignores it while the flag is false.

---

## Step 5 — Run the Performance Lab in live mode

From your local machine, run:

```sh
PERF_RUN_LIVE=true \
PERF_RUST_BASE_URL=https://<your-rust-staging-public-url> \
PERF_TEST_TOKEN=<non-prod JWT token> \
PERF_ITERATIONS=10 \
PERF_TIMEOUT_MS=5000 \
npm run perf:test
```

### Generating a non-prod test JWT

The token must be signed with the same `JWT_SECRET` used by the staging Rust
service. You can generate one with:

```sh
node -e "
const jwt = require('jsonwebtoken');
const token = jwt.sign(
  { userId: 'perf-test-user', email: 'perf@test.local' },
  process.env.JWT_SECRET,
  { expiresIn: '1h' }
);
console.log(token);
"
```

Run this against the **staging** secret only. Never log or commit the token.

### Environment safety checks (automatic)

The lab will block if:
- `PERF_RUST_BASE_URL` matches a known production pattern (railway.app with prod
  service name, vantro.in, supabase.co, etc.)
- `PERF_RUN_LIVE=true` but neither `PERF_RUST_BASE_URL` nor `PERF_NODE_BASE_URL`
  is set

### Expected output (live mode)

```
──────────────────────────────────────────────────────────────
  Vantro Performance Lab
  Mode:     live
  Rust URL: configured
  Node URL: not configured
──────────────────────────────────────────────────────────────
  PASS  Rust /health                     XX ms p50    ...
  PASS  Rust score-customer              XX ms p50    ...
  PASS  Rust calculate-cpi               XX ms p50    ...
  PASS  Rust simulate-credit-sale        XX ms p50    ...
  PASS  Rust evaluate-policy             XX ms p50    ...
  PASS  Rust cost-route                  XX ms p50    ...
  SKIP  Rust dashboard/bootstrap         ---          requires DB + auth
  SKIP  Rust collections/bootstrap       ---          requires DB + auth
  PASS  Wrapper: flag disabled fallback  1 ms p50     ...
  PASS  Wrapper: missing base URL        1 ms p50     ...
  PASS  Wrapper: connection refused      3 ms p50     ...
  PASS  Wrapper: timeout (250ms probe)   260 ms p50   ...
  PASS  Wrapper: valid response overhead 3 ms p50     ...
  SKIP  Node dashboard/bootstrap (unauth)  ---        PERF_NODE_BASE_URL not set
  ...
──────────────────────────────────────────────────────────────
  Tests Run: 17   Passed: 11   Failed: 0   Skipped: 6
  safe_to_enable_rust: YES (staging only; production requires additional canary review)
──────────────────────────────────────────────────────────────
```

The lab writes:
- `performance-lab/results/latest.json` — machine-readable with all p50/p95/min/max
- `performance-lab/reports/latest.md` — human-readable with full table

---

## Step 6 — Interpret results

### Rust endpoint budgets

| Endpoint | Target | Acceptable | Action if over |
|---|---|---|---|
| `/health` | <50ms | <150ms | Check Railway cold start |
| `score-customer` | <100ms | <250ms | Check DB connection / pool |
| `calculate-cpi` | <100ms | <250ms | Check DB |
| `simulate-credit-sale` | <150ms | <300ms | Check scoring logic |
| `evaluate-policy` | <50ms | <150ms | Should be pure logic, no DB |
| `cost-route` | <50ms | <150ms | Should be pure logic, no DB |
| `dashboard/bootstrap` | <200ms (cached) | <1500ms | Check L1/L2 cache |
| `collections/bootstrap` | <200ms (cached) | <1500ms | Check L1/L2 cache |

### Wrapper overhead budget

All wrapper fallback paths measured at offline: ≤4ms p50. Re-confirm same
numbers in live mode. If any wrapper fallback path increases to >20ms,
investigate before enabling the flag.

### `safe_to_enable_rust` field

The lab emits this field in `results/latest.json`:
- `NO — live Rust endpoints not yet measured` — run live mode first
- `NO — Node wrapper contract failed` — critical: do NOT enable flag
- `NO — see failures above` — fix failures first
- `YES (staging only; production requires additional canary review)` — staging
  enablement is safe; follow the canary gate in `rust-railway-deploy.md` for
  production

---

## Step 7 — What `safe_to_enable_rust: YES` actually means

**Staging flag enable is safe when ALL of these are true:**
- [ ] All measured Rust endpoints pass their budgets
- [ ] Node wrapper fallback contract: 8/8 cases return null on failure
- [ ] `safe_to_enable_rust: YES` in `performance-lab/results/latest.json`
- [ ] Rust `/health` returns 200 in production

**Production flag enable requires ADDITIONAL steps (not yet):**
- [ ] 24h staging soak with `RUST_AUTOMATION_API_ENABLED=true` on staging Node
- [ ] Zero errors / unexpected fallbacks during soak
- [ ] Live bootstrap endpoint measured with real non-prod data
- [ ] Auth isolation: Rust 401s on missing token, rejects wrong-user tokens
- [ ] Cache isolation: Rust response for user A does not bleed into user B
- [ ] Canary: 1 user → 1h → 10% → 50% → 100% (see `rust-railway-deploy.md`)

---

## Step 8 — Rollback at any point

**Fastest (seconds):** Set `RUST_AUTOMATION_API_ENABLED=false` on the Node
service. Restart. Client short-circuits to JS immediately. No customer impact.

**Service kill:** Stop the `vantro-automation-staging` Railway service. Even if
the flag was on, Node's fallback matrix returns null on connection refused.

**See** [rust-railway-deploy.md § Rollback](./rust-railway-deploy.md#rollback-fastest-to-slowest)
for the full rollback sequence.

---

## Checklist — ready to enable Rust on staging

```
[ ] Rust staging service deployed + health green
[ ] npm run perf:test (live mode) → exit 0
[ ] safe_to_enable_rust: YES in results/latest.json
[ ] npm run test:rust-fallback → 8/8 PASS
[ ] Rust endpoint p50s all within acceptable budgets
[ ] Node wrapper overhead ≤ 4ms p50 (confirmed in same run)
[ ] No token or payload logged in perf output
```

Only after all boxes are checked: set `RUST_AUTOMATION_API_ENABLED=true` on the
**staging** Node service. Keep it false on production.

---

## What this commit does NOT do

- Does NOT deploy anything.
- Does NOT enable `RUST_AUTOMATION_API_ENABLED`.
- Does NOT touch `server.js`, the frontend, or existing Node routes.
- Does NOT set any real secret — all values above are documentation.
- Does NOT commit the cortex-lab Harness X refactor (deferred).
