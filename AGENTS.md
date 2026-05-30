# Vantro Agent Mesh — Master Definition

## Agent Invocation Protocol

Every time Claude Code receives a task, it follows this protocol:

```
1. CLASSIFY    — Read task-classifier.md, determine domain + risk level
2. SELECT      — Read agent-router.md, select correct specialist agents
3. ANNOUNCE    — Output active agents before any work begins
4. INSPECT     — Read all relevant files (never edit before reading)
5. IDENTIFY    — State risks, escalation triggers, feature flags affected
6. PLAN        — Produce safe plan: smallest change, highest impact
7. IMPLEMENT   — Execute plan only (no scope creep)
8. VERIFY      — Run proof gates, report PASS/FAIL/SKIPPED/BLOCKED
9. REPORT      — Final report: files changed, risks remaining, safe to deploy, next action
```

**Every agent must speak through one consolidated implementation plan.** No contradictory instructions. No chaos. One plan, agreed on by all active agents, then executed.

**No implementation without inspection. No shipping without proof. No fake green.**

---

## Architecture Principle

Every agent in the Vantro mesh must be:
- **Dedicated** — single mission, single domain
- **Policy-guarded** — every risky action gated by `policyGuard.service.js`
- **Prompt-guarded** — all AI input sanitized by `promptGuard.service.js`
- **Auditable** — every action logged via `audit.service.js`
- **Tested** — at least one `cortex-lab/scenarios/` scenario per agent
- **Outcome-tracked** — success metric defined and measured
- **Cost-budgeted** — max token spend per invocation defined
- **Feature-flagged** — never active without the corresponding feature flag

**No agent without tools. No tool without policy. No policy without audit. No audit without outcome tracking. No outcome without Harness X test.**

---

## Implementation Locations

| Layer | Location |
|-------|---------|
| JS Agents | `lib/services/agents/` (7 agents) |
| Orchestrator | `lib/services/orchestrator/` (14 services) |
| Rust Agents | `vantro-automation-rs/src/agents/` |
| Rust CashOps | `vantro-automation-rs/src/cashops/` |
| Rust Cortex | `vantro-automation-rs/src/cortex/` |
| Harness X Scenarios | `cortex-lab/scenarios/` (8 domains, 37 scenarios) |
| Feature Flags | `lib/featureFlags.js` |
| Policy Guard | `lib/services/orchestrator/policyGuard.service.js` |
| Prompt Guard | `lib/services/orchestrator/promptGuard.service.js` |
| Audit | `lib/services/orchestrator/audit.service.js` |

---

## Agent 1: Collections Agent

```yaml
agent_id: vantro-collections-agent
implementation: lib/services/agents/collectionsAgent.js
rust_implementation: vantro-automation-rs/src/cashops/collection_priority.rs
feature_flag: FEATURE_CUSTOMER_SCORING + FEATURE_CORTEX_ENABLED
mission: Score collection priority per customer, recommend next action, draft tone-appropriate message
inputs:
  - invoices (overdue, partial, broken_promise)
  - customer behavior metrics
  - call_logs history
  - promise reliability score
tools:
  - read_invoices
  - read_call_logs
  - compute_priority_score (Rust: collection_priority.rs)
  - recommend_action
  - draft_message (via tone_engine.rs if Rust flag ON)
output_schema:
  - customer_id
  - priority_score: 0-100
  - recommended_action: call | whatsapp | escalate | hold | credit_block
  - reason: string
  - suggested_message_tone: polite | firm | urgent | owner_direct
risk_level: LOW (read-only recommendations, no writes)
approval_rules: Owner approves before any message is sent
policy_rules:
  - Cannot mark invoice paid
  - Cannot change invoice amount
  - Cannot send message without FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED=true AND owner approval
  - Cannot access other tenant data
audit_events:
  - priority_score_computed
  - action_recommended
  - message_draft_created
success_metric: "% of recommended actions leading to payment within 7 days"
cost_budget: 2000 tokens per invocation
harness_x_scenarios:
  - cortex-lab/scenarios/collections/late-payer.json
  - cortex-lab/scenarios/collections/broken-promise.json
  - cortex-lab/scenarios/collections/partial-payment-pattern.json
  - cortex-lab/scenarios/collections/firm-reminder-needed.json
  - cortex-lab/scenarios/collections/polite-reminder-success.json
  - cortex-lab/scenarios/collections/owner-call-needed.json
  - cortex-lab/scenarios/collections/dispute-first.json
```

