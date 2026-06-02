# Phase 2C.17 — Staging-Pair JWT Decoupling & Canary Monitoring

**Status:** PASSED (isolation complete) — Owner Briefing **GA PENDING** clean 24h canary
**Date:** 2026-06-02
**Builds on:** Phase 2C.16 (Production Rust Sidecar Separation)

---

## Runtime Architecture (confirmed)

```
PRODUCTION                                   STAGING
vantro-flow-backend (Node)                   vantro-node-staging (Node)
   │  RUST_AUTOMATION_BASE_URL                   │  RUST_AUTOMATION_BASE_URL
   ▼  …vantro-automation-prod…                   ▼  …vantro-automation-staging…
vantro-automation-prod (Rust)                vantro-automation-staging (Rust)
   JWT = production_pair (64-char)              JWT = staging_pair (64-char)
```

- Production Node → `vantro-automation-prod` ✅ (confirmed `BASE_URL_host=vantro-automation-prod-production.up.railway.app`)
- Staging Node → `vantro-automation-staging` ✅ (confirmed `BASE_URL_host=vantro-automation-staging-production.up.railway.app`)
- Production Node does **not** point to staging Rust ✅
- Staging Node does **not** point to production Rust ✅
- Runtime services fully separate ✅

---

## Staging-Pair Secret Decoupling

A fresh 64-char `crypto.randomBytes(32)` secret was generated and set (via stdin, never printed) on **both** staging services so they share one identical staging-pair secret, distinct from production:

| Service | Secret | Deploy |
|---------|--------|--------|
| `vantro-node-staging` | staging_pair (64-char) | `railway up` → `881b6a69` Online |
| `vantro-automation-staging` | staging_pair (identical) | `railway up` → `597025eb` Online |
| `vantro-flow-backend` | production_pair (64-char, unchanged) | — |
| `vantro-automation-prod` | production_pair (identical) | — |

**Production/staging JWT_SECRET coupling removed: YES.** Production pair ≠ staging pair. Temp secret files deleted after use.

> Production JWT_SECRET was **not** modified in this phase (no mismatch found; prod pair already live from 2C.16).

---

## Harness Token Regeneration

`railway run node scripts/staging-setup-harness.js` (injects the live staging-pair secret):
- `cortex-lab/.env.test` regenerated ✅ (gitignored, not committed)
- `/api/auth/me` OWNER_A → 200 `userId=11111111…` ✅
- `/api/auth/me` OWNER_B → 200 `userId=22222222…` ✅

---

## Live Harness X (staging, new staging-pair secret)

**Run `ctx_mpwkmu68_c91ece8a`:**

| Category | Score | Result |
|----------|-------|--------|
| orchestration | 100% (1/0) | ✅ PASS |
| business_isolation | 100% (10/0) | ✅ PASS |
| approval_gate_safety | 100% (1/0) | ✅ PASS |
| **Overall** | **100/100** | ✅ **PASS** |

Critical failures: 0 · wrong-token probes returning 200: **0** · launch_blocker = **false**.

---

## Production Canary Monitoring

Verified production unaffected by staging changes (proves isolation):

| Tenant | HTTP | evidence | safe_to_show | confidence | source_types | autoexec=false |
|--------|------|----------|--------------|------------|--------------|----------------|
| OWNER_A | 200 | 4 | true | 0.9 | invoice+promise | all true |
| OWNER_B (empty) | 200 | 1 | **false** (no-evidence state) | 0.9 | invoice | all true |

- prod Node `/api/health`: alive ✅
- `vantro-automation-prod` `/health`: `{"ok":true}` ✅
- No fake evidence, no cross-tenant evidence (A=4 vs B=1) ✅
- No owner-briefing 5xx observed ✅
- External send flag: unset → **false** ✅
- No secret leakage in logs ✅

---

## GA Decision

**GA NOT YET declared.** The 24h canary window is incomplete — the canary clock effectively reset at the Phase 2C.16 dedicated-sidecar switch (prod Node deploy `c757cee1`, earlier today 2026-06-02). Owner Briefing remains in **production canary**.

**Remaining before GA:** ~24h of clean observation from the sidecar switch with no rollback triggers (5xx spike, fake/cross-tenant evidence, evidence-missing-but-safe_to_show=true, Rust instability, auth/security failure, external send).

CLAUDE.md feature table updated to reflect the **accurate current state**: `FEATURE_OWNER_BRIEFING_AGENT_ENABLED = ON (production canary), GA pending`.

---

## Rollback (ready)

- Instant disable: `FEATURE_OWNER_BRIEFING_AGENT_ENABLED=false` on `vantro-flow-backend`.
- Sidecar-specific: restore `RUST_AUTOMATION_BASE_URL` to `…vantro-automation-staging…` + redeploy.

---

## Remaining Architecture Caveat

Production and staging Rust sidecars now have **separate runtime + separate JWT secrets**, but **still share the same Postgres** (`DATABASE_URL`). True data isolation requires a dedicated staging Postgres — **Phase 2C.18**.

---

## Next Phase: 2C.18 — Dedicated Staging Postgres

1. Provision a separate Railway Postgres for staging.
2. Point `vantro-node-staging` + `vantro-automation-staging` `DATABASE_URL` at it.
3. Seed staging test data (OWNER_A/B) into the staging DB.
4. Re-run live Harness X against isolated staging DB.
5. Close the production 24h canary → declare Owner Briefing **GA**.
