# Atlas Agent Mesh — Phase 2A.5: Data Quality Agent Staging Proof

> **Status:** COMPLETE — All proof gates passed
> **Date:** 2026-06-01
> **Branch:** performance-bootstrap-cortex-fix-v1
> **Commits:** 827e577 (CI fix) → 8928dd7 (schema fix)
> **Agent:** `core.data_quality` | Risk: Low | Mutations: NONE

---

## Summary

Phase 2A.5 proves the `core.data_quality` agent end-to-end on staging:
- Rust sidecar POST endpoint verified live
- Node preview GET endpoint verified live (Rust call succeeds)
- Auth rejection verified (401 for missing/invalid tokens)
- Mutation safety verified (zero DB row changes)
- Phase 2A invariants verified on staging data (safe_to_auto_fix=false, approval_required=true)
- Safety checks all pass
- Production untouched throughout

---

## CI Status

| Commit | Description | CI |
|--------|-------------|-----|
| `827e577` | fix(rust-fmt): fix cargo fmt --check failures | GREEN ✅ |
| `8928dd7` | fix(data-quality): accept camelCase Rust response in validateShape | Not separately CI'd (Node-only, syntax check passed locally) |

**CI jobs for 827e577 (all green):**
- cargo fmt / check / test (pure-Rust): SUCCESS
- cortex-lab static (no DB): SUCCESS
- server-feature offline build + auth tests (SQLX_OFFLINE=true): SUCCESS

**Root cause of original CI failure:** Two rustfmt violations in Phase 2A commit 7f7d28f:
1. `assert!(out.checks_run.contains(...))` — chain exceeded default `chain_width=60`, needed block form
2. `use vantro_automation_lib::agents::data_quality::{ CustomerRow, ..., evaluate }` — rustfmt places lowercase names before CamelCase types

---

## Deploy Status

| Service | Deployment ID | Timestamp | Status | Code |
|---------|--------------|-----------|--------|------|
| vantro-automation-staging (Rust) | `011c03de` | 2026-06-01 12:09 IST | SUCCESS | 827e577 |
| vantro-node-staging (Node) | `aecf32fd` | 2026-06-01 12:35 IST | SUCCESS | 8928dd7 |

**Production services:** NOT touched. `vantro-flow-backend` has no data quality flag, no code change.

---

## Feature Flag Status

| Service | Flag | Value |
|---------|------|-------|
| vantro-node-staging | `FEATURE_DATA_QUALITY_AGENT_ENABLED` | `true` |
| vantro-node-staging | `RUST_AUTOMATION_BASE_URL` | `https://vantro-automation-staging-production.up.railway.app` |
| vantro-node-staging | `FEATURE_AGENT_REGISTRY_API_ENABLED` | `true` (unchanged from Phase 1.5) |
| vantro-node-staging | `RUST_AUTOMATION_API_ENABLED` | `false` (unchanged — general sidecar flag, not used by data quality) |
| vantro-flow-backend (prod) | `FEATURE_DATA_QUALITY_AGENT_ENABLED` | **not set** |
| vantro-flow-backend (prod) | Any data quality flag | **not set** |

---

## Rust Direct Endpoint Result

**Endpoint:** `POST https://vantro-automation-staging-production.up.railway.app/api/v2/agents/core.data_quality/evaluate`

| Check | Result |
|-------|--------|
| HTTP status | 200 |
| agent_id | `core.data_quality` |
| status | `ok` |
| total_findings | 3 |
| findings array | 3 items |
| checks_run | 8 |
| duration_ms (server) | 13ms |
| safe_to_auto_fix=false for all | TRUE — Phase 2A invariant ✓ |
| approval_required=true for all | TRUE — Phase 2A invariant ✓ |
| warnings | [] |
| payload size | 2,207 bytes (2.2 KB) |
| LLM calls | NONE — deterministic Rust evaluation |
| DB mutations | NONE — read-only SELECT only |

---

## Node Preview Endpoint Result

