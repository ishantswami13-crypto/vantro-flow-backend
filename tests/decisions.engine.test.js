// FILE: tests/decisions.engine.test.js
// Pure tests of the decision engine (no database, no clock, no network):
// exact arithmetic, determinism, time-travel leakage, data parsing,
// currency, disputes, materiality and confidence.
//
// Run: node --test tests/decisions.engine.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildGoldenReceivables } = require('./fixtures/goldenReceivables');
const { deriveReceivablesState, assertNoFutureLeakage } = require('../lib/domain/decisions/snapshot');
const { discoverReceivableDecisions } = require('../lib/domain/decisions/detectors/receivables');
const { simulateOptions } = require('../lib/domain/decisions/simulate');
const { probPaidWithin, binOf } = require('../lib/domain/decisions/behavior');
const { parseBusinessDate, toIsoDate } = require('../lib/domain/decisions/dates');
const { effectiveDefinitions, validateOverrides } = require('../lib/domain/decisions/definitions');
const { detectDecisionContradictions } = require('../lib/domain/decisions/contradictions');
const { valueOfInformation } = require('../lib/domain/decisions/analysis');

const AS_OF = '2026-09-28';
const DAY = 86400000;
const defs = effectiveDefinitions({});

function constDaily(h) {
  return new Float64Array(binOf(10000) + 1).fill(h);
}

function discover(raw, asOf = AS_OF, ctx = {}) {
  const state = deriveReceivablesState(raw, `${asOf}T12:00:00Z`, { mode: 'live' });
  return { state, ...discoverReceivableDecisions(state, defs, { fullAnalysis: false, ...ctx }) };
}

test('dates: Indian and ISO formats parse; garbage and impossible dates are unknown, never today', () => {
  assert.equal(toIsoDate(parseBusinessDate('2026-03-31')), '2026-03-31');
  assert.equal(toIsoDate(parseBusinessDate('31/03/2026')), '2026-03-31');
  assert.equal(toIsoDate(parseBusinessDate('1-4-2026')), '2026-04-01');
  assert.equal(toIsoDate(parseBusinessDate('2026-03-31T18:30:00Z')), '2026-03-31');
  for (const bad of ['31/02/2026', '2026-13-01', 'next friday', '', null, undefined, '03/31/2026']) {
    assert.equal(parseBusinessDate(bad), null, `${bad} is not a date`);
  }
});

test('exact arithmetic: hazard 0 collects nothing, hazard 1 collects everything on day 0', () => {
  const lots = [{ age: 10, amount: 125000 }, { age: 40, amount: 75000 }];
  const options = [{ key: 'do_nothing', kind: 'baseline' }];
  const zero = simulateOptions({ lots, daily: constDaily(0), options, iterations: 200, seed: 7 });
  assert.equal(zero.summary[0].cash.d90.p90, 0);
  assert.equal(zero.summary[0].probFullRecovery90, 0);
  const one = simulateOptions({ lots, daily: constDaily(1), options, iterations: 200, seed: 7 });
  assert.equal(one.summary[0].cash.d30.p10, 200000);
  assert.equal(one.summary[0].cash.d30.mean, 200000);
  assert.equal(one.summary[0].probFullRecovery90, 1);
});

test('exact arithmetic: payment plan instalments land on days 28, 56, 84', () => {
  const lots = [{ age: 30, amount: 300000 }];
  const options = [{ key: 'plan', kind: 'payment_plan', params: [{ name: 'acceptance', lo: 0, hi: 1 }, { name: 'keep_rate', lo: 0, hi: 1 }] }];
  const s = simulateOptions({ lots, daily: constDaily(0), options, iterations: 50, seed: 1, fixedParams: { 'plan.acceptance': 1, 'plan.keep_rate': 1 } }).summary[0];
  assert.equal(s.cash.d30.mean, 100000);
  assert.equal(s.cash.d60.mean, 200000);
  assert.equal(s.cash.d90.mean, 300000);
});

