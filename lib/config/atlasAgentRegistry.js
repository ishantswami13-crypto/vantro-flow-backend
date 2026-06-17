// FILE: lib/config/atlasAgentRegistry.js
// ─────────────────────────────────────────────────────────────────────────────
// Atlas Agent Registry — static, honest, READ-ONLY "Agent Universe" truth (Phase 2C.28).
//
// PURPOSE
//   Agents are the actor layer that relates to the Atlas Pack Civilization Layer
//   (Phase 2C.26) and the Workflow business-process layer (Phase 2C.27). This
//   registry is a TRUTH MODEL describing what each agent IS, whether it is actually
//   implemented, whether it has committed proof, which packs/workflows it relates
//   to, and what it would require — never that it is live, runnable, activatable, or
//   that "hundreds of agents" are in production.
//
// HARD INVARIANTS (enforced by scripts/phase-2c-28-atlas-agent-registry-check.js):
//   - live_proven agents          = 0
//   - execution_allowed agents    = 0   (the registry NEVER executes an agent)
//   - activation_allowed agents   = 0   (activation needs live_proven; none exist)
//   - production_allowed agents   = 0   (no agent is production-enabled from here)
//   - external_send_allowed agents= 0   (no agent can send WhatsApp/email/etc.)
//   - `is_implemented` / `harness_verified` are INDEPENDENT factual fields. They NEVER
//     grant live_limited, execution, activation, or production readiness on their own.
//   - `live_limited` requires BOTH a concrete implementation artifact AND agent-specific
//     committed proof AND no production/external-send implication. Today only
//     `core.owner_briefing` qualifies — aligned with Phase 2C.21 Runtime Truth.
//   - swarms are ORGANIZATIONAL groupings, not agent-count claims; no hidden/multiplied
//     agents. Every row is one concrete, truthful agent contract.
//
// THIS FILE IS PURE STATIC DATA. NO secrets, DB URLs, env values, tokens, customer
// PII, emails, phones, invoice details, or raw row data — only ids, names, statuses,
// labels, counts, booleans, and references to committed in-repo artifact PATHS.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const AGENT_REGISTRY_VERSION = '2C.28';

// ── AGENT STATUS ENUM — the SHARED Atlas status model (packs/workflows/agents) ──
const AGENT_STATUS = Object.freeze({
  LIVE_PROVEN: 'live_proven',           // MUST stay count 0
  LIVE_LIMITED: 'live_limited',         // implemented + agent-specific STAGING proof; read-only, no live/GA claim
  PREVIEW: 'preview',
  CONNECTOR_REQUIRED: 'connector_required',
  CUSTOM_REQUIRED: 'custom_required',
  PARTNER_REQUIRED: 'partner_required',
  ROADMAP: 'roadmap',
  DISABLED: 'disabled',
});
const ALLOWED_AGENT_STATUSES = Object.freeze(Object.values(AGENT_STATUS));

// ── AGENT DOMAIN ENUM — the Agent Universe domains (15, per 2C.28 contract) ─────
const AGENT_DOMAIN = Object.freeze({
  COMMAND_INTELLIGENCE: 'command_intelligence',
  FINANCE: 'finance',
  COLLECTIONS: 'collections',
  SALES: 'sales',
  PURCHASE: 'purchase',
  INVENTORY: 'inventory',
  CUSTOMER: 'customer',
  SUPPLIER: 'supplier',
  GOVERNANCE: 'governance',
  EVIDENCE: 'evidence',
  APPROVALS: 'approvals',
  DATA_READINESS: 'data_readiness',
  WORKFLOW_ORCHESTRATION: 'workflow_orchestration',
  PACK_CONFIGURATION: 'pack_configuration',
  ENTERPRISE_CUSTOM_DEPLOYMENT: 'enterprise_custom_deployment',
});
const ALLOWED_AGENT_DOMAINS = Object.freeze(Object.values(AGENT_DOMAIN));

// ── AGENT CATEGORY ENUM — coarse functional grouping ───────────────────────────
const AGENT_CATEGORY = Object.freeze({
  INTELLIGENCE: 'intelligence',
  BUSINESS_REVIEW: 'business_review',
  GOVERNANCE: 'governance',
  EVIDENCE: 'evidence',
  ENABLEMENT: 'enablement',
  DEPLOYMENT: 'deployment',
});
const ALLOWED_AGENT_CATEGORIES = Object.freeze(Object.values(AGENT_CATEGORY));

