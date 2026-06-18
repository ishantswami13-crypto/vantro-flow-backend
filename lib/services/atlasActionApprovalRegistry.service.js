// FILE: lib/services/atlasActionApprovalRegistry.service.js
// ─────────────────────────────────────────────────────────────────────────────
// Atlas Action Approval Registry service (Phase 2C.30).
//
// Builds a READ-ONLY honest snapshot of the approval-REQUIREMENT contracts from the
// static registry in lib/config/atlasActionApprovalRegistry.js.
//
// SAFETY:
//   - No DB. No network. No filesystem. No env reads. No background jobs. No startup
//     side effects. Deterministic.
//   - This Phase 2C.30 service makes no approval decision and creates no approval record;
//     it runs no action and never approves/rejects/requests/executes/activates/sends/syncs/deploys.
//   - Each call returns FRESH copies (new objects + sliced arrays) projected from the
//     frozen source, so mutating a returned value cannot alter the source registry or
//     any future response.
//   - Emits enums / counts / booleans / labels / generic role labels only — never
//     secrets, env values, tokens, approver identities, customer ids, or PII.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const {
  ACTION_APPROVAL_VERSION,
  ALLOWED_ACTION_CLASSES,
  ALLOWED_STATUSES,
  ALLOWED_PROOF_LEVELS,
  ALLOWED_RISK_LEVELS,
  ALLOWED_APPROVAL_MODES,
  ALLOWED_EXTERNAL_EFFECT_TYPES,
  ALLOWED_APPROVER_ROLES,
  ALLOWED_SAFE_CTAS,
  FORBIDDEN_CTAS,
  BLOCKED_ACTIONS,
  REQUIRED_CONTRACT_FIELDS,
  CONTRACTS,
} = require('../config/atlasActionApprovalRegistry');

// Project a fresh, plain (non-frozen) copy with sliced arrays. The five safety
// booleans are coerced hard-false. Mutating the result never affects the source.
function publicContract(c) {
  return {
    id: c.id,
    name: c.name,
    action_class: c.action_class,
    risk_level: c.risk_level,
    status: c.status,
    proof_level: c.proof_level,
    approval_required: c.approval_required === true,
    approval_mode: c.approval_mode,
    minimum_approvers: typeof c.minimum_approvers === 'number' ? c.minimum_approvers : 0,
    allowed_approver_roles: Array.isArray(c.allowed_approver_roles) ? c.allowed_approver_roles.slice() : [],
    separation_of_duties_required: c.separation_of_duties_required === true,
    evidence_required: c.evidence_required === true,
    audit_required: c.audit_required === true,
    reason_required: c.reason_required === true,
    expiry_required: c.expiry_required === true,
    related_packs: Array.isArray(c.related_packs) ? c.related_packs.slice() : [],
    related_agents: Array.isArray(c.related_agents) ? c.related_agents.slice() : [],
    related_workflows: Array.isArray(c.related_workflows) ? c.related_workflows.slice() : [],
    external_effect_type: c.external_effect_type,
    execution_allowed: c.execution_allowed === true,            // never true in this phase
    activation_allowed: c.activation_allowed === true,          // never true in this phase
    production_allowed: c.production_allowed === true,          // never true in this phase
    external_send_allowed: c.external_send_allowed === true,    // never true in this phase
    automatic_approval_allowed: c.automatic_approval_allowed === true, // never true in this phase
    limitations: Array.isArray(c.limitations) ? c.limitations.slice() : [],
    blocked_reason: c.blocked_reason || null,
    safe_cta: c.safe_cta,
  };
}

/** @returns {Array<object>} every approval contract as a fresh safe copy. */
function listAtlasActionApprovalContracts() {
  return CONTRACTS.map(publicContract);
}

/**
 * @param {string} id contract id
 * @returns {object|null} fresh safe copy, or null if unknown.
 */
function getAtlasActionApprovalContractById(id) {
  if (typeof id !== 'string' || !id) return null;
  const c = CONTRACTS.find((x) => x.id === id);
  return c ? publicContract(c) : null;
}

function countBy(items, key) {
  const counts = {};
  for (const it of items) {
    const v = it[key];
    if (typeof v === 'string' && v) counts[v] = (counts[v] || 0) + 1;
  }
  return counts;
}

/**
 * Counts/booleans-only summary describing Phase 2C.30 approval REQUIREMENTS.
 * This phase operates no approval queue and records no granted approval.
 * @returns {object}
 */
