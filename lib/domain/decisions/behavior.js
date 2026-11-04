// FILE: lib/domain/decisions/behavior.js
// Payment Behaviour Engine: how likely is an open invoice to be paid within
// the next N days, given how long it is already overdue?
//
// Model: an actuarial (weekly) survival table over "days past due at which
// the invoice was paid". Paid invoices are events; still-open invoices are
// censored at their current age, so a customer who simply never pays is not
// mistaken for a fast payer. Each customer's table is shrunk towards the
// tenant-wide table (K_CUSTOMER pseudo-observations), and the tenant table is
// shrunk towards an explicit prior where the tenant has little history. The
// prior is an assumption and is reported as one on every decision that
// depends on it.
//
// Pure: no DB, no clock. Input is a state from snapshot.deriveReceivablesState.

const AXIS_MIN = -91;          // earliest day relative to due date we model
const AXIS_MAX = 728;          // two years past due
const BIN_DAYS = 7;
const N_BINS = Math.ceil((AXIS_MAX - AXIS_MIN) / BIN_DAYS);
const K_CUSTOMER = 5;
const K_TENANT = 3;
const PRIOR_WEEKLY_HAZARD = 0.08; // ≈ 29% of remaining balance paid per month

const MODEL_VERSION = 'km-weekly-shrunk@1';

function binOf(day) {
  const b = Math.floor((day - AXIS_MIN) / BIN_DAYS);
  if (b < 0) return 0;
  if (b >= N_BINS) return N_BINS - 1;
  return b;
}

function emptyTable() {
  return { events: new Float64Array(N_BINS), atRisk: new Float64Array(N_BINS), nEvents: 0, nCensored: 0 };
}

function addEvent(table, day) {
  const k = binOf(day);
  for (let b = 0; b <= k; b++) table.atRisk[b] += 1;
  table.events[k] += 1;
  table.nEvents++;
}

function addCensored(table, day) {
  const k = binOf(day);
  for (let b = 0; b < k; b++) table.atRisk[b] += 1;
  table.atRisk[k] += 0.5;
  table.nCensored++;
}

function weeklyHazard(table, priorHazards, k) {
  const out = new Float64Array(N_BINS);
  for (let b = 0; b < N_BINS; b++) {
    const prior = priorHazards ? priorHazards[b] : PRIOR_WEEKLY_HAZARD;
    out[b] = (table.events[b] + k * prior) / (table.atRisk[b] + k);
    if (out[b] > 1) out[b] = 1;
  }
  return out;
}

function toDaily(weekly) {
  const out = new Float64Array(N_BINS);
  for (let b = 0; b < N_BINS; b++) out[b] = 1 - Math.pow(1 - weekly[b], 1 / BIN_DAYS);
  return out;
}

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Builds per-customer daily hazard curves plus the evidence behind them.
 */
function buildBehaviorModel(state) {
  const tenant = emptyTable();
  const perCustomer = new Map();

  for (const c of state.customers.values()) {
    const table = emptyTable();
    const delays = [];
    for (const inv of c.invoices) {
      if (inv.dueDay == null) continue;
      if (inv.status === 'paid') {
        if (inv.paidDay == null) continue; // paid date unknown: cannot place the event
        const d = Math.round((inv.paidDay - inv.dueDay) / 86400000);
        addEvent(table, d);
        addEvent(tenant, d);
        delays.push({ delay: d, paidDay: inv.paidDay });
      } else if (inv.outstanding > 0 && inv.ageDays != null) {
        addCensored(table, inv.ageDays);
        addCensored(tenant, inv.ageDays);
      }
    }
    perCustomer.set(c.key, { table, delays });
  }

  const tenantWeekly = weeklyHazard(tenant, null, K_TENANT);
  const tenantDaily = toDaily(tenantWeekly);
  const tenantDelays = [];
  for (const v of perCustomer.values()) for (const d of v.delays) tenantDelays.push(d.delay);

  const customers = new Map();
  for (const [key, v] of perCustomer) {
    const weekly = weeklyHazard(v.table, tenantWeekly, K_CUSTOMER);
    customers.set(key, {
      daily: toDaily(weekly),
      paidSamples: v.table.nEvents,
      openSamples: v.table.nCensored,
      medianDelay: median(v.delays.map((d) => d.delay)),
      trend: delayTrend(v.delays, state.asOfDay),
      onTimeRate: v.delays.length ? v.delays.filter((d) => d.delay <= 0).length / v.delays.length : null,
    });
  }

  return {
    version: MODEL_VERSION,
    prior: { weeklyHazard: PRIOR_WEEKLY_HAZARD, kTenant: K_TENANT, kCustomer: K_CUSTOMER },
    tenant: { daily: tenantDaily, paidSamples: tenant.nEvents, openSamples: tenant.nCensored, medianDelay: median(tenantDelays) },
    customers,
  };
}

// Recent (last 90 days of payments) vs prior (91–365 days) median delay.
function delayTrend(delays, asOfDay, recentDays = 90, priorDays = 365) {
  const DAY = 86400000;
  const recent = delays.filter((d) => d.paidDay > asOfDay - recentDays * DAY).map((d) => d.delay);
  const prior = delays.filter((d) => d.paidDay <= asOfDay - recentDays * DAY && d.paidDay > asOfDay - priorDays * DAY).map((d) => d.delay);
  return { recentMedian: median(recent), recentN: recent.length, priorMedian: median(prior), priorN: prior.length };
}

/**
 * Probability an invoice currently `age` days past due is paid within
 * `horizon` days, with an optional hazard multiplier that applies from
 * `startOffset` days onwards.
 */
function probPaidWithin(daily, age, horizon, multiplier = 1, startOffset = 0, shock = 1) {
  let survive = 1;
  for (let d = 0; d < horizon; d++) {
    const m = d >= startOffset ? multiplier : 1;
    let h = daily[binOf(age + d)] * m * shock;
    if (h > 1) h = 1;
    survive *= 1 - h;
  }
  return 1 - survive;
}

/**
 * Samples the day (0-based, < horizon) on which an invoice is paid, or -1,
 * using a supplied uniform draw so different options can share the same
 * random numbers (common random numbers make option comparisons fair).
 */
function samplePaymentDay(daily, age, horizon, u, multiplier = 1, startOffset = 0, shock = 1) {
  let survive = 1;
  for (let d = 0; d < horizon; d++) {
    const m = d >= startOffset ? multiplier : 1;
    let h = daily[binOf(age + d)] * m * shock;
    if (h > 1) h = 1;
    survive *= 1 - h;
    if (survive < u) return d;
  }
  return -1;
}

module.exports = {
  MODEL_VERSION,
  PRIOR_WEEKLY_HAZARD,
  buildBehaviorModel,
  probPaidWithin,
  samplePaymentDay,
  median,
  binOf,
};
