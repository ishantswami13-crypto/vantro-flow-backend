# Atlas Agent Risk & Policy Framework v2

> **Version:** 2.0 (supersedes `agent-risk-policy.md` v1)
> **Effective date:** 2026-06-01
> **Owner:** Vantro Engineering & Security
> **Status:** Internal canonical policy — binding for all agent development

---

## 1. Risk Classification System

Every Atlas agent carries a risk level that governs how it executes, what approvals it requires, and what harness coverage it must have.

### 1.1 LOW Risk

**Definition:** Read-only operations. No state changes. No customer-facing output. No financial consequences.

**Criteria:**
- Reads data only — no writes to any system
- Output is internal (shown to operator, not sent externally)
- No financial record modification
- No customer communication
- Failure has no business impact beyond missing a recommendation

**Examples:**
- Revenue Trend Agent (reads sales data, outputs trend chart)
- Customer Behavior Agent (reads payment history, outputs behavior summary)
- Data Freshness Agent (checks when data was last updated)
- Observability Agent (reads system metrics)
- Cost Per Outcome Agent (calculates cost ratios)
- Owner Briefing Agent (synthesizes data into a brief — no external sends)

**Execution rules:**
- No approval required
- Parallel execution allowed by default
- Cached output permitted
- LLM: haiku_first or no_llm preferred
- Harness: static + dry-run required

### 1.2 MEDIUM Risk

**Definition:** Recommendations, forecasts, rankings, or draft outputs that an operator reviews before acting. No automatic execution.

**Criteria:**
- Outputs a recommendation or proposal (not an execution)
- Output is shown to operator for review
- Acting on the recommendation has business impact but is reversible
- No direct financial record changes
- No automatic external communication

**Examples:**
- Collections Priority Agent (ranks customers — operator decides to call)
- Cashflow Forecast Agent (forecasts — operator decides on action)
- Customer Segmentation Agent (segments customers — operator reviews)
- Sales Forecast Agent (predicts revenue — operator reviews)
- Aging Bucket Agent (groups overdue invoices — operator reviews)
- Repeat Purchase Agent (signals upsell opportunities — operator decides)

**Execution rules:**
- No approval required for generating the recommendation
- Approval required only if operator triggers follow-on high/critical action
- Parallel execution allowed
- LLM: sonnet_default typical
- Harness: static + dry-run required; red-team recommended

### 1.3 HIGH Risk

**Definition:** Outputs that, if acted upon, have significant business consequences. Includes customer communication drafts (to be reviewed before sending), credit limit suggestions, payment priority decisions, and collection strategy proposals.

**Criteria:**
- Customer-facing communication drafts (not yet sent, but ready to send)
- Credit limit suggestions that could affect business relationships
- Supplier payment prioritization that could damage supplier relationships
- Collection pressure strategy with potential legal/ethical dimensions
- Workflow automation proposals that would execute multiple financial actions
- Financial forecasts that will be used for binding business decisions

**Examples:**
- Tone Strategy Agent (drafts WhatsApp/email messages for review)
- Credit Risk Agent (suggests credit limit reductions)
- Owner Escalation Agent (proposes escalating to owner for a customer)
- Supplier Payment Simulation Agent (models which supplier to pay first)
- Cash Gap Simulation Agent (models funding options)
- Dispute-Aware Collection Agent (proposes collection strategy for disputed accounts)

**Execution rules:**
- Operator review required before any downstream execution
- Communication drafts require explicit "send" approval per message
- LLM: sonnet_default; opus_critical for complex reasoning
- Harness: static + dry-run + red-team required
- React UI: shows "Review and Approve" button, not "Auto-Execute"

### 1.4 CRITICAL Risk

**Definition:** Actions that directly change business state, send external communications, modify financial records, affect security configurations, or are irreversible without significant effort.

**Criteria:**
- Payment status changes (marking invoice as paid, writing off debt)
- Invoice amount modifications
- Record deletion or archival
- External message sending (WhatsApp, email, SMS actually transmitted)
- Legal wording generation that may be acted upon
- Production deployment or configuration changes
- Tenant access changes (RBAC modifications)
- Owner-only approval actions
- Security configuration changes
- Credit limit changes (actual, not suggested)
- Bank account or payment method changes

**Examples:**
- Payment Truth Guard Agent (validates payment status changes)
- Tenant Isolation Agent (manages tenant boundaries)
- Data Deletion Agent (executes data deletion requests)
- Legal Wording Safety Agent (validates legal communications)
- Deployment Readiness Agent (gates production deployments)
- Auth Boundary Agent (enforces authentication boundaries)

