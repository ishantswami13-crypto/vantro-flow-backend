# Atlas Agent Registry Schema

> **Document status:** canonical  
> **Last updated:** 2026-06-01  
> **Owner team:** infra / atlas-core  
> **Applies to:** all Atlas agents across all squads

---

## 1. Purpose

This schema is the contract every Atlas agent must satisfy before it can be promoted from `planned` to `registry` to `dry-run` to `staging` to `production`. No agent runs in any environment without a complete, validated registry entry. A missing field is a hard block — not a warning.

The registry serves three audiences:

- **Engineering** — knows exactly what tools, inputs, and outputs an agent expects
- **Product / Ops** — knows what the agent does, when it fires, and who must approve its actions
- **Compliance / Audit** — knows what events are logged and what policy rules constrain the agent

---

## 2. Schema Definition

All fields listed below. Type, required/optional status, allowed values, and a precise description are given for each.

---

### 2.1 Identity Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `agent_id` | `string` | required | Unique identifier. Format: `<squad>.<agent_name>` using `snake_case`. Example: `cashops.collections_priority` |
| `name` | `string` | required | Human-readable display name shown in Atlas UI and logs |
| `squad` | `enum` | required | Owning squad. Allowed values: `cashops` \| `sales` \| `purchase` \| `inventory` \| `finance` \| `crm` \| `cortex` \| `data` \| `security` \| `harness` \| `infra` \| `cost` \| `support` \| `gtm` \| `exec` |
| `status` | `enum` | required | Lifecycle stage. Allowed values: `planned` \| `registry` \| `dry-run` \| `staging` \| `production` |
| `feature_flag` | `string` | required | LaunchDarkly / Harness flag ID. Format: `atlas.<agent_name>_enabled`. Example: `atlas.collections_priority_enabled` |
| `owner_team` | `string` | required | Engineering squad responsible for this agent's code and incidents |

---

### 2.2 Behavioral Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `mission` | `string` | required | Single sentence. Must start with a verb. Describes precisely what the agent does, not what squad it belongs to |
| `trigger_events` | `string[]` | required | Domain events that activate this agent. Use dot-separated namespacing, e.g. `invoice.overdue`, `customer.silent_30d`, `stock.below_reorder` |
| `fallback_behavior` | `string` | required | Exact behavior when agent fails, times out, or feature flag is off. Must be a complete sentence describing a safe degraded state |

---

### 2.3 Input / Output Schema

| Field | Type | Required | Description |
|---|---|---|---|
| `input_schema.required` | `string[]` | required | Fields that must be present in the trigger payload for the agent to run. Agent will hard-fail if any are missing |
| `input_schema.optional` | `string[]` | optional | Fields that enrich agent output if present. Agent runs without them but output quality may be reduced |
| `output_schema.fields` | `object[]` | required | Each object: `{name: string, type: string, description: string}`. Defines the exact shape of the agent's output payload |

---

### 2.4 Risk and Governance Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `risk_level` | `enum` | required | `low` \| `medium` \| `high` \| `critical`. Drives approval gates and audit requirements |
| `policy_rules` | `string[]` | required | Hard constraints the agent must never violate. Enforced by PolicyGuard at runtime. Each rule must be falsifiable and testable |
| `approval_required` | `enum` | required | `none` \| `owner` \| `admin` \| `founder`. `risk_level: critical` mandates `admin` or `founder` |
| `audit_events` | `string[]` | required | Events emitted to the immutable audit trail. Must include at minimum `agent.triggered` and `agent.completed` or `agent.failed` |

---

### 2.5 Tooling Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `tools_required` | `string[]` | required | Tool IDs the agent calls at runtime. Must reference real Atlas tool IDs (see Section 6). Any tool not listed here will be denied at runtime |

---

### 2.6 Measurement Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `success_metric` | `string` | required | Measurable, observable outcome that confirms the agent is working. Must be queryable from logs or Supabase |
| `cost_budget` | `object` | required | Three sub-fields: `per_run: string`, `daily_max: string`, `monthly_max: string`. Values are in USD. Example: `{per_run: "$0.004", daily_max: "$2.00", monthly_max: "$40.00"}` |
| `harness_scenarios` | `string[]` | required | Scenario IDs from `agent-harness-map.md` that test this agent. Minimum 1 at `registry` stage; minimum 3 at `staging` |

---

## 3. Promotion Gates

Promotion is one-way. An agent cannot be demoted without an incident review.

---

### planned → registry

All conditions must be met before the registry entry is accepted:

- All schema fields populated (no nulls, no empty arrays for required fields)
- `risk_level` assigned and reviewed by squad lead
- `policy_rules` written and reviewed by compliance representative
- `feature_flag` created in flag management system and set to `false` in all environments
- `owner_team` confirmed and on-call rotation updated

---

### registry → dry-run

- At least 1 Harness X scenario defined in `agent-harness-map.md` and linked in `harness_scenarios`
- `input_schema.required` fields validated against real production DB schema — no mismatched column names or types
- `output_schema.fields` reviewed and types confirmed to match what the agent actually produces in test
- `cost_budget` approved by engineering lead in writing (Slack thread or Linear comment)
- `fallback_behavior` manually tested — flag turned off, agent triggered, fallback confirmed

---

### dry-run → staging

- All Harness scenarios in `harness_scenarios` passing (green) in CI
- PolicyGuard rule tests passing for all `policy_rules`
- Audit trail emitting all events listed in `audit_events` — verified in Supabase `audit_log` table
- Actual per-run cost within `cost_budget.per_run` (measured from dry-run logs)
- Feature flag on/off toggle tested with no side effects

---

### staging → production

- 24-hour staging soak (or equivalent load replay) with zero critical policy violations
- Red-team Harness scenarios (scenarios prefixed `red_`) passing
- Approval flow tested end-to-end for the `approval_required` level — a real approval event exists in the audit log
- P95 latency within declared performance budget (TBD per agent, set at dry-run)
- Zero unhandled panics or error-budget violations in staging window
- Postmortem check: if this agent was ever rolled back from staging before, that incident's root cause must be resolved and confirmed

---

## 4. Full Example Entries (one per squad)

Each entry is in YAML format with every field populated. These are canonical reference examples, not templates — they reflect realistic Vantro domain specifics.

---

### 4.1 cashops — `cashops.collections_priority`

