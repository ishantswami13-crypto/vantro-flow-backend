// FILE: lib/domain/os/objectives.js
// WATCH: objectives are persistent targets ("overdue share <= 8%") that
// Starlane evaluates now and forecasts forward, so a breach is flagged
// before it happens.
//
// Pure: evaluation takes an as-of state and a behaviour model, never the
// clock or the database. Forecasts are Monte Carlo over the Payment
// Behaviour Engine (decisions/behavior.js) with a seed derived from the
// objective, so the same data always gives the same answer.

const { DAY, quantile, round } = require('./stats');
const { samplePaymentDay } = require('../decisions/behavior');
const { mulberry32, seedFrom } = require('../decisions/rng');

const ITERATIONS = 400;
const HEALTH = ['ON_TRACK', 'AT_RISK', 'OFF_TRACK', 'UNKNOWN'];
const AUTOPILOT_MODES = ['WATCH', 'RECOMMEND', 'PREPARE', 'EXECUTE_WITH_APPROVAL', 'EXECUTE_WITHIN_POLICY'];

const METRICS = {
  overdue_share_pct: { label: 'Overdue share of receivables', unit: '%', better: 'lower' },
  overdue_amount: { label: 'Overdue receivables', unit: 'currency', better: 'lower' },
  dso_days: { label: 'Days sales outstanding', unit: 'days', better: 'lower' },
  collected_30d: { label: 'Collected in 30 days', unit: 'currency', better: 'higher' },
  cash_balance: { label: 'Cash balance', unit: 'currency', better: 'higher', requires: 'bank feed' },
};

function breaches(value, operator, target) {
  if (value == null) return null;
  return operator === '<=' ? value > target : value < target;
}

function billingRatePerDay(state) {
  const from = state.asOfDay - 90 * DAY;
  const billed = state.invoices.filter((i) => i.invoiceDay > from && i.currency === state.baseCurrency).reduce((a, i) => a + i.amount, 0);
  return billed / 90;
}

function currentValue(metricKey, state, overdueAfterDays) {
  const base = state.invoices.filter((i) => i.currency === state.baseCurrency);
  const open = base.filter((i) => i.outstanding > 0);
  const openAmount = open.reduce((a, i) => a + i.outstanding, 0);
  const overdue = open.filter((i) => i.ageDays != null && i.ageDays > overdueAfterDays).reduce((a, i) => a + i.outstanding, 0);
  switch (metricKey) {
    case 'overdue_share_pct': return openAmount > 0 ? round((overdue / openAmount) * 100, 1) : 0;
    case 'overdue_amount': return round(overdue);
    case 'dso_days': {
      const rate = billingRatePerDay(state);
      return rate > 0 ? round(openAmount / rate, 1) : null;
    }
    case 'collected_30d': {
      const from = state.asOfDay - 30 * DAY;
      return round(base.filter((i) => i.paidDay != null && i.paidDay > from).reduce((a, i) => a + i.paidAmount, 0));
    }
    default: return null;
  }
}

/**
 * Monte Carlo forward view at checkpoints up to the horizon.
 * Assumptions (reported on every forecast): disputed invoices are not paid
 * inside the horizon; new invoices keep arriving at the last 90 days'
 * average rate on the median credit terms and are not yet overdue while
 * inside those terms.
 */
