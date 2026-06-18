// FILE: lib/config/atlasActionApprovalRegistry.js
// ─────────────────────────────────────────────────────────────────────────────
// Atlas Action Approval Registry — static, honest, READ-ONLY approval-REQUIREMENT
// truth (Phase 2C.30).
//
// PURPOSE
//   Describes, per action class, what approval WOULD be required before an action
//   could ever run. It is a TRUTH MODEL of approval REQUIREMENTS — it does NOT
//   request, grant, deny, record, queue, or execute approvals, and it is NOT a claim
//   that human-in-the-loop enforcement is live or that an operational approval queue
//   exists. The real (operational) action surface is the pre-existing AI Action
//   Center (`/api/ai-actions/*`, `ai_actions` table) which this phase does NOT touch.
//
// HARD INVARIANTS (enforced by scripts/phase-2c-30-atlas-action-approval-check.js):
//   - execution_allowed / activation_allowed / production_allowed /
//     external_send_allowed / automatic_approval_allowed = false for EVERY contract.
//   - approval_required is true for every mutating / external / activation / financial
//     / export / override class; only read_only_analysis is approval_required:false
//     (and even it stays non-executable).
//   - production_sync and deployment_change remain BLOCKED.
//   - policy_override requires human approval AND separation of duties.
//   - related_packs/agents/workflows reference ONLY canonical 2C.26/2C.28/2C.27 ids.
//
// THIS FILE IS PURE STATIC DATA. NO secrets, DB URLs, env values, tokens, approver
// identities, customer PII, or raw row data — only ids, names, labels, enums, counts,
// booleans, and generic role labels.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const ACTION_APPROVAL_VERSION = '2C.30';

// ── ACTION CLASS ENUM — the 12 represented action classes ──────────────────────
const ACTION_CLASS = Object.freeze({
  READ_ONLY_ANALYSIS: 'read_only_analysis',
  BUSINESS_RECORD_MUTATION: 'business_record_mutation',
  FINANCIAL_COMMITMENT: 'financial_commitment',
  EXTERNAL_COMMUNICATION: 'external_communication',
  CUSTOMER_DATA_EXPORT: 'customer_data_export',
  WORKFLOW_ACTIVATION: 'workflow_activation',
  AGENT_ACTIVATION: 'agent_activation',
  PRODUCTION_SYNC: 'production_sync',
  CONFIGURATION_CHANGE: 'configuration_change',
  POLICY_OVERRIDE: 'policy_override',
  DEPLOYMENT_CHANGE: 'deployment_change',
  PARTNER_CUSTOM_AUTOMATION: 'partner_custom_automation',
});
const ALLOWED_ACTION_CLASSES = Object.freeze(Object.values(ACTION_CLASS));

// ── shared status / proof enums (consistent with prior Atlas registries) ───────
const STATUS = Object.freeze({
  LIVE_PROVEN: 'live_proven', LIVE_LIMITED: 'live_limited', PREVIEW: 'preview',
  CONNECTOR_REQUIRED: 'connector_required', CUSTOM_REQUIRED: 'custom_required',
  PARTNER_REQUIRED: 'partner_required', ROADMAP: 'roadmap', DISABLED: 'disabled',
});
const ALLOWED_STATUSES = Object.freeze(Object.values(STATUS));

const PROOF_LEVEL = Object.freeze({
  NONE: 'none', DESIGN_CONTRACT: 'design_contract', STAGING_PROVEN: 'staging_proven', PRODUCTION_CANARY: 'production_canary',
});
const ALLOWED_PROOF_LEVELS = Object.freeze(Object.values(PROOF_LEVEL));

const ALLOWED_RISK_LEVELS = Object.freeze(['low', 'medium', 'high', 'critical']);

// ── APPROVAL MODE ENUM ─────────────────────────────────────────────────────────
const APPROVAL_MODE = Object.freeze({
  NONE: 'none',                 // no approval required (read-only)
  SINGLE_HUMAN: 'single_human', // one human approver
  DUAL_HUMAN: 'dual_human',     // two human approvers (separation of duties)
  BLOCKED: 'blocked',           // not permitted regardless of approval
});
const ALLOWED_APPROVAL_MODES = Object.freeze(Object.values(APPROVAL_MODE));

