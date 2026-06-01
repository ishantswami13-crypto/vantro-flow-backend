# Phase 2C.5 - `core.cost_router` Staging Proof

## 1. CI Status & Deployment
* **Commit**: `ede06e0`
* **CI Status**: SUCCESS (all gates passed, including offline build and Harness X static tests).
* **Rust Staging (`vantro-automation-staging`)**: Deployed successfully.
* **Node Staging (`vantro-node-staging`)**: Deployed successfully.
* **Feature Flags**: 
  * `FEATURE_COST_ROUTER_AGENT_ENABLED=true` set on Node Staging.
  * Production flag remains untouched (`false`).

## 2. End-to-End Routing Matrix Proof
Tested against both Rust directly and Node wrapper.

| Case | Expected Route | Actual Rust | Actual Node |
|---|---|---|---|
| A. Deterministic Task | `rules_only` | `rules_only` | `rules_only` |
| B. Cache Available | `cache` | `cache` | `cache` |
| C. Simple Explanation | `cheap_model` | `cheap_model` | `cheap_model` |
| D. External WhatsApp | `require_approval` | `require_approval` | `require_approval` |
| E. Financial Mutation | `block` | `block` | `block` |
| F. High Token Budget | `batch` / `require_approval` | `batch` | `batch` |

*Note: The financial mutation case also correctly returned `safeToExecute: false` from Rust.*

## 3. Auth Rejection Proof
* **Missing Token**: Both Node and Rust returned `401 Unauthorized` / `Missing Token`.
* **Invalid Token**: Both Node and Rust returned `401 Unauthorized` / `Invalid token`.

## 4. Conservative Fallback Proof
Tested with an invalid `RUST_AUTOMATION_BASE_URL` locally mocking the client.
* **Result**: Client returned `require_approval` with `safeToExecute = false`.
* **Logs**: Emitted `cost_router_connection_failed_fallback` warning.
* **Safety**: Did not crash or fail open.

## 5. Mutation Safety Proof
DB counts checked on staging via `db_count.js` using Supabase API before and after tests:
* `customers`: 2 -> 2
* `invoices`: 3 -> 3
* `promises`: 3 -> 3
* `products`: 1 -> 1
* `purchases`: 1 -> 1
* `ai_actions`: 2 -> 2
* `agent_registry`: 0 -> 0

**Result**: ZERO mutations occurred during execution. No side effects.

## 6. Performance Proof
Average response time recorded against Staging:
* **Rust Direct**: ~300ms - ~1200ms depending on payload (average public internet + compute).
* **Node Wrapper**: ~400ms - ~1300ms (Node introduces minimal overhead, mostly routing directly).
* **Failures**: None in stable execution (one ephemeral fetch retry noted). No 5xx.

## 7. Safety Checks
* `npm run check`: PASS
* `npm run security:secrets`: PASS (No hardcoded secrets)
* `npm run cortex:test`: PASS (100/100)
* `npm run agents:seed:validate`: PASS

## 8. Remaining Risks
* The `core.cost_router` remains `is_active=false` in production (as intended). 
* Node wrapper behaves safely on network failure, but continuous health checks for the sidecar should be monitored via metrics.

## 9. Next Recommended Action
Proceed to Phase 2C.6 to implement `core.owner_briefing` using the validated `cost_router` baseline, ensuring the briefing agent correctly utilizes the cache/cheap model routes as intended.
