# Phase 2C.16 — Production Rust Sidecar Separation

**Status:** PASSED — production Node switched to dedicated prod Rust sidecar; evidence validated; Harness X 100/100
**Date:** 2026-06-02
**Builds on:** Phase 2C.15 (Production Owner Briefing Rollout)

---

## Completion Results (2026-06-02)

**Service:** `vantro-automation-prod` (ID `91abf019-fbac-4fc7-bc00-2e2a119c83ec`), URL `https://vantro-automation-prod-production.up.railway.app`, Config File `vantro-automation-rs/railway.toml`.

**Runtime fix:** Initial deploy health-failed because Railway's edge proxy routes to `PORT`, which was unset while the binary binds `RUST_AUTOMATION_PORT=3002`. Setting `PORT=3002` (matching staging) + re-`railway up` (local Phase 2C.13 tree, build-cache fast) → `/health` = `{"ok":true,"service":"vantro-automation-rs","version":"0.1.0"}`.

**Direct prod-sidecar evidence proof (prod-pair token, before Node switch):** HTTP 200, `evidence[]=4` (invoice×?, promise), real `source_id`s, scoped to OWNER_A.

**Atomic paired switch (prod Node deploy `c757cee1`):** staged `RUST_AUTOMATION_BASE_URL=…vantro-automation-prod…` + pending prod-pair `JWT_SECRET` with `--skip-deploys`, then `railway up` (local Phase 2C.13 code) → both landed in one deploy. Confirmed env: `BASE_URL_host=vantro-automation-prod-production.up.railway.app`, `JWT_len=64`, `OB_FLAG=true`, `RUST_ENABLED=true`, `EXTERNAL_SEND=unset(false)`.

**Post-switch production validation:**
| Check | Result |
|-------|--------|
| prod Node `/api/health` | alive ✅ |
| missing token / invalid token → OB | 401 / 401 ✅ |
| OWNER_A OB | 200, evidence=4, safe_to_show=true, confidence=0.9, claims 2/2, source_types invoice+promise ✅ |
| OWNER_B (empty) | 200, safe_to_show=false (`ALL_CLAIMS_BLOCKED`) → no-evidence state ✅ |
| all actions `safe_to_auto_execute=false` | true ✅ |
| risky actions `approval_required=true` | true ✅ |
| no fake / no cross-tenant evidence | confirmed (A=4 vs B=1) ✅ |
| Live Harness X | 100/100; business_isolation 10/0 (zero wrong-token 200s); approval_gate, orchestration PASS ✅ |
| External send | unset → false ✅ |

**Secret decoupling:** production pair (prod Node + prod Rust = prod-pair 64-char secret) is LIVE and distinct from staging. Staging pair (staging Node + staging Rust) still running the prior secret with `staging_pair` rotation staged via `--skip-deploys` (pending optional deploy). Production and staging **no longer share a secret**. Temp secret files deleted.

**Rollback (ready):** `railway variable set RUST_AUTOMATION_BASE_URL=https://vantro-automation-staging-production.up.railway.app` then redeploy, OR `FEATURE_OWNER_BRIEFING_AGENT_ENABLED=false` for instant disable.

**launch_blocker = false. Phase 2C.16 COMPLETE.**

---

## Objective

Separate the production and staging Rust sidecars so they have independent:
- Railway services
- JWT_SECRET values
- Deploy lifecycles
- Logs and rollback paths

---

## Old Architecture (Current State)

```
vantro-flow-backend (Production Node)  ──┐
                                          ├──→ vantro-automation-staging (Rust sidecar)
vantro-node-staging (Staging Node)     ──┘

All three share the same JWT_SECRET.
```

**Risk:** A Rust sidecar update or failure affects both production and staging simultaneously. A shared JWT_SECRET means production and staging are cryptographically coupled.

---

## Target Architecture

```
vantro-flow-backend (Production Node) ──→ vantro-automation-prod (NEW, Production Rust)
vantro-node-staging (Staging Node)    ──→ vantro-automation-staging (Staging Rust only)

Independent JWT_SECRETs:
  Production pair: vantro-flow-backend + vantro-automation-prod → PROD_JWT_SECRET
  Staging pair:    vantro-node-staging + vantro-automation-staging → STAGING_JWT_SECRET
```

---

## Service Configurations

### vantro-automation-prod (NEW)

**Railway Settings (must set in Railway UI):**
- Root Directory: *(repo root — leave blank)*
- Config File: `vantro-automation-rs/railway.toml`

**Environment Variables (set via CLI after service creation):**

| Variable | Value | Notes |
|----------|-------|-------|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | Railway reference to shared Postgres |
| `JWT_SECRET` | *Production-specific 64-char hex* | Must match `vantro-flow-backend` JWT_SECRET |
| `NODE_ENV` | `production` | |
| `RUST_AUTOMATION_API_ENABLED` | `true` | |
| `RUST_AUTOMATION_PORT` | `3002` | |

**Build:** NIXPACKS, `cargo build --release --target x86_64-unknown-linux-musl --features server`
**Start:** `/app/bin/cortex-core`
**Health check:** `GET /health` → `{"ok": true}` HTTP 200
**Restart policy:** ON_FAILURE, max 3 retries

### vantro-automation-staging (existing — no change to config file/build)

