// FILE: lib/domain/decisions/analysis.js
// Turns a simulation into decision analysis: recommendation, how stable it is,
// what a week of waiting costs, how options behave under stress, which
// assumption would flip the answer, and which unknown is worth resolving
// first (expected value of partial perfect information, by binning).
// Pure functions over simulate.js output; no DB, no LLM.

const { simulateOptions } = require('./simulate');
const { quantile } = require('./rng');

function meanOf(arr) {
  let s = 0;
  for (const v of arr) s += v;
  return arr.length ? s / arr.length : 0;
}

function recommend(sim, options) {
  let best = 0;
  sim.summary.forEach((s, i) => { if (s.value.mean > sim.summary[best].value.mean) best = i; });
  const baselineIdx = options.findIndex((o) => o.kind === 'baseline');
  const bestSummary = sim.summary[best];
  const gainOverBaseline = baselineIdx >= 0 ? bestSummary.value.mean - sim.summary[baselineIdx].value.mean : null;
  return {
    key: options[best].key,
    index: best,
    stability: bestSummary.bestShare,
    gainOverDoNothing: gainOverBaseline == null ? null : Math.round(gainOverBaseline),
  };
}

// Share of simulated futures in which each option is within `tolerance` of
// the best option in that same future.
function robustness(sim, tolerance) {
  const opts = sim.raw.perOption;
  const n = sim.iterations;
  return opts.map((rec) => {
    let ok = 0;
    for (let it = 0; it < n; it++) {
      let best = -Infinity;
      for (const o of opts) if (o.value[it] > best) best = o.value[it];
      if (rec.value[it] >= best - tolerance) ok++;
    }
    return { key: rec.key, acceptableShare: Math.round((ok / n) * 1000) / 1000 };
  });
}

function costOfDelay(baseInput, options, recommendedKey, delayDays = 7) {
  const opt = options.find((o) => o.key === recommendedKey);
  if (!opt || opt.kind === 'baseline') return null;
  const now = simulateOptions({ ...baseInput, options: [opt] });
  const later = simulateOptions({ ...baseInput, options: [opt], startOffset: delayDays });
  // Same seed and random draws in both runs, so each simulated future is
  // compared with itself acting a week later (paired difference).
  const a = now.raw.perOption[0].value;
  const b = later.raw.perOption[0].value;
  const diffs = Array.from(a, (v, i) => v - b[i]).sort((x, y) => x - y);
  const perWeek = diffs.reduce((s, v) => s + v, 0) / diffs.length;
  return { delayDays, valueLost: Math.round(perWeek), p10: Math.round(quantile(diffs, 0.1)), p90: Math.round(quantile(diffs, 0.9)), meaning: 'Expected value lost by acting one week later; p10-p90 across simulated futures.' };
}

const STRESS_SCENARIOS = [
  { key: 'baseline', label: 'History repeats', shock: 1, paramsAt: 'sampled', changes: 'Payment timing as in this customer\'s own history.' },
  { key: 'optimistic', label: 'Pays 25% faster', shock: 1.25, paramsAt: 'sampled', changes: 'Weekly chance of payment 25% higher than history.' },
  { key: 'pessimistic', label: 'Pays 33% slower', shock: 0.67, paramsAt: 'sampled', changes: 'Weekly chance of payment one third lower than history.' },
  { key: 'stress', label: 'Pays half as fast, actions work poorly', shock: 0.5, paramsAt: 'low', changes: 'Weekly chance of payment halved and every option effect at the low end of its range.' },
];

function stressTest(baseInput, options) {
  return STRESS_SCENARIOS.map((sc) => {
    const fixedParams = {};
    if (sc.paramsAt === 'low') {
      for (const o of options) for (const p of o.params || []) fixedParams[`${o.key}.${p.name}`] = p.lowIsWorse === false ? p.hi : p.lo;
    }
    const sim = simulateOptions({ ...baseInput, fixedShock: sc.shock, fixedParams, iterations: Math.min(baseInput.iterations || 2000, 800) });
    const rec = recommend(sim, options);
    return {
      key: sc.key,
      label: sc.label,
      changes: sc.changes,
      recommended: rec.key,
      options: sim.summary.map((s) => ({ key: s.key, cash60: s.cash.d60, value: s.value })),
    };
  });
}

