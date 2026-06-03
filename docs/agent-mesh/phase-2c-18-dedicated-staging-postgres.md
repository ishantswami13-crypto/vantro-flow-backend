# Phase 2C.18 — Dedicated Staging Postgres (Supabase Free)

**Status:** ✅ COMPLETE — staging Supabase switch live, `users` schema aligned, live Harness X 100/100, production untouched
**Date:** 2026-06-02 (executed 2026-06-03)
**Builds on:** Phase 2C.17 (Staging-Pair JWT Decoupling & Canary Monitoring)

> Result sections marked **⏳ PENDING EXECUTION** are filled in only after the live
> migrate → seed → RLS → Railway switch → live Harness X run completes. Nothing in
> this document contains secrets (no DATABASE_URL, password, keys, or tokens).

---

## 1. Why this phase exists

Phase 2C.17 isolated the staging **runtime + JWT secret** from production, but left one
shared resource:

> "Production and staging Rust sidecars now have separate runtime + separate JWT secrets,
> but **still share the same Postgres** (`DATABASE_URL`). True data isolation requires a
> dedicated staging Postgres — Phase 2C.18."

This phase gives staging its **own** Postgres so staging reads/writes can never touch
production data.

## 2. Railway DB blocker → Supabase Free workaround

- **Blocker:** Railway could not provision a second Postgres — Trial disk limits, and no
  card/UPI available to lift the plan.
- **Workaround:** Use **Supabase Free** as the dedicated staging Cortex Postgres.

| Field | Value |
|-------|-------|
| Project name | `vantro-cortex-staging-db` |
| Provider | Supabase Free |
| Region | Southeast Asia / Singapore / `ap-southeast-1` |
| Connection | Direct persistent **and** Transaction pooler both available |
| Secret handling | Direct URL pasted privately into gitignored `.env.staging` as `STAGING_DATABASE_URL` — never into chat, never committed |

**Side action:** the old Supabase project `vantro-node-staging` was **paused (not deleted)**
to free a Supabase Free project slot. Production untouched.

## 3. Topology

### Old (pre-2C.18)
```
PRODUCTION                          STAGING
vantro-flow-backend (Node) ─┐       vantro-node-staging (Node) ─┐
vantro-automation-prod (Rust)│      vantro-automation-staging ──┤
                             └──────────── shared Postgres ◄─────┘
                                      (staging shared prod DATABASE_URL)
```

### New (target 2C.18)
```
PRODUCTION                          STAGING
vantro-flow-backend (Node) ─┐       vantro-node-staging (Node) ─┐
vantro-automation-prod (Rust)│      vantro-automation-staging ──┤
        ▼                    │              ▼                    │
  prod Postgres  ◄───────────┘     vantro-cortex-staging-db ◄────┘
  (UNCHANGED)                       (Supabase Free, ap-southeast-1)
```

Production DATABASE_URL is **not** modified. Only the two staging services repoint.

## 4. Staging migration / seed plan (direct `pg`, single secret)

Driven entirely by the Direct connection URL in `.env.staging` — no Supabase Management
API token required. Order chosen so seeding runs before RLS is enabled.

| # | Action | Command | Notes |
|---|--------|---------|-------|
| 1 | Base schema + migrations 001–005, 007 | `node scripts/staging-migrate.js` | Skips `006_cortex_rls.sql` (uses `auth.uid()`). Idempotent (`IF NOT EXISTS`). Blocks prod Supabase id. |
| 2 | Create `public.sales` | `node scripts/apply-sql-file.js scripts/supabase/phase-2c-10c-script-a-create-sales.sql` | `CREATE TABLE IF NOT EXISTS public.sales` + indexes. |
| 3 | Seed OWNER_A / OWNER_B | `node scripts/staging-seed.js` | OWNER_A = evidence-producing rows; OWNER_B = minimal (no-evidence state). |
| 4 | Apply Supabase-safe RLS | `node scripts/apply-sql-file.js scripts/supabase/phase-2c-10c-script-c-rls-006-plus-sales.sql` | RLS 006 + sales. `auth.uid()` policies. Service role bypasses → zero backend impact. |

All four read `DATABASE_URL` from the environment (sourced from `.env.staging`), so the
URL is never printed or committed.

