'use strict';
// lib/ai/directAnswers.js — answers Ask Starlane can give straight from the
// ledger, with no AI model.
//
// Ask Starlane normally goes through a language model that calls lookup
// tools. When no model is configured, today's AI budget is spent, or every
// provider is down, the most common questions (the ones in the Library) can
// still be answered exactly: they are sums and rankings over open invoices.
// This module recognises those questions and does the arithmetic. Anything it
// does not recognise returns null, and the caller says the model is
// unavailable, as before. It never guesses an intent from a loose match.
//
// Pure: the caller passes the open invoices (already scoped to the tenant)
// and the business's region. Nothing here reads a database or the network.

const { formatMoney } = require('../locale/region');

const DAY = 86_400_000;

function startOfUtcDay(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function dayOf(value) {
  if (!value) return null;
  const s = String(value);
  const t = Date.parse(s.length === 10 ? `${s}T00:00:00Z` : s);
  return Number.isNaN(t) ? null : startOfUtcDay(t);
}

/** Open balance of one invoice: amount less what has been paid, never negative. */
function owedOn(inv) {
  const amount = Number(inv.invoice_amount) || 0;
  const paid = Number(inv.payment_amount) || 0;
  return Math.max(Math.round((amount - paid) * 100) / 100, 0);
}

function prepare(invoices, asOf) {
  const today = startOfUtcDay(asOf);
  return (invoices || [])
    .filter((i) => i && String(i.payment_status || '').toLowerCase() !== 'paid')
    .map((i) => {
      const due = dayOf(i.due_date) ?? dayOf(i.invoice_date);
      return {
        customer: String(i.customer_name || '').replace(/\s+/g, ' ').trim() || 'Unnamed customer',
        number: i.invoice_number || null,
        owed: owedOn(i),
        currency: i.currency ? String(i.currency).toUpperCase() : null,
        due,
        daysOverdue: due != null && due < today ? Math.floor((today - due) / DAY) : 0,
      };
    })
    .filter((i) => i.owed > 0);
}

function byCustomer(rows) {
  const map = new Map();
  for (const r of rows) {
    const key = r.customer.toLowerCase();
    const c = map.get(key) || { customer: r.customer, owed: 0, overdue: 0, invoices: 0, oldest: 0 };
    c.owed += r.owed;
    c.invoices += 1;
    if (r.daysOverdue > 0) c.overdue += r.owed;
    c.oldest = Math.max(c.oldest, r.daysOverdue);
    map.set(key, c);
  }
  return [...map.values()].sort((a, b) => b.owed - a.owed || a.customer.localeCompare(b.customer));
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const pctOf = (part, whole) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : '0%');

// Questions in another currency than the business's are not summed together:
// the answer would be a number that means nothing.
function singleCurrency(rows, base) {
  const set = new Set(rows.map((r) => r.currency || base));
  return set.size <= 1 ? (set.values().next().value || base) : null;
}

function normalise(q) {
  return String(q || '').toLowerCase().replace(/[’']/g, "'").replace(/[?!.,]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Which question this is, or null. Order matters: the most specific first. */
function detectIntent(question, customers) {
  const q = normalise(question);
  if (!q) return null;
  const overN = /\b(?:more than|over|above|older than|beyond|past|at least)\s+(\d{1,4})\s*(?:\+\s*)?days?\b/.exec(q)
    || /\b(\d{1,4})\s*\+\s*days?\b/.exec(q);
  if (overN && /\b(overdue|late|unpaid|outstanding|pending|due)\b/.test(q)) {
    return { kind: 'overdue_over', days: Math.min(Number(overN[1]), 3650) };
  }
  // A named customer: the full name, or a distinctive first word (5+ letters).
  if (/\b(owe|owes|owing|outstanding|balance|pending|due)\b/.test(q)) {
    for (const c of customers) {
      const name = normalise(c.customer);
      const first = name.split(' ')[0];
      if (name && (q.includes(name) || (first.length >= 5 && new RegExp(`\\b${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(q)))) {
        return { kind: 'customer', customer: c };
      }
    }
  }
  if (/\b(who|which customers?|top|biggest|largest)\b/.test(q) && /\b(owe|owes|owing|debtors?|outstanding|overdue)\b/.test(q)
    && /\b(most|top|biggest|largest|highest|ranking|rank)\b/.test(q)) {
    return { kind: 'top' };
  }
  if (/\b(total|how much|sum)\b/.test(q) && /\b(outstanding|owed|owe us|owe me|receivables?|overdue|unpaid|pending)\b/.test(q)) {
    return { kind: 'total' };
  }
  return null;
}

/**
 * The answer, or null when the question is not one this module answers.
 * { message, intent, figures } — message is plain text the chat renders.
 */
function answerFromLedger(question, invoices, { currency = 'INR', locale = null, asOf = Date.now() } = {}) {
  const rows = prepare(invoices, asOf);
  const customers = byCustomer(rows);
  const intent = detectIntent(question, customers);
  if (!intent) return null;

  const cur = singleCurrency(rows, currency);
  const footer = 'Worked out directly from your ledger, without an AI model.';
  if (!rows.length) {
    return { intent: intent.kind, figures: { open: 0 }, message: `Nothing is owed to you right now: there are no unpaid invoices on record.\n\n${footer}` };
  }
  if (!cur) {
    return { intent: intent.kind, figures: null, message: `Your open invoices are in more than one currency, so I won't add them into one figure. Decisions and Command Center show each currency separately.\n\n${footer}` };
  }
  const money = (v) => formatMoney(v, cur, locale);
  const total = rows.reduce((s, r) => s + r.owed, 0);
  const overdueRows = rows.filter((r) => r.daysOverdue > 0);
  const overdue = overdueRows.reduce((s, r) => s + r.owed, 0);

  if (intent.kind === 'top') {
    const top = customers.slice(0, 5);
    const lead = top[0];
    const lines = top.map((c, i) => `${i + 1}. ${c.customer}: ${money(c.owed)} on ${plural(c.invoices, 'invoice')}${c.overdue > 0 ? `, ${money(c.overdue)} overdue (oldest ${plural(c.oldest, 'day')})` : ', none overdue yet'}`);
    return {
      intent: 'top',
      figures: { total, top: top.map((c) => ({ customer: c.customer, owed: c.owed, overdue: c.overdue })) },
      message: `${lead.customer} owes you the most: ${money(lead.owed)}, ${pctOf(lead.owed, total)} of the ${money(total)} you are owed in all.\n\n${lines.join('\n')}\n\n${footer}`,
    };
  }

  if (intent.kind === 'total') {
    const oldest = overdueRows.reduce((m, r) => Math.max(m, r.daysOverdue), 0);
    return {
      intent: 'total',
      figures: { total, overdue, invoices: rows.length, overdueInvoices: overdueRows.length },
      message: `You are owed ${money(total)} on ${plural(rows.length, 'unpaid invoice')} from ${plural(customers.length, 'customer')}. ${overdue > 0 ? `${money(overdue)} of it (${pctOf(overdue, total)}) is overdue, on ${plural(overdueRows.length, 'invoice')}; the oldest is ${plural(oldest, 'day')} late.` : 'None of it is overdue yet.'}\n\n${footer}`,
    };
  }

  if (intent.kind === 'overdue_over') {
    const late = rows.filter((r) => r.daysOverdue > intent.days).sort((a, b) => b.daysOverdue - a.daysOverdue);
    if (!late.length) {
      return { intent: 'overdue_over', figures: { days: intent.days, count: 0, sum: 0 }, message: `No unpaid invoice is more than ${plural(intent.days, 'day')} overdue.${overdueRows.length ? ` ${plural(overdueRows.length, 'invoice')} ${overdueRows.length === 1 ? 'is' : 'are'} overdue by less than that.` : ''}\n\n${footer}` };
    }
    const sum = late.reduce((s, r) => s + r.owed, 0);
    const shown = late.slice(0, 8);
    const lines = shown.map((r) => `- ${r.customer}${r.number ? `, ${r.number}` : ''}: ${money(r.owed)}, ${plural(r.daysOverdue, 'day')} overdue`);
    const more = late.length > shown.length ? `\n…and ${plural(late.length - shown.length, 'more invoice')}.` : '';
    return {
      intent: 'overdue_over',
      figures: { days: intent.days, count: late.length, sum },
      message: `${plural(late.length, 'invoice')} worth ${money(sum)} ${late.length === 1 ? 'is' : 'are'} more than ${plural(intent.days, 'day')} overdue.\n\n${lines.join('\n')}${more}\n\n${footer}`,
    };
  }

  if (intent.kind === 'customer') {
    const c = intent.customer;
    const theirs = rows.filter((r) => r.customer.toLowerCase() === c.customer.toLowerCase()).sort((a, b) => b.daysOverdue - a.daysOverdue);
    const lines = theirs.slice(0, 8).map((r) => `- ${r.number || 'Invoice'}: ${money(r.owed)}${r.daysOverdue > 0 ? `, ${plural(r.daysOverdue, 'day')} overdue` : ', not due yet'}`);
    return {
      intent: 'customer',
      figures: { customer: c.customer, owed: c.owed, overdue: c.overdue },
      message: `${c.customer} owes you ${money(c.owed)} on ${plural(c.invoices, 'unpaid invoice')}${c.overdue > 0 ? `; ${money(c.overdue)} of it is overdue, the oldest by ${plural(c.oldest, 'day')}` : ', none of it overdue yet'}.\n\n${lines.join('\n')}\n\n${footer}`,
    };
  }
  return null;
}

module.exports = { answerFromLedger, detectIntent };
