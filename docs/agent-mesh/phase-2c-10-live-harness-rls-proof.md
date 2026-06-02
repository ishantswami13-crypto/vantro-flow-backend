# Phase 2C.10 — Live Harness X & RLS Proof Gate

**Status:** PASSED — Live proof complete (Phase 2C.10C)
**Date:** 2026-06-02
**Builds on:** Phase 2C.9 (live harness setup infrastructure)

---

## Executive Summary

| Gate | Method | Result |
|------|--------|--------|
| Cross-tenant isolation (all 7 endpoints) | Static code analysis + live harness | ✅ PROVEN |
| `requireOwner` middleware enforcement | Static code analysis | ✅ PROVEN |
| RLS migration 006 — Supabase compatibility | Code review | ✅ SAFE TO APPLY |
| RLS migration 006 — Railway Postgres | Code review | ❌ NOT COMPATIBLE (`auth.uid()` missing) |
| Live harness infrastructure | Scripts built + syntax clean | ✅ READY |
| Live harness run | mode=live, run=ctx_mpw63127_f6a4f637 | ✅ PASSED 100/100 |
| Backend integrity post-RLS | Static analysis (service role bypasses) | ✅ PROVEN |
| `public.sales` table | Script A applied to vantro-node-staging | ✅ EXISTS |
| RLS 006 + sales RLS | Script C applied to vantro-node-staging | ✅ APPLIED |
| POST /api/sales orchestration | Live harness credit-sale-orchestration | ✅ PASS (was HTTP 500) |
| Wrong-token probes returning 200 | Live harness cross-tenant-read-probes (10 assertions) | ✅ ZERO |

**Live proof complete. All P0 gates passed. Phase 2C.10C is COMPLETE.**

---

## Part 1 — Cross-Tenant Isolation Static Proof

### Tested Endpoints

The live runner `crossTenantReadProbes` probes 7 endpoints using Owner B's token against Owner A's user ID. Result must be 403 or 404 — never 200.

| Endpoint | Line | Middleware | Cross-tenant result |
|----------|------|-----------|---------------------|
| `GET /api/invoices/:userId` | 1736 | `requireOwner` | **403 Forbidden** |
| `GET /api/metrics/:userId` | 2106 | `requireOwner` | **403 Forbidden** |
| `GET /api/analytics/:userId` | 2150 | `requireOwner` | **403 Forbidden** |
| `GET /api/inventory/:userId` | 2206 | `requireOwner` | **403 Forbidden** |
| `GET /api/cash-forecast/:userId` | 5351 | `requireOwner` | **403 Forbidden** |
| `GET /api/collections/summary/:userId` | 6066 | `requireOwner` | **403 Forbidden** |
| `GET /api/transactions/:userId` | 7956 | `requireOwner` | **403 Forbidden** |

**Verification command (already in codebase):**
```bash
grep -n "requireOwner\|authMiddleware\|requireAdmin" server.js | \
  grep -E "\/api\/(inventory|invoices|analytics|cash-forecast|transactions|collections\/summary|metrics)/:userId"
```

### `requireOwner` Enforcement Logic

```javascript
// server.js line 547
function requireOwner(req, res, next) {
  const { token, source } = getAuthToken(req);
  if (!token) return res.status(401).json({ error: 'Missing token' });
  req.user = verifyJWT(token);
  req.authSource = source;

  if (!requireCookieCsrf(req, res)) return;  // no-op for Bearer tokens (authSource !== 'cookie')

  const paramId = req.params.userId;
  if (paramId && req.user.userId !== paramId) {
    return res.status(403).json({ error: 'Forbidden' });  // ← CROSS-TENANT BLOCK
  }
  // …
}
```

