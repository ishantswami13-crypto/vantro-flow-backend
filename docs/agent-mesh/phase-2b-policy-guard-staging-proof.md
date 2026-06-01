# Atlas Agent Mesh — Phase 2B.5: Policy Guard Agent Staging Proof

> **Status:** COMPLETE — All proof gates passed
> **Date:** 2026-06-01
> **Branch:** performance-bootstrap-cortex-fix-v1
> **Commits:** 808192e (implementation)
> **Agent:** `core.policy_guard` | Risk: Medium (safety-critical) | Mutations: NONE

---

## Summary

Phase 2B.5 proves the `core.policy_guard` agent end-to-end on staging:
- Rust sidecar POST endpoint verified live (8 test cases + auth rejection)
- Node POST endpoint verified live (Rust call succeeds for all cases)
- Auth rejection verified (401 for missing/invalid tokens)
- Fail-closed behavior verified (sidecar unavailable → blocked=true, POLICY_GUARD_UNAVAILABLE)
- Phase 2B invariants verified on all responses: `safe_to_auto_execute=false`, `approval_required=true`
- FIR word-boundary regression verified: "firm reminder" NOT blocked; standalone "FIR" BLOCKED
- Financial mutation attempts blocked (MARK_PAID, CHANGE_AMOUNT, DELETE_INVOICE)
- Zero DB mutations from all policy preview calls
- Production untouched throughout

---

## CI Status

| Commit | Description | CI |
|--------|-------------|-----|
| `808192e` | feat(agent-mesh): add read-only policy guard agent preview | GREEN ✅ |

**CI jobs for 808192e (all green):**
- cargo fmt / check / test (pure-Rust): SUCCESS
- server-feature offline build + auth tests (SQLX_OFFLINE=true): SUCCESS
- cortex-lab static (no DB): SUCCESS
- Node: rust fallback (8 cases) + check + cortex: SUCCESS
- live /api/v2 harness (ephemeral PG + in-CI Rust service): SUCCESS
- SQLx prepare + server-feature build (ephemeral Postgres): SUCCESS
- hello: SUCCESS

---

## Deploy Status

| Service | Deployment ID | Timestamp | Status | Source |
|---------|--------------|-----------|--------|--------|
| vantro-automation-staging (Rust) | `4988aa8f` | 2026-06-01 13:09 IST | SUCCESS | 808192e |
| vantro-node-staging (Node) | `1df7cc5c` | 2026-06-01 13:17 IST | SUCCESS | 808192e |

**Production services:** NOT touched. `vantro-flow-backend` last deployed 2026-05-29, unchanged.

---

## Feature Flag Status

| Service | Flag | Value |
|---------|------|-------|
| vantro-node-staging | `FEATURE_POLICY_GUARD_AGENT_ENABLED` | `true` |
| vantro-node-staging | `FEATURE_DATA_QUALITY_AGENT_ENABLED` | `true` (from Phase 2A.5, unchanged) |
| vantro-node-staging | `RUST_AUTOMATION_BASE_URL` | `https://vantro-automation-staging-production.up.railway.app` |
| vantro-node-staging | `RUST_AUTOMATION_API_ENABLED` | `false` (general sidecar flag, not used by policy guard) |
| vantro-flow-backend (prod) | `FEATURE_POLICY_GUARD_AGENT_ENABLED` | **not set** |
| vantro-flow-backend (prod) | Any policy guard flag | **not set** |

---

## Rust Direct Endpoint Results

**Endpoint:** `POST https://vantro-automation-staging-production.up.railway.app/api/v2/agents/core.policy_guard/evaluate`

### Test Case Matrix

| Case | Input | HTTP | blocked | allowed | approvalRequired | safeToAutoExecute | riskLevel | blockReason |
|------|-------|------|---------|---------|-----------------|-------------------|-----------|-------------|
| A — safe internal | draft_message + "Please confirm payment date" + internal | 200 | false | true | **true** | **false** | low | — |
| B — firm reminder FIR regression | draft_message + "Send a firm reminder for payment" + internal | 200 | false | true | **true** | **false** | low | — |
| C — FIR/legal threat | draft_message + "We will file FIR if you do not pay" + whatsapp | 200 | **true** | false | true | false | blocked | Message contains blocked phrase: "fir" |
| D — police threat | draft_message + "I will call the police on you" + whatsapp | 200 | **true** | false | true | false | blocked | Message contains blocked phrase: "police" |
| E — WhatsApp safe message | send_message + safe text + whatsapp + requires_external_message=true | 200 | false | true | **true** | false | medium | — |
| F — MARK_PAID (forbidden) | MARK_PAID + invoice | 200 | **true** | false | true | false | blocked | Action type MARK_PAID is forbidden for AI/rule suggestions |
| G — CHANGE_AMOUNT (forbidden) | CHANGE_AMOUNT + invoice | 200 | **true** | false | true | false | blocked | Action type CHANGE_AMOUNT is forbidden for AI/rule suggestions |
| H — DELETE_INVOICE (forbidden) | DELETE_INVOICE + customer | 200 | **true** | false | true | false | blocked | Action type DELETE_INVOICE is forbidden for AI/rule suggestions |

