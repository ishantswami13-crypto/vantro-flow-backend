'use strict';
// lib/features/missions.js — MISSIONS: an objective Starlane works towards
// over a horizon, with measurable progress. First type: collections.
//
// Lifecycle (enforced by canTransition, stored in missions.status):
//   draft -> active | cancelled
//   active -> paused | completed | failed | cancelled
//   paused -> active | cancelled
//   completed, failed, cancelled are final.
// completed/failed are decided by evaluate(), never by a client: completed
// when the money collected from the mission's invoices reaches the target,
// failed when the horizon passes first.
//
// A mission never acts on its own. Activating it PROPOSES one collections
// action per customer (the collections stage for the oldest invoice, with the
// same message drafts and the same policy guard as the collections agent),
// and every one of those goes through the normal approval path. Pausing a
// mission blocks approval of its actions; cancelling cancels the ones still
// waiting. Disputed invoices are never part of a mission.
//
// Progress is measured against a baseline frozen at activation: the amount
// outstanding on the mission's invoices then, minus the amount outstanding on
// the same invoices now (a paid or removed invoice counts as collected).

const { fact, evidence, n, customerKey, lifecycleOf, billLabel } = require('./core');

const TRANSITIONS = Object.freeze({
  draft: ['active', 'cancelled'],
  active: ['paused', 'completed', 'failed', 'cancelled'],
  paused: ['active', 'cancelled'],
  completed: [], failed: [], cancelled: [],
});
const canTransition = (from, to) => (TRANSITIONS[from] || []).includes(to);
const CLIENT_TRANSITIONS = Object.freeze({ activate: ['draft', 'paused'], pause: ['active'], cancel: ['draft', 'active', 'paused'] });

const DEFAULT_CONSTRAINTS = Object.freeze({
  // Missions only propose reminders unless the owner allows escalation.
  allowEscalation: false,
  // Invoices whose collection is paused (disputes) are always excluded.
  excludeDisputed: true,
  // Do not propose a reminder to a customer contacted in the last N days.
  minDaysBetweenReminders: 3,
});
const REMINDER_ONLY = new Set(['SEND_POLITE_REMINDER', 'SEND_FIRM_REMINDER']);

function cleanConstraints(c = {}) {
  const out = { ...DEFAULT_CONSTRAINTS };
  if (typeof c.allowEscalation === 'boolean') out.allowEscalation = c.allowEscalation;
  const d = Number(c.minDaysBetweenReminders);
  if (Number.isInteger(d) && d >= 0 && d <= 30) out.minDaysBetweenReminders = d;
  return out;
}

/** Pure: validate a draft request against the company's open invoices. */
function planDraft({ invoices, input }) {
  const errors = [];
  const horizonDays = input.horizonDays === undefined ? 14 : Number(input.horizonDays);
  if (!Number.isInteger(horizonDays) || horizonDays < 1 || horizonDays > 180) errors.push('horizonDays must be a whole number from 1 to 180');
  let chosen = invoices;
  if (Array.isArray(input.invoiceIds) && input.invoiceIds.length) {
    const want = new Set(input.invoiceIds.map(String));
    chosen = invoices.filter((i) => want.has(String(i.id)));
    if (chosen.length !== want.size) errors.push('Some invoices are not open invoices of this company');
  } else if (input.customer) {
    const k = customerKey(input.customer);
    chosen = invoices.filter((i) => customerKey(i.customer_name) === k && n(i.days_overdue) > 0);
  } else {
    chosen = invoices.filter((i) => n(i.days_overdue) > 0);
  }
  const disputed = chosen.filter((i) => i.dunning_paused);
  chosen = chosen.filter((i) => !i.dunning_paused);
  if (!chosen.length && !errors.length) errors.push('There are no open, undisputed overdue invoices to collect');
  const outstanding = chosen.reduce((s, i) => s + n(i.invoice_amount), 0);
  let amount = input.targetAmount === undefined ? outstanding : Number(input.targetAmount);
  if (!Number.isFinite(amount) || amount <= 0) errors.push('targetAmount must be a positive amount');
  if (amount > outstanding + 0.5 && chosen.length) errors.push('targetAmount cannot exceed what these invoices owe');
  amount = Math.round(amount * 100) / 100;
  const customers = [...new Set(chosen.map((i) => i.customer_name))];
  const who = customers.length === 1 ? customers[0] : `${customers.length} customers`;
  return {
    errors,
    draft: {
      title: String(input.title || `Collect from ${who}`).slice(0, 120),
      objective: `Collect ₹${Math.round(amount).toLocaleString('en-IN')} of ₹${Math.round(outstanding).toLocaleString('en-IN')} overdue from ${who} within ${horizonDays} days.`,
      target: { amount, invoiceIds: chosen.map((i) => String(i.id)) },
      horizonDays,
      constraints: cleanConstraints(input.constraints),
      excluded: disputed.map((i) => ({ id: String(i.id), customer: i.customer_name, reason: 'Collection is paused on this invoice (dispute).' })),
    },
  };
}