**Endpoint:** `GET https://vantro-node-staging-production.up.railway.app/api/agents/core.data_quality/preview`

| Check | Result |
|-------|--------|
| HTTP status | 200 |
| agent_id | `core.data_quality` |
| status | `ok` (Rust sidecar call succeeded) |
| success | true |
| total_findings | 3 |
| checks_run | 8 |
| safe_to_auto_fix=false for all | TRUE |
| approval_required=true for all | TRUE |
| warnings | [] |
| payload size | 2,101 bytes (2.1 KB) |
| Rust call path | SUCCESS — sidecar called and response accepted |

**Issue found and fixed during proof:** `validateShape()` in `dataQualityAgentClient.js` checked
snake_case keys (`agent_id`, `total_findings`) but the Rust API returns camelCase (`agentId`,
`totalFindings`) consistent with other Rust API endpoints. Fixed in commit `8928dd7`.

---

## Auth Rejection Tests

| Test | Endpoint | Expected | Result |
|------|----------|----------|--------|
| Missing Authorization header | Rust POST /evaluate | 401 | **401 PASS** |
| Invalid token | Rust POST /evaluate | 401 | **401 PASS** |
| Missing Authorization header | Node GET /preview | 401 | **401 PASS** |

Auth enforcement confirmed on both services.

---

## Mutation Safety Proof

### Staging DB Row Counts (via Supabase client)

| Table | Before | After | Delta |
|-------|--------|-------|-------|
| customers | 2 | 2 | **0** |
| invoices | 3 | 3 | **0** |
| promises | 3 | 3 | **0** |
| ai_actions | 2 | 2 | **0** |

Multiple preview calls made between baseline and post-call measurement. Zero row changes.

### Agent Registry

| Check | Result |
|-------|--------|
| Total agents | 12 |
| is_active=true agents | **0** (all inactive — Phase 2A invariant) |
| core.data_quality is_active | false |
| Registry public claim | "12 core specialized agents" (unchanged) |

No financial mutations. No payment status changes. No ai_action execution records created.
No external messages sent (FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED unset/false).

---

## Performance Result

| Metric | Rust Direct | Node Preview |
|--------|-------------|--------------|
| server duration_ms (p50) | 7–11ms | 7–8ms |
| wall-clock p50 | ~582ms | ~422ms |
| wall-clock p95 | ~1531ms | ~1132ms |
| payload | 2.1 KB | 2.1 KB |
| HTTP 200 rate | 5/5 | 5/5 |
| HTTP 5xx | 0 | 0 |
| timeout (>8s) | 0 | 0 |

**Note:** Wall-clock includes network RTT from Windows dev machine to Railway staging (cross-region).
Server duration_ms is the authoritative compute metric. Target: <150ms. **Actual: 7–11ms.**

---

## Railway Logs Summary

**Rust staging logs:**
- `Starting Container` — service started clean
- No panics, OOM, or 5xx in logs

**Node staging logs:**
- `✅ Vantro Flow Backend running on port 3000`
- JWT_SECRET validation: true
- Route registered: `/api/agents/core.data_quality/preview`
- Auth rejections logged correctly (401 for no-token requests)
- `[DataQualityAgent] success code=data_quality_success` after schema fix
- No production secrets in logs
- No token or JWT values logged

**Known non-critical log warning (pre-existing):**
- `[CollectionsAgent] run failed: column invoices.customer_name does not exist` — pre-existing schema issue unrelated to this feature

---

## Production Untouched Confirmation

| Check | Status |
|-------|--------|
| vantro-flow-backend redeployed | NO |
| vantro-flow-backend env changed | NO |
| FEATURE_DATA_QUALITY_AGENT_ENABLED on prod | NOT SET |
| Any production DB write | NO |
| Any production secret touched | NO |
| Frontend touched | NO |
| core.data_quality is_active=true anywhere | NO |

---

## Bug Found During Proof

**Bug:** `validateShape()` in `dataQualityAgentClient.js` used snake_case keys (`agent_id`, `total_findings`)
but Rust API returns camelCase (`agentId`, `totalFindings`) consistent with existing Rust endpoints.

