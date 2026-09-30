// Seven-feature engines, pure parts: action lifecycle, Watch detection and
// dedupe keys, mission planning/proposals/progress/verdict, Simulate labels,
// Memory inference, Prepared horizons.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const core = require('./core');
const watch = require('./watch');
const missions = require('./missions');
const { simulate, STARTING_RATES } = require('./simulate');
const memory = require('./memory');
const prepared = require('./prepared');
const { getStage, buildMessage } = require('../services/agents/collectionsAgent');

let pass = 0, fail = 0;
const check = (name, ok, extra) => { if (ok) { pass++; console.log(`  ✅ ${name}`); } else { fail++; console.log(`  ❌ ${name}`, extra ?? ''); } };
const NOW = Date.parse('2026-09-27T10:00:00Z');
const day = (d) => new Date(NOW + d * 86400000).toISOString().slice(0, 10);

console.log('— days overdue are live, from the due date');
check('stale stored value is ignored when there is a due date', core.liveDaysOverdue({ due_date: day(-40), days_overdue: 5 }, NOW) === 40);
check('not yet due -> 0', core.liveDaysOverdue({ due_date: day(4), days_overdue: 0 }, NOW) === 0);
check('due today -> 0', core.liveDaysOverdue({ due_date: day(0) }, NOW) === 0);
check('timestamp-shaped due date works', core.liveDaysOverdue({ due_date: `${day(-10)}T18:30:00.000Z` }, NOW) === 10);
check('Date object due date works', core.liveDaysOverdue({ due_date: new Date(`${day(-3)}T00:00:00Z`) }, NOW) === 3);
check('no due date -> the stored value (never negative)', core.liveDaysOverdue({ due_date: null, days_overdue: 12 }, NOW) === 12 && core.liveDaysOverdue({ days_overdue: -3 }, NOW) === 0);
check('unparseable due date -> the stored value', core.liveDaysOverdue({ due_date: 'soon', days_overdue: 7 }, NOW) === 7);

console.log('— action lifecycle');
const lc = (a, o) => core.lifecycleOf(a, o).state;
check('pending needing approval -> APPROVAL_REQUIRED', lc({ status: 'pending', requires_approval: true }) === 'APPROVAL_REQUIRED');
check('pending passed policy -> VALIDATED', lc({ status: 'pending', requires_approval: false }) === 'VALIDATED');
check('done + pending outcome check -> VERIFYING', lc({ status: 'done' }, [{ status: 'PENDING' }]) === 'VERIFYING');
check('done + MET -> VERIFIED', lc({ status: 'done' }, [{ status: 'MET' }]) === 'VERIFIED');
check('done + NOT_MET -> NOT_EFFECTIVE (failure state)', lc({ status: 'done' }, [{ status: 'NOT_MET' }]) === 'NOT_EFFECTIVE' && core.FAILURE_STATES.includes('NOT_EFFECTIVE'));
check('system_blocked -> BLOCKED with the policy reason', core.lifecycleOf({ status: 'system_blocked', block_reason: 'blocked phrase' }).note === 'blocked phrase');
check('only VALIDATED/APPROVAL_REQUIRED can be decided', core.lifecycleOf({ status: 'approved' }).canDecide === false && core.lifecycleOf({ status: 'pending' }).canDecide === true);
check('unknown kind of evidence is refused', (() => { try { core.fact('x', 1, { kind: 'vibes' }); return false; } catch { return true; } })());

console.log('— watch detection');
const inv = (id, days, extra = {}) => ({ id, customer_name: `Cust ${id}`, invoice_amount: 1000 * days, days_overdue: days, due_date: day(-days), ...extra });
let found = watch.detect({ invoices: [inv('a', 0), inv('b', 3), inv('c', 12), inv('d', 45), inv('e', 120), inv('f', 50, { dunning_paused: true })], now: NOW });
check('not-yet-due and disputed invoices raise nothing', !found.some((f) => ['a', 'f'].includes(f.entity_id)));
check('one event per overdue band, keyed by invoice + band', found.map((f) => f.dedupe_key).join() === 'invoice_overdue:b:1,invoice_overdue:c:8,invoice_overdue:d:31,invoice_overdue:e:91');
check('severity follows the band', found.map((f) => f.severity).join() === 'low,normal,high,critical');
check('only high/critical push, with no names or amounts on the lock screen',
  found.filter((f) => f.push).length === 2 && found.every((f) => !f.push || (!/Cust|₹|\d{3}/.test(f.push.title + f.push.body))));