**Execution rules:**
- CANNOT execute directly under any circumstances
- Can ONLY propose — output is always a proposal object
- Owner or admin approval REQUIRED before any execution
- Dual confirmation for irreversible actions
- 24-hour cooling period for certain financial record changes
- Audit log MANDATORY and unconditional
- Harness X MANDATORY — all 4 types (static, dry-run, red-team, live)
- React UI: shows "View Proposal" only; "Execute" button appears only after approval

---

## 2. Critical Agent Execution Rules — MANDATORY

These rules are non-negotiable and enforced at the Cortex Core RS level:

### Rule CR-001: No Direct Execution
```
IF agent.risk_level == 'critical'
THEN agent.execution_mode MUST be 'propose'
AND agent.output MUST be ProposalObject, not ExecutionResult
AND agent.status MUST advance to 'awaiting_approval'
```

### Rule CR-002: Mandatory Approval Gate
```
IF agent.risk_level == 'critical'
THEN approval_required MUST be true
AND approval_type MUST be 'owner' OR 'admin'
AND execution BLOCKED until approval_status == 'approved'
```

### Rule CR-003: Dual Confirmation for Irreversible
```
IF action.is_irreversible == true
THEN require TWO distinct approval events
  - First: approval.requested → approval.acknowledged (operator reads the proposal)
  - Second: approval.acknowledged → approval.confirmed (operator explicitly confirms)
Minimum 60-second gap between acknowledgment and confirmation
```

### Rule CR-004: 24-Hour Cooling Period
```
IF action.category IN ['debt_writeoff', 'credit_blacklist', 'account_closure']
THEN created_at + 24 hours MUST elapse before execution allowed
Exception: emergency override requires admin approval with explicit reason
```

### Rule CR-005: Mandatory Audit
```
FOR ALL critical agent operations:
  LOG: agent_id, execution_id, business_id, user_id, action_type,
       proposal_data, approval_user_id, approval_reason, executed_at
  These records are IMMUTABLE — no delete, no update
  Retention: minimum 7 years (financial record standard)
```

### Rule CR-006: Communication Hard Gate
```
IF action.type == 'external_message_send'
THEN REQUIRE:
  - FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED == true
  - owner.approval == 'approved' for this specific message
  - message.content passed through Legal Wording Safety Agent
  - consent.verified == true for recipient
TWO gates, not one. Both must be satisfied.
```

---

## 3. Approval Matrix

| Risk Level | Who Can Approve | Timeout | Escalation |
|------------|----------------|---------|-----------|
| low | N/A (no approval) | N/A | N/A |
| medium | N/A (no approval) | N/A | N/A |
| high | Manager or Owner | 24 hours | Escalates to Owner if no Manager response |
| critical | Owner or Admin | 48 hours | Escalates to Admin; auto-cancels at expiry |

### Bulk Approval Rules
- LOW agents: bulk approval allowed (approve all summaries for today)
- MEDIUM agents: bulk approval allowed within a single category (approve all collection recommendations)
- HIGH agents: individual approval only — no bulk
- CRITICAL agents: individual approval with reason — no bulk, ever

### Emergency Override
Only for infrastructure recovery scenarios (Deployment Readiness Agent, Rollback Readiness Agent):
- Requires admin role
- Explicit reason documented
- Audit log with override flag
- Post-incident review required within 24 hours

### Approval Expiry Behavior
- HIGH: on expiry, proposal is cancelled. Agent can be re-triggered.
- CRITICAL: on expiry, proposal is cancelled and flagged for owner review. Cannot be re-triggered for 30 minutes.

---

## 4. Policy Rule Engine

### Rule Structure

```json
{
  "rule_id": "PR001",
  "description": "Exclude disputed invoices from collection actions",
  "condition": "invoice.status == 'disputed' OR customer.has_active_grievance == true",
  "action": "deny",
  "priority": 1,
  "applies_to": ["cashops.*", "crm.*"],
  "override_requires": "admin"
}
```

**Actions:**
- `allow` — Proceed with execution
- `deny` — Block execution entirely; return reason to operator
- `require_approval` — Elevate to approval workflow
- `flag_for_review` — Allow but add a warning flag to output
- `add_disclaimer` — Append required legal/compliance text to output

### Rule Priority Ordering
1. Security rules (highest priority — override everything)
2. Legal/compliance rules
3. Business ethics rules (collections ethics, consent)
4. Financial accuracy rules
5. Business logic rules (lowest priority)

### Rule Conflict Resolution
- Higher priority rule wins if conflict exists
- If same priority: more restrictive action wins (deny > require_approval > flag_for_review > allow)
- Conflicts are logged and surfaced in React Governance Dashboard

### Tenant-Level Policy Overrides (Enterprise)
Enterprise customers can customize policy rules within permitted bounds:
- Can RESTRICT further (e.g., lower approval thresholds)
- Cannot RELAX below Vantro baseline (e.g., cannot disable collections ethics rules)
- Override requires admin role + audit log entry

