// FILE: lib/config/atlasPackRegistry.js
// ─────────────────────────────────────────────────────────────────────────────
// Atlas Pack Registry — static, honest, READ-ONLY backend truth (Phase 2C.26).
//
// PURPOSE
//   Defines the Atlas Pack Civilization Layer as a TRUTH MODEL — the
//   multidimensional operating-model layer for businesses — NOT as marketing and
//   NOT as anything executable. Every pack is read-only metadata: it tells the
//   frontend/agents what a pack IS, who it is for, what it would include, and what
//   it would require — never that it is live, runnable, or activatable.
//
// HARD INVARIANTS (enforced by scripts/phase-2c-26-atlas-pack-registry-check.js):
//   - live_proven packs            = 0   (nothing is proven live at the pack level)
//   - execution_allowed packs      = 0   (the registry NEVER executes a pack)
//   - activation_allowed packs     = 0   (activation needs live_proven; none exist)
//   - preview / connector / custom / partner / roadmap / disabled packs are all
//     non-executable; their only call-to-action is a SAFE, read-only CTA.
//
// THIS FILE IS PURE STATIC DATA. It contains NO secrets, DB URLs, env values,
// tokens, customer PII, emails, phones, invoice details, or raw row data —
// only ids, names, statuses, labels, counts, and booleans.
//
// It is INTENTIONALLY SEPARATE from lib/config/atlasRuntimeTruth.js: the runtime
// truth model uses a 4-value proof enum (live_proven/live_limited/planned/blocked)
// for individual agents/workflows; the pack layer uses the richer pack-status enum
// below to describe how a business would adopt a pack. Neither file is live.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const PACK_REGISTRY_VERSION = '2C.26';

// ── PACK STATUS ENUM — the ONLY allowed status values for a pack ───────────────
const PACK_STATUS = Object.freeze({
  LIVE_PROVEN: 'live_proven',           // MUST stay count 0 — proven live at pack level
  LIVE_LIMITED: 'live_limited',         // an honestly-mapped read-only preview proven in a canary
  PREVIEW: 'preview',                   // read-only preview surface; not executable
  CONNECTOR_REQUIRED: 'connector_required', // needs a connected data source first
  CUSTOM_REQUIRED: 'custom_required',   // needs owner/enterprise configuration first
  PARTNER_REQUIRED: 'partner_required', // needs partner approval + deployment
  ROADMAP: 'roadmap',                   // designed/declared only; not built
  DISABLED: 'disabled',                 // explicitly switched off
});
const ALLOWED_PACK_STATUSES = Object.freeze(Object.values(PACK_STATUS));

// ── PACK FAMILY ENUM — the required pack families ──────────────────────────────
const PACK_FAMILY = Object.freeze({
  GLOBAL_CORE: 'global_core',
  TRADER: 'trader',
  ENTERPRISE: 'enterprise',
  CUSTOM: 'custom',
  BUSINESS_TYPE: 'business_type',
  BUSINESS_SIZE: 'business_size',
  INDUSTRY: 'industry',
  REGION: 'region',
  ROLE: 'role',
  WORKFLOW: 'workflow',
  AGENT_SWARM: 'agent_swarm',
  PARTNER_CUSTOM_DEPLOYMENT: 'partner_custom_deployment',
});
const ALLOWED_PACK_FAMILIES = Object.freeze(Object.values(PACK_FAMILY));

// ── PACK CATEGORY ENUM — the dimension a pack operates on ──────────────────────
const PACK_CATEGORY = Object.freeze({
  CORE: 'core',
  COMMERCIAL_TIER: 'commercial_tier',
  SEGMENTATION: 'segmentation',
  GEOGRAPHY: 'geography',
  PERSONA: 'persona',
  OPERATING_MODEL: 'operating_model',
  DEPLOYMENT: 'deployment',
});
const ALLOWED_PACK_CATEGORIES = Object.freeze(Object.values(PACK_CATEGORY));

// ── PROOF LEVEL ENUM — depth of proof behind a pack (conservative) ─────────────
const PROOF_LEVEL = Object.freeze({
  NONE: 'none',                         // nothing proven
  DESIGN_CONTRACT: 'design_contract',   // contract/design defined in backend, not built
  STAGING_PROVEN: 'staging_proven',     // underlying capability proven on staging only
  PRODUCTION_CANARY: 'production_canary', // an honestly-mapped read-only production canary
});
const ALLOWED_PROOF_LEVELS = Object.freeze(Object.values(PROOF_LEVEL));