check('every event carries evidence with sources', found.every((f) => f.evidence.facts.length >= 3 && f.evidence.sources.includes('invoices')));
const again = watch.detect({ invoices: [inv('d', 46)], now: NOW });
check('re-detection next day keeps the same key (no duplicate)', again[0].dedupe_key === 'invoice_overdue:d:31');
check('resolution: invoice still open -> moved_to_next_band; gone -> paid_or_removed',
  watch.resolutionFor({ kind: 'invoice_overdue', entity_id: 'd' }, new Set(['d'])) === 'moved_to_next_band'
  && watch.resolutionFor({ kind: 'invoice_overdue', entity_id: 'd' }, new Set()) === 'paid_or_removed');
found = watch.detect({ connectors: [{ id: 'tally', name: 'Tally', availability: 'available', authType: 'local_bridge', state: { health: 'error', lastAttempt: { id: 'r1', status: 'failed', startedAt: day(0), error: 'Tally closed' }, lastSuccessAt: new Date(NOW - 3 * 86400000).toISOString() } }], now: NOW });
check('failed sync and stale sync are both events', found.map((f) => f.kind).sort().join() === 'sync_failed,sync_stale');
check('state machine: resolved is final; dismissed can reopen', !watch.canMove('resolved', 'open') && watch.canMove('dismissed', 'open') && watch.canMove('open', 'acknowledged'));

console.log('— missions');
const open = [inv('m1', 40, { customer_name: 'Mehta Hardware', customer_phone: '98' }), inv('m2', 10, { customer_name: 'Mehta Hardware' }), inv('k1', 5, { customer_name: 'Kapoor & Co' }), inv('z1', 0, { customer_name: 'Zed' }), inv('dx', 20, { customer_name: 'Disputed Ltd', dunning_paused: true })];
let p = missions.planDraft({ invoices: open, input: {} });
check('default draft: every open overdue, undisputed invoice', p.errors.length === 0 && p.draft.target.invoiceIds.sort().join() === 'k1,m1,m2');
check('disputed invoices are listed as excluded, not silently dropped', p.draft.excluded.length === 1 && p.draft.excluded[0].id === 'dx');
check('default target = everything they owe; 14-day horizon', p.draft.target.amount === 55000 && p.draft.horizonDays === 14);
p = missions.planDraft({ invoices: open, input: { customer: 'mehta hardware', targetAmount: 30000, horizonDays: 21 } });
check('customer draft: only that customer; objective states amount and horizon', p.draft.target.invoiceIds.sort().join() === 'm1,m2' && /₹30,000 of ₹50,000/.test(p.draft.objective) && /21 days/.test(p.draft.objective), p.draft);
check('target above what is owed is refused', missions.planDraft({ invoices: open, input: { customer: 'Kapoor & Co', targetAmount: 999999 } }).errors.length === 1);
check('horizon out of range is refused', missions.planDraft({ invoices: open, input: { horizonDays: 400 } }).errors.length === 1);
check('nothing overdue -> refused with a reason', missions.planDraft({ invoices: [inv('z', 0)], input: {} }).errors[0].includes('no open'));
const pr = missions.proposals({ invoices: open.filter((i) => !i.dunning_paused), constraints: missions.DEFAULT_CONSTRAINTS, getStage, buildMessage, now: NOW });
check('one proposal per customer, for their oldest invoice', pr.out.length === 2 && pr.out.find((x) => x.invoice.customer_name === 'Mehta Hardware').invoice.id === 'm1');
check('escalation not allowed -> 40-day invoice capped at a firm reminder', pr.out.find((x) => x.invoice.id === 'm1').stage.type === 'SEND_FIRM_REMINDER' && pr.out.find((x) => x.invoice.id === 'm1').stage.capped);
const pr2 = missions.proposals({ invoices: [inv('m1', 40)], constraints: { ...missions.DEFAULT_CONSTRAINTS, allowEscalation: true }, getStage, buildMessage, now: NOW });
check('escalation allowed -> the normal collections stage', pr2.out[0].stage.type === getStage(40).type && !pr2.out[0].stage.capped);
const pr3 = missions.proposals({ invoices: [inv('m1', 40, { last_reminder_sent: new Date(NOW - 86400000).toISOString() }), inv('k1', 5)], constraints: missions.DEFAULT_CONSTRAINTS, activeActionInvoiceIds: new Set(['k1']), getStage, buildMessage, now: NOW });
check('recently contacted and already-actioned invoices are skipped with a reason', pr3.out.length === 0 && pr3.skipped.map((s) => s.reason).sort().join() === 'already_has_an_open_action,contacted_recently');
check('transitions: draft->active ok, completed is final, paused->completed not allowed', missions.canTransition('draft', 'active') && !missions.canTransition('completed', 'active') && !missions.canTransition('paused', 'completed'));
const mission = { status: 'active', target: { amount: 30000 }, ends_at: new Date(NOW + 5 * 86400000).toISOString(),
  baseline: { at: day(-3), outstanding: 50000, invoices: [{ id: 'm1', customer: 'Mehta Hardware', amount: 40000 }, { id: 'm2', customer: 'Mehta Hardware', amount: 10000 }] } };