function forecast(metricKey, state, behavior, { horizonDays, overdueAfterDays, seedKey }) {
  const checkpoints = [];
  for (let d = 7; d < horizonDays; d += 7) checkpoints.push(d);
  checkpoints.push(horizonDays);
  const base = state.invoices.filter((i) => i.currency === state.baseCurrency && i.outstanding > 0);
  const rate = billingRatePerDay(state);
  const terms = base.filter((i) => i.dueDay != null).map((i) => (i.dueDay - i.invoiceDay) / DAY);
  const medianTerms = quantile(terms, 0.5) ?? 30;
  // Share of past invoices not paid by their due date, applied to new
  // invoices that fall due inside the window.
  const settled = state.invoices.filter((i) => i.status === 'paid' && i.paidDay != null && i.dueDay != null);
  const lateShare = settled.length ? settled.filter((i) => i.paidDay > i.dueDay).length / settled.length : 0.5;
  const rand = mulberry32(seedFrom(seedKey));
  const samples = checkpoints.map(() => []);

  for (let it = 0; it < ITERATIONS; it++) {
    const paidOn = base.map((inv) => {
      if (inv.disputeOpen || inv.ageDays == null) return -1;
      const model = behavior.customers.get(inv.customerKey) || behavior.tenant;
      return samplePaymentDay(model.daily, inv.ageDays, horizonDays, rand());
    });
    checkpoints.forEach((t, k) => {
      let open = 0;
      let overdue = 0;
      let collected = 0;
      base.forEach((inv, n) => {
        const paid = paidOn[n] >= 0 && paidOn[n] < t;
        if (paid) { collected += inv.outstanding; return; }
        open += inv.outstanding;
        if (inv.ageDays != null && inv.ageDays + t > overdueAfterDays) overdue += inv.outstanding;
      });
      // New billing inside the window.
      const newOpen = rate * t;
      const newOverdue = medianTerms < t ? rate * (t - medianTerms) * lateShare : 0;
      open += newOpen;
      overdue += newOverdue;
      let v;
      if (metricKey === 'overdue_share_pct') v = open > 0 ? (overdue / open) * 100 : 0;
      else if (metricKey === 'overdue_amount') v = overdue;
      else if (metricKey === 'dso_days') v = rate > 0 ? open / rate : null;
      else if (metricKey === 'collected_30d') v = (collected / t) * 30;
      samples[k].push(v);
    });
  }

  return {
    iterations: ITERATIONS,
    points: checkpoints.map((t, k) => ({
      day: t,
      p10: round(quantile(samples[k], 0.1), 1),
      p50: round(quantile(samples[k], 0.5), 1),
      p90: round(quantile(samples[k], 0.9), 1),
    })),
    samplesAtHorizon: samples[samples.length - 1],
    assumptions: [
      'Disputed invoices are not paid inside the horizon.',
      `New invoices keep arriving at the last 90 days' average (${Math.round(rate).toLocaleString('en-IN')} a day) on ${Math.round(medianTerms)}-day terms, and ${Math.round(lateShare * 100)}% of them are paid late, as in the past.`,
      'Each customer pays like their own history, shrunk towards the business-wide pattern when they have little history.',
    ],
  };
}

/**
 * @returns {{health, currentValue, forecast, breachProbability, breachInDays, confidence, evidence, explanation}}
 */
