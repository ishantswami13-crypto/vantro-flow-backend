// FILE: lib/config/atlasLaunchProfiles.js
// ─────────────────────────────────────────────────────────────────────────────
// Atlas Launch Profiles — static, honest, READ-ONLY launch-profile + evidence-
// contract SHAPE (Phase 2C.31).
//
// PURPOSE
//   Phase 2C.31 defines a STATIC launch-profile and evidence-contract shape for a
//   FUTURE pilot evaluation. It is a composition + contract TRUTH MODEL only:
//     - it COMPOSES a profile from canonical Phase 2C.26 Packs (by id);
//     - it declares THREE hook contracts (briefing / collections / reorder), each
//       mapped to canonical Phase 2C.28 agents, Phase 2C.27 workflows, and Phase
//       2C.30 action-approval classes — but ONLY where the source registries prove
//       it. Where no implemented agent exists, the hook is honestly not_implemented.
//   This file does NOT connect any business data, does NOT enforce an evaluator,
//   does NOT prepare or send any collections message, does NOT draft or commit any
//   purchase, and does NOT execute or activate anything. Hook capability is never
//   represented above the truth of the underlying source registries.
//
// HARD INVARIANTS (enforced by scripts/phase-2c-31-pilot-contract-check.js, which
// re-derives every fact from the canonical registries — it does NOT trust the
// booleans below):
//   - execution_allowed / external_sending_allowed / production_mutation_allowed /
//     automatic_approval_allowed = false (forced here; independently re-checked).
//   - every required Pack id is canonical (2C.26) and not status/permission-upgraded.
//   - every non-null agent/workflow ref is canonical (2C.28 / 2C.27); a hook may only
//     claim "implemented/live" capability if its agent is is_implemented in 2C.28.
//   - every action class is canonical (2C.30); every consequential (non read-only)
//     action requires human approval and is non-executable.
//
// THIS FILE IS PURE STATIC DATA. It loads no runtime module, opens
// NO DB/network/process, and contains NO secrets, env values, tokens, approver
// identities, customer details, phones, emails, invoice values, or raw row data —
// only ids, labels, enums, booleans, and a schema SHAPE description.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const LAUNCH_PROFILES_VERSION = '2C.31';

// ── The EXACT required Pack set (canonical Phase 2C.26 ids) ─────────────────────
// Order-independent; the checker enforces exactly these seven, no more, no fewer,
// no duplicates, every one canonical in lib/config/atlasPackRegistry.js.
const REQUIRED_PACK_IDS = Object.freeze([
  'global_core',
  'trader_pack',
  'business_type_distributor',
  'business_size_smb',
  'industry_wholesale_distribution',
  'region_india',
  'role_owner',
]);

// ── Enums (documentation only; checker re-derives truth from source registries) ─
// 'live_proven' is intentionally ABSENT from hook capability — no source row is
// live_proven, so a hook can never claim it.
const HOOK_CAPABILITY_STATUS = Object.freeze({
  NOT_IMPLEMENTED: 'not_implemented', // no implemented agent proves this hook
  PREVIEW: 'preview',                 // implemented + staging, default/preview only
  LIVE_LIMITED: 'live_limited',       // implemented + staging-proven, read-only (== source agent)
});

const IMPLEMENTATION_STATUS = Object.freeze({
  NOT_IMPLEMENTED: 'not_implemented',
  IMPLEMENTED: 'implemented',
});

const CAPABILITY_GATE_STATUS = Object.freeze({
  NOT_IMPLEMENTED: 'not_implemented',
  BLOCKED: 'blocked',
});

const DATA_BEHAVIOR = Object.freeze({
  FAIL_CLOSED: 'fail_closed',
  FAIL_CLOSED_WITH_LIMITATION: 'fail_closed_with_limitation',
});

