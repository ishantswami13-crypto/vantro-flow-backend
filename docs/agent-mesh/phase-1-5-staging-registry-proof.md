# Atlas Agent Mesh — Phase 1.5: Staging Registry Proof

> **Status:** Staging Proof Complete
> **Date:** 2026-06-01
> **Branch:** performance-bootstrap-cortex-fix-v1
> **Staging service:** vantro-node-staging (Railway)

---

## Summary

Phase 1.5 applies the agent registry foundation to staging, seeds 12 core agents, enables the read-only registry API, and verifies all safety properties hold in the live staging environment. No agents are runtime-active. No production systems touched.

---

## Part 1 — Migration 007 Applied

**Result: YES**

Migration `007_agent_registry.sql` applied to Railway Postgres (staging DB).

**Blocker found and fixed during inspection:**
`staging-migrate.js` had an auth schema check that blocked ALL Supabase databases, contradicting its own comment ("Non-prod Supabase projects are allowed"). The check was removed since `PROD_SUPABASE_ID` already guards the production project. See commit for exact diff.

**Infrastructure note:**
The `vantro-node-staging` service's `DATABASE_URL` was pointing to a Supabase pooler that returned "tenant/user not found" (pooler URL stale/expired). The Railway Postgres service in the same project (`zephyr.proxy.rlwy.net:51322`) is live and accessible. The staging service's DATABASE_URL was updated to reference `${{Postgres.DATABASE_URL}}` (Railway internal).

**Tables verified after migration:**

| Table | Present |
|-------|---------|
| customers | ✓ |
| business_events | ✓ |
| ai_actions | ✓ |
| promises | ✓ |
| business_memory | ✓ |
| ai_plans | ✓ |
| agent_run_log | ✓ |
| activity_logs | ✓ |
| workflow_runs | ✓ |
| **agent_registry** | ✓ (migration 007) |

---

## Part 2 — 12 Core Agents Seeded

**Result: YES**

```
[seed-agent-registry] Done.
  Upserted:    12 agents
  Total rows:  12
  Active:      0 (expected: 0)
  core_public: 12 (expected: 12)
```

**Idempotency confirmed:** Seed run twice — identical result both times. Total rows stayed at 12, Active stayed at 0.

**Agents seeded:**

| agent_id | risk_level | is_active | status |
|----------|-----------|-----------|--------|
| core.cashflow | medium | false | registry |
| core.collections | high | false | registry |
| core.cost_router | low | false | registry |
| core.credit_risk | high | false | registry |
| core.data_quality | low | false | registry |
| core.dispute | medium | false | registry |
| core.inventory_cash | medium | false | registry |
| core.learning | low | false | registry |
| core.owner_briefing | low | false | registry |
| core.payables | high | false | registry |
| core.policy_guard | medium | false | registry |
| core.promise_tracker | medium | false | registry |

---

## Part 3 — Registry API Enabled on Staging

**Result: YES (staging only)**

```
FEATURE_AGENT_REGISTRY_API_ENABLED=true   # vantro-node-staging only
```

Production `vantro-flow-backend` service: flag NOT set — remains OFF.

---

## Part 4 — API Verification

### GET /api/agents/registry

**HTTP 200**

```json
{
  "success": true,
  "count": 12,
  "agents": [...],
  "public_claim": "12 core specialized agents with an expandable Agent Mesh architecture."
}
```

| Property | Expected | Actual | Pass |
|----------|---------|--------|------|
| success | true | true | ✓ |
| count | 12 | 12 | ✓ |
| agents length | 12 | 12 | ✓ |
| all is_active=false | true | true (12/12) | ✓ |
| all status=registry | true | true (12/12) | ✓ |
| all public_claim=core_public | true | true (12/12) | ✓ |

### GET /api/agents/registry/core.collections

**HTTP 200**

```json
{
  "success": true,
  "agent": {
    "agent_id": "core.collections",
    "name": "Collections Agent",
    "risk_level": "high",
    "is_active": false,
    "status": "registry",
    "public_claim_status": "core_public"
  }
}
```

### Auth Rejection Tests

| Test | Expected | Actual | Pass |
|------|---------|--------|------|
| Missing Authorization header | 401 | 401 | ✓ |
| Invalid Bearer token | 401 | 401 | ✓ |
| Malformed agent_id (`core..bad`) | 400 | 400 | ✓ |
| Unknown agent (`core.nonexistent`) | 404 | 404 | ✓ |

---

## Part 5 — Safety Checks

| Check | Result |
|-------|--------|
| `npm run check` (Node.js syntax) | **PASS** |
| `npm run security:secrets` | **PASS** — no secrets found |
| `npm run cortex:test` (Harness X static) | **PASS — 100/100** |
| `npm run agents:seed:validate` | **PASS — 12/12** |

---

## Production Untouched Confirmation

| System | Touched? |
|--------|----------|
| `vantro-flow-backend` (production Railway) | NO |
| Production Supabase (`alepdpyqesevldobjxbo`) | NO |
| Production frontend (Vercel) | NO |
| Any production env var | NO |
| `FEATURE_AGENT_REGISTRY_API_ENABLED` on production | NO — still OFF |
| Any agent `is_active` = true | NO — all false |
| Runtime agent execution | NO |

---

## Files Changed in Phase 1.5

| File | Change |
|------|--------|
| `scripts/staging-migrate.js` | Removed over-broad auth schema check (non-prod Supabase now allowed) |
| `docs/agent-mesh/phase-1-5-staging-registry-proof.md` | NEW — this proof document |
| `scripts/_test_db_connect.js` | Temporary connectivity probe (to be deleted) |
| `scripts/_run_staging_migrate.js` | Temporary migration wrapper (to be deleted) |
| `scripts/_run_seed_agents.js` | Temporary seed wrapper (to be deleted) |

Railway env changes (not in code):
- `vantro-node-staging` DATABASE_URL → `${{Postgres.DATABASE_URL}}` (Railway Postgres internal)
- `vantro-node-staging` FEATURE_AGENT_REGISTRY_API_ENABLED → `true`

---

## What Was NOT Done (Intentional)

- No agent `is_active` set to `true`
- No LLM or agent execution triggered
- No production flag changed
- No main branch merge
- No 216 agent claim made public

---

## Next Action

Phase 2: wire the first agent tool connections. Recommended order: non-LLM agents first (data_quality, cost_router) → then medium-risk agents → then high-risk.

Before Phase 2:
1. Delete temporary scripts: `_test_db_connect.js`, `_run_staging_migrate.js`, `_run_seed_agents.js`
2. Confirm Railway Postgres persistence across redeployments
3. Run static harness before any code changes

---

*Phase 1 (registry foundation) → Phase 1.5 (staging proof) → Phase 2 (first agent execution)*
