'use strict';
// watchEvaluator.js — evaluates a single watch row (metric_key + condition_config)
// against the same real data the /api/ai-chat tools already query (get_overdue,
// get_cash_forecast). Reuses the SAME invoices-table logic instead of a parallel
// data-access path. Supported metric_keys (see migrations/046_watches.sql):
//   - receivables_overdue_amount : sum of outstanding (Pending) invoice amounts
//                                   for the user, optionally filtered by min_days
//                                   overdue, compared against threshold.
//   - cash_forecast_runway_days  : pessimistic-scenario runway (days) from the
//                                   same forecast math as get_cash_forecast,
//                                   compared against threshold.
//   - customer_exposure_amount   : sum of outstanding invoice amounts for one
//                                   customer (condition_config.entity_id /
//                                   entity_name), compared against threshold.
//
// Unknown metric_key values are rejected loudly (thrown Error), never
// silently no-op'd, per the migration's own contract.

const SUPPORTED_METRICS = new Set([
  'receivables_overdue_amount',
  'cash_forecast_runway_days',
  'customer_exposure_amount',
]);

const OPERATORS = {
  gt: (a, b) => a > b,
  gte: (a, b) => a >= b,
  lt: (a, b) => a < b,
  lte: (a, b) => a <= b,
  eq: (a, b) => a === b,
};

function calculateDaysOverdue(dateValue, isPaid = false) {
  if (isPaid || !dateValue) return 0;
  const due = new Date(dateValue);
  if (Number.isNaN(due.getTime())) return 0;
  const today = new Date();
  due.setHours(0, 0, 0, 0);
  today.setHours(0, 0, 0, 0);
  return Math.max(Math.floor((today - due) / (1000 * 60 * 60 * 24)), 0);
}

function applyOperator(operator, value, threshold) {
  const fn = OPERATORS[operator];
  if (!fn) throw new Error(`Unsupported operator "${operator}" in condition_config`);
  return fn(Number(value), Number(threshold));
}

async function metric_receivables_overdue_amount(pool, userId, conditionConfig) {
  const { rows } = await pool.query(
    `SELECT invoice_amount, payment_status, due_date, invoice_date
     FROM invoices WHERE user_id = $1 AND payment_status <> 'Paid'`,
    [userId]
  );
  const minDays = Number(conditionConfig.min_days || 0);
  let total = 0;
  for (const r of rows) {
    const daysOverdue = calculateDaysOverdue(r.due_date || r.invoice_date, false);
    if (daysOverdue >= minDays) total += Number(r.invoice_amount || 0);
  }
  return { value: total, detail: { min_days: minDays, matching_invoices: rows.length } };
}

async function metric_cash_forecast_runway_days(pool, userId, conditionConfig) {
  const days = Number(conditionConfig.days || 30);
  const currentCash = Number(conditionConfig.current_cash || 0);

  const [invoicesRes, bankRes] = await Promise.all([
    pool.query(`SELECT invoice_amount, payment_status, payment_date FROM invoices WHERE user_id = $1`, [userId]),
    pool.query(`SELECT * FROM bank_transactions WHERE user_id = $1`, [userId]).catch(() => ({ rows: [] })),
  ]);
  const invoices = invoicesRes.rows;
  const bankTxns = bankRes.rows || [];

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const thirtyDaysAgoStr = thirtyDaysAgo.toISOString().split('T')[0];

  const recentDebits = bankTxns.filter((t) => t.type === 'debit' && t.txn_date && t.txn_date >= thirtyDaysAgoStr);
  const totalDebitAmount = recentDebits.reduce((s, t) => s + Math.abs(Number(t.amount || 0)), 0);
  const bankBurnRate = recentDebits.length > 0 ? Math.round(totalDebitAmount / 30) : null;

  const outstanding = invoices.filter((i) => i.payment_status !== 'Paid').reduce((s, i) => s + Number(i.invoice_amount || 0), 0);
  const burnRate = bankBurnRate !== null ? bankBurnRate : Math.round(outstanding / 30);

  const paid = invoices.filter((i) => i.payment_status === 'Paid' && i.payment_date);
  const totalRecovered = paid.reduce((s, i) => s + Number(i.invoice_amount || 0), 0);
  const avgDailyCollections = paid.length > 0 ? Math.round(totalRecovered / 90) : Math.round(outstanding * 0.03);

  const pessimisticInflow = Math.round(avgDailyCollections * 0.5);
  const netDaily = pessimisticInflow - burnRate;
  const runwayDays = netDaily >= 0 ? 999 : Math.floor(currentCash / Math.abs(netDaily || 1));

  return { value: runwayDays, detail: { days, burnRate, avgDailyCollections, pessimisticInflow, currentCash } };
}

async function metric_customer_exposure_amount(pool, userId, conditionConfig) {
  const entityName = conditionConfig.entity_name || conditionConfig.customer_name;
  if (!entityName) throw new Error('customer_exposure_amount requires condition_config.entity_name');
  const { rows } = await pool.query(
    `SELECT invoice_amount, payment_status FROM invoices
     WHERE user_id = $1 AND payment_status <> 'Paid' AND customer_name ILIKE $2`,
    [userId, `%${entityName}%`]
  );
  const total = rows.reduce((s, r) => s + Number(r.invoice_amount || 0), 0);
  return { value: total, detail: { entity_name: entityName, matching_invoices: rows.length } };
}

const METRIC_HANDLERS = {
  receivables_overdue_amount: metric_receivables_overdue_amount,
  cash_forecast_runway_days: metric_cash_forecast_runway_days,
  customer_exposure_amount: metric_customer_exposure_amount,
};

/**
 * Evaluate one watch row against real DB data. Returns
 * { value, triggered, detail } and never mutates the DB itself —
 * callers are responsible for persisting the watch_evaluations row and
 * updating watches.last_evaluated_at / last_triggered_at.
 */
async function evaluateWatch(pool, watch) {
  const metricKey = watch.metric_key;
  if (!SUPPORTED_METRICS.has(metricKey)) {
    throw new Error(`Unknown metric_key "${metricKey}" — not implemented by watchEvaluator`);
  }
  const conditionConfig = watch.condition_config || {};
  if (!conditionConfig.operator || conditionConfig.threshold === undefined || conditionConfig.threshold === null) {
    throw new Error('condition_config must include "operator" and "threshold"');
  }
  const handler = METRIC_HANDLERS[metricKey];
  const { value, detail } = await handler(pool, watch.user_id, conditionConfig);
  const triggered = applyOperator(conditionConfig.operator, value, conditionConfig.threshold);
  return { value, triggered, detail };
}

module.exports = { evaluateWatch, SUPPORTED_METRICS, applyOperator, calculateDaysOverdue };
