// FILE: lib/domain/decisions/simulate.js
// Monte Carlo simulation of a receivables decision's options.
//
// The numbers come from three places, and the output keeps them apart:
//   OBSERVED   – open balances and ages (from the as-of snapshot) and the
//                customer's payment-timing history (behavior.js);
//   ASSUMPTION – every effect an option is assumed to have (e.g. "an escalation
//                call raises the weekly chance of payment by 5–60%") is a named
//                parameter with a range. It is sampled, never fixed, and its
//                influence on the answer is measured (analysis.js);
//   SIMULATED  – the resulting distributions of cash collected.
// An LLM never produces any number here.
//
// Common random numbers: every option sees the same draw per invoice per
// iteration, so differences between options come from the options, not noise.

const { mulberry32, normal, uniform, quantile } = require('./rng');
const { probPaidWithin, samplePaymentDay, binOf } = require('./behavior');

const HORIZONS = [30, 60, 90];
const MAX_LOTS = 40;

// Very large customers are simulated in "lots": open invoices in the same
// weekly age bucket move together. Means are unchanged; spread is slightly
// wider (lots are fully correlated). Recorded in the method notes.
function toLots(openInvoices) {
  if (openInvoices.length <= MAX_LOTS) {
    return { lots: openInvoices.map((i) => ({ age: i.ageDays, amount: i.outstanding, ids: [i.id] })), grouped: false };
  }
  const byBin = new Map();
  for (const inv of openInvoices) {
    const b = binOf(inv.ageDays);
    const lot = byBin.get(b) || { age: inv.ageDays, amount: 0, ids: [] };
    lot.amount += inv.outstanding;
    lot.ids.push(inv.id);
    lot.age = Math.max(lot.age, inv.ageDays);
    byBin.set(b, lot);
  }
  return { lots: [...byBin.values()], grouped: true };
}

function summarize(values) {
  const sorted = Float64Array.from(values).sort();
  let sum = 0;
  for (const v of values) sum += v;
  return {
    mean: round0(sum / values.length),
    p10: round0(quantile(sorted, 0.1)),
    p50: round0(quantile(sorted, 0.5)),
    p90: round0(quantile(sorted, 0.9)),
  };
}

function round0(n) {
  return n == null ? null : Math.round(n);
}

/**
 * @param {object} input
 *   lots: [{age, amount}]                open, collectable balances
 *   daily: Float64Array                   customer daily hazard (behavior.js)
 *   options: [{key, kind, params: [{name, lo, hi}]}]
 *   newCredit: { next60: number }         observed recent credit billing, for credit-hold
 *   margin: { known: number|null }        tenant gross margin if defined
 *   weights: { cash, credit_risk, margin }
 *   iterations, seed, shockSd, fixedShock, startOffset, fixedParams
 */
function simulateOptions(input) {
  const {
    lots, daily, options, newCredit = { next60: 0 }, margin = { known: null },
    weights = { cash: 1, credit_risk: 1, margin: 1 },
    iterations = 2000, seed = 1, shockSd = 0.25, fixedShock = null, startOffset = 0,
    fixedParams = {},
  } = input;
  const rand = mulberry32(seed);
  const H = HORIZONS[HORIZONS.length - 1];

  const perOption = options.map((o) => ({
    key: o.key,
    cash: HORIZONS.map(() => new Float64Array(iterations)),
    value: new Float64Array(iterations),
    lossAvoided: new Float64Array(iterations),
    marginLost: new Float64Array(iterations),
    full90: 0,
    params: Object.fromEntries((o.params || []).map((p) => [p.name, new Float64Array(iterations)])),
  }));
  const shocks = new Float64Array(iterations);
  const exposure = lots.reduce((s, l) => s + l.amount, 0);

  for (let it = 0; it < iterations; it++) {
    const shock = fixedShock != null ? fixedShock : Math.exp(shockSd * normal(rand));
    shocks[it] = shock;
    const uInvoice = lots.map(() => rand());
    const uAccept = rand();
    const uInstallment = [rand(), rand(), rand()];

    options.forEach((opt, oi) => {
      const rec = perOption[oi];
      const p = {};
      for (const spec of opt.params || []) {
        const fixed = fixedParams[`${opt.key}.${spec.name}`];
        p[spec.name] = fixed != null ? fixed : uniform(rand, spec.lo, spec.hi);
        rec.params[spec.name][it] = p[spec.name];
      }

      const cash = HORIZONS.map(() => 0);
      let fullyPaid = true;

      if (opt.kind === 'payment_plan') {
        const accepted = uAccept < p.acceptance;
        if (accepted) {
          const installmentDays = [28, 56, 84].map((d) => d + startOffset);
          for (let k = 0; k < 3; k++) {
            const paid = uInstallment[k] < p.keep_rate;
            if (!paid) { fullyPaid = false; continue; }
            HORIZONS.forEach((h, hi) => { if (installmentDays[k] < h) cash[hi] += exposure / 3; });
          }
        } else {
          lots.forEach((lot, li) => {
            const day = samplePaymentDay(daily, lot.age, H, uInvoice[li], 1, 0, shock);
            if (day < 0) { fullyPaid = false; return; }
            HORIZONS.forEach((h, hi) => { if (day < h) cash[hi] += lot.amount; });
          });
        }
      } else {
        const mult = opt.kind === 'baseline' ? 1 : p.hazard_multiplier * (p.escalation_multiplier || 1);
        lots.forEach((lot, li) => {
          const day = samplePaymentDay(daily, lot.age, H, uInvoice[li], mult, startOffset, shock);
          if (day < 0) { fullyPaid = false; return; }
          HORIZONS.forEach((h, hi) => { if (day < h) cash[hi] += lot.amount; });
        });
      }

      let lossAvoided = 0;
      let marginLost = 0;
      if (opt.kind === 'credit_hold' && newCredit.next60 > 0) {
        const freshLoss = 1 - probPaidWithin(daily, 0, 90, 1, 0, shock);
        lossAvoided = newCredit.next60 * freshLoss;
        const m = margin.known != null ? margin.known : p.gross_margin;
        marginLost = newCredit.next60 * p.churn * m;
      }

      HORIZONS.forEach((_, hi) => { rec.cash[hi][it] = cash[hi]; });
      rec.lossAvoided[it] = lossAvoided;
      rec.marginLost[it] = marginLost;
      rec.value[it] = weights.cash * cash[1] + weights.credit_risk * lossAvoided - weights.margin * marginLost;
      if (fullyPaid) rec.full90++;
    });
  }

  // Which option wins in each simulated future.
  const wins = new Float64Array(options.length);
  for (let it = 0; it < iterations; it++) {
    let best = 0;
    for (let oi = 1; oi < options.length; oi++) if (perOption[oi].value[it] > perOption[best].value[it]) best = oi;
    wins[best]++;
  }

  const summary = perOption.map((rec, oi) => ({
    key: rec.key,
    cash: Object.fromEntries(HORIZONS.map((h, hi) => [`d${h}`, summarize(rec.cash[hi])])),
    value: summarize(rec.value),
    lossAvoided: summarize(rec.lossAvoided),
    marginLost: summarize(rec.marginLost),
    probFullRecovery90: Math.round((rec.full90 / iterations) * 1000) / 1000,
    bestShare: Math.round((wins[oi] / iterations) * 1000) / 1000,
  }));

  return { iterations, seed, exposure: round0(exposure), horizons: HORIZONS, summary, raw: { perOption, shocks } };
}

module.exports = { simulateOptions, toLots, summarize, HORIZONS };