// ── AGENT SWARM ENUM — ORGANIZATIONAL groupings only (NOT count claims) ─────────
// A swarm is a launch-truth grouping. It does NOT imply hidden agents, executable
// behavior, or a multiplied count. Every agent in a swarm is an explicit row below.
const AGENT_SWARM = Object.freeze({
  COMMAND_INTELLIGENCE: 'command_intelligence',
  FINANCE_OPERATIONS: 'finance_operations',
  REVENUE_COLLECTIONS: 'revenue_collections',
  SUPPLY_INVENTORY: 'supply_inventory',
  GOVERNANCE_SAFETY: 'governance_safety',
  EVIDENCE_AUDIT: 'evidence_audit',
  DATA_READINESS: 'data_readiness',
  ENTERPRISE_CUSTOM_DEPLOYMENT: 'enterprise_custom_deployment',
});
const ALLOWED_AGENT_SWARMS = Object.freeze(Object.values(AGENT_SWARM));

// ── PROOF LEVEL ENUM (conservative) ────────────────────────────────────────────
const PROOF_LEVEL = Object.freeze({
  NONE: 'none',
  DESIGN_CONTRACT: 'design_contract',
  STAGING_PROVEN: 'staging_proven',
  // STAGING_PROVEN is the HIGHEST proof tier used in Phase 2C.28. The production-canary
  // tier is deliberately NOT defined here: it remains BLOCKED (2C.23 PRODUCTION_CANARY_READY:
  // no, 2C.24 CANARY_READY: no, 2C.25 owner/scope records absent), so no agent may carry a
  // production-canary proof level. live_limited (core.owner_briefing) uses STAGING_PROVEN only.
});
const ALLOWED_PROOF_LEVELS = Object.freeze(Object.values(PROOF_LEVEL));

// ── SAFE CTA allowlist (agent layer) ───────────────────────────────────────────
const ALLOWED_SAFE_CTAS = Object.freeze([
  'Preview',
  'Request Activation',
  'Connect Data Source',
  'Configure Agent',
  'Requires Approval',
  'View Evidence',
  'View Requirements',
]);

// ── FORBIDDEN CTA — execution-implying labels that must NEVER appear ───────────
const FORBIDDEN_CTAS = Object.freeze([
  'Run Now',
  'Execute',
  'Launch Agent',
  'Start Automation',
  'Send',
  'Sync Production',
  'Deploy',
]);

// ── BLOCKED ACTIONS — what this registry refuses to do / claim ─────────────────
const BLOCKED_ACTIONS = Object.freeze([
  'agent_execution',
  'agent_activation',
  'production_enablement',
  'external_sending',
  'production_sync',
  'deploy',
  'db_write',
  'background_job_trigger',
  'production_db_connection',
  'ga_claim',
  'canary_ready_claim',
  'inflated_agent_count_claim',
  'public_production_liveness_claim',
]);

// ── AGENT BLOCKED REASON ENUM (documentation only) ─────────────────────────────
const AGENT_BLOCKED_REASON = Object.freeze({
  AGENT_EXECUTION_NOT_ENABLED: 'agent_execution_not_enabled',
  CONNECTOR_NOT_CONNECTED: 'connector_not_connected',
  CUSTOM_CONFIGURATION_REQUIRED: 'custom_configuration_required',
  PARTNER_DEPLOYMENT_REQUIRED: 'partner_deployment_required',
  ROADMAP_NOT_BUILT: 'roadmap_not_built',
  DISABLED_BY_DEFAULT: 'disabled_by_default',
});

const ALLOWED_RISK_LEVEL = Object.freeze(['low', 'medium', 'high']);

// The exact field set every agent entry must carry (26 fields, per Phase 2C.28).
const REQUIRED_AGENT_FIELDS = Object.freeze([
  'id', 'name', 'domain', 'category', 'swarm', 'status', 'proof_level',
  'is_implemented', 'implementation_evidence', 'harness_verified', 'proof_artifact_refs',
  'execution_allowed', 'activation_allowed', 'production_allowed', 'external_send_allowed',
  'related_packs', 'related_workflows', 'required_data_sources',
  'capabilities', 'limitations', 'approval_requirements', 'evidence_requirements',
  'audit_requirements', 'risk_level', 'safe_cta', 'blocked_reason',
]);