### Auth Rejection

| Test | Expected | Result |
|------|----------|--------|
| Missing Authorization header | 401 | **401 PASS** |
| Invalid token | 401 | **401 PASS** |

### Phase 2B Invariants (Rust Direct)

| Invariant | Value | Verified |
|-----------|-------|----------|
| `safe_to_auto_execute` | false | ALL cases ✅ |
| `approval_required` | true | ALL cases ✅ |

---

## Node Endpoint Results

**Endpoint:** `POST https://vantro-node-staging-production.up.railway.app/api/agents/core.policy_guard/evaluate`

All 8 cases (A–H) match Rust direct results exactly — Node correctly calls Rust sidecar and passes response through.

| Case | HTTP | blocked | allowed | approvalRequired | safeToAutoExecute | riskLevel |
|------|------|---------|---------|-----------------|-------------------|-----------|
| A — safe internal | 200 | false | true | **true** | **false** | low |
| B — firm reminder | 200 | false | true | **true** | **false** | low |
| C — FIR/legal threat | 200 | **true** | false | true | false | blocked |
| D — police threat | 200 | **true** | false | true | false | blocked |
| E — WhatsApp safe | 200 | false | true | **true** | false | medium |
| F — MARK_PAID | 200 | **true** | false | true | false | blocked |
| G — CHANGE_AMOUNT | 200 | **true** | false | true | false | blocked |
| H — DELETE_INVOICE | 200 | **true** | false | true | false | blocked |

### Auth Rejection (Node)

| Test | Expected | Result |
|------|----------|--------|
| Missing Authorization header | 401 | **401 PASS** |
| Invalid token | 401 | **401 PASS** |

---

## Fail-Closed Proof

**Method:** Local wrapper test with `RUST_AUTOMATION_BASE_URL=http://localhost:9` (ECONNREFUSED — simulates unavailable sidecar).

| Check | Result |
|-------|--------|
| `status` | `unavailable` |
| `decision.blocked` | **true** |
| `decision.allowed` | **false** |
| `decision.blockReason` | `POLICY_GUARD_UNAVAILABLE` |
| No crash | ✅ |
| No unsafe allow | ✅ |
| Fallback code logged | `policy_guard_connection_failed_fallback` |

**Fail-closed invariant verified:** Sidecar unavailability produces `blocked=true`, never `allowed=true`.

---

## Mutation Safety Proof

### Staging DB Row Counts (via Supabase staging client)

| Table | Before | After | Delta |
|-------|--------|-------|-------|
| customers | 2 | 2 | **0** |
| invoices | 3 | 3 | **0** |
| promises | 3 | 3 | **0** |
| ai_actions | 2 | 2 | **0** |

Multiple policy evaluation calls made between baseline and post-call measurement. Zero row changes.

### Agent Registry

| Check | Result |
|-------|--------|
| Total agents | 12 |
| is_active=true agents | **0** (all inactive) |
| core.policy_guard is_active | false |
| Registry public claim | "12 core specialized agents" (unchanged) |

No financial mutations. No payment status changes. No ai_action execution records created.
No external messages sent (FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED unset/false).

---

## Performance Results

| Metric | Rust Direct | Node (wall-clock) |
|--------|-------------|--------------|
| server durationMs (p50) | 0–1ms | — |
| wall-clock p50 | ~776ms | ~391ms |
| wall-clock p95 | ~1773ms | ~862ms |
| payload | ~270 bytes | ~270 bytes |
| HTTP 200 rate | 8/8 (A–H) | 8/8 |
| HTTP 5xx | 0 | 0 |
| timeout (>8s) | 0 | 0 |

**Note:** Wall-clock includes network RTT from Windows dev machine to Railway staging (cross-region).
Server `durationMs` is the authoritative compute metric. Target: <50ms. **Actual: 0–1ms.**
Pure evaluation (no DB queries) — expected to be extremely fast.

---

## FIR Word-Boundary Regression

| Test | Input | Expected | Result |
|------|-------|----------|--------|
| "firm" must not trigger FIR block | "Send a firm reminder for payment." | NOT blocked | **PASS — not blocked** |
| Standalone "FIR" must block | "We will file FIR if you do not pay." | blocked | **PASS — blocked** |
| "police" as word must block | "I will call the police on you." | blocked | **PASS — blocked** |
| "policy" must not trigger police block | (tested via Harness X) | NOT blocked | **PASS** |

FIR word-boundary invariant intact on staging (same as Phase 2A.5 regression test results).