test('exact arithmetic: credit-hold loss avoided is next-60-day credit times the analytic non-payment probability', () => {
  const daily = constDaily(0.01);
  const options = [{ key: 'hold', kind: 'credit_hold', params: [{ name: 'hazard_multiplier', lo: 1, hi: 1 }, { name: 'churn', lo: 0.2, hi: 0.2 }, { name: 'gross_margin', lo: 0.1, hi: 0.1 }] }];
  const s = simulateOptions({ lots: [{ age: 0, amount: 1000 }], daily, options, newCredit: { next60: 200000 }, iterations: 20, seed: 3, fixedShock: 1 }).summary[0];
  const expectedLoss = 200000 * 0.99 ** 90; // survives 90 days unpaid
  assert.equal(s.lossAvoided.mean, Math.round(expectedLoss), 'reported to the nearest rupee');
  assert.equal(s.marginLost.mean, 4000);
});

test('Monte Carlo agrees with the closed form within sampling error', () => {
  const h = 0.02;
  const s = simulateOptions({ lots: [{ age: 5, amount: 100000 }], daily: constDaily(h), options: [{ key: 'dn', kind: 'baseline' }], iterations: 20000, seed: 11, fixedShock: 1 }).summary[0];
  const p30 = 1 - (1 - h) ** 30;
  assert.ok(Math.abs(probPaidWithin(constDaily(h), 5, 30) - p30) < 1e-12);
  assert.ok(Math.abs(s.cash.d30.mean / 100000 - p30) < 0.015, `${s.cash.d30.mean / 100000} vs ${p30}`);
});

test('determinism: same data and seed give byte-identical decisions', () => {
  const { raw } = buildGoldenReceivables(AS_OF);
  const a = discover(raw).drafts;
  const b = discover(raw).drafts;
  assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
});

test('golden fixture: exactly one material decision (Sharma), disputed and small balances only watched', () => {
  const { raw } = buildGoldenReceivables(AS_OF);
  const { drafts, watched } = discover(raw);
  assert.equal(drafts.length, 1);
  const d = drafts[0];
  assert.match(d.title, /Sharma Traders/);
  assert.equal(d.materiality.exposure, 420000);
  assert.equal(d.window.latestSafeAt, toIsoDate(Date.parse(`${AS_OF}T00:00:00Z`) + 2 * DAY), 'oldest invoice is 88 days overdue: 2 days to the 90-day line');
  const codes = d.triggerSignals.map((t) => t.code);
  for (const c of ['DELAY_DETERIORATION', 'BROKEN_PROMISES', 'CREDIT_STILL_EXTENDED']) assert.ok(codes.includes(c), `trigger ${c}`);
  assert.ok(watched.some((w) => /Rao/.test(w.customer) && /dispute/i.test(w.reason)));
  assert.ok(watched.some((w) => /Kapoor/.test(w.customer) && /materiality/i.test(w.reason)));
  assert.ok(d.options.some((o) => o.isDoNothing));
  assert.ok(d.options.find((o) => o.key === d.recommendation.key).valid);
});

test('time travel: rows from the future never change a past decision', () => {
  const { raw } = buildGoldenReceivables(AS_OF);
  const T = '2026-09-28';
  const base = discover(raw, T).drafts;
  const future = JSON.parse(JSON.stringify(raw));
  // A payment recorded after T, a new invoice after T, a dispute opened after T.
  const sh301 = future.invoices.find((i) => i.invoice_number === 'SH-301');
  sh301.payment_status = 'Paid';
  sh301.payment_date = '2026-10-05';
  sh301.payment_amount = sh301.invoice_amount;
  future.invoices.push({ ...sh301, id: 'future-inv', invoice_number: 'SH-999', invoice_date: '2026-10-10', due_date: '2026-11-09', payment_status: 'Pending', payment_date: null });
  future.disputes.push({ id: 'future-disp', invoice_id: future.invoices.find((i) => i.invoice_number === 'SH-302').id, status: 'open', created_at: '2026-10-02T00:00:00Z', resolved_at: null });
  const replayed = discover(future, T).drafts;
  const strip = (ds) => JSON.parse(JSON.stringify(ds.map((d) => ({ ...d, evidence: d.evidence.map((e) => ({ ...e, observedAt: null })) }))));
  assert.deepEqual(strip(replayed), strip(base));
});

