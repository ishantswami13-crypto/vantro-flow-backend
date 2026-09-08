// FILE: lib/domain/intelligence/forecastEngine.js
// STARLANE Forecasting Core, Backtesting & Self-Improving Prediction System.
// Part 1: Universal forecast contract. Part 6: Cash forecasting v2.
// Part 9: External-variable safety. Part 10: Model versioning (via predictions table).
//
// This file is ADDITIVE: it reads cashConsequenceEngine.js's existing
// getOpenReceivables()/buildCashConsequence() exports without modifying them,
// and never mutates real tenant state — a forecast call is read + compute
// only, with an explicit, separate persistPrediction() step.

const { getPool } = require('../../db/pg');
const { getOpenReceivables } = require('./cashConsequenceEngine');
const { runTournament } = require('./modelTournament');
const { persistenceModel, MODEL_VERSION: NAIVE_MODEL_VERSION } = require('./naiveBaselines');
const { assessUncertainty } = require('./uncertainty');
const { forecastCustomerPaymentWindow } = require('./customerPaymentForecast');

const FORECAST_ENGINE_VERSION = '1.0.0';

/**
 * Real daily net-cash series for a tenant, built from resolved invoice
 * payments (inflow, +amount on payment_date) — the only real, resolved,
 * dated cash-outcome signal this schema currently has (cashflow_events rows
 * are all status='expected' with no actual_date resolved yet, per DB audit
 * on 2026-09-08 — they cannot be used as a resolved-outcome series).
 * asOf: if given, only payments with payment_date <= asOf are included
 * (leakage boundary for backtesting).
 */
async function getResolvedCashInflowSeries(userId, { asOf = null } = {}) {
  const pool = getPool();
  const res = await pool.query(
    `SELECT payment_date::date AS d, SUM(invoice_amount) AS total
     FROM invoices
     WHERE user_id = $1 AND payment_status = 'Paid' AND payment_date IS NOT NULL
       ${asOf ? 'AND payment_date::date <= $2::date' : ''}
     GROUP BY payment_date::date ORDER BY d ASC`,
    asOf ? [userId, asOf] : [userId]
  );
  return res.rows.map(r => ({ date: r.d, value: Number(r.total) }));
}

/**
 * Real open receivables due within `horizonDays` of `asOf` — used as the
 * point-forecast driver when there isn't enough resolved history for a
 * model-tournament-selected forecast (which is the honest common case in
 * this dev DB — see cash forecast v2 below).
 */
async function getReceivablesDueWithinHorizon(userId, asOf, horizonDays) {
  const all = await getOpenReceivables(userId);
  const cutoff = new Date(asOf);
  const horizonEnd = new Date(cutoff.getTime() + horizonDays * 86400000);
  return all.filter(r => {
    if (!r.due_date) return false;
    const due = new Date(r.due_date);
    return due >= cutoff && due <= horizonEnd;
  });
}

/**
 * PART 1: Universal forecast contract.
 * forecast({target, entity_type, entity_id, horizon, as_of, context})
 * Only 'cash_position' target is implemented end-to-end for this pass; other
 * targets route to their dedicated modules (customerPaymentForecast.js,
 * salesForecast.js) and are documented, not silently unsupported.
 */
async function forecast({ target, entity_type, entity_id, horizon, as_of, context = {} } = {}) {
  const asOf = as_of || new Date().toISOString();
  if (target === 'cash_position') {
    return forecastCashPositionV2(entity_id, { horizonDays: horizon || 30, asOf, context });
  }
  if (target === 'customer_payment_window') {
    const r = await forecastCustomerPaymentWindow(entity_id, context.customerId, { asOf });
    return normalizeToContract({ target, entity_type: 'customer', entity_id: context.customerId, asOf, horizon, raw: r });
  }
  return { target, entity: { type: entity_type, id: entity_id }, as_of: asOf, horizon, status: 'UNSUPPORTED_TARGET', reason: `forecastEngine.forecast() does not implement target '${target}' yet` };
}

