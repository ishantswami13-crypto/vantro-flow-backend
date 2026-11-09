// FILE: lib/domain/os/workingCapital.js
// Working capital agent: the next N days of money in and money out, from the
// ledger only.
//
//   money in  = open receivables (outstanding after confirmed allocations and
//               recorded part payments, from the same snapshot every other
//               surface uses), bucketed by due date
//   money out = unpaid purchases (amount - paid_amount), bucketed by due date
//
// What it does NOT do, on purpose:
//   - It never assumes an opening bank balance. No bank feed is connected, so
//     the projection is a net flow, never "cash in hand". It says so.
//   - It never predicts that a late customer will pay on a given day. Overdue
//     receivables are reported separately as "already late, timing unknown",
//     not spread across the weeks.
//   - Disputed invoices are excluded from expected money in.
//   - It never pays, reschedules or contacts anyone. Read, analyze, record.
//
// Each run writes one agent_runs row (agent_key starlane.working_capital) so
// the Agents page can show real run history.

const { checkStops, getSettings } = require('../decisions/controls');
const { loadRawReceivables } = require('../decisions/discovery');
const { deriveReceivablesState } = require('../decisions/snapshot');
const { parseBusinessDate, startOfUtcDay } = require('../decisions/dates');
const { safeLog } = require('../../observability/logger');

const AGENT_KEY = 'starlane.working_capital';
const AGENT_VERSION = 'wc-1';
const DAY = 86400000;
const DEFAULT_HORIZON = 30;

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Pure: build the working-capital view from already-derived receivables and
 * raw purchase rows. Exported for tests.
 *
 * @param {object} args
 * @param {Array}  args.receivables  snapshot invoices ({ outstanding, dueDay, ageDays, disputeOpen, currency, customerName, number, id })
 * @param {Array}  args.purchases    rows ({ id, supplier_name, amount, paid_amount, status, due_date, bill_number, currency })
 * @param {number} args.asOfDay      UTC day start (ms)
 * @param {number} args.horizonDays
 * @param {string} args.baseCurrency
 */