test('replay mode drops paid-without-date rows and current customer settings; leakage guard catches tampering', () => {
  const { raw } = buildGoldenReceivables(AS_OF);
  const r = JSON.parse(JSON.stringify(raw));
  r.invoices[0].payment_date = null; // Paid, date unknown
  const s = deriveReceivablesState(r, Date.parse(`${AS_OF}T00:00:00Z`), { mode: 'replay' });
  assert.equal(s.quality.paidWithoutDateExcludedFromReplay, 1);
  assert.ok(![...s.customers.values()].some((c) => c.record));
  assert.equal(assertNoFutureLeakage(s), true);
  s.invoices[0].paidDay = s.asOfDay + DAY;
  assert.throws(() => assertNoFutureLeakage(s), /leakage/);
  const live = deriveReceivablesState(r, Date.parse(`${AS_OF}T00:00:00Z`), { mode: 'live' });
  assert.equal(live.quality.paidWithoutDate, 1);
  assert.ok(live.invoices.some((i) => i.paidDateUnknown));
});

test('bad rows are counted, not guessed: unparseable due dates, missing currency, non-positive amounts, duplicates', () => {
  const { raw } = buildGoldenReceivables(AS_OF);
  const r = JSON.parse(JSON.stringify(raw));
  r.invoices.push({ id: 'b1', invoice_number: 'X-1', customer_name: 'Bad Rows Co', invoice_amount: 5000, payment_status: 'Pending', invoice_date: '01/08/2026', due_date: 'soon', currency: null, created_at: '2026-08-01T00:00:00Z' });
  r.invoices.push({ id: 'b2', invoice_number: 'X-2', customer_name: 'Bad Rows Co', invoice_amount: -10, payment_status: 'Pending', invoice_date: '2026-08-01', due_date: '2026-08-31', currency: 'INR' });
  r.invoices.push({ id: 'b3', invoice_number: 'X-1', customer_name: 'Bad Rows Co', invoice_amount: 5000, payment_status: 'Pending', invoice_date: '2026-08-01', due_date: '2026-08-31', currency: 'INR' });
  const s = deriveReceivablesState(r, `${AS_OF}T00:00:00Z`, { mode: 'live' });
  assert.equal(s.quality.unparseableDueDate, 1);
  assert.equal(s.quality.currencyMissing, 1);
  assert.equal(s.quality.nonPositiveAmount, 1);
  assert.equal(s.quality.duplicateInvoiceNumbers, 1);
  const b1 = s.invoices.find((i) => i.id === 'b1');
  assert.equal(b1.ageDays, null, 'no due date means age unknown, not overdue');
  assert.equal(b1.currencyAssumed, true);
});

test('currencies are never summed together', () => {
  const { raw } = buildGoldenReceivables(AS_OF);
  const r = JSON.parse(JSON.stringify(raw));
  for (const i of r.invoices) if (i.invoice_number === 'SH-303') i.currency = 'USD';
  const s = deriveReceivablesState(r, `${AS_OF}T12:00:00Z`, { mode: 'live' });
  assert.ok(s.totalsByCurrency.USD && s.totalsByCurrency.INR);
  assert.equal(s.totalsByCurrency.USD.overdue, 130000);
  const { drafts } = discover(r);
  for (const d of drafts) {
    const inv = d.affectedEntities.filter((e) => e.type === 'invoice');
    const curr = new Set(inv.map((e) => r.invoices.find((x) => x.id === e.id).currency));
    assert.equal(curr.size, 1, 'each decision is in one currency');
    assert.equal(d.currency, [...curr][0]);
  }
});

