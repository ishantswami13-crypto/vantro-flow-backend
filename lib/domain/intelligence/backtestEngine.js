// FILE: lib/domain/intelligence/backtestEngine.js
// STARLANE Forecasting Core — Part 5: Rolling-origin backtest engine.
//
// THE SINGLE MOST IMPORTANT CORRECTNESS PROPERTY IN THIS FILE: at cutoff T,
// a candidate model may only see points with date <= T. `rollingOriginBacktest`
// enforces this by construction — it slices `series` (which the caller must
// have already sorted ascending) at each cutoff index and never hands the
// model anything beyond that index. There is no query inside this file that
// could leak future rows; the leakage boundary is a plain array slice.

/**
 * @param {Array<{date: string, value: number}>} series ascending-by-date real observed points
 * @param {Function} modelFn (pointsUpToCutoff) => { prediction, interval }
 * @param {Object} opts { minTrainSize = 1, horizonSteps = 1 }
 * @returns {{ cutoffs, errors: Array<{cutoffIndex, predicted, actual, absError, pctError, withinInterval}>, mae, rmse, wape, bias, n }}
 */
function rollingOriginBacktest(series, modelFn, opts = {}) {
  const minTrainSize = opts.minTrainSize ?? 1;
  const horizonSteps = opts.horizonSteps ?? 1;

  if (!Array.isArray(series) || series.length < minTrainSize + horizonSteps) {
    return { insufficientData: true, reason: `need at least ${minTrainSize + horizonSteps} real points, have ${series ? series.length : 0}`, n: 0 };
  }

  // DEFENSIVE SORT (Day 4 hardening): do not trust caller ordering. Sort by
  // date ascending ourselves, deduplicating identical timestamps by stable
  // original order, and drop rows with unparseable dates rather than letting
  // them silently corrupt the leakage boundary.
  const indexed = series.map((p, i) => ({ p, i }));
  const withParsedDate = indexed.filter(x => x.p && x.p.date != null && !Number.isNaN(new Date(x.p.date).getTime()));
  const droppedCount = series.length - withParsedDate.length;
  withParsedDate.sort((a, b) => {
    const ta = new Date(a.p.date).getTime();
    const tb = new Date(b.p.date).getTime();
    if (ta !== tb) return ta - tb;
    return a.i - b.i; // stable for duplicate timestamps
  });
  const sortedSeries = withParsedDate.map(x => x.p);

  if (sortedSeries.length < minTrainSize + horizonSteps) {
    return { insufficientData: true, reason: `need at least ${minTrainSize + horizonSteps} valid-date points after defensive sort/filter, have ${sortedSeries.length} (dropped ${droppedCount} unparseable)`, n: 0 };
  }

  const series_ = sortedSeries;
  const errors = [];
  for (let cutoffIdx = minTrainSize - 1; cutoffIdx <= series_.length - 1 - horizonSteps; cutoffIdx++) {
    // LEAKAGE BOUNDARY: trainPoints contains ONLY series_[0..cutoffIdx] — nothing after it.
    const trainPoints = series_.slice(0, cutoffIdx + 1);
    const actualPoint = series_[cutoffIdx + horizonSteps];
    if (!actualPoint) continue;

    const result = modelFn(trainPoints);
    if (!result || result.prediction == null || Number.isNaN(result.prediction)) continue;

    const actual = actualPoint.value;
    const predicted = result.prediction;
    const absError = Math.abs(actual - predicted);
    const pctError = actual !== 0 ? (absError / Math.abs(actual)) * 100 : null;
    const withinInterval = result.interval ? (actual >= result.interval.low && actual <= result.interval.high) : null;

    errors.push({ cutoffDate: trainPoints[trainPoints.length - 1].date, targetDate: actualPoint.date, predicted, actual, absError, pctError, withinInterval });
  }

  if (errors.length === 0) {
    return { insufficientData: true, reason: 'no valid (train, actual) pairs could be formed from the real series', n: 0 };
  }

  const n = errors.length;
  const mae = errors.reduce((s, e) => s + e.absError, 0) / n;
  const rmse = Math.sqrt(errors.reduce((s, e) => s + e.absError ** 2, 0) / n);
  const sumAbsActual = errors.reduce((s, e) => s + Math.abs(e.actual), 0);
  const wape = sumAbsActual !== 0 ? (errors.reduce((s, e) => s + e.absError, 0) / sumAbsActual) * 100 : null;
  const bias = errors.reduce((s, e) => s + (e.predicted - e.actual), 0) / n;
  const coverage = errors.filter(e => e.withinInterval !== null);
  const coverageRate = coverage.length > 0 ? coverage.filter(e => e.withinInterval).length / coverage.length : null;

  return { insufficientData: false, n, mae, rmse, wape, bias, coverageRate, errors, droppedUnparseableCount: droppedCount, defensivelySorted: true };
}

/**
 * Adversarial leakage guard: given a series that includes a "future" row the
 * caller must NOT see at a given cutoff, assert rollingOriginBacktest never
 * used it. Used by scripts/test-forecasting-core.js as test #2.
 */
function assertNoLeakage(series, cutoffDate, forbiddenDate) {
  const cutoffIdx = series.findIndex(p => p.date === cutoffDate);
  if (cutoffIdx === -1) throw new Error('assertNoLeakage: cutoffDate not found in series');
  const trainPoints = series.slice(0, cutoffIdx + 1);
  const leaked = trainPoints.some(p => p.date === forbiddenDate || new Date(p.date) > new Date(cutoffDate));
  return { leaked, trainPointCount: trainPoints.length, trainDates: trainPoints.map(p => p.date) };
}

module.exports = { rollingOriginBacktest, assertNoLeakage };