function computeWorkingCapital({ receivables, purchases, asOfDay, horizonDays = DEFAULT_HORIZON, baseCurrency = 'INR' }) {
  const horizonEnd = asOfDay + horizonDays * DAY;
  const weeks = Math.ceil(horizonDays / 7);
  const buckets = Array.from({ length: weeks }, (_, i) => {
    const start = asOfDay + i * 7 * DAY;
    const end = Math.min(asOfDay + (i + 1) * 7 * DAY, horizonEnd);
    return { week: i + 1, from: new Date(start).toISOString().slice(0, 10), to: new Date(end - DAY).toISOString().slice(0, 10), moneyIn: 0, moneyOut: 0, net: 0, cumulativeNet: 0 };
  });
  const bucketOf = (day) => Math.min(Math.floor((day - asOfDay) / (7 * DAY)), weeks - 1);

  const excluded = { otherCurrencyReceivables: 0, otherCurrencyPayables: 0, disputedReceivables: 0, disputedAmount: 0 };
  const inflow = { dueInHorizon: 0, dueInHorizonCount: 0, overdue: 0, overdueCount: 0, noDueDate: 0, noDueDateCount: 0, laterThanHorizon: 0 };
  const outflow = { dueInHorizon: 0, dueInHorizonCount: 0, overdue: 0, overdueCount: 0, noDueDate: 0, noDueDateCount: 0, laterThanHorizon: 0 };
  const lateReceivables = [];
  const upcomingPayables = [];

  for (const inv of receivables || []) {
    if (!(inv.outstanding > 0)) continue;
    if ((inv.currency || baseCurrency) !== baseCurrency) { excluded.otherCurrencyReceivables++; continue; }
    if (inv.disputeOpen) { excluded.disputedReceivables++; excluded.disputedAmount = round2(excluded.disputedAmount + inv.outstanding); continue; }
    if (inv.dueDay == null) { inflow.noDueDate = round2(inflow.noDueDate + inv.outstanding); inflow.noDueDateCount++; continue; }
    if (inv.dueDay < asOfDay) {
      inflow.overdue = round2(inflow.overdue + inv.outstanding); inflow.overdueCount++;
      lateReceivables.push({ invoiceId: inv.id, number: inv.number || null, customer: inv.customerName, outstanding: inv.outstanding, daysLate: inv.ageDays });
      continue;
    }
    if (inv.dueDay >= horizonEnd) { inflow.laterThanHorizon = round2(inflow.laterThanHorizon + inv.outstanding); continue; }
    inflow.dueInHorizon = round2(inflow.dueInHorizon + inv.outstanding); inflow.dueInHorizonCount++;
    const b = buckets[bucketOf(inv.dueDay)];
    b.moneyIn = round2(b.moneyIn + inv.outstanding);
  }

  for (const p of purchases || []) {
    const status = String(p.status || '').toLowerCase();
    if (status === 'paid' || status === 'cancelled') continue;
    const outstanding = round2(num(p.amount) - num(p.paid_amount));
    if (!(outstanding > 0)) continue;
    if ((p.currency || baseCurrency) !== baseCurrency) { excluded.otherCurrencyPayables++; continue; }
    const dueDay = p.due_date ? parseBusinessDate(p.due_date instanceof Date ? p.due_date.toISOString().slice(0, 10) : p.due_date) : null;
    const row = { purchaseId: String(p.id), supplier: p.supplier_name, billNumber: p.bill_number || null, outstanding, dueDate: dueDay != null ? new Date(dueDay).toISOString().slice(0, 10) : null };
    if (dueDay == null) { outflow.noDueDate = round2(outflow.noDueDate + outstanding); outflow.noDueDateCount++; upcomingPayables.push({ ...row, when: 'NO_DUE_DATE' }); continue; }
    if (dueDay < asOfDay) {
      outflow.overdue = round2(outflow.overdue + outstanding); outflow.overdueCount++;
      upcomingPayables.push({ ...row, when: 'OVERDUE', daysLate: Math.round((asOfDay - dueDay) / DAY) });
      // Overdue payables are owed now: they land in week 1.
      buckets[0].moneyOut = round2(buckets[0].moneyOut + outstanding);
      continue;
    }
    if (dueDay >= horizonEnd) { outflow.laterThanHorizon = round2(outflow.laterThanHorizon + outstanding); continue; }
    outflow.dueInHorizon = round2(outflow.dueInHorizon + outstanding); outflow.dueInHorizonCount++;
    upcomingPayables.push({ ...row, when: 'DUE' });
    const b = buckets[bucketOf(dueDay)];
    b.moneyOut = round2(b.moneyOut + outstanding);
  }

  let running = 0;
  let firstShortWeek = null;
  for (const b of buckets) {
    b.net = round2(b.moneyIn - b.moneyOut);
    running = round2(running + b.net);
    b.cumulativeNet = running;
    if (running < 0 && firstShortWeek == null) firstShortWeek = b.week;
  }

  const moneyIn = inflow.dueInHorizon;
  const moneyOut = round2(outflow.dueInHorizon + outflow.overdue);
  const net = round2(moneyIn - moneyOut);

  lateReceivables.sort((a, b) => b.outstanding - a.outstanding);
  const order = { OVERDUE: 0, DUE: 1, NO_DUE_DATE: 2 };
  upcomingPayables.sort((a, b) => (order[a.when] - order[b.when]) || String(a.dueDate || '').localeCompare(String(b.dueDate || '')) || b.outstanding - a.outstanding);

  const hasPayables = (purchases || []).length > 0;
  const hasReceivables = (receivables || []).some((i) => i.outstanding > 0);
  let headline;
  if (!hasPayables && !hasReceivables) headline = 'No open receivables or unpaid purchases yet, so there is nothing to project.';
  else if (net >= 0) headline = `Over the next ${horizonDays} days, ${fmt(moneyIn, baseCurrency)} is due in and ${fmt(moneyOut, baseCurrency)} is owed out: ${fmt(net, baseCurrency)} net, if customers pay on their due dates.`;
  else headline = `Over the next ${horizonDays} days, ${fmt(moneyOut, baseCurrency)} is owed out but only ${fmt(moneyIn, baseCurrency)} is due in: a ${fmt(-net, baseCurrency)} gap${firstShortWeek ? ` from week ${firstShortWeek}` : ''}, before any cash you already hold.`;

  const unknowns = ['Opening bank balance: no bank feed is connected, so this is net flow, not cash in hand.'];
  if (inflow.overdueCount) unknowns.push(`${inflow.overdueCount} overdue invoice${inflow.overdueCount === 1 ? '' : 's'} (${fmt(inflow.overdue, baseCurrency)}) are already late; when they will pay is not predicted.`);
  if (inflow.noDueDateCount) unknowns.push(`${inflow.noDueDateCount} open invoice${inflow.noDueDateCount === 1 ? ' has' : 's have'} no readable due date.`);
  if (outflow.noDueDateCount) unknowns.push(`${outflow.noDueDateCount} unpaid purchase${outflow.noDueDateCount === 1 ? ' has' : 's have'} no due date (${fmt(outflow.noDueDate, baseCurrency)}).`);
  if (!hasPayables) unknowns.push('No purchases are recorded, so money out is unknown, not zero.');

  return {
    status: hasPayables || hasReceivables ? 'COMPUTED' : 'NEEDS_DATA',
    headline,
    currency: baseCurrency,
    horizonDays,
    asOf: new Date(asOfDay).toISOString().slice(0, 10),
    moneyIn,
    moneyOut,
    net,
    firstShortWeek,
    inflow,
    outflow,
    weeks: buckets,
    chaseFirst: lateReceivables.slice(0, 5),
    payablesSoonest: upcomingPayables.slice(0, 5),
    excluded,
    unknowns,
  };
}

