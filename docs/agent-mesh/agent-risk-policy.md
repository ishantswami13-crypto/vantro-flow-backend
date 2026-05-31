# Atlas Agent Risk & Policy Framework

**Version:** 1.0  
**Effective Date:** 2026-06-01  
**Owner:** Vantro Engineering & Security  
**Applies To:** All 80 Atlas agents across all squads

---

## 1. Purpose

This document defines how risk is classified across Atlas agents, how policy guards enforce controls at runtime, and what approval, rollback, and audit requirements apply at each risk level.

Every Atlas agent — regardless of squad, function, or frequency — operates under this framework. There are no exceptions. Agents that do not conform to this policy may not be promoted to staging or production.

This framework exists because Atlas agents act on behalf of MSME business owners. A misconfigured agent can send a wrong message to a customer, corrupt a financial record, or expose tenant data. The stakes are real. The controls must match.

---

## 2. Risk Level Definitions

### 2.1 Low Risk

**Definition:** Read-only, internal, non-customer-facing operations that produce no side effects outside the Atlas mesh.

**Characteristics:**
- Read-only database or API operations
- Internal summaries, insights, and diagnostics
- No external messages of any kind
- No changes to financial data
- No customer-facing output
- Output is consumed by other agents or dashboards only

**Approval Required:** None  
**Rollback Mechanism:** Instant — disable the feature flag. Previous system state is unchanged because no mutations occurred.

**Examples:**
- `data.revenue_trend` — reads invoice data, surfaces trend
- `data.data_freshness` — checks when data was last synced
- `harness.observability` — monitors agent health and cost metrics

---

### 2.2 Medium Risk

**Definition:** Agents that generate recommendations, forecasts, or draft content that influences decisions but do not directly execute actions or contact customers.

**Characteristics:**
- Recommendations and priority rankings
- Draft messages that are not yet sent
- Forecasts and predictive outputs
- Internal workflow suggestions or routing decisions

**Approval Required:** None for standard outputs. Owner approval required when the recommendation exceeds a defined high-value threshold (e.g., credit limit recommendation above ₹5,00,000, or bulk action affecting more than 50 records).  
**Rollback Mechanism:** Disable feature flag. Previous state is unchanged because no mutations have occurred yet.

**Examples:**
- `cashops.collections_priority` — ranks which invoices to chase
- `sales.sales_forecast` — predicts next 30-day revenue
- `purchase.cost_router` — recommends which supplier to prioritize

---

### 2.3 High Risk

**Definition:** Agents that initiate customer-facing drafts, generate credit or payment recommendations, or produce outputs that, if executed, directly affect business relationships or finances.

**Characteristics:**
- Drafting customer communication (WhatsApp, email, SMS) — even if not yet sent
- Credit limit recommendations
- Payment follow-up action plans
- Supplier payment prioritization
- Financial warnings or alerts surfaced to customers or owners

**Approval Required:** Owner must explicitly approve before any action is executed. The approval UI must present the full recommendation with all relevant context before the owner can confirm.  
**Rollback Mechanism:** Cancel the pending action before it executes. Log the cancellation with reason. System state reverts to pre-recommendation baseline.

**Examples:**
- `crm.tone_strategy` — determines message tone for a specific customer
- `cashops.owner_escalation` — recommends escalating a customer to the owner
- `finance.margin_pressure` — surfaces a margin alert

---

### 2.4 Critical Risk

**Definition:** Agents that execute irreversible or externally visible actions — including sending messages, mutating financial records, changing access controls, or producing legal-grade outputs.

**Characteristics:**
- Payment status changes in the ledger
- Invoice creation, modification, or deletion
- External message sending (WhatsApp, email, SMS) — actual dispatch
- Production deployments or infrastructure changes
- Tenant access control changes
- Legal wording in customer-facing communications
- Any permanent data mutation that cannot be trivially undone