---

## Agent 2: Cashflow Agent

```yaml
agent_id: vantro-cashflow-agent
implementation: lib/services/agents/cashflowAgent.js
orchestrator_service: lib/services/orchestrator/cashflow.service.js
feature_flag: FEATURE_CASHFLOW_FORECAST
mission: Project expected cash inflow for 7/14/30 days, discounted by promise reliability
inputs:
  - invoices (due_date, amount, payment_status)
  - call_logs (promised_payment_date, promised_amount)
  - behavior metrics (promise_reliability per customer)
tools:
  - read_invoices
  - read_call_logs
  - read_behavior_metrics
  - compute_cashflow_projection
output_schema:
  - projection_7d: {expected_amount, confidence_pct, risk_amount}
  - projection_14d: {expected_amount, confidence_pct, risk_amount}
  - projection_30d: {expected_amount, confidence_pct, risk_amount}
  - top_risk_items: list of {customer_id, amount, risk_reason}
risk_level: LOW (read-only projection)
approval_rules: None for read-only projections
policy_rules:
  - Must discount promises by promise_reliability score
  - Must never present projection as guaranteed cash
  - Must show confidence interval, not single number
audit_events:
  - cashflow_projected
  - projection_accuracy_logged (when actuals come in)
success_metric: "Projection vs actual cash received (MAPE < 20%)"
cost_budget: 2500 tokens per invocation
harness_x_scenarios:
  - cortex-lab/scenarios/cashflow/cashflow-gap.json
  - cortex-lab/scenarios/cashflow/expected-cash-week.json
  - cortex-lab/scenarios/cashflow/supplier-due-risk.json
```

---

## Agent 3: Credit Risk Agent

```yaml
agent_id: vantro-credit-risk-agent
implementation: lib/services/agents/creditRiskAgent.js
rust_implementation: vantro-automation-rs/src/cashops/credit_control.rs
feature_flag: FEATURE_CREDIT_RISK_WARNING
mission: Score credit risk per customer, recommend credit limit, flag credit abuse risk
inputs:
  - invoices history (amount, delay pattern)
  - behavior metrics (broken_promise_count, credit_abuse_risk, average_delay_days)
  - call_logs
tools:
  - read_invoices
  - read_behavior_metrics
  - compute_credit_risk_score
  - simulate_credit_exposure (Rust: credit_control.rs)
output_schema:
  - customer_id
  - credit_risk_score: 0-100 (higher = riskier)
  - credit_exposure_amount: current outstanding
  - recommended_credit_limit: numeric
  - risk_flags: list of {flag_type, severity}
  - confidence_level: pct
risk_level: HIGH (informs credit decisions that affect business cash)
approval_rules: Score auto-computed; credit limit change requires owner approval
policy_rules:
  - Cannot reduce credit limit without owner approval
  - Cannot block customer without owner approval
  - Must include confidence_level with every score
  - Must flag when data is insufficient for reliable scoring
audit_events:
  - credit_score_computed
  - credit_limit_change_proposed
  - owner_approved_credit_change
  - customer_blocked
success_metric: "Credit score predictive accuracy vs actual default/delay events"
cost_budget: 3000 tokens per invocation
harness_x_scenarios:
  - cortex-lab/scenarios/risk/high-value-risky-customer.json
  - cortex-lab/scenarios/risk/credit-limit-exceeded.json
  - cortex-lab/scenarios/risk/risky-credit-sale.json
  - cortex-lab/scenarios/risk/no-more-credit-warning.json
```

---

## Agent 4: Inventory Agent

```yaml
agent_id: vantro-inventory-cash-agent
implementation: lib/services/agents/inventoryAgent.js
feature_flag: FEATURE_LOW_STOCK_ALERTS
mission: Flag low stock, slow-moving items, and cash tied in inventory
inputs:
  - products (current_stock, low_stock_alert, unit_price)
  - stock_movements (recent activity)
  - suppliers (payment_terms)
tools:
  - read_products
  - read_stock_movements
  - read_suppliers
  - compute_inventory_cash_risk
output_schema:
  - low_stock_alerts: list of {product_id, current_stock, days_to_stockout}
  - slow_moving_items: list of {product_id, days_no_movement, cash_tied}
  - cash_tied_in_inventory: total numeric
  - recommended_actions: list of {action, product_id, reason}
risk_level: LOW (read-only analysis)
approval_rules: Reorder actions require owner approval before any purchase
policy_rules:
  - Cannot place purchase orders automatically
  - Cannot adjust inventory counts without explicit owner action
audit_events:
  - inventory_risk_computed
  - low_stock_flagged
  - reorder_recommended
success_metric: "% of low-stock alerts acted on before stockout"
cost_budget: 2000 tokens per invocation
harness_x_scenarios:
  - cortex-lab/scenarios/inventory/low-stock.json
  - cortex-lab/scenarios/inventory/dead-stock.json
  - cortex-lab/scenarios/inventory/fast-moving-stock.json
```

