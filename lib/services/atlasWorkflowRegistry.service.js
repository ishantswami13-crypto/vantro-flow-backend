// FILE: lib/services/atlasWorkflowRegistry.service.js
// ─────────────────────────────────────────────────────────────────────────────
// Atlas Workflow Registry service (Phase 2C.27).
//
// Builds a READ-ONLY honest snapshot of the Atlas business-process (workflow) layer
// from the static registry in lib/config/atlasWorkflowRegistry.js.
//
// SAFETY:
//   - No DB access. No network. No filesystem. No env reads. No mutations.
//   - Triggers NO execution and NO activation of any workflow; no production sync,
//     no external send, no DB write, no background job.
//   - Emits counts / booleans / status / labels only — never secrets, DB URLs,
//     env values, tokens, customer PII, emails, phones, invoice details, or raw
//     row data.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const {
  WORKFLOW_REGISTRY_VERSION,
  ALLOWED_WORKFLOW_STATUSES,
  ALLOWED_WORKFLOW_DOMAINS,
  ALLOWED_WORKFLOW_CATEGORIES,
  ALLOWED_PROOF_LEVELS,
  ALLOWED_SAFE_CTAS,
  FORBIDDEN_CTAS,
  ALLOWED_SETUP_COMPLEXITY,
  ALLOWED_AUTOMATION_DEPTH,
  ALLOWED_RISK_LEVEL,
  REQUIRED_WORKFLOW_FIELDS,
  BLOCKED_ACTIONS,
  WORKFLOWS,
} = require('../config/atlasWorkflowRegistry');

// Project only safe, non-sensitive fields; normalize defensively.
function publicWorkflow(w) {
  const oc = w.output_contract || {};
  return {
    id: w.id,
    name: w.name,
    domain: w.domain,
    category: w.category,
    status: w.status,
    proof_level: w.proof_level,
    execution_allowed: w.execution_allowed === true,   // never true in this phase
    activation_allowed: w.activation_allowed === true, // never true in this phase
    target_business_outcome: w.target_business_outcome,
    related_packs: Array.isArray(w.related_packs) ? w.related_packs.slice() : [],
    required_agents: Array.isArray(w.required_agents) ? w.required_agents.slice() : [],
    required_data_sources: Array.isArray(w.required_data_sources) ? w.required_data_sources.slice() : [],
    input_requirements: Array.isArray(w.input_requirements) ? w.input_requirements.slice() : [],
    output_contract: {
      kind: oc.kind,
      returns: Array.isArray(oc.returns) ? oc.returns.slice() : [],
      side_effects: oc.side_effects,
      mutations: oc.mutations === true,
      external_sends: oc.external_sends === true,
      production_sync: oc.production_sync === true,
    },
    approval_requirements: Array.isArray(w.approval_requirements) ? w.approval_requirements.slice() : [],
    evidence_requirements: Array.isArray(w.evidence_requirements) ? w.evidence_requirements.slice() : [],
    audit_requirements: Array.isArray(w.audit_requirements) ? w.audit_requirements.slice() : [],
    risk_level: w.risk_level,
    setup_complexity: w.setup_complexity,
    automation_depth: w.automation_depth,
    safe_cta: w.safe_cta,
    blocked_reason: w.blocked_reason || null,
  };
}

/** @returns {Array<object>} every workflow as safe, read-only metadata. */
function listAtlasWorkflows() {
  return WORKFLOWS.map(publicWorkflow);
}

/**
 * @param {string} id workflow id
 * @returns {object|null} safe workflow metadata, or null if unknown.
 */
function getAtlasWorkflowById(id) {
  if (typeof id !== 'string' || !id) return null;
  const w = WORKFLOWS.find((x) => x.id === id);
  return w ? publicWorkflow(w) : null;
}

function countBy(workflows, key) {
  const counts = {};
  for (const w of workflows) {
    const v = w[key];
    if (typeof v === 'string' && v) counts[v] = (counts[v] || 0) + 1;
  }
  return counts;
}

/**
 * Counts/booleans-only summary of the registry.
 * @returns {object}
 */
function summarizeAtlasWorkflowRegistry() {
  const workflows = listAtlasWorkflows();
  return {
    workflows_total: workflows.length,
    domains_total: ALLOWED_WORKFLOW_DOMAINS.length,
    live_proven_count: workflows.filter((w) => w.status === 'live_proven').length,
    execution_allowed_count: workflows.filter((w) => w.execution_allowed === true).length,
    activation_allowed_count: workflows.filter((w) => w.activation_allowed === true).length,
    by_status: countBy(workflows, 'status'),
    by_domain: countBy(workflows, 'domain'),
    by_category: countBy(workflows, 'category'),
    by_proof_level: countBy(workflows, 'proof_level'),
    blocked_actions: BLOCKED_ACTIONS.slice(),
  };
}

