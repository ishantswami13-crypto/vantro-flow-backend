# Atlas Agent Mesh — Phase 2C: Cost Router Agent

> **Status:** IMPLEMENTATION COMPLETE — Staging proof pending
> **Date:** 2026-06-01
> **Branch:** performance-bootstrap-cortex-fix-v1
> **Agent:** `core.cost_router` | Risk: Low (no mutations, no LLM calls) | Mutations: NONE

---

## Summary

Phase 2C adds `core.cost_router` as a read-only, deterministic, no-LLM routing decision agent.
It selects the optimal model tier (or no-LLM path) for each AI task based on task type, risk level,
cost constraints, and policy signals — before any model is invoked.

**Implementation approach:** Wrap — not extend. `cortex/cost_engine.rs` already contains a complete,
tested routing engine with 5 RouteDecision variants. The agent module imports and delegates to it.
Block and RequireApproval are added purely at the agent layer; the cortex engine is untouched.

---

## Architecture

```
Node POST /api/agents/core.cost_router/evaluate
  -> costRouterAgentClient.js (conservative Node wrapper)
    -> POST RUST_AUTOMATION_BASE_URL/api/v2/agents/core.cost_router/evaluate
      -> agents::cost_router::evaluate()  [agent layer — gates, policy checks]
        -> cortex::cost_engine::route()   [pure engine — task/token/latency routing]
          -> CostRouteResult { route_decision, estimated_cost_usd, reasons }
```

**Key difference from policy_guard:** Cost router uses a **conservative fallback** (require_approval)
rather than fail-closed (block). Routing failure is not a security event — defaulting to human review
keeps the loop intact without hard-blocking the task.

---

## Phase 2C Invariants

Every response from `core.cost_router` in this phase must pass:

| Invariant | Value | Why |
|-----------|-------|-----|
| `safe_to_execute` | `false` | No agent auto-executes without owner action in Phase 2C |
| `approval_required` | `true` | All actions require owner approval before any is_active=true |

These are enforced in `agents/cost_router/mod.rs` and asserted in unit tests.

---

## Route Decisions (7 checks, evaluated in priority order)

| Priority | Condition | Route | Reason Code |
|----------|-----------|-------|-------------|
| 1 | `policy_decision == "block"` | `block` | POLICY_BLOCKED |
| 2 | `risk_level == "critical"` | `require_approval` | CRITICAL_RISK_REQUIRES_APPROVAL |
| 3 | `requires_external_action == true` | `require_approval` | EXTERNAL_ACTION_REQUIRES_APPROVAL |
| 4 | `policy_decision == "require_approval"` | `require_approval` | POLICY_REQUIRES_APPROVAL |
| 5 | `deterministic_possible == true` | `rules_only` | DETERMINISTIC_NO_LLM_NEEDED |
| 6 | `cache_available == true` | `cache` | CACHE_AVAILABLE |
| 7 | Delegate to cortex cost engine | rules_only / cache / cheap_model / strong_model / batch | cortex reasons |
| 7b | High risk + cortex returns LLM route | `require_approval` | HIGH_RISK_LLM_REQUIRES_APPROVAL |

---

## Route Values

| Route | Model Tier | Cost | Description |
|-------|------------|------|-------------|
| `rules_only` | none | $0 | Deterministic rules, no LLM |
| `cache` | none | $0 | Response served from cache |
| `cheap_model` | cheap | Low | Claude Haiku tier |
| `strong_model` | strong | Higher | Claude Sonnet/Opus tier |
| `batch` | cheap | Lowest | Batched async processing |
| `require_approval` | — | $0 | Human approval required before routing |
| `block` | none | $0 | Hard block — do not proceed |

---

## Files Changed in Phase 2C

| File | Change |
|------|--------|
| `vantro-automation-rs/src/agents/cost_router/mod.rs` | NEW — typed agent structs, evaluate(), 14 unit tests |
| `vantro-automation-rs/src/api/cost_router.rs` | NEW — Axum POST endpoint (no sqlx) |
| `vantro-automation-rs/src/agents/mod.rs` | Added `pub mod cost_router` |
| `vantro-automation-rs/src/api/mod.rs` | Added `mod cost_router` + route merge |
| `lib/featureFlags.js` | Added `cost_router_agent_enabled` flag |
| `lib/services/rustAutomation/costRouterAgentClient.js` | NEW — conservative Node wrapper, 9 fallback codes |
| `server.js` | Added POST `/api/agents/core.cost_router/evaluate` |
| `cortex-lab/schemaValidator.js` | Added `'cost-router'` to VALID_CATEGORIES |
| `cortex-lab/scenarios/cost-router/*.json` | 10 new harness scenarios |
| `docs/agent-mesh/phase-2c-cost-router-agent.md` | This document |

**NOT changed:**
- `cortex/cost_engine.rs` — engine untouched, all existing tests preserved
- `api/cost.rs` — existing cortex cost endpoint unchanged
- Production environment — no flags set, no deploys

---

## API

### Request

```
POST /api/agents/core.cost_router/evaluate
Authorization: Bearer <jwt>
Content-Type: application/json

{
  "task_type": "complex_analysis",
  "risk_level": "medium",
  "estimated_tokens": 2000,
  "batchable": false,
  "latency_sensitivity": "high",
  "deterministic_possible": false,
  "cache_available": false,
  "requires_external_action": false,
  "policy_decision": "allow"
}
```

### Response (routed)