**Approval Required:** Admin or founder confirmation required before execution. A pending critical action must remain in a proposed state until explicitly approved. Auto-approval is never permitted for critical-risk actions.  
**Rollback Mechanism:** Explicit reversal action required. Disabling the feature flag is not sufficient — the reversal must be logged and confirmed. For external messages already sent, a follow-up correction message may be required.  
**Zero-Tolerance Policy:** A single policy violation by a critical-risk agent triggers immediate agent shutdown and a mandatory security review before re-enablement.

**Examples:**
- `security.tenant_isolation` — enforces cross-tenant data barriers
- `security.legal_wording_safety` — validates legal language before dispatch
- `infra.rollback_readiness` — manages production rollback capabilities

---

## 3. Core Policy Rules

These rules apply to every Atlas agent without exception. Violation of any rule constitutes a policy breach and triggers the response defined in Section 7.

---

### RULE-001: No Direct Execution of Critical Actions

Agents cannot execute critical-risk actions directly. Every critical-risk action must be emitted as a proposal. A human — specifically the owner for business actions or an admin/founder for system actions — must explicitly confirm via the approval flow before the action transitions to executed state.

Agents that attempt to bypass the proposal/approval cycle must be blocked by PolicyGuard at the pre-execution check. This is a hard stop, not a warning.

---

### RULE-002: Tenant Isolation

No agent may access, process, query, or output data that belongs to a different tenant (identified by `user_id` or `tenant_id`). Every agent invocation must pass the requesting tenant ID, and every data query must be scoped to that tenant ID.

Violation trigger conditions:
- Agent query returns rows from a different tenant
- Agent output contains identifiers from a different tenant
- Agent attempts to write to a record owned by a different tenant

On violation: PolicyGuard blocks the action, emits a `policy.violation` event with severity `critical`, and initiates an immediate agent shutdown. The incident is escalated to the security team within 5 minutes.

---

### RULE-003: No Secret Exposure

No agent may log, output, cache, or transmit the following in cleartext under any circumstances:
- JWT tokens or session tokens
- API keys or secret keys
- Database credentials or connection strings
- Customer PII (name, phone number, Aadhaar, PAN, bank account details) in log streams
- Tenant financial data in diagnostic outputs

Agents must use masked representations (e.g., `****3421` for phone numbers) in any log or trace output. PII appearing in agent outputs must be scoped to the owning tenant's session only.

---

### RULE-004: Approval Gate Required for High and Critical Actions

High-risk agents must present their recommendation through the owner approval UI before any downstream action is triggered. The approval UI must display:
- The proposed action in plain language
- The affected customer or record
- The estimated financial or relationship impact
- A clear confirm/reject control

Critical-risk agents require admin or founder confirmation. The confirmation must be an explicit action — passive timeout or inaction does not constitute approval. Pending critical actions must expire after 24 hours if not confirmed.

---

### RULE-005: Audit Trail Mandatory

Every agent invocation must emit a complete audit event chain. The minimum required events are:

| Event | Trigger |
|---|---|
| `agent.triggered` | Agent invocation begins |
| `recommendation.generated` | Agent produces output (if applicable) |
| `approval.requested` | Approval gate is entered (if applicable) |
| `approval.received` | Owner or admin confirms |
| `action.executed` | Approved action is executed |
| `audit.completed` | Invocation cycle closes |

All audit events must include: `agent_id`, `tenant_id`, `timestamp`, `user_id` (if approval was provided), `action_type`, `risk_level`, and `outcome`.

Audit logs must be immutable. No agent or process may delete or modify an emitted audit event.

---

### RULE-006: Fallback Required

Every agent must declare a fallback behavior. If an agent fails, times out, or its feature flag is disabled at runtime, the system must degrade gracefully.

Acceptable fallback behaviors:
- Return a default/safe value with a fallback flag set
- Surface a human-readable status message to the owner dashboard
- Route the task to a queue for manual review

Unacceptable fallback behavior:
- Silent failure with no user notification
- Propagating a null or error state to a downstream agent without logging
- Retrying indefinitely without a circuit breaker

Fallback behavior must be documented in the agent's spec and tested in Harness X before production promotion.

---

### RULE-007: Cost Budget Enforced

Every agent has a declared daily cost budget (LLM token spend + external API call cost). Budgets are defined per-agent in the Atlas agent registry.

