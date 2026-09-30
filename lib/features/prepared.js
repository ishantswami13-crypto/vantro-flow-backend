'use strict';
// lib/features/prepared.js — PREPARED: what is coming in the next 24 hours,
// 7 days and 30 days, worked out ahead so the owner is not surprised.
//
// Only from dated facts: invoice due dates, invoices about to cross into a
// worse overdue band, open payment promises, missions ending, decisions
// waiting. Every item carries its reason and its source rows. A horizon the
// data cannot support says so (status 'insufficient_data') rather than
// showing an empty "all clear".

const { n, parseDay } = require('./core');

const HORIZONS = Object.freeze([
  { id: '24h', label: 'Next 24 hours', days: 1 },
  { id: '7d', label: 'Next 7 days', days: 7 },
  { id: '30d', label: 'Next 30 days', days: 30 },
]);
const inr = (v) => `₹${Math.round(n(v)).toLocaleString('en-IN')}`;
const DAY = 86400000;

function horizonOf(ms, now) {
  const d = (ms - now) / DAY;
  if (d < 0) return null;
  if (d <= 1) return '24h';
  if (d <= 7) return '7d';
  if (d <= 30) return '30d';
  return null;
}

function build({ invoices = [], promises = [], missions = [], pending = [], now = Date.now() }) {
  const today = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
  const items = [];
  const withDue = invoices.filter((i) => parseDay(i.due_date) !== null);

  // Invoices falling due, grouped per horizon (one item per horizon, listing ids).
  const dueBy = {};
  for (const inv of withDue) {
    const due = parseDay(inv.due_date);
    if (due < today) continue;
    const h = horizonOf(due, today - 1);
    if (!h) continue;
    (dueBy[h] = dueBy[h] || []).push(inv);
  }
  for (const [h, list] of Object.entries(dueBy)) {
    const total = list.reduce((s, i) => s + n(i.invoice_amount), 0);
    items.push({
      id: `due:${h}`, horizon: h, kind: 'invoices_due',
      title: `${list.length} invoice${list.length > 1 ? 's' : ''} fall${list.length > 1 ? '' : 's'} due · ${inr(total)}`,
      reason: 'Due dates recorded on these invoices fall in this window. Expect the money, or a reason it is late.',
      amount: Math.round(total), source: { table: 'invoices', ids: list.map((i) => String(i.id)).slice(0, 50) },
      route: '/watch', customers: [...new Set(list.map((i) => i.customer_name))].slice(0, 5),
    });
  }

  // Invoices about to cross into the 31+ and 90+ bands.
  for (const [edge, label, sev] of [[31, 'more than 30 days overdue', 'high'], [91, 'more than 90 days overdue', 'critical']]) {
    const soon = invoices.filter((i) => !i.dunning_paused && n(i.days_overdue) >= 1 && n(i.days_overdue) < edge && edge - n(i.days_overdue) <= 7);
    if (!soon.length) continue;
    const byDays = {};
    for (const i of soon) {
      const h = edge - n(i.days_overdue) <= 1 ? '24h' : '7d';
      (byDays[h] = byDays[h] || []).push(i);
    }
    for (const [h, list] of Object.entries(byDays)) {
      const total = list.reduce((s, i) => s + n(i.invoice_amount), 0);
      items.push({
        id: `cross:${edge}:${h}`, horizon: h, kind: 'crossing_band', severity: sev,
        title: `${list.length} invoice${list.length > 1 ? 's' : ''} will be ${label} · ${inr(total)}`,
        reason: `Counted from days overdue today. A reminder before day ${edge} is the cheaper conversation.`,
        amount: Math.round(total), source: { table: 'invoices', ids: list.map((i) => String(i.id)).slice(0, 50) },
        route: '/missions/new', customers: [...new Set(list.map((i) => i.customer_name))].slice(0, 5),
      });
    }
  }

  for (const p of promises) {
    const d = parseDay(String(p.promised_date).slice(0, 10));
    if (d === null || d < today) continue;
    const h = horizonOf(d, today - 1);
    if (!h) continue;
    items.push({
      id: `promise:${p.id}`, horizon: h, kind: 'promise_due',
      title: `${p.customer_name || 'A customer'} promised ${p.promised_amount ? inr(p.promised_amount) : 'a payment'} by ${String(p.promised_date).slice(0, 10)}`,
      reason: 'A payment promise recorded against this customer comes due. Watch will flag it if it is missed.',
      amount: p.promised_amount != null ? Math.round(n(p.promised_amount)) : null, source: { table: 'promises', ids: [String(p.id)] }, route: '/watch',
    });
  }

  for (const m of missions) {
    const end = m.ends_at ? Date.parse(m.ends_at) : null;
    if (!end || end < now) continue;
    const h = horizonOf(end, now);
    if (!h) continue;
    items.push({
      id: `mission:${m.id}`, horizon: h, kind: 'mission_ending',
      title: `Mission ends: ${m.title}`, reason: 'The mission’s horizon closes; Starlane will mark it completed or failed against its target.',
      amount: null, source: { table: 'missions', ids: [String(m.id)] }, route: `/missions/${m.id}`,
    });
  }

  if (pending.length) {
    items.push({
      id: 'decisions', horizon: '24h', kind: 'decisions_waiting',
      title: `${pending.length} decision${pending.length > 1 ? 's' : ''} waiting for you`,
      reason: 'Proposed actions do nothing until you approve them.',
      amount: null, source: { table: 'ai_actions', ids: pending.map((a) => String(a.id)).slice(0, 50) }, route: '/missions',
    });
  }

  const noDates = invoices.length > 0 && withDue.length === 0;
  const noData = invoices.length === 0 && promises.length === 0 && missions.length === 0;
  return HORIZONS.map((h) => {
    const list = items.filter((i) => i.horizon === h.id);
    let status = list.length ? 'ready' : 'nothing_due';
    let note = null;
    if (!list.length && noData) { status = 'insufficient_data'; note = 'Starlane has no invoices yet. Connect Tally or import a sheet so it can prepare ahead.'; }
    else if (!list.length && noDates && h.id !== '24h') { status = 'insufficient_data'; note = 'Your invoices have no due dates, so Starlane cannot see what falls due. Imports with a due date or credit terms fix this.'; }
    return { horizon: h.id, label: h.label, status, note, items: list };
  });
}

module.exports = { build, HORIZONS, horizonOf };