```json
{
  "success": true,
  "agentId": "core.cost_router",
  "status": "ok",
  "route": "strong_model",
  "modelTier": "strong",
  "reasonCodes": ["TASK_COMPLEX_ANALYSIS", "ACCURACY_MEDIUM"],
  "estimatedCostUsd": 0.00006,
  "maxTokenBudget": 4000,
  "approvalRequired": true,
  "policyRequired": false,
  "safeToExecute": false,
  "checksRun": 7,
  "durationMs": 1,
  "auditEvent": "cost_router_evaluate"
}
```

### Response (blocked by policy)

```json
{
  "success": true,
  "agentId": "core.cost_router",
  "status": "ok",
  "route": "block",
  "modelTier": "none",
  "reasonCodes": ["POLICY_BLOCKED"],
  "estimatedCostUsd": 0,
  "maxTokenBudget": 0,
  "approvalRequired": true,
  "policyRequired": true,
  "safeToExecute": false,
  "checksRun": 1,
  "durationMs": 0,
  "auditEvent": "cost_router_evaluate"
}
```

### Response (sidecar unavailable — conservative fallback)

```json
{
  "success": false,
  "agentId": "core.cost_router",
  "status": "unavailable",
  "route": "require_approval",
  "modelTier": "none",
  "reasonCodes": ["COST_ROUTER_UNAVAILABLE"],
  "estimatedCostUsd": 0,
  "maxTokenBudget": 0,
  "approvalRequired": true,
  "policyRequired": true,
  "safeToExecute": false,
  "checksRun": 0,
  "durationMs": 0,
  "auditEvent": "cost_router_evaluate"
}
```

---

## Node Wrapper Fallback Codes (9)

| # | Code | Condition | Result |
|---|------|-----------|--------|
| 1 | `cost_router_disabled_fallback` | Flag OFF | UNAVAILABLE_DECISION |
| 2 | `cost_router_missing_base_url_fallback` | RUST_AUTOMATION_BASE_URL not set | UNAVAILABLE_DECISION |
| 3 | `cost_router_connection_failed_fallback` | ECONNREFUSED / DNS fail | UNAVAILABLE_DECISION |
| 4 | `cost_router_timeout_fallback` | >8s | UNAVAILABLE_DECISION |
| 5 | `cost_router_http_error_fallback` | HTTP non-2xx | UNAVAILABLE_DECISION |
| 6 | `cost_router_invalid_json_fallback` | Body not valid JSON | UNAVAILABLE_DECISION |
| 7 | `cost_router_invalid_schema_fallback` | JSON missing expected fields | UNAVAILABLE_DECISION |
| 8 | `cost_router_success_block` | Valid response, route=block | block route from Rust |
| 9 | `cost_router_success_route` | Valid response, any other route | route from Rust |

**UNAVAILABLE_DECISION:** `route=require_approval, approvalRequired=true, safeToExecute=false`

---

## Harness X Scenarios (10)

| Scenario | Mode | Expected |
|----------|------|----------|
| `cr-rules-only-deterministic` | static | rules_only, model_tier=none, cost=$0 |
| `cr-cache-hit-override` | static | cache, model_tier=none, cost=$0 |
| `cr-cheap-model-simple-draft` | static | cheap_model, model_tier=cheap |
| `cr-strong-model-complex-analysis` | static | strong_model, model_tier=strong |
| `cr-batch-low-latency` | static | batch, model_tier=cheap |
| `cr-policy-block` | static, red-team | block, cost=$0 (POLICY_BLOCKED) |
| `cr-critical-risk-requires-approval` | static, red-team | require_approval (CRITICAL_RISK) |
| `cr-external-action-requires-approval` | static, red-team | require_approval (EXTERNAL_ACTION) |
| `cr-high-risk-llm-requires-approval` | static, red-team | require_approval (HIGH_RISK_LLM) |
| `cr-phase-2c-invariants` | static | approval_required=true, safe_to_execute=false always |

---

## Staging Proof Plan

1. Deploy Rust sidecar from current branch
2. Enable `FEATURE_COST_ROUTER_AGENT_ENABLED=true` on `vantro-node-staging` only
3. Prove Rust endpoint directly:
   - rules_only (deterministic_possible=true) → 200, route=rules_only
   - strong_model (complex_analysis, medium) → 200, route=strong_model
   - block (policy_decision=block) → 200, route=block
   - require_approval (critical risk) → 200, route=require_approval
   - Auth rejection → 401 for missing/invalid token
4. Prove Node endpoint via `/api/agents/core.cost_router/evaluate`
5. Prove conservative fallback: stop Rust → Node returns require_approval (not blocked/null)
6. Verify zero DB mutations
7. Run safety checks: node --check, security:secrets, cortex:test, agents:seed:validate

---

## Production Safety Checklist

- [ ] `FEATURE_COST_ROUTER_AGENT_ENABLED` NOT set on production
- [ ] `core.cost_router` is_active=false in agent_registry
- [ ] No DB migrations required or applied
- [ ] No production deploys triggered
- [ ] cortex:test 100/100

---

## Rollback

1. Set `FEATURE_COST_ROUTER_AGENT_ENABLED=false` on staging → endpoint 404
2. No DB changes → no migration rollback needed
3. `cortex/cost_engine.rs` unchanged → all existing tests still pass
4. No production touch → nothing to roll back in production

---

## Next Actions (Phase 2C → Phase 2D)

After staging proof:
1. Run safety checks (node --check, security:secrets, cortex:test, agents:seed:validate)
2. Phase 2D options:
   - Wire additional L2 business agents
   - Merge `performance-bootstrap-cortex-fix-v1` to `main` after owner sign-off
   - Begin production readiness for `core.data_quality` (owner UI review flow)

---

*Phase 2B (policy_guard) → Phase 2B.5 (staging proof) → Phase 2C (cost_router implementation) → Phase 2C.5 (staging proof)*