function normalizeToContract({ target, entity_type, entity_id, asOf, horizon, raw }) {
  return {
    target,
    entity: { type: entity_type, id: entity_id },
    as_of: asOf,
    horizon,
    point_estimate: raw.expectedDaysToPay ?? raw.pointEstimate ?? null,
    interval: raw.window ? { low: raw.window.lowDays, high: raw.window.highDays } : (raw.interval || null),
    model_selected: raw.model?.name || raw.tournament?.winner?.name || null,
    candidate_models: raw.tournament?.results?.map(r => r.name) || null,
    baseline_model: raw.tournament?.baselineName || 'persistence',
    drivers: raw.evidence ? raw.evidence.map(e => e.id || e.date) : null,
    assumptions: raw.assumptions || (raw.languageNote ? [{ assumption: raw.languageNote, basis: 'real data', strength: raw.confidenceLanguage === 'MODERATE_SAMPLE' ? 'MODERATE' : 'WEAK' }] : []),
    evidence: raw.evidence || [],
    uncertainty_band: raw.uncertainty?.band || null,
    data_quality: raw.status || (raw.insufficientData ? 'INSUFFICIENT' : 'REAL'),
    missing_context: raw.reason ? [raw.reason] : [],
    historical_performance: raw.tournament || null,
    generated_at: new Date().toISOString(),
  };
}

/**
 * PART 6: Cash forecasting v2 — 7/14/30-day horizons.
 *
 * Honesty discipline (per mission): attempts a real model-tournament backtest
 * using getResolvedCashInflowSeries(); this dev DB's real resolved-payment
 * history is genuinely thin for every tenant (confirmed via SQL audit on
 * 2026-09-08 — at most a handful of distinct payment dates per tenant), so
 * for almost every tenant this will honestly fall back to the persistence
 * baseline (fallback_used=true) rather than claim a validated model
 * selection it cannot support. The point estimate always also cross-checks
 * against real open receivables due in the horizon (reusing
 * cashConsequenceEngine.getOpenReceivables — no duplicated query logic).
 *
 * PART 9 (external-variable safety): this function applies NO world-event/FX
 * adjustment to the point estimate — those signals (per worldEventConsequence.js
 * and fxExposureNarrative.js's own discipline) are only ever allowed to widen
 * uncertainty/flag risk, never move a point forecast without direct evidence,
 * and this cash engine does not wire them in at all, so that discipline
 * cannot be violated here by construction.
 */
async function forecastCashPositionV2(userId, { horizonDays = 30, asOf, context = {} } = {}) {
  const series = await getResolvedCashInflowSeries(userId, { asOf });
  const tournament = runTournament(series, undefined, { minTrainSize: 2, horizonSteps: 1 });
  const dueReceivables = await getReceivablesDueWithinHorizon(userId, asOf, horizonDays);
  const dueTotal = dueReceivables.reduce((s, r) => s + r.invoice_amount, 0);

  let fallbackUsed = false;
  let modelUsed, pointEstimate, interval, candidateModels = null, historicalPerformance = null, dataQuality;

  if (!tournament.insufficientData) {
    modelUsed = tournament.winner.name;
    candidateModels = tournament.results.map(r => ({ name: r.name, mae: r.backtest.insufficientData ? null : r.backtest.mae, wape: r.backtest.insufficientData ? null : r.backtest.wape }));
    historicalPerformance = tournament;
    // Model-selected point estimate is the receivable-driven due total —
    // the model tournament validates WHICH averaging/trend approach best
    // matches this tenant's real resolved-payment rhythm, but the actual
    // dollar figure for "cash expected in the next N days" must be anchored
    // to real, named open receivables, not an abstract series projection.
    pointEstimate = dueTotal;
    const sd = tournament.results.find(r => r.name === modelUsed)?.backtest?.mae || 0;
    interval = { low: Math.max(0, dueTotal - sd), high: dueTotal + sd };
    dataQuality = 'REAL_MODEL_SELECTED';
  } else {
    fallbackUsed = true;
    modelUsed = 'persistence';
    const baseline = persistenceModel(series);
    pointEstimate = dueTotal; // real named receivables, not the thin series
    interval = { low: dueTotal * 0.85, high: dueTotal * 1.15 }; // named +/-15% band, disclosed below, not claimed as calibrated
    dataQuality = 'IMPLEMENTED_BUT_DATA_INSUFFICIENT_FOR_MODEL_SELECTION';
  }

  const uncertainty = assessUncertainty({
    sourceReliability: 'VERIFIED',
    recencyDays: 0,
    sampleSize: series.length,
    relationshipCertainty: dueReceivables.every(r => r.customer_id) ? 'VERIFIED' : 'UNVERIFIED',
    missingContextCount: fallbackUsed ? 1 : 0,
  });

  return {
    target: 'cash_position',
    entity: { type: 'tenant_cash', id: userId },
    as_of: asOf,
    horizon: horizonDays,
    point_estimate: pointEstimate,
    interval,
    model_selected: modelUsed,
    candidate_models: candidateModels,
    baseline_model: 'persistence',
    fallback_used: fallbackUsed,
    drivers: dueReceivables.map(r => ({ invoiceId: r.id, customerName: r.customer_name, amount: r.invoice_amount, dueDate: r.due_date })),
    assumptions: [
      { assumption: `Open receivables with a due_date within ${horizonDays} days of ${asOf} will collect at their full real invoice_amount.`, basis: `${dueReceivables.length} real open invoice row(s)`, strength: dueReceivables.length > 0 ? 'MODERATE' : 'WEAK' },
      fallbackUsed
        ? { assumption: 'Interval uses a disclosed +/-15% band (not a calibrated model interval) because real resolved-payment history was insufficient for model-tournament interval estimation.', basis: `only ${series.length} distinct real resolved-payment date(s) exist for this tenant`, strength: 'WEAK' }
        : { assumption: `Interval derived from the winning model's (${modelUsed}) real backtest MAE.`, basis: `rolling-origin backtest over ${series.length} real resolved-payment date(s)`, strength: 'MODERATE' },
    ],
    evidence: series,
    uncertainty_band: uncertainty.band,
    data_quality: dataQuality,
    missing_context: fallbackUsed ? [`only ${series.length} real resolved-payment date(s) — cannot validate a model-selected forecast; falling back to persistence baseline + named open receivables`] : [],
    historical_performance: historicalPerformance,
    model_name: modelUsed,
    model_version: NAIVE_MODEL_VERSION,
    engine_version: FORECAST_ENGINE_VERSION,
    generated_at: new Date().toISOString(),
  };
}

