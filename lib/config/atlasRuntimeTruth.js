// FILE: lib/config/atlasRuntimeTruth.js
// ─────────────────────────────────────────────────────────────────────────────
// Atlas Runtime Truth — static, honest registry (Phase 2C.21)
//
// PURPOSE
//   Single source of truth that tells frontend/agents EXACTLY what is real,
//   proven, limited, planned, or blocked. Atlas must never fake live capability.
//
// THIS FILE IS PURE STATIC DATA. It contains:
//   - the allowed status enum
//   - the pack / agent / workflow registry (status + honest limitations + proof refs)
//   - proof gates, launch-claim allow/block lists, warnings
//
// IT NEVER CONTAINS: secrets, DB URLs, env values, tokens, customer PII, emails,
// phones, invoice details, or raw row data. Counts / booleans / status only.
//
// STATUS RULES (enforced by scripts/phase-2c-21-runtime-truth-check.js):
//   live_proven   — ONLY if implemented + tool-wired + policy-guarded + audited +
//                   cost/status tracked (where applicable) + proof-gated in prod.
//   live_limited  — actually ENABLED and proven in at least a production canary,
//                   usable in a restricted mode with clear, listed limitations.
//                   Staging-only proof does NOT qualify — see `planned`.
//   planned       — NOT production-live; never counted as live. Covers BOTH
//                   roadmap-only items AND capabilities that are fully implemented
//                   and staging-proven but whose production flag is OFF/not-set.
//                   (Status labels are PROOF labels, not marketing labels.)
//   blocked       — needs production canary, legal/compliance, missing evidence,
//                   missing tenant map, missing schema parity, or owner approval.
//                   `blocked_reason` carries the nuance (e.g. 'production_canary').
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const TRUTH_VERSION = '2C.21';

// Canonical status enum — the ONLY allowed values for any registry entry.
const STATUS = Object.freeze({
  LIVE_PROVEN: 'live_proven',
  LIVE_LIMITED: 'live_limited',
  PLANNED: 'planned',
  BLOCKED: 'blocked',
});

const ALLOWED_STATUSES = Object.freeze(Object.values(STATUS));

// Reasons a blocked entry is blocked (documentation only — not a status).
const BLOCKED_REASON = Object.freeze({
  PRODUCTION_CANARY: 'production_canary',
  DEFAULT_OFF: 'default_off',
  MISSING_TENANT_MAP: 'missing_tenant_map',
  MISSING_SCHEMA_PARITY: 'missing_schema_parity',
  MISSING_OWNER_APPROVAL: 'missing_owner_approval',
  PLANNED_ROADMAP: 'planned_roadmap',
  // Implemented + staging-proven, but production flag OFF/not-set — dormant in
  // production. Distinguishes "built but not production-live" from "roadmap only".
  NOT_PRODUCTION_LIVE: 'not_production_live',
});

// ── PACKS ────────────────────────────────────────────────────────────────────
// NO pack is live at the pack level. The Global Core Pack is planned/not-
// production-live: only individual read-only previews exist (one as a production
// canary), never a live business-automation pack. Every region pack and the
// trader/enterprise/custom packs are roadmap-only.
const PACKS = [
  {
    id: 'pack.global_core',
    name: 'Global Core Pack',
    region: 'global',
    status: STATUS.PLANNED,
    limitations: [
      'Pack-level business automation is NOT live.',
      'One member agent (core.owner_briefing) runs only as a read-only production-canary preview — not GA.',
      'The other core agents are implemented and staging-proven but their production flags are OFF — not production-live.',
      'The only always-available surface is this read-only Runtime Truth contract; it performs no execution and no external sends.',
    ],
    proof_refs: ['phase-2c-19-owner-briefing-evidence-gate', 'phase-2c-20-production-readiness-gate'],
    blocked_reason: BLOCKED_REASON.NOT_PRODUCTION_LIVE,
  },
  {
    id: 'pack.india',
    name: 'India Region Pack',
    region: 'IN',
    status: STATUS.PLANNED,
    limitations: ['Roadmap only — not implemented; no India-specific compliance proven.'],
    proof_refs: [],
    blocked_reason: BLOCKED_REASON.PLANNED_ROADMAP,
  },
  {
    id: 'pack.uae',
    name: 'UAE Region Pack',
    region: 'AE',
    status: STATUS.PLANNED,
    limitations: ['Roadmap only — not implemented.'],
    proof_refs: [],
    blocked_reason: BLOCKED_REASON.PLANNED_ROADMAP,
  },
  {
    id: 'pack.us',
    name: 'US Region Pack',
    region: 'US',
    status: STATUS.PLANNED,
    limitations: ['Roadmap only — not implemented.'],
    proof_refs: [],
    blocked_reason: BLOCKED_REASON.PLANNED_ROADMAP,
  },
  {
    id: 'pack.uk_eu',
    name: 'UK/EU Region Pack',
    region: 'UK_EU',
    status: STATUS.PLANNED,
    limitations: ['Roadmap only — not implemented; GDPR approach not yet audited.'],
    proof_refs: [],
    blocked_reason: BLOCKED_REASON.PLANNED_ROADMAP,
  },
  {
    id: 'pack.trader',
    name: 'Trader Pack',
    region: 'global',
    status: STATUS.PLANNED,
    limitations: ['Roadmap only — not honestly backed as live yet.'],
    proof_refs: [],
    blocked_reason: BLOCKED_REASON.PLANNED_ROADMAP,
  },
  {
    id: 'pack.enterprise',
    name: 'Enterprise Pack',
    region: 'global',
    status: STATUS.PLANNED,
    limitations: ['Roadmap only — not implemented.'],
    proof_refs: [],
    blocked_reason: BLOCKED_REASON.PLANNED_ROADMAP,
  },
  {
    id: 'pack.custom',
    name: 'Custom Pack',
    region: 'global',
    status: STATUS.PLANNED,
    limitations: ['Roadmap only — not implemented.'],
    proof_refs: [],
    blocked_reason: BLOCKED_REASON.PLANNED_ROADMAP,
  },
];