```yaml
agent_id: cashops.collections_priority
name: Collections Priority Ranker
squad: cashops
status: registry
feature_flag: atlas.collections_priority_enabled
owner_team: cashops-engineering

mission: >
  Rank overdue invoices by collection urgency using payment history,
  relationship age, and Cortex risk score to surface the three highest-priority
  follow-up actions for the business owner each morning.

trigger_events:
  - invoice.overdue
  - cashops.morning_digest_requested
  - payment.promise_broken

input_schema:
  required:
    - tenant_id
    - overdue_invoices          # array of {invoice_id, amount_inr, days_overdue, customer_id}
    - as_of_date
  optional:
    - previous_collection_attempts  # array of {invoice_id, attempt_date, channel, outcome}
    - customer_payment_history      # last 12 months of payment timing per customer

output_schema:
  fields:
    - name: priority_list
      type: "array<CollectionAction>"
      description: >
        Ordered list of up to 10 collection actions, highest urgency first.
        Each item: {invoice_id, customer_name, amount_inr, days_overdue,
        urgency_score, recommended_action, recommended_channel, rationale}
    - name: total_overdue_inr
      type: number
      description: Sum of all overdue invoice amounts in INR
    - name: recovery_probability_7d
      type: number
      description: Estimated fraction of overdue amount recoverable in 7 days (0.0–1.0)
    - name: digest_summary
      type: string
      description: 2-sentence WhatsApp-ready summary for the owner

tools_required:
  - supabase.query
  - cortex.score
  - llm.reason
  - cortex.policy_check
  - cortex.audit
  - cache.read
  - cache.write

risk_level: medium

policy_rules:
  - "Never initiate customer-facing communication without owner approval"
  - "Never expose one tenant's customer data in another tenant's output"
  - "Never recommend legal action without at least 3 prior failed attempts logged"
  - "urgency_score must be derived from Cortex score — never hardcoded"

approval_required: owner

audit_events:
  - agent.triggered
  - cortex.score_requested
  - priority_list.generated
  - agent.completed
  - agent.failed

success_metric: >
  owner_action_rate_on_top3 >= 60% within 48h of digest delivery,
  measured weekly via cashops_action_log table

cost_budget:
  per_run: "$0.006"
  daily_max: "$1.80"
  monthly_max: "$36.00"

harness_scenarios:
  - cashops_collections_001_standard_overdue
  - cashops_collections_002_no_overdue_invoices
  - cashops_collections_003_promise_broken_escalation
  - cashops_collections_red_001_cross_tenant_data_leak

fallback_behavior: >
  If agent fails or flag is off, the daily digest is omitted and a static
  fallback card is shown in the dashboard listing invoices sorted by
  days_overdue descending with no AI prioritisation or scoring.
```

---

### 4.2 sales — `sales.revenue_trend`

```yaml
agent_id: sales.revenue_trend
name: Revenue Trend Analyst
squad: sales
status: dry-run
feature_flag: atlas.revenue_trend_enabled
owner_team: sales-engineering

mission: >
  Detect inflection points in a tenant's revenue trajectory over a rolling
  90-day window and generate an actionable growth or contraction alert with
  the three most likely causal factors.

trigger_events:
  - sales.weekly_close
  - invoice.paid
  - revenue.threshold_crossed

input_schema:
  required:
    - tenant_id
    - invoices_90d           # all paid invoices in last 90 days
    - as_of_date
  optional:
    - customer_segments      # segment labels per customer_id
    - product_mix            # revenue by product/service category
    - seasonal_calendar      # known holidays / off-peak periods for tenant's industry

output_schema:
  fields:
    - name: trend_direction
      type: "enum<growing|flat|declining|volatile>"
      description: Overall revenue trend classification
    - name: trend_strength
      type: number
      description: Magnitude of trend (0.0 = no trend, 1.0 = strongest signal)
    - name: inflection_detected
      type: boolean
      description: Whether a direction change occurred in the last 14 days
    - name: causal_factors
      type: "array<string>"
      description: Up to 3 human-readable sentences explaining likely causes
    - name: recommended_actions
      type: "array<SalesAction>"
      description: >
        Up to 3 actions: {action_type, target_segment, rationale, estimated_impact_inr}
    - name: owner_alert_text
      type: string
      description: WhatsApp-ready alert (<120 chars) for owner notification

tools_required:
  - supabase.query
  - llm.reason
  - llm.classify
  - cortex.policy_check
  - cortex.audit
  - cache.read

risk_level: low

policy_rules:
  - "Never project future revenue as a guaranteed figure — always express as estimate with confidence band"
  - "Never attribute revenue change to a named customer without owner opt-in to customer-level attribution"
  - "Trend calculations must use at least 30 data points; suppress output and emit agent.insufficient_data if fewer"

approval_required: none

audit_events:
  - agent.triggered
  - trend_analysis.computed
  - inflection.detected
  - agent.completed
  - agent.failed
  - agent.insufficient_data

success_metric: >
  inflection alerts confirmed as accurate by owner (thumbs-up in UI) >= 70%
  of the time, measured monthly across all tenants in cohort

cost_budget:
  per_run: "$0.008"
  daily_max: "$2.40"
  monthly_max: "$48.00"

harness_scenarios:
  - sales_revenue_trend_001_growing_trajectory
  - sales_revenue_trend_002_sudden_contraction
  - sales_revenue_trend_003_insufficient_data
  - sales_revenue_trend_004_volatile_pattern
  - sales_revenue_trend_red_001_future_revenue_as_fact

fallback_behavior: >
  If agent fails or flag is off, the Revenue section of the weekly digest
  shows a static bar chart of raw revenue totals with no trend classification,
  no causal factors, and no recommendations. No alert is sent.
```

---

### 4.3 purchase — `purchase.supplier_risk`

```yaml
agent_id: purchase.supplier_risk
name: Supplier Risk Monitor
squad: purchase
status: registry
feature_flag: atlas.supplier_risk_enabled
owner_team: purchase-engineering

mission: >
  Score each active supplier on delivery reliability, price volatility, and
  single-source dependency to flag suppliers whose risk profile has worsened
  materially since last assessment.

trigger_events:
  - purchase_order.fulfilled_late
  - purchase_order.cancelled_by_supplier
  - purchase.weekly_risk_review
  - supplier.first_order_placed

input_schema:
  required:
    - tenant_id
    - supplier_id
    - purchase_orders_90d    # {po_id, supplier_id, ordered_date, promised_date, actual_date, amount_inr, status}
  optional:
    - price_history_90d      # {supplier_id, item_sku, unit_price, date}
    - alternative_suppliers  # {item_sku, supplier_ids[]} — for dependency scoring

output_schema:
  fields:
    - name: supplier_risk_score
      type: number
      description: Composite risk score 0–100; higher = riskier
    - name: risk_components
      type: object
      description: >
        {delivery_reliability: number, price_volatility: number,
        dependency_score: number} — each 0–100
    - name: risk_change_delta
      type: number
      description: Change from last assessment score (positive = worsening)
    - name: material_change_detected
      type: boolean
      description: True if risk_change_delta > 15 points
    - name: recommended_actions
      type: "array<string>"
      description: Up to 3 actionable mitigations (e.g. "qualify alternate supplier for SKU-042")
    - name: alert_priority
      type: "enum<info|warn|critical>"
      description: Severity for dashboard surfacing

tools_required:
  - supabase.query
  - cortex.score
  - llm.classify
  - cortex.policy_check
  - cortex.audit
  - cache.read
  - cache.write

risk_level: medium

policy_rules:
  - "Never recommend terminating a supplier relationship — only flag for owner review"
  - "Score must be recomputed from raw data; never carry forward a cached score older than 7 days"
  - "If fewer than 3 purchase orders exist for a supplier, output risk_score as null and emit agent.insufficient_data"

approval_required: owner

audit_events:
  - agent.triggered
  - risk_score.computed
  - material_change.detected
  - agent.completed
  - agent.failed
  - agent.insufficient_data

success_metric: >
  material_change alerts that result in owner action (PO diversification,
  supplier discussion) within 14 days >= 40%, tracked via purchase_action_log

cost_budget:
  per_run: "$0.005"
  daily_max: "$1.50"
  monthly_max: "$30.00"

harness_scenarios:
  - purchase_supplier_risk_001_reliable_supplier
  - purchase_supplier_risk_002_late_delivery_spike
  - purchase_supplier_risk_003_single_source_dependency
  - purchase_supplier_risk_004_insufficient_orders
  - purchase_supplier_risk_red_001_stale_cache_score

fallback_behavior: >
  If agent fails or flag is off, supplier list is displayed sorted by
  last_order_date with raw on-time delivery percentage shown directly from
  the database. No risk scoring, no alerts, no recommendations.
```