// ── SAFE CTA — the ONLY call-to-action labels a pack may surface ───────────────
const ALLOWED_SAFE_CTAS = Object.freeze([
  'Preview',
  'Request Activation',
  'Connect Data Source',
  'Configure Custom Pack',
  'Requires Approval',
  'View Evidence',
  'View Requirements',
]);

// ── FORBIDDEN CTA — labels that imply execution and must NEVER appear ──────────
const FORBIDDEN_CTAS = Object.freeze([
  'Run Now',
  'Execute',
  'Launch Agent',
  'Start Automation',
  'Send',
  'Sync Production',
]);

// ── BLOCKED ACTIONS — what this registry refuses to do / claim ─────────────────
const BLOCKED_ACTIONS = Object.freeze([
  'pack_execution',
  'pack_activation',
  'production_sync',
  'external_sending',
  'deploy',
  'production_db_connection',
  'ga_claim',
  'canary_ready_claim',
  'public_production_live_claim',
]);

// ── PACK BLOCKED REASON ENUM (documentation only) ──────────────────────────────
const PACK_BLOCKED_REASON = Object.freeze({
  PACK_EXECUTION_NOT_ENABLED: 'pack_execution_not_enabled',
  CONNECTOR_NOT_CONNECTED: 'connector_not_connected',
  CUSTOM_CONFIGURATION_REQUIRED: 'custom_configuration_required',
  PARTNER_DEPLOYMENT_REQUIRED: 'partner_deployment_required',
  ROADMAP_NOT_BUILT: 'roadmap_not_built',
  DISABLED_BY_DEFAULT: 'disabled_by_default',
});

// ── value enums for the descriptive fields ─────────────────────────────────────
const ALLOWED_SETUP_COMPLEXITY = Object.freeze(['low', 'medium', 'high']);
const ALLOWED_AUTOMATION_DEPTH = Object.freeze([
  'read_only_preview',   // the only honest depth today
  'assisted_planned',
  'supervised_planned',
  'orchestrated_planned',
]);
const ALLOWED_RISK_LEVEL = Object.freeze(['low', 'medium', 'high']);

// The exact field set every pack entry must carry.
const REQUIRED_PACK_FIELDS = Object.freeze([
  'id', 'name', 'family', 'category', 'status', 'proof_level',
  'execution_allowed', 'activation_allowed', 'target_business', 'outcome',
  'included_agents', 'included_workflows', 'required_data_sources',
  'approval_requirements', 'evidence_requirements', 'audit_requirements',
  'setup_complexity', 'automation_depth', 'risk_level', 'safe_cta', 'blocked_reason',
]);

// ── shared requirement labels (generic categories only — never raw data/PII) ───
const AUDIT_BASELINE = ['audit_user_resolved', 'counts_booleans_only_no_pii', 'no_raw_row_data'];
const EVIDENCE_BASELINE = ['harness_x_static_proof', 'staging_proof'];
const EVIDENCE_RAG = ['harness_x_static_proof', 'rag_evidence_contract', 'staging_proof'];
const APPROVAL_CANARY = ['owner_approval_record', 'canary_scope_record']; // per Phase 2C.25
const APPROVAL_OWNER_REVIEW = ['owner_review'];

// definePack() FORCES the two execution invariants false regardless of input, so a
// pack literally cannot be marked executable/activatable from this registry.
function definePack(p) {
  return Object.freeze({
    id: p.id,
    name: p.name,
    family: p.family,
    category: p.category,
    status: p.status,
    proof_level: p.proof_level,
    execution_allowed: false,   // HARD INVARIANT — the registry never executes a pack
    activation_allowed: false,  // HARD INVARIANT — activation needs live_proven (none exist)
    target_business: p.target_business,
    outcome: p.outcome,
    included_agents: Object.freeze((p.included_agents || []).slice()),
    included_workflows: Object.freeze((p.included_workflows || []).slice()),
    required_data_sources: Object.freeze((p.required_data_sources || []).slice()),
    approval_requirements: Object.freeze((p.approval_requirements || []).slice()),
    evidence_requirements: Object.freeze((p.evidence_requirements || []).slice()),
    audit_requirements: Object.freeze((p.audit_requirements || []).slice()),
    setup_complexity: p.setup_complexity,
    automation_depth: p.automation_depth,
    risk_level: p.risk_level,
    safe_cta: p.safe_cta,
    blocked_reason: p.blocked_reason,
  });
}

