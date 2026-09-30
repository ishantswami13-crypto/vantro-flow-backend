'use strict';
// Turns an invoice/receivables export from (almost) any bookkeeping software
// into Starlane invoices — without the owner mapping columns by hand.
//
//   parseDelimited(text)        robust CSV/TSV/semicolon parsing (quotes, CRLF, BOM)
//   detectSource(headers)       which software the export looks like it came from
//   mapHeaders(headers)         header → field, scored; never two fields on one column
//   toInvoice(row, mapping, …)  one row → invoice fields, or a plain reason it was skipped
//
// Pure functions; no I/O. Known exports (Tally, Busy, Marg, Vyapar, Zoho
// Books, QuickBooks, Xero, Khatabook) are recognised by their header
// vocabulary; anything else goes through the same scored matching.
//
// Rules that keep it honest:
//   - An amount column is never a date/number/percentage column ("Due Date",
//     "Invoice No." and "Tax %" cannot be read as money).
//   - Outstanding balance wins over invoice total when both exist — that is
//     what is actually owed.
//   - Days overdue come from the due date when there is one, otherwise from
//     the invoice date plus the payment terms if given, otherwise the invoice
//     date (and the result says which was used).
//   - Dates are read day-first (Indian convention) unless unambiguous.

const FIELDS = {
  customer_name: {
    exact: ['customer name', 'customer', 'name', 'party name', 'party', "party's name", 'party ledger name', 'ledger name', 'client name', 'client', 'contactname', 'contact name', 'debtor', 'debtor name', 'buyer', 'buyer name', 'account name', 'name of party', 'billed to', 'bill to'],
    words: ['customer', 'party', 'client', 'debtor', 'buyer', 'contact', 'ledger', 'name'],
    avoid: ['phone', 'mobile', 'email', 'gst', 'id', 'code', 'address', 'number', 'no', 'item', 'product', 'stock', 'file', 'company'],
  },
  balance: {
    exact: ['balance', 'balance due', 'amount due', 'amountdue', 'outstanding', 'outstanding amount', 'o/s amount', 'os amount', 'pending amount', 'open balance', 'due amount', 'net outstanding', 'closing balance', 'receivable', 'balance amount'],
    words: ['balance', 'outstanding', 'pending', 'receivable', 'o/s'],
    avoid: ['date', 'days', 'no', 'number', '%', 'percent', 'status'],
  },
  amount: {
    exact: ['amount', 'invoice amount', 'bill amount', 'bill amt', 'total', 'total amount', 'invoice total', 'grand total', 'net amount', 'value', 'invoice value', 'debit', 'dr amount'],
    words: ['amount', 'amt', 'total', 'value', 'debit'],
    avoid: ['date', 'days', 'no', 'number', '%', 'percent', 'tax', 'gst', 'cgst', 'sgst', 'igst', 'discount', 'paid', 'received', 'status', 'quantity', 'qty', 'rate'],
  },
  paid: {
    exact: ['amount paid', 'paid amount', 'received', 'amount received', 'payments', 'payment received', 'credit', 'cr amount'],
    words: ['paid', 'received'],
    avoid: ['date', 'status', 'mode'],
  },
  invoice_number: {
    exact: ['invoice number', 'invoice no', 'invoice no.', 'invoice#', 'invoice #', 'invoicenumber', 'bill no', 'bill no.', 'bill number', 'voucher no', 'voucher no.', 'voucher number', 'vch no', 'num', 'number', 'ref no', 'reference', 'doc no'],
    words: ['invoice no', 'invoice number', 'bill no', 'voucher no', 'vch no', 'ref'],
    avoid: ['date', 'amount', 'phone', 'mobile'],
  },
  invoice_date: {
    exact: ['invoice date', 'invoicedate', 'bill date', 'date', 'voucher date', 'vch date', 'txn date', 'transaction date', 'document date', 'issue date'],
    words: ['date'],
    avoid: ['due', 'payment date', 'paid'],
  },
  due_date: {
    exact: ['due date', 'duedate', 'due on', 'payment due', 'payment due date', 'due by'],
    words: ['due date', 'due on', 'due by'],
    avoid: [],
  },
  terms_days: {
    exact: ['credit days', 'credit period', 'payment terms', 'terms', 'due days'],
    words: ['credit days', 'credit period', 'terms'],
    avoid: [],
  },
  phone: {
    exact: ['phone', 'mobile', 'mobile no', 'mobile number', 'phone number', 'contact number', 'contact no', 'whatsapp', 'whatsapp number', 'cell'],
    words: ['phone', 'mobile', 'whatsapp', 'contact no', 'contact number'],
    avoid: ['invoice', 'bill', 'voucher', 'gst', 'pan'],
  },
  email: { exact: ['email', 'email id', 'e-mail', 'emailaddress', 'email address'], words: ['email', 'e-mail'], avoid: [] },
  status: { exact: ['status', 'payment status', 'invoice status', 'state'], words: ['status'], avoid: [] },
};