---

## 5. Policy Rules by Agent Category

### 5.1 Collections Agents
```
PR-C001: No collection action on disputed invoices
  condition: invoice.dispute_status == 'active'
  action: deny

PR-C002: No collection contact during prohibited hours
  condition: current_time NOT IN business_hours
  action: deny

PR-C003: Maximum contact frequency
  condition: contact_attempts_7_days >= 3
  action: require_approval  (owner must approve additional contact)

PR-C004: Grievance handling priority
  condition: customer.has_grievance == true
  action: flag_for_review, add_disclaimer: "Active grievance — review before proceeding"

PR-C005: Legal notice threshold
  condition: proposed_action.type == 'legal_notice'
  action: require_approval (owner approval required)

PR-C006: Collections ethics compliance
  condition: message.tone == 'threatening' OR message.contains_false_urgency == true
  action: deny
```

### 5.2 Financial Agents
```
PR-F001: No hallucinated financial figures
  condition: output.contains_unverified_financial_claim == true
  action: deny

PR-F002: Forecast confidence threshold
  condition: forecast.confidence_score < 0.6
  action: flag_for_review, add_disclaimer: "Low confidence forecast — treat as estimate only"

PR-F003: Large transaction threshold
  condition: proposed_action.amount > tenant.large_transaction_threshold
  action: require_approval

PR-F004: Financial record modification truth guard
  condition: action.type IN ['payment_status_change', 'invoice_amount_change']
  action: require_approval + harness_check
```

### 5.3 Security Agents
```
PR-S001: Cross-tenant isolation absolute rule
  condition: query.scope != 'current_tenant'
  action: deny (no override)

PR-S002: PII in logs
  condition: log_entry.contains_pii == true
  action: deny (no override)

PR-S003: Secret in output
  condition: output.contains_secret_pattern == true
  action: deny (no override)

PR-S004: Auth boundary enforcement
  condition: request.user_id != verified_jwt_user_id
  action: deny (no override)
```

### 5.4 Communication Agents
```
PR-M001: Consent required for external messages
  condition: FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED == false
  action: deny

PR-M002: Legal wording validation
  condition: message.is_legal_communication == true
  action: require Legal Wording Safety Agent check before allow

PR-M003: Recipient consent verification
  condition: recipient.communication_consent != 'granted'
  action: deny

PR-M004: No midnight messages
  condition: send_time.hour NOT IN [8..20] in recipient_timezone
  action: deny
```

---

## 6. Harness X Policy Integration

### Mandatory Harness Coverage by Risk Level

| Risk Level | Static | Dry-Run | Red-Team | Live |
|------------|--------|---------|----------|------|
| low | Required | Required | Optional | Required |
| medium | Required | Required | Recommended | Required |
| high | Required | Required | Required | Required |
| critical | Required | Required | Required | Required |

### What Each Harness Validates from a Policy Perspective

**Static Harness — Policy Checks:**
- All required policy_rules fields are present
- Policy rule conditions use valid syntax
- No policy rules that conflict with Vantro baseline rules
- Approval type is correct for risk level

**Dry-Run Harness — Policy Execution:**
- Policy rules fire correctly on test data
- Deny rules actually block execution in dry-run
- Approval requests are created correctly
- Audit events log the correct event types

**Red-Team Harness — Policy Adversarial:**
- Injection of disputed invoice data → verify PR-C001 fires
- Injection of after-hours trigger → verify PR-C002 fires
- Injection of cross-tenant data → verify PR-S001 fires
- Injection of PII in output path → verify PR-S002 fires
- Injection of threatening message content → verify PR-C006 fires

**Live Harness — Policy in Production:**
- End-to-end approval workflow with real data
- Real approval notification sent to test owner account
- Approval decision recorded in audit log
- Execution proceeds only after approval

---

## 7. Compliance Policy Rules

### 7.1 DPDP (Digital Personal Data Protection Act — India)

```
DPDP-001: Data collection consent
  All personal data processing must have documented consent
  Agents accessing customer personal data must verify consent exists

DPDP-002: Purpose limitation
  Personal data collected for collections may not be used for marketing
  Agent tool access is scoped to declared purpose

DPDP-003: Data minimization
  Agents receive only the data fields they declare in input_schema
  No agent receives full customer database dumps

DPDP-004: Right to erasure
  Data Deletion Agent is the only agent that can execute data erasure
  All erasure requests must be logged and confirmed within 72 hours

DPDP-005: Data portability
  Data Export Agent generates portable data files on request
  Format: JSON or CSV, within 30 days of request
```

### 7.2 Collections Ethics