/**
 * Independent validation used by checks/tests. Pure — returns offenders, never
 * throws. ok === true means every workflow honors every invariant.
 * @returns {{ok: boolean, offenders: object}}
 */
function validateWorkflowRegistry() {
  const bad_status = [];
  const bad_domain = [];
  const bad_category = [];
  const bad_proof_level = [];
  const bad_setup = [];
  const bad_automation = [];
  const bad_risk = [];
  const bad_cta = [];
  const forbidden_cta = [];
  const executable = [];
  const activatable = [];
  const unsafe_output_contract = [];
  const missing_fields = [];
  const blank_blocked_reason = [];

  const lowerForbidden = FORBIDDEN_CTAS.map((c) => c.toLowerCase());

  for (const w of WORKFLOWS) {
    if (!ALLOWED_WORKFLOW_STATUSES.includes(w.status)) bad_status.push(w.id);
    if (!ALLOWED_WORKFLOW_DOMAINS.includes(w.domain)) bad_domain.push(w.id);
    if (!ALLOWED_WORKFLOW_CATEGORIES.includes(w.category)) bad_category.push(w.id);
    if (!ALLOWED_PROOF_LEVELS.includes(w.proof_level)) bad_proof_level.push(w.id);
    if (!ALLOWED_SETUP_COMPLEXITY.includes(w.setup_complexity)) bad_setup.push(w.id);
    if (!ALLOWED_AUTOMATION_DEPTH.includes(w.automation_depth)) bad_automation.push(w.id);
    if (!ALLOWED_RISK_LEVEL.includes(w.risk_level)) bad_risk.push(w.id);
    if (!ALLOWED_SAFE_CTAS.includes(w.safe_cta)) bad_cta.push(w.id);
    if (typeof w.safe_cta === 'string' && lowerForbidden.some((c) => w.safe_cta.toLowerCase().includes(c))) {
      forbidden_cta.push(w.id);
    }
    if (w.execution_allowed === true) executable.push(w.id);
    if (w.activation_allowed === true && w.status !== 'live_proven') activatable.push(w.id);
    const oc = w.output_contract || {};
    if (oc.side_effects !== 'none' || oc.mutations === true || oc.external_sends === true || oc.production_sync === true) {
      unsafe_output_contract.push(w.id);
    }
    for (const f of REQUIRED_WORKFLOW_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(w, f) || w[f] === undefined) missing_fields.push(w.id + ':' + f);
    }
    if (typeof w.blocked_reason !== 'string' || !w.blocked_reason) blank_blocked_reason.push(w.id);
  }

  const offenders = {
    bad_status, bad_domain, bad_category, bad_proof_level, bad_setup, bad_automation,
    bad_risk, bad_cta, forbidden_cta, executable, activatable, unsafe_output_contract,
    missing_fields, blank_blocked_reason,
  };
  const ok = Object.values(offenders).every((arr) => arr.length === 0);
  return { ok, offenders };
}

/**
 * Build the full read-only Workflow Registry truth object.
 * @param {object} [opts]
 * @param {string} [opts.generatedAt] caller-supplied ISO timestamp (for testability)
 * @returns {object} honest, redacted, counts/booleans/status/labels-only snapshot.
 */
function buildAtlasWorkflowRegistryTruth(opts = {}) {
  const generatedAt =
    typeof opts.generatedAt === 'string' && opts.generatedAt
      ? opts.generatedAt
      : new Date().toISOString();

  const workflows = listAtlasWorkflows();
  const summary = summarizeAtlasWorkflowRegistry();

  return {
    platform: 'atlas',
    layer: 'atlas_workflow_business_process_layer',
    contract: 'read_only_workflow_registry_truth',
    environment: 'safe_redacted',
    workflow_registry_version: WORKFLOW_REGISTRY_VERSION,
    generated_at: generatedAt,

    // Safety posture — hard-false by design in this phase.
    read_only: true,
    execution_enabled: false,
    activation_enabled: false,
    production_sync_enabled: false,
    external_send_enabled: false,

    summary,
    workflows,
    blocked_actions: BLOCKED_ACTIONS.slice(),

    notes: [
      'Workflows are the business-process layer under the Atlas Pack Civilization Layer.',
      'This registry is read-only: it never executes or activates a workflow.',
      'No workflow is proven live (live_proven = 0); none triggers sync, sends, DB writes, or jobs.',
      'Preview / connector / custom / partner / roadmap / disabled workflows are not executable.',
      'Pack Registry and Runtime Truth remain conservative and untouched.',
    ],
  };
}

module.exports = {
  buildAtlasWorkflowRegistryTruth,
  listAtlasWorkflows,
  getAtlasWorkflowById,
  summarizeAtlasWorkflowRegistry,
  validateWorkflowRegistry,
  REQUIRED_WORKFLOW_FIELDS,
};