**JWT_SECRET:** Updated to staging-specific secret (decoupled from production)

---

## Required Env Var Names (reference — values not stored here)

**Rust sidecar (both prod and staging):**
- `DATABASE_URL` — Postgres connection (REQUIRED)
- `JWT_SECRET` — JWT validation (REQUIRED, must match paired Node service)
- `NODE_ENV` — deployment environment
- `RUST_AUTOMATION_API_ENABLED` — feature gate
- `RUST_AUTOMATION_PORT` — HTTP port (default 3002)

**Optional (not currently used):**
- `REDIS_URL` — L2 cache
- `NATS_URL` — event publishing
- `TEMPORAL_HOST` — workflow scheduling

---

## Deployment Steps

### Step 1 — Create vantro-automation-prod (Railway UI)

1. Go to Railway project dashboard
2. **+ New Service → GitHub Repo** → `ishantswami13-crypto/vantro-flow-backend`
3. Service name: **`vantro-automation-prod`**
4. After creation → **Settings** → **Config File**: `vantro-automation-rs/railway.toml`

### Step 2 — Set Variables (CLI)

```bash
cd I:/Vantro/vantro-flow-backend
railway service vantro-automation-prod

# DATABASE_URL via Railway reference (safe — no hardcoded URL)
railway variable set "DATABASE_URL=\${{Postgres.DATABASE_URL}}" NODE_ENV=production RUST_AUTOMATION_API_ENABLED=true RUST_AUTOMATION_PORT=3002 --skip-deploys

# JWT_SECRET via stdin (never printed)
<prod_secret> | railway variable set JWT_SECRET --stdin
```

### Step 3 — Deploy

```bash
railway service vantro-automation-prod
railway up --detach
```

### Step 4 — Verify Health

```bash
curl https://vantro-automation-prod-production.up.railway.app/health
# Expected: {"ok": true, "service": "vantro-automation-rs", "version": "0.1.0"}
```

### Step 5 — Decouple JWT_SECRETs

```bash
# Set production pair: production Node + production Rust sidecar → same PROD_SECRET
railway service vantro-flow-backend
<prod_secret> | railway variable set JWT_SECRET --stdin --skip-deploys

# Set staging pair: staging Node + staging Rust sidecar → same STAGING_SECRET
railway service vantro-node-staging
<staging_secret> | railway variable set JWT_SECRET --stdin --skip-deploys
railway service vantro-automation-staging
<staging_secret> | railway variable set JWT_SECRET --stdin --skip-deploys
```

### Step 6 — Switch Production Node to Production Sidecar

```bash
railway service vantro-flow-backend
railway variable set "RUST_AUTOMATION_BASE_URL=https://vantro-automation-prod-production.up.railway.app" --skip-deploys
railway up --detach
```

### Step 7 — Redeploy Services

```bash
# Redeploy all changed services
railway service vantro-flow-backend && railway up --detach
railway service vantro-node-staging && railway up --detach
railway service vantro-automation-staging && railway redeploy --yes
```

### Step 8 — Verify Production Evidence Still Flows

```bash
curl -s https://vantro-flow-backend-production.up.railway.app/api/health
# Then test owner briefing with OWNER_A token
```

---

## Rollback Plan

**Instant rollback to old shared sidecar:**
```bash
railway service vantro-flow-backend
railway variable set "RUST_AUTOMATION_BASE_URL=https://vantro-automation-staging-production.up.railway.app" --skip-deploys
railway redeploy --yes
```

**Or instant feature flag disable:**
```bash
railway service vantro-flow-backend
railway variable set FEATURE_OWNER_BRIEFING_AGENT_ENABLED=false
```

---

## Canary Protection

After sidecar switch, monitor for 24 hours:
- No production owner briefing 500 errors
- evidence.length > 0 for tenants with data
- safe_to_show=true only with evidence
- No cross-tenant evidence
- audit_logs show `owner_briefing_generated`
- Rust prod sidecar health stable

Rollback triggers: 500 spike, missing evidence with safe_to_show=true, auth failure, Rust instability.

---

## Status: AWAITING Railway UI Service Creation

**Blocked on:** User must create `vantro-automation-prod` service in Railway UI and set Config File to `vantro-automation-rs/railway.toml`. All CLI steps are prepared and ready to execute.

---

## Acceptance Criteria Checklist

- [ ] `vantro-automation-prod` service created
- [ ] Config File set to `vantro-automation-rs/railway.toml`
- [ ] Variables set (DATABASE_URL, JWT_SECRET, NODE_ENV, RUST_AUTOMATION_API_ENABLED)
- [ ] Service deployed and health check passes
- [ ] `vantro-flow-backend` RUST_AUTOMATION_BASE_URL points to prod sidecar
- [ ] Prod and staging JWT_SECRETs are independent (no shared coupling)
- [ ] Production owner briefing evidence still flows (evidence.length > 0)
- [ ] Staging harness X still 100/100
- [ ] No incidents during switch
- [ ] Rollback documented and tested

---

## Next Phase: 2C.17 — 24-Hour Canary Close and GA Declaration

After Phase 2C.16 is complete and 24-hour canary window passes with no incidents:
1. Declare Owner Briefing feature Generally Available
2. Update CLAUDE.md to reflect production-ready status
3. Plan Phase 2C.18: Owner Briefing UI polish and MSME user testing
