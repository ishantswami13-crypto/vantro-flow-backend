// FILE: lib/config/atlasWorkflowRegistry.js
// ─────────────────────────────────────────────────────────────────────────────
// Atlas Workflow Registry — static, honest, READ-ONLY backend truth (Phase 2C.27).
//
// PURPOSE
//   Workflows are the business-PROCESS layer that sits UNDER the Atlas Pack
//   Civilization Layer (Phase 2C.26). This registry is a TRUTH MODEL describing
//   what each workflow IS, which packs/agents it relates to, what it would require,
//   and what it would return — never that it is live, runnable, or activatable.
//
// HARD INVARIANTS (enforced by scripts/phase-2c-27-atlas-workflow-registry-check.js):
//   - live_proven workflows        = 0
//   - execution_allowed workflows  = 0   (the registry NEVER executes a workflow)
//   - activation_allowed workflows = 0   (activation needs live_proven; none exist)
//   - every workflow's output_contract has side_effects:'none', mutations:false,
//     external_sends:false, production_sync:false — no execution, no sends, no sync,
//     no DB write, no background job.
//   - preview / connector / custom / partner / roadmap / disabled workflows are all
//     non-executable; their only call-to-action is a SAFE, read-only CTA.
//
// THIS FILE IS PURE STATIC DATA. NO secrets, DB URLs, env values, tokens, customer
// PII, emails, phones, invoice details, or raw row data — only ids, names, statuses,
// labels, counts, and booleans.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const WORKFLOW_REGISTRY_VERSION = '2C.27';

// ── WORKFLOW STATUS ENUM — the ONLY allowed status values ──────────────────────
const WORKFLOW_STATUS = Object.freeze({
  LIVE_PROVEN: 'live_proven',           // MUST stay count 0
  LIVE_LIMITED: 'live_limited',         // honestly-mapped read-only canary preview
  PREVIEW: 'preview',
  CONNECTOR_REQUIRED: 'connector_required',
  CUSTOM_REQUIRED: 'custom_required',
  PARTNER_REQUIRED: 'partner_required',
  ROADMAP: 'roadmap',
  DISABLED: 'disabled',
});
const ALLOWED_WORKFLOW_STATUSES = Object.freeze(Object.values(WORKFLOW_STATUS));

// ── WORKFLOW DOMAIN ENUM — business-process area ───────────────────────────────
const WORKFLOW_DOMAIN = Object.freeze({
  OWNER_BRIEFING: 'owner_briefing',
  COLLECTIONS: 'collections',
  CASHFLOW: 'cashflow',
  INVENTORY: 'inventory',
  SALES: 'sales',
  PURCHASE: 'purchase',
  CREDIT_RISK: 'credit_risk',
  GOVERNANCE: 'governance',
  EVIDENCE: 'evidence',
  DATA_OPS: 'data_ops',
  DESIGN: 'design',
  ORCHESTRATION: 'orchestration',
  PARTNER: 'partner',
});
const ALLOWED_WORKFLOW_DOMAINS = Object.freeze(Object.values(WORKFLOW_DOMAIN));

// ── WORKFLOW CATEGORY ENUM — coarse grouping ───────────────────────────────────
const WORKFLOW_CATEGORY = Object.freeze({
  BUSINESS_REVIEW: 'business_review',
  GOVERNANCE: 'governance',
  ENABLEMENT: 'enablement',
  INFRASTRUCTURE: 'infrastructure',
  DEPLOYMENT: 'deployment',
});
const ALLOWED_WORKFLOW_CATEGORIES = Object.freeze(Object.values(WORKFLOW_CATEGORY));

// ── PROOF LEVEL ENUM (conservative) ────────────────────────────────────────────
const PROOF_LEVEL = Object.freeze({
  NONE: 'none',
  DESIGN_CONTRACT: 'design_contract',
  STAGING_PROVEN: 'staging_proven',
  PRODUCTION_CANARY: 'production_canary',
});
const ALLOWED_PROOF_LEVELS = Object.freeze(Object.values(PROOF_LEVEL));

