# Rust Staging 24h Soak Log

**Service:** `vantro-automation-staging`
**URL:** https://vantro-automation-staging-production.up.railway.app
**Branch:** `performance-bootstrap-cortex-fix-v1`
**Commit at soak start:** `366d590`
**Railway project:** `handsome-stillness` (ef15ae28-4a41-472f-8eb0-b3554b280fc0)
**Service ID:** `6a2b75bb-77d2-4298-863d-4a9a82ed5e39`
**Region:** iad (US East)

**Soak protocol:** `docs/rust-staging-soak.md`
**Spot checks:** T+0h, T+4h, T+8h, T+24h

> Token safety: PERF_TEST_TOKEN never printed. All spot checks load it from `.staging-token` only.

---

## Baseline (before soak)

| Metric | Value |
|---|---|
| Railway status | Online |
| Memory (pre-soak) | Not captured via CLI — check Railway Metrics tab |
| CPU (pre-soak) | Not captured via CLI |
| RUST_AUTOMATION_API_ENABLED | `false` everywhere |
| Migrations applied | 001–005 on Railway staging Postgres |
| Seed data | Present (ownerA=11111111-... · 3 invoices · 3 promises · 1 ai_action) |

---

## T+0h — 2026-05-31 ~06:50 UTC

**Health check:**

| Field | Value |
|---|---|
| HTTP status | 200 |
| ok | true |
| service | vantro-automation-rs |
| version | 0.1.0 |

**Performance Lab (10 iterations, PERF_SKIP_DB=false):**

| Endpoint | Metric kind | Server-compute | Wall-clock p50 | Payload | Result |
|---|---|---|---|---|---|
| `GET /health` | wall-clock | — | 318ms | 0.1 KB | PASS ⚠ |
| `POST /api/v2/cortex/score-customer` | server-compute | **0ms** | 315ms | 0.3 KB | PASS ✓ |
| `POST /api/v2/cortex/calculate-cpi` | server-compute | **0ms** | 317ms | 0.4 KB | PASS ✓ |
| `POST /api/v2/cortex/simulate-credit-sale` | server-compute | **0ms** | 313ms | 0.6 KB | PASS ✓ |
| `POST /api/v2/cortex/evaluate-policy` | server-compute | **0ms** | 316ms | 0.2 KB | PASS ✓ |
| `POST /api/v2/cortex/cost-route` | server-compute | **0ms** | 314ms | 0.3 KB | PASS ✓ |
| `GET /api/v2/dashboard/bootstrap` | server-compute | **0ms** | 319ms | 0.3 KB | PASS ✓ |
| `GET /api/v2/collections/bootstrap` | server-compute | **0ms** | 314ms | 0.2 KB | PASS ✓ |
| Wrapper: flag disabled | — | — | 2ms p50 | 0B | PASS ✓ |
| Wrapper: missing URL | — | — | 1ms p50 | 0B | PASS ✓ |
| Wrapper: conn refused | — | — | 1ms p50 | 0B | PASS ✓ |
| Wrapper: timeout 250ms | — | — | 253ms p50 | 0B | PASS ✓ |
| Wrapper: valid overhead | — | — | 1ms p50 | 0B | PASS ✓ |

**Summary:** 13/13 PASS · 0 FAIL · 4 SKIP (Node URL not set) · 0 critical

**Railway logs at T+0h:** `Starting Container` — minimal log output via CLI. No PANIC, no ERROR, no OOM visible.

**safe_to_continue_soak:** YES

---

## T+~1h — 2026-05-31 ~07:53 UTC (status semantics validation run)

> Note: Not a scheduled checkpoint. Run to validate the new granular status
> fields (`rust_sidecar_ready` etc.) added in this session. Confirms soak
> is progressing cleanly.

**Performance Lab (10 iterations, both URLs set):**

| Endpoint | Server-compute | Wall-clock p50 | Result |
|---|---|---|---|
| `GET /health` | — | 406ms | PASS ⚠ |
| `POST score-customer` | **0ms** | 310ms | PASS ✓ |
| `POST calculate-cpi` | **0ms** | 410ms | PASS ✓ |
| `POST simulate-credit-sale` | **0ms** | 317ms | PASS ✓ |
| `POST evaluate-policy` | **0ms** | 308ms | PASS ✓ |
| `POST cost-route` | **0ms** | 319ms | PASS ✓ |
| `GET dashboard/bootstrap` | **0ms** | 315ms | PASS ✓ |
| `GET collections/bootstrap` | **0ms** | 308ms | PASS ✓ |
| Node unauth (dashboard) | — | 327ms | PASS ✓ |
| Node unauth (collections) | — | 319ms | PASS ✓ |
| Node auth (dashboard) | — | 321ms | FAIL (500 — placeholder Supabase, expected) |
| Node auth (collections) | — | 321ms | FAIL (500 — placeholder Supabase, expected) |

**Granular status:**

| Field | Value |
|---|---|
| rust_sidecar_ready | **YES (staging only)** |
| node_staging_ready | PARTIAL — unauth pass, auth needs non-prod Supabase |
| node_auth_baseline_ready | NO — placeholder Supabase |
| production_enablement_ready | NO |
| safe_to_enable_rust | **YES (staging only)** |

