// FILE: lib/services/runtimeTruth.service.js
// ─────────────────────────────────────────────────────────────────────────────
// Atlas Runtime Truth service (Phase 2C.21)
//
// Builds a READ-ONLY honest snapshot of what Atlas can actually do right now,
// from the static registry in lib/config/atlasRuntimeTruth.js plus the live
// boolean state of safety feature flags.
//
// SAFETY:
//   - No DB access. No network. No mutations. No secrets/PII/env values emitted.
//   - Emits counts / booleans / status only.
//   - Validates every registry status against the allowed enum (fail-loud in the
//     check script; here we drop unknown statuses so we never over-count "live").
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const {
  TRUTH_VERSION,
  STATUS,
  ALLOWED_STATUSES,
  PACKS,
  AGENTS,
  WORKFLOWS,
  PROOF_GATES,
  LAUNCH_CLAIMS,
  WARNINGS,
} = require('../config/atlasRuntimeTruth');

const { isEnabled } = require('../featureFlags');

// Only ever expose safe, non-sensitive fields from a registry entry.
function publicPack(p) {
  return {
    id: p.id,
    name: p.name,
    region: p.region,
    status: p.status,
    limitations: Array.isArray(p.limitations) ? p.limitations : [],
    proof_refs: Array.isArray(p.proof_refs) ? p.proof_refs : [],
    blocked_reason: p.blocked_reason || null,
  };
}

function publicAgent(a) {
  return {
    id: a.id,
    name: a.name,
    status: a.status,
    limitations: Array.isArray(a.limitations) ? a.limitations : [],
    proof_refs: Array.isArray(a.proof_refs) ? a.proof_refs : [],
    audited: a.audited === true,
    blocked_reason: a.blocked_reason || null,
  };
}

function publicWorkflow(w) {
  return {
    id: w.id,
    name: w.name,
    status: w.status,
    limitations: Array.isArray(w.limitations) ? w.limitations : [],
    proof_refs: Array.isArray(w.proof_refs) ? w.proof_refs : [],
    blocked_reason: w.blocked_reason || null,
  };
}

// Tally statuses across all entities. Unknown statuses are ignored (never
// counted as live) — the static check script fails-loud if any appear.
function tally(entities) {
  const counts = { live_proven: 0, live_limited: 0, planned: 0, blocked: 0 };
  for (const e of entities) {
    if (ALLOWED_STATUSES.includes(e.status) && counts[e.status] !== undefined) {
      counts[e.status] += 1;
    }
  }
  return counts;
}

/**
 * Build the Runtime Truth object.
 * @param {object} [opts]
 * @param {string} [opts.generatedAt] ISO timestamp (caller-supplied for testability).
 * @returns {object} honest, redacted, counts/booleans/status-only snapshot.
 */
function buildRuntimeTruth(opts = {}) {
  const generatedAt =
    typeof opts.generatedAt === 'string' && opts.generatedAt
      ? opts.generatedAt
      : new Date().toISOString();

  const packs = PACKS.map(publicPack);
  const agents = AGENTS.map(publicAgent);
  const workflows = WORKFLOWS.map(publicWorkflow);

  const combined = tally([...packs, ...agents, ...workflows]);

  // Safety toggles — derived from live flag booleans, defaulting to the safe
  // (disabled) side. No flag enables agent execution or production sync in this
  // phase, so those are hard-false by design.
  const execution_enabled = false; // no agent execution / no production canary in 2C.21
  const external_send_enabled = isEnabled('external_message_sending_enabled') === true;
  const production_sync_enabled = false; // Neon→Cortex is a manual script; no flag wires it

  return {
    platform: 'atlas',
    environment: 'safe_redacted',
    truth_version: TRUTH_VERSION,
    generated_at: generatedAt,

    execution_enabled,
    external_send_enabled,
    production_sync_enabled,

    summary: {
      packs_total: packs.length,
      agents_total: agents.length,
      workflows_total: workflows.length,
      live_proven: combined.live_proven,
      live_limited: combined.live_limited,
      planned: combined.planned,
      blocked: combined.blocked,
    },

    packs,
    agents,
    workflows,
    proof_gates: PROOF_GATES,
    launch_claims: {
      allowed: LAUNCH_CLAIMS.allowed.slice(),
      blocked: LAUNCH_CLAIMS.blocked.slice(),
    },
    warnings: WARNINGS.slice(),
  };
}

// Validate that every registry status is in the allowed enum (used by checks/tests).
function validateStatuses() {
  const offenders = [];
  for (const e of [...PACKS, ...AGENTS, ...WORKFLOWS]) {
    if (!ALLOWED_STATUSES.includes(e.status)) offenders.push({ id: e.id, status: e.status });
  }
  return { ok: offenders.length === 0, offenders };
}

module.exports = { buildRuntimeTruth, validateStatuses, STATUS, ALLOWED_STATUSES };