// ── shared evidence-contract SHAPE (a description, never live evidence) ─────────
// Every hook carries this shape. The checker verifies the required keys, the
// isolation requirements, evidence/provenance/freshness requirements, and the
// fail-closed missing/stale-data behaviour.
function evidenceContractShape() {
  return {
    output_schema: {
      finding: 'string',
      business_impact: 'string',
      priority: 'enum[HIGH,MEDIUM,LOW]',
      evidence_ids: 'array[string]',
      provenance_source_ids: 'array[string]',
      source_freshness: 'string(iso8601)',
      confidence: 'enum[HIGH,MEDIUM,LOW]',
      prepared_next_action: 'string',
      approval_requirement: 'string',
      safe_to_show_decision: 'boolean',
    },
    evidence_ids_required_for_material_findings: true,
    provenance_source_ids_required: true,
    freshness_required: true,
    workspace_isolation_required: true,
    owner_isolation_required: true,
    missing_data_behavior: DATA_BEHAVIOR.FAIL_CLOSED,
    stale_data_behavior: DATA_BEHAVIOR.FAIL_CLOSED_WITH_LIMITATION,
    limitations: [
      'no_data_loaded_in_this_phase',
      'no_hook_computation_proven_in_this_phase',
      'fail_closed_on_missing_or_stale_data',
    ],
  };
}

// ── THE THREE HOOK CONTRACTS ────────────────────────────────────────────────────
const HOOKS = [
  // 1 — Daily Owner Briefing (read-only analysis; backed by the ONLY implemented
  //     canonical agent core.owner_briefing — live_limited/staging-proven in 2C.28).
  {
    id: 'daily_owner_briefing',
    name: 'Daily Owner Briefing',
    description:
      'Static contract for a read-only owner-briefing preview. This phase loads no ' +
      'data and proves no computation; capability is not represented above the ' +
      'source agent truth.',
    contract_status: 'contract_defined',
    implementation_status: IMPLEMENTATION_STATUS.IMPLEMENTED, // core.owner_briefing is_implemented:true (2C.28)
    capability_status: HOOK_CAPABILITY_STATUS.LIVE_LIMITED,    // == source agent status; NOT upgraded
    proof_level: 'staging_proven',                              // == source agent proof_level
    canonical_agent_ref: 'core.owner_briefing',
    canonical_workflow_ref: 'workflow_owner_briefing_preview',
    analysis_requires_data: true,
    actions: [
      {
        role: 'analysis',
        action_class: 'read_only_analysis',
        approval_required: false, // justified ONLY because read-only + non-executable (2C.30 contract)
        executable: false,
        external_effect: 'none',
      },
    ],
    evidence_contract: evidenceContractShape(),
    limitations: [
      'read_only_preview',
      'no_execution',
      'no_external_send',
      'no_production_mutation',
      'tenant_isolated',
      'evidence_gated',
      'no_data_loaded_in_this_phase',
      'no_hook_computation_proven_in_this_phase',
    ],
  },

  // 2 — Collections Copilot (NO implemented canonical agent → not_implemented).
  //     Analysis and collection-message PREPARATION are separated; preparation maps
  //     to the consequential external_communication class and requires human approval.
  {
    id: 'collections_copilot',
    name: 'Collections Copilot',
    description:
      'Static contract for collections analysis and (separately) collection-message ' +
      'preparation. No implemented agent proves this hook; this phase computes no ' +
      'analysis and prepares or sends no message.',
    contract_status: 'contract_defined',
    implementation_status: IMPLEMENTATION_STATUS.NOT_IMPLEMENTED, // collections.priority_review is_implemented:false (roadmap)
    capability_status: HOOK_CAPABILITY_STATUS.NOT_IMPLEMENTED,
    proof_level: 'none',
    canonical_agent_ref: null,    // no implemented canonical agent supports this hook
    canonical_workflow_ref: null, // workflow_collections_review has no implemented required agent
    analysis_requires_data: true,
    action_preparation_status: CAPABILITY_GATE_STATUS.NOT_IMPLEMENTED,
    external_send_status: CAPABILITY_GATE_STATUS.BLOCKED,
    actions: [
      {
        role: 'analysis',
        action_class: 'read_only_analysis',
        approval_required: false,
        executable: false,
        external_effect: 'none',
      },
      {
        role: 'message_preparation',
        action_class: 'external_communication', // consequential — human approval required (2C.30)
        approval_required: true,
        executable: false,
        external_effect: 'external_message',
        preparation_status: CAPABILITY_GATE_STATUS.NOT_IMPLEMENTED,
        external_send_status: CAPABILITY_GATE_STATUS.BLOCKED,
      },
    ],
    evidence_contract: evidenceContractShape(),
    limitations: [
      'not_implemented',
      'analysis_requires_connected_data',
      'message_preparation_not_implemented',
      'external_send_blocked',
      'no_execution',
      'no_production_mutation',
      'tenant_isolated',
      'no_data_loaded_in_this_phase',
    ],
  },

  // 3 — Smart Reorder (NO implemented canonical agent → not_implemented).
  //     Analysis and purchase/reorder DRAFT are separated; the draft maps to the
  //     consequential financial_commitment class and requires human approval.
  {
    id: 'smart_reorder',
    name: 'Smart Reorder',
    description:
      'Static contract for reorder analysis and (separately) a purchase/reorder ' +
      'draft. No implemented agent proves this hook; this phase computes no analysis ' +
      'and drafts or commits no purchase.',
    contract_status: 'contract_defined',
    implementation_status: IMPLEMENTATION_STATUS.NOT_IMPLEMENTED, // purchase.supplier_review is_implemented:false (connector_required)
    capability_status: HOOK_CAPABILITY_STATUS.NOT_IMPLEMENTED,
    proof_level: 'none',
    canonical_agent_ref: null,    // no implemented canonical agent supports this hook
    canonical_workflow_ref: null, // workflow_purchase_supplier_review has no implemented required agent
    analysis_requires_data: true,
    purchase_draft_status: CAPABILITY_GATE_STATUS.NOT_IMPLEMENTED,
    purchase_commitment_status: CAPABILITY_GATE_STATUS.BLOCKED,
    actions: [
      {
        role: 'analysis',
        action_class: 'read_only_analysis',
        approval_required: false,
        executable: false,
        external_effect: 'none',
      },
      {
        role: 'purchase_draft',
        action_class: 'financial_commitment', // consequential — human approval required (2C.30)
        approval_required: true,
        executable: false,
        external_effect: 'financial',
        draft_status: CAPABILITY_GATE_STATUS.NOT_IMPLEMENTED,
        commitment_status: CAPABILITY_GATE_STATUS.BLOCKED,
      },
    ],
    evidence_contract: evidenceContractShape(),
    limitations: [
      'not_implemented',
      'analysis_requires_connected_data',
      'purchase_draft_not_implemented',
      'purchase_commitment_blocked',
      'no_execution',
      'no_financial_commitment_execution',
      'no_production_mutation',
      'tenant_isolated',
      'no_data_loaded_in_this_phase',
    ],
  },
];

