// FILE: lib/services/atlasPackRegistry.service.js
// ─────────────────────────────────────────────────────────────────────────────
// Atlas Pack Registry service (Phase 2C.26).
//
// Builds a READ-ONLY honest snapshot of the Atlas Pack Civilization Layer from the
// static registry in lib/config/atlasPackRegistry.js.
//
// SAFETY:
//   - No DB access. No network. No filesystem. No env reads. No mutations.
//   - Triggers NO execution and NO activation of any pack.
//   - Emits counts / booleans / status / labels only — never secrets, DB URLs,
//     env values, tokens, customer PII, emails, phones, invoice details, or raw
//     row data.
//   - Drops unknown statuses from "live" tallies so it can never over-count live.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const {
  PACK_REGISTRY_VERSION,
  ALLOWED_PACK_STATUSES,
  ALLOWED_PACK_FAMILIES,
  ALLOWED_PACK_CATEGORIES,
  ALLOWED_PROOF_LEVELS,
  ALLOWED_SAFE_CTAS,
  FORBIDDEN_CTAS,
  ALLOWED_SETUP_COMPLEXITY,
  ALLOWED_AUTOMATION_DEPTH,
  ALLOWED_RISK_LEVEL,
  REQUIRED_PACK_FIELDS,
  BLOCKED_ACTIONS,
  PACKS,
} = require('../config/atlasPackRegistry');

// Project only the safe, non-sensitive fields of a pack (all registry fields are
// already safe labels/booleans; this also normalizes array fields defensively).
function publicPack(p) {
  return {
    id: p.id,
    name: p.name,
    family: p.family,
    category: p.category,
    status: p.status,
    proof_level: p.proof_level,
    execution_allowed: p.execution_allowed === true, // never true in this phase
    activation_allowed: p.activation_allowed === true, // never true in this phase
    target_business: p.target_business,
    outcome: p.outcome,
    included_agents: Array.isArray(p.included_agents) ? p.included_agents.slice() : [],
    included_workflows: Array.isArray(p.included_workflows) ? p.included_workflows.slice() : [],
    required_data_sources: Array.isArray(p.required_data_sources) ? p.required_data_sources.slice() : [],
    approval_requirements: Array.isArray(p.approval_requirements) ? p.approval_requirements.slice() : [],
    evidence_requirements: Array.isArray(p.evidence_requirements) ? p.evidence_requirements.slice() : [],
    audit_requirements: Array.isArray(p.audit_requirements) ? p.audit_requirements.slice() : [],
    setup_complexity: p.setup_complexity,
    automation_depth: p.automation_depth,
    risk_level: p.risk_level,
    safe_cta: p.safe_cta,
    blocked_reason: p.blocked_reason || null,
  };
}

/** @returns {Array<object>} every pack as safe, read-only metadata. */
function listAtlasPacks() {
  return PACKS.map(publicPack);
}

/**
 * @param {string} id pack id
 * @returns {object|null} the safe pack metadata, or null if unknown.
 */
function getAtlasPackById(id) {
  if (typeof id !== 'string' || !id) return null;
  const p = PACKS.find((x) => x.id === id);
  return p ? publicPack(p) : null;
}

// Count occurrences of a field value across a list of packs.
function countBy(packs, key) {
  const counts = {};
  for (const p of packs) {
    const v = p[key];
    if (typeof v === 'string' && v) counts[v] = (counts[v] || 0) + 1;
  }
  return counts;
}

/**
 * Counts/booleans-only summary of the registry.
 * @returns {object}
 */
function summarizeAtlasPackRegistry() {
  const packs = listAtlasPacks();
  return {
    packs_total: packs.length,
    families_total: ALLOWED_PACK_FAMILIES.length,
    // The three hard-invariant counts a reviewer cares about most:
    live_proven_count: packs.filter((p) => p.status === 'live_proven').length,
    execution_allowed_count: packs.filter((p) => p.execution_allowed === true).length,
    activation_allowed_count: packs.filter((p) => p.activation_allowed === true).length,
    by_status: countBy(packs, 'status'),
    by_family: countBy(packs, 'family'),
    by_category: countBy(packs, 'category'),
    by_proof_level: countBy(packs, 'proof_level'),
    blocked_actions: BLOCKED_ACTIONS.slice(),
  };
}