function summarizeAtlasActionApprovalContracts() {
  const contracts = listAtlasActionApprovalContracts();
  return {
    counts_are_requirements_not_operational_records: true,
    contracts_total: contracts.length,
    action_classes_total: ALLOWED_ACTION_CLASSES.length,
    approval_required_count: contracts.filter((c) => c.approval_required === true).length,
    no_approval_required_count: contracts.filter((c) => c.approval_required === false).length,
    blocked_count: contracts.filter((c) => c.approval_mode === 'blocked' || c.status === 'disabled').length,
    separation_of_duties_count: contracts.filter((c) => c.separation_of_duties_required === true).length,
    // hard-zero safety counts
    execution_allowed_count: contracts.filter((c) => c.execution_allowed === true).length,
    activation_allowed_count: contracts.filter((c) => c.activation_allowed === true).length,
    production_allowed_count: contracts.filter((c) => c.production_allowed === true).length,
    external_send_allowed_count: contracts.filter((c) => c.external_send_allowed === true).length,
    automatic_approval_allowed_count: contracts.filter((c) => c.automatic_approval_allowed === true).length,
    by_action_class: countBy(contracts, 'action_class'),
    by_risk_level: countBy(contracts, 'risk_level'),
    by_approval_mode: countBy(contracts, 'approval_mode'),
    by_status: countBy(contracts, 'status'),
    blocked_actions: BLOCKED_ACTIONS.slice(),
  };
}

/**
 * Independent validation used by the checker/tests. Pure — returns offenders, never
 * throws. ok === true means every contract honors every invariant.
 * @returns {{ok: boolean, offenders: object}}
 */
function validateActionApprovalRegistry() {
  const bad_action_class = [];
  const bad_risk = [];
  const bad_status = [];
  const bad_proof = [];
  const bad_mode = [];
  const bad_effect = [];
  const bad_role = [];
  const bad_cta = [];
  const forbidden_cta = [];
  const missing_fields = [];
  const duplicate_ids = [];
  const executable = [];
  const activatable = [];
  const production = [];
  const external_send = [];
  const auto_approval = [];
  const approval_inconsistent = [];
  const approver_count_inconsistent = [];
  const role_inconsistent = [];
  const sod_inconsistent = [];

  const lowerForbidden = FORBIDDEN_CTAS.map((c) => c.toLowerCase());
  const seen = new Set();
  for (const c of CONTRACTS) {
    if (seen.has(c.id)) duplicate_ids.push(c.id); else seen.add(c.id);
    if (!ALLOWED_ACTION_CLASSES.includes(c.action_class)) bad_action_class.push(c.id);
    if (!ALLOWED_RISK_LEVELS.includes(c.risk_level)) bad_risk.push(c.id);
    if (!ALLOWED_STATUSES.includes(c.status)) bad_status.push(c.id);
    if (!ALLOWED_PROOF_LEVELS.includes(c.proof_level)) bad_proof.push(c.id);
    if (!ALLOWED_APPROVAL_MODES.includes(c.approval_mode)) bad_mode.push(c.id);
    if (!ALLOWED_EXTERNAL_EFFECT_TYPES.includes(c.external_effect_type)) bad_effect.push(c.id);
    if (!c.allowed_approver_roles.every((r) => ALLOWED_APPROVER_ROLES.includes(r))) bad_role.push(c.id);
    if (!ALLOWED_SAFE_CTAS.includes(c.safe_cta)) bad_cta.push(c.id);
    if (typeof c.safe_cta === 'string' && lowerForbidden.some((f) => c.safe_cta.toLowerCase() === f)) forbidden_cta.push(c.id);
    for (const f of REQUIRED_CONTRACT_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(c, f) || c[f] === undefined) missing_fields.push(c.id + ':' + f);
    }
    if (c.execution_allowed === true) executable.push(c.id);
    if (c.activation_allowed === true) activatable.push(c.id);
    if (c.production_allowed === true) production.push(c.id);
    if (c.external_send_allowed === true) external_send.push(c.id);
    if (c.automatic_approval_allowed === true) auto_approval.push(c.id);
    // approval_required ⇔ mode/approver/role consistency
    if (c.approval_required === true && (c.approval_mode === 'none' || c.minimum_approvers < 1)) approval_inconsistent.push(c.id);
    if (c.approval_required === false && (c.approval_mode !== 'none' || c.minimum_approvers !== 0)) approval_inconsistent.push(c.id);
    if (c.approval_required === true && c.allowed_approver_roles.length === 0) role_inconsistent.push(c.id);
    if (c.approval_required === false && c.allowed_approver_roles.length !== 0) role_inconsistent.push(c.id);
    if (c.separation_of_duties_required === true && c.minimum_approvers < 2) sod_inconsistent.push(c.id);
    if ((c.approval_mode === 'dual_human') && c.minimum_approvers < 2) approver_count_inconsistent.push(c.id);
  }

  const offenders = {
    bad_action_class, bad_risk, bad_status, bad_proof, bad_mode, bad_effect, bad_role,
    bad_cta, forbidden_cta, missing_fields, duplicate_ids, executable, activatable,
    production, external_send, auto_approval, approval_inconsistent,
    approver_count_inconsistent, role_inconsistent, sod_inconsistent,
  };
  const ok = Object.values(offenders).every((arr) => arr.length === 0);
  return { ok, offenders };
}

