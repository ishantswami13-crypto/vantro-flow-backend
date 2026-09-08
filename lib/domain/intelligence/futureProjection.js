// FILE: lib/domain/intelligence/futureProjection.js
// STARLANE Day 3 — Consequence, Scenario & Possible-Future Intelligence.
// Part 1: Future-projection primitive.
//
// A "projection" is a structured, honest statement about a possible future
// state, built ONLY from real observed data (variables.js, uncertainty.js,
// exposureMap.js) plus explicit, named assumptions. It NEVER fabricates a
// probability, confidence percentage, or causal claim. Every projection
// carries the evidence and assumptions that produced it, and an explicit
// set of invalidation_conditions describing what real-world event would make
// it stale.
//
// This is a pure builder/normalizer — it does not query the DB itself.
// Callers (cashConsequenceEngine.js, scenarioEngine.js) gather real evidence
// and pass it in.

const { bandAtLeast } = require('./uncertainty');

const PROJECTION_KIND = {
  BASELINE: 'BASELINE', // "if recent observed pattern persists"
  SCENARIO: 'SCENARIO', // explicit hypothetical, never real state
};

/**
 * @param {object} params
 * @param {string} params.kind - PROJECTION_KIND.BASELINE | .SCENARIO
 * @param {{type:string,id:string,label?:string}} params.subject
 * @param {{days:number,label:string}} params.horizon
 * @param {object} params.baseline_state - real, currently-observed state this projects from
 * @param {Array<{assumption:string,basis:string,strength:'STRONG'|'MODERATE'|'WEAK'}>} params.assumptions
 * @param {string[]} params.driving_variables - names of variables.js variables used
 * @param {object} params.projected_state - the projected (never-observed) future state
 * @param {object} params.uncertainty - output of assessUncertainty (or a downgraded copy)
 * @param {Array<object>} params.evidence - real rows/facts backing baseline_state
 * @param {string[]} params.invalidation_conditions - human-readable conditions that would make this stale
 * @param {string} [params.scenarioName] - required when kind === SCENARIO
 */
function buildFutureProjection({
  kind,
  subject,
  horizon,
  baseline_state,
  assumptions = [],
  driving_variables = [],
  projected_state,
  uncertainty,
  evidence = [],
  invalidation_conditions = [],
  scenarioName = null,
}) {
  if (!kind || !PROJECTION_KIND[kind]) throw new Error(`buildFutureProjection: invalid kind '${kind}'`);
  if (!subject || !subject.type || !subject.id) throw new Error('buildFutureProjection: subject {type,id} is required');
  if (!horizon || typeof horizon.days !== 'number') throw new Error('buildFutureProjection: horizon {days} is required');
  if (kind === PROJECTION_KIND.SCENARIO && !scenarioName) {
    throw new Error('buildFutureProjection: scenarioName is required for SCENARIO projections');
  }
  if (!Array.isArray(assumptions)) throw new Error('buildFutureProjection: assumptions must be an array');

  return {
    kind, // BASELINE | SCENARIO — never omit, never let a SCENARIO be mistaken for observed truth
    label: kind === PROJECTION_KIND.SCENARIO ? `SCENARIO: ${scenarioName}` : 'BASELINE (if recent observed pattern persists)',
    scenarioName,
    subject,
    horizon,
    baseline_state: baseline_state || null,
    assumptions,
    driving_variables,
    projected_state: projected_state || null,
    uncertainty: uncertainty || { band: 'INSUFFICIENT', factors: {}, reason: 'no uncertainty assessment supplied' },
    evidence,
    invalidation_conditions,
    generated_at: new Date().toISOString(),
    status: 'ACTIVE', // ACTIVE | RESOLVED | SUPERSEDED — see invalidation logic below
  };
}

/**
 * Downgrade a projection's uncertainty band when contradiction detection
 * flags conflicting real evidence for the same subject (Part 14 wiring).
 * Never fabricates a worse-sounding reason — states exactly which real
 * contradiction caused the downgrade.
 */
function downgradeForContradiction(projection, contradictions) {
  if (!contradictions || contradictions.length === 0) return projection;
  const order = ['INSUFFICIENT', 'WEAK', 'MODERATE', 'STRONG', 'VERIFIED'];
  const currentIdx = order.indexOf(projection.uncertainty.band);
  const downgradedIdx = Math.max(0, currentIdx - 1);
  return {
    ...projection,
    uncertainty: {
      ...projection.uncertainty,
      band: order[downgradedIdx],
      reason: `${projection.uncertainty.reason}; DOWNGRADED because ${contradictions.length} real contradiction(s) affect this subject's evidence: ` +
        contradictions.map(c => c.type).join(', '),
      downgraded_due_to_contradictions: contradictions.map(c => ({ type: c.type, claim: c.claim, contradiction: c.contradiction })),
    },
  };
}

/**
 * Invalidation check (Part 11): given a projection and the CURRENT real state
 * of its subject, decide whether the projection is now stale. This never
 * mutates history — callers persist the result (e.g. mark a stored
 * projection RESOLVED) if they keep projections in a table; here it is a
 * pure decision function usable with in-memory or DB-backed projections.
 *
 * @param {object} projection
 * @param {object} currentRealState - freshly queried real state of the same subject
 * @param {(baseline:object, current:object) => boolean} hasRealityDivergedFn
 */
function checkInvalidation(projection, currentRealState, hasRealityDivergedFn) {
  if (projection.status !== 'ACTIVE') {
    return { invalidated: false, alreadyResolved: true, status: projection.status };
  }
  const diverged = hasRealityDivergedFn(projection.baseline_state, currentRealState);
  if (!diverged) {
    return { invalidated: false, status: 'ACTIVE' };
  }
  return {
    invalidated: true,
    status: 'RESOLVED',
    resolved_at: new Date().toISOString(),
    reason: 'Real observed state has diverged from the baseline_state this projection was built from.',
    baseline_state: projection.baseline_state,
    current_real_state: currentRealState,
  };
}

// Part 16: Action/outcome linkage — a projection/scenario can be attached to
// the ai_actions.reason_json of the action it informed, purely as
// CHRONOLOGY (what existed when the action was suggested), never as a
// causal claim ("this projection caused this action"). Consumers
// (contextAssembly.js) surface it back out as `linkedFutureIntelligence`
// alongside the existing priorOutcomeSummary mechanism, without altering
// any existing reason_json field.
function linkProjectionToAction(existingReasonJson, projectionOrScenario) {
  const base = existingReasonJson && typeof existingReasonJson === 'object' ? { ...existingReasonJson } : {};
  const link = {
    kind: projectionOrScenario.kind,
    label: projectionOrScenario.label,
    subject: projectionOrScenario.subject,
    horizon: projectionOrScenario.horizon,
    uncertaintyBand: projectionOrScenario.uncertainty?.band,
    generatedAt: projectionOrScenario.generated_at,
  };
  base.possibleFutureLink = link;
  return base;
}

function extractLinkedFutureIntelligence(actionsWithReasonJson) {
  return (actionsWithReasonJson || [])
    .filter(a => a.reason_json && a.reason_json.possibleFutureLink)
    .map(a => ({ actionId: a.id, ...a.reason_json.possibleFutureLink }));
}

module.exports = {
  buildFutureProjection,
  downgradeForContradiction,
  checkInvalidation,
  linkProjectionToAction,
  extractLinkedFutureIntelligence,
  PROJECTION_KIND,
  bandAtLeast,
};
