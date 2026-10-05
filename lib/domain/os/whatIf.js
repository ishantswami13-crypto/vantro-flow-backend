'use strict';
// Business-level what-if for Simulate and Ask Starlane: "what if sales fall
// 20%?". Deterministic and read-only; nothing is stored.
//
// Cash in the next H days comes from two places:
//   1. invoices already open today: a sales change does not touch them;
//   2. invoices raised during the next H days: scaled by the sales change,
//      and only the part this business's customers historically pay within
//      the window counts as cash.
// (2) uses this tenant's own invoice-to-payment lags (empirical CDF), not a
// generic assumption. When there is not enough history it says so instead of
// guessing.

const MIN_PAID_INVOICES = 8;
const SALES_LOOKBACK_DAYS = 90;
const LAG_LOOKBACK_DAYS = 365;
const DAY = 86400000;

function lagCdf(lags) {
  const sorted = [...lags].sort((a, b) => a - b);
  return (d) => {
    if (!sorted.length) return 0;
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] <= d) lo = mid + 1; else hi = mid; }
    return lo / sorted.length;
  };
}

// Expected cash from new sales raised evenly over `days`, given a lag CDF.
function cashFromNewSales(dailySales, days, cdf) {
  let total = 0;
  for (let t = 0; t < days; t++) total += dailySales * cdf(days - t);
  return total;
}

async function salesChangeWhatIf(pool, userId, { changePct, days = 30, asOf = new Date(), baseCurrency = 'INR' } = {}) {
  const change = Number(changePct);
  if (!Number.isFinite(change) || change < -100 || change > 200) {
    const err = new Error('changePct must be a number between -100 and 200 (for example -20 for "sales fall 20%").');
    err.status = 400;
    throw err;
  }
  const horizon = Math.min(180, Math.max(7, Math.round(Number(days) || 30)));
  const now = asOf.getTime();

  // invoice_date / payment_date are text in older schemas: parse here, not in SQL.
  const { rows: all } = await pool.query(
    `SELECT invoice_amount::float8 AS amount, invoice_date::text AS invoice_date, payment_date::text AS payment_date, payment_status
       FROM invoices
      WHERE user_id = $1
        AND COALESCE(NULLIF(currency, ''), $2) = $2
        AND invoice_date IS NOT NULL
        AND COALESCE(payment_status, '') <> 'Cancelled'`,
    [userId, baseCurrency],
  );
  const t = (v) => { const ms = Date.parse(String(v || '').slice(0, 10)); return Number.isFinite(ms) ? ms : null; };
  const rows = all
    .map((r) => ({ ...r, invoiceMs: t(r.invoice_date), paymentMs: t(r.payment_date) }))
    .filter((r) => r.invoiceMs != null && r.invoiceMs <= now && now - r.invoiceMs <= LAG_LOOKBACK_DAYS * DAY);

  const recent = rows.filter((r) => now - r.invoiceMs <= SALES_LOOKBACK_DAYS * DAY);
  const sales90 = recent.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const paid = rows.filter((r) => r.paymentMs != null && String(r.payment_status).toLowerCase() === 'paid');
  const lags = paid.map((r) => Math.max(0, Math.round((r.paymentMs - r.invoiceMs) / DAY)));

  const basis = {
    salesLookbackDays: SALES_LOOKBACK_DAYS,
    invoicesInLookback: recent.length,
    paidInvoicesForTiming: paid.length,
    currency: baseCurrency,
  };

  if (recent.length === 0 || paid.length < MIN_PAID_INVOICES) {
    return {
      status: 'INSUFFICIENT_EVIDENCE',
      changePct: change,
      horizonDays: horizon,
      basis,
      reason: recent.length === 0
        ? `No invoices were raised in the last ${SALES_LOOKBACK_DAYS} days, so there is no sales level to change.`
        : `Only ${paid.length} paid invoices with dates; at least ${MIN_PAID_INVOICES} are needed to know how fast sales turn into cash.`,
      persisted: false,
    };
  }

  const dailySales = sales90 / SALES_LOOKBACK_DAYS;
  const cdf = lagCdf(lags);
  const baseline = cashFromNewSales(dailySales, horizon, cdf);
  const scenario = baseline * (1 + change / 100);
  const medianLag = [...lags].sort((a, b) => a - b)[Math.floor(lags.length / 2)];
  const round = (n) => Math.round(n);
  const inr = (n) => `₹${round(Math.abs(n)).toLocaleString('en-IN')}`;
  const signed = (n) => `${n < 0 ? '−' : '+'}${inr(n)}`;

  return {
    status: 'PROJECTED',
    changePct: change,
    horizonDays: horizon,
    salesPerMonth: round(dailySales * 30),
    scenarioSalesPerMonth: round(dailySales * 30 * (1 + change / 100)),
    cashFromNewSales: { baseline: round(baseline), scenario: round(scenario), delta: round(scenario - baseline) },
    shareCollectedInWindow: Number((baseline / (dailySales * horizon)).toFixed(3)),
    medianDaysToCash: medianLag,
    summary: `If sales ${change < 0 ? 'fall' : 'rise'} ${Math.abs(change)}%, cash from new sales over the next ${horizon} days goes from about ${inr(baseline)} to ${inr(scenario)} (${signed(scenario - baseline)}). Invoices already open are not affected.${baseline < 0.25 * dailySales * horizon ? ` Most of the effect lands after ${horizon} days, because customers take a median ${medianLag} days to pay: over ${horizon + medianLag} days the change is about ${signed((cashFromNewSales(dailySales, horizon + medianLag, cdf)) * change / 100)}.` : ''}`,
    assumptions: [
      `Sales level: the last ${SALES_LOOKBACK_DAYS} days of invoices (₹${round(sales90).toLocaleString('en-IN')}, ${recent.length} invoices), raised evenly over the window.`,
      `Payment timing: your own ${paid.length} paid invoices (median ${medianLag} days from invoice to cash) stay the same.`,
      'Costs, purchases and the bank balance are not modelled; only cash coming in from customers.',
    ],
    basis,
    persisted: false,
  };
}

module.exports = { salesChangeWhatIf, lagCdf, cashFromNewSales, MIN_PAID_INVOICES };