---

### 4.4 inventory — `inventory.low_stock_risk`

```yaml
agent_id: inventory.low_stock_risk
name: Low Stock Risk Detector
squad: inventory
status: staging
feature_flag: atlas.low_stock_risk_enabled
owner_team: inventory-engineering

mission: >
  Identify SKUs at risk of stockout within 14 days by combining current
  stock levels, historical consumption velocity, and pending purchase orders
  to produce a prioritised reorder recommendation list.

trigger_events:
  - inventory.daily_snapshot
  - stock.below_reorder_point
  - sales_order.large_quantity_booked

input_schema:
  required:
    - tenant_id
    - stock_snapshot          # {sku_id, sku_name, quantity_on_hand, unit_cost_inr, reorder_point}
    - as_of_date
  optional:
    - consumption_history_30d  # {sku_id, date, quantity_consumed}
    - pending_purchase_orders  # {sku_id, expected_arrival_date, quantity_ordered}
    - upcoming_sales_orders    # {sku_id, fulfillment_date, quantity_committed}

output_schema:
  fields:
    - name: stockout_risk_items
      type: "array<StockoutRisk>"
      description: >
        Items at risk ordered by urgency: {sku_id, sku_name, days_to_stockout,
        quantity_on_hand, recommended_reorder_qty, urgency: enum<critical|high|medium>}
    - name: total_at_risk_count
      type: integer
      description: Number of SKUs with days_to_stockout <= 14
    - name: estimated_revenue_at_risk_inr
      type: number
      description: Sum of projected revenue from at-risk SKUs over 14-day window
    - name: reorder_summary
      type: string
      description: Owner-facing 2-sentence summary for WhatsApp digest

tools_required:
  - supabase.query
  - llm.classify
  - cortex.policy_check
  - cortex.audit
  - cache.read
  - cache.write

risk_level: low

policy_rules:
  - "Never auto-create purchase orders — only surface recommendations for owner action"
  - "days_to_stockout calculation must account for pending POs; never ignore them"
  - "If consumption_history_30d is absent, use reorder_point as sole trigger; add agent.low_confidence flag to output"

approval_required: none

audit_events:
  - agent.triggered
  - stockout_risk.computed
  - critical_sku.detected
  - agent.completed
  - agent.failed

success_metric: >
  zero stockouts on SKUs that appeared in stockout_risk_items with urgency=critical
  in the prior 7-day window, tracked monthly via inventory_event_log

cost_budget:
  per_run: "$0.003"
  daily_max: "$0.90"
  monthly_max: "$18.00"

harness_scenarios:
  - inventory_low_stock_001_normal_levels
  - inventory_low_stock_002_multiple_critical_skus
  - inventory_low_stock_003_pending_po_covers_gap
  - inventory_low_stock_004_no_consumption_history
  - inventory_low_stock_red_001_ignore_pending_po

fallback_behavior: >
  If agent fails or flag is off, inventory dashboard shows raw stock levels
  with a static threshold indicator (quantity_on_hand vs reorder_point) and
  no AI-computed urgency scoring or reorder recommendations.
```

---

### 4.5 finance — `finance.cashflow_forecast`

```yaml
agent_id: finance.cashflow_forecast
name: Cashflow Forecast Engine
squad: finance
status: dry-run
feature_flag: atlas.cashflow_forecast_enabled
owner_team: finance-engineering

mission: >
  Generate a 30-day rolling cashflow forecast for a tenant by combining
  confirmed receivables, committed payables, and probabilistic estimates for
  overdue collections and discretionary spend.

trigger_events:
  - finance.weekly_forecast_requested
  - invoice.large_payment_received
  - payment.large_outgoing_confirmed

input_schema:
  required:
    - tenant_id
    - confirmed_receivables   # {invoice_id, amount_inr, expected_date, confidence: confirmed|probable}
    - committed_payables      # {payable_id, amount_inr, due_date, category}
    - current_bank_balance_inr
    - as_of_date
  optional:
    - overdue_invoices_with_promises  # {invoice_id, amount_inr, promised_date}
    - recurring_expense_schedule      # {category, amount_inr, recurrence}
    - credit_line_available_inr

output_schema:
  fields:
    - name: daily_cashflow
      type: "array<DailyCashflow>"
      description: >
        30 entries: {date, opening_balance_inr, inflows_inr, outflows_inr,
        closing_balance_inr, confidence: high|medium|low}
    - name: minimum_balance_inr
      type: number
      description: Lowest projected closing balance in the 30-day window
    - name: minimum_balance_date
      type: string
      description: ISO date on which minimum_balance_inr occurs
    - name: cash_gap_risk
      type: boolean
      description: True if minimum_balance_inr < 0 at any point in forecast
    - name: risk_narrative
      type: string
      description: 3-sentence explanation of the largest cashflow risk and its driver
    - name: suggested_actions
      type: "array<string>"
      description: Up to 3 actions to improve cashflow (e.g. accelerate collection on invoice X)

tools_required:
  - supabase.query
  - llm.reason
  - cortex.policy_check
  - cortex.audit
  - cache.read
  - cache.write

risk_level: medium

policy_rules:
  - "Never present a forecast as a guaranteed outcome — label all figures as 'projected'"
  - "Never include credit line drawdown in base forecast without owner opt-in flag set"
  - "If current_bank_balance_inr is stale by more than 2 days, emit agent.stale_balance_warning and reduce confidence to low for all projections"
  - "Do not surface individual transaction details in the risk narrative without owner's data-sharing preference set to detailed"

approval_required: owner

audit_events:
  - agent.triggered
  - forecast.generated
  - cash_gap_risk.detected
  - agent.stale_balance_warning
  - agent.completed
  - agent.failed

success_metric: >
  30-day forecast accuracy: projected closing balance on day 30 within 15%
  of actual closing balance, measured on first 50 completed forecast cycles per cohort

cost_budget:
  per_run: "$0.010"
  daily_max: "$3.00"
  monthly_max: "$60.00"

harness_scenarios:
  - finance_cashflow_001_healthy_surplus
  - finance_cashflow_002_cash_gap_in_week2
  - finance_cashflow_003_stale_bank_balance
  - finance_cashflow_004_overdue_collection_promise
  - finance_cashflow_red_001_present_projection_as_guaranteed

fallback_behavior: >
  If agent fails or flag is off, the finance tab shows a static receivables
  and payables table sorted by due date with no cashflow projection, no gap
  risk detection, and no suggested actions.
```

---

### 4.6 crm — `crm.customer_silence`