// ── shared requirement labels (generic categories only — never raw data/PII) ───
const AUDIT_BASELINE = ['audit_user_resolved', 'counts_booleans_only_no_pii', 'no_raw_row_data'];
const APPROVAL_OWNER_REVIEW = ['owner_review'];
const APPROVAL_CANARY = ['owner_approval_record', 'canary_scope_record']; // per Phase 2C.25

// defineAgent() HARD-FORCES the four safety booleans false and normalizes shape,
// regardless of input — an agent literally cannot be marked executable, activatable,
// production-enabled, or external-send-capable from this registry. `is_implemented`
// and `harness_verified` are passed through as INDEPENDENT facts (coerced to strict
// booleans); they are deliberately NOT allowed to flip any safety boolean.
function defineAgent(a) {
  return Object.freeze({
    id: a.id,
    name: a.name,
    domain: a.domain,
    category: a.category,
    swarm: a.swarm,
    status: a.status,
    proof_level: a.proof_level,
    // independent factual fields — never grant live/execution/activation/production
    is_implemented: a.is_implemented === true,
    implementation_evidence: typeof a.implementation_evidence === 'string' ? a.implementation_evidence : '',
    harness_verified: a.harness_verified === true,
    proof_artifact_refs: Object.freeze((a.proof_artifact_refs || []).slice()),
    // HARD INVARIANTS — always false from this registry
    execution_allowed: false,
    activation_allowed: false,
    production_allowed: false,
    external_send_allowed: false,
    related_packs: Object.freeze((a.related_packs || []).slice()),
    related_workflows: Object.freeze((a.related_workflows || []).slice()),
    required_data_sources: Object.freeze((a.required_data_sources || []).slice()),
    capabilities: Object.freeze((a.capabilities || []).slice()),
    limitations: Object.freeze((a.limitations || []).slice()),
    approval_requirements: Object.freeze((a.approval_requirements || []).slice()),
    evidence_requirements: Object.freeze((a.evidence_requirements || []).slice()),
    audit_requirements: Object.freeze((a.audit_requirements || []).slice()),
    risk_level: a.risk_level,
    safe_cta: a.safe_cta,
    blocked_reason: a.blocked_reason,
  });
}

const S = AGENT_STATUS;
const D = AGENT_DOMAIN;
const C = AGENT_CATEGORY;
const SW = AGENT_SWARM;
const P = PROOF_LEVEL;
const RB = AGENT_BLOCKED_REASON;

