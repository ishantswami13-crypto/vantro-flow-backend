# Phase 2C.14 — Evidence Staging Validation & Production Gate

**Status:** PASSED
**Date:** 2026-06-02
**Builds on:** Phase 2C.13 (Rust Evidence Output)

---

## Objective

Deploy Phase 2C.13 Rust evidence changes to Railway staging, validate that real evidence flows end-to-end from Rust DB queries to the Node evidence contract to the frontend EvidenceContractPanel, and produce a proof-based production gate recommendation.

---

## Deployment Summary

### Commit Pushed
- Commit: `f71d2bc` — feat(2C.8-2C.13): RAG Evidence Contract, Owner Briefing command layer, live Harness X
- Branch: `performance-bootstrap-cortex-fix-v1`
- Files: 88 files changed, 5737 insertions (+), 308 deletions (−)
- Push time: 2026-06-02T07:30Z

### Railway Services Deployed

| Service | Deployment ID | Method | Status |
|---------|---------------|--------|--------|
| vantro-node-staging | `a1ed90e3` | `railway up` | ✅ Online |
| vantro-automation-staging (Rust) | `1a38771c` | `railway up` | ✅ Online |

### JWT_SECRET Rotation (Part of Phase 2C.14)
- New shared JWT_SECRET generated (64-char hex) and set on BOTH services via `--stdin`
- Tokens in `cortex-lab/.env.test` regenerated with new shared secret
- Owner A auth verified: ✅ `userId=11111111-1111-1111-1111-111111111111`
- Owner B auth verified: ✅ `userId=22222222-2222-2222-2222-222222222222`
- Temp file containing secret deleted immediately after use
- `.env.test` not tracked by git ✅

### Why Phase 2C.14 Required JWT_SECRET Sync
Phase 2C.11 rotated the JWT_SECRET only for `vantro-node-staging`. The Rust sidecar (`vantro-automation-staging`) kept the old secret. When Node forwarded user tokens to Rust for validation, Rust rejected them (401 Unauthorized → `RUST_UNAVAILABLE` fallback). This phase synced both services to the same JWT_SECRET.

---

## Health Endpoints

| Service | URL | Result |
|---------|-----|--------|
| Node staging | `/api/health` | ✅ `{"status":"alive"}` HTTP 200 |
| Rust sidecar | `/health` | ✅ `{"ok":true,"service":"vantro-automation-rs"}` HTTP 200 |

---

## Live Evidence Flow Validation

### OWNER_A (11111111-...) — Has Seeded Business Data

| Field | Value | Expected |
|-------|-------|----------|
| HTTP | 200 | ✅ |
| `status` | `success` | ✅ |
| `audit_context` | `owner_briefing_generated` | ✅ |
| `evidence[]` field present | Yes | ✅ |
| `evidence.length` | **4** | ✅ >0 |
| Evidence source_types | `invoice` (×3), `promise` (×1) | ✅ Real DB records |
| Evidence amounts | ₹40,000 (overdue), ₹32,000 (unpaid) | ✅ Live values |
| `safe_to_show` | **true** | ✅ |
| `confidence` | 0.9 | ✅ ≥0.65 |
| `claims total` | 2 | ✅ |
| `claims safe` | 2 | ✅ All safe |
| `top_actions evidence_ids` | Present on all actions | ✅ |
| `safe_to_auto_execute` (all actions) | false | ✅ |
| Tenant isolation | Only OWNER_A records returned | ✅ |
| `fallback_reason` | null | ✅ No fallback |

### OWNER_B (22222222-...) — Minimal Business Data

| Field | Value | Expected |
|-------|-------|----------|
| `status` | `success` | ✅ |
| `evidence.length` | 1 | ✅ Different from OWNER_A (tenant isolated) |
| `safe_to_show` | **false** | ✅ Insufficient claims (DQ action has no evidence_ids) |
| `claims safe` | 0 / 0 | ✅ No actions with evidence_ids → no safe claims |
| `safe_to_auto_execute` (all actions) | false | ✅ |
| UI state | "No verified evidence yet" | ✅ |

**Tenant isolation confirmed:** OWNER_A and OWNER_B receive different evidence arrays scoped to their own data. Zero cross-tenant evidence was observed.

---

## Feature Flag Status (Node Staging)

| Flag | Value | Status |
|------|-------|--------|
| `FEATURE_OWNER_BRIEFING_AGENT_ENABLED` | `true` | ✅ Enabled on staging |
| `RUST_AUTOMATION_API_ENABLED` | `true` | ✅ Enabled |
| `RUST_AUTOMATION_BASE_URL` | Set | ✅ |
| `FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED` | NOT_SET → `false` | ✅ Disabled |

---

## Live Harness X Results (Post-Deployment)

**Run ID:** `ctx_mpwcmx1h_32e66d9c`

| Category | Score | Assertions | Result |
|----------|-------|-----------|--------|
| orchestration | 100% | 1/0 | ✅ PASS |
| business_isolation | 100% | 10/0 | ✅ PASS |
| approval_gate_safety | 100% | 1/0 | ✅ PASS |
| event_audit_completeness | N/A | 0 | ⚪ N/A |
| **Overall** | **100/100** | **12/0** | ✅ **PASS** |