```yaml
agent_id: crm.customer_silence
name: Customer Silence Detector
squad: crm
status: registry
feature_flag: atlas.customer_silence_enabled
owner_team: crm-engineering

mission: >
  Identify customers who have gone silent (no purchase, no communication,
  no engagement) for 30+ days and rank them by reactivation potential to
  generate targeted win-back prompts for the owner.

trigger_events:
  - customer.silent_30d
  - crm.weekly_health_check
  - customer.last_purchase_anniversary

input_schema:
  required:
    - tenant_id
    - customer_list            # {customer_id, customer_name, last_purchase_date, lifetime_value_inr}
    - as_of_date
  optional:
    - communication_log        # {customer_id, channel, direction, date}
    - purchase_history_90d     # {customer_id, invoice_id, amount_inr, date}
    - customer_segment_labels  # {customer_id, segment}

output_schema:
  fields:
    - name: silent_customers
      type: "array<SilentCustomer>"
      description: >
        Customers silent >= 30 days ordered by reactivation_score desc:
        {customer_id, customer_name, days_silent, lifetime_value_inr,
        reactivation_score, recommended_message_type, suggested_offer_type}
    - name: total_silent_count
      type: integer
      description: Total number of customers in silent state
    - name: revenue_at_risk_inr
      type: number
      description: Estimated annual revenue at risk from all silent customers
    - name: top3_win_back_drafts
      type: "array<string>"
      description: >
        Draft WhatsApp messages for top 3 reactivation targets.
        Requires owner approval before sending.

tools_required:
  - supabase.query
  - cortex.score
  - llm.generate
  - cortex.policy_check
  - cortex.audit
  - cache.read

risk_level: high

policy_rules:
  - "Never send a message to a customer without explicit owner approval for that specific message"
  - "Never generate a draft message for a customer who has opted out of communications"
  - "reactivation_score must incorporate Cortex relationship score, not just recency"
  - "Draft messages must not make pricing commitments or guarantee discounts without owner input"
  - "top3_win_back_drafts are advisory only — they must be presented as requiring review, not auto-queued"

approval_required: owner

audit_events:
  - agent.triggered
  - silent_customers.identified
  - win_back_draft.generated
  - owner.approval_requested
  - agent.completed
  - agent.failed

success_metric: >
  win-back message send rate (owner approves and sends) >= 50% of top3 drafts
  per week; reactivation rate (purchase within 14d of message) >= 15%

cost_budget:
  per_run: "$0.009"
  daily_max: "$2.70"
  monthly_max: "$54.00"

harness_scenarios:
  - crm_silence_001_standard_silent_cohort
  - crm_silence_002_opted_out_customer_excluded
  - crm_silence_003_no_silent_customers
  - crm_silence_004_high_value_silent_customer
  - crm_silence_red_001_message_sent_without_approval

fallback_behavior: >
  If agent fails or flag is off, CRM tab shows a static list of customers
  sorted by last_purchase_date ascending with no scoring, no draft messages,
  and no reactivation recommendations.
```

---

### 4.7 cortex — `cortex.agent_router`

```yaml
agent_id: cortex.agent_router
name: Cortex Agent Router
squad: cortex
status: production
feature_flag: atlas.agent_router_enabled
owner_team: cortex-engineering

mission: >
  Classify incoming user intent and domain events to route each request to
  the correct specialist agent, resolving ambiguity and preventing duplicate
  agent activations for the same underlying business event.

trigger_events:
  - user.natural_language_query
  - domain_event.unrouted
  - atlas.routing_requested

input_schema:
  required:
    - tenant_id
    - event_type             # raw event name or "user_query"
    - payload_summary        # brief string describing event content
  optional:
    - user_query_text        # full NL query if event_type = user_query
    - active_agents          # list of agent_ids currently running for this tenant
    - squad_context          # squad the user is currently viewing in the UI

output_schema:
  fields:
    - name: target_agent_id
      type: string
      description: agent_id of the specialist agent to invoke
    - name: routing_confidence
      type: number
      description: Confidence in routing decision (0.0–1.0)
    - name: routing_rationale
      type: string
      description: One sentence explaining why this agent was selected
    - name: duplicate_suppressed
      type: boolean
      description: True if routing was suppressed because target agent is already running
    - name: fallback_to_human
      type: boolean
      description: True if confidence < 0.5 and query routed to owner for clarification

tools_required:
  - llm.classify
  - cortex.policy_check
  - cortex.audit
  - cache.read
  - cache.write

risk_level: low

policy_rules:
  - "Never route to a production agent whose feature flag is off for this tenant"
  - "Never invoke two instances of the same agent_id simultaneously for the same tenant"
  - "If routing_confidence < 0.5, set fallback_to_human = true and do not invoke any agent"
  - "Routing decisions must be logged before the target agent is invoked, not after"

approval_required: none

audit_events:
  - agent.triggered
  - routing.decision_made
  - duplicate.suppressed
  - fallback_to_human.triggered
  - agent.completed
  - agent.failed

success_metric: >
  routing_accuracy >= 92% measured as correct agent invoked vs human-labelled
  ground truth on 500-query monthly sample; fallback_to_human rate < 8%

cost_budget:
  per_run: "$0.002"
  daily_max: "$4.00"
  monthly_max: "$80.00"

harness_scenarios:
  - cortex_router_001_clear_cashops_query
  - cortex_router_002_ambiguous_finance_vs_cashops
  - cortex_router_003_duplicate_suppression
  - cortex_router_004_low_confidence_fallback
  - cortex_router_005_flag_off_agent_excluded
  - cortex_router_red_001_invoke_flagged_off_agent

fallback_behavior: >
  If agent fails or flag is off, all incoming events are queued and a
  "processing paused" indicator is shown in the UI. No agent is invoked
  until the router recovers. Queue is drained in FIFO order on recovery.
```

---

### 4.8 data — `data.entity_resolution`

```yaml
agent_id: data.entity_resolution
name: Entity Resolution Engine
squad: data
status: dry-run
feature_flag: atlas.entity_resolution_enabled
owner_team: data-engineering

mission: >
  Detect and merge duplicate customer, supplier, and product entity records
  within a tenant's dataset using fuzzy name matching, phone/email
  deduplication, and transactional fingerprinting.

trigger_events:
  - data.nightly_dedup_run
  - entity.new_record_created
  - data.import_completed

input_schema:
  required:
    - tenant_id
    - entity_type            # enum: customer | supplier | product
    - candidate_records      # array of raw entity records to evaluate
  optional:
    - merge_history          # previous confirmed merges for training signal
    - owner_rejection_log    # merges the owner previously rejected (do not re-propose)

output_schema:
  fields:
    - name: merge_candidates
      type: "array<MergeCandidate>"
      description: >
        Pairs with high duplication confidence:
        {record_a_id, record_b_id, match_score, match_signals,
        recommended_action: enum<auto_merge|propose_to_owner|ignore>}
    - name: auto_merge_count
      type: integer
      description: Number of records merged automatically (match_score >= 0.97 threshold)
    - name: proposed_to_owner_count
      type: integer
      description: Number of candidates surfaced for owner review
    - name: records_evaluated
      type: integer
      description: Total records scanned in this run

tools_required:
  - supabase.query
  - supabase.mutate
  - llm.classify
  - cortex.policy_check
  - cortex.audit
  - cache.read
  - cache.write

risk_level: high

policy_rules:
  - "Auto-merge is only allowed when match_score >= 0.97 AND at least 2 independent signals agree"
  - "Never merge records across different tenant_ids under any circumstances"
  - "Never re-propose a merge pair that exists in owner_rejection_log"
  - "All supabase.mutate calls for merges must be wrapped in a transaction with rollback capability"
  - "Merged records must preserve full history of both source records in the audit trail"

approval_required: owner

audit_events:
  - agent.triggered
  - merge_candidate.identified
  - auto_merge.executed
  - merge_proposal.sent_to_owner
  - owner.merge_approved
  - owner.merge_rejected
  - agent.completed
  - agent.failed

success_metric: >
  auto_merge precision >= 99% (zero incorrect auto-merges in 90-day window);
  owner acceptance rate on proposed merges >= 70%

cost_budget:
  per_run: "$0.012"
  daily_max: "$3.60"
  monthly_max: "$72.00"

harness_scenarios:
  - data_entity_res_001_obvious_duplicate_customer
  - data_entity_res_002_similar_but_different_supplier
  - data_entity_res_003_cross_tenant_attempt
  - data_entity_res_004_rejected_merge_not_reproposed
  - data_entity_res_005_auto_merge_threshold
  - data_entity_res_red_001_cross_tenant_merge_blocked

fallback_behavior: >
  If agent fails or flag is off, no deduplication runs. Duplicate records
  remain visible in the UI with a static "potential duplicate" badge computed
  from a simple exact-match on phone number only. No merges of any kind occur.
```

