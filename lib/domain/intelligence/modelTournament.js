// FILE: lib/domain/intelligence/modelTournament.js
// STARLANE Forecasting Core — Part 4: Model tournament.
// Runs every candidate model through backtestEngine.rollingOriginBacktest
// against the SAME real series, and picks a winner using WAPE (falls back to
// MAE when WAPE is null, e.g. all-zero actuals). The baseline (persistence,
// by default) is included as a candidate like any other — it is never
// artificially demoted. If the baseline has the lowest error, it wins.

const { rollingOriginBacktest } = require('./backtestEngine');
const naive = require('./naiveBaselines');
const { externalAwareIntervalModel } = require('./externalAwareForecast');

function defaultCandidates() {
  return [
    { name: 'persistence', isBaseline: true, fn: (pts) => naive.persistenceModel(pts) },
    { name: 'historical_median', isBaseline: false, fn: (pts) => naive.historicalMedianModel(pts) },
    { name: 'moving_average', isBaseline: false, fn: (pts) => naive.movingAverageModel(pts, 3) },
    { name: 'weighted_moving_average', isBaseline: false, fn: (pts) => naive.weightedMovingAverageModel(pts, 3) },
    { name: 'exp_smoothing', isBaseline: false, fn: (pts) => naive.simpleExponentialSmoothingModel(pts, 0.4) },
    { name: 'simple_trend', isBaseline: false, fn: (pts) => naive.simpleTrendModel(pts, 1) },
  ];
}

/**
 * World Intelligence Expansion, Part 28 — same defaultCandidates() set plus
 * the external-aware candidate. Kept as a SEPARATE opt-in list (not merged
 * into defaultCandidates()) so every existing caller of runTournament(series)
 * with no explicit candidates argument is completely unaffected — this is
 * additive, not a change to default tournament behavior.
 */
function candidatesWithExternalAware() {
  return [
    ...defaultCandidates(),
    { name: 'external_aware_v1', isBaseline: false, fn: (pts) => externalAwareIntervalModel(pts) },
  ];
}

/**
 * @param {Array<{date,value}>} series ascending real points
 * @param {Array} candidates optional override of defaultCandidates()
 * @returns {{ insufficientData?:boolean, reason?, results: [{name,isBaseline,backtest}], winner, baselineName, comparisonBasis }}
 */
function runTournament(series, candidates = defaultCandidates(), opts = {}) {
  const results = candidates.map(c => ({
    name: c.name,
    isBaseline: !!c.isBaseline,
    backtest: rollingOriginBacktest(series, c.fn, opts),
  }));

  const usable = results.filter(r => !r.backtest.insufficientData);
  if (usable.length === 0) {
    return {
      insufficientData: true,
      reason: 'no candidate model produced a usable backtest — real history is too short for rolling-origin evaluation',
      results,
      winner: null,
      baselineName: candidates.find(c => c.isBaseline)?.name || null,
    };
  }

  const scoreOf = (r) => (r.backtest.wape != null ? r.backtest.wape : r.backtest.mae);
  const ranked = usable.slice().sort((a, b) => scoreOf(a) - scoreOf(b));
  const winner = ranked[0];
  const baseline = results.find(r => r.isBaseline);

  return {
    insufficientData: false,
    results,
    winner: { name: winner.name, isBaseline: winner.isBaseline, score: scoreOf(winner), n: winner.backtest.n },
    baselineName: baseline ? baseline.name : null,
    baselineBeaten: baseline && !baseline.backtest.insufficientData ? scoreOf(winner) < scoreOf(baseline) || winner.name === baseline.name : null,
    comparisonBasis: 'WAPE (falls back to MAE if WAPE undefined, e.g. all-zero actuals); lower is better',
  };
}

module.exports = { runTournament, defaultCandidates, candidatesWithExternalAware };
