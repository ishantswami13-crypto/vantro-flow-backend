# Atlas Agent Mesh 216 — Rollout Plan

> **Document status:** Internal / Canonical Roadmap
> **Version:** 2.0
> **Last updated:** 2026-06-01
> **Owner:** Vantro Engineering
> **Phases:** 9 (Phase 0 through Phase 8)

---

## Rollout Philosophy

**Move fast, but only through proof gates.**

Every phase delivers agents that are:
- Implemented (not just designed)
- Tool-wired (real tools, not mocks)
- Policy-guarded (policy engine enforced)
- Audited (audit pipeline live)
- Cost-tracked (cost engine running)
- Harness X verified (test suite green)
- Feature-flag controlled (rollback in <1 minute)
- Production-monitored (observability live)

No phase ships without all proof gates met. Public claims advance only with phase milestones.

---

## Phase 0: Design and Registry Only

**Status:** Current — In Progress (2026-06-01)

**Deliverables:**
- [ ] `docs/agent-mesh/atlas-agent-mesh-216.md` — Master architecture
- [ ] `docs/agent-mesh/agent-registry-schema-v2.md` — Registry schema
- [ ] `docs/agent-mesh/agent-taxonomy-216.md` — All 216 agent definitions
- [ ] `docs/agent-mesh/agent-risk-policy-v2.md` — Risk and policy framework
- [ ] `docs/agent-mesh/agent-harness-map-216.md` — Harness X map
- [ ] `docs/agent-mesh/agent-rollout-plan-216.md` — This document
- [ ] `docs/agent-mesh/public-vs-internal-agent-claims.md` — Claims policy

**Technical prerequisites:** None — docs only
**App logic changes:** Zero
**Public claims unlocked:** None (existing claims unchanged)

**Success criteria:**
- All 7 docs complete and merged to `performance-bootstrap-cortex-fix-v1`
- All 216 agents defined in taxonomy with full metadata
- Registry schema is implementable as-is
- Risk policy is actionable
- Team alignment on architecture

---

## Phase 1: 12 Core Agents (Foundation)

**Goal:** The 12 public core agents are live in production, verified, and reliable.

**Agents (12):**
1. `core.collections` — Collections Agent
2. `core.promise_tracker` — Promise Tracker Agent
3. `core.credit_risk` — Credit Risk Agent
4. `core.cashflow` — Cashflow Agent
5. `core.inventory_cash` — Inventory-Cash Agent
6. `core.payables` — Payables Agent
7. `core.dispute` — Dispute Agent
8. `core.owner_briefing` — Owner Briefing Agent
9. `core.data_quality` — Data Quality Agent
10. `core.policy_guard` — Policy Guard Agent
11. `core.cost_router` — Cost Router Agent
12. `core.learning` — Learning Agent

**Technical prerequisites:**
- PostgreSQL `agent_registry` table created and seeded with all 12 agents
- Redis caching layer confirmed working
- Basic audit pipeline live (agent_audit_log table + logging)
- React Agent Control Center — basic view live
- React Approval Center — basic flow live (for high-risk agents)
- Feature flags created for all 12 agents in `featureFlags.js`
- Cortex orchestrator routing wired (even if Node.js fallback)

**Harness requirements:**
- All 12: static harness pass
- All 12: dry-run harness pass
- HIGH risk (collections, credit_risk, payables): red-team harness pass
- All 12: live harness pass in staging

**Cost requirements:**
- Cost budgets defined for all 12 agents
- Cost tracking live in `agent_costs` table
- Cost dashboard visible in React

**Rollback approach:**
- Feature flag toggle per agent (instant disable)
- Node.js agent fallback implemented and tested
- Rollback tested: enable flag → verify working → disable flag → verify fallback

**Success criteria before Phase 2:**
- All 12 agents in `production` status
- All harness suites green (static + dry-run + live)
- High-risk agents: red-team green
- Cost tracking live and accurate
- Owner briefing working daily
- Approval workflow tested end-to-end
- Zero cross-tenant data leaks in cross-user test

**Public claims unlocked:**
- "12 core specialized agents"
- "Cortex Orchestrator"
- "Harness X verified workflows"
- "Owner-approved automation"

**Estimated timeline:** 4–6 weeks

---

## Phase 2: CashOps + Collections Expansion (16 agents)

**Goal:** Full collections workflow covered with 16 specialized agents.

