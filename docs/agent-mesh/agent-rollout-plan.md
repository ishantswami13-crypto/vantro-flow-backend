# Atlas Agent Mesh — Phased Rollout Plan

## Overview
80 agents are designed. They will not be built all at once.
Each phase has strict gates: tests, Harness X scenarios, feature flags, audit logs, rollback, cost measurement, staging proof.
Public claims are controlled by phase.

## Current Baseline (Pre-Phase 1)
- 12 core Cortex agents live (Cortex RS Milestone A+B)
- Staging soak infrastructure proven (24h Rust soak complete)
- Feature flag system: RUST_AUTOMATION_API_ENABLED
- Harness X framework: static + red-team + dry-run + live modes
- PolicyGuard: production-grade
- Audit trail: operational
- Public claim: "12 specialized business automation agents" ✅

---

## Phase 0 — Registry Only (Now → June 2026)
**Goal:** All 80 agents defined in registry. None running.

What happens:
- All 80 agent_ids defined in registry
- All schema fields populated
- Risk levels assigned
- Policy rules written
- Feature flags created (all false)
- Harness X scenarios designed (not yet running)
- Cost budgets estimated

Gates to complete Phase 0:
- [ ] All 80 registry entries validated against schema
- [ ] All feature flags confirmed off
- [ ] No runtime code changes
- [ ] No production impact

Public claim: Still "12 specialized business automation agents"
Timeline: 1-2 weeks

---

## Phase 1 — 12 Core Public Agents (June 2026)
**Goal:** The 12 agents that power the current public product claim are fully implemented, tested, and Harness X verified.

Agents in Phase 1 (the "Atlas 12"):
1. cashops.collections_priority
2. cashops.promise_tracker
3. cashops.broken_promise
4. cashops.followup_timing
5. cashops.tone_strategy
6. cashops.owner_escalation
7. finance.cashflow_forecast
8. crm.customer_silence
9. crm.customer_health
10. cortex.agent_router
11. security.policy_guard
12. exec.owner_briefing

Gates for each agent in Phase 1:
- [ ] Full registry entry validated
- [ ] Harness X static scenario passing
- [ ] Harness X red-team scenario passing
- [ ] PolicyGuard integration tested
- [ ] Audit trail emitting correct events
- [ ] Feature flag on/off tested
- [ ] Cost within budget for 7 days
- [ ] Owner approval flow tested end-to-end (for high/critical risk)
- [ ] 24h staging soak proof

Public claim after Phase 1: "12 specialized business automation agents" (still valid and now fully proven)
Timeline: June 2026 (aligns with 22 June readiness deadline)

---

## Phase 2 — CashOps + Finance + Customer Behavior (July 2026)
**Goal:** Expand to full CashOps suite + finance forecasting + CRM behavior intelligence.

New agents in Phase 2:
- cashops.dispute_detection, cashops.partial_payment, cashops.credit_hold, cashops.recovery_outcome
- finance.ledger_integrity, finance.receivables_forecast, finance.payables_forecast, finance.margin_pressure, finance.expense_drift, finance.financial_anomaly
- crm.customer_behavior, crm.relationship_risk, crm.communication_channel, crm.customer_segmentation, crm.repeat_excuse_pattern

Phase 2 additional gates:
- [ ] All Phase 1 agents stable for 30 days
- [ ] credit_hold and ledger_integrity have founder-approval flow tested
- [ ] Financial anomaly agent has red-team: intentional anomaly injection test
- [ ] Multi-tenant load test (100 tenants simulated)

Public claim after Phase 2: "30+ specialized business automation agents"
Timeline: July 2026

---

## Phase 3 — Cortex Orchestration + Data Quality + Security (August 2026)
**Goal:** Full Cortex agent mesh backbone. Data quality layer. Complete security suite.

New agents in Phase 3:
- cortex.event_normalizer, cortex.context_builder, cortex.workflow_planner, cortex.action_composer, cortex.outcome_router
- data.duplicate_record, data.missing_field, data.data_freshness, data.business_memory, data.entity_resolution
- security.tenant_isolation, security.rbac_permission, security.unsafe_message, security.audit_trail, security.consent_compliance, security.legal_wording_safety