let prog = missions.progressOf({ mission, current: [{ id: 'm1', invoice_amount: 25000, customer_phone: '98' }, { id: 'm2', invoice_amount: 10000, customer_phone: null }], actions: [{ status: 'pending', requires_approval: true, recommended_message: 'hi' }], dataAsOf: new Date(NOW - 3600e3).toISOString(), now: NOW });
check('progress: part payment counts as collected', prog.collected === 15000 && prog.remaining === 15000 && prog.ratio === 0.5);
check('blockers: approval waiting, messaging off, missing phone', ['awaiting_approval', 'messaging_off', 'no_phone'].every((c) => prog.blockers.some((b) => b.code === c)), prog.blockers);
check('progress evidence labels the target as an assumption', prog.evidence.facts.find((f) => f.label === 'Target').kind === 'assumption');
check('verdict: not yet', missions.verdict({ mission, progress: prog, now: NOW }) === null);
prog = missions.progressOf({ mission, current: [{ id: 'm2', invoice_amount: 10000 }], now: NOW });
check('paid invoice disappears -> collected; target reached -> completed', prog.collected === 40000 && missions.verdict({ mission, progress: prog, now: NOW }) === 'completed');
prog = missions.progressOf({ mission, current: [{ id: 'm1', invoice_amount: 40000 }, { id: 'm2', invoice_amount: 10000 }], now: NOW });
check('horizon passed short of target -> failed', missions.verdict({ mission, progress: prog, now: NOW + 6 * 86400000 }) === 'failed');
check('stale data is a blocker, not hidden', prog.blockers.some((b) => b.code === 'data_stale'));
check('a closed mission shows no blockers', missions.progressOf({ mission: { ...mission, status: 'completed' }, current: [], actions: [{ status: 'pending', recommended_message: 'x' }], now: NOW }).blockers.length === 0);