// Header vocabulary that identifies common Indian and global bookkeeping exports.
const SOURCES = [
  { id: 'zoho_books', name: 'Zoho Books', any: [['customer name', 'invoice#'], ['customer name', 'invoice number', 'balance']] },
  { id: 'quickbooks', name: 'QuickBooks', any: [['customer', 'num', 'open balance'], ['customer', 'num', 'amount', 'due date']] },
  { id: 'xero', name: 'Xero', any: [['contactname', 'invoicenumber'], ['contactname', 'amountdue']] },
  { id: 'tally', name: 'TallyPrime', any: [["party's name", 'vch no.'], ["party's name", 'pending amount'], ['particulars', 'vch type'], ['party ledger name'], ['voucher no', 'party name', 'pending amount']] },
  { id: 'busy', name: 'Busy', any: [['party name', 'bill no', 'bill amt'], ['party', 'bill no', 'balance']] },
  { id: 'marg', name: 'Marg ERP', any: [['party', 'bill amount', 'o/s amount'], ['party name', 'o/s amount']] },
  { id: 'vyapar', name: 'Vyapar', any: [['party name', 'invoice no', 'balance due'], ['party name', 'total amount', 'balance due']] },
  { id: 'khatabook', name: 'Khatabook', any: [['customer name', 'you will get'], ['name', 'you will get']] },
];

