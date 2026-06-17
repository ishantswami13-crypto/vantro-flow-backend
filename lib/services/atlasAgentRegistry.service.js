// FILE: lib/services/atlasAgentRegistry.service.js
// ─────────────────────────────────────────────────────────────────────────────
// Atlas Agent Registry service (Phase 2C.28).
//
// Builds a READ-ONLY honest snapshot of the Atlas "Agent Universe" from the static
// registry in lib/config/atlasAgentRegistry.js.
//
// SAFETY:
//   - No DB access. No network. No filesystem. No env reads. No mutations.
//   - Triggers NO execution and NO activation of any agent; no production enablement,
//     no external send, no production sync, no DB write, no background job.
//   - Emits counts / booleans / status / labels / in-repo artifact paths only — never
//     secrets, DB URLs, env values, tokens, customer PII, emails, phones, invoice
//     details, or raw row data.
//   - `is_implemented` / `harness_verified` are surfaced as INDEPENDENT facts; they do
//     not change any execution/activation/production/external-send boolean (all false).
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const {
  AGENT_REGISTRY_VERSION,
  ALLOWED_AGENT_STATUSES,
  ALLOWED_AGENT_DOMAINS,
  ALLOWED_AGENT_CATEGORIES,
  ALLOWED_AGENT_SWARMS,
  ALLOWED_PROOF_LEVELS,
  ALLOWED_SAFE_CTAS,
  FORBIDDEN_CTAS,
  ALLOWED_RISK_LEVEL,
  REQUIRED_AGENT_FIELDS,
  BLOCKED_ACTIONS,
  AGENTS,
} = require('../config/atlasAgentRegistry');

// Project only safe, non-sensitive fields; normalize defensively. Every
// execution/activation/production/external-send boolean is coerced hard-false.
function publicAgent(a) {
  return {
    id: a.id,
    name: a.name,
    domain: a.domain,
    category: a.category,
    swarm: a.swarm,
    status: a.status,
    proof_level: a.proof_level,
    is_implemented: a.is_implemented === true,
    implementation_evidence: typeof a.implementation_evidence === 'string' ? a.implementation_evidence : '',
    harness_verified: a.harness_verified === true,
    proof_artifact_refs: Array.isArray(a.proof_artifact_refs) ? a.proof_artifact_refs.slice() : [],
    execution_allowed: a.execution_allowed === true,       // never true in this phase
    activation_allowed: a.activation_allowed === true,     // never true in this phase
    production_allowed: a.production_allowed === true,     // never true in this phase
    external_send_allowed: a.external_send_allowed === true, // never true in this phase
    related_packs: Array.isArray(a.related_packs) ? a.related_packs.slice() : [],
    related_workflows: Array.isArray(a.related_workflows) ? a.related_workflows.slice() : [],
    required_data_sources: Array.isArray(a.required_data_sources) ? a.required_data_sources.slice() : [],
    capabilities: Array.isArray(a.capabilities) ? a.capabilities.slice() : [],
    limitations: Array.isArray(a.limitations) ? a.limitations.slice() : [],
    approval_requirements: Array.isArray(a.approval_requirements) ? a.approval_requirements.slice() : [],
    evidence_requirements: Array.isArray(a.evidence_requirements) ? a.evidence_requirements.slice() : [],
    audit_requirements: Array.isArray(a.audit_requirements) ? a.audit_requirements.slice() : [],
    risk_level: a.risk_level,
    safe_cta: a.safe_cta,
    blocked_reason: a.blocked_reason || null,
  };
}

/** @returns {Array<object>} every agent as safe, read-only metadata. */
function listAtlasAgents() {
  return AGENTS.map(publicAgent);
}

/**
 * @param {string} id agent id
 * @returns {object|null} safe agent metadata, or null if unknown.
 */
function getAtlasAgentById(id) {
  if (typeof id !== 'string' || !id) return null;
  const a = AGENTS.find((x) => x.id === id);
  return a ? publicAgent(a) : null;
}

