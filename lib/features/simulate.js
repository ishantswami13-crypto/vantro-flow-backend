'use strict';
// lib/features/simulate.js — SIMULATE: "what happens to cash if…", with every
// number labelled for what it is.
//
//   fact        what the books say today (outstanding, overdue per band)
//   assumption  the chance an invoice in a band gets paid within the horizon;
//               editable by the owner. Starlane's starting values are marked
//               source 'starting_assumption' — they are NOT learned from this
//               company. Where the company's own paid invoices give enough
//               history (>= MIN_HISTORY per band), that observed rate is
//               offered instead and marked source 'your_history'.
//   estimate    expected collection = sum(amount x assumed rate), with a
//               range from moving every rate down/up by `spread`.
// Deterministic and pure; no model call.

const { fact, n, BANDS } = require('./core');

const STARTING_RATES = Object.freeze({ current: 0.85, '1_7': 0.75, '8_30': 0.55, '31_90': 0.3, '90_plus': 0.08 });
const MIN_HISTORY = 5;
const clamp01 = (x) => Math.max(0, Math.min(1, x));

function bandOf(days) { return BANDS.find((b) => n(days) >= b.min && n(days) <= b.max).id; }

/** Observed in-horizon payment rate per band from paid invoices ({ due_date, payment_date }), when there is enough history. */
function observedRates(paid, horizonDays) {
  const tally = {};
  for (const p of paid) {
    const due = Date.parse(p.due_date), pay = Date.parse(p.payment_date);
    if (!Number.isFinite(due) || !Number.isFinite(pay)) continue;
    const late = Math.round((pay - due) / 86400000);
    // For each band: of the invoices that reached the band's first day,
    // how many were paid within `horizonDays` of reaching it.
    for (const b of BANDS) {
      const start = b.id === 'current' ? 0 : b.min;
      if (late < start && b.id !== 'current') continue;
      tally[b.id] = tally[b.id] || { hit: 0, all: 0 };
      tally[b.id].all++;
      if (late - start <= horizonDays) tally[b.id].hit++;
    }
  }
  const out = {};
  for (const [k, v] of Object.entries(tally)) if (v.all >= MIN_HISTORY) out[k] = { rate: v.hit / v.all, sample: v.all };
  return out;
}

function simulate({ invoices, horizonDays = 30, rates = {}, spread = 0.15, history = [], targetAmount = null }) {
  const h = Math.max(1, Math.min(180, Math.round(Number(horizonDays) || 30)));
  const observed = observedRates(history, h);
  const assumptions = BANDS.map((b) => {
    const owner = rates[b.id];
    if (owner !== undefined && Number.isFinite(Number(owner))) return { band: b.id, label: b.label, rate: clamp01(Number(owner)), source: 'you' };
    if (observed[b.id]) return { band: b.id, label: b.label, rate: observed[b.id].rate, source: 'your_history', sample: observed[b.id].sample };
    return { band: b.id, label: b.label, rate: STARTING_RATES[b.id], source: 'starting_assumption' };
  });
  const rate = Object.fromEntries(assumptions.map((a) => [a.band, a.rate]));
  const bands = BANDS.map((b) => ({ band: b.id, label: b.label, amount: 0, count: 0 }));
  for (const inv of invoices) {
    const i = bands.findIndex((x) => x.band === bandOf(inv.days_overdue));
    bands[i].amount += n(inv.invoice_amount); bands[i].count++;
  }
  const expected = bands.reduce((s, b) => s + b.amount * rate[b.band], 0);
  const low = bands.reduce((s, b) => s + b.amount * clamp01(rate[b.band] - spread), 0);
  const high = bands.reduce((s, b) => s + b.amount * clamp01(rate[b.band] + spread), 0);
  const outstanding = bands.reduce((s, b) => s + b.amount, 0);
  const r2 = (x) => Math.round(x);
  const out = {
    horizonDays: h,
    facts: [
      fact('Outstanding on these invoices', r2(outstanding), { unit: 'INR', source: 'invoices' }),
      ...bands.filter((b) => b.count).map((b) => fact(`Owed ${b.label.toLowerCase()}`, r2(b.amount), { unit: 'INR', source: 'invoices', note: `${b.count} invoice${b.count > 1 ? 's' : ''}` })),
    ],
    assumptions: assumptions.map((a) => ({ ...a, kind: 'assumption' })),
    estimate: {
      expected: { label: `Expected to come in within ${h} days`, value: r2(expected), kind: 'estimate', unit: 'INR' },
      range: { label: 'Range if every assumption is off by 15 points', low: r2(low), high: r2(high), kind: 'estimate', unit: 'INR' },
      stillOwed: { label: `Still owed after ${h} days (expected)`, value: r2(outstanding - expected), kind: 'estimate', unit: 'INR' },
    },
    bands: bands.map((b) => ({ ...b, amount: r2(b.amount), rate: rate[b.band], expected: r2(b.amount * rate[b.band]) })),
    method: 'Expected = amount owed in each overdue band x the assumed chance an invoice in that band is paid within the horizon.',
    caveat: assumptions.some((a) => a.source === 'starting_assumption')
      ? 'Some rates are Starlane’s starting assumptions, not learned from your business. Change them to match what you know.'
      : null,
  };
  if (targetAmount != null) {
    const t = n(targetAmount);
    out.target = {
      amount: t, kind: 'assumption',
      reach: expected >= t ? 'likely' : high >= t ? 'possible' : 'unlikely',
      text: expected >= t ? 'At these assumptions the target is reached.' : high >= t ? 'Only reached if payments go better than assumed.' : 'Not reached even if payments go better than assumed.',
    };
  }
  return out;
}

module.exports = { simulate, observedRates, STARTING_RATES, MIN_HISTORY, bandOf };