function fmt(n, currency) {
  return require('../../locale/region').formatMoney(Math.round(Number(n) || 0), currency);
}

async function runWorkingCapital(pool, userId, { actorId = null, horizonDays = DEFAULT_HORIZON, now = Date.now(), instruction = null, understood = null } = {}) {
  const started = Date.now();
  const stops = await checkStops(pool, userId, { agentKey: AGENT_KEY });
  if (!stops.allowed) return { status: 'STOPPED', blockedBy: stops.blockedBy };
  const h = Math.max(7, Math.min(90, Math.round(Number(horizonDays) || DEFAULT_HORIZON)));
  const asOfIso = new Date(now).toISOString();
  const [settings, raw, purchases] = await Promise.all([
    getSettings(pool, userId),
    loadRawReceivables(pool, userId),
    pool.query(
      `SELECT id, supplier_name, amount, paid_amount, status, due_date, bill_number, currency
         FROM purchases WHERE user_id = $1 AND COALESCE(LOWER(status), '') NOT IN ('paid', 'cancelled')`,
      [userId]
    ).then((r) => r.rows),
  ]);
  const baseCurrency = settings.definitions.base_currency || 'INR';
  const state = deriveReceivablesState(raw, asOfIso, { mode: 'live', baseCurrency });
  const result = {
    ...computeWorkingCapital({ receivables: state.invoices, purchases, asOfDay: startOfUtcDay(now), horizonDays: h, baseCurrency }),
    durationMs: Date.now() - started,
    agent: { key: AGENT_KEY, version: AGENT_VERSION, model: 'deterministic (no LLM)' },
  };
  let runId = null;
  try {
    const r = await pool.query(
      `INSERT INTO agent_runs (user_id, agent_key, status, started_at, finished_at, input_json, output_json)
       VALUES ($1,$2,'completed',to_timestamp($3/1000.0),NOW(),$4,$5) RETURNING id`,
      [userId, AGENT_KEY, started, JSON.stringify({ asOf: asOfIso, horizonDays: h, onBehalfOf: actorId, agentVersion: AGENT_VERSION, instruction, understood }), JSON.stringify(result)]
    );
    runId = r.rows[0].id;
  } catch (err) {
    safeLog('warn', '[os] working capital run write failed', { error: err.message });
  }
  return { ...result, runId };
}

module.exports = { runWorkingCapital, computeWorkingCapital, AGENT_KEY, AGENT_VERSION };
