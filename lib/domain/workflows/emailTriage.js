'use strict';
// lib/domain/workflows/emailTriage.js — the Email triage agent.
//
// Reads one email (from Gmail, or text a webhook sent) and says what it is,
// so a workflow can route it:
//   invoice          a bill or invoice someone sent you
//   payment_sent     a customer says they paid (remittance, "transferred")
//   payment_promise  a customer says when they will pay
//   dispute          a customer disputes an amount or a delivery
//   question         asks for a statement, a copy, or details
//   other            none of the above
//
// Deterministic rules, no model call: the same email always gets the same
// answer, every answer lists the phrases that decided it, and nothing is
// guessed (an amount or date is returned only when the text states one).
// When the sender's address matches a customer on file, the customer and
// their open balance are attached.

const CATEGORY_RULES = [
  ['dispute', [/\bdisput/i, /\bincorrect (amount|invoice|charge)/i, /\bwrong (amount|invoice|price|quantity)/i, /\bnot (received|delivered)\b/i, /\bdamaged\b/i, /\bovercharg/i, /\bdo not agree\b/i, /\bcredit note\b/i, /\brefund\b/i]],
  ['payment_sent', [/\b(we|i) (have )?(paid|transferred|sent (the )?payment|wired)\b/i, /\bpayment (has been )?(made|sent|processed|completed)\b/i, /\bremittance\b/i, /\bproof of payment\b/i, /\btransaction (id|ref)/i, /\butr\b/i]],
  ['payment_promise', [/\bwill (pay|transfer|clear|settle|send (the )?payment)\b/i, /\bpayment (will be|is) (made|sent|released|scheduled)\b/i, /\bby (end of|next) (week|month)\b/i, /\bscheduled (the )?payment\b/i, /\bwe('| a)?ll (pay|clear|settle)\b/i]],
  ['invoice', [/\binvoice (attached|enclosed|for|no|number|#)/i, /\bplease find (attached )?(the |our )?(invoice|bill)\b/i, /\bamount due\b/i, /\bdue date\b/i, /\bpayment (is )?due\b/i, /\bnew invoice\b/i, /\bbill (for|attached)\b/i]],
  ['question', [/\b(send|share|need) (me |us )?(a |the )?(copy|statement|soa|ledger|invoice copy)\b/i, /\bstatement of account\b/i, /\bcan you (confirm|send|share)\b/i, /\?\s*$/m]],
];

const CURRENCY_SYMBOLS = { '$': 'USD', '€': 'EUR', '£': 'GBP', '₹': 'INR', '¥': 'JPY' };
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function extractAmount(text) {
  const m = /(?:([$€£₹¥])\s?|\b(USD|EUR|GBP|INR|AUD|CAD|SGD|AED|JPY)\s?)(\d{1,3}(?:[,\s]\d{2,3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)(\s?(k|m|thousand|million|lakh|crore)\b)?/i.exec(text);
  if (!m) return { amount: null, currency: null };
  let v = Number(String(m[3]).replace(/[,\s]/g, ''));
  const mult = { k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, lakh: 1e5, crore: 1e7 }[String(m[5] || '').toLowerCase()];
  if (mult) v *= mult;
  if (!Number.isFinite(v) || v <= 0) return { amount: null, currency: null };
  return { amount: Math.round(v * 100) / 100, currency: m[2] ? m[2].toUpperCase() : CURRENCY_SYMBOLS[m[1]] || null };
}

function extractInvoiceNumber(text) {
  const m = /\b(?:invoice|inv|bill)\s*(?:no\.?|number|#|:)?\s*#?\s*([A-Z0-9][A-Z0-9/_-]{2,24})\b/i.exec(text);
  if (!m) return null;
  const v = m[1];
  return /\d/.test(v) ? v.toUpperCase() : null;
}

function extractDate(text) {
  const iso = /\b(20\d{2})-(\d{2})-(\d{2})\b/.exec(text);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const named = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s*(20\d{2})?\b/i.exec(text)
    || /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(20\d{2})?\b/i.exec(text);
  if (!named) return null;
  let day; let mon; let year = named[3];
  if (/^\d/.test(named[1])) { day = Number(named[1]); mon = MONTHS.indexOf(named[2].slice(0, 3).toLowerCase()); } else { mon = MONTHS.indexOf(named[1].slice(0, 3).toLowerCase()); day = Number(named[2]); }
  if (mon < 0 || day < 1 || day > 31) return null;
  if (!year) return `--${String(mon + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`; // month-day; no year stated
  return `${year}-${String(mon + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Pure: classify one email. */
function triageEmail({ subject = '', body = '', fromAddress = '' } = {}) {
  const text = `${subject}\n${body}`.slice(0, 8000);
  let category = 'other';
  const matched = [];
  for (const [cat, rules] of CATEGORY_RULES) {
    const hits = rules.map((r) => (r.exec(text) || [])[0]).filter(Boolean);
    if (hits.length) { category = cat; matched.push(...hits.map((h) => h.trim().slice(0, 60))); break; }
  }
  const { amount, currency } = extractAmount(text);
  const invoiceNumber = extractInvoiceNumber(text);
  const date = ['payment_promise', 'invoice', 'payment_sent'].includes(category) ? extractDate(text) : null;
  return {
    category,
    amount,
    currency,
    invoiceNumber,
    date,
    fromAddress: String(fromAddress || '').toLowerCase(),
    evidence: matched,
  };
}

const LABEL = {
  invoice: 'an invoice or bill', payment_sent: 'a payment confirmation', payment_promise: 'a promise to pay',
  dispute: 'a dispute', question: 'a question', other: 'not about money owed or owing',
};

/**
 * The agent: triage the email from the trigger, and look up the sender
 * among this tenant's customers.
 */
async function runEmailTriage(pool, userId, email) {
  if (!email || (!email.subject && !email.body)) {
    return { status: 'NEEDS_DATA', headline: 'There was no email to read. Use this agent after an email trigger.', category: null };
  }
  const t = triageEmail(email);
  let customer = null;
  if (t.fromAddress && pool) {
    try {
      const r = await pool.query(
        `SELECT c.id, c.name,
                COALESCE((SELECT SUM(GREATEST(COALESCE(i.invoice_amount,0) - COALESCE(i.payment_amount,0), 0)) FROM invoices i
                           WHERE i.user_id = c.user_id AND i.customer_id = c.id AND lower(COALESCE(i.payment_status,'')) NOT IN ('paid','cancelled','written_off')), 0) AS open_balance
           FROM customers c WHERE c.user_id = $1 AND lower(c.email) = $2 LIMIT 1`,
        [userId, t.fromAddress]
      );
      if (r.rows[0]) customer = { id: r.rows[0].id, name: r.rows[0].name, openBalance: Number(r.rows[0].open_balance) || 0 };
    } catch { /* customers table without email column: no match */ }
  }
  const who = customer ? customer.name : t.fromAddress || 'the sender';
  const bits = [`Email from ${who} reads as ${LABEL[t.category]}`];
  if (t.amount !== null) bits.push(`amount ${t.currency ? `${t.currency} ` : ''}${t.amount}`);
  if (t.invoiceNumber) bits.push(`invoice ${t.invoiceNumber}`);
  if (t.date) bits.push(`date ${t.date}`);
  return {
    status: 'DONE',
    ...t,
    customer,
    headline: `${bits.join(', ')}.`,
  };
}

module.exports = { triageEmail, runEmailTriage, extractAmount, extractInvoiceNumber, extractDate, LABEL };