const norm = (h) => String(h ?? '').replace(/^﻿/, '').trim().toLowerCase().replace(/[_\s]+/g, ' ');
const tokens = (h) => norm(h).split(/[^a-z0-9%/#.']+/).filter(Boolean);

function detectSource(headers) {
  const set = new Set(headers.map(norm));
  for (const s of SOURCES) if (s.any.some((combo) => combo.every((h) => set.has(h)))) return { id: s.id, name: s.name };
  return { id: 'generic', name: null };
}

function scoreHeader(header, field) {
  const h = norm(header);
  const spec = FIELDS[field];
  if (spec.exact.includes(h)) return 100;
  const toks = tokens(h);
  if (spec.avoid.some((a) => (a.length <= 3 ? toks.includes(a) : h.includes(a)))) return 0;
  let best = 0;
  for (const w of spec.words) if (h.includes(w)) best = Math.max(best, 60 + Math.min(20, w.length));
  return best;
}

/**
 * Map headers to fields. Each column is used for at most one field; stronger
 * matches claim columns first. Returns { byField: {field: header}, confidence,
 * verdicts: {field: 'exact'|'guessed'|'missing'} }.
 */
function mapHeaders(headers) {
  const candidates = [];
  for (const field of Object.keys(FIELDS)) {
    headers.forEach((header, index) => {
      const s = scoreHeader(header, field);
      if (s > 0) candidates.push({ field, header, index, s });
    });
  }
  candidates.sort((a, b) => b.s - a.s || a.index - b.index);
  const byField = {};
  const verdicts = {};
  const used = new Set();
  for (const c of candidates) {
    if (byField[c.field] || used.has(c.index)) continue;
    byField[c.field] = c.header;
    verdicts[c.field] = c.s >= 100 ? 'exact' : 'guessed';
    used.add(c.index);
  }
  for (const f of Object.keys(FIELDS)) if (!verdicts[f]) verdicts[f] = 'missing';
  const hasMoney = !!(byField.balance || byField.amount);
  const confidence = !byField.customer_name || !hasMoney ? 'insufficient'
    : [verdicts.customer_name, byField.balance ? verdicts.balance : verdicts.amount].every((v) => v === 'exact') ? 'high' : 'medium';
  return { byField, verdicts, confidence };
}

/** ₹1,28,500.50 · Rs. 1,28,500 · 128500 Dr · (5,000) · 1.28.500,50 is NOT guessed. */
function parseAmount(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = String(v).trim();
  if (!s) return null;
  let sign = 1;
  if (/^\(.*\)$/.test(s)) { sign = -1; s = s.slice(1, -1); }
  if (/\bcr\.?$/i.test(s)) sign = -1;
  s = s.replace(/\b(dr|cr)\.?$/i, '').replace(/₹|rs\.?|inr/gi, '').replace(/[\s,]/g, '');
  if (s.startsWith('-')) { sign = -sign; s = s.slice(1); }
  // At most two decimals: "10.000" (European thousands) is not guessed as ten.
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  return sign * parseFloat(s);
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const iso = (y, m, d) => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? dt.toISOString().slice(0, 10) : null;
};
/** Day-first (Indian) unless unambiguous; Excel serials; Date objects; ISO; 12-Apr-2026 / 12 April 2026. */
function parseDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  if (typeof v === 'number') {
    if (v > 20000 && v < 80000) return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10);
    return null;
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (m) {
    let [a, b, y] = [+m[1], +m[2], +m[3]];
    if (y < 100) y += 2000;
    if (a > 12 && b <= 12) return iso(y, b, a);      // unambiguous day-first
    if (b > 12 && a <= 12) return iso(y, a, b);      // unambiguous month-first
    return iso(y, b, a);                              // ambiguous → day-first (India)
  }
  m = s.match(/^(\d{1,2})[\s-]([a-z]{3,9})[\s,-]*(\d{2,4})$/i);
  if (m) {
    const mon = MONTHS[m[2].toLowerCase().slice(0, 4)] ?? MONTHS[m[2].toLowerCase().slice(0, 3)];
    if (!mon) return null;
    let y = +m[3]; if (y < 100) y += 2000;
    return iso(y, mon, +m[1]);
  }
  return null;
}

const PAID_WORDS = /\b(paid|cleared|settled|closed|received)\b/i;
const OPEN_WORDS = /\b(unpaid|overdue|due|open|pending|partially|partial|outstanding)\b/i;

/**
 * One row → { invoice } or { skip: reason }. `today` is injectable for tests.
 */
function toInvoice(row, byField, { today = new Date() } = {}) {
  const get = (f) => (byField[f] ? row[byField[f]] : undefined);
  const name = String(get('customer_name') ?? '').trim();
  if (!name) return { skip: 'no customer name' };
  if (/^(total|grand total|sub ?total|closing balance|opening balance)$/i.test(name)) return { skip: 'a totals row' };

  const total = parseAmount(get('amount'));
  const paid = parseAmount(get('paid'));
  let owed = parseAmount(get('balance'));
  if (owed === null && total !== null) owed = paid !== null ? total - paid : total;
  if (owed === null) return { skip: 'no amount' };
  if (owed < 0) return { skip: 'a credit, not money owed' };

  const statusRaw = String(get('status') ?? '');
  const isPaid = owed === 0 || (PAID_WORDS.test(statusRaw) && !OPEN_WORDS.test(statusRaw));

  const invoiceDate = parseDate(get('invoice_date'));
  let dueDate = parseDate(get('due_date'));
  let overdueFrom = 'due_date';
  if (!dueDate && invoiceDate) {
    const terms = parseAmount(get('terms_days'));
    if (terms !== null && terms >= 0 && terms < 400) {
      const d = new Date(`${invoiceDate}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + terms);
      dueDate = d.toISOString().slice(0, 10); overdueFrom = 'terms';
    } else { dueDate = invoiceDate; overdueFrom = 'invoice_date'; }
  }
  const ref = dueDate ? Date.parse(`${dueDate}T00:00:00Z`) : null;
  const t = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const daysOverdue = isPaid || ref === null ? 0 : Math.max(0, Math.floor((t - ref) / 86400000));

  const phoneDigits = String(get('phone') ?? '').replace(/\D/g, '');
  return {
    invoice: {
      customer_name: name.slice(0, 200),
      customer_phone: phoneDigits.length >= 10 ? phoneDigits.slice(-10) : null,
      customer_email: /@/.test(String(get('email') ?? '')) ? String(get('email')).trim().slice(0, 200) : null,
      invoice_number: get('invoice_number') ? String(get('invoice_number')).trim().slice(0, 100) : null,
      invoice_amount: Math.round((isPaid ? (total ?? owed) : owed) * 100) / 100,
      invoice_date: invoiceDate,
      due_date: dueDate,
      payment_status: isPaid ? 'Paid' : 'Pending',
      days_overdue: daysOverdue,
      overdue_from: dueDate ? overdueFrom : null,
    },
  };
}

/** Minimal RFC-4180 parser with delimiter sniffing (comma, semicolon, tab, pipe). */
function parseDelimited(text) {
  const src = String(text).replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] || '';
  const delim = [',', ';', '\t', '|'].map((d) => [d, firstLine.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) {
      if (ch === '"') { if (src[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

/**
 * Some exports (Tally, Busy) put a company title and blank lines above the
 * real header. Pick the first row within the first 15 that maps to a customer
 * and an amount.
 */
function findHeaderRow(matrix) {
  for (let i = 0; i < Math.min(15, matrix.length); i++) {
    const headers = matrix[i].map((h) => String(h ?? '').trim());
    if (mapHeaders(headers).confidence !== 'insufficient') return i;
  }
  return 0;
}

/** Table (array of arrays, first row anywhere near the top) → mapped result. */
function mapTable(matrix, { today } = {}) {
  const h = findHeaderRow(matrix);
  const headers = (matrix[h] || []).map((x) => String(x ?? '').trim());
  const mapping = mapHeaders(headers);
  const source = detectSource(headers);
  const invoices = [];
  const skipped = [];
  for (let r = h + 1; r < matrix.length; r++) {
    const obj = {};
    headers.forEach((k, i) => { obj[k] = matrix[r][i]; });
    const out = toInvoice(obj, mapping.byField, { today });
    if (out.invoice) invoices.push(out.invoice);
    else skipped.push({ row: r + 1, reason: out.skip });
  }
  return { headerRow: h + 1, headers, mapping, source, invoices, skipped };
}

module.exports = { FIELDS, SOURCES, detectSource, mapHeaders, parseAmount, parseDate, toInvoice, parseDelimited, findHeaderRow, mapTable };