function countBy(agents, key) {
  const counts = {};
  for (const a of agents) {
    const v = a[key];
    if (typeof v === 'string' && v) counts[v] = (counts[v] || 0) + 1;
  }
  return counts;
}

/**
 * Counts/booleans-only summary of the registry.
 * @returns {object}
 */
function summarizeAtlasAgentRegistry() {
  const agents = listAtlasAgents();
  return {
    agents_total: agents.length,
    domains_total: ALLOWED_AGENT_DOMAINS.length,
    categories_total: ALLOWED_AGENT_CATEGORIES.length,
    swarms_total: ALLOWED_AGENT_SWARMS.length,
    // hard-zero safety counts
    live_proven_count: agents.filter((a) => a.status === 'live_proven').length,
    execution_allowed_count: agents.filter((a) => a.execution_allowed === true).length,
    activation_allowed_count: agents.filter((a) => a.activation_allowed === true).length,
    production_allowed_count: agents.filter((a) => a.production_allowed === true).length,
    external_send_allowed_count: agents.filter((a) => a.external_send_allowed === true).length,
    // independent factual counts (NOT a pass/claim condition)
    live_limited_count: agents.filter((a) => a.status === 'live_limited').length,
    is_implemented_count: agents.filter((a) => a.is_implemented === true).length,
    harness_verified_count: agents.filter((a) => a.harness_verified === true).length,
    by_status: countBy(agents, 'status'),
    by_domain: countBy(agents, 'domain'),
    by_category: countBy(agents, 'category'),
    by_swarm: countBy(agents, 'swarm'),
    by_proof_level: countBy(agents, 'proof_level'),
    blocked_actions: BLOCKED_ACTIONS.slice(),
  };
}

/**
 * Independent validation used by checks/tests. Pure — returns offenders, never
 * throws. ok === true means every agent honors every invariant.
 * @returns {{ok: boolean, offenders: object}}
 */
function validateAgentRegistry() {
  const bad_status = [];
  const bad_domain = [];
  const bad_category = [];
  const bad_swarm = [];
  const bad_proof_level = [];
  const bad_risk = [];
  const bad_cta = [];
  const forbidden_cta = [];
  const executable = [];
  const activatable = [];
  const production_enabled = [];
  const external_send_enabled = [];
  const missing_fields = [];
  const blank_blocked_reason = [];
  const duplicate_ids = [];
  const implemented_without_evidence = [];
  const harness_without_proof = [];
  const live_limited_without_proof = [];

  const lowerForbidden = FORBIDDEN_CTAS.map((c) => c.toLowerCase());
  const seen = new Set();

  for (const a of AGENTS) {
    if (seen.has(a.id)) duplicate_ids.push(a.id); else seen.add(a.id);
    if (!ALLOWED_AGENT_STATUSES.includes(a.status)) bad_status.push(a.id);
    if (!ALLOWED_AGENT_DOMAINS.includes(a.domain)) bad_domain.push(a.id);
    if (!ALLOWED_AGENT_CATEGORIES.includes(a.category)) bad_category.push(a.id);
    if (!ALLOWED_AGENT_SWARMS.includes(a.swarm)) bad_swarm.push(a.id);
    if (!ALLOWED_PROOF_LEVELS.includes(a.proof_level)) bad_proof_level.push(a.id);
    if (!ALLOWED_RISK_LEVEL.includes(a.risk_level)) bad_risk.push(a.id);
    if (!ALLOWED_SAFE_CTAS.includes(a.safe_cta)) bad_cta.push(a.id);
    if (typeof a.safe_cta === 'string' && lowerForbidden.some((c) => a.safe_cta.toLowerCase().includes(c))) {
      forbidden_cta.push(a.id);
    }
    if (a.execution_allowed === true) executable.push(a.id);
    if (a.activation_allowed === true) activatable.push(a.id);
    if (a.production_allowed === true) production_enabled.push(a.id);
    if (a.external_send_allowed === true) external_send_enabled.push(a.id);
    for (const f of REQUIRED_AGENT_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(a, f) || a[f] === undefined) missing_fields.push(a.id + ':' + f);
    }
    if (typeof a.blocked_reason !== 'string' || !a.blocked_reason) blank_blocked_reason.push(a.id);
    // factual-field integrity (independent of the safety booleans)
    if (a.is_implemented === true && !(typeof a.implementation_evidence === 'string' && a.implementation_evidence.length > 0)) {
      implemented_without_evidence.push(a.id);
    }
    if (a.harness_verified === true && !(Array.isArray(a.proof_artifact_refs) && a.proof_artifact_refs.length > 0)) {
      harness_without_proof.push(a.id);
    }
    // live_limited demands BOTH implementation AND agent-specific proof
    if (a.status === 'live_limited' &&
        !(a.is_implemented === true && a.harness_verified === true &&
          typeof a.implementation_evidence === 'string' && a.implementation_evidence.length > 0 &&
          Array.isArray(a.proof_artifact_refs) && a.proof_artifact_refs.length > 0)) {
      live_limited_without_proof.push(a.id);
    }
  }

  const offenders = {
    bad_status, bad_domain, bad_category, bad_swarm, bad_proof_level, bad_risk,
    bad_cta, forbidden_cta, executable, activatable, production_enabled,
    external_send_enabled, missing_fields, blank_blocked_reason, duplicate_ids,
    implemented_without_evidence, harness_without_proof, live_limited_without_proof,
  };
  const ok = Object.values(offenders).every((arr) => arr.length === 0);
  return { ok, offenders };
}