**Compatibility fix applied this phase:** `scripts/staging-seed.js` previously blocked
*all* `supabase.co` URLs (and, by substring, the `*.pooler.supabase.com` host), which made
seeding the dedicated staging Supabase impossible. It now blocks only the **production
Supabase project id** (`alepdpyqesevldobjxbo`) and `vantro.in`, exactly like
`scripts/staging-migrate.js`. Production protection is unchanged.

**Tables present after the plan** (migrations 001–005/007 + Script A):
`users, customers, invoices, sales (public.sales), promises, followups, call_logs,
products, purchases, suppliers, ai_actions, ai_plans, tool_calls, policy_decisions,
audit_logs, business_events, customer_scores, cashflow_events, business_memory, tasks,
workflow_runs` (+ agent registry from 007).

## 5. RLS (Supabase-safe)

- File: `scripts/supabase/phase-2c-10c-script-c-rls-006-plus-sales.sql`.
- Enables RLS + `user_id = auth.uid()` SELECT/ALL policies on 14 Cortex tables + `sales`.
- Backend authenticates with the **Supabase service role key**, which bypasses RLS →
  staging routes keep working. RLS only engages if an anon/user JWT ever hits the DB directly.
- Applied **after** seeding so the seed insert path is never affected.

## 6. Staging Railway service switch (ONLY staging)

Target Railway project: `handsome-stillness` (env `production`), service IDs:
`vantro-node-staging` = `558e7fa3…`, `vantro-automation-staging` = `6a2b75bb…`.

**IMPORTANT discovery (corrects the original Step-6 plan):** this backend reads most
data over the **Supabase JS REST client** (`lib/config/supabaseClient.js`,
`SUPABASE_URL` + `SUPABASE_KEY`/`SUPABASE_SERVICE_ROLE_KEY`) — e.g. `/api/auth/me` does
`supabase.from('users')`. Only multi-statement transactions (`lib/db/pg.js`) and the Rust
sidecar (`sqlx`) use `DATABASE_URL`. So switching `DATABASE_URL` alone is **not** enough:
because the old staging Supabase project was paused, the REST client 500s.

Variables to set on **each** staging service (and nothing on prod):

| Var | New value | Source |
|-----|-----------|--------|
| `DATABASE_URL` | new Supabase direct URL | from `.env.staging` (✅ done, verified `ref` matches) |
| `SUPABASE_URL` | `https://<newref>.supabase.co` | derived from the `DATABASE_URL` host ref (no new secret) |
| `SUPABASE_SERVICE_ROLE_KEY` | new project service-role key | **new secret — from Supabase dashboard → Settings → API** |
| `SUPABASE_KEY` | new project service-role key | set equal to service-role key (supabaseClient checks `SUPABASE_KEY` first) |

All values set via Railway `variable set --stdin` / derived in-process — **never printed**.
Then redeploy the staging pair.

**Untouched (hard rule):** `vantro-flow-backend`, `vantro-automation-prod`,
production `DATABASE_URL`, `FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED` (stays OFF).

**Execution note (2026-06-03):** `SUPABASE_URL` (derived in-process from the
`STAGING_DATABASE_URL` ref), `SUPABASE_SERVICE_ROLE_KEY`, and `SUPABASE_KEY` were set on
both staging services via `railway variable set <KEY> --stdin --skip-deploys` (values piped
on stdin — never in argv, never printed), followed by one `railway redeploy` each.
`.env.staging` had a UTF-8 BOM + mixed CRLF, so the appendix's `source ./.env.staging`
would have silently dropped `STAGING_DATABASE_URL`; values were parsed BOM/CR-safe instead.

**Schema gap found + fixed:** after the switch, `/api/auth/me` 500'd — `staging-migrate.js`
`BASE_SCHEMA` had created `users` as a stub (`id, email, name, password, created_at`), so
the handler's `fullColumns` **and** its `coreColumns` fallback both hit
`42703 column users.phone does not exist`. Fix: `scripts/supabase/phase-2c-18-users-schema-align.sql`
(idempotent `ADD COLUMN IF NOT EXISTS` for the production-shaped `users` columns + a
non-clobbering backfill of the two harness owners), applied via `apply-sql-file.js`.
`staging-migrate.js` `BASE_SCHEMA` was also hardened so future staging rebuilds create the
full `users` table directly. Staging-only; production schema untouched.

## 7. Harness token regeneration

```
railway run --service vantro-node-staging node scripts/staging-setup-harness.js
```
Confirms OWNER_A / OWNER_B `/api/auth/me` → 200, regenerates the gitignored
`cortex-lab/.env.test`, prints **no** tokens.