/** Pure: what to propose on activation — one action per customer. */
function proposals({ invoices, constraints, activeActionInvoiceIds = new Set(), now = Date.now(), getStage }) {
  const byCustomer = new Map();
  for (const inv of invoices) {
    if (n(inv.days_overdue) < 1 || inv.dunning_paused) continue;
    const k = customerKey(inv.customer_name);
    const cur = byCustomer.get(k);
    if (!cur || n(inv.days_overdue) > n(cur.days_overdue)) byCustomer.set(k, inv);
  }
  const out = [], skipped = [];
  for (const inv of byCustomer.values()) {
    if (activeActionInvoiceIds.has(String(inv.id))) { skipped.push({ id: String(inv.id), reason: 'already_has_an_open_action' }); continue; }
    const last = inv.last_reminder_sent ? Date.parse(inv.last_reminder_sent) : null;
    if (last && now - last < constraints.minDaysBetweenReminders * 86400000) { skipped.push({ id: String(inv.id), reason: 'contacted_recently' }); continue; }
    let stage = getStage(n(inv.days_overdue));
    if (!constraints.allowEscalation && !REMINDER_ONLY.has(stage.type)) {
      stage = { ...stage, type: 'SEND_FIRM_REMINDER', priority: 'high', riskLevel: 'medium', capped: true };
    }
    out.push({ invoice: inv, stage });
  }
  return { out, skipped };
}