// ── EXTERNAL EFFECT TYPE ENUM ──────────────────────────────────────────────────
const EXTERNAL_EFFECT_TYPE = Object.freeze({
  NONE: 'none', INTERNAL_RECORD: 'internal_record', FINANCIAL: 'financial',
  EXTERNAL_MESSAGE: 'external_message', DATA_EXPORT: 'data_export', CONFIGURATION: 'configuration',
  PRODUCTION: 'production', DEPLOYMENT: 'deployment', CUSTOM: 'custom',
});
const ALLOWED_EXTERNAL_EFFECT_TYPES = Object.freeze(Object.values(EXTERNAL_EFFECT_TYPE));

// ── APPROVER ROLE ENUM — generic role labels ONLY (never real identities) ──────
const APPROVER_ROLE = Object.freeze({
  OWNER: 'owner', FINANCE_APPROVER: 'finance_approver', SECURITY_APPROVER: 'security_approver',
  ADMIN: 'admin', PARTNER: 'partner',
});
const ALLOWED_APPROVER_ROLES = Object.freeze(Object.values(APPROVER_ROLE));

// ── BLOCKED REASON ENUM (documentation only) ───────────────────────────────────
const APPROVAL_BLOCKED_REASON = Object.freeze({
  APPROVAL_NOT_REQUIRED_READ_ONLY: 'approval_not_required_read_only',
  HUMAN_APPROVAL_REQUIRED: 'human_approval_required',
  HUMAN_APPROVAL_AND_SOD_REQUIRED: 'human_approval_and_sod_required',
  PRODUCTION_BLOCKED: 'production_blocked',
  DEPLOYMENT_BLOCKED: 'deployment_blocked',
  PARTNER_AND_HUMAN_APPROVAL_REQUIRED: 'partner_and_human_approval_required',
});

// ── SAFE CTA allowlist (read-only) ─────────────────────────────────────────────
const ALLOWED_SAFE_CTAS = Object.freeze(['View Requirements', 'Requires Approval', 'View Evidence', 'Preview']);

// ── FORBIDDEN CTA — approval/execution-implying labels that must NEVER appear ──
const FORBIDDEN_CTAS = Object.freeze([
  'Approve', 'Reject', 'Request Approval', 'Decide', 'Run Now', 'Execute',
  'Activate', 'Send', 'Sync Production', 'Deploy',
]);

// ── BLOCKED ACTIONS — what this registry refuses to do / claim ─────────────────
const BLOCKED_ACTIONS = Object.freeze([
  'approval_record_creation', 'approval_decision', 'approve', 'reject', 'request_approval',
  'agent_execution', 'agent_activation', 'workflow_activation', 'external_sending',
  'production_sync', 'deploy', 'automatic_approval',
  'human_in_the_loop_enforcement_live_claim', 'operational_approval_queue_claim',
  'human_approval_granted_claim', 'execution_after_approval_claim',
]);

const REQUIRED_CONTRACT_FIELDS = Object.freeze([
  'id', 'name', 'action_class', 'risk_level', 'status', 'proof_level',
  'approval_required', 'approval_mode', 'minimum_approvers', 'allowed_approver_roles',
  'separation_of_duties_required', 'evidence_required', 'audit_required', 'reason_required',
  'expiry_required', 'related_packs', 'related_agents', 'related_workflows',
  'external_effect_type', 'execution_allowed', 'activation_allowed', 'production_allowed',
  'external_send_allowed', 'automatic_approval_allowed', 'limitations', 'blocked_reason', 'safe_cta',
]);

const AUDIT_BASELINE = ['audit_user_resolved', 'counts_booleans_only_no_pii', 'no_raw_row_data'];
const EVIDENCE_BASELINE = ['staging_proof', 'rag_evidence_contract'];

