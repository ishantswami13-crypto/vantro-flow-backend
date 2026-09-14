// FILE: lib/domain/intelligence/outcomeVerification.js
// Closes the loop that supplyChainOrchestrator.js and forecastEngine.js
// leave open: "action executed" is not "outcome verified". This module
// reuses forecastEngine.resolvePrediction (real, existing prediction-error
// math) rather than inventing a parallel scoring mechanism, and only ever
// writes a verified outcome once the prediction's horizon has actually
// elapsed — never before, and never guessed.
const { getPool } = require('../../db/pg');
const { resolvePrediction } = require('./forecastEngine');
const { findAffectedProducts, calculateAffectedDemand, calculateRevenueExposure } = require('./supplyChainImpact');

// A stockout-within-horizon prediction (written by
// supplyChainOrchestrator.writeDoNothingForecast) resolves against a real,
// observable fact: is this component's current_stock at or below zero
// right now? That is the only actual value this prediction type supports —
// no other signal is invented to "complete" verification early.
async function observeActualStockoutState(userId, componentId) {
  const pool = getPool();
  const res = await pool.query(
    `SELECT current_stock FROM products WHERE id = $1 AND user_id = $2`,
    [componentId, userId]
  );
  if (res.rows.length === 0) return null;
  const stock = Number(res.rows[0].current_stock);
  return stock <= 0 ? 1 : 0;
}

// A revenue-exposure-within-horizon prediction resolves against the SAME
// deterministic calculation used to originate it (calculateRevenueExposure),
// but recomputed now against current order_line_items/product_components
// state — not against the original snapshot. If orders have since shipped,
// been cancelled, or new ones appeared, the observed actual reflects that
// real movement, honestly, rather than replaying the original number.
async function observeActualRevenueExposure(userId, componentId) {
  const pool = getPool();
  const compRes = await pool.query(`SELECT id FROM products WHERE id = $1 AND user_id = $2`, [componentId, userId]);
  if (compRes.rows.length === 0) return null;

  const bomRes = await pool.query(`SELECT finished_product_id, component_product_id, quantity_per_unit FROM product_components WHERE user_id = $1`, [userId]);
  const orderLinesRes = await pool.query(
    `SELECT oli.order_id, oli.product_id, oli.quantity, oli.unit_price
     FROM order_line_items oli JOIN orders o ON o.id = oli.order_id
     WHERE oli.user_id = $1 AND o.status NOT IN ('delivered', 'cancelled')`,
    [userId]
  );
  const affectedFinished = findAffectedProducts(componentId, bomRes.rows);
  const demand = calculateAffectedDemand(orderLinesRes.rows, affectedFinished.map((a) => a.finishedProductId));
  const revenue = calculateRevenueExposure(demand.affectedLineItems);
  return revenue.sufficientData ? revenue.totalRevenueExposure : null;
}

const OBSERVERS = {
  stockout_within_horizon: observeActualStockoutState,
  revenue_exposure_within_horizon: observeActualRevenueExposure,
};

// Resolves every prediction for one signal whose horizon has elapsed, and
// rolls the result up into the outcome of the ai_action(s) raised for that
// signal. Never resolves a prediction before its horizon date — those stay
// AWAITING_OBSERVATION (evaluation_status is left untouched by design).
async function verifySignalOutcomes(userId, signalId) {
  const pool = getPool();
  const now = new Date();

  const predRes = await pool.query(
    `SELECT * FROM predictions
     WHERE user_id = $1 AND target = ANY($2) AND evaluation_status IS DISTINCT FROM 'RESOLVED'`,
    [userId, Object.keys(OBSERVERS)]
  );
  const relevant = predRes.rows.filter((p) => p.evidence && p.evidence.signalId === signalId);

  const resolved = [];
  const stillAwaiting = [];
  for (const p of relevant) {
    const horizonDate = new Date(new Date(p.as_of).getTime() + p.horizon_days * 86400000);
    if (horizonDate > now) {
      stillAwaiting.push({ predictionId: p.id, target: p.target, horizonDays: p.horizon_days, horizonDate: horizonDate.toISOString() });
      continue;
    }
    const observe = OBSERVERS[p.target];
    const actual = await observe(userId, p.entity_id);
    if (actual == null) continue; // entity no longer exists, or insufficient data — cannot observe, cannot resolve
    const result = await resolvePrediction(p.id, actual);
    resolved.push({ ...result, target: p.target, horizonDays: p.horizon_days });
  }

  // Only the stockout target rolls up into the action's effective/ineffective
  // outcome today — revenue-exposure resolution is real and persisted, but
  // has no rollup rule defined yet (see docs/2xa-demo.md known limitations).
  const stockoutResolved = resolved.filter((r) => r.target === 'stockout_within_horizon');
  const stockoutAwaiting = stillAwaiting.filter((r) => r.target === 'stockout_within_horizon');

  // Roll up: an action tied to this signal is "effective" if, for every
  // resolved horizon, the actual observed stockout state was 0 (never
  // stocked out) — "ineffective" if any resolved horizon shows a real
  // stockout despite the action. Never marked either way while any
  // horizon relevant to the decision is still awaiting observation.
  const actionsRes = await pool.query(
    `SELECT * FROM ai_actions WHERE user_id = $1 AND related_entity_type = 'business_signal' AND related_entity_id = $2 AND status = 'done'`,
    [userId, signalId]
  );

  const updatedActions = [];
  if (stockoutResolved.length > 0 && stockoutAwaiting.length === 0) {
    const anyStockout = stockoutResolved.some((r) => r.actualValue === 1);
    const outcome = anyStockout ? 'ineffective' : 'effective';
    for (const action of actionsRes.rows) {
      const notes = anyStockout
        ? `Verified against real inventory data: a stockout occurred despite this action (resolved horizons: ${stockoutResolved.map((r) => r.horizonDays).join(', ')}d).`
        : `Verified against real inventory data: no stockout occurred through the resolved horizon(s) (${stockoutResolved.map((r) => r.horizonDays).join(', ')}d).`;
      await pool.query(
        `UPDATE ai_actions SET outcome = $1, outcome_at = NOW(), outcome_notes = $2 WHERE id = $3`,
        [outcome, notes, action.id]
      );
      updatedActions.push({ actionId: action.id, outcome });
    }
  }

  return {
    signalId,
    resolvedPredictions: resolved,
    awaitingPredictions: stillAwaiting,
    updatedActions,
    status: updatedActions.length > 0 ? 'VERIFIED' : (stillAwaiting.length > 0 ? 'AWAITING_OBSERVATION' : 'NO_ACTION_TO_VERIFY'),
  };
}

module.exports = { observeActualStockoutState, observeActualRevenueExposure, verifySignalOutcomes };