```
CE-001: No harassment
  Collections agents must not generate content classified as harassment
  Definition: repeated contact after explicit refusal, threats, false urgency

CE-002: Accuracy in communications
  All financial figures cited in communications must be verified from database
  No agent may cite unverified amounts to customers

CE-003: Grievance acknowledgment
  If customer has an active grievance, it must be acknowledged before collection proceeds
  Grievance Handling Agent must be consulted first

CE-004: Tone boundaries
  Firm is acceptable. Threatening is not.
  Tone Strategy Agent has explicit tone classification with deny on 'threatening'

CE-005: Communication frequency
  Maximum 3 collection contacts per customer per 7 days
  Exceptions require owner approval (PR-C003)
```

### 7.3 Financial Accuracy

```
FA-001: No hallucinated numbers
  Any financial figure in agent output must be traceable to a source record
  AI-generated estimates must be labeled as estimates with confidence score

FA-002: Currency accuracy
  All monetary values must specify currency
  Multi-currency calculations must use verified FX rates

FA-003: Calculation verification
  High-stakes calculations (forecasts used for borrowing, credit decisions) must
  be verified by a second deterministic calculation path

FA-004: Forecast disclaimers
  All forecasts must include: confidence level, data freshness, key assumptions
```

### 7.4 Data Retention

| Data Type | Retention Period | Handling on Expiry |
|-----------|-----------------|-------------------|
| Agent execution logs | 2 years | Archive then delete |
| Audit logs | 7 years (financial standard) | Archive, never delete |
| Approval records | 7 years | Archive, never delete |
| Customer communication drafts | 1 year | Delete |
| Business memory | Until customer requests deletion | DPDP-004 applies |
| Harness test results | 1 year | Archive |

---

## 8. Cost Policy

### Per-Agent Cost Governance

Every agent has a cost budget defined in its registry entry:
- `max_tokens_per_run`: maximum tokens per single execution
- `max_cost_usd_per_run`: maximum cost per execution
- `monthly_budget_usd`: maximum monthly spend for this agent across all tenants

### Cost Circuit Breakers

```
COST-CB-001: Per-execution circuit breaker
  IF execution.estimated_cost > agent.max_cost_usd_per_run * 1.5
  THEN abort execution before LLM call
  RETURN: cost_limit_exceeded error to operator

COST-CB-002: Monthly budget alert
  AT 75% of agent.monthly_budget_usd: alert sent to admin in React Cost Dashboard
  AT 90% of agent.monthly_budget_usd: warning + owner notification

COST-CB-003: Monthly budget circuit breaker
  AT 100% of agent.monthly_budget_usd: agent suspended for remainder of month
  Admin can manually restore with budget override

COST-CB-004: Runaway cost detection
  IF agent.cost_24h > agent.monthly_budget_usd * 0.5
  THEN immediate suspension + admin alert
  (Prevents a bug from consuming entire monthly budget in one day)
```

### Cost Optimization Mandates

1. Always evaluate `no_llm` path first — if deterministic rules can answer, don't call LLM
2. Use `haiku_first` for all LOW risk agents
3. Cache LLM outputs where TTL is acceptable
4. Batch multiple similar requests into one LLM call where possible
5. Use prompt compression for agents with large context windows
6. Cost per outcome must be tracked and reported monthly

---

## 9. Risk Policy Enforcement Architecture

```
Agent Execution Request
    │
    ▼
Feature Flag Check
    │ (flag OFF) → Reject with FEATURE_DISABLED error
    │ (flag ON) ↓
    ▼
Input Validation (against input_schema)
    │ (invalid) → Reject with VALIDATION_ERROR
    │ (valid) ↓
    ▼
Policy Rule Evaluation (priority order)
    │ (deny) → Reject with POLICY_VIOLATION error + rule_id
    │ (require_approval) → Create approval request, suspend execution
    │ (flag_for_review) → Mark output, continue
    │ (add_disclaimer) → Queue disclaimer for output, continue
    │ (allow) ↓
    ▼
Risk Level Check
    │ (critical) → Wrap output as ProposalObject, create approval
    │ (high) → Show in React with "Review" required
    │ (medium/low) → Execute
    ▼
Harness X Check (if risk_level: high or critical)
    │ (fail) → Block, log failure, alert admin
    │ (pass) ↓
    ▼
Cost Check
    │ (over budget) → Abort, return cost error
    │ (within budget) ↓
    ▼
Execute Agent
    ▼
Audit Log
    ▼
Outcome Tracking
```

---

## 10. Policy Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-05-01 | Initial policy for 80-agent mesh |
| 2.0 | 2026-06-01 | Expanded to 216 agents; added DPDP rules; added cost circuit breakers; added dual-confirmation for irreversible actions; added 24-hour cooling period; strengthened communications gate |

---

*End of Atlas Agent Risk & Policy Framework v2*
*See agent-taxonomy-216.md for per-agent risk classifications*
*See agent-harness-map-216.md for harness coverage requirements*