---

## Railway Logs Summary

**Rust staging logs (4988aa8f):**
- `Starting Container` — service started clean
- No panics, OOM, or 5xx in logs
- `policy_guard_evaluate` tracing events logged for each call

**Node staging logs (1df7cc5c):**
- `✅ Vantro Flow Backend running on port 3000`
- JWT_SECRET validation: true
- Route registered: `/api/agents/core.policy_guard/evaluate`
- Auth rejections logged correctly (401 for no-token requests)
- `[PolicyGuardAgent] success code=policy_guard_success_blocked` for blocked cases
- `[PolicyGuardAgent] success code=policy_guard_success_allowed` for allowed cases
- `[PolicyGuardAgent] fallback code=policy_guard_connection_failed_fallback` on fail-closed test
- No token or JWT values logged
- No production secrets in logs

**Pre-existing non-critical log warning:**
- `[CollectionsAgent] run failed: column invoices.customer_name does not exist` — pre-existing schema issue, unrelated to this feature

---

## Production Untouched Confirmation

| Check | Status |
|-------|--------|
| vantro-flow-backend redeployed | NO |
| vantro-flow-backend env changed | NO |
| FEATURE_POLICY_GUARD_AGENT_ENABLED on prod | NOT SET |
| Any production DB write | NO |
| Any production secret touched | NO |
| Frontend touched | NO |
| core.policy_guard is_active=true anywhere | NO |

---

## Issue Found During Proof

**Bug:** JWT_SECRET in Railway env had correct value (54 chars) but `railway variables` CLI table truncated it to 11 chars (`vantro2025!`). Initial JWT was generated with truncated secret → `InvalidSignature` 401s.

**Fix:** Used `railway variables --json` to get full 54-char secret. Regenerated JWT with PowerShell env var passthrough.

**Impact:** Staging-only catch. Production was never exposed. No code change required — this was an operational issue with CLI table truncation, not a code bug.

---

## Safety Checks Summary

| Check | Command | Result |
|-------|---------|--------|
| Node syntax | `node --check server.js` | **PASS** |
| Secrets scan | `npm run security:secrets` | **PASS** |
| Cortex harness | `npm run cortex:test` | **100/100** (53 checks) |
| Agent seed | `npm run agents:seed:validate` | **PASS** (12 agents, unique IDs) |
| Rust CI | `cargo fmt / check / test` | **GREEN** (commit 808192e) |

---

## Remaining Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| `RUST_AUTOMATION_BASE_URL` uses public HTTPS (potential extra hop) | Low | Consider Railway private domain for production |
| Wall-clock latency (cross-region from Windows dev) | Cosmetic | Server durationMs 0–1ms is the real metric |
| JWT_SECRET CLI truncation | Operational | Always use `--json` flag for Railway vars when generating tokens |

---

## Files Changed in Phase 2B + 2B.5

| File | Change | Commit |
|------|--------|--------|
| `vantro-automation-rs/src/agents/policy_guard/mod.rs` | NEW — typed agent structs, 13 unit tests | 808192e |
| `vantro-automation-rs/src/api/policy_guard.rs` | NEW — Axum POST endpoint (no sqlx) | 808192e |
| `vantro-automation-rs/src/agents/mod.rs` | Added `pub mod policy_guard` | 808192e |
| `vantro-automation-rs/src/api/mod.rs` | Added `mod policy_guard` + route merge | 808192e |
| `lib/featureFlags.js` | Added `policy_guard_agent_enabled` flag | 808192e |
| `lib/services/rustAutomation/policyGuardAgentClient.js` | NEW — fail-closed Node wrapper, 9 fallback codes | 808192e |
| `server.js` | Added POST `/api/agents/core.policy_guard/evaluate` | 808192e |
| `cortex-lab/schemaValidator.js` | Added `'policy-guard'` to VALID_CATEGORIES | 808192e |
| `cortex-lab/scenarios/policy-guard/*.json` | 10 new harness scenarios | 808192e |
| `docs/agent-mesh/phase-2b-policy-guard-agent.md` | Phase 2B architecture doc | 808192e |
| `docs/agent-mesh/phase-2b-policy-guard-staging-proof.md` | This document | (this commit) |

---

## Next Recommended Action

Phase 2B.5 is complete. Options for Phase 2C:

1. **Wire `core.cost_router`** (next low-risk, no-LLM agent)
   - Similar risk profile to data_quality and policy_guard
   - No external calls, deterministic computation

Before any Phase 2C work:
- Merge `performance-bootstrap-cortex-fix-v1` to `main` (or keep as staging-verified branch)
- Confirm staging flags remain ON for ongoing staging use
- Do NOT enable on production until owner UI review flow is wired

---

*Phase 2B (implementation) → Phase 2B.5 (staging proof) → Phase 2C (next agent OR production readiness)*