// ── SAFE CTA allowlist (workflow layer) ────────────────────────────────────────
const ALLOWED_SAFE_CTAS = Object.freeze([
  'Preview',
  'Request Activation',
  'Connect Data Source',
  'Configure Custom Workflow',
  'Requires Approval',
  'View Evidence',
  'View Requirements',
]);

// ── FORBIDDEN CTA — execution-implying labels that must NEVER appear ───────────
const FORBIDDEN_CTAS = Object.freeze([
  'Run Now',
  'Execute',
  'Launch Workflow',
  'Start Automation',
  'Send',
  'Sync Production',
  'Deploy',
]);

// ── BLOCKED ACTIONS — what this registry refuses to do / claim ─────────────────
const BLOCKED_ACTIONS = Object.freeze([
  'workflow_execution',
  'workflow_activation',
  'production_sync',
  'external_sending',
  'deploy',
  'db_write',
  'background_job_trigger',
  'production_db_connection',
  'ga_claim',
  'canary_ready_claim',
  'public_production_live_claim',
]);

// ── WORKFLOW BLOCKED REASON ENUM (documentation only) ──────────────────────────
const WORKFLOW_BLOCKED_REASON = Object.freeze({
  WORKFLOW_EXECUTION_NOT_ENABLED: 'workflow_execution_not_enabled',
  CONNECTOR_NOT_CONNECTED: 'connector_not_connected',
  CUSTOM_CONFIGURATION_REQUIRED: 'custom_configuration_required',
  PARTNER_DEPLOYMENT_REQUIRED: 'partner_deployment_required',
  ROADMAP_NOT_BUILT: 'roadmap_not_built',
  DISABLED_BY_DEFAULT: 'disabled_by_default',
});

// ── descriptive value enums ────────────────────────────────────────────────────
const ALLOWED_SETUP_COMPLEXITY = Object.freeze(['low', 'medium', 'high']);
const ALLOWED_AUTOMATION_DEPTH = Object.freeze([
  'read_only_preview', 'assisted_planned', 'supervised_planned', 'orchestrated_planned',
]);
const ALLOWED_RISK_LEVEL = Object.freeze(['low', 'medium', 'high']);

// The exact field set every workflow entry must carry.
const REQUIRED_WORKFLOW_FIELDS = Object.freeze([
  'id', 'name', 'domain', 'category', 'status', 'proof_level',
  'execution_allowed', 'activation_allowed', 'target_business_outcome',
  'related_packs', 'required_agents', 'required_data_sources',
  'input_requirements', 'output_contract', 'approval_requirements',
  'evidence_requirements', 'audit_requirements', 'risk_level',
  'setup_complexity', 'automation_depth', 'safe_cta', 'blocked_reason',
]);

// ── shared requirement labels (generic categories only — never raw data/PII) ───
const AUDIT_BASELINE = ['audit_user_resolved', 'counts_booleans_only_no_pii', 'no_raw_row_data'];
const EVIDENCE_BASELINE = ['harness_x_static_proof', 'staging_proof'];
const EVIDENCE_RAG = ['harness_x_static_proof', 'rag_evidence_contract', 'staging_proof'];
const APPROVAL_CANARY = ['owner_approval_record', 'canary_scope_record']; // per Phase 2C.25
const APPROVAL_OWNER_REVIEW = ['owner_review'];
const INPUT_AUTH = ['authenticated_owner', 'business_context'];