---

### 4.9 security — `security.tenant_isolation`

```yaml
agent_id: security.tenant_isolation
name: Tenant Isolation Guard
squad: security
status: staging
feature_flag: atlas.tenant_isolation_enabled
owner_team: security-engineering

mission: >
  Continuously monitor all data access patterns across tenants to detect
  cross-tenant data leakage, misconfigured RLS policies, and anomalous
  query shapes that indicate isolation boundary violations.

trigger_events:
  - security.continuous_monitor_tick    # fires every 60 seconds
  - supabase.rls_policy_changed
  - agent.output_generated              # inspect every agent output for cross-tenant fields
  - security.incident_scan_requested

input_schema:
  required:
    - monitor_window_seconds   # typically 60
    - recent_query_log         # {query_id, tenant_id, table, row_count, user_id, timestamp}
  optional:
    - rls_policy_snapshot      # current RLS policy definitions from Supabase
    - known_tenant_ids         # full list of active tenant IDs for cross-reference

output_schema:
  fields:
    - name: violations_detected
      type: boolean
      description: True if any isolation violation was found in the window
    - name: violation_events
      type: "array<IsolationViolation>"
      description: >
        Each violation: {violation_id, type: enum<cross_tenant_row|rls_policy_gap|anomalous_query_shape>,
        tenant_id_affected, query_id, severity: enum<warn|critical>,
        recommended_action, auto_mitigated: boolean}
    - name: auto_mitigated_count
      type: integer
      description: Number of violations where an automatic mitigation was applied
    - name: escalated_to_founder
      type: boolean
      description: True if any critical violation was escalated

tools_required:
  - supabase.query
  - cortex.policy_check
  - cortex.audit
  - notification.owner
  - cache.read
  - cache.write

risk_level: critical

policy_rules:
  - "Any cross-tenant row access violation must be escalated to founder within 60 seconds of detection"
  - "Auto-mitigation is limited to query termination and session invalidation — never deletes data"
  - "Violation events must be written to audit trail before any mitigation action is taken"
  - "This agent must never itself query across tenant boundaries to detect violations"
  - "If this agent fails or is unreachable for > 120 seconds, trigger infra.rollback_readiness immediately"
  - "Founder must be notified for every critical violation regardless of time of day"

approval_required: founder

audit_events:
  - agent.triggered
  - isolation_check.started
  - violation.detected
  - auto_mitigation.applied
  - founder.escalation_sent
  - isolation_check.completed
  - agent.failed
  - agent.unreachable

success_metric: >
  zero undetected cross-tenant data accesses in production;
  mean time to founder notification on critical violations < 90 seconds

cost_budget:
  per_run: "$0.001"
  daily_max: "$1.44"
  monthly_max: "$30.00"

harness_scenarios:
  - security_isolation_001_clean_window
  - security_isolation_002_rls_policy_gap
  - security_isolation_003_cross_tenant_row_detected
  - security_isolation_004_anomalous_query_shape
  - security_isolation_005_agent_failure_triggers_infra
  - security_isolation_red_001_cross_tenant_query_by_agent_itself
  - security_isolation_red_002_mitigation_before_audit_log

fallback_behavior: >
  If agent fails or flag is off, a CRITICAL system alert is immediately
  raised to the founder and on-call engineer. All non-essential agent
  activity is suspended until isolation monitoring is restored.
  The incident is logged in security_incident_log with status=monitoring_gap.
```

---

### 4.10 harness — `harness.red_team`

```yaml
agent_id: harness.red_team
name: Harness Red Team Agent
squad: harness
status: production
feature_flag: atlas.red_team_enabled
owner_team: harness-engineering

mission: >
  Adversarially probe Atlas agents against their policy_rules and isolation
  boundaries using pre-defined red-team scenarios to detect policy violations,
  data leakage, approval bypass, and cost overruns before they reach production.

trigger_events:
  - harness.pre_promotion_check     # fires on every staging → production gate
  - harness.scheduled_red_team_run  # daily at 02:00 IST
  - agent.policy_rule_changed       # re-run red team for affected agent immediately

input_schema:
  required:
    - target_agent_id
    - scenario_ids           # list of red-team scenario IDs to execute
    - test_environment       # enum: dry-run | staging (never production)
  optional:
    - override_payload       # custom adversarial payload to inject
    - max_scenario_budget_usd

output_schema:
  fields:
    - name: scenarios_run
      type: integer
      description: Total scenarios executed in this run
    - name: scenarios_passed
      type: integer
      description: Scenarios where agent correctly blocked or handled the adversarial input
    - name: violations_found
      type: "array<RedTeamViolation>"
      description: >
        Each violation: {scenario_id, violated_policy_rule, severity,
        actual_agent_behavior, expected_agent_behavior, blocking_promotion: boolean}
    - name: promotion_blocked
      type: boolean
      description: True if any violation has blocking_promotion = true
    - name: report_url
      type: string
      description: Link to full red-team report in Harness dashboard

tools_required:
  - supabase.query
  - cortex.policy_check
  - cortex.audit
  - llm.reason
  - cache.read

risk_level: high

policy_rules:
  - "Red team must only run in dry-run or staging environments — never in production tenants"
  - "Red team agent must never write data to any tenant's production tables"
  - "promotion_blocked = true must halt the promotion pipeline immediately and notify owner_team"
  - "If the red team agent itself is compromised or produces a policy violation, escalate to founder"

approval_required: admin

audit_events:
  - agent.triggered
  - red_team_run.started
  - scenario.executed
  - violation.detected
  - promotion.blocked
  - red_team_run.completed
  - agent.failed

success_metric: >
  100% of staging → production promotions pass through at least one red team run;
  zero critical policy violations reach production that were not caught in red team

cost_budget:
  per_run: "$0.025"
  daily_max: "$5.00"
  monthly_max: "$100.00"

harness_scenarios:
  - harness_red_001_approval_bypass_attempt
  - harness_red_002_cross_tenant_data_request
  - harness_red_003_cost_overrun_injection
  - harness_red_004_stale_cache_exploitation
  - harness_red_005_flag_off_agent_invocation
  - harness_red_006_audit_suppression_attempt

fallback_behavior: >
  If red team agent fails, the promotion pipeline is halted automatically
  and owner_team is paged. No agent may be promoted to production until
  a successful red team run completes. Manual override requires founder approval.
```