// ── AGENTS ───────────────────────────────────────────────────────────────────
// Only ONE agent is live_limited: core.owner_briefing, which is actually enabled
// as a production canary AND backed by the 2C.19 evidence gate + 2C.20 readiness
// gate. The other three are fully implemented and staging-proven, but their
// production flags are OFF/dormant — so they are planned (not production-live),
// never counted as live. live_proven stays 0 by design.
const AGENTS = [
  {
    id: 'core.owner_briefing',
    name: 'Owner Briefing Agent',
    status: STATUS.LIVE_LIMITED,
    flag: 'owner_briefing_agent_enabled',
    limitations: [
      'Read-only preview; no mutations, no external sends.',
      'Production CANARY only (flag ON in production) — NOT GA; a clean 24h canary is still pending (Phase 2C.17).',
      'Evidence currently flows from staging Cortex until the Neon→Cortex pipeline reaches production.',
      'RAG Evidence Contract enforced; unsafe claims are blocked, not shown.',
    ],
    // References Phase 2C.19 evidence gate + 2C.20 readiness gate — not a fake claim.
    proof_refs: ['phase-2c-19-owner-briefing-evidence-gate', 'phase-2c-20-production-readiness-gate'],
    audited: true,
    blocked_reason: null,
  },
  {
    id: 'core.data_quality',
    name: 'Data Quality Agent',
    status: STATUS.PLANNED,
    flag: 'data_quality_agent_enabled',
    limitations: [
      'Backend implemented (Rust sidecar + Node client) and proven END-TO-END on STAGING (read-only scan, auth-gated, zero mutations).',
      'Production feature flag is NOT set — endpoint 404s in production; not production-live.',
      'Blocked from production enablement until the owner UI review flow is wired (per Phase 2A proof).',
    ],
    proof_refs: ['phase-2a-data-quality-staging-proof', 'harness-x-static'],
    audited: false,
    blocked_reason: BLOCKED_REASON.NOT_PRODUCTION_LIVE,
  },
  {
    id: 'core.policy_guard',
    name: 'Policy Guard Agent',
    status: STATUS.PLANNED,
    flag: 'policy_guard_agent_enabled',
    limitations: [
      'Backend implemented (Rust sidecar + Node client) and proven on STAGING (8 cases, FIR word-boundary regression, fail-closed, zero mutations).',
      'Feature flag is dormant everywhere — the staging proof window (2026-06-01) is closed; production flag NOT set.',
      'Read-only evaluation; not production-live.',
    ],
    proof_refs: ['phase-2b-policy-guard-staging-proof', 'harness-x-static'],
    audited: false,
    blocked_reason: BLOCKED_REASON.NOT_PRODUCTION_LIVE,
  },
  {
    id: 'core.cost_router',
    name: 'Cost Router Agent',
    status: STATUS.PLANNED,
    flag: 'cost_router_agent_enabled',
    limitations: [
      'Backend implemented (Rust sidecar + Node client) and proven END-TO-END on STAGING (routing matrix, auth, conservative fallback, zero mutations).',
      'Feature flag is default-OFF and dormant everywhere — absent from the production flag table; opt-in preview only.',
      'Read-only routing decision; not production-live.',
    ],
    proof_refs: ['phase-2c-cost-router-staging-proof', 'harness-x-static'],
    audited: false,
    blocked_reason: BLOCKED_REASON.NOT_PRODUCTION_LIVE,
  },
];