// defineWorkflow() FORCES execution/activation false and normalizes output_contract
// to a non-executable read-only shape, regardless of input — a workflow literally
// cannot be marked executable/activatable or claim side effects from this registry.
function defineWorkflow(w) {
  const oc = w.output_contract || {};
  return Object.freeze({
    id: w.id,
    name: w.name,
    domain: w.domain,
    category: w.category,
    status: w.status,
    proof_level: w.proof_level,
    execution_allowed: false,   // HARD INVARIANT
    activation_allowed: false,  // HARD INVARIANT
    target_business_outcome: w.target_business_outcome,
    related_packs: Object.freeze((w.related_packs || []).slice()),
    required_agents: Object.freeze((w.required_agents || []).slice()),
    required_data_sources: Object.freeze((w.required_data_sources || []).slice()),
    input_requirements: Object.freeze((w.input_requirements || []).slice()),
    output_contract: Object.freeze({
      kind: oc.kind || 'read_only_preview',
      returns: Object.freeze((oc.returns || []).slice()),
      side_effects: 'none',     // HARD INVARIANT
      mutations: false,         // HARD INVARIANT
      external_sends: false,    // HARD INVARIANT
      production_sync: false,   // HARD INVARIANT
    }),
    approval_requirements: Object.freeze((w.approval_requirements || []).slice()),
    evidence_requirements: Object.freeze((w.evidence_requirements || []).slice()),
    audit_requirements: Object.freeze((w.audit_requirements || []).slice()),
    risk_level: w.risk_level,
    setup_complexity: w.setup_complexity,
    automation_depth: w.automation_depth,
    safe_cta: w.safe_cta,
    blocked_reason: w.blocked_reason,
  });
}

const RB = WORKFLOW_BLOCKED_REASON;

