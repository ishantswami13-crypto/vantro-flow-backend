// FILE: lib/domain/intelligence/naiveBaselines.js
// STARLANE Forecasting Core — Part 3: Naive baselines.
// Plain, explainable, no-ML reference models. Every candidate model in
// modelTournament.js is judged against these — an "advanced" model that
// cannot beat a naive baseline on real backtest data is not allowed to win
// (see modelTournament.js selectWinner()).
//
// Each function takes an ASCENDING-by-date array of real historical numeric
// points: [{ date: ISOString, value: number }] and returns:
//   { prediction, interval: {low, high} | null, requiredData, assumptions, modelName, modelVersion }
// No function ever looks past the last element of `points` — callers are
// responsible for only passing points with date <= as_of (backtestEngine.js
// enforces this at the query layer).

const MODEL_VERSION = '1.0.0';

function stddev(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/** "Tomorrow = today" — last observed value carried forward unchanged. */
function persistenceModel(points) {
  if (!points || points.length === 0) {
    return { prediction: null, interval: null, requiredData: 'at least 1 historical point', insufficientData: true, modelName: 'persistence', modelVersion: MODEL_VERSION };
  }
  const last = points[points.length - 1].value;
  const recent = points.slice(-5).map(p => p.value);
  const sd = stddev(recent);
  return {
    prediction: last,
    interval: { low: last - sd, high: last + sd },
    requiredData: 'at least 1 historical point',
    assumptions: [{ assumption: 'The most recent real observed value persists unchanged.', basis: `last real point = ${last}`, strength: recent.length >= 2 ? 'MODERATE' : 'WEAK' }],
    modelName: 'persistence',
    modelVersion: MODEL_VERSION,
  };
}

/** Historical median of all real points — robust to outliers, used for days-to-pay style targets. */
function historicalMedianModel(points) {
  if (!points || points.length === 0) {
    return { prediction: null, interval: null, requiredData: 'at least 1 historical point', insufficientData: true, modelName: 'historical_median', modelVersion: MODEL_VERSION };
  }
  const values = points.map(p => p.value).slice().sort((a, b) => a - b);
  const mid = Math.floor(values.length / 2);
  const median = values.length % 2 === 0 ? (values[mid - 1] + values[mid]) / 2 : values[mid];
  const sd = stddev(values);
  return {
    prediction: median,
    interval: { low: Math.max(0, median - sd), high: median + sd },
    requiredData: 'at least 1 historical point',
    assumptions: [{ assumption: 'The median of real historical outcomes is the best point estimate for a new similar case.', basis: `median of ${values.length} real point(s)`, strength: values.length >= 3 ? 'MODERATE' : 'WEAK' }],
    modelName: 'historical_median',
    modelVersion: MODEL_VERSION,
  };
}

/** Simple moving average over the last `window` real points. */
function movingAverageModel(points, window = 3) {
  if (!points || points.length === 0) {
    return { prediction: null, interval: null, requiredData: `at least 1 historical point`, insufficientData: true, modelName: 'moving_average', modelVersion: MODEL_VERSION };
  }
  const slice = points.slice(-window).map(p => p.value);
  const avg = slice.reduce((a, b) => a + b, 0) / slice.length;
  const sd = stddev(slice);
  return {
    prediction: avg,
    interval: { low: avg - sd, high: avg + sd },
    requiredData: `at least 1 historical point (uses up to last ${window})`,
    assumptions: [{ assumption: `Average of the last ${slice.length} real point(s) continues.`, basis: `moving average window=${window}, n=${slice.length}`, strength: slice.length >= window ? 'MODERATE' : 'WEAK' }],
    modelName: 'moving_average',
    modelVersion: MODEL_VERSION,
  };
}

/** Weighted moving average — more recent points weighted higher (linear weights). */
function weightedMovingAverageModel(points, window = 3) {
  if (!points || points.length === 0) {
    return { prediction: null, interval: null, requiredData: 'at least 1 historical point', insufficientData: true, modelName: 'weighted_moving_average', modelVersion: MODEL_VERSION };
  }
  const slice = points.slice(-window);
  const weights = slice.map((_, i) => i + 1);
  const weightSum = weights.reduce((a, b) => a + b, 0);
  const wavg = slice.reduce((acc, p, i) => acc + p.value * weights[i], 0) / weightSum;
  const sd = stddev(slice.map(p => p.value));
  return {
    prediction: wavg,
    interval: { low: wavg - sd, high: wavg + sd },
    requiredData: `at least 1 historical point (uses up to last ${window}, recency-weighted)`,
    assumptions: [{ assumption: 'More recent real points are more predictive than older ones.', basis: `linear weights 1..${weights.length} over n=${slice.length}`, strength: slice.length >= window ? 'MODERATE' : 'WEAK' }],
    modelName: 'weighted_moving_average',
    modelVersion: MODEL_VERSION,
  };
}

/** Simple exponential smoothing, alpha default 0.4. */
function simpleExponentialSmoothingModel(points, alpha = 0.4) {
  if (!points || points.length === 0) {
    return { prediction: null, interval: null, requiredData: 'at least 1 historical point', insufficientData: true, modelName: 'exp_smoothing', modelVersion: MODEL_VERSION };
  }
  let level = points[0].value;
  for (let i = 1; i < points.length; i++) {
    level = alpha * points[i].value + (1 - alpha) * level;
  }
  const sd = stddev(points.map(p => p.value));
  return {
    prediction: level,
    interval: { low: level - sd, high: level + sd },
    requiredData: 'at least 1 historical point (more points improve the smoothed level)',
    assumptions: [{ assumption: `Exponentially-weighted recent history (alpha=${alpha}) approximates the current level.`, basis: `n=${points.length} real points`, strength: points.length >= 4 ? 'MODERATE' : 'WEAK' }],
    modelName: 'exp_smoothing',
    modelVersion: MODEL_VERSION,
  };
}

/** Simple linear trend (least squares over index vs value) projected `stepsAhead` beyond the last point. */
function simpleTrendModel(points, stepsAhead = 1) {
  if (!points || points.length < 2) {
    return { prediction: points && points.length === 1 ? points[0].value : null, interval: null, requiredData: 'at least 2 historical points', insufficientData: points.length < 2, modelName: 'simple_trend', modelVersion: MODEL_VERSION };
  }
  const n = points.length;
  const xs = points.map((_, i) => i);
  const ys = points.map(p => p.value);
  const xMean = xs.reduce((a, b) => a + b, 0) / n;
  const yMean = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - xMean) * (ys[i] - yMean); den += (xs[i] - xMean) ** 2; }
  const slope = den === 0 ? 0 : num / den;
  const intercept = yMean - slope * xMean;
  const predX = (n - 1) + stepsAhead;
  const prediction = intercept + slope * predX;
  const residuals = ys.map((y, i) => y - (intercept + slope * xs[i]));
  const sd = stddev(residuals);
  return {
    prediction,
    interval: { low: prediction - sd, high: prediction + sd },
    requiredData: 'at least 2 historical points',
    assumptions: [{ assumption: 'The linear slope observed across real historical points continues.', basis: `least-squares slope=${slope.toFixed(4)} over n=${n} real points`, strength: n >= 4 ? 'MODERATE' : 'WEAK' }],
    modelName: 'simple_trend',
    modelVersion: MODEL_VERSION,
  };
}

module.exports = {
  persistenceModel,
  historicalMedianModel,
  movingAverageModel,
  weightedMovingAverageModel,
  simpleExponentialSmoothingModel,
  simpleTrendModel,
  MODEL_VERSION,
};