## 8. Live Harness X — ✅ PASS (2026-06-03, run `ctx_mpxq2jqk_85b59cdf`)

```
npm run cortex:test:live   # (or: railway run npm run cortex:test:live)
```

| Category | Score | Result |
|----------|-------|--------|
| orchestration | 100% (1/0) | ✅ |
| business_isolation | 100% (10/0) | ✅ |
| approval_gate_safety | 100% (1/0) | ✅ |
| **Overall** | **100 / 100** | ✅ PASS |

Pass gates met: wrong-token probes returning 200 = **0** (`cross-tenant-read-probes` pass;
`business_isolation` gate 100/100, required 100), `launch_blocker = false`
(`scorecard.critical = []`, `scorecard.pass = true`). Scenarios: `auth-sanity`,
`cross-tenant-read-probes`, `external-send-flag-off`, `credit-sale-orchestration`,
`approval-gate-firm-reminder` — all pass. Lone warning: `Test Supabase client unavailable:
missing_url_or_key` (DB-level event/audit assertions intentionally skipped —
`CORTEX_TEST_SUPABASE_URL/KEY` unset by design).

> The first run scored 97/100 due to a single transient `status:0` (connection drop) on
> `auth-sanity/owner_a`; the clean re-run scored 100/100. Not an isolation breach.

## 9. Production untouched verification — ✅ CONFIRMED (2026-06-03)

- prod Node `/api/health` → **200 `status:alive`** ✅
- `vantro-automation-prod` `/health` → **200 `{ok:true}`** ✅
- Owner Briefing canary (`FEATURE_OWNER_BRIEFING_AGENT_ENABLED=true`) → **clean**: no
  5xx / agent-execution / RAG-evidence errors in recent prod logs; only unauthenticated
  4xx probes (404 `…core.owner_briefing/preview`, 401 `/api/ml/briefing`, `userId=null`) ✅
- production `DATABASE_URL` unchanged → **not touched** (only the two staging services
  were modified; the switch helper hard-blocks prod service names) ✅
- external send flag → `FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED` **unset/false** ✅

> Observation (NOT caused by this phase): `vantro-automation-prod` showed a Railway
> "Deploy failed" badge for a *new* deploy attempt that never cut over; the last-good
> deployment serves `/health` 200. Flagging for a separate look — unrelated to the staging switch.

## 10. Rollback plan

1. **Staging DB switch rollback:** restore the previous `DATABASE_URL` on
   `vantro-node-staging` + `vantro-automation-staging` and redeploy. (The old shared value
   is recoverable from Railway variable history / the prod service.)
2. **Schema/RLS:** non-destructive — all DDL is `IF NOT EXISTS` / `DROP POLICY IF EXISTS`;
   nothing is dropped. The paused old Supabase `vantro-node-staging` project can be resumed
   if needed.
3. **Owner Briefing safety net (unchanged):** `FEATURE_OWNER_BRIEFING_AGENT_ENABLED=false`
   on `vantro-flow-backend` is the instant kill switch.
4. Production is never modified, so production rollback is N/A.

## 11. Remaining caveat (carried forward)

Production **Neon → Cortex data pipeline** is still **not solved**. This phase isolates
staging's database; it does not build the production data pipeline. That remains a separate
follow-up.

---

## Appendix — exact run order (once `.env.staging` has `STAGING_DATABASE_URL`)

```bash
cd I:/Vantro/vantro-flow-backend
set -a; . ./.env.staging; set +a            # load STAGING_DATABASE_URL (not printed)
export DATABASE_URL="$STAGING_DATABASE_URL" # for the migrate/seed/apply scripts

node scripts/staging-migrate.js
node scripts/apply-sql-file.js scripts/supabase/phase-2c-10c-script-a-create-sales.sql
node scripts/staging-seed.js
node scripts/apply-sql-file.js scripts/supabase/phase-2c-10c-script-c-rls-006-plus-sales.sql

# Switch ONLY staging services (value from env, never printed):
railway variables --set "DATABASE_URL=$STAGING_DATABASE_URL" --service vantro-node-staging
railway variables --set "DATABASE_URL=$STAGING_DATABASE_URL" --service vantro-automation-staging
railway redeploy --service vantro-node-staging -y
railway redeploy --service vantro-automation-staging -y

# Regenerate tokens + run live harness:
railway run --service vantro-node-staging node scripts/staging-setup-harness.js
npm run cortex:test:live
```
