// FILE: lib/domain/intelligence/trajectoryV2.js
// STARLANE Temporal Intelligence — Part 3: Trajectory Engine v2.
//
// Composes variables.js's existing point-count discipline (classifyTrend)
// into richer labels ONLY when the point count honestly justifies it. Does
// NOT duplicate or alter classifyTrend/getVariable — this module calls into
// variables.js's exported classifyTrend for the base 0/1/2/3+ classification
// and layers acceleration/reversal/volatility detection strictly on top,
// requiring 4+ real points before ever using an acceleration/reversal label.
//
// Point-count rules (mission-mandated, strictly enforced):
//   0 points -> INSUFFICIENT_HISTORY
//   1 point  -> INSUFFICIENT_HISTORY
//   2 points -> STABLE / IMPROVING / WORSENING (direction only, no "trend" word)
//   3 points -> STABLE / IMPROVING / WORSENING (basic trend, still no acceleration)
//   4+ points -> may additionally return ACCELERATING_IMPROVEMENT /
//                ACCELERATING_DETERIORATION / REVERSING / VOLATILE, but only
//                when the math genuinely supports it (see below) — otherwise
//                falls back to the 3-point basic labels.
//
// `higherIsBetter` lets callers say whether an increasing value is good
// (e.g. promise_reliability_score) or bad (e.g. credit_risk_score,
// payment_delay_days) — trajectoryV2 never assumes a direction.

const { classifyTrend } = require('./variables');

const NOISE_BAND_PCT = 3; // a move smaller than this (relative to the series' own range) is treated as flat/noise, not a direction

function seriesRange(points) {
  const values = points.map(p => Number(p.value));
  return Math.max(...values) - Math.min(...values);
}

function directionOf(delta, range, higherIsBetter) {
  if (range === 0) return 'STABLE';
  const pct = (Math.abs(delta) / range) * 100;
  if (pct < NOISE_BAND_PCT) return 'STABLE';
  const rising = delta > 0;
  if (higherIsBetter) return rising ? 'IMPROVING' : 'WORSENING';
  return rising ? 'WORSENING' : 'IMPROVING';
}

/**
 * @param {Array<{value:number, recorded_at:string}>} pointsAsc - real points, oldest first, ALREADY filtered to non-null real values by the caller (mirrors variables.js's `real` filtering — this module invents no data).
 * @param {Object} [opts]
 * @param {boolean} [opts.higherIsBetter=false]
 */
function classifyTrajectoryV2(pointsAsc, opts = {}) {
  const higherIsBetter = !!opts.higherIsBetter;
  const n = (pointsAsc || []).length;

  if (n === 0) {
    return { label: 'INSUFFICIENT_HISTORY', pointCount: 0, reason: 'no real historical points exist' };
  }
  if (n === 1) {
    return { label: 'INSUFFICIENT_HISTORY', pointCount: 1, reason: 'only 1 real point exists — nothing to compare against' };
  }

  const base = classifyTrend(pointsAsc); // reuses variables.js's own discipline, not reimplemented

  if (n === 2) {
    const [p0, p1] = pointsAsc;
    const delta = Number(p1.value) - Number(p0.value);
    const range = seriesRange(pointsAsc) || Math.abs(delta) || 1;
    return {
      label: directionOf(delta, range, higherIsBetter),
      pointCount: 2,
      reason: '2-point direction only, per variables.js DIRECTIONAL_CHANGE_ONLY discipline — not a trend.',
      baseTrend: base.trend,
    };
  }

  if (n === 3) {
    const delta = Number(pointsAsc[2].value) - Number(pointsAsc[0].value);
    const range = seriesRange(pointsAsc) || Math.abs(delta) || 1;
    return {
      label: directionOf(delta, range, higherIsBetter),
      pointCount: 3,
      reason: 'basic 3-point trend (first vs last), per variables.js SIMPLE_TREND discipline — not acceleration.',
      baseTrend: base.trend,
    };
  }

  // 4+ points: acceleration/reversal/volatility only if the math is real.
  const deltas = [];
  for (let i = 1; i < pointsAsc.length; i++) {
    deltas.push(Number(pointsAsc[i].value) - Number(pointsAsc[i - 1].value));
  }
  const range = seriesRange(pointsAsc) || 1;
  const signs = deltas.map(d => (Math.abs(d) / range) * 100 < NOISE_BAND_PCT ? 0 : Math.sign(d));
  const nonZeroSigns = signs.filter(s => s !== 0);
  const signChanges = nonZeroSigns.reduce((count, s, i) => i > 0 && s !== nonZeroSigns[i - 1] ? count + 1 : count, 0);

  // Volatility: sign flips at least twice among the real deltas.
  if (signChanges >= 2) {
    return { label: 'VOLATILE', pointCount: n, reason: `${signChanges} direction reversals across ${n} real points — no single trend is honest here.`, baseTrend: base.trend };
  }

  // Reversal: most recent delta's sign is opposite the earlier overall direction.
  const earlyDir = nonZeroSigns[0];
  const lastDir = nonZeroSigns[nonZeroSigns.length - 1];
  if (earlyDir != null && lastDir != null && earlyDir !== lastDir && signChanges === 1) {
    const newLabel = directionOf(lastDir, 1, higherIsBetter);
    return { label: 'REVERSING', pointCount: n, reason: `direction reversed partway through the series; most recent movement is now ${newLabel}.`, currentDirection: newLabel, baseTrend: base.trend };
  }

  // Consistent direction throughout — check whether the rate of change is
  // itself increasing (acceleration) using successive |delta| magnitudes.
  const magnitudes = deltas.map(Math.abs);
  let increasing = true;
  for (let i = 1; i < magnitudes.length; i++) {
    if (magnitudes[i] <= magnitudes[i - 1] * 1.05) { increasing = false; break; } // require a genuine >5% step-up each time, not noise
  }
  const overallDelta = Number(pointsAsc[n - 1].value) - Number(pointsAsc[0].value);
  const overallDir = directionOf(overallDelta, range, higherIsBetter);

  if (increasing && overallDir !== 'STABLE') {
    const label = overallDir === 'IMPROVING' ? 'ACCELERATING_IMPROVEMENT' : 'ACCELERATING_DETERIORATION';
    return { label, pointCount: n, reason: `magnitude of change increased at every step across ${n} real points (${magnitudes.map(m => Math.round(m * 100) / 100).join(' -> ')}).`, baseTrend: base.trend };
  }

  return { label: overallDir, pointCount: n, reason: `consistent direction across ${n} real points, but rate of change is not monotonically increasing — no acceleration claim made.`, baseTrend: base.trend };
}

module.exports = { classifyTrajectoryV2, NOISE_BAND_PCT };
