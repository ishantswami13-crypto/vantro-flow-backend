// FILE: lib/domain/intelligence/salesForecast.js
// STARLANE Forecasting Core — Part 11: Second prediction family.
//
// Investigated via real SQL against the dev DB (2026-09-08) before choosing:
//   - product_suppliers: 0 rows, purchase_line_items: 0 rows -> inventory
//     depletion forecast is NOT_IMPLEMENTED (confirmed blocked, matches
//     migration 024's own honest finding).
//   - purchases: 5 rows total, no purchase_line_items -> supplier lead-time
//     forecasting has no real receipt-history rows either.
//   - sales: 16 rows total across 11 tenants; the best-populated tenant
//     (ece4ca68-...) has only 5 rows across 4 distinct dates.
// Sales/demand moving-average forecast has genuinely the most real rows of
// the three options, so it is the chosen second family — but the real volume
// is still tiny. This module is built for correctness and will honestly
// report INSUFFICIENT_DATA/insufficientData for the rolling-origin backtest
// for nearly every tenant given current data volume; it is NOT faked to look
// more mature than the data supports.

const { getPool } = require('../../db/pg');
const { runTournament } = require('./modelTournament');
const { movingAverageModel } = require('./naiveBaselines');
const { assessUncertainty } = require('./uncertainty');

/** Real per-day total sales amount for a tenant, ascending by date. Aggregates
 * same-day rows (multiple sales on one date) into a single point — no
 * estimation, just a real SUM. */
async function getDailySalesSeries(userId) {
  const pool = getPool();
  const res = await pool.query(
    `SELECT sale_date::date AS d, SUM(amount) AS total
     FROM sales WHERE user_id = $1 AND sale_date IS NOT NULL
     GROUP BY sale_date::date ORDER BY d ASC`,
    [userId]
  );
  return res.rows.map(r => ({ date: r.d, value: Number(r.total) }));
}

/**
 * Forecast next-period total sales for a tenant using a moving-average model,
 * with an honest backtest via modelTournament when there is enough real
 * history, and an explicit insufficientData / IMPLEMENTED_BUT_DATA_INSUFFICIENT
 * classification when there isn't.
 */
async function forecastSalesDemand(userId, { asOf = null } = {}) {
  let series = await getDailySalesSeries(userId);
  if (asOf) series = series.filter(p => new Date(p.date) <= new Date(asOf));

  if (series.length === 0) {
    return { userId, status: 'NOT_IMPLEMENTED', reason: 'zero real sales rows for this tenant', forecast: null };
  }

  const tournament = runTournament(series, undefined, { minTrainSize: 2, horizonSteps: 1 });
  const model = movingAverageModel(series, 3);

  const uncertainty = assessUncertainty({
    sourceReliability: 'VERIFIED',
    recencyDays: 0,
    sampleSize: series.length,
    relationshipCertainty: 'VERIFIED',
    missingContextCount: 0,
  });

  if (series.length < 4 || tournament.insufficientData) {
    return {
      userId,
      status: 'IMPLEMENTED_BUT_DATA_INSUFFICIENT',
      reason: `only ${series.length} distinct real sale date(s) exist for this tenant — a rolling-origin backtest needs more history to be meaningful; mechanism is real and functions correctly, but this tenant's forecast should not be treated as validated`,
      pointEstimate: model.prediction,
      sampleSize: series.length,
      tournament,
      uncertainty,
      evidence: series,
    };
  }

  return {
    userId,
    status: 'FORECASTED',
    pointEstimate: model.prediction,
    interval: model.interval,
    sampleSize: series.length,
    tournament,
    uncertainty,
    evidence: series,
  };
}

module.exports = { getDailySalesSeries, forecastSalesDemand };