If an agent exceeds its daily cost budget:
1. The agent auto-disables for the remainder of the day
2. An alert is sent to the ops team immediately
3. A `cost.budget_exceeded` audit event is emitted
4. The agent remains disabled until the next UTC day unless manually re-enabled by an admin

Agents approaching 80% of their daily budget emit a `cost.budget_warning` event. No action is required at this threshold, but it is surfaced in the ops dashboard.

---

### RULE-008: Harness X Baseline Required

No agent may be promoted to staging without at least one passing Harness X scenario covering its core function.

No agent may enter production without all defined Harness X scenarios passing in the most recent CI run.

Harness X scenarios must cover:
- Happy path execution
- Input validation failures
- Tenant isolation enforcement
- Feature flag disabled behavior (fallback path)
- Budget exceeded behavior (for any agent with LLM or external API calls)

Harness X results are recorded per agent per build. A regression in any scenario blocks promotion.

---

### RULE-009: No Customer Data in LLM Prompts Without Anonymization

Agents that invoke external LLM APIs must anonymize or pseudonymize customer PII before constructing the prompt. Acceptable anonymization methods:

- Replace customer name with a stable pseudonym (e.g., `Customer_A7F2`)
- Replace phone numbers with masked versions (e.g., `+91-XXXXXX4821`)
- Replace monetary amounts with relative descriptors if exact values are not required by the agent function
- Remove or hash Aadhaar, PAN, or bank account references

The original PII mapping must not be sent to the LLM. Re-identification from the response must happen in the Atlas mesh only, never on the LLM provider side.

This rule applies to all external LLM providers including but not limited to Anthropic, OpenAI, and Google.

---

### RULE-010: Feature Flag Required

Every agent must be controlled by a named feature flag in the Atlas feature flag registry. The flag name must match the agent ID (e.g., `atlas.cashops.collections_priority`).

Flag defaults:
- All new agents: `false` by default
- Flag may only be set to `true` after all Harness X scenarios pass and the agent has been reviewed against this policy
- Production flag enables require a second approver (not the same engineer who wrote the agent)

Feature flags must not be hardcoded in application code. They must be read from the feature flag service at agent invocation time.

---

## 4. PolicyGuard Integration

The `security.policy_guard` agent acts as the runtime enforcement layer for this framework. It is invoked as a pre-execution check before any agent action is dispatched.

### 4.1 Pre-Execution Check Flow

```
Agent proposes action
    → PolicyGuard.check(action, agent_id, tenant_id, risk_level)
        → 1. Action type validation: is this action type permitted for this agent's declared risk level?
        → 2. Tenant ID validation: does the action's target tenant match the requesting tenant?
        → 3. Approval validation: for high/critical actions, does a confirmed approval exist?
        → 4. Budget check: is the agent within its daily cost budget?
    → Returns: { allowed: bool, reason: string, required_approval: string | null }
```

### 4.2 Response Handling

| `allowed` | `required_approval` | System Behavior |
|---|---|---|
| `true` | `null` | Action proceeds |
| `false` | `null` | Action blocked, `policy.violation` emitted |
| `false` | `"owner"` | Action queued, owner approval requested |
| `false` | `"admin"` | Action queued, admin/founder approval requested |

### 4.3 PolicyGuard as a Critical-Risk Agent

PolicyGuard itself is a critical-risk agent. It must not be disabled via feature flag without admin approval. It must always be running when any other agent is active. If PolicyGuard fails or times out, all pending agent actions must be blocked until PolicyGuard recovers. This is a hard dependency, not optional middleware.

---

## 5. Per-Squad Risk Summary Table