**Impact:** Node preview always fell back to safe empty response (`preview_unavailable`) even when Rust
call succeeded. The fallback is safe (no mutations), but the preview was non-functional.

**Fix:** `8928dd7` — `validateShape` now accepts either format via nullish coalescing.
This is a **staging-only catch** — production was never exposed to this issue.

---

## Remaining Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| `RUST_AUTOMATION_BASE_URL` uses public HTTPS (potential extra hop) | Low | Consider Railway private domain for production |
| Railway auto-redeploy from env var change deploys from GitHub branch, not local upload | Low | Always redeploy with `railway deployment up` after env var changes on non-auto-deploy services |
| `agent_registry` not visible via Supabase client (uses Railway Postgres) | Low | API endpoint confirms 12 agents correctly |
| Wall-clock latency from staging (cross-region) | Cosmetic | Server duration 7-11ms is the real metric |

---

## Safety Checks Summary

| Check | Command | Result |
|-------|---------|--------|
| Node syntax | `node --check server.js` | **PASS** |
| Secrets scan | `npm run security:secrets` | **PASS** |
| Cortex harness | `npm run cortex:test` | **100/100** (43 checks) |
| Agent seed | `npm run agents:seed:validate` | **PASS** (12 agents, unique IDs) |
| Rust CI | `cargo fmt / check / test` | **GREEN** (commit 827e577) |

---

## Files Changed in Phase 2A + 2A.5

| File | Change | Commit |
|------|--------|--------|
| `vantro-automation-rs/src/agents/data_quality/mod.rs` | NEW — pure Rust eval, 19 tests | 7f7d28f |
| `vantro-automation-rs/src/api/data_quality.rs` | NEW — Axum POST endpoint | 7f7d28f |
| `vantro-automation-rs/src/agents/mod.rs` | Added `pub mod data_quality` | 7f7d28f |
| `vantro-automation-rs/src/api/mod.rs` | Registered data_quality routes | 7f7d28f |
| `lib/services/rustAutomation/dataQualityAgentClient.js` | NEW — Node safe wrapper | 7f7d28f |
| `lib/featureFlags.js` | Added `data_quality_agent_enabled` flag | 7f7d28f |
| `server.js` | Added GET /api/agents/core.data_quality/preview | 7f7d28f |
| `cortex-lab/schemaValidator.js` | Added `data-quality` to VALID_CATEGORIES | 7f7d28f |
| `cortex-lab/scenarios/data-quality/*.json` | 6 new harness scenarios | 7f7d28f |
| `docs/agent-mesh/phase-2a-data-quality-agent.md` | Phase 2A architecture doc | 7f7d28f |
| `vantro-automation-rs/src/agents/data_quality/mod.rs` | rustfmt fix (chain_width) | 827e577 |
| `vantro-automation-rs/src/api/data_quality.rs` | rustfmt fix (import order) | 827e577 |
| `lib/services/rustAutomation/dataQualityAgentClient.js` | validateShape camelCase fix | 8928dd7 |
| `docs/agent-mesh/phase-2a-data-quality-staging-proof.md` | This document | (this commit) |

---

## Next Recommended Action

Phase 2A.5 is complete. Options for Phase 2B:

1. **Wire `core.cost_router`** (next low-risk, no-LLM agent)
   - Similar risk profile to data_quality
   - No external calls, deterministic computation

2. **Wire `core.policy_guard` preview endpoint**
   - Medium risk — policy guard is safety-critical
   - Requires `ESCALATED TRACK` per risk-matrix.md

Before any Phase 2B work:
- Merge `performance-bootstrap-cortex-fix-v1` to `main` (or keep as staging-verified branch)
- Confirm staging data quality flag remains ON for ongoing staging use
- Do NOT enable on production until owner UI review flow is wired

---

*Phase 2A (implementation) → Phase 2A.5 (staging proof) → Phase 2B (next agent OR production readiness)*