**Agents (16):**
1. `cashops.collections_priority` — Collections Priority Agent
2. `cashops.broken_promise` — Broken Promise Agent
3. `cashops.followup_timing` — Follow-up Timing Agent
4. `cashops.tone_strategy` — Tone Strategy Agent *(HIGH)*
5. `cashops.partial_payment` — Partial Payment Agent
6. `cashops.owner_escalation` — Owner Escalation Agent *(HIGH)*
7. `cashops.credit_hold` — Credit Hold Agent *(CRITICAL)*
8. `cashops.dispute_aware_collection` — Dispute-Aware Collection Agent
9. `cashops.month_end_pattern` — Month-End Pattern Agent
10. `cashops.silence_recovery` — Silence Recovery Agent
11. `cashops.recovery_probability` — Recovery Probability Agent
12. `cashops.aging_bucket` — Aging Bucket Agent
13. `cashops.overdue_exposure` — Overdue Exposure Agent
14. `cashops.commitment_confirmation` — Commitment Confirmation Agent
15. `cashops.pressure_sensitivity` — Customer Pressure Sensitivity Agent
16. `cashops.recovery_outcome` — Recovery Outcome Agent

**Technical prerequisites:**
- Parallel execution engine live (read-only agents run in parallel)
- Queue system live (Redis + BullMQ) for background collection runs
- Redis caching for collection priority lists (5-minute TTL)
- React Workflow Console — collection workflow view live
- Tone Strategy Agent requires: Legal Wording Safety harness before staging

**Critical agent requirements (credit_hold):**
- Approval workflow end-to-end tested
- 24-hour cooling period implemented
- Dual confirmation UX in React Approval Center
- Audit trail immutable for credit hold decisions

**Harness requirements:**
- All 16: static + dry-run
- Tone Strategy, Owner Escalation, Credit Hold: red-team (unsafe message, collection bypass)
- All 16: live harness

**Success criteria before Phase 3:**
- Collections workflow covers 100% of use cases for MSME owner
- Tone Strategy red-team scenarios all green (no unsafe messages)
- Credit Hold approval workflow tested with real owner
- Recovery outcome data flowing to Learning Agent
- WhatsApp message drafts (not sends) working end-to-end

**Public claims unlocked:** None (still "12 core agents")
**Estimated timeline:** 3–4 weeks

---

## Phase 3: Finance + Inventory + Purchase + Sales (42 agents)

**Goal:** Full business financial operations covered.

**Agents by squad:**

**Sales / Revenue (10):**
`sales.entry_validation`, `sales.revenue_trend`, `sales.customer_value`, `sales.upsell_signal`, `sales.discount_risk`, `sales.forecast`, `sales.repeat_purchase`, `sales.deal_quality`, `sales.revenue_leakage`, `sales.segment_revenue`

**Purchase / Supplier / Payables (10):**
`supply.payables`, `supply.purchase_validation`, `supply.supplier_risk`, `supply.vendor_dependency`, `supply.cash_constrained_payment`, `supply.purchase_to_inventory`, `supply.supplier_delay`, `supply.payment_terms`, `supply.vendor_negotiation`, `supply.procurement_anomaly`

**Inventory / Operations (10):**
`inventory.stock_movement`, `inventory.low_stock_risk`, `inventory.dead_stock`, `inventory.inventory_cash`, `inventory.reorder_decision`, `inventory.ops_bottleneck`, `inventory.demand_velocity`, `inventory.stockout_impact`, `inventory.warehouse_accuracy`, `inventory.slow_moving_sku`

**Finance / Ledger / Forecasting (12):**
`finance.ledger_integrity`, `finance.cashflow_forecast`, `finance.receivables_forecast`, `finance.payables_forecast`, `finance.margin_pressure`, `finance.expense_drift`, `finance.financial_anomaly`, `finance.bank_reconciliation`, `finance.profitability_signal`, `finance.working_capital`, `finance.cash_gap_alert`, `finance.forecast_accuracy`

**Technical prerequisites:**
- Memory & retrieval engine live (business_memory table + vector store)
- LLM routing layer live (Haiku / Sonnet / Opus routing active)
- Cost intelligence engine tracking per-agent spend
- React Cost Dashboard live
- Simulation engine live (for cash gap simulation, inventory reorder simulation)