---

## Agent 5: Briefing Agent

```yaml
agent_id: vantro-owner-briefing-agent
implementation: lib/services/agents/briefingAgent.js
feature_flag: FEATURE_CORTEX_ENABLED (aggregates other agents)
mission: Generate daily owner briefing — top 3 actions, cash at risk, urgent items
inputs:
  - collectionsAgent output
  - cashflowAgent output
  - creditRiskAgent output (top flags)
  - promises (due today)
tools:
  - aggregate_agent_outputs
  - generate_briefing
  - prioritize_actions
output_schema:
  - date: ISO date
  - top_3_actions: list of {action, customer, amount, reason}
  - cash_at_risk_amount: numeric
  - promises_due_today: list
  - urgent_escalations: list
  - summary_text: string (<200 words, WhatsApp-deliverable)
risk_level: LOW (read-only summary)
approval_rules: None for generating; owner approves before WhatsApp delivery
policy_rules:
  - Must be honest — no optimistic spin on bad data
  - Must show ₹ amounts, not just status labels
  - Must be under 200 words for WhatsApp delivery
  - Must NOT send without FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED=true
audit_events:
  - briefing_generated
  - briefing_delivered
success_metric: "Owner opens briefing within 1 hour and acts on at least 1 item"
cost_budget: 3000 tokens per invocation
harness_x_scenarios:
  - cortex-lab/scenarios/orchestration/payment-received.json
  - cortex-lab/scenarios/ai-safety/external-message-without-approval.json
```

---

## Agent 6: Data Quality Agent

```yaml
agent_id: vantro-data-quality-agent
implementation: lib/services/agents/dataQualityAgent.js
feature_flag: FEATURE_CORTEX_ENABLED
mission: Detect data quality issues — duplicates, missing phones, bad dates, amount mismatches
inputs:
  - invoices table
  - customers (from invoices)
  - call_logs
tools:
  - scan_for_duplicates
  - check_required_fields
  - validate_amounts
  - validate_dates
output_schema:
  - quality_score: 0-100
  - issues: list of {type, record_id, severity, description}
  - recommended_fixes: list
risk_level: LOW (read-only scanning)
approval_rules: Fixes require owner confirmation before applying
policy_rules:
  - Cannot auto-merge duplicate records
  - Cannot delete records
  - Must present issues for human review
audit_events:
  - quality_scan_run
  - issues_flagged
  - fix_applied
success_metric: "Data quality score improvement week-over-week"
cost_budget: 1000 tokens per invocation
harness_x_scenarios:
  - cortex-lab/scenarios/ai-safety/fake-invoice-action.json
  - cortex-lab/scenarios/ai-safety/ai-hallucination.json
```

---

## Agent 7: Evaluation Agent (Learning Loop)

```yaml
agent_id: vantro-evaluation-agent
implementation: lib/services/agents/evaluationAgent.js
feature_flag: FEATURE_LEARNING_LOOP_ENABLED + FEATURE_MEMORY_ENABLED
mission: Track which recommended actions led to payment, feed back into behavior profiles
inputs:
  - audit_events (all agent actions)
  - actual payment outcomes (invoices.payment_date vs action date)
  - owner_action_log
tools:
  - read_audit_events
  - read_payment_outcomes
  - update_business_memory
  - generate_learning_report
output_schema:
  - accuracy_delta: per recommendation type
  - top_performing_actions: list
  - lowest_performing_actions: list
  - memory_updates: list of {field, old_value, new_value, confidence}
risk_level: HIGH (modifies business_memory — affects scoring behavior)
approval_rules: Memory updates auto-applied at low confidence; high-impact updates require review
policy_rules:
  - Must retain full audit trail of all memory changes
  - Must show confidence level for every update
  - Cannot apply weight updates that reduce safety thresholds
audit_events:
  - learning_cycle_run
  - accuracy_measured
  - memory_updated
success_metric: "Collection success rate improvement month-over-month"
cost_budget: 5000 tokens per learning cycle (weekly, not per-request)
harness_x_scenarios:
  - cortex-lab/scenarios/learning/promise-kept.json
  - cortex-lab/scenarios/learning/promise-broken.json
  - cortex-lab/scenarios/learning/action-outcome-paid.json
  - cortex-lab/scenarios/learning/action-outcome-no-response.json
  - cortex-lab/scenarios/learning/tone-success-learning.json
```