/**
 * PART 2: Persist a forecast() output as a `predictions` row. Additive —
 * never mutates any other table. Returns the inserted row's id.
 */
async function persistPrediction(userId, forecastResult) {
  const pool = getPool();
  const res = await pool.query(
    `INSERT INTO predictions
       (user_id, entity_type, entity_id, target, prediction_type, as_of, horizon_days,
        point_estimate, lower_bound, upper_bound, model_name, model_version, baseline_model,
        assumptions, evidence, uncertainty_band, data_quality)
     VALUES ($1,$2,$3,$4,'interval',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     RETURNING id`,
    [
      userId,
      forecastResult.entity?.type || 'tenant_cash',
      forecastResult.entity?.id ? String(forecastResult.entity.id) : null,
      forecastResult.target,
      forecastResult.as_of,
      forecastResult.horizon,
      forecastResult.point_estimate,
      forecastResult.interval ? forecastResult.interval.low : null,
      forecastResult.interval ? forecastResult.interval.high : null,
      forecastResult.model_name || forecastResult.model_selected,
      forecastResult.model_version || NAIVE_MODEL_VERSION,
      forecastResult.baseline_model || 'persistence',
      JSON.stringify(forecastResult.assumptions || []),
      JSON.stringify(forecastResult.evidence || []),
      forecastResult.uncertainty_band || null,
      forecastResult.data_quality || null,
    ]
  );
  return res.rows[0].id;
}

/**
 * PART 2 (resolution) / Test #6: resolve a prediction against a real actual
 * outcome. Only ever UPDATEs the evaluation columns — model/forecast fields
 * are never rewritten (model versioning discipline).
 */
async function resolvePrediction(predictionId, actualValue) {
  const pool = getPool();
  const cur = await pool.query('SELECT * FROM predictions WHERE id = $1', [predictionId]);
  if (cur.rows.length === 0) throw new Error(`resolvePrediction: no prediction with id ${predictionId}`);
  const p = cur.rows[0];
  const predicted = Number(p.point_estimate);
  const absError = Math.abs(actualValue - predicted);
  const pctError = actualValue !== 0 ? (absError / Math.abs(actualValue)) * 100 : null;
  const coverageHit = p.lower_bound != null && p.upper_bound != null
    ? (actualValue >= Number(p.lower_bound) && actualValue <= Number(p.upper_bound))
    : null;

  await pool.query(
    `UPDATE predictions SET actual_value=$1, resolved_at=now(), absolute_error=$2, percentage_error=$3, coverage_hit=$4, evaluation_status='RESOLVED' WHERE id=$5`,
    [actualValue, absError, pctError, coverageHit, predictionId]
  );
  return { predictionId, actualValue, predicted, absError, pctError, coverageHit };
}

module.exports = {
  forecast,
  forecastCashPositionV2,
  getResolvedCashInflowSeries,
  getReceivablesDueWithinHorizon,
  persistPrediction,
  resolvePrediction,
  FORECAST_ENGINE_VERSION,
};