| Squad | Agents | Typical Risk Level | Approval Model | Key Policy Concern |
|---|---|---|---|---|
| cashops | collections_priority, dunning_calendar, owner_escalation, tone_strategy, dispute_handler, payment_reconciler, aging_bucket | Medium to High | Owner approval for high-value or customer-facing actions | Customer communication tone and payment follow-up accuracy |
| sales | sales_forecast, pipeline_health, lead_scorer, deal_velocity, win_loss_analyzer | Medium | Auto-approve for forecasts; owner for bulk recommendations | Forecast accuracy impacting owner business decisions |
| purchase | cost_router, supplier_ranker, reorder_trigger, purchase_order_draft | Medium to High | Owner approval for any purchase order draft | Supplier payment prioritization affecting cash flow |
| inventory | stock_alert, reorder_predictor, wastage_monitor, slow_mover_detector | Low to Medium | Auto-approve for alerts; owner for reorder triggers | Reorder triggers that initiate purchase flows |
| finance | ledger_integrity, financial_anomaly, tax_estimator, cash_flow_predictor, margin_pressure | High to Critical | Owner for warnings; admin for ledger mutations | Ledger integrity and financial anomaly detection |
| crm | relationship_scorer, churn_risk, contact_enricher, tone_strategy, sentiment_tracker | Medium to High | Owner for customer-facing recommendations | PII handling and customer relationship impact |
| cortex | action_center, milestone_tracker, insight_aggregator, smart_nudge | Medium to High | Owner for nudges and action items | Cross-agent data aggregation and output accuracy |
| data | revenue_trend, data_freshness, sync_monitor, schema_validator | Low | None | Data quality and freshness impacting all other agents |
| security | policy_guard, tenant_isolation, legal_wording_safety, audit_logger | Critical | Admin/founder for any change or disable | Cross-tenant isolation, policy enforcement continuity |
| harness | observability, scenario_runner, regression_detector, coverage_tracker | Low to Medium | None for reads; admin for test overrides | Test integrity and promotion gate reliability |
| infra | rollback_readiness, incident_response, deployment_gate, health_monitor | Critical | Admin/founder for deployment and rollback actions | Production stability and rollback availability |
| cost | budget_tracker, token_optimizer, api_cost_monitor, savings_recommender | Low to Medium | None for monitoring; admin for budget limit changes | Cost overruns disabling agents mid-day |
| support | ticket_classifier, response_suggester, escalation_router | Medium | Owner for escalations | Customer-facing language and escalation accuracy |
| gtm | campaign_planner, cohort_analyzer, activation_scorer | Medium | Owner for campaign actions | Customer segmentation accuracy and messaging compliance |
| exec | kpi_dashboard, board_summary, goal_tracker | Low to Medium | None for read; founder for goal mutations | Executive output accuracy and confidentiality |

---

## 6. Critical Agents — Detailed Controls

### 6.1 `security.tenant_isolation`

**What makes it critical:** This agent enforces the data boundary between every tenant in the system. A failure here is a data breach — one customer's financial data becomes visible to another.

**Failure mode:** If the tenant ID validation logic has a bug, a query built for Tenant A could return or mutate records for Tenant B. In an MSME context, this exposes a business's customer list, outstanding invoices, and payment history to a competitor or unrelated party. The reputational and legal damage would be severe.

**Hard stop conditions:**
- Any query returning rows where `tenant_id != requesting_tenant_id` — block query, emit critical alert, shut down requesting agent
- Any write operation targeting a record where `tenant_id != requesting_tenant_id` — block write, emit critical alert, initiate incident
- Feature flag disable requires admin approval and a documented reason; PolicyGuard must remain active even if this agent is under maintenance

---

### 6.2 `security.legal_wording_safety`

**What makes it critical:** This agent validates language in customer communications before dispatch. Legal wording errors — false promises about payment terms, incorrect statutory notices, misleading collection language — can create contractual obligations or regulatory violations.

**Failure mode:** If this agent passes a message containing legally problematic language, an MSME owner could inadvertently send a message that constitutes an illegal debt collection practice under Indian law or creates a binding commitment the business cannot fulfill.

**Hard stop conditions:**
- Any message containing prohibited patterns (threats, false legal authority claims, incorrect statutory citations) must be blocked and returned for human review
- If the validation model is unavailable, all message dispatches must be queued — never bypassed
- Messages passing this check must carry a `legal_wording_checked: true` flag; any dispatch without this flag is blocked by PolicyGuard

---

### 6.3 `security.policy_guard`