**Proof chain:**
1. Harness uses `Authorization: Bearer <tokenB>` → `authSource = 'bearer'`
2. `requireCookieCsrf` returns `true` immediately (no-op) — CSRF only applies to cookie auth
3. `req.params.userId` = Owner A's UUID (`11111111-1111-1111-1111-111111111111`)
4. `req.user.userId` = Owner B's UUID (`22222222-2222-2222-2222-222222222222`)
5. `'22222222-...' !== '11111111-...'` → `true` → returns **403 Forbidden**

**This proof is deterministic and does not depend on the live environment.**

---

## Part 2 — RLS Migration 006 Analysis

### What It Does

Migration `006_cortex_rls.sql` enables Row Level Security on 14 Cortex tables and creates `user_id = auth.uid()` policies for SELECT and ALL operations.

### Where It Can Be Applied

| Environment | Compatible | Reason |
|-------------|-----------|--------|
| Supabase (production) | ✅ YES | Supabase provides `auth.uid()` |
| Supabase (non-prod / shadow) | ✅ YES | All Supabase projects have `auth.uid()` |
| Railway Postgres (staging) | ❌ NO | Plain Postgres — `auth.uid()` function does not exist |

The existing `staging-migrate.js` explicitly documents this:
```
// 006_cortex_rls.sql — SKIP: uses auth.uid() which is Supabase-specific.
// Plain Railway Postgres does not have this function.
```

### Why Applying to Supabase Production Is Safe

The backend uses the **Supabase service role key** (`SUPABASE_SERVICE_ROLE_KEY`). Supabase's service role bypasses RLS entirely — no backend queries are affected regardless of policies.

**Impact matrix:**

| Connection type | RLS active? | Effect |
|-----------------|-------------|--------|
| Backend (service role) | Bypassed | Zero impact — all queries work unchanged |
| Direct anon key (not in use) | Enforced | `auth.uid() = null` → zero rows returned for anon |
| Direct authenticated (not in use) | Enforced | `auth.uid()` maps Supabase Auth session |

**Result: Applying RLS is zero-risk for the backend and provides defence-in-depth against accidental anon exposure.**

### How to Apply (Supabase SQL Editor)

1. Open: https://supabase.com/dashboard/project/YOUR_REF/sql/new
2. Paste the contents of `migrations/006_cortex_rls.sql`
3. Click "Run"
4. Smoke-test in SQL Editor:
   ```sql
   SET ROLE anon;
   SELECT count(*) FROM ai_actions;  -- must return 0
   RESET ROLE;
   ```
5. Verify backend still works: `node scripts/security-smoke-test.js`

### How to Apply (Script — Requires Supabase Management API Token)

```bash
SUPABASE_ACCESS_TOKEN=sbp_xxx SB_PROJECT_REF=your-ref \
  node scripts/apply-rls-supabase.js
```

For production, add `CONFIRM_PRODUCTION=I-UNDERSTAND`.

---

## Part 3 — Live Harness Setup

### Current State

| Component | Status |
|-----------|--------|
| `scripts/staging-setup-harness.js` | ✅ Created — one-command setup |
| `scripts/generate-test-tokens.js` | ✅ Created (login-based alternative) |
| `cortex-lab/config.js` | ✅ Updated — loads `.env.test` with override priority |
| `cortex-lab/.env.test.example` | ✅ Created |
| `cortex-lab/.env.test` in `.gitignore` | ✅ Confirmed |
| Staging server (`vantro-flow-backend-staging.up.railway.app`) | ⚠️ URL returns Railway 404 — URL has changed |
| Correct staging URL | ⏳ User must confirm from Railway dashboard |

### Staging Server URL — Finding It

The correct staging URL is the `vantro-node-staging` Railway service domain.

**Where to find it:**
1. Railway Dashboard → Your Project → `vantro-node-staging` service
2. Settings → Domains → the Railway-assigned `.up.railway.app` URL

OR from CLI: `railway domain` (in the vantro-node-staging service context)

### One-Command Setup

Once you have the correct URL and JWT_SECRET from Railway:

```bash
JWT_SECRET=<staging-jwt-secret> \
CORTEX_TEST_BASE_URL=https://<your-actual-staging-url>.up.railway.app \
  node scripts/staging-setup-harness.js
```

