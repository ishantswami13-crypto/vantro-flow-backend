// FILE: lib/domain/temporal/temporalComparison.js
// Day 1 sprint (2026-09-07): minimal, reusable pure functions for "compare
// current window to prior comparable window" logic. Extracted so future
// temporal signals stop duplicating this same shape of comparison ad hoc.
//
// Deliberately small: this codebase already has multiple independent
// implementations of "is this getting better or worse" (creditRiskAgent.js's
// classifyScoreTrajectory — 2-point history comparison; revenueIntelligence
// .service.js's momentum calc — window-sum comparison). This module does NOT
// retrofit either of those today (see MIN_SAMPLE_SIZE note + Day 1 report):
// classifyScoreTrajectory is deeply embedded (reused verbatim by
// receivablesRiskAgent.js, keyed on exact historyRows[0]/[1] semantics) and a
// retrofit risked behavior drift for a low-value refactor under sprint time
// pressure. This utility is used by NEW temporal signals going forward.
//
// Never fabricates: hasEnoughHistory is a real, checkable gate, not
// decoration — every function here returns hasEnoughHistory: false rather
// than a computed direction/pctChange when the sample size requirement
// isn't met, exactly like classifyScoreTrajectory returning 'UNKNOWN'.

// Minimum number of real, distinct sample points required before a
// direction/pctChange is considered meaningful rather than noise. 2 is the
// same bar classifyScoreTrajectory() already uses (current + one prior).
const MIN_SAMPLE_SIZE = 2;

/**
 * Pure function: compare a current-window value to a prior-comparable-window
 * value. Returns a structured result — never a bare number, so a caller
 * can never accidentally treat "not enough history" as "flat" or "0%".
 *
 * @param {number|null|undefined} currentValue
 * @param {number|null|undefined} priorValue
 * @param {object} [opts]
 * @param {number} [opts.sampleSize] - number of real observations backing
 *   currentValue+priorValue (e.g. distinct history rows available). If
 *   provided and < MIN_SAMPLE_SIZE, hasEnoughHistory is forced false
 *   regardless of whether currentValue/priorValue are individually present.
 * @returns {{direction: 'up'|'down'|'flat'|null, pctChange: number|null, hasEnoughHistory: boolean}}
 */
function compareWindows(currentValue, priorValue, opts = {}) {
  const { sampleSize } = opts;

  if (Number.isFinite(sampleSize) && sampleSize < MIN_SAMPLE_SIZE) {
    return { direction: null, pctChange: null, hasEnoughHistory: false };
  }

  // Reject null/undefined explicitly before Number() coercion — Number(null)
  // is 0 (a real, finite number), which would silently treat "missing" as
  // "zero" and fabricate a direction/pctChange from absent data.
  if (currentValue === null || currentValue === undefined || priorValue === null || priorValue === undefined) {
    return { direction: null, pctChange: null, hasEnoughHistory: false };
  }

  const cur = Number(currentValue);
  const prior = Number(priorValue);
  if (!Number.isFinite(cur) || !Number.isFinite(prior)) {
    return { direction: null, pctChange: null, hasEnoughHistory: false };
  }

  if (cur === prior) {
    return { direction: 'flat', pctChange: 0, hasEnoughHistory: true };
  }

  // pctChange is null (not Infinity/NaN) when the prior window was exactly
  // zero — a percentage change from zero is undefined, not "infinite growth",
  // and must never be presented as a number.
  const pctChange = prior === 0 ? null : ((cur - prior) / Math.abs(prior)) * 100;

  return {
    direction: cur > prior ? 'up' : 'down',
    pctChange,
    hasEnoughHistory: true,
  };
}

/**
 * Pure function: does this many real observations meet the minimum sample
 * size this module requires before a trend is meaningful? Exposed so
 * callers can gate BEFORE calling compareWindows if they want to skip the
 * comparison entirely (e.g. to omit a `change_over_time` field rather than
 * include one with hasEnoughHistory: false).
 */
function hasMinimumSampleSize(sampleSize) {
  return Number.isFinite(sampleSize) && sampleSize >= MIN_SAMPLE_SIZE;
}

module.exports = { compareWindows, hasMinimumSampleSize, MIN_SAMPLE_SIZE };