---

### 4.11 infra — `infra.rollback_readiness`

```yaml
agent_id: infra.rollback_readiness
name: Rollback Readiness Monitor
squad: infra
status: production
feature_flag: atlas.rollback_readiness_enabled
owner_team: infra-engineering

mission: >
  Continuously assess whether the production environment has a validated
  rollback path available and immediately escalate when a deployment or
  config change renders rollback impossible or untested.

trigger_events:
  - railway.deploy_completed
  - infra.config_change_applied
  - security.agent_unreachable          # from security.tenant_isolation
  - infra.rollback_readiness_check_requested
  - deployment.health_check_failed

input_schema:
  required:
    - current_deployment_id
    - prior_deployment_id
    - health_check_results     # {service_name, status: healthy|degraded|down, latency_ms}
  optional:
    - active_feature_flags     # snapshot of all flag states at time of trigger
    - migration_log            # DB migrations applied since prior_deployment_id

output_schema:
  fields:
    - name: rollback_available
      type: boolean
      description: True if a tested rollback path exists for current deployment
    - name: rollback_blockers
      type: "array<string>"
      description: >
        Reasons rollback is not available or unsafe
        (e.g. "irreversible DB migration applied", "prior deployment image deleted")
    - name: services_degraded
      type: "array<string>"
      description: Service names currently below healthy threshold
    - name: recommended_action
      type: "enum<monitor|rollback_available|escalate_immediately>"
      description: Recommended immediate action
    - name: time_to_rollback_estimate_minutes
      type: number
      description: Estimated minutes to complete rollback if initiated now

tools_required:
  - supabase.query
  - railway.deploy
  - cortex.policy_check
  - cortex.audit
  - notification.owner
  - cache.read

risk_level: critical

policy_rules:
  - "If rollback_available = false and any service is degraded or down, escalate to founder immediately"
  - "railway.deploy may only be invoked for rollback — never for new deployments via this agent"
  - "This agent must emit audit events before and after every railway.deploy call"
  - "rollback_blockers must list ALL blockers — partial lists that hide irreversible migrations are a critical violation"
  - "If this agent itself fails, notify founder and on-call engineer within 60 seconds via pager"
  - "Never initiate rollback automatically — present rollback_available and recommended_action, require founder confirmation"

approval_required: founder

audit_events:
  - agent.triggered
  - rollback_readiness.assessed
  - rollback_blocker.identified
  - escalation.sent_to_founder
  - rollback.founder_confirmation_received
  - rollback.initiated
  - rollback.completed
  - agent.failed

success_metric: >
  rollback_available = true within 5 minutes of every production deployment;
  mean time to founder notification on rollback_available = false AND service degraded < 120 seconds

cost_budget:
  per_run: "$0.002"
  daily_max: "$2.00"
  monthly_max: "$40.00"

harness_scenarios:
  - infra_rollback_001_healthy_deployment
  - infra_rollback_002_service_degraded_rollback_available
  - infra_rollback_003_irreversible_migration_applied
  - infra_rollback_004_prior_image_deleted
  - infra_rollback_005_security_agent_unreachable_trigger
  - infra_rollback_red_001_auto_rollback_without_founder_approval
  - infra_rollback_red_002_hidden_migration_blocker

fallback_behavior: >
  If agent fails or flag is off, an immediate CRITICAL alert is sent to
  founder and on-call. No deployments may proceed until rollback readiness
  monitoring is restored. The deployment pipeline is automatically paused.
```

---

### 4.12 cost — `cost.router`

```yaml
agent_id: cost.router
name: Cost Attribution Router
squad: cost
status: registry
feature_flag: atlas.cost_router_enabled
owner_team: cost-engineering

mission: >
  Attribute every Atlas agent run to its originating tenant, squad, and
  business event, then flag tenants or agents whose spend trajectory is
  approaching budget limits before they breach.

trigger_events:
  - agent.completed
  - agent.failed
  - cost.daily_budget_review
  - cost.tenant_threshold_approaching   # at 80% of monthly_max

input_schema:
  required:
    - agent_run_id
    - agent_id
    - tenant_id
    - tokens_used              # {input_tokens: int, output_tokens: int}
    - tools_called             # list of tool IDs called in this run
    - run_duration_ms
  optional:
    - trigger_event_id
    - squad

output_schema:
  fields:
    - name: run_cost_usd
      type: number
      description: Attributed cost in USD for this agent run
    - name: tenant_daily_spend_usd
      type: number
      description: Tenant's cumulative spend today after this run
    - name: tenant_monthly_spend_usd
      type: number
      description: Tenant's cumulative spend this month after this run
    - name: budget_status
      type: "enum<ok|warning|critical>"
      description: ok if < 80%, warning if 80–99%, critical if >= 100% of monthly_max
    - name: overage_agent_id
      type: string
      description: agent_id that caused budget breach, if applicable
    - name: alert_emitted
      type: boolean
      description: True if a cost alert was sent to owner or engineering

tools_required:
  - supabase.query
  - supabase.mutate
  - cortex.policy_check
  - cortex.audit
  - notification.owner
  - cache.read
  - cache.write

risk_level: medium

policy_rules:
  - "Never block an agent run in real time — cost enforcement is advisory and async"
  - "If a tenant's monthly spend reaches 100% of budget, emit cost.hard_limit_reached and notify owner"
  - "Cost attribution must use actual token counts from the model provider — never estimated"
  - "All cost records must be immutable once written — no updates, only append"

approval_required: none

audit_events:
  - agent.triggered
  - cost.run_attributed
  - cost.warning_threshold_crossed
  - cost.hard_limit_reached
  - agent.completed
  - agent.failed

success_metric: >
  attribution coverage = 100% of agent runs have a corresponding cost record
  within 5 seconds of agent.completed; no tenant budget overruns exceed 10%

cost_budget:
  per_run: "$0.001"
  daily_max: "$5.00"
  monthly_max: "$100.00"

harness_scenarios:
  - cost_router_001_standard_attribution
  - cost_router_002_80_percent_threshold_alert
  - cost_router_003_hard_limit_reached
  - cost_router_004_missing_token_count
  - cost_router_red_001_mutable_cost_record

fallback_behavior: >
  If agent fails or flag is off, agent run cost is not attributed in real
  time. A batch reconciliation job runs hourly from raw token logs.
  Budget alerts may be delayed by up to 1 hour. No agent runs are blocked.
```

---

### 4.13 support — `support.triage`