// ── deep-freeze + hard-force safety booleans ────────────────────────────────────
function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.keys(o).forEach((k) => deepFreeze(o[k]));
    Object.freeze(o);
  }
  return o;
}

// defineLaunchProfile() HARD-FORCES the four safety booleans false and forces every
// hook action non-executable, regardless of input. A profile literally cannot be
// marked executable, external-sending, production-mutating, or auto-approving here.
function defineLaunchProfile(p) {
  const profile = {
    id: p.id,
    name: p.name,
    version: p.version,
    phase: '2C.31',
    description: p.description,
    required_packs: (p.required_packs || []).slice(),
    hooks: (p.hooks || []).map((h) => ({
      ...h,
      actions: (h.actions || []).map((a) => ({ ...a, executable: false })), // HARD INVARIANT
    })),
    safety_invariants: {
      execution_allowed: false,            // HARD INVARIANT
      external_sending_allowed: false,     // HARD INVARIANT
      production_mutation_allowed: false,  // HARD INVARIANT
      automatic_approval_allowed: false,   // HARD INVARIANT
    },
    // explicit, honest scope booleans for this phase
    pilot_readiness_claimed: false,
    data_loaded_by_this_phase: false,
    evaluator_enforced_by_this_phase: false,
    hook_computation_proven_by_this_phase: false,
  };
  return deepFreeze(profile);
}

// ── THE LAUNCH PROFILE (exactly one) ─────────────────────────────────────────────
const swami_founding_pilot_v1 = defineLaunchProfile({
  id: 'swami_founding_pilot_v1',
  name: 'Founding Pilot Profile v1',
  version: '1.0.0',
  description:
    'Static launch-profile and evidence-contract shape for a future pilot evaluation. ' +
    'Defines pack composition and three hook contracts only; loads no data, proves no ' +
    'hook computation, and enables no execution, sending, or mutation.',
  required_packs: REQUIRED_PACK_IDS,
  hooks: HOOKS,
});

const PROFILES = Object.freeze([swami_founding_pilot_v1]);

module.exports = {
  LAUNCH_PROFILES_VERSION,
  REQUIRED_PACK_IDS,
  HOOK_CAPABILITY_STATUS,
  IMPLEMENTATION_STATUS,
  PROFILES,
  swami_founding_pilot_v1,
};