// One-at-a-time sweep of every assumption (and of the behaviour shock) to
// find the value at which the recommendation changes.
function sensitivity(baseInput, options, recommendedKey, points = 7) {
  const results = [];
  const iterations = Math.min(baseInput.iterations || 2000, 300);
  const sweeps = [];
  for (const o of options) for (const p of o.params || []) sweeps.push({ option: o.key, param: p, id: `${o.key}.${p.name}` });
  sweeps.push({ option: null, param: { name: 'payment_speed', lo: 0.5, hi: 1.5, label: 'Customer pays at x times historical speed' }, id: 'shock' });

  const mids = {};
  for (const o of options) for (const p of o.params || []) mids[`${o.key}.${p.name}`] = (p.lo + p.hi) / 2;

  for (const sw of sweeps) {
    const grid = [];
    for (let i = 0; i < points; i++) grid.push(sw.param.lo + ((sw.param.hi - sw.param.lo) * i) / (points - 1));
    const recs = grid.map((v) => {
      const fixedParams = { ...mids };
      let fixedShock = 1;
      if (sw.id === 'shock') fixedShock = v; else fixedParams[sw.id] = v;
      const sim = simulateOptions({ ...baseInput, iterations, fixedShock, fixedParams });
      return { value: v, recommended: recommend(sim, options).key };
    });
    const switches = [];
    for (let i = 1; i < recs.length; i++) {
      if (recs[i].recommended !== recs[i - 1].recommended) {
        switches.push({ between: [round3(recs[i - 1].value), round3(recs[i].value)], from: recs[i - 1].recommended, to: recs[i].recommended });
      }
    }
    results.push({
      assumption: sw.id,
      label: sw.param.label || sw.param.name,
      range: [sw.param.lo, sw.param.hi],
      flips: switches.length > 0,
      switches,
      atLow: recs[0].recommended,
      atHigh: recs[recs.length - 1].recommended,
    });
  }
  // Assumptions that flip the answer first, then the rest.
  results.sort((a, b) => Number(b.flips) - Number(a.flips));
  return { recommendedAtMidpoints: recommendedKey, results };
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

// EVPPI by binning: how much better would the decision be, on average, if
// this one uncertain quantity were known before choosing?
function valueOfInformation(sim, options, bins = 5, materialGain = 1000) {
  const n = sim.iterations;
  const values = sim.raw.perOption.map((r) => r.value);
  const baseBest = Math.max(...values.map((v) => meanOf(v)));
  const out = [];

  const candidates = [];
  sim.raw.perOption.forEach((rec, oi) => {
    for (const [name, arr] of Object.entries(rec.params)) candidates.push({ id: `${options[oi].key}.${name}`, arr, spec: (options[oi].params || []).find((p) => p.name === name) });
  });
  candidates.push({ id: 'shock', arr: sim.raw.shocks, spec: { label: 'How fast this customer actually pays compared with history' } });

  for (const c of candidates) {
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => c.arr[a] - c.arr[b]);
    let total = 0;
    const perBinBest = [];
    for (let b = 0; b < bins; b++) {
      const idx = order.slice(Math.floor((b * n) / bins), Math.floor(((b + 1) * n) / bins));
      if (!idx.length) continue;
      let bestMean = -Infinity;
      let bestKey = null;
      values.forEach((v, oi) => {
        let s = 0;
        for (const i of idx) s += v[i];
        const m = s / idx.length;
        if (m > bestMean) { bestMean = m; bestKey = options[oi].key; }
      });
      total += bestMean * idx.length;
      perBinBest.push(bestKey);
    }
    const evppi = total / n - baseBest;
    out.push({
      unknown: c.id,
      label: c.spec?.label || c.id,
      basis: c.spec?.basis || (c.id === 'shock' ? 'MODEL_UNCERTAINTY' : 'ASSUMPTION'),
      expectedValueOfKnowing: Math.max(0, Math.round(evppi)),
      recommendationDependsOnIt: new Set(perBinBest).size > 1 && evppi >= materialGain,
    });
  }
  out.sort((a, b) => b.expectedValueOfKnowing - a.expectedValueOfKnowing);
  return out;
}

module.exports = { recommend, robustness, costOfDelay, stressTest, sensitivity, valueOfInformation, STRESS_SCENARIOS };