/**
 * Build the full read-only Agent Registry truth object.
 * @param {object} [opts]
 * @param {string} [opts.generatedAt] caller-supplied ISO timestamp (for testability)
 * @returns {object} honest, redacted, counts/booleans/status/labels-only snapshot.
 */
function buildAtlasAgentRegistryTruth(opts = {}) {
  const generatedAt =
    typeof opts.generatedAt === 'string' && opts.generatedAt
      ? opts.generatedAt
      : new Date().toISOString();

  const agents = listAtlasAgents();
  const summary = summarizeAtlasAgentRegistry();

  return {
    platform: 'atlas',
    layer: 'atlas_agent_universe_layer',
    contract: 'read_only_agent_registry_truth',
    environment: 'safe_redacted',
    agent_registry_version: AGENT_REGISTRY_VERSION,
    generated_at: generatedAt,

    // Safety posture — hard-false by design in this phase.
    read_only: true,
    execution_enabled: false,
    activation_enabled: false,
    production_enabled: false,
    external_send_enabled: false,

    // Honest count posture — no marketing multiplication.
    agent_count_is_concrete_rows: true,
    claimed_agent_count: agents.length,

    summary,
    agents,
    blocked_actions: BLOCKED_ACTIONS.slice(),

    notes: [
      'Agents are the actor layer relating to the Atlas Pack and Workflow registries.',
      'This registry is read-only: it never executes, activates, or production-enables an agent.',
      'No agent is proven live (live_proven = 0); none can execute, send, sync, or write.',
      'is_implemented / harness_verified are independent facts and never grant live status.',
      'live_limited requires implementation AND agent-specific committed proof; only core.owner_briefing qualifies.',
      'Swarms are organizational groupings only — not hidden agents and not a count claim.',
      'No inflated agent-count claim is made (not 216, 300, 360, or 500); every row is one concrete agent contract.',
      'Pack Registry, Workflow Registry, and Runtime Truth remain conservative and untouched.',
    ],
  };
}

module.exports = {
  buildAtlasAgentRegistryTruth,
  listAtlasAgents,
  getAtlasAgentById,
  summarizeAtlasAgentRegistry,
  validateAgentRegistry,
  REQUIRED_AGENT_FIELDS,
};