const R = APPROVER_ROLE;
const RB = APPROVAL_BLOCKED_REASON;

// defineContract() FORCES the five safety booleans false regardless of input — this
// registry can never mark an action executable, activatable, production-enabled,
// external-send-capable, or auto-approvable.
function defineContract(c) {
  return Object.freeze({
    id: c.id,
    name: c.name,
    action_class: c.action_class,
    risk_level: c.risk_level,
    status: c.status,
    proof_level: c.proof_level,
    approval_required: c.approval_required === true,
    approval_mode: c.approval_mode,
    minimum_approvers: typeof c.minimum_approvers === 'number' ? c.minimum_approvers : 0,
    allowed_approver_roles: Object.freeze((c.allowed_approver_roles || []).slice()),
    separation_of_duties_required: c.separation_of_duties_required === true,
    evidence_required: c.evidence_required === true,
    audit_required: c.audit_required === true,
    reason_required: c.reason_required === true,
    expiry_required: c.expiry_required === true,
    related_packs: Object.freeze((c.related_packs || []).slice()),
    related_agents: Object.freeze((c.related_agents || []).slice()),
    related_workflows: Object.freeze((c.related_workflows || []).slice()),
    external_effect_type: c.external_effect_type,
    execution_allowed: false,          // HARD INVARIANT
    activation_allowed: false,         // HARD INVARIANT
    production_allowed: false,         // HARD INVARIANT
    external_send_allowed: false,      // HARD INVARIANT
    automatic_approval_allowed: false, // HARD INVARIANT
    limitations: Object.freeze((c.limitations || []).slice()),
    blocked_reason: c.blocked_reason,
    safe_cta: c.safe_cta,
  });
}

const AC = ACTION_CLASS;
const AM = APPROVAL_MODE;
const EE = EXTERNAL_EFFECT_TYPE;