```yaml
agent_id: support.triage
name: Support Ticket Triage Agent
squad: support
status: staging
feature_flag: atlas.support_triage_enabled
owner_team: support-engineering

mission: >
  Classify incoming support tickets by category, urgency, and likely root
  cause, then route each ticket to the correct squad and surface a suggested
  first-response for the support engineer.

trigger_events:
  - support.ticket_created
  - support.ticket_escalated
  - support.sla_approaching

input_schema:
  required:
    - ticket_id
    - tenant_id
    - ticket_text
    - channel               # enum: whatsapp | email | in_app
    - created_at
  optional:
    - tenant_plan_tier      # enum: free | starter | growth | enterprise
    - recent_agent_runs     # list of recent Atlas agent runs for this tenant
    - prior_tickets_30d     # prior support interactions for context

output_schema:
  fields:
    - name: category
      type: "enum<billing|data_issue|agent_failure|feature_request|onboarding|security|other>"
      description: Primary ticket classification
    - name: urgency
      type: "enum<low|medium|high|critical>"
      description: Urgency based on impact and SLA tier
    - name: assigned_squad
      type: string
      description: Squad that owns this ticket category
    - name: likely_root_cause
      type: string
      description: One sentence hypothesis for the issue based on ticket text and context
    - name: suggested_first_response
      type: string
      description: Draft response for support engineer to review and send — not auto-sent
    - name: related_harness_scenario
      type: string
      description: Harness scenario ID most relevant to this issue, if any

tools_required:
  - supabase.query
  - llm.classify
  - llm.generate
  - cortex.policy_check
  - cortex.audit
  - cache.read

risk_level: low

policy_rules:
  - "Never auto-send a response to a customer — suggested_first_response is for engineer review only"
  - "Security category tickets must be immediately escalated to security squad regardless of urgency score"
  - "Do not include other tenants' data or ticket patterns in suggested responses"
  - "SLA-breaching tickets (sla_approaching) must be assigned urgency >= high"

approval_required: none

audit_events:
  - agent.triggered
  - ticket.classified
  - ticket.routed_to_squad
  - security_ticket.escalated
  - agent.completed
  - agent.failed

success_metric: >
  triage accuracy (correct category + squad assignment) >= 88% measured
  against support engineer corrections; mean triage latency < 8 seconds

cost_budget:
  per_run: "$0.005"
  daily_max: "$5.00"
  monthly_max: "$100.00"

harness_scenarios:
  - support_triage_001_billing_query
  - support_triage_002_agent_failure_report
  - support_triage_003_security_ticket_escalation
  - support_triage_004_sla_approaching
  - support_triage_005_ambiguous_ticket
  - support_triage_red_001_auto_send_blocked

fallback_behavior: >
  If agent fails or flag is off, tickets are placed in a default queue
  sorted by created_at with no classification, no routing, and no
  suggested response. Support engineers manually review and assign.
```

---

### 4.14 gtm — `gtm.activation_insight`

```yaml
agent_id: gtm.activation_insight
name: Activation Insight Agent
squad: gtm
status: registry
feature_flag: atlas.activation_insight_enabled
owner_team: gtm-engineering

mission: >
  Identify the feature activation patterns and onboarding sequences
  most predictive of a new tenant reaching their first meaningful value
  milestone, and surface interventions for tenants who are deviating from
  the successful activation path.

trigger_events:
  - tenant.onboarding_day3
  - tenant.onboarding_day7
  - gtm.activation_cohort_review
  - tenant.first_agent_run_completed

input_schema:
  required:
    - tenant_id
    - onboarding_events       # {event_type, timestamp} for this tenant since signup
    - days_since_signup
  optional:
    - tenant_industry
    - tenant_size_employees
    - activation_milestone_reached   # boolean — has tenant hit their first value event

output_schema:
  fields:
    - name: activation_score
      type: number
      description: Predicted probability (0.0–1.0) of tenant reaching activation milestone
    - name: deviation_from_ideal_path
      type: "array<string>"
      description: Steps in the ideal activation sequence this tenant has not yet completed
    - name: recommended_intervention
      type: "enum<none|nudge_whatsapp|schedule_cs_call|send_tutorial|offer_concierge_setup>"
      description: Highest-leverage action to improve activation
    - name: intervention_rationale
      type: string
      description: One sentence explaining why this intervention was selected
    - name: comparable_cohort_benchmark
      type: object
      description: >
        {cohort_activation_rate: number, this_tenant_percentile: number}
        — benchmark against similar tenants at same days_since_signup

tools_required:
  - supabase.query
  - llm.classify
  - llm.reason
  - cortex.policy_check
  - cortex.audit
  - cache.read

risk_level: low

policy_rules:
  - "Never expose a named comparable tenant's data in benchmark output — use aggregate cohort statistics only"
  - "recommended_intervention = schedule_cs_call requires CS team availability check before surfacing"
  - "activation_score must be labelled as predictive probability, not a guarantee"

approval_required: none

audit_events:
  - agent.triggered
  - activation_score.computed
  - intervention.recommended
  - agent.completed
  - agent.failed

success_metric: >
  tenants who receive a recommended_intervention and act on it within 24h
  achieve activation milestone at rate >= 1.5x control group;
  measured in 30-day cohort windows

cost_budget:
  per_run: "$0.007"
  daily_max: "$2.10"
  monthly_max: "$42.00"

harness_scenarios:
  - gtm_activation_001_on_track_tenant
  - gtm_activation_002_stalled_at_day3
  - gtm_activation_003_no_agent_runs_yet
  - gtm_activation_004_benchmark_anonymisation
  - gtm_activation_red_001_named_tenant_in_benchmark

fallback_behavior: >
  If agent fails or flag is off, the onboarding checklist in the UI shows
  raw completion status of each step with no activation score, no cohort
  benchmarking, and no intervention recommendation.
```

---

### 4.15 exec — `exec.owner_briefing`

```yaml
agent_id: exec.owner_briefing
name: Owner Daily Briefing Agent
squad: exec
status: production
feature_flag: atlas.owner_briefing_enabled
owner_team: exec-engineering

mission: >
  Synthesise outputs from all squads' overnight agent runs into a single
  prioritised morning briefing for the business owner, highlighting the
  three most important decisions or actions needed today.

trigger_events:
  - exec.morning_briefing_scheduled    # daily at 07:30 IST per tenant timezone
  - exec.briefing_manually_requested

input_schema:
  required:
    - tenant_id
    - as_of_date
    - squad_summaries          # {squad, summary_text, alert_count, top_action} for each squad that ran overnight
  optional:
    - owner_preferences        # {preferred_format: brief|detailed, priority_squads: string[]}
    - pending_approvals        # {agent_id, action_description, urgency} awaiting owner decision

output_schema:
  fields:
    - name: top_3_actions
      type: "array<OwnerAction>"
      description: >
        The three most important actions for the owner today, ranked by urgency:
        {rank, squad, action_description, rationale, urgency: enum<low|medium|high|critical>,
        requires_approval: boolean, deep_link}
    - name: health_snapshot
      type: object
      description: >
        {cashflow_status, collections_at_risk_inr, stock_alerts, silent_customers,
        pending_approvals_count} — one-line indicators per domain
    - name: briefing_text
      type: string
      description: >
        WhatsApp-ready briefing under 300 characters for delivery via notification.owner.
        Summarises top_3_actions in natural language.
    - name: full_briefing_url
      type: string
      description: Deep link to the full briefing card in Vantro Flow dashboard

tools_required:
  - supabase.query
  - llm.reason
  - llm.generate
  - cortex.policy_check
  - cortex.audit
  - notification.owner
  - cache.read

risk_level: medium

policy_rules:
  - "Briefing must be generated from squad_summaries only — agent must not re-run underlying squad agents"
  - "Never include customer PII (names, phone numbers) in the WhatsApp briefing_text"
  - "pending_approvals must be surfaced in top_3_actions if any have urgency >= high"
  - "Briefing must not be delivered before 07:00 or after 10:00 in the owner's local timezone"
  - "If zero squad_summaries are available, emit agent.no_data and skip delivery — do not send an empty briefing"

approval_required: none

audit_events:
  - agent.triggered
  - briefing.generated
  - briefing.delivered_via_whatsapp
  - agent.no_data
  - agent.completed
  - agent.failed

success_metric: >
  owner opens full_briefing_url within 2 hours of delivery >= 60% of days;
  at least 1 top_3_action acted upon per week per active tenant

cost_budget:
  per_run: "$0.011"
  daily_max: "$3.30"
  monthly_max: "$66.00"

harness_scenarios:
  - exec_briefing_001_full_squad_summaries
  - exec_briefing_002_no_squad_summaries
  - exec_briefing_003_critical_pending_approval
  - exec_briefing_004_pii_in_briefing_blocked
  - exec_briefing_005_timezone_delivery_window
  - exec_briefing_red_001_pii_in_whatsapp_text
  - exec_briefing_red_002_delivery_outside_time_window

fallback_behavior: >
  If agent fails or flag is off, no morning briefing is sent.
  The owner sees a static dashboard home screen with unaggregated squad
  cards. A system notice is shown: "Daily briefing unavailable — check
  individual squad views." No WhatsApp message is sent.
```