/**
 * Independent validation used by checks/tests. Pure — returns offenders, never
 * throws. ok === true means every pack honors every invariant.
 * @returns {{ok: boolean, offenders: object}}
 */
function validatePackRegistry() {
  const bad_status = [];
  const bad_family = [];
  const bad_category = [];
  const bad_proof_level = [];
  const bad_setup = [];
  const bad_automation = [];
  const bad_risk = [];
  const bad_cta = [];
  const forbidden_cta = [];
  const executable = [];
  const activatable = [];
  const missing_fields = [];
  const blank_blocked_reason = [];

  const lowerForbidden = FORBIDDEN_CTAS.map((c) => c.toLowerCase());

  for (const p of PACKS) {
    if (!ALLOWED_PACK_STATUSES.includes(p.status)) bad_status.push(p.id);
    if (!ALLOWED_PACK_FAMILIES.includes(p.family)) bad_family.push(p.id);
    if (!ALLOWED_PACK_CATEGORIES.includes(p.category)) bad_category.push(p.id);
    if (!ALLOWED_PROOF_LEVELS.includes(p.proof_level)) bad_proof_level.push(p.id);
    if (!ALLOWED_SETUP_COMPLEXITY.includes(p.setup_complexity)) bad_setup.push(p.id);
    if (!ALLOWED_AUTOMATION_DEPTH.includes(p.automation_depth)) bad_automation.push(p.id);
    if (!ALLOWED_RISK_LEVEL.includes(p.risk_level)) bad_risk.push(p.id);
    if (!ALLOWED_SAFE_CTAS.includes(p.safe_cta)) bad_cta.push(p.id);
    if (typeof p.safe_cta === 'string' && lowerForbidden.some((c) => p.safe_cta.toLowerCase().includes(c))) {
      forbidden_cta.push(p.id);
    }
    if (p.execution_allowed === true) executable.push(p.id);
    // activation may only be true when live_proven; none are live_proven, so any
    // activation_allowed === true is an offense.
    if (p.activation_allowed === true && p.status !== 'live_proven') activatable.push(p.id);
    for (const f of REQUIRED_PACK_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(p, f) || p[f] === undefined) {
        missing_fields.push(p.id + ':' + f);
      }
    }
    if (typeof p.blocked_reason !== 'string' || !p.blocked_reason) blank_blocked_reason.push(p.id);
  }

  const offenders = {
    bad_status, bad_family, bad_category, bad_proof_level, bad_setup,
    bad_automation, bad_risk, bad_cta, forbidden_cta, executable, activatable,
    missing_fields, blank_blocked_reason,
  };
  const ok = Object.values(offenders).every((arr) => arr.length === 0);
  return { ok, offenders };
}

/**
 * Build the full read-only Pack Registry truth object.
 * @param {object} [opts]
 * @param {string} [opts.generatedAt] caller-supplied ISO timestamp (for testability)
 * @returns {object} honest, redacted, counts/booleans/status/labels-only snapshot.
 */
function buildAtlasPackRegistryTruth(opts = {}) {
  const generatedAt =
    typeof opts.generatedAt === 'string' && opts.generatedAt
      ? opts.generatedAt
      : new Date().toISOString();

  const packs = listAtlasPacks();
  const summary = summarizeAtlasPackRegistry();

  return {
    platform: 'atlas',
    layer: 'atlas_pack_civilization_layer',
    contract: 'read_only_pack_registry_truth',
    environment: 'safe_redacted',
    pack_registry_version: PACK_REGISTRY_VERSION,
    generated_at: generatedAt,

    // Safety posture — hard-false by design in this phase.
    read_only: true,
    execution_enabled: false,
    activation_enabled: false,
    production_sync_enabled: false,
    external_send_enabled: false,

    summary,
    packs,
    blocked_actions: BLOCKED_ACTIONS.slice(),

    notes: [
      'The Atlas Pack Civilization Layer is a TRUTH MODEL, not marketing.',
      'This registry is read-only: it never executes or activates a pack.',
      'No pack is proven live at the pack level (live_proven = 0).',
      'Preview / connector / custom / partner / roadmap / disabled packs are not executable.',
      'Production sync and external sending remain blocked.',
    ],
  };
}

module.exports = {
  buildAtlasPackRegistryTruth,
  listAtlasPacks,
  getAtlasPackById,
  summarizeAtlasPackRegistry,
  validatePackRegistry,
  REQUIRED_PACK_FIELDS,
};
