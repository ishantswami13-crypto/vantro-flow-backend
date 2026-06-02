# Phase 2C.9 — Live Harness X Setup

**Status:** PASSED (setup infrastructure)  
**Date:** 2026-06-02  
**Builds on:** Phase 2C.8 (Owner Briefing command layer verified)

---

## Objective

Unblock the 5 `N/A` Harness X categories by wiring up live mode with:
- A token generation script for two staging test accounts
- A gitignored `cortex-lab/.env.test` holding credentials
- Config update to auto-load `.env.test` with override priority
- Clear one-command setup for any future run

The live harness proves: auth sanity, cross-tenant isolation, credit-sale orchestration, event/audit completeness, external-send flag safety, and approval gate correctness.

---

## Files Changed

| File | Change |
|------|--------|
| `scripts/generate-test-tokens.js` | New script — logs in two staging accounts, writes `cortex-lab/.env.test` |
| `cortex-lab/.env.test.example` | New template — documents all required env vars |
| `cortex-lab/config.js` | Loads `cortex-lab/.env.test` with `override: true` after root `.env` |
| `.gitignore` | Added `cortex-lab/.env.test` |

---

## Live Mode Requirements

Harness X live mode (`npm run cortex:test:live`) requires:

| Variable | Source | Required |
|----------|--------|----------|
| `CORTEX_TEST_BASE_URL` | Staging Railway URL | **Yes** |
| `CORTEX_TEST_TOKEN_OWNER_A` | Staging JWT, account A | **Yes** |
| `CORTEX_TEST_TOKEN_OWNER_B` | Staging JWT, account B (different user) | **Yes** |
| `CORTEX_TEST_DB_ALLOW_WRITE` | Must be `true` | **Yes** |
| `NODE_ENV` | Must not be `production` | **Yes** |
| `CORTEX_TEST_SUPABASE_URL` | Separate test Supabase project | Optional |
| `CORTEX_TEST_SUPABASE_KEY` | Service role key for test project | Optional |

Without `CORTEX_TEST_SUPABASE_URL`, DB-level event/audit assertions are skipped but auth + cross-tenant HTTP probes run normally.

---

## Setup (One-Time)

### Step 1 — Create two staging test accounts

If you don't have them yet, create via the staging signup form or curl:

```bash
# Account A
curl -X POST https://vantro-flow-backend-staging.up.railway.app/api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"harness-a@example.com","phone":"+919900000001","business_name":"Harness A","password":"HarnessTest1!"}'

# Complete OTP verification (WhatsApp/email), then repeat for Account B
```

### Step 2 — Generate tokens

```bash
cd I:/Vantro/vantro-flow-backend

node scripts/generate-test-tokens.js \
  --base-url https://vantro-flow-backend-staging.up.railway.app \
  --owner-a harness-a@example.com:HarnessTest1! \
  --owner-b harness-b@example.com:HarnessTest2!
```

This writes `cortex-lab/.env.test` (gitignored).

### Step 3 — Run live harness

```bash
npm run cortex:test:live
```

Or all modes:

```bash
npm run cortex:test:all
```

---

## What Live Mode Tests

| Test | Category | Checks |
|------|----------|--------|
| `auth-sanity` | `business_isolation` | Owner A token valid, Owner B token valid, bad token → 401 |
| `cross-tenant-read-probes` | `business_isolation` | Owner B cannot read Owner A's inventory/invoices/analytics |
| `external-send-flag-off` | `approval_gate_safety` | `FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED` is off |
| `credit-sale-orchestration` | `orchestration`, `event_audit_completeness` | Credit sale creates event + audit log (needs test DB) |
| `approval-gate-firm-reminder` | `approval_gate_safety` | SEND_FIRM_REMINDER has `requires_approval = true` |

---

## Sandbox Guard

The live runner triple-gates against production:

1. `NODE_ENV` must not be `production`
2. `CORTEX_TEST_DB_ALLOW_WRITE` must be `true`
3. `CORTEX_TEST_BASE_URL` must not match production deny-list:
   - `vantro-flow-backend-production.up.railway.app`
   - `flow.vantro.ai`, `app.vantro.ai`, `api.vantro.ai`
   - Any URL containing the string `prod`
4. `CORTEX_TEST_SUPABASE_URL` (if set) must differ from `SUPABASE_URL`

The token generation script also refuses production hosts at arg-parse time.

---

## Security Notes

- `cortex-lab/.env.test` is gitignored and must never be committed
- Tokens are 30-day JWTs — regenerate before they expire
- Test accounts should use `@example.com` or private relay addresses
- All seeded test rows are tagged with the run ID (`[cortex-test ctx_...]`) and cleaned up after each run
- The harness never sends real WhatsApp messages (external send flag must be off)

---

## RLS Migration 006 — Status

Migration `006_cortex_rls.sql` enables RLS and creates `auth.uid()`-based policies on all Cortex tables. **It is safe to apply** because:

- The backend uses the Supabase **service role key**, which bypasses RLS entirely — no backend queries break
- The policies use `auth.uid()` which maps to Supabase Auth, not our custom JWT — so policies are currently a no-op for backend connections
- Applying it now closes an anon-key exposure path as defence-in-depth (even if that path isn't currently open)

**To apply:** run the migration SQL directly in your Supabase SQL editor. No code change required. Backend queries are unaffected (service role bypass).

The auth bridge (mapping our custom JWT `userId` claim to `auth.uid()`) is deferred to post-launch Phase 3.

---

## Next Phase

Phase 2C.10 — Owner Briefing production rollout gate:
- Live Harness X must pass (all non-N/A categories ✅)
- Set `FEATURE_OWNER_BRIEFING_AGENT_ENABLED=true` in Railway staging
- Run owner briefing live test against staging
- If passes: enable in Railway production

---

## Test Results

| Action | Result |
|--------|--------|
| `node --check scripts/generate-test-tokens.js` | ✅ 0 syntax errors |
| `cortex-lab/config.js` syntax | ✅ 0 errors |
| `.env.test.example` present | ✅ |
| `cortex-lab/.env.test` gitignored | ✅ |
| Live run (requires staging credentials) | ⏳ Pending — run after Step 2 above |