Phase 3 critical gates:
- [ ] security.tenant_isolation: cross-tenant red-team test passing
- [ ] security.legal_wording_safety: 20+ legal threat phrases tested
- [ ] cortex.event_normalizer: 100+ event types normalized correctly
- [ ] data.business_memory: memory persistence tested across sessions
- [ ] SOC2-ready audit trail: all 80 defined audit events logging correctly

Public claim after Phase 3: "50+ specialized business automation agents"
Timeline: August 2026

---

## Phase 4 — Harness X + Infrastructure + Cost Engine (September 2026)
**Goal:** Meta-agents that govern the mesh itself. Production-grade infrastructure intelligence. AI cost optimization.

New agents in Phase 4:
- harness.static, harness.red_team, harness.dry_run, harness.live, harness.regression_guard
- infra.deployment_readiness, infra.rollback_readiness, infra.observability, infra.performance_budget, infra.incident_response
- cost.router, cost.cache_decision, cost.model_selection, cost.token_budget

Phase 4 critical gates:
- [ ] harness.red_team: adversarial injection attacks passing
- [ ] infra.rollback_readiness: simulate Rust service failure, confirm rollback in <60s
- [ ] cost.router: LLM cost reduction target: 30% vs unoptimized baseline
- [ ] infra.incident_response: PagerDuty / alert integration tested

Public claim after Phase 4: "65+ specialized business automation agents"
Timeline: September 2026

---

## Phase 5 — Sales + Purchase + Inventory + Support + GTM + Executive (October 2026)
**Goal:** Complete the mesh. All 80 agents live.

New agents in Phase 5:
- sales (6): entry_validation, revenue_trend, customer_value, upsell_signal, discount_risk, sales_forecast
- purchase (6): supplier_payables, validation, supplier_risk, vendor_dependency, cash_constrained_payment, purchase_to_inventory
- inventory (6): stock_movement, low_stock_risk, dead_stock, inventory_cash, reorder_decision, operations_bottleneck
- support (3): triage, onboarding, feedback_loop
- gtm (2): pricing_experiment, activation_insight

Phase 5 gates:
- [ ] All Phase 1–4 agents stable for 30 days
- [ ] Enterprise multi-tenant scale test: 1,000 tenants
- [ ] All 80 Harness X scenarios passing
- [ ] Cost budget validated across full mesh: total daily AI cost per tenant within target

Public claim after Phase 5: "80+ specialized business automation agents" ✅ (all implemented, tested, Harness X verified)
Timeline: October 2026

---

## Phase 6 — Production Hardening + Enterprise Controls (Q4 2026)
**Goal:** Enterprise-grade reliability, compliance, and scale.

Deliverables:
- SOC2 Type II audit readiness
- GDPR / DPDP compliance automation
- Enterprise SSO + RBAC
- Multi-region data residency
- SLA 99.9% uptime for all production agents
- Dedicated enterprise support tier
- Agent mesh performance: <200ms p50 for all orchestration decisions

Public claim: "Enterprise-grade AI automation mesh, SOC2-ready, global-scale"

---

## Rollback Rules (all phases)
Every phase must have:
1. Feature flags off = complete rollback in <5 minutes
2. Database migrations are additive only (no destructive changes)
3. Every new agent deployed behind flag with default=false
4. Staging proof required before production flag enable
5. Incident response: if any agent causes data corruption or policy violation, entire squad flag disabled within 60 seconds

## Timeline Summary Table
| Phase | Agents | Target | Public Claim |
|---|---|---|---|
| 0 — Registry | 80 designed | June 2026 | 12 |
| 1 — Core 12 | 12 live | June 22, 2026 | 12 (proven) |
| 2 — CashOps+ | ~30 live | July 2026 | 30+ |
| 3 — Cortex+Sec | ~50 live | August 2026 | 50+ |
| 4 — Infra+Cost | ~65 live | September 2026 | 65+ |
| 5 — Full mesh | 80 live | October 2026 | 80+ |
| 6 — Enterprise | 80 hardened | Q4 2026 | Enterprise-grade |