// ── THE WORKFLOW REGISTRY ──────────────────────────────────────────────────────
const WORKFLOWS = Object.freeze([
  // 1 — Owner Briefing Preview (honestly maps to the existing canary preview)
  defineWorkflow({
    id: 'workflow_owner_briefing_preview',
    name: 'Owner Briefing Preview',
    domain: WORKFLOW_DOMAIN.OWNER_BRIEFING,
    category: WORKFLOW_CATEGORY.BUSINESS_REVIEW,
    status: WORKFLOW_STATUS.LIVE_LIMITED,
    proof_level: PROOF_LEVEL.PRODUCTION_CANARY,
    target_business_outcome: 'Read-only owner briefing preview (production canary; not GA; not executable from this registry).',
    related_packs: ['workflow_owner_briefing', 'global_core', 'role_owner'],
    required_agents: ['core.owner_briefing'],
    required_data_sources: ['invoices', 'customers', 'payments'],
    input_requirements: INPUT_AUTH,
    output_contract: { kind: 'read_only_preview', returns: ['counts', 'status_labels', 'briefing_preview'] },
    approval_requirements: APPROVAL_OWNER_REVIEW,
    evidence_requirements: EVIDENCE_RAG,
    audit_requirements: AUDIT_BASELINE,
    risk_level: 'low',
    setup_complexity: 'low',
    automation_depth: 'read_only_preview',
    safe_cta: 'Preview',
    blocked_reason: RB.WORKFLOW_EXECUTION_NOT_ENABLED,
  }),
  // 2 — Daily Command Briefing
  defineWorkflow({
    id: 'workflow_daily_command_briefing',
    name: 'Daily Command Briefing',
    domain: WORKFLOW_DOMAIN.OWNER_BRIEFING,
    category: WORKFLOW_CATEGORY.BUSINESS_REVIEW,
    status: WORKFLOW_STATUS.PREVIEW,
    proof_level: PROOF_LEVEL.STAGING_PROVEN,
    target_business_outcome: 'A daily read-only command view of what to act on today — preview only.',
    related_packs: ['global_core', 'role_owner'],
    required_agents: ['core.owner_briefing'],
    required_data_sources: ['invoices', 'customers', 'payments'],
    input_requirements: INPUT_AUTH,
    output_contract: { kind: 'read_only_preview', returns: ['counts', 'priorities_preview'] },
    approval_requirements: APPROVAL_OWNER_REVIEW,
    evidence_requirements: EVIDENCE_BASELINE,
    audit_requirements: AUDIT_BASELINE,
    risk_level: 'low',
    setup_complexity: 'low',
    automation_depth: 'read_only_preview',
    safe_cta: 'Preview',
    blocked_reason: RB.WORKFLOW_EXECUTION_NOT_ENABLED,
  }),
  // 3 — Collections Review
  defineWorkflow({
    id: 'workflow_collections_review',
    name: 'Collections Review',
    domain: WORKFLOW_DOMAIN.COLLECTIONS,
    category: WORKFLOW_CATEGORY.BUSINESS_REVIEW,
    status: WORKFLOW_STATUS.PREVIEW,
    proof_level: PROOF_LEVEL.STAGING_PROVEN,
    target_business_outcome: 'Read-only prioritization of who to follow up with first — no messages sent.',
    related_packs: ['workflow_collections', 'role_finance'],
    required_agents: [],
    required_data_sources: ['invoices', 'customers', 'payments', 'overdue_status'],
    input_requirements: INPUT_AUTH,
    output_contract: { kind: 'read_only_preview', returns: ['priority_ranking_preview', 'counts'] },
    approval_requirements: APPROVAL_OWNER_REVIEW,
    evidence_requirements: EVIDENCE_BASELINE,
    audit_requirements: AUDIT_BASELINE,
    risk_level: 'medium',
    setup_complexity: 'medium',
    automation_depth: 'read_only_preview',
    safe_cta: 'View Evidence',
    blocked_reason: RB.WORKFLOW_EXECUTION_NOT_ENABLED,
  }),
  // 4 — Cashflow Risk Review
  defineWorkflow({
    id: 'workflow_cashflow_risk_review',
    name: 'Cashflow Risk Review',
    domain: WORKFLOW_DOMAIN.CASHFLOW,
    category: WORKFLOW_CATEGORY.BUSINESS_REVIEW,
    status: WORKFLOW_STATUS.PREVIEW,
    proof_level: PROOF_LEVEL.STAGING_PROVEN,
    target_business_outcome: 'Read-only view of cash pressure and at-risk receivables — preview only.',
    related_packs: ['global_core', 'role_finance'],
    required_agents: ['core.owner_briefing'],
    required_data_sources: ['invoices', 'payments', 'cashflow_events'],
    input_requirements: INPUT_AUTH,
    output_contract: { kind: 'read_only_preview', returns: ['cash_pressure_preview', 'counts'] },
    approval_requirements: APPROVAL_OWNER_REVIEW,
    evidence_requirements: EVIDENCE_BASELINE,
    audit_requirements: AUDIT_BASELINE,
    risk_level: 'medium',
    setup_complexity: 'low',
    automation_depth: 'read_only_preview',
    safe_cta: 'Preview',
    blocked_reason: RB.WORKFLOW_EXECUTION_NOT_ENABLED,
  }),
  // 5 — Inventory Pressure Review
  defineWorkflow({
    id: 'workflow_inventory_pressure_review',
    name: 'Inventory Pressure Review',
    domain: WORKFLOW_DOMAIN.INVENTORY,
    category: WORKFLOW_CATEGORY.BUSINESS_REVIEW,
    status: WORKFLOW_STATUS.CONNECTOR_REQUIRED,
    proof_level: PROOF_LEVEL.DESIGN_CONTRACT,
    target_business_outcome: 'Read-only view of inventory-driven cash pressure — requires a connected data source.',
    related_packs: ['agent_swarm_inventory_ops'],
    required_agents: ['core.data_quality'],
    required_data_sources: ['inventory', 'invoices'],
    input_requirements: INPUT_AUTH,
    output_contract: { kind: 'read_only_preview', returns: ['stock_pressure_preview', 'counts'] },
    approval_requirements: APPROVAL_OWNER_REVIEW,
    evidence_requirements: EVIDENCE_BASELINE,
    audit_requirements: AUDIT_BASELINE,
    risk_level: 'low',
    setup_complexity: 'medium',
    automation_depth: 'read_only_preview',
    safe_cta: 'Connect Data Source',
    blocked_reason: RB.CONNECTOR_NOT_CONNECTED,
  }),
  // 6 — Sales Pipeline Review
  defineWorkflow({
    id: 'workflow_sales_pipeline_review',
    name: 'Sales Pipeline Review',
    domain: WORKFLOW_DOMAIN.SALES,
    category: WORKFLOW_CATEGORY.BUSINESS_REVIEW,
    status: WORKFLOW_STATUS.CONNECTOR_REQUIRED,
    proof_level: PROOF_LEVEL.DESIGN_CONTRACT,
    target_business_outcome: 'Read-only view of sales pipeline health — requires a connected data source.',
    related_packs: ['business_type_distributor'],
    required_agents: [],
    required_data_sources: ['sales_orders', 'customers'],
    input_requirements: INPUT_AUTH,
    output_contract: { kind: 'read_only_preview', returns: ['pipeline_preview', 'counts'] },
    approval_requirements: APPROVAL_OWNER_REVIEW,
    evidence_requirements: EVIDENCE_BASELINE,
    audit_requirements: AUDIT_BASELINE,
    risk_level: 'low',
    setup_complexity: 'medium',
    automation_depth: 'read_only_preview',
    safe_cta: 'Connect Data Source',
    blocked_reason: RB.CONNECTOR_NOT_CONNECTED,
  }),
  // 7 — Purchase / Supplier Review
  defineWorkflow({
    id: 'workflow_purchase_supplier_review',
    name: 'Purchase & Supplier Review',
    domain: WORKFLOW_DOMAIN.PURCHASE,
    category: WORKFLOW_CATEGORY.BUSINESS_REVIEW,
    status: WORKFLOW_STATUS.CONNECTOR_REQUIRED,
    proof_level: PROOF_LEVEL.DESIGN_CONTRACT,
    target_business_outcome: 'Read-only view of supplier exposure and payables — requires a connected data source.',
    related_packs: ['business_type_distributor'],
    required_agents: [],
    required_data_sources: ['purchase_orders', 'suppliers', 'payments'],
    input_requirements: INPUT_AUTH,
    output_contract: { kind: 'read_only_preview', returns: ['payables_preview', 'counts'] },
    approval_requirements: APPROVAL_OWNER_REVIEW,
    evidence_requirements: EVIDENCE_BASELINE,
    audit_requirements: AUDIT_BASELINE,
    risk_level: 'low',
    setup_complexity: 'medium',
    automation_depth: 'read_only_preview',
    safe_cta: 'Connect Data Source',
    blocked_reason: RB.CONNECTOR_NOT_CONNECTED,
  }),
  // 8 — Customer Risk Review
  defineWorkflow({
    id: 'workflow_customer_risk_review',
    name: 'Customer Risk Review',
    domain: WORKFLOW_DOMAIN.CREDIT_RISK,
    category: WORKFLOW_CATEGORY.BUSINESS_REVIEW,
    status: WORKFLOW_STATUS.PREVIEW,
    proof_level: PROOF_LEVEL.STAGING_PROVEN,
    target_business_outcome: 'Read-only view of customer credit risk and exposure — preview only.',
    related_packs: ['role_finance'],
    required_agents: ['core.policy_guard'],
    required_data_sources: ['invoices', 'customers', 'payments'],
    input_requirements: INPUT_AUTH,
    output_contract: { kind: 'read_only_preview', returns: ['risk_score_preview', 'counts'] },
    approval_requirements: APPROVAL_OWNER_REVIEW,
    evidence_requirements: EVIDENCE_BASELINE,
    audit_requirements: AUDIT_BASELINE,
    risk_level: 'medium',
    setup_complexity: 'medium',
    automation_depth: 'read_only_preview',
    safe_cta: 'View Evidence',
    blocked_reason: RB.WORKFLOW_EXECUTION_NOT_ENABLED,
  }),
  // 9 — Actions Approval Review
  defineWorkflow({
    id: 'workflow_actions_approval_review',
    name: 'Actions Approval Review',
    domain: WORKFLOW_DOMAIN.GOVERNANCE,
    category: WORKFLOW_CATEGORY.GOVERNANCE,
    status: WORKFLOW_STATUS.PREVIEW,
    proof_level: PROOF_LEVEL.DESIGN_CONTRACT,
    target_business_outcome: 'Read-only review of AI-proposed actions awaiting owner approval — nothing is executed.',
    related_packs: ['global_core'],
    required_agents: ['core.policy_guard'],
    required_data_sources: ['ai_actions'],
    input_requirements: INPUT_AUTH,
    output_contract: { kind: 'read_only_preview', returns: ['pending_actions_preview', 'counts'] },
    approval_requirements: APPROVAL_OWNER_REVIEW,
    evidence_requirements: EVIDENCE_BASELINE,
    audit_requirements: AUDIT_BASELINE,
    risk_level: 'medium',
    setup_complexity: 'low',
    automation_depth: 'read_only_preview',
    safe_cta: 'Requires Approval',
    blocked_reason: RB.WORKFLOW_EXECUTION_NOT_ENABLED,
  }),
  // 10 — Evidence Review
  defineWorkflow({
    id: 'workflow_evidence_review',
    name: 'Evidence Review',
    domain: WORKFLOW_DOMAIN.EVIDENCE,
    category: WORKFLOW_CATEGORY.GOVERNANCE,
    status: WORKFLOW_STATUS.PREVIEW,
    proof_level: PROOF_LEVEL.STAGING_PROVEN,
    target_business_outcome: 'Read-only review of the evidence behind a briefing or recommendation — preview only.',
    related_packs: ['global_core'],
    required_agents: ['core.owner_briefing'],
    required_data_sources: ['evidence_records'],
    input_requirements: INPUT_AUTH,
    output_contract: { kind: 'read_only_preview', returns: ['evidence_preview', 'confidence_label'] },
    approval_requirements: APPROVAL_OWNER_REVIEW,
    evidence_requirements: EVIDENCE_RAG,
    audit_requirements: AUDIT_BASELINE,
    risk_level: 'low',
    setup_complexity: 'low',
    automation_depth: 'read_only_preview',
    safe_cta: 'View Evidence',
    blocked_reason: RB.WORKFLOW_EXECUTION_NOT_ENABLED,
  }),
  // 11 — Data Source Readiness
  defineWorkflow({
    id: 'workflow_data_source_readiness',
    name: 'Data Source Readiness',
    domain: WORKFLOW_DOMAIN.DATA_OPS,
    category: WORKFLOW_CATEGORY.ENABLEMENT,
    status: WORKFLOW_STATUS.CONNECTOR_REQUIRED,
    proof_level: PROOF_LEVEL.DESIGN_CONTRACT,
    target_business_outcome: 'Read-only assessment of whether a data source is connected and ready — requires connection.',
    related_packs: ['industry_wholesale_distribution', 'region_india'],
    required_agents: ['core.data_quality'],
    required_data_sources: ['connection_metadata'],
    input_requirements: INPUT_AUTH,
    output_contract: { kind: 'read_only_preview', returns: ['readiness_status', 'gap_list_preview'] },
    approval_requirements: APPROVAL_OWNER_REVIEW,
    evidence_requirements: EVIDENCE_BASELINE,
    audit_requirements: AUDIT_BASELINE,
    risk_level: 'low',
    setup_complexity: 'medium',
    automation_depth: 'read_only_preview',
    safe_cta: 'Connect Data Source',
    blocked_reason: RB.CONNECTOR_NOT_CONNECTED,
  }),
  // 12 — Neon → Cortex Dry Run (roadmap; never triggers real sync)
  defineWorkflow({
    id: 'workflow_neon_to_cortex_dry_run',
    name: 'Neon to Cortex Dry-Run',
    domain: WORKFLOW_DOMAIN.DATA_OPS,
    category: WORKFLOW_CATEGORY.INFRASTRUCTURE,
    status: WORKFLOW_STATUS.ROADMAP,
    proof_level: PROOF_LEVEL.NONE,
    target_business_outcome: 'Planned read-only dry-run description of the data pipeline — roadmap; triggers no real sync.',
    related_packs: [],
    required_agents: [],
    required_data_sources: ['pipeline_metadata'],
    input_requirements: INPUT_AUTH,
    output_contract: { kind: 'read_only_preview', returns: ['dry_run_plan_preview'] },
    approval_requirements: APPROVAL_CANARY,
    evidence_requirements: [],
    audit_requirements: AUDIT_BASELINE,
    risk_level: 'high',
    setup_complexity: 'high',
    automation_depth: 'supervised_planned',
    safe_cta: 'View Requirements',
    blocked_reason: RB.ROADMAP_NOT_BUILT,
  }),
  // 13 — Canary Scope Review
  defineWorkflow({
    id: 'workflow_canary_scope_review',
    name: 'Canary Scope Review',
    domain: WORKFLOW_DOMAIN.GOVERNANCE,
    category: WORKFLOW_CATEGORY.GOVERNANCE,
    status: WORKFLOW_STATUS.CUSTOM_REQUIRED,
    proof_level: PROOF_LEVEL.DESIGN_CONTRACT,
    target_business_outcome: 'Read-only review of a proposed canary scope against the Phase 2C.25 contract — requires a recorded scope.',
    related_packs: ['enterprise_pack'],
    required_agents: [],
    required_data_sources: ['canary_scope_record'],
    input_requirements: INPUT_AUTH,
    output_contract: { kind: 'read_only_preview', returns: ['scope_check_preview', 'gap_list_preview'] },
    approval_requirements: APPROVAL_CANARY,
    evidence_requirements: EVIDENCE_BASELINE,
    audit_requirements: AUDIT_BASELINE,
    risk_level: 'high',
    setup_complexity: 'high',
    automation_depth: 'supervised_planned',
    safe_cta: 'Requires Approval',
    blocked_reason: RB.CUSTOM_CONFIGURATION_REQUIRED,
  }),
  // 14 — Pack Activation Request
  defineWorkflow({
    id: 'workflow_pack_activation_request',
    name: 'Pack Activation Request',
    domain: WORKFLOW_DOMAIN.GOVERNANCE,
    category: WORKFLOW_CATEGORY.GOVERNANCE,
    status: WORKFLOW_STATUS.CUSTOM_REQUIRED,
    proof_level: PROOF_LEVEL.DESIGN_CONTRACT,
    target_business_outcome: 'Read-only intake to REQUEST (not perform) activation of a pack — records a request, activates nothing.',
    related_packs: ['trader_pack', 'enterprise_pack', 'custom_pack'],
    required_agents: [],
    required_data_sources: ['owner_approval_record'],
    input_requirements: INPUT_AUTH,
    output_contract: { kind: 'read_only_preview', returns: ['request_form_preview', 'requirements_preview'] },
    approval_requirements: APPROVAL_CANARY,
    evidence_requirements: EVIDENCE_BASELINE,
    audit_requirements: AUDIT_BASELINE,
    risk_level: 'medium',
    setup_complexity: 'medium',
    automation_depth: 'assisted_planned',
    safe_cta: 'Request Activation',
    blocked_reason: RB.CUSTOM_CONFIGURATION_REQUIRED,
  }),
  // 15 — Enterprise Governance Review
  defineWorkflow({
    id: 'workflow_enterprise_governance_review',
    name: 'Enterprise Governance Review',
    domain: WORKFLOW_DOMAIN.GOVERNANCE,
    category: WORKFLOW_CATEGORY.GOVERNANCE,
    status: WORKFLOW_STATUS.CUSTOM_REQUIRED,
    proof_level: PROOF_LEVEL.DESIGN_CONTRACT,
    target_business_outcome: 'Read-only governance and policy review for larger deployments — requires configuration.',
    related_packs: ['enterprise_pack', 'business_size_enterprise'],
    required_agents: ['core.policy_guard'],
    required_data_sources: ['policy_records'],
    input_requirements: INPUT_AUTH,
    output_contract: { kind: 'read_only_preview', returns: ['governance_preview', 'gap_list_preview'] },
    approval_requirements: APPROVAL_CANARY,
    evidence_requirements: EVIDENCE_RAG,
    audit_requirements: AUDIT_BASELINE,
    risk_level: 'medium',
    setup_complexity: 'high',
    automation_depth: 'supervised_planned',
    safe_cta: 'Requires Approval',
    blocked_reason: RB.CUSTOM_CONFIGURATION_REQUIRED,
  }),
  // 16 — Custom Pack Design
  defineWorkflow({
    id: 'workflow_custom_pack_design',
    name: 'Custom Pack Design',
    domain: WORKFLOW_DOMAIN.DESIGN,
    category: WORKFLOW_CATEGORY.ENABLEMENT,
    status: WORKFLOW_STATUS.CUSTOM_REQUIRED,
    proof_level: PROOF_LEVEL.DESIGN_CONTRACT,
    target_business_outcome: 'Read-only design workspace for composing a custom pack from approved building blocks — requires configuration.',
    related_packs: ['custom_pack'],
    required_agents: [],
    required_data_sources: ['design_inputs'],
    input_requirements: INPUT_AUTH,
    output_contract: { kind: 'read_only_preview', returns: ['design_preview', 'requirements_preview'] },
    approval_requirements: APPROVAL_OWNER_REVIEW,
    evidence_requirements: EVIDENCE_BASELINE,
    audit_requirements: AUDIT_BASELINE,
    risk_level: 'medium',
    setup_complexity: 'high',
    automation_depth: 'assisted_planned',
    safe_cta: 'Configure Custom Workflow',
    blocked_reason: RB.CUSTOM_CONFIGURATION_REQUIRED,
  }),
  // 17 — Agent Swarm Planning
  defineWorkflow({
    id: 'workflow_agent_swarm_planning',
    name: 'Agent Swarm Planning',
    domain: WORKFLOW_DOMAIN.ORCHESTRATION,
    category: WORKFLOW_CATEGORY.INFRASTRUCTURE,
    status: WORKFLOW_STATUS.ROADMAP,
    proof_level: PROOF_LEVEL.NONE,
    target_business_outcome: 'Planned read-only description of how an agent group would coordinate — roadmap; not executable here.',
    related_packs: ['agent_swarm_finance_ops', 'agent_swarm_inventory_ops'],
    required_agents: ['core.owner_briefing', 'core.cost_router', 'core.policy_guard'],
    required_data_sources: ['orchestration_metadata'],
    input_requirements: INPUT_AUTH,
    output_contract: { kind: 'read_only_preview', returns: ['plan_preview'] },
    approval_requirements: APPROVAL_CANARY,
    evidence_requirements: [],
    audit_requirements: AUDIT_BASELINE,
    risk_level: 'high',
    setup_complexity: 'high',
    automation_depth: 'orchestrated_planned',
    safe_cta: 'View Requirements',
    blocked_reason: RB.ROADMAP_NOT_BUILT,
  }),
  // 18 — Partner Deployment Review
  defineWorkflow({
    id: 'workflow_partner_deployment_review',
    name: 'Partner Deployment Review',
    domain: WORKFLOW_DOMAIN.PARTNER,
    category: WORKFLOW_CATEGORY.DEPLOYMENT,
    status: WORKFLOW_STATUS.PARTNER_REQUIRED,
    proof_level: PROOF_LEVEL.DESIGN_CONTRACT,
    target_business_outcome: 'Read-only review of a partner-delivered deployment — requires partner approval and a signed contract.',
    related_packs: ['partner_custom_deployment'],
    required_agents: [],
    required_data_sources: ['deployment_metadata'],
    input_requirements: INPUT_AUTH,
    output_contract: { kind: 'read_only_preview', returns: ['deployment_review_preview', 'requirements_preview'] },
    approval_requirements: APPROVAL_CANARY,
    evidence_requirements: EVIDENCE_BASELINE,
    audit_requirements: AUDIT_BASELINE,
    risk_level: 'high',
    setup_complexity: 'high',
    automation_depth: 'supervised_planned',
    safe_cta: 'Requires Approval',
    blocked_reason: RB.PARTNER_DEPLOYMENT_REQUIRED,
  }),
]);

module.exports = {
  WORKFLOW_REGISTRY_VERSION,
  WORKFLOW_STATUS,
  ALLOWED_WORKFLOW_STATUSES,
  WORKFLOW_DOMAIN,
  ALLOWED_WORKFLOW_DOMAINS,
  WORKFLOW_CATEGORY,
  ALLOWED_WORKFLOW_CATEGORIES,
  PROOF_LEVEL,
  ALLOWED_PROOF_LEVELS,
  ALLOWED_SAFE_CTAS,
  FORBIDDEN_CTAS,
  WORKFLOW_BLOCKED_REASON,
  ALLOWED_SETUP_COMPLEXITY,
  ALLOWED_AUTOMATION_DEPTH,
  ALLOWED_RISK_LEVEL,
  REQUIRED_WORKFLOW_FIELDS,
  BLOCKED_ACTIONS,
  WORKFLOWS,
};