Exit code: **0** (Node auth 500 no longer exits 1 — correct)
Railway restarts: 0 (service running continuously)
PANIC/OOM in logs: None visible
**safe_to_continue_soak: YES**

---

## T+4h — target ~2026-05-31 ~10:50 UTC

*Pending — refresh .staging-token before running spot check.*

```bash
JWT_SECRET=<staging-secret> npm run staging:jwt

PERF_RUN_LIVE=true \
PERF_RUST_BASE_URL=https://vantro-automation-staging-production.up.railway.app \
PERF_NODE_BASE_URL=https://vantro-node-staging-production.up.railway.app \
PERF_TEST_TOKEN=$(cat .staging-token) \
PERF_ITERATIONS=10 PERF_TIMEOUT_MS=5000 PERF_REQUIRE_NON_PROD=true \
npm run perf:test
```

| Metric | Value | vs T+0h |
|---|---|---|
| Health HTTP | | |
| score-customer server-compute | | |
| dashboard/bootstrap server-compute | | |
| Wall-clock p50 range | | |
| Railway restarts | | |
| Memory (MB) | | |
| PANIC in logs | | |
| rust_sidecar_ready | | |
| safe_to_continue_soak | | |

---

## T+8h — target ~2026-05-31 ~14:50 UTC

*Pending.*

| Metric | Value | vs T+0h |
|---|---|---|
| Health HTTP | | |
| score-customer server-compute | | |
| dashboard/bootstrap server-compute | | |
| Wall-clock p50 | | |
| Railway restarts | | |
| Memory (MB) | | |
| PANIC in logs | | |
| safe_to_continue_soak | | |

---

## T+24h — target ~2026-06-01 ~06:50 UTC

*Pending — final soak verdict.*

| Metric | Value | Pass? |
|---|---|---|
| Total duration | | ✓ if 24h no manual restart |
| Restarts | | ✓ if 0 |
| Memory at end | | ✓ if < 2× T+0h baseline |
| PANIC in logs | | ✓ if NO |
| OOM in logs | | ✓ if NO |
| 5xx responses | | ✓ if 0 |
| Health ping failures | | ✓ if < 1% |
| p50 server-compute at T+24h | | ✓ if 0–1ms |
| safe_to_enable_rust (final run) | | ✓ if YES (staging only) |

**Soak verdict (fill at T+24h):** PENDING

---

## Node Staging Status

**Service:** `vantro-node-staging` (558e7fa3-27c6-476f-9c0f-f0e36ee78756)
**URL:** https://vantro-node-staging-production.up.railway.app
**Status:** Deploying (first run crashed — invalid Supabase URL format fixed, redeploy triggered 2026-05-31)

**Current state:**
- Unauth 401 tests: available once service is up
- Auth 200 tests (full DB-backed): BLOCKED — requires non-prod Supabase project
  See `docs/node-staging-baseline.md` for setup instructions.

**Node baseline (unauth 401 check — MEASURED 2026-05-31):**

| Endpoint | Expected | Actual | Wall p50 | Result |
|---|---|---|---|---|
| `GET /api/v1/dashboard/bootstrap` (no token) | 401 | **401** | 355ms | **PASS** ✓ |
| `GET /api/v1/collections/bootstrap` (no token) | 401 | **401** | 396ms | **PASS** ✓ |

Wall-clock 355–396ms = same public-internet RTT as Rust (~318–409ms). Node auth middleware responds identically fast.

**Node baseline (auth 200 — BLOCKED until non-prod Supabase wired):**

| Endpoint | Expected | Actual | Wall p50 | Result |
|---|---|---|---|---|
| `GET /api/v1/dashboard/bootstrap` (valid JWT) | 200 | 500 | 332ms | BLOCKED — placeholder Supabase URL |
| `GET /api/v1/collections/bootstrap` (valid JWT) | 200 | 500 | 409ms | BLOCKED — placeholder Supabase URL |

The 500 errors are expected: `supabase-js` client tries to query `placeholder.supabase.co` and gets a connection error.
These tests will pass once non-prod Supabase project is created and wired in.
See `docs/node-staging-baseline.md` for exact setup steps.

**Full perf lab run with PERF_NODE_BASE_URL set (2026-05-31):**
- 15/17 PASS · 2 FAIL (Node auth — Supabase placeholder) · 0 SKIP · 2 critical
- safe_to_enable_rust: NO due to Node auth FAIL — **correct and expected**
- Rust 8/8 PASS independently: all server-compute 0ms

Once non-prod Supabase is wired and re-run:
- Expected: 17/17 PASS · 0 FAIL
- Expected safe_to_enable_rust: YES (staging only)

---

## Soak Rules (from docs/rust-staging-soak.md)

**PASS requires all:**
- 0 restarts (or only Railway rolling deploy restarts)
- No PANIC in logs
- No OOM
- No 5xx spikes
- Memory stable (not growing monotonically)
- p50 server-compute still 0–1ms at T+24h

**FAIL on any of:**
- Crash loop or unexpected restarts → investigate before production cutover
- PANIC in logs → open Rust bug, block production
- OOM → profile heap, check DB connection pool
- 5xx spike → trace and fix before proceeding
- p50 server-compute > 5ms at T+24h
