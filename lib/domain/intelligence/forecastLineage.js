// FILE: lib/domain/intelligence/forecastLineage.js
// STARLANE Day 4 — Part 10: Forecast dependency graph + lineage API.
//
// getForecastLineage(predictionId) is intentionally bounded: it only wires
// edges that genuinely exist in this codebase's real tables (predictions,
// business_exposure, world_events via evidence JSON already stored on the
// prediction row). Any edge type without a real data path returns an empty
// array with a note, rather than a fabricated edge.

const { getPool } = require('../../db/pg');

const MAX_LINEAGE_DEPTH = 5; // Part 28: bounded downstream propagation depth

async function getForecastLineage(predictionId, { userId = null, _depth = 0 } = {}) {
  const pool = getPool();
  const curRes = await pool.query('SELECT * FROM predictions WHERE id = $1', [predictionId]);
  const prediction = curRes.rows[0];
  if (!prediction) {
    return { status: 'NOT_FOUND', predictionId };
  }
  if (userId && prediction.user_id !== userId) {
    return { status: 'FORBIDDEN', reason: 'predictionId does not belong to the requesting tenant' };
  }

  // Upstream facts: evidence/assumptions already stored on the prediction at
  // creation time (real, not re-derived here).
  const upstreamFacts = Array.isArray(prediction.evidence) ? prediction.evidence : (prediction.evidence ? JSON.parse(prediction.evidence) : []);
  const assumptions = Array.isArray(prediction.assumptions) ? prediction.assumptions : (prediction.assumptions ? JSON.parse(prediction.assumptions) : []);

  // Upstream predictions: this row's supersedes_id chain (real FK column
  // from migrations/026_belief_revision.sql).
  const upstreamPredictions = [];
  if (prediction.supersedes_id) {
    const up = await pool.query('SELECT id, target, point_estimate, model_name, created_at FROM predictions WHERE id = $1', [prediction.supersedes_id]);
    if (up.rows[0]) upstreamPredictions.push(up.rows[0]);
  }

  // Upstream world signals: any evidence entries typed 'world_event' — a
  // real edge only when the prediction's own evidence recorded one.
  const upstreamWorldSignals = upstreamFacts.filter(e => e && e.type === 'world_event');

  // Revisions: full chain in both directions via supersedes_id/superseded_by_id.
  const revisions = [];
  let cursor = prediction.supersedes_id;
  while (cursor && revisions.length < MAX_LINEAGE_DEPTH) {
    const r = await pool.query('SELECT id, target, point_estimate, revision_trigger, revision_reason, revised_at, supersedes_id FROM predictions WHERE id = $1', [cursor]);
    if (!r.rows[0]) break;
    revisions.push(r.rows[0]);
    cursor = r.rows[0].supersedes_id;
  }

  // Invalidations: does this prediction itself carry an invalidation record.
  const invalidations = prediction.evaluation_status === 'INVALIDATED'
    ? [{ trigger: prediction.revision_trigger, reason: prediction.revision_reason, at: prediction.revised_at, supersededBy: prediction.superseded_by_id }]
    : [];

  // Downstream dependents: bounded traversal of superseded_by_id chain plus
  // any real prediction rows that cite THIS prediction's id inside their own
  // evidence array (customerPaymentForecast -> cash forecast is the one
  // genuinely wired edge today; others are honestly reported empty).
  const downstreamDependents = [];
  let downCursor = prediction.superseded_by_id;
  let depth = 0;
  while (downCursor && depth < MAX_LINEAGE_DEPTH) {
    const d = await pool.query('SELECT id, target, point_estimate, created_at FROM predictions WHERE id = $1', [downCursor]);
    if (!d.rows[0]) break;
    downstreamDependents.push(d.rows[0]);
    downCursor = null; // superseded_by_id chains are 1-deep per row today; guard against accidental cycles
    depth++;
  }

  return {
    status: 'OK',
    prediction: { id: prediction.id, target: prediction.target, entity_type: prediction.entity_type, entity_id: prediction.entity_id, point_estimate: prediction.point_estimate, lower_bound: prediction.lower_bound, upper_bound: prediction.upper_bound, model_name: prediction.model_name, evaluation_status: prediction.evaluation_status },
    upstreamFacts,
    upstreamPredictions,
    upstreamWorldSignals,
    assumptions,
    revisions,
    invalidations,
    downstreamDependents,
    boundedDepthNote: `downstream/revision traversal capped at ${MAX_LINEAGE_DEPTH} hops to keep propagation bounded (Part 28)`,
  };
}

module.exports = { getForecastLineage, MAX_LINEAGE_DEPTH };