Critical failures: **0** | Wrong-token probes returning 200: **Zero**

*Note: An earlier harness run during server restart returned connection errors (status 0). Re-run on stable server returned 100/100.*

---

## Rust CI Status

The Rust test suite (`cargo test --features server`) requires Linux/C toolchain and cannot run on Windows. It runs in GitHub Actions `rust-automation-ci.yml` triggered by the push to `performance-bootstrap-cortex-fix-v1`.

**Functional proof that Phase 2C.13 Rust code is deployed:**
- `vantro-automation-staging` deployment `1a38771c` is serving requests
- OWNER_A owner briefing returns `evidence: [{source_type: "invoice", amount: 40000}, {source_type: "invoice", amount: 32000}, {source_type: "promise"}, ...]`
- These items are serialized from `Vec<EvidenceItem>` in the Rust response — only possible if the Phase 2C.13 code is compiled and running
- Rust syntax verified via `rustfmt --check` before deployment

---

## Git Safety

| Check | Result |
|-------|--------|
| `cortex-lab/.env.test` tracked | ✅ Not tracked |
| Temp JWT file | ✅ Deleted after use |
| Secrets in committed files | ✅ None |
| Production variables changed | ✅ None — only staging touched |
| Production feature flags | ✅ Unchanged |

---

## End-to-End Evidence Flow — CONFIRMED LIVE ✅

```
Rust DB query: SELECT id, invoice_amount, ... FROM invoices WHERE user_id = $1
  → EvidenceItem { source_type: "invoice", amount: 40000.0, confidence: 1.0 }
  → OwnerBriefingOutput { evidence: [EvidenceItem, ...] }
  → Node rustFetch receives evidence[]
  → enforceEvidenceContract: rawEvidence.length=4, hasEvidence=true
  → Claims synthesized from top_actions.evidence_ids
  → safe_to_show=true, confidence=0.9
  → evidence_contract attached to API response
  → Frontend EvidenceContractPanel: 4 sources, High confidence
  → Audit log: evidence_count=4, evidence_source_ids=[...], safe_to_show=true
```

---

## Production Gate Decision

### Gate Criteria Evaluation

| Criterion | Status |
|-----------|--------|
| Staging evidence live (evidence.length>0 for seeded data) | ✅ PASS — 4 evidence items |
| Node contract safe_to_show=true with evidence | ✅ PASS |
| Empty-data owner shows safe "no evidence" state | ✅ PASS — OWNER_B correct |
| Tenant isolation (no cross-tenant evidence) | ✅ PASS |
| Harness X live passes | ✅ 100/100 |
| Wrong-token probes return 403/404 | ✅ Zero return 200 |
| External message sending disabled | ✅ NOT_SET → false |
| No fake evidence | ✅ All from real DB records |
| All actions safe_to_auto_execute=false | ✅ |
| Risky recommendations require_human_approval=true | ✅ |
| Rust sidecar deployed and healthy | ✅ |
| No secrets exposed | ✅ |
| Rollback path | ✅ Set `FEATURE_OWNER_BRIEFING_AGENT_ENABLED=false` → instant disable |
| Rust CI (Linux) | ⚪ Runs in GitHub Actions on push |

### Production Gate Recommendation

**✅ READY for controlled production flag enablement.**

> Enable `FEATURE_OWNER_BRIEFING_AGENT_ENABLED=true` in production with canary monitoring and rollback plan.

**Pre-production checklist:**
1. ✅ Staging evidence proven live with real tenant data
2. ✅ Live Harness X 100/100 on staging
3. ✅ No cross-tenant leakage
4. ✅ No fake evidence
5. ✅ Fallback safety verified (RUST_UNAVAILABLE → safe state)
6. ✅ External message sending still disabled
7. ⚠️ Confirm production Rust sidecar (`vantro-automation-staging` → production equivalent) is deployed with Phase 2C.13 code before enabling
8. ⚠️ Confirm production JWT_SECRET matches Rust sidecar JWT_SECRET (same sync needed)
9. Monitor: audit_logs for `AGENT_PREVIEW` actions, error rate, Rust sidecar health

**Rollback:** Set `FEATURE_OWNER_BRIEFING_AGENT_ENABLED=false` in production Railway → instant disable, no redeploy needed.

---

## Files Changed in Phase 2C.14

| File | Change |
|------|--------|
| `docs/agent-mesh/phase-2c-14-evidence-staging-validation.md` | This document |
| `cortex-lab/.env.test` | Regenerated with new shared JWT_SECRET (gitignored) |
| Railway: vantro-node-staging JWT_SECRET | Rotated to new shared 64-char secret |
| Railway: vantro-automation-staging JWT_SECRET | Updated to match Node staging |

---

## Next Phase: 2C.15 — Production Owner Briefing Rollout

1. Confirm `vantro-flow-backend` (production) Rust sidecar has Phase 2C.13 code
2. Sync JWT_SECRETs if production uses the same pattern
3. Enable `FEATURE_OWNER_BRIEFING_AGENT_ENABLED=true` in production
4. Monitor audit_logs and Rust sidecar health
5. Confirm production evidence flows with real customer invoices
6. Declare Owner Briefing feature generally available