/**
 * Build the full read-only Action Approval truth object.
 * @param {object} [opts]
 * @param {string} [opts.generatedAt] caller-supplied ISO timestamp (for testability)
 * @returns {object}
 */
function buildAtlasActionApprovalTruth(opts = {}) {
  const generatedAt =
    typeof opts.generatedAt === 'string' && opts.generatedAt
      ? opts.generatedAt
      : new Date().toISOString();

  const contracts = listAtlasActionApprovalContracts();
  const summary = summarizeAtlasActionApprovalContracts();

  return {
    platform: 'atlas',
    layer: 'atlas_action_approval_contract_layer',
    contract: 'read_only_action_approval_requirement_truth',
    environment: 'safe_redacted',
    action_approval_version: ACTION_APPROVAL_VERSION,
    generated_at: generatedAt,

    // Safety posture — hard-false by design in this phase.
    read_only: true,
    execution_enabled: false,
    activation_enabled: false,
    production_enabled: false,
    external_send_enabled: false,
    automatic_approval_enabled: false,

    // Honesty posture — SCOPED to Phase 2C.30 only. These booleans describe what THIS
    // phase does/does not introduce; they are NOT platform-wide absence claims (the legacy
    // AI Action Center and ai_actions storage are separate, pre-existing systems).
    phase_scope: {
      phase: '2C.30',
      contract_registry_only: true,
      approval_records_created_by_this_phase: false,
      approval_queue_operated_by_this_phase: false,
      human_approval_granted_by_this_phase: false,
      execution_after_approval_enabled_by_this_phase: false,
      policy_guard_treated_as_human_approval_by_this_phase: false,
    },
    // Legacy compatibility acknowledgement — separate, pre-existing, unchanged by 2C.30.
    legacy_ai_action_center_separate_and_unchanged: true,
    legacy_ai_actions_table_separate_and_unchanged: true,

    summary,
    contracts,
    blocked_actions: BLOCKED_ACTIONS.slice(),

    notes: [
      'Phase 2C.30 is an approval-REQUIREMENT registry only: it describes what approval would be required.',
      'Phase 2C.30 creates no approval records and operates no approval queue.',
      'This read-only contract does not grant human approval and introduces no execution-after-approval capability.',
      'For Phase 2C.30, approval_required does not imply execution availability; this phase performs no execution.',
      'policy guard is automated policy enforcement; this phase does not treat it as human approval.',
      'The existing legacy AI Action Center (/api/ai-actions/*) and ai_actions storage are separate, pre-existing systems that Phase 2C.30 neither modifies nor relies on.',
      'Their existence is not evidence that this Phase 2C.30 registry provides human-approval enforcement.',
      'Owner approval and canary scope remain absent (Phase 2C.25); production and canary remain blocked.',
      'For every contract in this phase, execution/activation/production/external-send are false and automatic approvals are zero.',
      'Phase 2C.31 will add evidence-contract truth; Phase 2C.32 will consolidate launch truth.',
    ],
  };
}

module.exports = {
  buildAtlasActionApprovalTruth,
  listAtlasActionApprovalContracts,
  getAtlasActionApprovalContractById,
  summarizeAtlasActionApprovalContracts,
  validateActionApprovalRegistry,
  REQUIRED_CONTRACT_FIELDS,
};