This:
1. Generates 7-day JWTs for `OWNER_A (11111...1)` and `OWNER_B (22222...2)`
2. Health-checks the staging server
3. Verifies both tokens authenticate against `/api/auth/me`
4. Writes `cortex-lab/.env.test`

### Prerequisites Before Running

```bash
# 1. Seed staging Postgres (one-time — idempotent)
DATABASE_URL=<staging-postgres-url> node scripts/staging-seed.js

# 2. Apply migrations 001-005 if not already done
DATABASE_URL=<staging-postgres-url> node scripts/staging-migrate.js
```

### Running Live Harness

```bash
npm run cortex:test:live
```

Expected output: all 5 previously-N/A categories should now execute (not N/A).

---

## Part 4 — Launch Blocker Assessment

| Item | Status | Launch blocker? |
|------|--------|-----------------|
| Cross-tenant isolation | ✅ STATICALLY PROVEN | No |
| RLS migration 006 applied to Supabase | ⏳ Pending — SQL Editor run | **P1** (defence-in-depth) |
| Live harness: `business_isolation` | ⏳ Pending staging URL | **P0** |
| Live harness: `orchestration` | ⏳ Pending staging URL | **P0** |
| Live harness: `approval_gate_safety` | ⏳ Pending staging URL | **P0** |
| Live harness: `event_audit_completeness` (live) | ⏳ Pending staging URL + test DB | P1 |
| Staging server URL confirmed | ⏳ Check Railway dashboard | Unblocks live harness |
| JWT_SECRET from Railway | ⏳ Railway → Variables | Unblocks live harness |

**The only hard blockers for live harness execution are:**
1. Correct Railway staging URL (find in Railway dashboard)
2. `JWT_SECRET` from the Railway staging service environment

Static cross-tenant proof (all 7 endpoints → 403 on mismatch) means the cross-tenant isolation is structurally guaranteed regardless of live test results.

---

## Part 5 — Files Changed This Phase

| File | Change |
|------|--------|
| `scripts/staging-setup-harness.js` | New — one-command JWT generation + health check + `.env.test` writer |
| `scripts/apply-rls-supabase.js` | New — applies migration 006 via Supabase Management API |
| `docs/agent-mesh/phase-2c-10-live-harness-rls-proof.md` | This document |

---

## Part 6 — What To Run Today

```bash
# Step 1: Find staging URL and JWT_SECRET in Railway, then:
JWT_SECRET=xxx CORTEX_TEST_BASE_URL=https://your-staging.up.railway.app \
  node scripts/staging-setup-harness.js

# Step 2: Run live harness
npm run cortex:test:live

# Step 3: Apply RLS to Supabase (SQL Editor or script)
SUPABASE_ACCESS_TOKEN=sbp_xxx SB_PROJECT_REF=your-ref \
  node scripts/apply-rls-supabase.js

# Step 4: Verify no backend breakage
node scripts/security-smoke-test.js
```

---

## Part 7 — Static Harness Verification (Confirmed Still Passing)

```
mode=static   Overall: 100/100   Critical failures: 0   RESULT: PASS ✅
  policy_safety              100%   (17 pass)
  ai_hallucination_block     100%   (39 pass)
  event_audit_completeness   100%   (78 pass)
```

---

## Part 8 — Phase 2C.10C Live Proof (2026-06-02)

### Staging Environment

| Field | Value |
|-------|-------|
| Project | vantro-node-staging |
| Supabase Project ID | bbkbgnhycmfqosageqxa |
| Region | ap-southeast-1 |
| Run ID | ctx_mpw63127_f6a4f637 |
| Run mode | live |
| Started | 2026-06-02T04:58:25.183Z |
| Finished | 2026-06-02T04:59:09.983Z |

### SQL Scripts Applied (Supabase SQL Editor)

