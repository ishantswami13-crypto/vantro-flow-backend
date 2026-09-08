// FILE: lib/domain/intelligence/velocity.js
// STARLANE Temporal Intelligence — Part 5: Velocity (rate of change).
//
// Computes rate-of-change per real-day between the two most recent real
// points of a series, with an explicit unit and an honest
// INSUFFICIENT_HISTORY / DEGENERATE_SPACING result when timestamps don't
// support a meaningful rate (e.g. same-day duplicate rows, or fewer than 2
// points). Never fabricates a rate from a single point.

function computeVelocity(pointsAsc, { unitLabel = 'units/day', minSpacingDays = 0.5 } = {}) {
  const n = (pointsAsc || []).length;
  if (n < 2) {
    return { status: 'INSUFFICIENT_HISTORY', rate: null, unit: unitLabel, reason: `need at least 2 real points, have ${n}` };
  }
  const prior = pointsAsc[n - 2];
  const latest = pointsAsc[n - 1];
  const spacingDays = (new Date(latest.recorded_at).getTime() - new Date(prior.recorded_at).getTime()) / 86400000;
  if (!(spacingDays >= minSpacingDays)) {
    return { status: 'DEGENERATE_SPACING', rate: null, unit: unitLabel, reason: `points are only ${spacingDays.toFixed(3)} days apart — too close for a meaningful rate` };
  }
  const rate = (Number(latest.value) - Number(prior.value)) / spacingDays;
  return {
    status: 'OK',
    rate: Math.round(rate * 1000) / 1000,
    unit: unitLabel,
    spacingDays: Math.round(spacingDays * 100) / 100,
    fromValue: Number(prior.value),
    toValue: Number(latest.value),
    fromAt: prior.recorded_at,
    toAt: latest.recorded_at,
  };
}

module.exports = { computeVelocity };