// ── THE APPROVAL CONTRACTS — one per action class (12) ─────────────────────────
const CONTRACTS = Object.freeze([
  // 1 — Read-only analysis (the ONLY no-approval class; still non-executable)
  defineContract({
    id: 'approval.read_only_analysis',
    name: 'Read-Only Analysis',
    action_class: AC.READ_ONLY_ANALYSIS,
    risk_level: 'low',
    status: STATUS.PREVIEW,
    proof_level: PROOF_LEVEL.DESIGN_CONTRACT,
    approval_required: false,
    approval_mode: AM.NONE,
    minimum_approvers: 0,
    allowed_approver_roles: [],
    separation_of_duties_required: false,
    evidence_required: false,
    audit_required: true,
    reason_required: false,
    expiry_required: false,
    related_packs: ['global_core'],
    related_agents: ['core.owner_briefing'],
    related_workflows: ['workflow_daily_command_briefing'],
    external_effect_type: EE.NONE,
    limitations: ['read_only', 'no_execution', 'no_external_effect'],
    blocked_reason: RB.APPROVAL_NOT_REQUIRED_READ_ONLY,
    safe_cta: 'Preview',
  }),
  // 2 — Business-record mutation
  defineContract({
    id: 'approval.business_record_mutation',
    name: 'Business Record Mutation',
    action_class: AC.BUSINESS_RECORD_MUTATION,
    risk_level: 'medium',
    status: STATUS.PREVIEW,
    proof_level: PROOF_LEVEL.DESIGN_CONTRACT,
    approval_required: true,
    approval_mode: AM.SINGLE_HUMAN,
    minimum_approvers: 1,
    allowed_approver_roles: [R.OWNER],
    separation_of_duties_required: false,
    evidence_required: true,
    audit_required: true,
    reason_required: true,
    expiry_required: true,
    related_packs: ['workflow_collections'],
    related_agents: ['collections.priority_review'],
    related_workflows: ['workflow_collections_review'],
    external_effect_type: EE.INTERNAL_RECORD,
    limitations: ['requires_explicit_human_approval', 'no_execution', 'no_auto_approval'],
    blocked_reason: RB.HUMAN_APPROVAL_REQUIRED,
    safe_cta: 'Requires Approval',
  }),
  // 3 — Financial commitment
  defineContract({
    id: 'approval.financial_commitment',
    name: 'Financial Commitment',
    action_class: AC.FINANCIAL_COMMITMENT,
    risk_level: 'high',
    status: STATUS.PREVIEW,
    proof_level: PROOF_LEVEL.DESIGN_CONTRACT,
    approval_required: true,
    approval_mode: AM.DUAL_HUMAN,
    minimum_approvers: 2,
    allowed_approver_roles: [R.OWNER, R.FINANCE_APPROVER],
    separation_of_duties_required: true,
    evidence_required: true,
    audit_required: true,
    reason_required: true,
    expiry_required: true,
    related_packs: ['role_finance'],
    related_agents: ['finance.cashflow_risk'],
    related_workflows: ['workflow_cashflow_risk_review'],
    external_effect_type: EE.FINANCIAL,
    limitations: ['requires_explicit_human_approval', 'separation_of_duties', 'no_execution', 'no_auto_approval'],
    blocked_reason: RB.HUMAN_APPROVAL_AND_SOD_REQUIRED,
    safe_cta: 'Requires Approval',
  }),
  // 4 — External communication (drafts only; no external send)
  defineContract({
    id: 'approval.external_communication',
    name: 'External Communication',
    action_class: AC.EXTERNAL_COMMUNICATION,
    risk_level: 'high',
    status: STATUS.PREVIEW,
    proof_level: PROOF_LEVEL.DESIGN_CONTRACT,
    approval_required: true,
    approval_mode: AM.SINGLE_HUMAN,
    minimum_approvers: 1,
    allowed_approver_roles: [R.OWNER],
    separation_of_duties_required: false,
    evidence_required: true,
    audit_required: true,
    reason_required: true,
    expiry_required: true,
    related_packs: ['global_core'],
    related_agents: ['core.policy_guard'],
    related_workflows: ['workflow_actions_approval_review'],
    external_effect_type: EE.EXTERNAL_MESSAGE,
    limitations: ['requires_explicit_human_approval', 'external_send_blocked', 'drafts_only', 'no_auto_approval'],
    blocked_reason: RB.HUMAN_APPROVAL_REQUIRED,
    safe_cta: 'Requires Approval',
  }),
  // 5 — Customer-data export
  defineContract({
    id: 'approval.customer_data_export',
    name: 'Customer Data Export',
    action_class: AC.CUSTOMER_DATA_EXPORT,
    risk_level: 'high',
    status: STATUS.PREVIEW,
    proof_level: PROOF_LEVEL.DESIGN_CONTRACT,
    approval_required: true,
    approval_mode: AM.DUAL_HUMAN,
    minimum_approvers: 2,
    allowed_approver_roles: [R.OWNER, R.SECURITY_APPROVER],
    separation_of_duties_required: true,
    evidence_required: true,
    audit_required: true,
    reason_required: true,
    expiry_required: true,
    related_packs: ['global_core'],
    related_agents: ['core.data_quality'],
    related_workflows: ['workflow_data_source_readiness'],
    external_effect_type: EE.DATA_EXPORT,
    limitations: ['requires_explicit_human_approval', 'separation_of_duties', 'no_pii_in_contract', 'no_auto_approval'],
    blocked_reason: RB.HUMAN_APPROVAL_AND_SOD_REQUIRED,
    safe_cta: 'Requires Approval',
  }),
  // 6 — Workflow activation
  defineContract({
    id: 'approval.workflow_activation',
    name: 'Workflow Activation',
    action_class: AC.WORKFLOW_ACTIVATION,
    risk_level: 'medium',
    status: STATUS.PREVIEW,
    proof_level: PROOF_LEVEL.DESIGN_CONTRACT,
    approval_required: true,
    approval_mode: AM.SINGLE_HUMAN,
    minimum_approvers: 1,
    allowed_approver_roles: [R.OWNER],
    separation_of_duties_required: false,
    evidence_required: true,
    audit_required: true,
    reason_required: true,
    expiry_required: true,
    related_packs: ['global_core'],
    related_agents: ['packs.pack_recommendation'],
    related_workflows: ['workflow_pack_activation_request'],
    external_effect_type: EE.CONFIGURATION,
    limitations: ['requires_explicit_human_approval', 'activation_blocked', 'no_auto_approval'],
    blocked_reason: RB.HUMAN_APPROVAL_REQUIRED,
    safe_cta: 'Requires Approval',
  }),
  // 7 — Agent activation
  defineContract({
    id: 'approval.agent_activation',
    name: 'Agent Activation',
    action_class: AC.AGENT_ACTIVATION,
    risk_level: 'medium',
    status: STATUS.PREVIEW,
    proof_level: PROOF_LEVEL.DESIGN_CONTRACT,
    approval_required: true,
    approval_mode: AM.SINGLE_HUMAN,
    minimum_approvers: 1,
    allowed_approver_roles: [R.OWNER],
    separation_of_duties_required: false,
    evidence_required: true,
    audit_required: true,
    reason_required: true,
    expiry_required: true,
    related_packs: ['global_core'],
    related_agents: ['core.owner_briefing'],
    related_workflows: ['workflow_owner_briefing_preview'],
    external_effect_type: EE.CONFIGURATION,
    limitations: ['requires_explicit_human_approval', 'activation_blocked', 'no_auto_approval'],
    blocked_reason: RB.HUMAN_APPROVAL_REQUIRED,
    safe_cta: 'Requires Approval',
  }),
  // 8 — Production sync (BLOCKED)
  defineContract({
    id: 'approval.production_sync',
    name: 'Production Sync',
    action_class: AC.PRODUCTION_SYNC,
    risk_level: 'critical',
    status: STATUS.DISABLED,
    proof_level: PROOF_LEVEL.NONE,
    approval_required: true,
    approval_mode: AM.BLOCKED,
    minimum_approvers: 2,
    allowed_approver_roles: [R.OWNER, R.SECURITY_APPROVER],
    separation_of_duties_required: true,
    evidence_required: true,
    audit_required: true,
    reason_required: true,
    expiry_required: true,
    related_packs: [],
    related_agents: [],
    related_workflows: ['workflow_neon_to_cortex_dry_run'],
    external_effect_type: EE.PRODUCTION,
    limitations: ['production_blocked', 'no_execution', 'no_auto_approval', 'separation_of_duties'],
    blocked_reason: RB.PRODUCTION_BLOCKED,
    safe_cta: 'View Requirements',
  }),
  // 9 — Configuration change
  defineContract({
    id: 'approval.configuration_change',
    name: 'Configuration Change',
    action_class: AC.CONFIGURATION_CHANGE,
    risk_level: 'medium',
    status: STATUS.CUSTOM_REQUIRED,
    proof_level: PROOF_LEVEL.DESIGN_CONTRACT,
    approval_required: true,
    approval_mode: AM.SINGLE_HUMAN,
    minimum_approvers: 1,
    allowed_approver_roles: [R.OWNER, R.ADMIN],
    separation_of_duties_required: false,
    evidence_required: true,
    audit_required: true,
    reason_required: true,
    expiry_required: true,
    related_packs: ['custom_pack'],
    related_agents: ['custom.operating_model_designer'],
    related_workflows: ['workflow_custom_pack_design'],
    external_effect_type: EE.CONFIGURATION,
    limitations: ['requires_explicit_human_approval', 'no_execution', 'no_auto_approval'],
    blocked_reason: RB.HUMAN_APPROVAL_REQUIRED,
    safe_cta: 'Requires Approval',
  }),
  // 10 — Policy override (human approval AND separation of duties)
  defineContract({
    id: 'approval.policy_override',
    name: 'Policy Override',
    action_class: AC.POLICY_OVERRIDE,
    risk_level: 'critical',
    status: STATUS.PREVIEW,
    proof_level: PROOF_LEVEL.DESIGN_CONTRACT,
    approval_required: true,
    approval_mode: AM.DUAL_HUMAN,
    minimum_approvers: 2,
    allowed_approver_roles: [R.OWNER, R.SECURITY_APPROVER],
    separation_of_duties_required: true,
    evidence_required: true,
    audit_required: true,
    reason_required: true,
    expiry_required: true,
    related_packs: ['global_core'],
    related_agents: ['core.policy_guard'],
    related_workflows: ['workflow_actions_approval_review'],
    external_effect_type: EE.CONFIGURATION,
    limitations: ['requires_explicit_human_approval', 'separation_of_duties', 'no_auto_approval', 'policy_guard_is_not_human_approval'],
    blocked_reason: RB.HUMAN_APPROVAL_AND_SOD_REQUIRED,
    safe_cta: 'Requires Approval',
  }),
  // 11 — Deployment change (BLOCKED)
  defineContract({
    id: 'approval.deployment_change',
    name: 'Deployment Change',
    action_class: AC.DEPLOYMENT_CHANGE,
    risk_level: 'critical',
    status: STATUS.DISABLED,
    proof_level: PROOF_LEVEL.NONE,
    approval_required: true,
    approval_mode: AM.BLOCKED,
    minimum_approvers: 2,
    allowed_approver_roles: [R.OWNER, R.PARTNER],
    separation_of_duties_required: true,
    evidence_required: true,
    audit_required: true,
    reason_required: true,
    expiry_required: true,
    related_packs: ['partner_custom_deployment'],
    related_agents: ['partner.deployment_planner'],
    related_workflows: ['workflow_partner_deployment_review'],
    external_effect_type: EE.DEPLOYMENT,
    limitations: ['deployment_blocked', 'no_execution', 'no_auto_approval', 'separation_of_duties'],
    blocked_reason: RB.DEPLOYMENT_BLOCKED,
    safe_cta: 'View Requirements',
  }),
  // 12 — Partner custom automation
  defineContract({
    id: 'approval.partner_custom_automation',
    name: 'Partner Custom Automation',
    action_class: AC.PARTNER_CUSTOM_AUTOMATION,
    risk_level: 'high',
    status: STATUS.PARTNER_REQUIRED,
    proof_level: PROOF_LEVEL.DESIGN_CONTRACT,
    approval_required: true,
    approval_mode: AM.DUAL_HUMAN,
    minimum_approvers: 2,
    allowed_approver_roles: [R.OWNER, R.PARTNER],
    separation_of_duties_required: true,
    evidence_required: true,
    audit_required: true,
    reason_required: true,
    expiry_required: true,
    related_packs: ['partner_custom_deployment'],
    related_agents: ['partner.deployment_planner'],
    related_workflows: ['workflow_partner_deployment_review'],
    external_effect_type: EE.CUSTOM,
    limitations: ['requires_explicit_human_approval', 'requires_partner_approval', 'separation_of_duties', 'no_auto_approval'],
    blocked_reason: RB.PARTNER_AND_HUMAN_APPROVAL_REQUIRED,
    safe_cta: 'Requires Approval',
  }),
]);

module.exports = {
  ACTION_APPROVAL_VERSION,
  ACTION_CLASS,
  ALLOWED_ACTION_CLASSES,
  STATUS,
  ALLOWED_STATUSES,
  PROOF_LEVEL,
  ALLOWED_PROOF_LEVELS,
  ALLOWED_RISK_LEVELS,
  APPROVAL_MODE,
  ALLOWED_APPROVAL_MODES,
  EXTERNAL_EFFECT_TYPE,
  ALLOWED_EXTERNAL_EFFECT_TYPES,
  APPROVER_ROLE,
  ALLOWED_APPROVER_ROLES,
  APPROVAL_BLOCKED_REASON,
  ALLOWED_SAFE_CTAS,
  FORBIDDEN_CTAS,
  BLOCKED_ACTIONS,
  REQUIRED_CONTRACT_FIELDS,
  CONTRACTS,
};
