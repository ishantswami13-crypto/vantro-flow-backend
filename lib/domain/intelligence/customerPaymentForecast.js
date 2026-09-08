// FILE: lib/domain/intelligence/customerPaymentForecast.js
// STARLANE Forecasting Core — Part 7: Customer payment forecasting.
// Per-customer expected settlement WINDOW (never a false-exact single day),
// built from real resolved invoices (invoice_date + payment_date both present,
// payment_status = 'Paid'). Reuses variables.js's honesty-by-sample-size
// language (1-2 points => DIRECTIONAL/LIMITED, never "high-confidence trend").

const { getPool } = require('../../db/pg');
const { historicalMedianModel } = require('./naiveBaselines');
const { assessUncertainty } = require('./uncertainty');

function daysBetween(a, b) {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000);
}

/**
 * Real resolved days-to-pay series for one customer, ascending by invoice_date.
 * Only rows with BOTH invoice_date and payment_date are used — never estimated.
 */
async function getResolvedDaysToPay(userId, customerId) {
  const pool = getPool();
  const res = await pool.query(
    `SELECT id, invoice_date, payment_date, invoice_amount
     FROM invoices
     WHERE user_id = $1 AND customer_id = $2
       AND payment_status = 'Paid' AND invoice_date IS NOT NULL AND payment_date IS NOT NULL
     ORDER BY invoice_date ASC`,
    [userId, customerId]
  );
  return res.rows
    .map(r => ({ id: r.id, date: r.invoice_date, value: daysBetween(r.invoice_date, r.payment_date), amount: Number(r.invoice_amount || 0) }))
    .filter(r => Number.isFinite(r.value) && r.value >= 0);
}

/**
 * Expected settlement WINDOW for a customer — a range built from the real
 * historical median days-to-pay, never a single false-exact day.
 * asOf: optional ISO cutoff — if given, only invoices with invoice_date <= asOf
 * are used (so this function is safe to call from a backtest at cutoff T).
 */
async function forecastCustomerPaymentWindow(userId, customerId, { asOf = null } = {}) {
  let series = await getResolvedDaysToPay(userId, customerId);
  if (asOf) series = series.filter(p => new Date(p.date) <= new Date(asOf));

  if (series.length === 0) {
    return {
      customerId, status: 'INSUFFICIENT_DATA',
      reason: 'no resolved (Paid, with both invoice_date and payment_date) invoices exist for this customer',
      window: null, confidenceLanguage: 'UNKNOWN', uncertainty: assessUncertainty({ sampleSize: 0 }),
    };
  }

  const model = historicalMedianModel(series);
  const n = series.length;
  // Reuse variables.js's own honesty discipline for sample-size language.
  const confidenceLanguage = n === 1 ? 'SINGLE_POINT_LIMITED' : n === 2 ? 'DIRECTIONAL_LIMITED' : 'MODERATE_SAMPLE';

  const uncertainty = assessUncertainty({
    sourceReliability: 'VERIFIED', // invoices table, first-party
    recencyDays: daysBetween(series[series.length - 1].date, asOf || new Date().toISOString()),
    sampleSize: n,
    relationshipCertainty: 'VERIFIED',
    missingContextCount: 0,
  });

  return {
    customerId,
    status: 'FORECASTED',
    sampleSize: n,
    expectedDaysToPay: Math.round(model.prediction),
    window: { lowDays: Math.max(0, Math.round(model.interval.low)), highDays: Math.round(model.interval.high) },
    confidenceLanguage,
    languageNote: n <= 2
      ? `Only ${n} real resolved payment(s) exist for this customer — this is a ${confidenceLanguage === 'SINGLE_POINT_LIMITED' ? 'single observed data point' : 'directional 2-point comparison'}, not a statistically confident trend.`
      : `Median of ${n} real resolved payments.`,
    model: { name: model.modelName, version: model.modelVersion },
    evidence: series.map(s => ({ table: 'invoices', id: s.id, daysToPay: s.value, amount: s.amount })),
    uncertainty,
  };
}

module.exports = { getResolvedDaysToPay, forecastCustomerPaymentWindow };
