'use strict';
// lib/features/core.js — primitives shared by Starlane's seven features
// (Bridge, Scan, Watch, Missions, Simulate, Memory, Prepared).
//
// Evidence
//   Every figure a feature shows carries what kind of figure it is:
//     fact        read from the company's own records (an invoice row)
//     calculated  arithmetic over facts (days overdue, a sum)
//     assumption  something the owner or Starlane chose, editable
//     estimate    a projection that depends on assumptions
//     model       output of a model (never presented as a fact)
//   and where it came from (table + ids). Pure; no I/O.
//
// Action lifecycle
//   ai_actions keeps its historical status column; lifecycleOf() presents it
//   as the one lifecycle every feature uses:
//     PROPOSED -> VALIDATED -> APPROVAL_REQUIRED -> APPROVED -> EXECUTING
//       -> EXECUTED -> VERIFYING -> VERIFIED
//   with the failure states REJECTED, BLOCKED, FAILED, EXPIRED, CANCELLED,
//   UNKNOWN, NOT_EFFECTIVE. Rows reach the table only after the policy guard
//   (collectionsAgent, missions), so a pending row is at least VALIDATED.

const KINDS = Object.freeze(['fact', 'calculated', 'assumption', 'estimate', 'model']);

function fact(label, value, { kind = 'fact', source = null, ids = null, unit = null, note = null } = {}) {
  if (!KINDS.includes(kind)) throw new Error(`unknown evidence kind ${kind}`);
  const out = { label, value, kind };
  if (unit) out.unit = unit;
  if (source) out.source = source;
  if (ids && ids.length) out.ids = ids.slice(0, 50).map(String);
  if (note) out.note = note;
  return out;
}

function evidence({ summary, facts = [], sources = [], computedAt = new Date().toISOString(), method = null }) {
  return { summary, facts, sources: [...new Set(sources.filter(Boolean))], computedAt, method };
}

const LIFECYCLE = Object.freeze([
  'PROPOSED', 'VALIDATED', 'APPROVAL_REQUIRED', 'APPROVED', 'EXECUTING', 'EXECUTED', 'VERIFYING', 'VERIFIED',
]);
const FAILURE_STATES = Object.freeze(['REJECTED', 'BLOCKED', 'FAILED', 'EXPIRED', 'CANCELLED', 'UNKNOWN', 'NOT_EFFECTIVE']);

/**
 * @param {object} a ai_actions row
 * @param {Array<{status:string}>} outcomes action_outcomes rows for it
 * @returns {{ state: string, terminal: boolean, canDecide: boolean, note: string|null }}
 */
function lifecycleOf(a, outcomes = []) {
  const s = a.status;
  const verified = outcomes.find((o) => ['verified', 'effective', 'succeeded', 'met'].includes(String(o.status).toLowerCase()));
  const notEffective = outcomes.find((o) => ['not_met', 'ineffective', 'failed', 'missed'].includes(String(o.status).toLowerCase()));
  const pendingCheck = outcomes.find((o) => ['pending', 'scheduled', 'waiting'].includes(String(o.status).toLowerCase()));
  const out = (state, note = null) => ({
    state, note,
    terminal: FAILURE_STATES.includes(state) || state === 'VERIFIED' || (state === 'EXECUTED' && !pendingCheck),
    canDecide: state === 'VALIDATED' || state === 'APPROVAL_REQUIRED',
  });
  switch (s) {
    case 'pending': return out(a.requires_approval ? 'APPROVAL_REQUIRED' : 'VALIDATED');
    case 'approved': return out('APPROVED');
    case 'executing': return out('EXECUTING');
    case 'done':
      if (verified) return out('VERIFIED');
      if (notEffective) return out('NOT_EFFECTIVE', 'The result was checked and the expected effect did not happen.');
      if (pendingCheck) return out('VERIFYING', 'Starlane will check the result against the books.');
      return out('EXECUTED');
    case 'rejected': return out('REJECTED');
    case 'system_blocked': return out('BLOCKED', a.block_reason || 'Stopped by the policy guard.');
    case 'failed': return out('FAILED', a.last_execution_error || null);
    case 'expired': return out('EXPIRED');
    case 'cancelled': return out('CANCELLED');
    case 'execution_unknown': return out('UNKNOWN', 'Starlane could not confirm whether this was carried out.');
    default: return out('PROPOSED');
  }
}

// ── Receivables helpers ────────────────────────────────────────────────
const OPEN_SQL = `COALESCE(payment_status,'Pending') NOT IN ('Paid','paid','PAID')`;
// An open bill is owed for what is left on it: a part payment or credit note
// (e.g. a Tally "Agst Ref" receipt) is recorded in payment_amount.
const OPEN_AMOUNT_SQL = `GREATEST(COALESCE(invoice_amount,0) - COALESCE(payment_amount,0), 0)`;

function customerKey(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 120);
}

const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };

// Days-overdue bands, the same bands the collections stages use.
const BANDS = Object.freeze([
  { id: 'current', label: 'Not yet due', min: -Infinity, max: 0 },
  { id: '1_7', label: '1–7 days', min: 1, max: 7 },
  { id: '8_30', label: '8–30 days', min: 8, max: 30 },
  { id: '31_90', label: '31–90 days', min: 31, max: 90 },
  { id: '90_plus', label: 'Over 90 days', min: 91, max: Infinity },
]);

function ageing(invoices) {
  const out = BANDS.map((b) => ({ id: b.id, label: b.label, amount: 0, count: 0 }));
  for (const inv of invoices) {
    const d = n(inv.days_overdue);
    const i = BANDS.findIndex((b) => d >= b.min && d <= b.max);
    out[i].amount += n(inv.invoice_amount); out[i].count++;
  }
  return out;
}

function parseDay(s) {
  if (!s) return null;
  const t = Date.parse(String(s).length === 10 ? `${s}T00:00:00Z` : s);
  return Number.isFinite(t) ? t : null;
}

// invoices.days_overdue is stored at import time and goes stale: an invoice
// imported at 5 days overdue would read 5 forever. The due date is the fact;
// the stored number is used only when there is no usable due date.
function liveDaysOverdue(inv, now = Date.now()) {
  const raw = inv.due_date instanceof Date ? inv.due_date.toISOString() : inv.due_date;
  const due = raw ? parseDay(String(raw).slice(0, 10)) : null;
  if (due == null) return Math.max(0, Math.floor(n(inv.days_overdue)));
  const today = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
  return Math.max(0, Math.floor((today - due) / 86400000));
}
// The same rule in SQL, for totals worked out in the database (UTC day, as above).
const LIVE_OVERDUE_SQL = `(CASE WHEN due_date::text ~ '^\\d{4}-\\d{2}-\\d{2}'
  THEN GREATEST((now() AT TIME ZONE 'UTC')::date - substr(due_date::text, 1, 10)::date, 0)
  ELSE GREATEST(COALESCE(days_overdue, 0), 0) END)`;
function withLiveOverdue(rows, now) {
  for (const r of rows || []) r.days_overdue = liveDaysOverdue(r, now);
  return rows;
}

module.exports = { KINDS, fact, evidence, LIFECYCLE, FAILURE_STATES, lifecycleOf, OPEN_SQL, OPEN_AMOUNT_SQL, LIVE_OVERDUE_SQL, customerKey, n, BANDS, ageing, parseDay, liveDaysOverdue, withLiveOverdue };