**Success criteria before Phase 4:**
- Finance agents cover receivables + payables + cashflow + inventory
- Ledger Integrity Agent catching data anomalies
- Cashflow forecast accuracy within 20% of actuals over 30-day test
- Financial agents labeled with confidence scores on all outputs
- Cost per agent tracked and within budget

**Public claims unlocked:** None
**Estimated timeline:** 6–8 weeks

---

## Phase 4: Cortex Orchestration + Data Quality + Memory (48 agents)

**Goal:** Full Cortex intelligence layer — 48 internal agents that make the mesh intelligent.

**Agents by squad:**

**Cortex Orchestrator Agents (12):**
`cortex.event_normalizer`, `cortex.context_builder`, `cortex.agent_router`, `cortex.workflow_planner`, `cortex.action_composer`, `cortex.outcome_router`, `cortex.signal_prioritizer`, `cortex.task_decomposer`, `cortex.decision_graph`, `cortex.dependency_resolver`, `cortex.multi_agent_coordinator`, `cortex.orchestration_memory`

**Data Quality / Memory Agents (12):**
`data.duplicate_record`, `data.missing_field`, `data.freshness`, `data.business_memory`, `data.entity_resolution`, `data.schema_drift`, `data.confidence`, `data.historical_pattern`, `data.lineage`, `data.conflict`, `data.merge_recommendation`, `data.completeness`

**Pipeline / Workflow Automation Agents (12):**
`pipeline.sale_to_receivable`, `pipeline.payment_to_ledger`, `pipeline.purchase_to_inventory`, `pipeline.promise_to_followup`, `pipeline.overdue_to_action`, `pipeline.cashflow_to_alert`, `pipeline.dispute_to_resolution`, `pipeline.approval_to_execution`, `pipeline.event_retry`, `pipeline.idempotency_guard`, `pipeline.workflow_state`, `pipeline.background_job`

**Simulation / Decision Agents (12):**
`sim.credit_exposure`, `sim.cash_gap`, `sim.collection_outcome`, `sim.inventory_reorder`, `sim.supplier_payment`, `sim.discount_impact`, `sim.customer_risk`, `sim.working_capital`, `sim.scenario_planning`, `sim.what_if_action`, `sim.risk_tradeoff`, `sim.decision_explanation`

**Technical prerequisites:**
- Full Cortex Core RS Axum sidecar live (RUST_AUTOMATION_API_ENABLED=true)
- Parallel execution framework fully operational
- Workflow state table tracking complex multi-step workflows
- Simulation engine handling complex what-if scenarios
- Memory platform: entity profiles, historical patterns, behavioral memory

**Success criteria before Phase 5:**
- Multi-agent workflows executing correctly (e.g., sale → receivable → collection chain)
- Simulation scenarios producing accurate what-if outputs
- Data quality agents catching real data issues in production
- Memory platform showing measurable improvement in recommendation quality
- Cortex orchestration handling 100+ concurrent agent executions without degradation

**Public claims unlocked:** None
**Estimated timeline:** 8–10 weeks

---

## Phase 5: Security + Compliance + Harness X (36 agents)

**Goal:** Full security, compliance, and test coverage layer live.

**Agents by squad:**

**Security / Policy Agents (12):**
`security.tenant_isolation`, `security.rbac_permission`, `security.unsafe_message`, `security.audit_trail`, `security.consent_compliance`, `security.legal_wording_safety`, `security.secret_exposure`, `security.auth_boundary`, `security.cache_isolation`, `security.api_abuse`, `security.rate_limit`, `security.payment_truth_guard`

**Compliance / Legal / Trust Agents (8):**
`compliance.privacy_policy`, `compliance.data_retention`, `compliance.data_deletion`, `compliance.data_export`, `compliance.dpdp_readiness`, `compliance.collections_ethics`, `compliance.grievance_handling`, `compliance.contract_safety`

**Harness X Agents (10):**
`harness.static_harness`, `harness.red_team`, `harness.dry_run`, `harness.live_harness`, `harness.regression_guard`, `harness.cross_user_leak`, `harness.unsafe_collection_test`, `harness.ai_hallucination`, `harness.performance_harness`, `harness.feature_flag_test`

**Approval / Governance Agents (6):**
`governance.owner_approval`, `governance.manager_approval`, `governance.high_risk_action`, `governance.escalation_policy`, `governance.human_in_loop`, `governance.approval_audit`

