# Atlas Agent Mesh — Phase 2B: Policy Guard Agent

> **Status:** IMPLEMENTATION COMPLETE — Staging proof pending
> **Date:** 2026-06-01
> **Branch:** performance-bootstrap-cortex-fix-v1
> **Agent:** `core.policy_guard` | Risk: Medium (safety-critical, read-only) | Mutations: NONE

---

## Summary

Phase 2B adds `core.policy_guard` as a read-only, deterministic, no-LLM policy evaluation agent.
It is the safety rail that every future Atlas agent action must pass through before execution.

**Implementation approach:** Wrap — not rewrite. `cortex/policy_guard.rs` already contains a
complete, tested policy engine with word-boundary phrase matching and 14 unit tests. The agent
module imports and delegates to it. The FIR regression tests remain untouched.

---

## Architecture

```
Node POST /api/agents/core.policy_guard/evaluate
  -> policyGuardAgentClient.js (fail-closed Node wrapper)
    -> POST RUST_AUTOMATION_BASE_URL/api/v2/agents/core.policy_guard/evaluate
      -> agents::policy_guard::evaluate()  [agent layer — typed structs, channel gate]
        -> cortex::policy_guard::evaluate() [pure engine — phrases, forbidden types, approval]
          -> PolicyDecision { allowed, blocked, requires_approval, ... }
```

**Key difference from data_quality:** Policy guard is **fail-closed**. If the sidecar is
unavailable, the Node wrapper returns `blocked=true, block_reason='POLICY_GUARD_UNAVAILABLE'`
rather than null. Data quality can safely return empty findings; policy guard cannot safely
return `allowed=true` when the guard cannot be consulted.

---

## Phase 2B Invariants

Every response from `core.policy_guard` in this phase must pass:

| Invariant | Value | Why |
|-----------|-------|-----|
| `safe_to_auto_execute` | `false` | No agent auto-executes without owner action in Phase 2B |
| `approval_required` | `true` | All actions require owner approval before any is_active=true |

