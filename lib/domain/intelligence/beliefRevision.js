// FILE: lib/domain/intelligence/beliefRevision.js
// STARLANE Day 4 — Part 8: Belief revision. Part 9: targeted prediction
// invalidation. Part 12: materiality filter for forecast revisions.
//
// Never overwrites a superseded prediction row. resolvePrediction()
// (forecastEngine.js) already fills actual_value/resolved_at on the OLD row
// without touching its model fields; this module additionally links
// old -> new when a genuinely new forecast is created in response to real
// evidence (e.g. a payment arriving), and produces a structured diff.

const { getPool } = require('../../db/pg');
const { computeMaterialityComponents } = require('../../world/materiality');

/**
 * Mark `oldPredictionId` as invalidated/superseded by `newPredictionId`,
 * recording why. Both rows must already exist and belong to the same
 * tenant — cross-tenant linking is refused.
 */
async function reviseBelief({ userId, oldPredictionId, newPredictionId, trigger, reason }) {
  if (!userId) throw new Error('reviseBelief: userId is required');
  if (!oldPredictionId || !newPredictionId) throw new Error('reviseBelief: both oldPredictionId and newPredictionId are required');
  const pool = getPool();

  const rows = await pool.query(
    `SELECT id, user_id FROM predictions WHERE id = ANY($1::uuid[])`,
    [[oldPredictionId, newPredictionId]]
  );
  if (rows.rows.length !== 2) throw new Error('reviseBelief: one or both prediction ids not found');
  if (rows.rows.some(r => r.user_id !== userId)) {
    throw new Error('reviseBelief: refusing cross-tenant belief revision — both predictions must belong to userId');
  }

  await pool.query(
    `UPDATE predictions SET superseded_by_id = $1, revision_trigger = $2, revision_reason = $3, revised_at = now(), evaluation_status = 'INVALIDATED'
     WHERE id = $4 AND evaluation_status != 'RESOLVED'`,
    [newPredictionId, trigger, reason, oldPredictionId]
  );
  // If the old prediction was already RESOLVED (has a real actual_value),
  // we still link it for lineage but do not overwrite its evaluation_status
  // — a resolved outcome is a fact, not something belief-revision undoes.
  await pool.query(
    `UPDATE predictions SET superseded_by_id = $1 WHERE id = $2 AND evaluation_status = 'RESOLVED'`,
    [newPredictionId, oldPredictionId]
  );
  await pool.query(`UPDATE predictions SET supersedes_id = $1 WHERE id = $2`, [oldPredictionId, newPredictionId]);

  return { oldPredictionId, newPredictionId, trigger, reason };
}

/**
 * Structured (not prose-only) diff between two prediction rows, tracing the
 * numeric change to fields that actually differ. Does not invent a upstream
 * cause — `upstreamDelta` is supplied by the caller (the real fact that
 * triggered the revision, e.g. a payment) rather than guessed here.
 */
function explainForecastChange(oldPrediction, newPrediction, upstreamDelta = null) {
  if (!oldPrediction || !newPrediction) {
    return { status: 'INSUFFICIENT_CONTEXT', reason: 'both old and new prediction rows are required to explain a change' };
  }
  const pointDelta = Number(newPrediction.point_estimate) - Number(oldPrediction.point_estimate);
  const lowerDelta = (newPrediction.lower_bound != null && oldPrediction.lower_bound != null)
    ? Number(newPrediction.lower_bound) - Number(oldPrediction.lower_bound) : null;
  const upperDelta = (newPrediction.upper_bound != null && oldPrediction.upper_bound != null)
    ? Number(newPrediction.upper_bound) - Number(oldPrediction.upper_bound) : null;

  return {
    status: 'EXPLAINED',
    pointDelta,
    lowerDelta,
    upperDelta,
    intervalWidthDelta: (lowerDelta != null && upperDelta != null) ? (upperDelta - lowerDelta) : null,
    upstreamDelta: upstreamDelta || { note: 'no upstream real-world delta was supplied by caller — trace is point-estimate diff only' },
    modelChanged: oldPrediction.model_name !== newPrediction.model_name || oldPrediction.model_version !== newPrediction.model_version,
    oldModel: { name: oldPrediction.model_name, version: oldPrediction.model_version },
    newModel: { name: newPrediction.model_name, version: newPrediction.model_version },
  };
}

/**
 * Part 12: materiality filter for forecast revisions. Reuses
 * computeMaterialityComponents (never duplicated) plus a simple relative
 * point-estimate threshold to decide whether a revision is worth surfacing.
 */
function isRevisionMaterial(explanation, { minPctChange = 5, materialityInputs = null } = {}) {
  if (!explanation || explanation.status !== 'EXPLAINED') {
    return { material: false, reason: 'no explained delta available' };
  }
  const base = Math.abs(explanation.pointDelta);
  const pctOfOld = materialityInputs?.oldPointEstimate ? (base / Math.abs(materialityInputs.oldPointEstimate)) * 100 : null;
  const materialByPct = pctOfOld != null ? pctOfOld >= minPctChange : (base > 0);

  let materialityComponents = null;
  if (materialityInputs?.signal || materialityInputs?.exposure || materialityInputs?.event) {
    materialityComponents = computeMaterialityComponents(materialityInputs);
  }

  return {
    material: materialByPct,
    pctOfOld,
    minPctChange,
    reason: materialByPct ? `point estimate changed ${pctOfOld != null ? pctOfOld.toFixed(1) + '%' : 'by ' + base} which meets/exceeds the ${minPctChange}% surfacing threshold` : 'change is below the materiality threshold — suppressed as trivial',
    materialityComponents,
  };
}

module.exports = { reviseBelief, explainForecastChange, isRevisionMaterial };