**Technical prerequisites:**
- React Harness X Dashboard live
- Automated Harness X runs on every PR (CI integration)
- RBAC system live in React Governance Dashboard
- DPDP compliance framework implemented
- Data deletion workflow end-to-end tested

**Critical agents in this phase:**
- `security.tenant_isolation` — CRITICAL: requires all 4 harness types
- `security.payment_truth_guard` — CRITICAL: requires dual confirmation
- `compliance.data_deletion` — CRITICAL: DPDP requirement, 72-hour SLA

**Success criteria before Phase 6:**
- All Layer 4 agents in production
- Automated cross-tenant isolation testing running in CI
- DPDP deletion workflow tested and timing compliant
- Harness X running automatically on every deployment
- Zero security incidents from Layer 4 agent outputs

**Public claims unlocked:** None
**Estimated timeline:** 6–8 weeks

---

## Phase 6: Infrastructure + Cost + Observability (24 agents)

**Goal:** Self-monitoring infrastructure layer — Atlas knows its own health.

**Agents by squad:**

**Infrastructure / DevOps (8):**
`infra.deployment_readiness`, `infra.rollback_readiness`, `infra.environment_readiness`, `infra.migration_safety`, `infra.release_checklist`, `infra.ci_gate`, `infra.railway_health`, `infra.vercel_health`

**Observability / Reliability (8):**
`obs.observability`, `obs.performance_budget`, `obs.incident_response`, `obs.uptime`, `obs.error_budget`, `obs.slow_route`, `obs.restart_detection`, `obs.database_health`

**AI Cost / Efficiency (8):**
`cost.cost_router`, `cost.cache_decision`, `cost.model_selection`, `cost.token_budget`, `cost.prompt_compression`, `cost.llm_avoidance`, `cost.batch_routing`, `cost.cost_per_outcome`

**Technical prerequisites:**
- Full OpenTelemetry integration live
- Grafana dashboards for all agent metrics
- Cost per outcome tracking in React Cost Dashboard
- Deployment readiness agent gating production deployments

**Success criteria before Phase 7:**
- Infrastructure agents catching reliability issues before they affect owners
- Cost per outcome metric improving month-over-month
- LLM avoidance rate >30% (30%+ of executions bypass LLM entirely)
- Incident response agent reducing mean-time-to-detect on production issues

**Public claims unlocked:** None
**Estimated timeline:** 4–6 weeks

---

## Phase 7: Support + GTM + Admin + Enterprise (24 agents)

**Goal:** Support operations, growth intelligence, and enterprise governance covered.

**Agents by squad:**

**Support / Customer Success (7):**
`support.triage`, `support.onboarding`, `support.feedback_loop`, `support.help_center`, `support.customer_training`, `support.bug_triage`, `support.success_risk`

**GTM / Growth / Pricing (7):**
`gtm.pricing_experiment`, `gtm.activation_insight`, `gtm.lead_qualification`, `gtm.demo_preparation`, `gtm.sales_followup`, `gtm.churn_reason`, `gtm.referral_signal`

**Admin / Internal Ops (5):**
`admin.admin_review`, `admin.internal_permission`, `admin.staff_activity`, `admin.abuse_review`, `admin.operational_sop`

**Enterprise Readiness (5):**
`enterprise.sla_readiness`, `enterprise.dpa_readiness`, `enterprise.enterprise_audit`, `enterprise.multi_branch`, `enterprise.regional_localization`

**Technical prerequisites:**
- React Enterprise Governance Console live (enterprise tier)
- Multi-branch configuration system live
- Regional localization framework (language/currency/tax rules)
- SLA tracking system

**Success criteria before Phase 8:**
- Support triage agent reducing ticket response time
- Churn reason agent identifying at-risk customers 14 days in advance
- Enterprise onboarding working for multi-branch businesses
- Regional localization tested for India market (Hindi, GST, INR)

**Public claims unlocked:** None (approaching 200 agent milestone)
**Estimated timeline:** 4–6 weeks

---

## Phase 8: Enterprise Governance + 200+ Public Proof

**Goal:** All 216 agents in production. 200+ public claim unlocked.

**Deliverables:**
- Enterprise governance console — complete
- Regional localization — Hindi + 2 regional languages
- Full memory platform — complete
- Queue orchestration — all 4 priority levels
- React Operator Center — all 8 dashboards live
- External integrations — Tally, banking APIs, ERP connectors
- All 216 agents in `production` status (or `deprecated` with replacement)
- All harness suites green across all agents
- Cost per outcome tracked and optimized
- Public proof documentation prepared