console.log('— simulate');
const sim = simulate({ invoices: [inv('a', 0), inv('b', 45)], horizonDays: 30, targetAmount: 20000 });
check('facts, assumptions and estimates are labelled separately', sim.facts.every((f) => f.kind === 'fact') && sim.assumptions.every((a) => a.kind === 'assumption') && sim.estimate.expected.kind === 'estimate');
check('starting assumptions are marked as not learned from the business', sim.assumptions.find((a) => a.band === '31_90').source === 'starting_assumption' && sim.caveat);
check('expected = sum(amount x rate)', sim.estimate.expected.value === Math.round(0 * STARTING_RATES.current + 45000 * STARTING_RATES['31_90']));
check('range brackets the expectation', sim.estimate.range.low <= sim.estimate.expected.value && sim.estimate.range.high >= sim.estimate.expected.value);
const owner = simulate({ invoices: [inv('b', 45)], rates: { '31_90': 0.9 } });
check('owner-edited rate is used and attributed to you', owner.assumptions.find((a) => a.band === '31_90').source === 'you' && owner.estimate.expected.value === 40500);
check('target reach is an estimate with a plain sentence', ['likely', 'possible', 'unlikely'].includes(sim.target.reach) && sim.target.text.length > 10);
const hist = Array.from({ length: 6 }, (_, i) => ({ due_date: day(-100 - i), payment_date: day(-100 - i + 40) }));
const learned = simulate({ invoices: [inv('b', 45)], history: hist, horizonDays: 30 });
check('enough paid history -> rate from your history, with sample size', learned.assumptions.find((a) => a.band === '31_90').source === 'your_history' && learned.assumptions.find((a) => a.band === '31_90').sample === 6);

console.log('— memory');
const paid = [5, 9, 7, 30].map((late, i) => ({ id: `p${i}`, customer_name: 'Mehta Hardware', due_date: day(-60), payment_date: day(-60 + late) }))
  .concat([{ id: 'q1', customer_name: 'Kapoor', due_date: day(-10), payment_date: day(-8) }]);
const recs = memory.infer({ paidInvoices: paid });
check('infers only where there is enough history (>=3 paid)', recs.length === 1 && recs[0].subject_label === 'Mehta Hardware');
check('median, not mean (one 30-day outlier does not skew it)', recs[0].value.medianDaysLate === 8 && /about 8 days after/.test(recs[0].statement));
check('provenance: table, ids, method, sample size', recs[0].provenance.table === 'invoices' && recs[0].provenance.ids.length === 4 && recs[0].provenance.sampleSize === 4 && recs[0].provenance.method);
check('stale inferred record is flagged', memory.shape({ status: 'inferred', stale_after: day(-1), topic: 'payment_timing', value: {} }, NOW).freshness === 'stale');
check('confirmed record whose data moved is flagged, not overwritten', memory.shape({ status: 'confirmed', topic: 'payment_timing', statement: 'x', value: { medianDaysLate: 8, latest: { medianDaysLate: 20 } } }, NOW).freshness === 'changed_since_confirmed');

console.log('— prepared');
let hz = prepared.build({ invoices: [
  { id: 'i1', customer_name: 'A', invoice_amount: 1000, days_overdue: 0, due_date: day(0) },
  { id: 'i2', customer_name: 'B', invoice_amount: 2000, days_overdue: 0, due_date: day(5) },
  { id: 'i3', customer_name: 'C', invoice_amount: 3000, days_overdue: 0, due_date: day(20) },
  { id: 'i4', customer_name: 'D', invoice_amount: 4000, days_overdue: 27, due_date: day(-27) },
], pending: [{ id: 'x' }], now: NOW });
const at = (h) => hz.find((x) => x.horizon === h);
check('24h: due today + decisions waiting', at('24h').items.some((i) => i.kind === 'invoices_due' && i.source.ids.includes('i1')) && at('24h').items.some((i) => i.kind === 'decisions_waiting'));
check('7d: due in 5 days + about to cross 30 days overdue', at('7d').items.some((i) => i.kind === 'invoices_due' && i.source.ids.includes('i2')) && at('7d').items.some((i) => i.kind === 'crossing_band' && i.source.ids.includes('i4')));
check('30d: due in 20 days', at('30d').items.some((i) => i.source.ids.includes('i3')));
check('every item has a reason and a source', hz.flatMap((h) => h.items).every((i) => i.reason && i.source.table && i.source.ids.length));
hz = prepared.build({ invoices: [{ id: 'n', customer_name: 'N', invoice_amount: 1, days_overdue: 0, due_date: null }], now: NOW });
check('no due dates -> 7d/30d say insufficient data (not "all clear")', hz.find((h) => h.horizon === '7d').status === 'insufficient_data' && hz.find((h) => h.horizon === '30d').note);
check('no data at all -> insufficient data everywhere', prepared.build({ now: NOW }).every((h) => h.status === 'insufficient_data'));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
