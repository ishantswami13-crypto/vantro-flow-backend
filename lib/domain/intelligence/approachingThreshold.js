// FILE: lib/domain/intelligence/approachingThreshold.js
// STARLANE Temporal Intelligence — Part 6: Approaching-threshold intelligence.
//
// Detects a value approaching a defined threshold BEFORE it breaches, using
// real velocity (velocity.js) — never claiming an exact breach date unless
// the caller's own forecast interval genuinely supports it (that decision is
// left to the caller; this module only ever reports a velocity-based ETA
// range, and marks it UNSUPPORTED_PRECISION when the rate is too small/noisy
// to project responsibly).
//
// Pure function: does not fetch data itself, so it composes over ANY real
// series (cash buffer, concentration, credit score) without new per-domain
// fetch logic. cashConsequenceEngine.js / forecastEngine.js remain the real
// data sources for the one worked case in the mission (cash buffer).

const { computeVelocity } = require('./velocity');

/**
 * @param {Array<{value:number, recorded_at:string}>} pointsAsc - real points, oldest first
 * @param {number} threshold - the value that would constitute a breach
 * @param {Object} [opts]
 * @param {'below'|'above'} [opts.breachDirection='below'] - breach occurs when value crosses threshold in this direction
 * @param {number} [opts.maxProjectionDays=90] - refuse to project further than this even if velocity implies it (avoids absurd long-range point estimates)
 */
function detectApproachingThreshold(pointsAsc, threshold, opts = {}) {
  const breachDirection = opts.breachDirection || 'below';
  const maxProjectionDays = opts.maxProjectionDays || 90;
  const n = (pointsAsc || []).length;

  if (n < 2) {
    return { status: 'INSUFFICIENT_HISTORY', reason: `need at least 2 real points to compute velocity, have ${n}` };
  }

  const latest = pointsAsc[n - 1];
  const currentValue = Number(latest.value);
  const alreadyBreached = breachDirection === 'below' ? currentValue <= threshold : currentValue >= threshold;
  if (alreadyBreached) {
    return { status: 'ALREADY_BREACHED', currentValue, threshold, asOf: latest.recorded_at };
  }

  const vel = computeVelocity(pointsAsc, { unitLabel: 'units/day' });
  if (vel.status !== 'OK') {
    return { status: 'INSUFFICIENT_HISTORY', reason: `velocity not computable: ${vel.reason}` };
  }

  const movingTowardThreshold = breachDirection === 'below' ? vel.rate < 0 : vel.rate > 0;
  if (!movingTowardThreshold) {
    return { status: 'NOT_APPROACHING', currentValue, threshold, rate: vel.rate, unit: vel.unit, reason: 'current velocity moves away from or parallel to the threshold' };
  }

  const distance = Math.abs(currentValue - threshold);
  const daysToBreach = distance / Math.abs(vel.rate);

  if (daysToBreach > maxProjectionDays) {
    return {
      status: 'APPROACHING_BUT_FAR',
      currentValue, threshold, rate: vel.rate, unit: vel.unit,
      reason: `at the current real rate, breach is more than ${maxProjectionDays} days out (${Math.round(daysToBreach)}d) — not surfaced as an imminent warning`,
    };
  }

  return {
    status: 'APPROACHING_THRESHOLD',
    currentValue,
    threshold,
    breachDirection,
    rate: vel.rate,
    unit: vel.unit,
    estimatedDaysToBreach: Math.round(daysToBreach * 10) / 10,
    basis: `linear projection from the two most recent real points (${vel.fromAt} -> ${vel.toAt}); not a probability distribution, no exact calendar date asserted beyond this estimate`,
  };
}

module.exports = { detectApproachingThreshold };