test('a dispute on every overdue invoice turns the decision into a watch', () => {
  const { raw } = buildGoldenReceivables(AS_OF);
  const r = JSON.parse(JSON.stringify(raw));
  for (const num of ['SH-301', 'SH-302', 'SH-303']) {
    const inv = r.invoices.find((i) => i.invoice_number === num);
    r.disputes.push({ id: `d-${num}`, invoice_id: inv.id, status: 'open', created_at: '2026-09-01T00:00:00Z', resolved_at: null });
  }
  const { drafts, watched } = discover(r);
  assert.equal(drafts.length, 0);
  assert.ok(watched.some((w) => /Sharma/.test(w.customer) && /dispute/i.test(w.reason)));
});

test('stale data lowers confidence; contradictions are surfaced', () => {
  const { raw } = buildGoldenReceivables(AS_OF);
  const fresh = discover(raw, AS_OF, { freshness: { status: 'FRESH', detail: 'fresh' } }).drafts[0];
  const stale = discover(raw, AS_OF, { freshness: { status: 'STALE', detail: 'stale' } }).drafts[0];
  assert.ok(stale.confidence.score < fresh.confidence.score, `${stale.confidence.score} < ${fresh.confidence.score}`);

  const r = JSON.parse(JSON.stringify(raw));
  r.customers.find((c) => /Sharma/.test(c.name)).advance_required = true; // on hold, yet billed on credit 10 days ago
  const state = deriveReceivablesState(r, `${AS_OF}T12:00:00Z`, { mode: 'live' });
  const contradictions = detectDecisionContradictions(state);
  const all = [...contradictions.values()].flat();
  assert.ok(all.some((c) => c.type === 'CREDIT_HOLD_VS_LEDGER'));
  const withC = discoverReceivableDecisions(state, defs, { fullAnalysis: false, contradictionsByInvoice: contradictions }).drafts[0];
  assert.ok(withC.contradictions.length >= 1);
  assert.ok(!withC.options.find((o) => o.key === 'credit_hold')?.valid, 'cannot hold credit that is already on hold');
});

test('external messaging off: contact options are prepared drafts, never sends', () => {
  const { raw } = buildGoldenReceivables(AS_OF);
  const d = discover(raw, AS_OF, { externalSendEnabled: false }).drafts[0];
  const contact = d.options.find((o) => o.key === 'escalate_contact');
  assert.equal(contact.intent.channel, 'prepared_draft');
  assert.ok(d.constraints.some((c) => c.key === 'external_send_off'));
});

test('value of information is only flagged when it could change the decision by a material amount', () => {
  const { raw } = buildGoldenReceivables(AS_OF);
  const state = deriveReceivablesState(raw, `${AS_OF}T12:00:00Z`, { mode: 'live' });
  const lots = [{ age: 30, amount: 100000 }];
  const options = [
    { key: 'a', kind: 'baseline' },
    { key: 'b', kind: 'hazard_multiplier', params: [{ name: 'hazard_multiplier', lo: 1.0, hi: 1.0001 }] },
  ];
  const sim = simulateOptions({ lots, daily: constDaily(0.01), options, iterations: 500, seed: 2 });
  const voi = valueOfInformation(sim, options, 5, 1000);
  assert.ok(state);
  assert.ok(voi.every((v) => !v.recommendationDependsOnIt), 'an assumption with no spread has no decision value');
});

test('definitions: overrides are validated and cannot smuggle unknown keys', () => {
  assert.equal(validateOverrides({ material_amount_min: 50000 }).ok, true);
  assert.equal(validateOverrides({ material_amount_min: -1 }).ok, false);
  assert.equal(validateOverrides({ drop_table: 1 }).ok, false);
  assert.equal(effectiveDefinitions({ material_amount_min: 50000 }).material_amount_min, 50000);
});