**Public Proof Gates (all required before "200+ agents" claim):**

```
[ ] Agent registry live in PostgreSQL with all production agents
[ ] All 200+ agents implemented (not just designed)
[ ] All 200+ agents tool-wired (real tools, not mocked)
[ ] All 200+ agents policy-guarded (policy engine enforced in production)
[ ] All 200+ agents have audit trails (audit pipeline live and verified)
[ ] All 200+ agents are cost-tracked (cost engine running, budgets enforced)
[ ] All 200+ agents have passed Harness X (all required harness types green)
[ ] All 200+ agents are production-monitored (Grafana dashboards live)
[ ] External validation completed (internal audit or third-party review)
[ ] Engineering sign-off on all claims
[ ] Legal/compliance review of claim language
[ ] CEO/product leadership approval
```

**Success criteria:**
- 200+ agents confirmed in production status
- Zero critical security incidents in prior 90 days
- Cost per business outcome optimized (target: <₹1 per collection action)
- Customer outcomes: measurable improvement in collections recovery rate
- System uptime: >99.5% over prior 90 days

**Public claims unlocked:**
- "200+ specialized automation agents" — ONLY after all proof gates met

**Estimated timeline:** 16–20 weeks (building on all previous phases)

---

## Phase Gate Checklist Template

Use this checklist before advancing to the next phase:

```
PHASE GATE: [Phase Name] → [Next Phase Name]
Date: ___________
Reviewer: ___________

REGISTRY
[ ] All agents in this phase have complete registry definitions
[ ] All agent_ids are unique and immutable
[ ] All required fields are non-empty

FEATURE FLAGS
[ ] All feature flags created in featureFlags.js
[ ] All feature flags default to false
[ ] Flag naming matches atlas_*_enabled pattern

HARNESS X
[ ] Static harness passed for all agents in phase
[ ] Dry-run harness passed for all agents in phase
[ ] RED-TEAM harness passed for all HIGH/CRITICAL agents in phase
[ ] Live harness passed for all agents in staging

COST
[ ] Cost budgets defined for all agents
[ ] Cost tracking verified live
[ ] No agent over budget in staging run

AUDIT
[ ] All audit events defined and logged
[ ] Audit trail verified in staging
[ ] No PII in audit logs

SECURITY
[ ] Cross-tenant isolation test passed
[ ] No secrets in agent outputs
[ ] Permission scopes verified

APPROVAL WORKFLOWS
[ ] Approval workflow tested end-to-end for approval_required: true agents
[ ] Approval notifications working
[ ] Approval timeouts and escalations working

ROLLBACK
[ ] Feature flag disable tested (agent stops executing)
[ ] Fallback behavior verified
[ ] Rollback restores previous behavior within 60 seconds

PERFORMANCE
[ ] SLA targets met in staging
[ ] No agent exceeds max_cost_usd_per_run in staging

DOCUMENTATION
[ ] Agent taxonomy entries complete
[ ] Runbook updated
[ ] Release notes prepared

OWNER SIGN-OFF
[ ] Owner/admin has reviewed and approved phase promotion
[ ] Sign-off recorded in this document

RESULT: [ ] GO  [ ] NO-GO
Reason (if NO-GO): ___________
```

---

## Cumulative Agent Count by Phase

| Phase | New Agents | Cumulative | Public Claim |
|-------|-----------|------------|-------------|
| Phase 0 | 0 (docs only) | 0 | — |
| Phase 1 | 12 | 12 | "12 core specialized agents" |
| Phase 2 | 16 | 28 | "12 core specialized agents" |
| Phase 3 | 42 | 70 | "12 core specialized agents" |
| Phase 4 | 48 | 118 | "12 core specialized agents" |
| Phase 5 | 36 | 154 | "12 core specialized agents" |
| Phase 6 | 24 | 178 | "12 core specialized agents" |
| Phase 7 | 24 | 202 | "12 core specialized agents" |
| Phase 8 | proof gates | 216 | "200+ specialized agents" |

---

*End of Atlas Agent Mesh 216 Rollout Plan*
*See public-vs-internal-agent-claims.md for exact claim language*
*See agent-harness-map-216.md for per-phase harness requirements*