// ── WORKFLOWS ────────────────────────────────────────────────────────────────
const WORKFLOWS = [
  {
    id: 'workflow.owner_briefing_preview',
    name: 'Owner Briefing Preview',
    status: STATUS.LIVE_LIMITED,
    limitations: [
      'Read-only aggregation via GET /api/agents/core.owner_briefing/preview.',
      'Production CANARY only — NOT GA; a clean 24h canary is still pending.',
      'Evidence sourced from staging Cortex until the Neon→Cortex pipeline reaches production.',
    ],
    proof_refs: ['phase-2c-19-owner-briefing-evidence-gate'],
    blocked_reason: null,
  },
  {
    id: 'workflow.neon_to_cortex_sync',
    name: 'Neon → Cortex Pipeline',
    status: STATUS.BLOCKED,
    limitations: [
      'Manual operator script only — NOT wired into the app, no flag enables it.',
      'Blocked for production canary until 2C.20 blockers are cleared.',
    ],
    proof_refs: ['phase-2c-19-production-neon-to-cortex-pipeline', 'phase-2c-20-production-readiness-gate'],
    blocked_reason: BLOCKED_REASON.PRODUCTION_CANARY,
  },
  {
    id: 'workflow.external_message_send',
    name: 'External Message Sending (Twilio/WhatsApp)',
    status: STATUS.BLOCKED,
    limitations: [
      'Default OFF — drafts only until owner-approval gate is wired.',
      'FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED must be true AND owner approval given.',
    ],
    proof_refs: [],
    blocked_reason: BLOCKED_REASON.DEFAULT_OFF,
  },
];

// ── PROOF GATES ──────────────────────────────────────────────────────────────
// Honest status of the evidence/readiness gates that back the live_limited claims.
const PROOF_GATES = [
  {
    id: 'phase-2c-19-owner-briefing-evidence-gate',
    name: 'Owner Briefing Evidence Gate',
    status: 'passed_staging',
    scope: 'staging',
    note: 'RAG Evidence Contract enforced; fail-closed when sidecar unreachable.',
  },
  {
    id: 'phase-2c-20-production-readiness-gate',
    name: 'Production Readiness Gate (Neon → Cortex)',
    status: 'passed_static',
    scope: 'static',
    note: '12/12 readiness invariants proven statically; production canary still blocked.',
  },
  {
    id: 'production-canary',
    name: 'Production Canary',
    status: 'blocked',
    scope: 'production',
    note: 'Blocked pending real tenant map, production connectivity proof, schema parity, canary scope, and explicit owner approval.',
  },
  {
    id: 'harness-x-static',
    name: 'Harness X (static)',
    status: 'passed_static',
    scope: 'static',
    note: 'Static scenario pass; live categories require a live env.',
  },
];

// ── LAUNCH CLAIMS ────────────────────────────────────────────────────────────
// Mirrors docs/agent-mesh/public-vs-internal-agent-claims.md. Allowed claims are
// evidence-backed and approved; blocked claims must never be presented as live.
const LAUNCH_CLAIMS = {
  allowed: [
    '12 core specialized agents',
    'Expandable Agent Mesh architecture',
    'Harness X verified workflows — every agent tested before deployment',
    'Owner-approved automation — no critical action without your sign-off',
    'CashOps, collections, receivables, and cashflow intelligence',
  ],
  blocked: [
    '216 live agents',
    'All 216 agents are running',
    '50+ / 100+ / 200+ specialized agents (unproven tier)',
    'Fully autonomous finance operations',
    'Production-live Neon → Cortex sync',
    'Live external WhatsApp/Twilio sending',
    'Bank-grade / military-grade security',
  ],
};

// ── WARNINGS ─────────────────────────────────────────────────────────────────
const WARNINGS = [
  'Execution, external sending, and production sync are all disabled in this build.',
  'Production canary is blocked: needs real tenant map, production connectivity proof, schema parity, canary scope, and explicit owner approval.',
  'No agent is live_proven yet — strongest honest status is live_limited.',
  'Status labels are PROOF labels, not marketing labels: a capability may be fully implemented and staging-proven yet still labeled `planned` because it is not enabled or proven in production.',
  'Underclaiming is intentional — Atlas must never imply production-live capability it has not proven in production. Only core.owner_briefing (production canary) is live_limited.',
];

module.exports = {
  TRUTH_VERSION,
  STATUS,
  ALLOWED_STATUSES,
  BLOCKED_REASON,
  PACKS,
  AGENTS,
  WORKFLOWS,
  PROOF_GATES,
  LAUNCH_CLAIMS,
  WARNINGS,
};