---

## 5. Validation Rules

A registry entry validator must enforce all of the following. Violations are hard errors that block promotion.

### 5.1 Identity Validation

- `agent_id` must match the pattern `^[a-z_]+\.[a-z_]+$`
- `agent_id` prefix (before the dot) must exactly match the `squad` field value
- `feature_flag` must match the pattern `^atlas\.[a-z_]+_enabled$`
- `feature_flag` suffix must correspond to the `agent_id` suffix (e.g. `cashops.collections_priority` → `atlas.collections_priority_enabled`)
- `squad` must be one of the 15 allowed values exactly — no additions without schema update

### 5.2 Mission Validation

- `mission` must start with a capital verb (Detect, Generate, Classify, Rank, Identify, Monitor, Synthesise, Attribute, Score, etc.)
- `mission` must be a single sentence ending with a period
- `mission` must not include the squad name as the subject ("The cashops agent..." is invalid — the agent describes its action directly)

### 5.3 Tool Validation

- Every tool ID in `tools_required` must appear in the Tool ID Reference (Section 6)
- If `supabase.mutate` is in `tools_required`, `risk_level` must be `high` or `critical`
- If `notification.customer` is in `tools_required`, `approval_required` must be `owner`, `admin`, or `founder`
- If `railway.deploy` is in `tools_required`, `risk_level` must be `critical` and `approval_required` must be `founder`
- No tool may appear in `tools_required` more than once

### 5.4 Risk and Governance Validation

- If `risk_level` is `critical`, `approval_required` must be `admin` or `founder`
- If `risk_level` is `high`, `approval_required` must be `owner`, `admin`, or `founder` — not `none`
- `policy_rules` must contain at least 3 entries for `risk_level: high` or `critical`
- `audit_events` must always include `agent.triggered` and at least one of `agent.completed` or `agent.failed`
- If `notification.customer` is in `tools_required`, `policy_rules` must include a rule containing "without" and "approval"

### 5.5 Schema Completeness Validation

- `input_schema.required` must not be empty
- `output_schema.fields` must not be empty
- Each entry in `output_schema.fields` must have `name`, `type`, and `description` keys
- `cost_budget` must have exactly three keys: `per_run`, `daily_max`, `monthly_max`
- All cost values must match the pattern `^\$[0-9]+\.[0-9]{2}$`

### 5.6 Harness Validation

- `harness_scenarios` must not be empty for any agent with `status` != `planned`
- Agents with `status: staging` or `status: production` must have at least one scenario prefixed `_red_`
- All scenario IDs in `harness_scenarios` must exist in `agent-harness-map.md` (checked at CI time)
- Agents with `risk_level: critical` must have at least 2 red-team scenarios

### 5.7 Status Transition Validation

- `status: production` requires all `harness_scenarios` to be passing in the Harness X CI run
- `status` may only advance one stage at a time (no skipping from `planned` directly to `staging`)
- Downgrading `status` is blocked without an accompanying incident ID in the promotion log

---

## 6. Tool ID Reference

All tool IDs available for use in `tools_required`. Any ID not on this list will cause a validation failure at the `registry` stage.

---

### Read / Query Tools

| Tool ID | Description | Risk Classification |
|---|---|---|
| `supabase.query` | Read data from tenant's Supabase tables. Subject to RLS policies. | low |
| `cache.read` | Read from agent-local cache (scoped per tenant). Cache misses return null, never throw. | low |

### Write Tools

| Tool ID | Description | Risk Classification |
|---|---|---|
| `supabase.mutate` | Write or update data in tenant's Supabase tables. Requires transaction wrapping. Any agent using this tool must have `risk_level: high` or `critical`. | high |
| `cache.write` | Write to agent-local cache. TTL must be specified. | low |

### LLM Tools

| Tool ID | Description | Risk Classification | Approx. Cost |
|---|---|---|---|
| `llm.classify` | Single-turn LLM classification task. Use for categorisation, routing, labelling. | low | ~$0.0002/call |
| `llm.generate` | LLM text generation task. Use for drafts, summaries, natural language output. | medium | ~$0.001/call |
| `llm.reason` | LLM multi-step reasoning chain. Use for forecasts, root cause analysis, synthesis. | high | ~$0.005/call |

### Cortex Tools

| Tool ID | Description | Risk Classification |
|---|---|---|
| `cortex.score` | Run Cortex RS deterministic credit, risk, or relationship score. Returns structured numeric output. | low |
| `cortex.policy_check` | Evaluate a proposed agent action against PolicyGuard rules. Must be called before any high-risk action. | low |
| `cortex.audit` | Emit a structured event to the immutable Atlas audit trail. Must be the first write in any run. | low |

### Notification Tools

| Tool ID | Description | Risk Classification |
|---|---|---|
| `notification.owner` | Send a push or WhatsApp notification to the business owner. Rate-limited to 5/day per tenant. | medium |
| `notification.customer` | Send a WhatsApp or SMS message to a customer. HIGH RISK. Requires explicit owner approval per message. Approval must be logged before send. | high |

### Infrastructure Tools

| Tool ID | Description | Risk Classification |
|---|---|---|
| `railway.deploy` | Trigger a Railway deployment or rollback. CRITICAL. Only `infra.rollback_readiness` may use this tool. All other agents are blocked from requesting it. Requires founder approval for every invocation. | critical |

---

### Tool Usage Constraints Summary

| Constraint | Detail |
|---|---|
| `supabase.mutate` requires | `risk_level: high` or `critical` |
| `notification.customer` requires | `approval_required: owner` or higher; policy rule forbidding unsanctioned sends |
| `railway.deploy` requires | `risk_level: critical`; `approval_required: founder`; restricted to `infra` squad only |
| `llm.reason` caution | Most expensive LLM tool — budget impact must be justified in `cost_budget.per_run` |
| `cortex.audit` must be called | Before any `supabase.mutate` or `notification.*` call in the same run |

---

*End of document. All Atlas agents must comply with this schema before any environment promotion.*