/** Pure: progress and blockers from the baseline and the invoices now. */
function progressOf({ mission, current, actions = [], externalMessaging = false, dataAsOf = null, now = Date.now() }) {
  const base = mission.baseline;
  const targetAmount = n(mission.target?.amount);
  if (!base) return { collected: 0, targetAmount, ratio: 0, remaining: targetAmount, byInvoice: [], blockers: [], actions: { total: 0 } };
  const cur = new Map(current.map((i) => [String(i.id), i]));
  const byInvoice = base.invoices.map((b) => {
    const now_ = cur.get(String(b.id));
    const outstandingNow = now_ ? n(now_.invoice_amount) : 0;
    return { id: b.id, customer: b.customer, invoiceNumber: billLabel(b.invoiceNumber), baseline: n(b.amount), now: outstandingNow,
      collected: Math.max(0, n(b.amount) - outstandingNow), status: now_ ? (outstandingNow < n(b.amount) ? 'part_paid' : 'open') : 'paid_or_removed',
      disputed: !!now_?.dunning_paused, hasPhone: now_ ? !!now_.customer_phone : null };
  });
  const collected = byInvoice.reduce((s, i) => s + i.collected, 0);
  const counts = { total: actions.length };
  for (const a of actions) { const st = lifecycleOf(a).state; counts[st] = (counts[st] || 0) + 1; }
  const blockers = [];
  const open = mission.status === 'active' || mission.status === 'paused';
  const waiting = (counts.APPROVAL_REQUIRED || 0) + (counts.VALIDATED || 0);
  if (mission.status === 'paused') blockers.push({ code: 'paused', text: 'The mission is paused; its actions cannot be approved until you resume it.' });
  if (waiting) blockers.push({ code: 'awaiting_approval', text: `${waiting} action${waiting > 1 ? 's' : ''} waiting for your approval.` });
  if (!externalMessaging && actions.some((a) => a.recommended_message)) blockers.push({ code: 'messaging_off', text: 'Reminders are drafted but not sent: sending messages is switched off for this company. Approving records the draft; send it yourself.' });
  const noPhone = byInvoice.filter((i) => i.status !== 'paid_or_removed' && i.hasPhone === false);
  if (noPhone.length) blockers.push({ code: 'no_phone', text: `${noPhone.length} invoice${noPhone.length > 1 ? 's have' : ' has'} no phone number on file.` });
  const disputed = byInvoice.filter((i) => i.disputed);
  if (disputed.length) blockers.push({ code: 'disputed', text: `${disputed.length} invoice${disputed.length > 1 ? 's are' : ' is'} now disputed; Starlane will not chase ${disputed.length > 1 ? 'them' : 'it'}.` });
  if (!dataAsOf || now - Date.parse(dataAsOf) > 24 * 3600 * 1000) blockers.push({ code: 'data_stale', text: dataAsOf ? 'Your books have not synced in over a day, so payments received since may not show yet.' : 'Starlane has no sync record for your books, so progress depends on imports.' });
  if (!open) blockers.length = 0; // a closed mission has nothing left to unblock
  const endsAt = mission.ends_at ? Date.parse(mission.ends_at) : null;
  return {
    collected: Math.round(collected * 100) / 100, targetAmount,
    ratio: targetAmount ? Math.min(1, collected / targetAmount) : 0,
    remaining: Math.max(0, Math.round((targetAmount - collected) * 100) / 100),
    daysLeft: endsAt ? Math.max(0, Math.ceil((endsAt - now) / 86400000)) : null,
    byInvoice, blockers, actions: counts,
    evidence: evidence({
      summary: 'Collected = outstanding on these invoices at the start minus outstanding now.',
      facts: [
        fact('Outstanding at start', n(base.outstanding), { unit: 'INR', source: 'missions.baseline', note: `Frozen ${String(base.at).slice(0, 10)}` }),
        fact('Outstanding now', byInvoice.reduce((s, i) => s + i.now, 0), { unit: 'INR', source: 'invoices', ids: byInvoice.map((i) => i.id) }),
        fact('Collected', collected, { kind: 'calculated', unit: 'INR' }),
        fact('Target', targetAmount, { kind: 'assumption', unit: 'INR', note: 'Set when the mission was created.' }),
      ],
      sources: ['invoices', 'missions'],
      computedAt: new Date(now).toISOString(),
    }),
  };
}

/** Pure: should an active mission close? */
function verdict({ mission, progress, now = Date.now() }) {
  if (mission.status !== 'active') return null;
  if (progress.targetAmount > 0 && progress.collected >= progress.targetAmount - 0.5) return 'completed';
  if (mission.ends_at && now > Date.parse(mission.ends_at)) return 'failed';
  return null;
}

function shape(m, extra = {}) {
  return {
    id: m.id, type: m.type, status: m.status, title: m.title, objective: m.objective,
    target: m.target, horizonDays: m.horizon_days, constraints: m.constraints, baseline: m.baseline, outcome: m.outcome,
    createdAt: m.created_at, updatedAt: m.updated_at, activatedAt: m.activated_at, endsAt: m.ends_at, closedAt: m.closed_at,
    ...extra,
  };
}

module.exports = { TRANSITIONS, CLIENT_TRANSITIONS, canTransition, DEFAULT_CONSTRAINTS, cleanConstraints, planDraft, proposals, progressOf, verdict, shape, REMINDER_ONLY };