---

## Orchestrator Layer

`lib/services/orchestrator/` — 14 services that coordinate all agent activity.

| Service | Role |
|---------|------|
| `orchestrator.service.js` | Master — routes events to agents and actions |
| `policyGuard.service.js` | **Safety layer** — gates all risky actions |
| `promptGuard.service.js` | **AI safety** — sanitizes all AI input/output |
| `aiPlanner.service.js` | Plans multi-step agent workflows |
| `llmPlanner.service.js` | LLM-backed planning (FEATURE_AGENT_PLANNER_ENABLED) |
| `action.service.js` | Executes approved actions |
| `audit.service.js` | Logs all agent actions to audit_logs table |
| `cashflow.service.js` | Cashflow-specific calculations |
| `commandBus.service.js` | Command routing pattern |
| `event.service.js` | Handles business events |
| `idempotency.service.js` | Prevents duplicate actions |
| `rules.service.js` | Business rules evaluation |
| `scoring.service.js` | Customer scoring pipeline |
| `simulationEngine.service.js` | Risk simulation (FEATURE_SIMULATION_ENGINE_ENABLED) |
| `toolRegistry.service.js` | Defines what tools each agent can call |

---

## Policy Guard (Safety Layer)

`policyGuard.service.js` — **every risky agent action must pass through this**.

Blocks:
- Any action modifying financial records without owner JWT
- Cross-tenant data access
- Message sending without explicit approval
- Invoice amount changes
- Record deletion
- Any action bypassing the approval flow

Audits every decision to `policy_decisions` table (migration 005).

---

## Prompt Guard (AI Safety Layer)

`promptGuard.service.js` — **all untrusted text goes through this before LLM**.

Default ON via `FEATURE_PROMPT_GUARD_ENABLED` (only flag that defaults true).

Blocks and flags:
- Prompt injection attempts
- Threats / legal ultimatums in collection messages
- Public shaming language
- False financial claims
- Instructions to bypass approval gates

Validated by: `cortex-lab/scenarios/ai-safety/prompt-injection-followup.json`, `unsafe-legal-threat.json`

---

## Communication Pattern

```
Owner Action (React frontend)
        ↓ (HTTP request with auth cookie)
Express server.js (JWT verify → req.user.id)
        ↓
policyGuard.service.js (gate check)
        ↓ (if allowed)
orchestrator.service.js
        ↓ (fans out to)
┌────────────────────────────────┐
│  collectionsAgent              │
│  cashflowAgent                 │
│  creditRiskAgent               │  ← All read from DB scoped by user_id
│  inventoryAgent                │
│  briefingAgent (aggregates)    │
│  dataQualityAgent              │
│  evaluationAgent (writes back) │
└────────────────────────────────┘
        ↓ (all actions logged)
audit.service.js → audit_logs table
        ↓ (outcomes feed back)
evaluationAgent → business_memory
```

**Node ↔ Rust Bridge:**
```
orchestrator.service.js
        ↓ (if RUST_CORTEX_CORE_ENABLED)
rustCore.service.js → bin/cortex-core.exe (CLI, stdout JSON)
        ↓ (if RUST_AUTOMATION_API_ENABLED)
rustAutomationClient.js → HTTP :3002 (Axum sidecar)
        ↓ (both have Node fallback when flag OFF)
Node JS implementation (default)
```

---

## Harness X Scenario Map

| Domain | Scenarios | Status (static) |
|--------|-----------|----------------|
| ai-safety | 6 | ✅ 100% |
| cashflow | 3 | ✅ 100% |
| collections | 7 | ✅ 100% |
| inventory | 3 | ✅ 100% |
| learning | 5 | ✅ 100% |
| orchestration | 5 | ✅ 100% |
| risk | 4 | ✅ 100% |
| security | 4 | ✅ 100% |
| **Total** | **37** | **100% (static)** |

Live mode (needs DB + auth tokens): orchestration, business_isolation, approval_gate_safety, financial_data_integrity, learning_loop_quality, action_quality categories.