These are enforced in `agents/policy_guard/mod.rs` and asserted in unit tests (same pattern as
Phase 2A's `safe_to_auto_fix=false` and `approval_required=true`).

---

## Policy Engine Checks (5 total)

| # | Check | Layer |
|---|-------|-------|
| 1 | Forbidden action type (MARK_PAID, CHANGE_AMOUNT, OFFER_DISCOUNT, DELETE_INVOICE) | cortex |
| 2 | Blocked phrases in proposed_text — word-boundary matching | cortex |
| 3 | Hallucination check: customer_id not in known_customer_ids | cortex |
| 4 | Approval determination (ALWAYS_APPROVAL list, high amount, high risk) | cortex |
| 5 | Channel gate: whatsapp/external channels force approval | agent layer |

---

## Blocked Phrases (cortex engine)

`legal action`, `file case`, `police`, `fir`, `court`, `arrest`, `lawyer`, `criminal`,
`fraud`, `cheater`, `threaten`, `warning letter`

All checked with word-boundary matching — "firm", "confirm", "first", "policy" are NOT blocked.

---

## Forbidden Action Types

`MARK_PAID`, `CHANGE_AMOUNT`, `OFFER_DISCOUNT`, `DELETE_INVOICE`

---

## Always-Approval Action Types

`SEND_FIRM_REMINDER`, `CALL_CUSTOMER`, `ESCALATE_TO_OWNER`, `STOP_CREDIT_WARNING`,
`CASHFLOW_RISK`, `CREDIT_HOLD_SUGGESTED`, `ASK_PARTIAL_PAYMENT`

---

## Files Changed in Phase 2B

| File | Change |
|------|--------|
| `vantro-automation-rs/src/agents/policy_guard/mod.rs` | NEW — typed agent structs, evaluate(), 13 unit tests |
| `vantro-automation-rs/src/api/policy_guard.rs` | NEW — Axum POST endpoint |
| `vantro-automation-rs/src/agents/mod.rs` | Added `pub mod policy_guard` |
| `vantro-automation-rs/src/api/mod.rs` | Added `mod policy_guard` + route merge |
| `lib/featureFlags.js` | Added `policy_guard_agent_enabled` flag |
| `lib/services/rustAutomation/policyGuardAgentClient.js` | NEW — fail-closed Node wrapper, 9 fallback codes |
| `server.js` | Added POST `/api/agents/core.policy_guard/evaluate` |
| `cortex-lab/schemaValidator.js` | Added `'policy-guard'` to VALID_CATEGORIES |
| `cortex-lab/scenarios/policy-guard/*.json` | 10 new harness scenarios |
| `docs/agent-mesh/phase-2b-policy-guard-agent.md` | This document |

**NOT changed:**
- `cortex/policy_guard.rs` — engine untouched, all existing tests preserved
- `tests/policy_guard_fir_regression.rs` — FIR regression tests unchanged
- `api/policy.rs` — existing cortex endpoint unchanged
- Production environment — no flags set, no deploys

---

## API

### Request

```
POST /api/agents/core.policy_guard/evaluate
Authorization: Bearer <jwt>
Content-Type: application/json

{
  "proposed_action_type": "SEND_FIRM_REMINDER",
  "proposed_text": "Please settle your overdue invoice.",
  "entity_type": "customer",
  "channel": "whatsapp",
  "risk_context": "medium",
  "amount": 12000.0,
  "requires_external_message": true,
  "known_customer_ids": ["uuid-aaa", "uuid-bbb"],
  "customer_id": "uuid-aaa"
}
```

### Response (allowed)

```json
{
  "success": true,
  "agentId": "core.policy_guard",
  "status": "ok",
  "decision": {
    "allowed": true,
    "blocked": false,
    "approvalRequired": true,
    "safeToAutoExecute": false,
    "blockReason": null,
    "reasons": [],
    "riskLevel": "medium"
  },
  "checksRun": 5,
  "durationMs": 1,
  "auditEvent": "policy_guard_evaluate"
}
```

### Response (blocked)

```json
{
  "success": true,
  "agentId": "core.policy_guard",
  "status": "ok",
  "decision": {
    "allowed": false,
    "blocked": true,
    "approvalRequired": false,
    "safeToAutoExecute": false,
    "blockReason": "Action type MARK_PAID is forbidden for AI/rule suggestions",
    "reasons": ["Action type MARK_PAID is forbidden for AI/rule suggestions"],
    "riskLevel": "blocked"
  },
  "checksRun": 5,
  "durationMs": 0,
  "auditEvent": "policy_guard_evaluate"
}
```

### Response (sidecar unavailable — fail-closed)

```json
{
  "success": false,
  "agentId": "core.policy_guard",
  "status": "unavailable",
  "decision": {
    "allowed": false,
    "blocked": true,
    "approvalRequired": true,
    "safeToAutoExecute": false,
    "blockReason": "POLICY_GUARD_UNAVAILABLE",
    "reasons": ["Policy guard sidecar could not be reached"],
    "riskLevel": "blocked"
  },
  "checksRun": 0,
  "durationMs": 0,
  "auditEvent": "policy_guard_evaluate"
}
```

---

## Node Wrapper Fallback Codes (9)

| # | Code | Condition | Result |
|---|------|-----------|--------|
| 1 | `policy_guard_disabled_fallback` | Flag OFF | UNAVAILABLE_DECISION |
| 2 | `policy_guard_missing_base_url_fallback` | RUST_AUTOMATION_BASE_URL not set | UNAVAILABLE_DECISION |
| 3 | `policy_guard_connection_failed_fallback` | ECONNREFUSED / DNS fail | UNAVAILABLE_DECISION |
| 4 | `policy_guard_timeout_fallback` | >8s | UNAVAILABLE_DECISION |
| 5 | `policy_guard_http_error_fallback` | HTTP non-2xx | UNAVAILABLE_DECISION |
| 6 | `policy_guard_invalid_json_fallback` | Body not valid JSON | UNAVAILABLE_DECISION |
| 7 | `policy_guard_invalid_schema_fallback` | JSON missing expected fields | UNAVAILABLE_DECISION |
| 8 | `policy_guard_success_blocked` | Valid response, blocked=true | blocked decision from Rust |
| 9 | `policy_guard_success_allowed` | Valid response, blocked=false | allowed decision from Rust |

---

## Harness X Scenarios (10)

| Scenario | Mode | Expected |
|----------|------|----------|
| `pg-allowed-safe-reminder` | static | allowed, approval_required=true, safe_to_auto_execute=false |
| `pg-allowed-firm-reminder-needs-approval` | static | allowed, approval_required=true (ALWAYS_APPROVAL) |
| `pg-blocked-legal-threat` | static, red-team | blocked |
| `pg-blocked-fir-standalone` | static, red-team | blocked (word-boundary) |
| `pg-blocked-forbidden-mark-paid` | static, red-team | blocked |
| `pg-blocked-forbidden-delete-invoice` | static, red-team | blocked |
| `pg-blocked-police-threat` | static, red-team | blocked |
| `pg-allowed-policy-not-police` | static, red-team | allowed (word-boundary) |
| `pg-whatsapp-channel-needs-approval` | static | allowed, approval_required=true |
| `pg-blocked-hallucinated-customer` | static, red-team | blocked |

---

## Staging Proof Plan

1. Deploy Rust sidecar from current branch (same flow as Phase 2A.5)
2. Enable `FEATURE_POLICY_GUARD_AGENT_ENABLED=true` on `vantro-node-staging` only
3. Prove Rust endpoint directly:
   - Blocked case (MARK_PAID) → 200, blocked=true
   - Allowed case (SEND_FIRM_REMINDER) → 200, allowed=true, approval_required=true, safe_to_auto_execute=false
   - Auth rejection → 401 for missing/invalid token
4. Prove Node endpoint:
   - Same blocked/allowed cases via `/api/agents/core.policy_guard/evaluate`
   - Fail-closed: stop Rust → verify Node returns blocked=true (POLICY_GUARD_UNAVAILABLE)
5. Verify zero DB mutations (no INSERT/UPDATE/DELETE)
6. Run safety checks: node --check, security:secrets, cortex:test, agents:seed:validate

---

## Production Safety Checklist

- [ ] `FEATURE_POLICY_GUARD_AGENT_ENABLED` NOT set on production
- [ ] `core.policy_guard` is_active=false in agent_registry
- [ ] No DB migrations required or applied
- [ ] No production deploys triggered
- [ ] FIR regression tests passing
- [ ] cortex:test 100/100

---

## Rollback

1. Set `FEATURE_POLICY_GUARD_AGENT_ENABLED=false` on staging → endpoint 404
2. No DB changes → no migration rollback needed
3. `cortex/policy_guard.rs` unchanged → all existing tests still pass
4. No production touch → nothing to roll back in production

---

## Next Actions (Phase 2B → Phase 2C)

After staging proof:
1. Run safety checks (node --check, security:secrets, cortex:test, agents:seed:validate)
2. Commit + push for CI
3. Phase 2C options:
   - Wire `core.cost_router` (next low-risk, no-LLM agent)
   - Merge branch to main after owner sign-off
   - Begin production readiness for `core.data_quality` (owner UI review flow)

---

*Phase 2A (data_quality implementation) → Phase 2A.5 (staging proof) → Phase 2B (policy_guard implementation) → Phase 2B.5 (staging proof) → Phase 2C*