// ── THE AGENT REGISTRY ─────────────────────────────────────────────────────────
// Statuses below are evidence-derived (see docs/agent-mesh/phase-2c-28-...md §3).
// Only `core.owner_briefing` is live_limited. The three other implemented core
// agents are `preview` (staging-proven, production-OFF). Every other row is an
// honest not-yet-built contract (roadmap / connector / custom / partner) with
// is_implemented:false and no proof refs — code existence elsewhere does not promote.
const AGENTS = Object.freeze([
  // 1 — Owner Briefing (the ONLY live_limited agent; staging-proven, read-only — NO production canary)
  defineAgent({
    id: 'core.owner_briefing',
    name: 'Owner Briefing Agent',
    domain: D.COMMAND_INTELLIGENCE,
    category: C.INTELLIGENCE,
    swarm: SW.COMMAND_INTELLIGENCE,
    status: S.LIVE_LIMITED,
    proof_level: P.STAGING_PROVEN,
    is_implemented: true,
    implementation_evidence: 'vantro-automation-rs/src/agents/owner_briefing/core_owner_briefing.rs',
    harness_verified: true,
    proof_artifact_refs: [
      'scripts/phase-2c-19-owner-briefing-evidence-gate.js',
      'cortex-lab/scenarios/owner-briefing',
    ],
    related_packs: ['workflow_owner_briefing', 'global_core', 'role_owner'],
    related_workflows: ['workflow_owner_briefing_preview', 'workflow_daily_command_briefing'],
    required_data_sources: ['invoices', 'customers', 'payments'],
    capabilities: ['read_only_owner_briefing_preview', 'counts_and_status_labels'],
    limitations: ['no_execution', 'no_external_send', 'read_only_preview', 'staging_safe', 'tenant_isolated', 'evidence_gated', 'no_canary', 'no_ga_or_production_readiness'],
    approval_requirements: APPROVAL_OWNER_REVIEW,
    evidence_requirements: ['rag_evidence_contract', 'staging_proof'],
    audit_requirements: AUDIT_BASELINE,
    risk_level: 'low',
    safe_cta: 'Preview',
    blocked_reason: RB.AGENT_EXECUTION_NOT_ENABLED,
  }),
  // 2 — Data Quality (implemented + staging-proven; production-OFF → preview)
  defineAgent({
    id: 'core.data_quality',
    name: 'Data Quality Agent',
    domain: D.DATA_READINESS,
    category: C.ENABLEMENT,
    swarm: SW.DATA_READINESS,
    status: S.PREVIEW,
    proof_level: P.STAGING_PROVEN,
    is_implemented: true,
    implementation_evidence: 'vantro-automation-rs/src/agents/data_quality/mod.rs',
    harness_verified: true,
    proof_artifact_refs: [
      'docs/agent-mesh/phase-2a-data-quality-staging-proof.md',
      'cortex-lab/scenarios/data-quality',
    ],
    related_packs: ['industry_wholesale_distribution', 'region_india'],
    related_workflows: ['workflow_data_source_readiness'],
    required_data_sources: ['connection_metadata'],
    capabilities: ['read_only_data_quality_scan_preview', 'counts_and_gap_labels'],
    limitations: ['no_execution', 'no_external_send', 'staging_only_not_production'],
    approval_requirements: APPROVAL_OWNER_REVIEW,
    evidence_requirements: ['staging_proof'],
    audit_requirements: AUDIT_BASELINE,
    risk_level: 'low',
    safe_cta: 'Preview',
    blocked_reason: RB.AGENT_EXECUTION_NOT_ENABLED,
  }),
  // 3 — Policy Guard (implemented + staging-proven + committed Rust test; preview)
  defineAgent({
    id: 'core.policy_guard',
    name: 'Policy Guard Agent',
    domain: D.GOVERNANCE,
    category: C.GOVERNANCE,
    swarm: SW.GOVERNANCE_SAFETY,
    status: S.PREVIEW,
    proof_level: P.STAGING_PROVEN,
    is_implemented: true,
    implementation_evidence: 'vantro-automation-rs/src/agents/policy_guard/mod.rs',
    harness_verified: true,
    proof_artifact_refs: [
      'docs/agent-mesh/phase-2b-policy-guard-staging-proof.md',
      'vantro-automation-rs/tests/policy_guard_fir_regression.rs',
      'cortex-lab/scenarios/policy-guard',
    ],
    related_packs: ['global_core'],
    related_workflows: ['workflow_actions_approval_review', 'workflow_customer_risk_review'],
    required_data_sources: ['ai_actions'],
    capabilities: ['read_only_policy_evaluation_preview', 'fail_closed_decision_label'],
    limitations: ['no_execution', 'no_external_send', 'staging_only_not_production'],
    approval_requirements: APPROVAL_OWNER_REVIEW,
    evidence_requirements: ['staging_proof'],
    audit_requirements: AUDIT_BASELINE,
    risk_level: 'medium',
    safe_cta: 'View Evidence',
    blocked_reason: RB.AGENT_EXECUTION_NOT_ENABLED,
  }),
  // 4 — Cost Router (implemented + staging-proven; default-OFF → preview)
  defineAgent({
    id: 'core.cost_router',
    name: 'Cost Router Agent',
    domain: D.COMMAND_INTELLIGENCE,
    category: C.INTELLIGENCE,
    swarm: SW.COMMAND_INTELLIGENCE,
    status: S.PREVIEW,
    proof_level: P.STAGING_PROVEN,
    is_implemented: true,
    implementation_evidence: 'vantro-automation-rs/src/agents/cost_router/mod.rs',
    harness_verified: true,
    proof_artifact_refs: [
      'docs/agent-mesh/phase-2c-cost-router-staging-proof.md',
      'cortex-lab/scenarios/cost-router',
    ],
    related_packs: ['global_core'],
    related_workflows: ['workflow_agent_swarm_planning'],
    required_data_sources: ['orchestration_metadata'],
    capabilities: ['read_only_routing_decision_preview', 'conservative_fallback_label'],
    limitations: ['no_execution', 'no_external_send', 'default_off_not_production'],
    approval_requirements: APPROVAL_OWNER_REVIEW,
    evidence_requirements: ['staging_proof'],
    audit_requirements: AUDIT_BASELINE,
    risk_level: 'low',
    safe_cta: 'Preview',
    blocked_reason: RB.AGENT_EXECUTION_NOT_ENABLED,
  }),
  // 5 — Cashflow Risk (NOT implemented under this contract id → roadmap)
  defineAgent({
    id: 'finance.cashflow_risk',
    name: 'Cashflow Risk Agent',
    domain: D.FINANCE,
    category: C.BUSINESS_REVIEW,
    swarm: SW.FINANCE_OPERATIONS,
    status: S.ROADMAP,
    proof_level: P.DESIGN_CONTRACT,
    is_implemented: false,
    implementation_evidence: '',
    harness_verified: false,
    proof_artifact_refs: [],
    related_packs: ['global_core', 'role_finance'],
    related_workflows: ['workflow_cashflow_risk_review'],
    required_data_sources: ['invoices', 'payments', 'cashflow_events'],
    capabilities: ['planned_read_only_cashflow_risk_preview'],
    limitations: ['not_implemented_as_proven_agent', 'legacy_cashflow_scorer_not_wired_as_agent'],
    approval_requirements: APPROVAL_OWNER_REVIEW,
    evidence_requirements: [],
    audit_requirements: AUDIT_BASELINE,
    risk_level: 'medium',
    safe_cta: 'View Requirements',
    blocked_reason: RB.ROADMAP_NOT_BUILT,
  }),
  // 6 — Collections Priority Review (NOT implemented under this id → roadmap)
  defineAgent({
    id: 'collections.priority_review',
    name: 'Collections Priority Agent',
    domain: D.COLLECTIONS,
    category: C.BUSINESS_REVIEW,
    swarm: SW.REVENUE_COLLECTIONS,
    status: S.ROADMAP,
    proof_level: P.DESIGN_CONTRACT,
    is_implemented: false,
    implementation_evidence: '',
    harness_verified: false,
    proof_artifact_refs: [],
    related_packs: ['workflow_collections', 'role_finance'],
    related_workflows: ['workflow_collections_review'],
    required_data_sources: ['invoices', 'customers', 'payments', 'overdue_status'],
    capabilities: ['planned_read_only_priority_ranking_preview'],
    limitations: ['not_implemented_as_proven_agent', 'legacy_collections_scorer_not_wired_as_agent'],
    approval_requirements: APPROVAL_OWNER_REVIEW,
    evidence_requirements: [],
    audit_requirements: AUDIT_BASELINE,
    risk_level: 'medium',
    safe_cta: 'View Requirements',
    blocked_reason: RB.ROADMAP_NOT_BUILT,
  }),
  // 7 — Inventory Pressure Review (needs connected source → connector_required)
  defineAgent({
    id: 'inventory.pressure_review',
    name: 'Inventory Pressure Agent',
    domain: D.INVENTORY,
    category: C.BUSINESS_REVIEW,
    swarm: SW.SUPPLY_INVENTORY,
    status: S.CONNECTOR_REQUIRED,
    proof_level: P.DESIGN_CONTRACT,
    is_implemented: false,
    implementation_evidence: '',
    harness_verified: false,
    proof_artifact_refs: [],
    related_packs: ['agent_swarm_inventory_ops'],
    related_workflows: ['workflow_inventory_pressure_review'],
    required_data_sources: ['inventory', 'invoices'],
    capabilities: ['planned_read_only_stock_pressure_preview'],
    limitations: ['not_implemented_as_proven_agent', 'requires_connected_inventory_source'],
    approval_requirements: APPROVAL_OWNER_REVIEW,
    evidence_requirements: [],
    audit_requirements: AUDIT_BASELINE,
    risk_level: 'low',
    safe_cta: 'Connect Data Source',
    blocked_reason: RB.CONNECTOR_NOT_CONNECTED,
  }),
  // 8 — Sales Pipeline Review (needs connected source → connector_required)
  defineAgent({
    id: 'sales.pipeline_review',
    name: 'Sales Pipeline Agent',
    domain: D.SALES,
    category: C.BUSINESS_REVIEW,
    swarm: SW.REVENUE_COLLECTIONS,
    status: S.CONNECTOR_REQUIRED,
    proof_level: P.DESIGN_CONTRACT,
    is_implemented: false,
    implementation_evidence: '',
    harness_verified: false,
    proof_artifact_refs: [],
    related_packs: ['business_type_distributor'],
    related_workflows: ['workflow_sales_pipeline_review'],
    required_data_sources: ['sales_orders', 'customers'],
    capabilities: ['planned_read_only_pipeline_preview'],
    limitations: ['not_implemented_as_proven_agent', 'requires_connected_sales_source'],
    approval_requirements: APPROVAL_OWNER_REVIEW,
    evidence_requirements: [],
    audit_requirements: AUDIT_BASELINE,
    risk_level: 'low',
    safe_cta: 'Connect Data Source',
    blocked_reason: RB.CONNECTOR_NOT_CONNECTED,
  }),
  // 9 — Purchase & Supplier Review (needs connected source → connector_required)
  defineAgent({
    id: 'purchase.supplier_review',
    name: 'Purchase & Supplier Agent',
    domain: D.PURCHASE,
    category: C.BUSINESS_REVIEW,
    swarm: SW.SUPPLY_INVENTORY,
    status: S.CONNECTOR_REQUIRED,
    proof_level: P.DESIGN_CONTRACT,
    is_implemented: false,
    implementation_evidence: '',
    harness_verified: false,
    proof_artifact_refs: [],
    related_packs: ['business_type_distributor'],
    related_workflows: ['workflow_purchase_supplier_review'],
    required_data_sources: ['purchase_orders', 'suppliers', 'payments'],
    capabilities: ['planned_read_only_payables_preview'],
    limitations: ['not_implemented_as_proven_agent', 'requires_connected_purchase_source'],
    approval_requirements: APPROVAL_OWNER_REVIEW,
    evidence_requirements: [],
    audit_requirements: AUDIT_BASELINE,
    risk_level: 'low',
    safe_cta: 'Connect Data Source',
    blocked_reason: RB.CONNECTOR_NOT_CONNECTED,
  }),
  // 10 — Customer Risk Review (NOT implemented under this id → roadmap)
  defineAgent({
    id: 'customer.risk_review',
    name: 'Customer Risk Agent',
    domain: D.CUSTOMER,
    category: C.BUSINESS_REVIEW,
    swarm: SW.FINANCE_OPERATIONS,
    status: S.ROADMAP,
    proof_level: P.DESIGN_CONTRACT,
    is_implemented: false,
    implementation_evidence: '',
    harness_verified: false,
    proof_artifact_refs: [],
    related_packs: ['role_finance'],
    related_workflows: ['workflow_customer_risk_review'],
    required_data_sources: ['invoices', 'customers', 'payments'],
    capabilities: ['planned_read_only_risk_score_preview'],
    limitations: ['not_implemented_as_proven_agent', 'legacy_credit_risk_scorer_not_wired_as_agent'],
    approval_requirements: APPROVAL_OWNER_REVIEW,
    evidence_requirements: [],
    audit_requirements: AUDIT_BASELINE,
    risk_level: 'medium',
    safe_cta: 'View Requirements',
    blocked_reason: RB.ROADMAP_NOT_BUILT,
  }),
  // 11 — Approval Review (NOT implemented as standalone agent → roadmap)
  defineAgent({
    id: 'governance.approval_review',
    name: 'Approval Review Agent',
    domain: D.APPROVALS,
    category: C.GOVERNANCE,
    swarm: SW.GOVERNANCE_SAFETY,
    status: S.ROADMAP,
    proof_level: P.DESIGN_CONTRACT,
    is_implemented: false,
    implementation_evidence: '',
    harness_verified: false,
    proof_artifact_refs: [],
    related_packs: ['global_core'],
    related_workflows: ['workflow_actions_approval_review'],
    required_data_sources: ['ai_actions'],
    capabilities: ['planned_read_only_pending_actions_preview'],
    limitations: ['not_implemented_as_proven_agent', 'no_action_execution'],
    approval_requirements: APPROVAL_OWNER_REVIEW,
    evidence_requirements: [],
    audit_requirements: AUDIT_BASELINE,
    risk_level: 'medium',
    safe_cta: 'Requires Approval',
    blocked_reason: RB.ROADMAP_NOT_BUILT,
  }),
  // 12 — Evidence Review (logic lives inside owner_briefing RAG; standalone → roadmap)
  defineAgent({
    id: 'evidence.evidence_review',
    name: 'Evidence Review Agent',
    domain: D.EVIDENCE,
    category: C.EVIDENCE,
    swarm: SW.EVIDENCE_AUDIT,
    status: S.ROADMAP,
    proof_level: P.DESIGN_CONTRACT,
    is_implemented: false,
    implementation_evidence: '',
    harness_verified: false,
    proof_artifact_refs: [],
    related_packs: ['global_core'],
    related_workflows: ['workflow_evidence_review'],
    required_data_sources: ['evidence_records'],
    capabilities: ['planned_read_only_evidence_preview'],
    limitations: ['not_implemented_as_standalone_agent', 'evidence_contract_currently_internal_to_owner_briefing'],
    approval_requirements: APPROVAL_OWNER_REVIEW,
    evidence_requirements: [],
    audit_requirements: AUDIT_BASELINE,
    risk_level: 'low',
    safe_cta: 'View Evidence',
    blocked_reason: RB.ROADMAP_NOT_BUILT,
  }),
  // 13 — Data Source Readiness (needs connected source → connector_required)
  defineAgent({
    id: 'data.source_readiness',
    name: 'Data Source Readiness Agent',
    domain: D.DATA_READINESS,
    category: C.ENABLEMENT,
    swarm: SW.DATA_READINESS,
    status: S.CONNECTOR_REQUIRED,
    proof_level: P.DESIGN_CONTRACT,
    is_implemented: false,
    implementation_evidence: '',
    harness_verified: false,
    proof_artifact_refs: [],
    related_packs: ['industry_wholesale_distribution', 'region_india'],
    related_workflows: ['workflow_data_source_readiness'],
    required_data_sources: ['connection_metadata'],
    capabilities: ['planned_read_only_readiness_assessment_preview'],
    limitations: ['not_implemented_as_proven_agent', 'requires_connected_data_source'],
    approval_requirements: APPROVAL_OWNER_REVIEW,
    evidence_requirements: [],
    audit_requirements: AUDIT_BASELINE,
    risk_level: 'low',
    safe_cta: 'Connect Data Source',
    blocked_reason: RB.CONNECTOR_NOT_CONNECTED,
  }),
  // 14 — Workflow Planner / orchestration (planned/hidden concept → roadmap)
  defineAgent({
    id: 'orchestrator.workflow_planner',
    name: 'Workflow Planner Agent',
    domain: D.WORKFLOW_ORCHESTRATION,
    category: C.INTELLIGENCE,
    swarm: SW.COMMAND_INTELLIGENCE,
    status: S.ROADMAP,
    proof_level: P.NONE,
    is_implemented: false,
    implementation_evidence: '',
    harness_verified: false,
    proof_artifact_refs: [],
    related_packs: ['agent_swarm_finance_ops', 'agent_swarm_inventory_ops'],
    related_workflows: ['workflow_agent_swarm_planning'],
    required_data_sources: ['orchestration_metadata'],
    capabilities: ['planned_read_only_plan_preview'],
    limitations: ['not_implemented', 'no_orchestration_execution'],
    approval_requirements: APPROVAL_CANARY,
    evidence_requirements: [],
    audit_requirements: AUDIT_BASELINE,
    risk_level: 'high',
    safe_cta: 'View Requirements',
    blocked_reason: RB.ROADMAP_NOT_BUILT,
  }),
  // 15 — Pack Recommendation (pack registry exists; recommendation agent → roadmap)
  defineAgent({
    id: 'packs.pack_recommendation',
    name: 'Pack Recommendation Agent',
    domain: D.PACK_CONFIGURATION,
    category: C.ENABLEMENT,
    swarm: SW.ENTERPRISE_CUSTOM_DEPLOYMENT,
    status: S.ROADMAP,
    proof_level: P.DESIGN_CONTRACT,
    is_implemented: false,
    implementation_evidence: '',
    harness_verified: false,
    proof_artifact_refs: [],
    related_packs: ['trader_pack', 'enterprise_pack', 'custom_pack'],
    related_workflows: ['workflow_pack_activation_request'],
    required_data_sources: ['pack_registry_metadata'],
    capabilities: ['planned_read_only_pack_recommendation_preview'],
    limitations: ['not_implemented_as_proven_agent', 'pack_registry_is_read_only_no_activation'],
    approval_requirements: APPROVAL_OWNER_REVIEW,
    evidence_requirements: [],
    audit_requirements: AUDIT_BASELINE,
    risk_level: 'low',
    safe_cta: 'View Requirements',
    blocked_reason: RB.ROADMAP_NOT_BUILT,
  }),
  // 16 — Enterprise Governance Review (requires configuration → custom_required)
  defineAgent({
    id: 'enterprise.governance_review',
    name: 'Enterprise Governance Agent',
    domain: D.ENTERPRISE_CUSTOM_DEPLOYMENT,
    category: C.GOVERNANCE,
    swarm: SW.ENTERPRISE_CUSTOM_DEPLOYMENT,
    status: S.CUSTOM_REQUIRED,
    proof_level: P.DESIGN_CONTRACT,
    is_implemented: false,
    implementation_evidence: '',
    harness_verified: false,
    proof_artifact_refs: [],
    related_packs: ['enterprise_pack', 'business_size_enterprise'],
    related_workflows: ['workflow_enterprise_governance_review'],
    required_data_sources: ['policy_records'],
    capabilities: ['planned_read_only_governance_preview'],
    limitations: ['not_implemented_as_proven_agent', 'requires_enterprise_configuration'],
    approval_requirements: APPROVAL_CANARY,
    evidence_requirements: [],
    audit_requirements: AUDIT_BASELINE,
    risk_level: 'medium',
    safe_cta: 'Requires Approval',
    blocked_reason: RB.CUSTOM_CONFIGURATION_REQUIRED,
  }),
  // 17 — Custom Operating-Model Designer (requires configuration → custom_required)
  defineAgent({
    id: 'custom.operating_model_designer',
    name: 'Custom Operating Model Designer Agent',
    domain: D.ENTERPRISE_CUSTOM_DEPLOYMENT,
    category: C.ENABLEMENT,
    swarm: SW.ENTERPRISE_CUSTOM_DEPLOYMENT,
    status: S.CUSTOM_REQUIRED,
    proof_level: P.DESIGN_CONTRACT,
    is_implemented: false,
    implementation_evidence: '',
    harness_verified: false,
    proof_artifact_refs: [],
    related_packs: ['custom_pack'],
    related_workflows: ['workflow_custom_pack_design'],
    required_data_sources: ['design_inputs'],
    capabilities: ['planned_read_only_design_preview'],
    limitations: ['not_implemented_as_proven_agent', 'requires_custom_configuration'],
    approval_requirements: APPROVAL_OWNER_REVIEW,
    evidence_requirements: [],
    audit_requirements: AUDIT_BASELINE,
    risk_level: 'medium',
    safe_cta: 'Configure Agent',
    blocked_reason: RB.CUSTOM_CONFIGURATION_REQUIRED,
  }),
  // 18 — Partner Deployment Planner (requires partner contract → partner_required)
  defineAgent({
    id: 'partner.deployment_planner',
    name: 'Partner Deployment Planner Agent',
    domain: D.ENTERPRISE_CUSTOM_DEPLOYMENT,
    category: C.DEPLOYMENT,
    swarm: SW.ENTERPRISE_CUSTOM_DEPLOYMENT,
    status: S.PARTNER_REQUIRED,
    proof_level: P.DESIGN_CONTRACT,
    is_implemented: false,
    implementation_evidence: '',
    harness_verified: false,
    proof_artifact_refs: [],
    related_packs: ['partner_custom_deployment'],
    related_workflows: ['workflow_partner_deployment_review'],
    required_data_sources: ['deployment_metadata'],
    capabilities: ['planned_read_only_deployment_review_preview'],
    limitations: ['not_implemented_as_proven_agent', 'requires_partner_approval_and_contract'],
    approval_requirements: APPROVAL_CANARY,
    evidence_requirements: [],
    audit_requirements: AUDIT_BASELINE,
    risk_level: 'high',
    safe_cta: 'Requires Approval',
    blocked_reason: RB.PARTNER_DEPLOYMENT_REQUIRED,
  }),
]);

module.exports = {
  AGENT_REGISTRY_VERSION,
  AGENT_STATUS,
  ALLOWED_AGENT_STATUSES,
  AGENT_DOMAIN,
  ALLOWED_AGENT_DOMAINS,
  AGENT_CATEGORY,
  ALLOWED_AGENT_CATEGORIES,
  AGENT_SWARM,
  ALLOWED_AGENT_SWARMS,
  PROOF_LEVEL,
  ALLOWED_PROOF_LEVELS,
  ALLOWED_SAFE_CTAS,
  FORBIDDEN_CTAS,
  AGENT_BLOCKED_REASON,
  ALLOWED_RISK_LEVEL,
  REQUIRED_AGENT_FIELDS,
  BLOCKED_ACTIONS,
  AGENTS,
};