// ── THE PACK REGISTRY ──────────────────────────────────────────────────────────
const PACKS = Object.freeze([
  // 1 — Global Core Pack (foundation)
  definePack({
    id: 'global_core',
    name: 'Global Core Pack',
    family: PACK_FAMILY.GLOBAL_CORE,
    category: PACK_CATEGORY.CORE,
    status: PACK_STATUS.PREVIEW,
    proof_level: PROOF_LEVEL.STAGING_PROVEN,
    target_business: 'Any business (foundation layer)',
    outcome: 'Know who owes money, who breaks promises, and what to act on today — read-only preview.',
    included_agents: ['core.owner_briefing', 'core.data_quality', 'core.policy_guard', 'core.cost_router'],
    included_workflows: ['workflow.owner_briefing_preview'],
    required_data_sources: ['invoices', 'customers', 'payments'],
    approval_requirements: APPROVAL_OWNER_REVIEW,
    evidence_requirements: EVIDENCE_RAG,
    audit_requirements: AUDIT_BASELINE,
    setup_complexity: 'low',
    automation_depth: 'read_only_preview',
    risk_level: 'low',
    safe_cta: 'Preview',
    blocked_reason: PACK_BLOCKED_REASON.PACK_EXECUTION_NOT_ENABLED,
  }),
  // 2 — Trader Pack
  definePack({
    id: 'trader_pack',
    name: 'Trader Pack',
    family: PACK_FAMILY.TRADER,
    category: PACK_CATEGORY.COMMERCIAL_TIER,
    status: PACK_STATUS.PREVIEW,
    proof_level: PROOF_LEVEL.DESIGN_CONTRACT,
    target_business: 'Trading / reselling / distribution businesses',
    outcome: 'Receivables-first cash visibility for fast-moving trade — read-only preview.',
    included_agents: ['core.owner_briefing', 'core.cost_router'],
    included_workflows: [],
    required_data_sources: ['invoices', 'customers', 'payments'],
    approval_requirements: APPROVAL_OWNER_REVIEW,
    evidence_requirements: EVIDENCE_BASELINE,
    audit_requirements: AUDIT_BASELINE,
    setup_complexity: 'low',
    automation_depth: 'read_only_preview',
    risk_level: 'low',
    safe_cta: 'Preview',
    blocked_reason: PACK_BLOCKED_REASON.PACK_EXECUTION_NOT_ENABLED,
  }),
  // 3 — Enterprise Pack
  definePack({
    id: 'enterprise_pack',
    name: 'Enterprise Pack',
    family: PACK_FAMILY.ENTERPRISE,
    category: PACK_CATEGORY.COMMERCIAL_TIER,
    status: PACK_STATUS.CUSTOM_REQUIRED,
    proof_level: PROOF_LEVEL.DESIGN_CONTRACT,
    target_business: 'Larger multi-team businesses',
    outcome: 'Multi-team finance operating model — requires custom configuration before any use.',
    included_agents: ['core.owner_briefing', 'core.policy_guard', 'core.cost_router'],
    included_workflows: [],
    required_data_sources: ['invoices', 'customers', 'payments', 'inventory'],
    approval_requirements: APPROVAL_CANARY,
    evidence_requirements: EVIDENCE_RAG,
    audit_requirements: AUDIT_BASELINE,
    setup_complexity: 'high',
    automation_depth: 'supervised_planned',
    risk_level: 'medium',
    safe_cta: 'Configure Custom Pack',
    blocked_reason: PACK_BLOCKED_REASON.CUSTOM_CONFIGURATION_REQUIRED,
  }),
  // 4 — Custom Pack
  definePack({
    id: 'custom_pack',
    name: 'Custom Pack',
    family: PACK_FAMILY.CUSTOM,
    category: PACK_CATEGORY.COMMERCIAL_TIER,
    status: PACK_STATUS.CUSTOM_REQUIRED,
    proof_level: PROOF_LEVEL.DESIGN_CONTRACT,
    target_business: 'Businesses with bespoke needs',
    outcome: 'Owner-defined pack composed from approved building blocks — requires configuration.',
    included_agents: [],
    included_workflows: [],
    required_data_sources: [],
    approval_requirements: APPROVAL_CANARY,
    evidence_requirements: EVIDENCE_BASELINE,
    audit_requirements: AUDIT_BASELINE,
    setup_complexity: 'high',
    automation_depth: 'supervised_planned',
    risk_level: 'medium',
    safe_cta: 'Configure Custom Pack',
    blocked_reason: PACK_BLOCKED_REASON.CUSTOM_CONFIGURATION_REQUIRED,
  }),
  // 5 — Business-Type: Distributor
  definePack({
    id: 'business_type_distributor',
    name: 'Distributor Business-Type Pack',
    family: PACK_FAMILY.BUSINESS_TYPE,
    category: PACK_CATEGORY.SEGMENTATION,
    status: PACK_STATUS.PREVIEW,
    proof_level: PROOF_LEVEL.DESIGN_CONTRACT,
    target_business: 'Distributors / wholesalers',
    outcome: 'Distributor receivables and credit-control preview — read-only.',
    included_agents: ['core.owner_briefing'],
    included_workflows: [],
    required_data_sources: ['invoices', 'customers', 'payments'],
    approval_requirements: APPROVAL_OWNER_REVIEW,
    evidence_requirements: EVIDENCE_BASELINE,
    audit_requirements: AUDIT_BASELINE,
    setup_complexity: 'low',
    automation_depth: 'read_only_preview',
    risk_level: 'low',
    safe_cta: 'Preview',
    blocked_reason: PACK_BLOCKED_REASON.PACK_EXECUTION_NOT_ENABLED,
  }),
  // 6 — Business-Type: Manufacturer
  definePack({
    id: 'business_type_manufacturer',
    name: 'Manufacturer Business-Type Pack',
    family: PACK_FAMILY.BUSINESS_TYPE,
    category: PACK_CATEGORY.SEGMENTATION,
    status: PACK_STATUS.ROADMAP,
    proof_level: PROOF_LEVEL.NONE,
    target_business: 'Manufacturers',
    outcome: 'Manufacturing cash and receivables model — roadmap, not built.',
    included_agents: [],
    included_workflows: [],
    required_data_sources: ['invoices', 'customers', 'payments', 'inventory'],
    approval_requirements: APPROVAL_OWNER_REVIEW,
    evidence_requirements: [],
    audit_requirements: AUDIT_BASELINE,
    setup_complexity: 'medium',
    automation_depth: 'supervised_planned',
    risk_level: 'low',
    safe_cta: 'View Requirements',
    blocked_reason: PACK_BLOCKED_REASON.ROADMAP_NOT_BUILT,
  }),
  // 7 — Business-Size: Startup
  definePack({
    id: 'business_size_startup',
    name: 'Startup Business-Size Pack',
    family: PACK_FAMILY.BUSINESS_SIZE,
    category: PACK_CATEGORY.SEGMENTATION,
    status: PACK_STATUS.PREVIEW,
    proof_level: PROOF_LEVEL.DESIGN_CONTRACT,
    target_business: 'Early-stage / startup businesses',
    outcome: 'Lean cashflow and collections preview — read-only.',
    included_agents: ['core.owner_briefing'],
    included_workflows: [],
    required_data_sources: ['invoices', 'customers', 'payments'],
    approval_requirements: APPROVAL_OWNER_REVIEW,
    evidence_requirements: EVIDENCE_BASELINE,
    audit_requirements: AUDIT_BASELINE,
    setup_complexity: 'low',
    automation_depth: 'read_only_preview',
    risk_level: 'low',
    safe_cta: 'Preview',
    blocked_reason: PACK_BLOCKED_REASON.PACK_EXECUTION_NOT_ENABLED,
  }),
  // 8 — Business-Size: SMB
  definePack({
    id: 'business_size_smb',
    name: 'SMB Business-Size Pack',
    family: PACK_FAMILY.BUSINESS_SIZE,
    category: PACK_CATEGORY.SEGMENTATION,
    status: PACK_STATUS.PREVIEW,
    proof_level: PROOF_LEVEL.DESIGN_CONTRACT,
    target_business: 'Small & medium businesses',
    outcome: 'SMB receivables and collections preview — read-only.',
    included_agents: ['core.owner_briefing'],
    included_workflows: [],
    required_data_sources: ['invoices', 'customers', 'payments'],
    approval_requirements: APPROVAL_OWNER_REVIEW,
    evidence_requirements: EVIDENCE_BASELINE,
    audit_requirements: AUDIT_BASELINE,
    setup_complexity: 'medium',
    automation_depth: 'read_only_preview',
    risk_level: 'low',
    safe_cta: 'Preview',
    blocked_reason: PACK_BLOCKED_REASON.PACK_EXECUTION_NOT_ENABLED,
  }),
  // 9 — Business-Size: Enterprise
  definePack({
    id: 'business_size_enterprise',
    name: 'Enterprise Business-Size Pack',
    family: PACK_FAMILY.BUSINESS_SIZE,
    category: PACK_CATEGORY.SEGMENTATION,
    status: PACK_STATUS.CUSTOM_REQUIRED,
    proof_level: PROOF_LEVEL.DESIGN_CONTRACT,
    target_business: 'Enterprise-scale businesses',
    outcome: 'Enterprise finance operating model — requires custom configuration.',
    included_agents: ['core.owner_briefing', 'core.policy_guard'],
    included_workflows: [],
    required_data_sources: ['invoices', 'customers', 'payments', 'inventory'],
    approval_requirements: APPROVAL_CANARY,
    evidence_requirements: EVIDENCE_RAG,
    audit_requirements: AUDIT_BASELINE,
    setup_complexity: 'high',
    automation_depth: 'supervised_planned',
    risk_level: 'medium',
    safe_cta: 'Configure Custom Pack',
    blocked_reason: PACK_BLOCKED_REASON.CUSTOM_CONFIGURATION_REQUIRED,
  }),
  // 10 — Industry: Wholesale Distribution
  definePack({
    id: 'industry_wholesale_distribution',
    name: 'Wholesale & Distribution Industry Pack',
    family: PACK_FAMILY.INDUSTRY,
    category: PACK_CATEGORY.SEGMENTATION,
    status: PACK_STATUS.CONNECTOR_REQUIRED,
    proof_level: PROOF_LEVEL.DESIGN_CONTRACT,
    target_business: 'Wholesale & distribution industry',
    outcome: 'Industry-tuned receivables preview — requires a connected data source first.',
    included_agents: ['core.owner_briefing', 'core.data_quality'],
    included_workflows: [],
    required_data_sources: ['invoices', 'customers', 'payments', 'inventory'],
    approval_requirements: APPROVAL_OWNER_REVIEW,
    evidence_requirements: EVIDENCE_BASELINE,
    audit_requirements: AUDIT_BASELINE,
    setup_complexity: 'medium',
    automation_depth: 'read_only_preview',
    risk_level: 'low',
    safe_cta: 'Connect Data Source',
    blocked_reason: PACK_BLOCKED_REASON.CONNECTOR_NOT_CONNECTED,
  }),
  // 11 — Industry: Manufacturing
  definePack({
    id: 'industry_manufacturing',
    name: 'Manufacturing Industry Pack',
    family: PACK_FAMILY.INDUSTRY,
    category: PACK_CATEGORY.SEGMENTATION,
    status: PACK_STATUS.ROADMAP,
    proof_level: PROOF_LEVEL.NONE,
    target_business: 'Manufacturing industry',
    outcome: 'Industry-tuned manufacturing finance model — roadmap, not built.',
    included_agents: [],
    included_workflows: [],
    required_data_sources: ['invoices', 'customers', 'payments', 'inventory'],
    approval_requirements: APPROVAL_OWNER_REVIEW,
    evidence_requirements: [],
    audit_requirements: AUDIT_BASELINE,
    setup_complexity: 'high',
    automation_depth: 'supervised_planned',
    risk_level: 'low',
    safe_cta: 'View Requirements',
    blocked_reason: PACK_BLOCKED_REASON.ROADMAP_NOT_BUILT,
  }),
  // 12 — Region: Global
  definePack({
    id: 'region_global',
    name: 'Global Region Pack',
    family: PACK_FAMILY.REGION,
    category: PACK_CATEGORY.GEOGRAPHY,
    status: PACK_STATUS.PREVIEW,
    proof_level: PROOF_LEVEL.DESIGN_CONTRACT,
    target_business: 'Global / region-agnostic',
    outcome: 'Region-neutral baseline preview — read-only.',
    included_agents: ['core.owner_briefing'],
    included_workflows: [],
    required_data_sources: ['invoices', 'customers', 'payments'],
    approval_requirements: APPROVAL_OWNER_REVIEW,
    evidence_requirements: EVIDENCE_BASELINE,
    audit_requirements: AUDIT_BASELINE,
    setup_complexity: 'low',
    automation_depth: 'read_only_preview',
    risk_level: 'low',
    safe_cta: 'Preview',
    blocked_reason: PACK_BLOCKED_REASON.PACK_EXECUTION_NOT_ENABLED,
  }),
  // 13 — Region: India
  definePack({
    id: 'region_india',
    name: 'India Region Pack',
    family: PACK_FAMILY.REGION,
    category: PACK_CATEGORY.GEOGRAPHY,
    status: PACK_STATUS.CONNECTOR_REQUIRED,
    proof_level: PROOF_LEVEL.DESIGN_CONTRACT,
    target_business: 'India (MSME)',
    outcome: 'India-tuned receivables preview — requires a connected data source first.',
    included_agents: ['core.owner_briefing'],
    included_workflows: [],
    required_data_sources: ['invoices', 'customers', 'payments'],
    approval_requirements: APPROVAL_OWNER_REVIEW,
    evidence_requirements: EVIDENCE_BASELINE,
    audit_requirements: AUDIT_BASELINE,
    setup_complexity: 'medium',
    automation_depth: 'read_only_preview',
    risk_level: 'low',
    safe_cta: 'Connect Data Source',
    blocked_reason: PACK_BLOCKED_REASON.CONNECTOR_NOT_CONNECTED,
  }),
  // 14 — Region: US
  definePack({
    id: 'region_us',
    name: 'US Region Pack',
    family: PACK_FAMILY.REGION,
    category: PACK_CATEGORY.GEOGRAPHY,
    status: PACK_STATUS.ROADMAP,
    proof_level: PROOF_LEVEL.NONE,
    target_business: 'United States',
    outcome: 'US compliance-aware model — roadmap, not built.',
    included_agents: [],
    included_workflows: [],
    required_data_sources: ['invoices', 'customers', 'payments'],
    approval_requirements: APPROVAL_OWNER_REVIEW,
    evidence_requirements: [],
    audit_requirements: AUDIT_BASELINE,
    setup_complexity: 'high',
    automation_depth: 'supervised_planned',
    risk_level: 'low',
    safe_cta: 'View Requirements',
    blocked_reason: PACK_BLOCKED_REASON.ROADMAP_NOT_BUILT,
  }),
  // 15 — Region: UAE
  definePack({
    id: 'region_uae',
    name: 'UAE Region Pack',
    family: PACK_FAMILY.REGION,
    category: PACK_CATEGORY.GEOGRAPHY,
    status: PACK_STATUS.ROADMAP,
    proof_level: PROOF_LEVEL.NONE,
    target_business: 'United Arab Emirates',
    outcome: 'UAE compliance-aware model — roadmap, not built.',
    included_agents: [],
    included_workflows: [],
    required_data_sources: ['invoices', 'customers', 'payments'],
    approval_requirements: APPROVAL_OWNER_REVIEW,
    evidence_requirements: [],
    audit_requirements: AUDIT_BASELINE,
    setup_complexity: 'high',
    automation_depth: 'supervised_planned',
    risk_level: 'low',
    safe_cta: 'View Requirements',
    blocked_reason: PACK_BLOCKED_REASON.ROADMAP_NOT_BUILT,
  }),
  // 16 — Region: UK/EU
  definePack({
    id: 'region_uk_eu',
    name: 'UK/EU Region Pack',
    family: PACK_FAMILY.REGION,
    category: PACK_CATEGORY.GEOGRAPHY,
    status: PACK_STATUS.ROADMAP,
    proof_level: PROOF_LEVEL.NONE,
    target_business: 'UK & EU',
    outcome: 'UK/EU (GDPR-aware) model — roadmap, not built.',
    included_agents: [],
    included_workflows: [],
    required_data_sources: ['invoices', 'customers', 'payments'],
    approval_requirements: APPROVAL_OWNER_REVIEW,
    evidence_requirements: [],
    audit_requirements: AUDIT_BASELINE,
    setup_complexity: 'high',
    automation_depth: 'supervised_planned',
    risk_level: 'medium',
    safe_cta: 'View Requirements',
    blocked_reason: PACK_BLOCKED_REASON.ROADMAP_NOT_BUILT,
  }),
  // 17 — Role: Owner
  definePack({
    id: 'role_owner',
    name: 'Owner Role Pack',
    family: PACK_FAMILY.ROLE,
    category: PACK_CATEGORY.PERSONA,
    status: PACK_STATUS.PREVIEW,
    proof_level: PROOF_LEVEL.STAGING_PROVEN,
    target_business: 'Business owner persona',
    outcome: 'Owner daily briefing and action preview — read-only.',
    included_agents: ['core.owner_briefing'],
    included_workflows: ['workflow.owner_briefing_preview'],
    required_data_sources: ['invoices', 'customers', 'payments'],
    approval_requirements: APPROVAL_OWNER_REVIEW,
    evidence_requirements: EVIDENCE_RAG,
    audit_requirements: AUDIT_BASELINE,
    setup_complexity: 'low',
    automation_depth: 'read_only_preview',
    risk_level: 'low',
    safe_cta: 'Preview',
    blocked_reason: PACK_BLOCKED_REASON.PACK_EXECUTION_NOT_ENABLED,
  }),
  // 18 — Role: Finance
  definePack({
    id: 'role_finance',
    name: 'Finance Role Pack',
    family: PACK_FAMILY.ROLE,
    category: PACK_CATEGORY.PERSONA,
    status: PACK_STATUS.PREVIEW,
    proof_level: PROOF_LEVEL.DESIGN_CONTRACT,
    target_business: 'Finance / accounts persona',
    outcome: 'Finance receivables workspace preview — read-only.',
    included_agents: ['core.owner_briefing', 'core.cost_router'],
    included_workflows: [],
    required_data_sources: ['invoices', 'customers', 'payments'],
    approval_requirements: APPROVAL_OWNER_REVIEW,
    evidence_requirements: EVIDENCE_BASELINE,
    audit_requirements: AUDIT_BASELINE,
    setup_complexity: 'medium',
    automation_depth: 'read_only_preview',
    risk_level: 'low',
    safe_cta: 'Preview',
    blocked_reason: PACK_BLOCKED_REASON.PACK_EXECUTION_NOT_ENABLED,
  }),
  // 19 — Workflow: Owner Briefing (honestly maps to the existing canary preview)
  definePack({
    id: 'workflow_owner_briefing',
    name: 'Owner Briefing Workflow Pack',
    family: PACK_FAMILY.WORKFLOW,
    category: PACK_CATEGORY.OPERATING_MODEL,
    status: PACK_STATUS.LIVE_LIMITED,
    proof_level: PROOF_LEVEL.PRODUCTION_CANARY,
    target_business: 'Owner daily habit loop',
    outcome: 'Read-only owner briefing preview (production canary; not GA; not executable from this registry).',
    included_agents: ['core.owner_briefing'],
    included_workflows: ['workflow.owner_briefing_preview'],
    required_data_sources: ['invoices', 'customers', 'payments'],
    approval_requirements: APPROVAL_OWNER_REVIEW,
    evidence_requirements: EVIDENCE_RAG,
    audit_requirements: AUDIT_BASELINE,
    setup_complexity: 'low',
    automation_depth: 'read_only_preview',
    risk_level: 'low',
    safe_cta: 'Preview',
    blocked_reason: PACK_BLOCKED_REASON.PACK_EXECUTION_NOT_ENABLED,
  }),
  // 20 — Workflow: Collections
  definePack({
    id: 'workflow_collections',
    name: 'Collections Workflow Pack',
    family: PACK_FAMILY.WORKFLOW,
    category: PACK_CATEGORY.OPERATING_MODEL,
    status: PACK_STATUS.PREVIEW,
    proof_level: PROOF_LEVEL.STAGING_PROVEN,
    target_business: 'Collections operations',
    outcome: 'Collections prioritization preview — read-only; no messages sent.',
    included_agents: [],
    included_workflows: [],
    required_data_sources: ['invoices', 'customers', 'payments'],
    approval_requirements: APPROVAL_OWNER_REVIEW,
    evidence_requirements: EVIDENCE_BASELINE,
    audit_requirements: AUDIT_BASELINE,
    setup_complexity: 'medium',
    automation_depth: 'read_only_preview',
    risk_level: 'medium',
    safe_cta: 'View Evidence',
    blocked_reason: PACK_BLOCKED_REASON.PACK_EXECUTION_NOT_ENABLED,
  }),
  // 21 — Agent Swarm: Finance Ops
  definePack({
    id: 'agent_swarm_finance_ops',
    name: 'Finance Operations Agent-Swarm Pack',
    family: PACK_FAMILY.AGENT_SWARM,
    category: PACK_CATEGORY.OPERATING_MODEL,
    status: PACK_STATUS.ROADMAP,
    proof_level: PROOF_LEVEL.NONE,
    target_business: 'Coordinated finance operations',
    outcome: 'Finance-operations agent group — roadmap; not executable here.',
    included_agents: ['core.owner_briefing', 'core.cost_router', 'core.policy_guard'],
    included_workflows: [],
    required_data_sources: ['invoices', 'customers', 'payments'],
    approval_requirements: APPROVAL_CANARY,
    evidence_requirements: [],
    audit_requirements: AUDIT_BASELINE,
    setup_complexity: 'high',
    automation_depth: 'orchestrated_planned',
    risk_level: 'high',
    safe_cta: 'View Requirements',
    blocked_reason: PACK_BLOCKED_REASON.ROADMAP_NOT_BUILT,
  }),
  // 22 — Agent Swarm: Inventory Ops
  definePack({
    id: 'agent_swarm_inventory_ops',
    name: 'Inventory Operations Agent-Swarm Pack',
    family: PACK_FAMILY.AGENT_SWARM,
    category: PACK_CATEGORY.OPERATING_MODEL,
    status: PACK_STATUS.ROADMAP,
    proof_level: PROOF_LEVEL.NONE,
    target_business: 'Coordinated inventory operations',
    outcome: 'Inventory-operations agent group — roadmap; not executable here.',
    included_agents: ['core.data_quality'],
    included_workflows: [],
    required_data_sources: ['inventory', 'invoices'],
    approval_requirements: APPROVAL_CANARY,
    evidence_requirements: [],
    audit_requirements: AUDIT_BASELINE,
    setup_complexity: 'high',
    automation_depth: 'orchestrated_planned',
    risk_level: 'high',
    safe_cta: 'View Requirements',
    blocked_reason: PACK_BLOCKED_REASON.ROADMAP_NOT_BUILT,
  }),
  // 23 — Partner / Custom Deployment Pack
  definePack({
    id: 'partner_custom_deployment',
    name: 'Partner / Custom Deployment Pack',
    family: PACK_FAMILY.PARTNER_CUSTOM_DEPLOYMENT,
    category: PACK_CATEGORY.DEPLOYMENT,
    status: PACK_STATUS.PARTNER_REQUIRED,
    proof_level: PROOF_LEVEL.DESIGN_CONTRACT,
    target_business: 'Partner / bespoke deployments',
    outcome: 'Partner-delivered deployment — requires partner approval and a signed contract.',
    included_agents: [],
    included_workflows: [],
    required_data_sources: [],
    approval_requirements: APPROVAL_CANARY,
    evidence_requirements: EVIDENCE_BASELINE,
    audit_requirements: AUDIT_BASELINE,
    setup_complexity: 'high',
    automation_depth: 'supervised_planned',
    risk_level: 'high',
    safe_cta: 'Requires Approval',
    blocked_reason: PACK_BLOCKED_REASON.PARTNER_DEPLOYMENT_REQUIRED,
  }),
]);

module.exports = {
  PACK_REGISTRY_VERSION,
  PACK_STATUS,
  ALLOWED_PACK_STATUSES,
  PACK_FAMILY,
  ALLOWED_PACK_FAMILIES,
  PACK_CATEGORY,
  ALLOWED_PACK_CATEGORIES,
  PROOF_LEVEL,
  ALLOWED_PROOF_LEVELS,
  ALLOWED_SAFE_CTAS,
  FORBIDDEN_CTAS,
  PACK_BLOCKED_REASON,
  ALLOWED_SETUP_COMPLEXITY,
  ALLOWED_AUTOMATION_DEPTH,
  ALLOWED_RISK_LEVEL,
  REQUIRED_PACK_FIELDS,
  BLOCKED_ACTIONS,
  PACKS,
};