function evaluateObjective(objective, state, behavior, { overdueAfterDays = 0, freshness = null } = {}) {
  const meta = METRICS[objective.metric_key];
  const target = Number(objective.target);
  const op = objective.operator;
  const base = { metric: objective.metric_key, metricLabel: meta?.label || objective.metric_key, unit: meta?.unit, target, operator: op, horizonDays: objective.horizon_days };

  if (!meta) return { ...base, health: 'UNKNOWN', explanation: 'Starlane does not know how to measure this metric.', evidence: [], confidence: { level: 'NONE', reasons: ['unsupported metric'] } };
  if (meta.requires) return { ...base, health: 'UNKNOWN', explanation: `Needs a ${meta.requires}, which is not connected. Connect it in Bridge.`, evidence: [], confidence: { level: 'NONE', reasons: [`no ${meta.requires}`] } };

  const withDue = state.invoices.filter((i) => i.dueDay != null && i.currency === state.baseCurrency);
  if (!state.invoices.length || !withDue.length) {
    return { ...base, health: 'UNKNOWN', explanation: 'No invoices with due dates yet, so this cannot be measured.', evidence: [], confidence: { level: 'NONE', reasons: ['no data'] } };
  }

  const reasons = [];
  let level = 'HIGH';
  if (freshness?.status === 'STALE') {
    return { ...base, health: 'UNKNOWN', currentValue: currentValue(objective.metric_key, state, overdueAfterDays), explanation: `The receivables data is stale (${freshness.detail}). Re-import before trusting this.`, evidence: [], confidence: { level: 'LOW', reasons: ['stale data'] } };
  }
  if (freshness?.status === 'AGING') { level = 'MEDIUM'; reasons.push(freshness.detail); }
  if (behavior.tenant.paidSamples < 20) { level = level === 'HIGH' ? 'MEDIUM' : 'LOW'; reasons.push(`Only ${behavior.tenant.paidSamples} paid invoices with dates to learn payment behaviour from`); }

  const now = currentValue(objective.metric_key, state, overdueAfterDays);
  const fc = forecast(objective.metric_key, state, behavior, { horizonDays: objective.horizon_days, overdueAfterDays, seedKey: `${objective.id}|${state.asOfDay}` });
  const breachAtHorizon = fc.samplesAtHorizon.filter((v) => breaches(v, op, target)).length / fc.samplesAtHorizon.length;
  const firstBreach = fc.points.find((p) => breaches(p.p50, op, target));
  delete fc.samplesAtHorizon;

  let health;
  let explanation;
  const fmt = (v) => (meta.unit === '%' ? `${v}%` : meta.unit === 'days' ? `${v} days` : `${Math.round(v).toLocaleString('en-IN')} ${state.baseCurrency}`);
  const horizon = fc.points[fc.points.length - 1];
  if (breaches(now, op, target)) {
    health = 'OFF_TRACK';
    explanation = `${meta.label} is ${fmt(now)} now, against a target of ${op === '<=' ? 'at most' : 'at least'} ${fmt(target)}.`;
  } else if (firstBreach) {
    health = 'AT_RISK';
    explanation = `${meta.label} is ${fmt(now)} now but is forecast to reach ${fmt(firstBreach.p50)} in about ${firstBreach.day} days, past the target of ${fmt(target)}.`;
  } else {
    health = 'ON_TRACK';
    explanation = `${meta.label} is ${fmt(now)} and forecast at ${fmt(horizon.p50)} in ${horizon.day} days (range ${fmt(horizon.p10)} to ${fmt(horizon.p90)}), inside the target.`;
    if (breachAtHorizon >= 0.2) explanation += ` There is a ${Math.round(breachAtHorizon * 100)}% chance it breaches.`;
  }

  return {
    ...base,
    health,
    currentValue: now,
    forecast: fc,
    breachProbability: round(breachAtHorizon, 3),
    breachInDays: firstBreach ? firstBreach.day : null,
    explanation,
    confidence: { level, reasons },
    evidence: [
      { label: 'Invoices measured', value: state.invoices.filter((i) => i.currency === state.baseCurrency).length, source: 'ledger' },
      { label: 'Paid invoices behind the forecast', value: behavior.tenant.paidSamples, source: 'ledger' },
      ...(freshness ? [{ label: 'Freshness', value: freshness.detail, source: 'Bridge' }] : []),
    ],
  };
}

function autopilotTemplates({ hasDueDates, hasInventory, hasBank }) {
  return [
    {
      key: 'COLLECTIONS_AUTOPILOT',
      name: 'Collections autopilot',
      objective: { metric_key: 'overdue_share_pct', operator: '<=', suggestedTarget: 15, horizon_days: 30 },
      workflow: 'receivables_followup',
      availability: hasDueDates ? 'SUPPORTED' : 'BLOCKED',
      detail: hasDueDates ? 'Watches the overdue share and runs the overdue follow-up workflow. Reminders are prepared for your approval; sending is manual.' : 'Needs invoices with due dates. Import them in Bridge.',
    },
    { key: 'CASH_AUTOPILOT', name: 'Cash autopilot', availability: 'BLOCKED', detail: hasBank ? 'No cash workflow has been built yet.' : 'Needs a bank feed, which is not connected.' },
    { key: 'INVENTORY_AUTOPILOT', name: 'Inventory autopilot', availability: 'BLOCKED', detail: hasInventory ? 'Stock data exists, but the replenishment workflow is not built yet.' : 'Needs stock levels from Tally or another source.' },
    { key: 'SUPPLIER_AUTOPILOT', name: 'Supplier autopilot', availability: 'BLOCKED', detail: 'Needs supplier lead times and purchase orders, which are not connected.' },
    { key: 'FULFILMENT_AUTOPILOT', name: 'Fulfilment autopilot', availability: 'BLOCKED', detail: 'Needs order and dispatch data, which is not connected.' },
  ];
}

module.exports = { evaluateObjective, currentValue, forecast, autopilotTemplates, breaches, METRICS, HEALTH, AUTOPILOT_MODES };