| Script | File | Status |
|--------|------|--------|
| Script A | `scripts/supabase/phase-2c-10c-script-a-create-sales.sql` | ✅ Applied |
| Script C | `scripts/supabase/phase-2c-10c-script-c-rls-006-plus-sales.sql` | ✅ Applied |

### Live Harness Results

| Category | Score | Assertions | Gate Threshold | Result |
|----------|-------|-----------|----------------|--------|
| orchestration | 100% | 1 pass / 0 fail | ≥90% | ✅ PASS |
| business_isolation | 100% | 10 pass / 0 fail | 100% | ✅ PASS |
| approval_gate_safety | 100% | 1 pass / 0 fail | 100% | ✅ PASS |
| event_audit_completeness | N/A | 0 (no test Supabase creds) | — | ⚪ N/A |
| learning_loop_quality | N/A | 0 (no test Supabase creds) | — | ⚪ N/A |
| action_quality | N/A | 0 (no test Supabase creds) | — | ⚪ N/A |
| **Overall** | **100/100** | **12 pass / 0 fail** | ≥90% | ✅ **PASS** |

### Key Gate Details

| Gate | Scenario | Result |
|------|----------|--------|
| POST /api/sales orchestration | `credit-sale-orchestration` | ✅ No longer HTTP 500 |
| Cross-tenant isolation (10 probes) | `cross-tenant-read-probes` | ✅ Zero wrong-token returned 200 |
| Auth sanity | `auth-sanity` | ✅ PASS |
| External send flag OFF | `external-send-flag-off` | ✅ PASS |
| Approval gate firm reminder | `approval-gate-firm-reminder` | ✅ PASS |

### `public.sales` Table

- **Exists:** Yes — Script A applied before live run
- **Indexes:** Applied (user_id, created_at, sale_date)
- **Schema cache:** Reloaded via `NOTIFY pgrst, 'reload schema'`

### RLS 006 + Sales RLS

- **Applied:** Yes — Script C applied to vantro-node-staging (Supabase)
- **Tables covered:** All 14 Cortex tables + public.sales
- **Backend impact:** Zero — service role key bypasses RLS entirely
- **Effect:** Defence-in-depth against accidental anon key exposure

### Warning (Non-Blocking)

```
"Test Supabase client unavailable: missing_url_or_key"
```

This is expected — the `.env.test` does not include `TEST_SUPABASE_URL` / `TEST_SUPABASE_KEY`. The N/A categories (`event_audit_completeness`, `learning_loop_quality`, `action_quality`) require a live test Supabase instance to run. They are not P0 launch blockers.

### Critical Failures

```
[]  ← zero critical failures
```

### Launch Blocker Assessment (Post 2C.10C)

| Item | Status | Launch blocker? |
|------|--------|-----------------|
| business_isolation (live) | ✅ 100% — 10 assertions pass | No |
| orchestration (live) | ✅ 100% — POST /api/sales works | No |
| approval_gate_safety (live) | ✅ 100% | No |
| Wrong-token → 200 | ✅ Zero occurrences | No |
| public.sales table | ✅ Exists | No |
| RLS 006 applied | ✅ Applied to Supabase | No |
| event_audit_completeness (live) | ⚪ N/A — needs test Supabase | P1 (not P0) |

**launch_blocker = false**

### Final Status: PHASE 2C.10C COMPLETE ✅

All P0 gates passed in live mode. Cross-tenant isolation is proven live (not just static). POST /api/sales orchestration is unblocked. RLS 006 + sales RLS applied to staging Supabase.

**Next phase: Phase 2C.11 — JWT_SECRET rotation + final staging security smoke test.**

⚠️ SECURITY REMINDER: The staging JWT_SECRET was exposed in conversation. Rotate it immediately in Railway → vantro-node-staging → Variables → JWT_SECRET. Generate a new secret (≥32 chars), update the value in Railway, redeploy the service, then re-run `node scripts/staging-setup-harness.js` with the new secret to regenerate `.env.test`.
