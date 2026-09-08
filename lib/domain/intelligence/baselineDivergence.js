// FILE: lib/domain/intelligence/baselineDivergence.js
// STARLANE Multidimensional Intelligence Expansion — Capability 4:
// Baseline Divergence Detection.
//
// Detects when a real entity's RECENT behavior (last 7-30 days) diverges
// materially from ITS OWN long-term real baseline — never a universal
// cross-tenant threshold. Reuses variables.js's/trajectoryV2.js's
// point-count discipline verbatim (1pt=none, 2pt=direction only,
// 3+pt=trend only if justified) for BOTH windows independently, and reuses
// evidenceDrift.js's disclosed-threshold diff engine to compare the two
// windows' summary values — no new trend methodology and no new materiality
// math is invented here.

const { getPool } = require('../../db/pg');
const { classifyTrend } = require('./variables');
const { classifyTrajectoryV2 } = require('./trajectoryV2');
const { detectEvidenceDrift } = require('./evidenceDrift');

const RECENT_WINDOW_DAYS = 30;

const FIELD_NAMES = new Set(['credit_risk_score', 'promise_reliability_score', 'broken_promise_count', 'collection_priority_score']);

function average(points) {
  if (!points.length) return null;
  return points.reduce((s, p) => s + Number(p.value), 0) / points.length;
}

/**
 * @param {string} userId
 * @param {string} customerId
 * @param {string} variableName - one of the customer_score_history columns
 * @param {object} [opts]
 * @param {boolean} [opts.higherIsBetter=false]
 * @param {number} [opts.recentWindowDays=30]
 */
async function detectBaselineDivergence(userId, customerId, variableName, opts = {}) {
  if (!userId || !customerId || !variableName) {
    throw new Error('detectBaselineDivergence: userId, customerId, and variableName are required');
  }
  if (!FIELD_NAMES.has(variableName)) {
    throw new Error(`detectBaselineDivergence: unsupported variableName '${variableName}' — must be a real customer_score_history column`);
  }
  const recentWindowDays = opts.recentWindowDays || RECENT_WINDOW_DAYS;
  const higherIsBetter = !!opts.higherIsBetter;

  const pool = getPool();
  const res = await pool.query(
    `SELECT ${variableName} AS value, recorded_at
     FROM customer_score_history
     WHERE user_id = $1 AND customer_id = $2 AND ${variableName} IS NOT NULL
     ORDER BY recorded_at ASC`,
    [userId, customerId]
  );
  const allAsc = res.rows.map(r => ({ value: Number(r.value), recorded_at: r.recorded_at }));

  if (allAsc.length === 0) {
    return { userId, customerId, variableName, status: 'INSUFFICIENT_DATA', reason: 'no real customer_score_history rows for this customer/variable', generatedAt: new Date().toISOString() };
  }

  const cutoff = Date.now() - recentWindowDays * 86400000;
  const recentAsc = allAsc.filter(p => new Date(p.recorded_at).getTime() >= cutoff);
  const baselineAsc = allAsc.filter(p => new Date(p.recorded_at).getTime() < cutoff);

  const recentTrajectory = classifyTrajectoryV2(recentAsc, { higherIsBetter });
  const baselineTrajectory = classifyTrajectoryV2(baselineAsc, { higherIsBetter });

  if (baselineAsc.length === 0) {
    return {
      userId, customerId, variableName, status: 'NO_BASELINE_WINDOW',
      reason: `no real points exist older than the ${recentWindowDays}-day recent window — this entity has no long-term baseline to diverge from yet, not fabricated as stable or divergent`,
      recentTrajectory, generatedAt: new Date().toISOString(),
    };
  }
  if (recentAsc.length === 0) {
    return {
      userId, customerId, variableName, status: 'NO_RECENT_WINDOW',
      reason: `no real points exist within the last ${recentWindowDays} days — cannot assess recent behavior against baseline`,
      baselineTrajectory, generatedAt: new Date().toISOString(),
    };
  }

  const baselineAvg = average(baselineAsc);
  const recentAvg = average(recentAsc);

  const drift = detectEvidenceDrift(
    { [variableName]: baselineAvg },
    { [variableName]: recentAvg },
    { entityLabel: `customer ${customerId} ${variableName}` }
  );
  const item = drift.driftItems[0] || drift.suppressedItems[0];

  return {
    userId,
    customerId,
    variableName,
    status: 'ASSESSED',
    baselineWindow: { pointCount: baselineAsc.length, average: Math.round(baselineAvg * 1000) / 1000, trajectory: baselineTrajectory },
    recentWindow: { days: recentWindowDays, pointCount: recentAsc.length, average: Math.round(recentAvg * 1000) / 1000, trajectory: recentTrajectory },
    diverges: item.material,
    divergence: item,
    statement: item.material
      ? `This customer's recent ${recentWindowDays}-day ${variableName} average (${item.after}) diverges materially from ITS OWN long-term baseline average (${item.before}) — ${item.statement}`
      : `Recent ${recentWindowDays}-day behavior (${item.after}) is within this customer's own historical range (${item.before}) — no material divergence from its own baseline.`,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { detectBaselineDivergence, RECENT_WINDOW_DAYS };