**What makes it critical:** PolicyGuard is the runtime enforcement layer for this entire framework. If it fails, all enforcement stops. Every other agent's risk controls depend on it.

**Failure mode:** If PolicyGuard is unavailable or returns incorrect responses, high-risk and critical-risk agents could execute without approval, tenant isolation checks could be skipped, and budget controls could be bypassed. This is a systemic failure, not a single agent failure.

**Hard stop conditions:**
- If PolicyGuard times out or returns an error, the requesting agent's action must be blocked — fail closed, never fail open
- PolicyGuard itself must not be subject to its own approval gate for reads; only mutations to its policy configuration require admin approval
- PolicyGuard health must be monitored by `harness.observability` with a sub-60-second alert threshold

---

### 6.4 `infra.rollback_readiness`

**What makes it critical:** This agent manages the system's ability to revert to a known-good state. If it is misconfigured or its rollback artifacts are stale, a production incident could result in extended downtime or permanent data loss.

**Failure mode:** A deployment introduces a regression. The team attempts a rollback. The rollback artifact is missing, corrupted, or points to an incompatible migration state. The system cannot recover without a manual, time-consuming database restore.

**Hard stop conditions:**
- Rollback readiness must be validated before every production deployment — deployment gate blocks if rollback artifact is not confirmed present and tested
- If the rollback artifact is more than 7 days old for a production environment, emit a `rollback.stale_artifact` alert
- Rollback execution requires admin confirmation; no automated rollback without explicit trigger

---

### 6.5 `infra.incident_response`

**What makes it critical:** This agent coordinates the response to production incidents. Incorrect escalation, missed alerts, or wrong runbook selection during an incident extends downtime and potentially worsens the incident.

**Failure mode:** An incident occurs. The agent misclassifies the severity, routes to the wrong on-call contact, or selects an outdated runbook. The actual responder receives incorrect instructions. Resolution time doubles.

**Hard stop conditions:**
- Incident severity classification must be confirmed by a human before automated runbook execution begins
- Runbooks must be version-controlled and validated against the current production architecture — stale runbooks must be flagged
- Any action that involves production data changes during incident response requires admin confirmation, even under time pressure

---

### 6.6 `finance.ledger_integrity`

**What makes it critical:** This agent validates the consistency and accuracy of the financial ledger. The ledger is the source of truth for every invoice, payment, and balance in the system. A corrupt or inconsistent ledger cannot be trusted for tax, compliance, or business decisions.

**Failure mode:** A sync error or concurrent write creates a discrepancy between the ledger balance and the sum of transactions. If undetected, this propagates into tax calculations, GST filings, and owner financial reports. Correcting a corrupted ledger retroactively is extremely difficult and may require external audit.

**Hard stop conditions:**
- If a ledger integrity check fails, all write operations to the affected tenant's financial records must be paused until the discrepancy is resolved
- Integrity checks must run on a schedule (minimum: every 6 hours) and before any bulk financial operation
- Discrepancy alerts must reach the founder within 15 minutes; unacknowledged alerts escalate to a P1 incident

---

### 6.7 `finance.financial_anomaly`

**What makes it critical:** This agent detects unusual financial patterns that may indicate fraud, data entry errors, or system bugs. False negatives leave problems undetected; false positives that trigger incorrect alerts erode owner trust.

**Failure mode:** An anomaly detector with a poorly calibrated threshold flags a legitimate large payment as fraud, blocks a transaction, and damages the relationship with that customer. Alternatively, a real anomaly goes undetected because the threshold is too permissive.

**Hard stop conditions:**
- Any action triggered by an anomaly detection (e.g., flagging a transaction, sending an alert) requires owner confirmation before execution
- Anomaly model thresholds must be reviewed monthly and after any significant business growth event
- False positive rate must be tracked; if it exceeds 10% in any 7-day window, the model must be reviewed before further use

---

## 7. Policy Violation Response

When PolicyGuard detects or any system component reports a policy violation, the following sequence executes:

1. **Action Blocked** — PolicyGuard returns `{ allowed: false, reason: "<violation description>" }`. The requesting agent's action does not execute.

2. **Audit Event Emitted** — A `policy.violation` event is written to the immutable audit log immediately. The event includes: `agent_id`, `tenant_id`, `violation_type`, `rule_id` (e.g., `RULE-002`), `timestamp`, `blocked_action`, `severity`.

3. **Agent Flagged for Review** — The violating agent is marked with a `policy_review_pending` flag in the agent registry. This flag does not disable the agent but is visible in the ops dashboard.

4. **Auto-Disable on Repeated Violations** — If a single agent accumulates 3 or more `policy.violation` events within any 24-hour window, the agent is automatically disabled (feature flag set to `false`) pending investigation. A `agent.auto_disabled` event is emitted.

5. **Security Team Alert** — An alert is sent to the security team immediately on any violation. For critical-risk violations (RULE-001, RULE-002, RULE-003), the alert is P1 priority and requires acknowledgment within 30 minutes.

6. **Incident Logged** — A formal incident record is created in the incident management system. The incident captures: timeline, affected tenant, agent involved, actions blocked, and assigned investigator.

7. **Re-enablement Gate** — A disabled agent may only be re-enabled after a documented root cause analysis, a fix verified by Harness X, and sign-off from the security team lead.

---

## 8. Regulatory Context — India and Global

### 8.1 India

**RBI Guidelines on Automated Customer Communication:**  
The Reserve Bank of India has issued guidelines on automated and algorithmic communication in lending and collections contexts. Atlas agents that generate collections messages, payment reminders, or credit recommendations must comply with:
- No contact outside permitted hours (typically 8am–7pm local time)
- No harassment language or undue pressure
- Clear identification of the communicating entity
- Opt-out mechanism available in every communication

The `cashops.tone_strategy` and `security.legal_wording_safety` agents are the primary enforcement points for RBI communication compliance.

**Digital Personal Data Protection (DPDP) Act, 2023:**  
The DPDP Act governs how personal data of Indian citizens is collected, processed, and stored. Atlas obligations under DPDP:
- Customer consent must be obtained before processing personal data for automated decision-making
- Data principals have the right to access their data — Atlas must support export of all agent-processed data for a given tenant on request
- Data principals have the right to erasure — Atlas must support deletion of customer PII from all agent outputs and logs on verified request
- Cross-border data transfer restrictions apply — customer data must not leave India's borders without explicit consent and appropriate safeguards

**GST and Financial Reporting:**  
Any agent that generates or modifies invoice data, payment records, or financial summaries is subject to GST Act record-keeping requirements. Records must be retained for a minimum of 8 years. The `finance.ledger_integrity` agent must enforce this retention policy.

### 8.2 Global

**GDPR (if EU customers are onboarded):**  
If Vantro Flow processes data for customers with EU-based contacts, GDPR applies. Key obligations:
- Lawful basis for processing must be documented
- Data subject access requests must be fulfilled within 30 days
- Data breach notification to supervisory authority within 72 hours of discovery
- Data processing agreements required with all third-party LLM providers

**SOC 2 (for enterprise customers):**  
Enterprise customers may require SOC 2 Type II audit evidence. Atlas supports this through:
- Immutable audit logs (RULE-005)
- Access controls and approval gates (RULE-004, RULE-001)
- Incident response procedures (Section 7)
- Vendor risk documentation for LLM API usage

### 8.3 Atlas Compliance Capabilities

| Requirement | Atlas Support |
|---|---|
| Data residency controls | Tenant data scoped by `tenant_id`; database hosted in India region |
| Right to erasure | PII deletion workflow triggered via `security.policy_guard` on verified request |
| Audit export | All audit events exportable per tenant on demand |
| Consent tracking | Consent flags stored per customer; agents check consent before communication |
| Breach notification | `infra.incident_response` triggers breach notification workflow on data exposure events |
| Retention enforcement | `finance.ledger_integrity` enforces 8-year minimum retention for financial records |

---

*This document is maintained by the Vantro Engineering and Security teams. Updates require review by the founder and must be versioned. All agents must be re-validated against this policy on any material change to risk level definitions or core policy rules.*
