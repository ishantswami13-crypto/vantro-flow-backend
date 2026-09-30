// FILE: lib/domain/decisions/ledgerImport.js
// Receivables ledger import for the decision engine: a business uploads the
// CSV/XLSX it already has (sales register, outstanding report, Tally export)
// and Starlane turns it into invoices the engine can reason about.
//
//   readLedgerFile -> proposeMapping (preview, writes nothing)
//   -> normalizeRows(mapping the human confirmed) -> commitLedger (one
//   transaction, idempotent) -> profileLedger ("what I found").
//
// Rules this module keeps:
//   - Nothing is guessed silently. A column match that is not exact, a date
//     column whose day/month order cannot be proven, and a file with no
//     payment status at all are all returned as needsConfirmation; commit
//     only uses the mapping the caller sends back, never its own guesses.
//   - A row that cannot be read is rejected with a reason and a row number.
//     A missing date never becomes today; a negative amount is not flipped.
//   - Re-importing the same file changes nothing. Re-importing a newer export
//     updates payment status on the same invoices (that is how "did it
//     work?" gets observed from files), keyed on customer + invoice number.
//   - Invoices already present from another source (Tally sync, manual) are
//     never duplicated.

const crypto = require('crypto');
const XLSX = require('xlsx');
const { DAY_MS, parseBusinessDate, toIsoDate, startOfUtcDay, daysBetween } = require('./dates');
const { normalizeName } = require('./snapshot');

const SOURCE_TYPE = 'ledger_import';
const MAX_ROWS = 50000;

// Field -> header aliases. Exact matches confirm; partial matches only suggest.
const FIELDS = {
  customer: { required: true, kind: 'text', aliases: ['customer', 'customer name', 'party', 'party name', 'party ledger name', 'ledger name', 'ledger', 'client', 'client name', 'buyer', 'buyer name', 'debtor', 'debtor name', 'bill to', 'account name', 'name of party', 'particulars'] },
  invoice_number: { kind: 'text', aliases: ['invoice no', 'invoice number', 'invoice #', 'invoice', 'inv no', 'inv #', 'bill no', 'bill number', 'bill #', 'voucher no', 'voucher number', 'vch no', 'doc no', 'document no', 'document number', 'ref no', 'reference', 'reference no'] },
  invoice_date: { required: true, kind: 'date', aliases: ['invoice date', 'bill date', 'voucher date', 'vch date', 'date', 'inv date', 'document date', 'doc date', 'posting date', 'sale date', 'txn date'] },
  due_date: { kind: 'date', aliases: ['due date', 'due on', 'payment due date', 'due by', 'overdue since', 'due'] },
  amount: { required: true, kind: 'money', aliases: ['invoice amount', 'amount', 'bill amount', 'total', 'invoice total', 'invoice value', 'bill value', 'gross amount', 'net amount', 'grand total', 'value', 'sale amount', 'debit', 'dr amount'] },
  paid_amount: { kind: 'money', aliases: ['amount paid', 'paid amount', 'amount received', 'received amount', 'received', 'payment amount', 'payment received', 'collected', 'receipts', 'credit', 'cr amount'] },
  outstanding: { kind: 'money', aliases: ['outstanding', 'outstanding amount', 'balance', 'balance due', 'balance amount', 'pending amount', 'amount due', 'due amount', 'closing balance', 'pending'] },
  payment_date: { kind: 'date', aliases: ['payment date', 'paid on', 'paid date', 'date of payment', 'receipt date', 'received on', 'received date', 'settlement date', 'cleared on', 'collection date'] },
  status: { kind: 'status', aliases: ['status', 'payment status', 'paid status', 'invoice status', 'state', 'paid?'] },
  currency: { kind: 'currency', aliases: ['currency', 'ccy', 'curr', 'currency code'] },
  credit_days: { kind: 'integer', aliases: ['credit days', 'credit period', 'credit period days', 'payment terms', 'terms', 'credit terms', 'terms days', 'days allowed'] },
  phone: { kind: 'text', aliases: ['phone', 'mobile', 'mobile no', 'phone number', 'contact', 'contact no', 'whatsapp', 'whatsapp no'] },
};
const FIELD_KEYS = Object.keys(FIELDS);

const PAID_TOKENS = new Set(['paid', 'settled', 'cleared', 'closed', 'received', 'collected', 'fully paid', 'complete', 'completed', 'done', 'yes', 'y']);
const OPEN_TOKENS = new Set(['unpaid', 'pending', 'open', 'due', 'outstanding', 'overdue', 'not paid', 'no', 'n', 'raised', 'sent', 'issued', 'partially paid', 'partial', 'part paid', 'partly paid']);
const PARTIAL_TOKENS = new Set(['partially paid', 'partial', 'part paid', 'partly paid']);
const VOID_TOKENS = new Set(['cancelled', 'canceled', 'void', 'voided', 'credit note', 'reversed', 'written off', 'write off', 'draft']);

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

// ── File reading ─────────────────────────────────────────────────────────

function fileTypeOf(filename) {
  const ext = String(filename || '').toLowerCase().split('.').pop();
  if (ext === 'csv' || ext === 'txt') return 'CSV';
  if (ext === 'xlsx' || ext === 'xls' || ext === 'xlsm') return 'XLSX';
  return null;
}

// Excel stores dates as serial numbers; cellDates turns them into Date
// objects, which we keep as ISO days so day/month order is never in question.
function readLedgerFile(buffer, filename) {
  const fileType = fileTypeOf(filename);
  if (!fileType) return { ok: false, error: 'Please upload a .csv or .xlsx file.' };
  let headers = [];
  let rows = [];
  let sheet = null;
  try {
    if (fileType === 'CSV') {
      const text = buffer.toString('utf8');
      const parsed = parseDelimited(text, sniffDelimiter(text));
      headers = parsed.headers;
      rows = parsed.rows;
    } else {
      const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true, cellFormula: false, cellHTML: false });
      for (const name of wb.SheetNames) {
        const aoa = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '', blankrows: false });
        const headerAt = findHeaderRow(aoa);
        if (headerAt === -1) continue;
        sheet = name;
        headers = aoa[headerAt].map((h) => String(h).trim());
        rows = aoa.slice(headerAt + 1).map((r) => headers.map((_, i) => cellToString(r[i])));
        break;
      }
    }
  } catch (err) {
    return { ok: false, error: `This file could not be read (${err.message}). Try saving it again as .xlsx or .csv.` };
  }
  headers = headers.map((h, i) => (String(h || '').trim() || `Column ${i + 1}`));
  rows = rows.filter((r) => r.some((v) => String(v || '').trim() !== ''));
  if (!headers.length || !rows.length) return { ok: false, error: 'The file has no rows under its header.' };
  if (rows.length > MAX_ROWS) return { ok: false, error: `The file has ${rows.length} rows. Please split it into files of ${MAX_ROWS} rows or fewer.` };
  return { ok: true, fileType, sheet, headers, rows };
}

function cellToString(v) {
  if (v == null) return '';
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return '';
    // SheetJS builds dates in local time; shift by the offset to recover the calendar day.
    const t = v.getTime() - v.getTimezoneOffset() * 60000;
    return new Date(t).toISOString().slice(0, 10);
  }
  return String(v);
}

// Exports often carry a title block above the real header ("Sharma Traders
// — Outstanding as on ..."). The header is the first row with 3+ text cells.
function findHeaderRow(aoa) {
  for (let i = 0; i < Math.min(aoa.length, 15); i++) {
    const texts = (aoa[i] || []).filter((c) => typeof c === 'string' && c.trim() && !/^[\d,.\s₹-]+$/.test(c));
    if (texts.length >= 3) return i;
  }
  return aoa.length ? 0 : -1;
}

function sniffDelimiter(text) {
  const first = String(text).replace(/^\uFEFF/, '').split(/\r?\n/)[0] || '';
  const counts = { ',': 0, ';': 0, '\t': 0, '|': 0 };
  let inQ = false;
  for (const ch of first) {
    if (ch === '"') inQ = !inQ;
    else if (!inQ && counts[ch] !== undefined) counts[ch]++;
  }
  const [best, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return n > 0 ? best : ',';
}

// RFC 4180 with a chosen delimiter: quoted fields, "" escapes, CRLF/LF,
// newlines inside quotes.
function parseDelimited(text, delimiter) {
  const raw = String(text).replace(/^\uFEFF/, '');
  const out = [];
  let row = [];
  let field = '';
  let inQ = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inQ) {
      if (ch === '"' && raw[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQ = false;
      else field += ch;
      continue;
    }
    if (ch === '"' && field === '') { inQ = true; continue; }
    if (ch === delimiter) { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field); out.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field !== '' || row.length) { row.push(field); out.push(row); }
  const headerAt = findHeaderRow(out);
  const headers = (out[headerAt] || []).map((h) => String(h).trim());
  const rows = out.slice(headerAt + 1).map((r) => headers.map((_, i) => (r[i] == null ? '' : String(r[i]).trim())));
  return { headers, rows };
}

// ── Value parsing ────────────────────────────────────────────────────────

function normHeader(h) {
  return String(h || '').toLowerCase().replace(/[_./\\()[\]:-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Money in Indian and western formats. Returns { value } or { error }. */
function parseMoney(raw) {
  if (raw == null) return { value: null };
  let s = String(raw).trim();
  if (!s || s === '-' || s === '—') return { value: null };
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  let side = null;
  const drcr = s.match(/\s*\b(dr|cr)\.?$/i);
  if (drcr) { side = drcr[1].toLowerCase(); s = s.slice(0, drcr.index); }
  s = s.replace(/₹|rs\.?|inr|\$|usd|€|eur|£|gbp|aed/gi, '').replace(/\s+/g, '');
  if (s.startsWith('-')) { negative = !negative; s = s.slice(1); }
  if (!/^\d{1,3}(,\d{2,3})*(\.\d+)?$|^\d+(\.\d+)?$/.test(s)) return { error: `"${String(raw).trim()}" is not an amount` };
  const n = Number(s.replace(/,/g, ''));
  if (!Number.isFinite(n)) return { error: `"${String(raw).trim()}" is not an amount` };
  return { value: negative ? -n : n, side };
}

function currencyOf(raw) {
  const s = String(raw || '');
  if (/₹|\brs\.?|\binr\b/i.test(s)) return 'INR';
  if (/\$|\busd\b/i.test(s)) return 'USD';
  if (/€|\beur\b/i.test(s)) return 'EUR';
  if (/£|\bgbp\b/i.test(s)) return 'GBP';
  if (/\baed\b/i.test(s)) return 'AED';
  return null;
}

/** Parses one date string. order: 'DMY' | 'MDY'. Returns UTC day ms or null. */
function parseDateWithOrder(raw, order = 'DMY') {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/);
  if (m) return utc(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[-/. ]([A-Za-z]{3,9})[-/. ,]*(\d{2}|\d{4})$/);
  if (m) {
    const mo = MONTHS[m[2].slice(0, 4).toLowerCase()] || MONTHS[m[2].slice(0, 3).toLowerCase()];
    return mo ? utc(year4(m[3]), mo, +m[1]) : null;
  }
  m = s.match(/^([A-Za-z]{3,9})[ -](\d{1,2}),?[ -](\d{2}|\d{4})$/);
  if (m) {
    const mo = MONTHS[m[1].slice(0, 4).toLowerCase()] || MONTHS[m[1].slice(0, 3).toLowerCase()];
    return mo ? utc(year4(m[3]), mo, +m[2]) : null;
  }
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})(?:\s.*)?$/);
  if (m) {
    const [a, b, y] = [+m[1], +m[2], year4(m[3])];
    return order === 'MDY' ? utc(y, a, b) : utc(y, b, a);
  }
  return null;
}

function year4(y) {
  const n = Number(y);
  return y.length === 2 ? 2000 + n : n;
}

function utc(y, mo, d) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) return null;
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  return back.getUTCMonth() === mo - 1 && back.getUTCDate() === d ? t : null;
}

/**
 * Looks at every value in a date column and decides day/month order.
 * Proven when some value can only be one way (13/04/2026 is day-first).
 */
function detectDateOrder(values) {
  let dayFirst = 0;
  let monthFirst = 0;
  let numericSlash = 0;
  for (const v of values) {
    const m = String(v || '').trim().match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})/);
    if (!m) continue;
    numericSlash++;
    if (+m[1] > 12 && +m[2] <= 12) dayFirst++;
    if (+m[2] > 12 && +m[1] <= 12) monthFirst++;
  }
  if (!numericSlash) return { order: 'DMY', verdict: 'NOT_NEEDED', reason: 'dates are unambiguous (ISO or month names)' };
  if (dayFirst && monthFirst) return { order: null, verdict: 'CONFLICT', reason: `${dayFirst} values are day-first and ${monthFirst} are month-first` };
  if (dayFirst) return { order: 'DMY', verdict: 'PROVEN', reason: `${dayFirst} value(s) like 13/04 can only be day/month` };
  if (monthFirst) return { order: 'MDY', verdict: 'PROVEN', reason: `${monthFirst} value(s) like 04/13 can only be month/day` };
  return { order: 'DMY', verdict: 'ASSUMED', reason: 'every date has day and month both 12 or below, so the order cannot be proven; day/month (Indian convention) is assumed' };
}

function statusToken(raw) {
  return String(raw || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// ── Mapping ──────────────────────────────────────────────────────────────

function columnValues(rows, idx) {
  return rows.map((r) => r[idx]).filter((v) => v != null && String(v).trim() !== '');
}

// Whether a column's values fit a field's kind (share of non-empty values).
function kindFit(kind, values) {
  if (!values.length) return 0;
  const sample = values.slice(0, 500);
  let ok = 0;
  for (const v of sample) {
    if (kind === 'money' || kind === 'integer') { if (!parseMoney(v).error && parseMoney(v).value != null) ok++; }
    else if (kind === 'date') { if (parseDateWithOrder(v, 'DMY') != null || parseDateWithOrder(v, 'MDY') != null) ok++; }
    else if (kind === 'status') { const t = statusToken(v); if (PAID_TOKENS.has(t) || OPEN_TOKENS.has(t) || VOID_TOKENS.has(t)) ok++; }
    else if (kind === 'currency') { if (/^[A-Za-z]{3}$/.test(String(v).trim()) || currencyOf(v)) ok++; }
    else ok++;
  }
  return ok / sample.length;
}

/**
 * Proposes which column holds which field. Returns
 * { fields: {field: {header, verdict, reason, fit}}, unmapped, dateOrders, needsConfirmation, missingRequired }.
 * verdict: CONFIRMED (exact header, values fit) | SUGGESTED (partial header
 * match or weak fit) — SUGGESTED must be confirmed by a human before commit.
 */
function proposeMapping(headers, rows) {
  const candidates = [];
  headers.forEach((header, idx) => {
    const h = normHeader(header);
    const values = columnValues(rows, idx);
    for (const field of FIELD_KEYS) {
      const def = FIELDS[field];
      let match = null;
      for (const alias of def.aliases) {
        if (h === alias) { match = { strength: 2, alias }; break; }
      }
      if (!match) {
        for (const alias of def.aliases) {
          if (alias.length >= 4 && (h.startsWith(`${alias} `) || h.endsWith(` ${alias}`) || h.includes(` ${alias} `))) {
            if (!match || alias.length > match.alias.length) match = { strength: 1, alias };
          }
        }
      }
      if (!match) continue;
      const fit = kindFit(def.kind, values);
      if (fit < 0.5) continue; // "Paid" with Yes/No values is not an amount
      candidates.push({ field, header, idx, strength: match.strength, alias: match.alias, fit });
    }
  });
  // Greedy assignment: strongest header match, then most specific alias, then fit.
  candidates.sort((a, b) => b.strength - a.strength || b.alias.length - a.alias.length || b.fit - a.fit);
  const fields = {};
  const usedHeaders = new Set();
  for (const c of candidates) {
    if (fields[c.field] || usedHeaders.has(c.header)) continue;
    const confirmed = c.strength === 2 && c.fit >= 0.9;
    fields[c.field] = {
      header: c.header,
      verdict: confirmed ? 'CONFIRMED' : 'SUGGESTED',
      reason: c.strength === 2 ? `column is named "${c.header}"${c.fit < 0.9 ? `, but only ${Math.round(c.fit * 100)}% of its values look right` : ''}` : `column "${c.header}" looks like ${c.field.replace('_', ' ')} (partial name match)`,
      fit: Math.round(c.fit * 100) / 100,
    };
    usedHeaders.add(c.header);
  }
  const dateOrders = {};
  for (const f of ['invoice_date', 'due_date', 'payment_date']) {
    if (!fields[f]) continue;
    const idx = headers.indexOf(fields[f].header);
    dateOrders[fields[f].header] = detectDateOrder(columnValues(rows, idx));
  }
  const needsConfirmation = [];
  for (const [field, m] of Object.entries(fields)) {
    if (m.verdict !== 'CONFIRMED') needsConfirmation.push({ key: `field:${field}`, field, header: m.header, message: `Is "${m.header}" the ${label(field)}?`, reason: m.reason });
  }
  for (const [header, d] of Object.entries(dateOrders)) {
    if (d.verdict === 'ASSUMED') needsConfirmation.push({ key: `dateOrder:${header}`, header, message: `Are dates in "${header}" written day/month (e.g. 03/04 = 3 April)?`, reason: d.reason });
    if (d.verdict === 'CONFLICT') needsConfirmation.push({ key: `dateOrder:${header}`, header, message: `"${header}" mixes day/month and month/day dates. Rows that cannot be read either way will be skipped.`, reason: d.reason, blocking: false });
  }
  if (!fields.status && !fields.paid_amount && !fields.outstanding && !fields.payment_date) {
    needsConfirmation.push({ key: 'assumption:all_open', message: 'There is no status, paid or balance column. Should every row be treated as still unpaid?', reason: 'without one of these, Starlane cannot tell paid invoices from unpaid ones' });
  }
  const missingRequired = FIELD_KEYS.filter((f) => FIELDS[f].required && !fields[f] && !(f === 'amount' && fields.outstanding));
  const unmapped = headers.filter((h) => !usedHeaders.has(h));
  return { fields, dateOrders, unmapped, needsConfirmation, missingRequired };
}

function label(field) {
  return {
    customer: 'customer name', invoice_number: 'invoice number', invoice_date: 'invoice date', due_date: 'due date', amount: 'invoice amount',
    paid_amount: 'amount paid', outstanding: 'balance still owed', payment_date: 'payment date', status: 'payment status', currency: 'currency',
    credit_days: 'credit days', phone: 'phone number',
  }[field] || field;
}

/**
 * Validates a caller-supplied mapping (the one a human confirmed).
 * mapping: { field: header|null }, dateOrders: { header: 'DMY'|'MDY' }.
 */
function validateMapping(headers, input = {}) {
  const errors = [];
  const fields = {};
  const mapping = input.mapping || {};
  for (const [field, header] of Object.entries(mapping)) {
    if (!FIELDS[field]) { errors.push(`unknown field "${field}"`); continue; }
    if (header == null || header === '') continue;
    if (!headers.includes(header)) { errors.push(`column "${header}" is not in the file`); continue; }
    fields[field] = header;
  }
  const seen = new Map();
  for (const [f, h] of Object.entries(fields)) {
    if (seen.has(h)) errors.push(`column "${h}" is used for both ${label(seen.get(h))} and ${label(f)}`);
    seen.set(h, f);
  }
  if (!fields.customer) errors.push('choose the customer name column');
  if (!fields.invoice_date) errors.push('choose the invoice date column');
  if (!fields.amount && !fields.outstanding) errors.push('choose the invoice amount (or balance) column');
  const dateOrders = {};
  for (const f of ['invoice_date', 'due_date', 'payment_date']) {
    if (!fields[f]) continue;
    const o = input.dateOrders && input.dateOrders[fields[f]];
    if (o !== 'DMY' && o !== 'MDY') errors.push(`say whether "${fields[f]}" is day/month or month/day`);
    dateOrders[f] = o;
  }
  const hasPaymentSignal = fields.status || fields.paid_amount || fields.outstanding || fields.payment_date;
  if (!hasPaymentSignal && input.allOpen !== true) errors.push('confirm that every row is still unpaid, or map a status, paid or balance column');
  let currency = null;
  if (input.currency != null && input.currency !== '') {
    if (!/^[A-Z]{3}$/.test(String(input.currency))) errors.push('currency must be a 3-letter code such as INR');
    else currency = String(input.currency);
  }
  let defaultCreditDays = null;
  if (input.defaultCreditDays != null && input.defaultCreditDays !== '') {
    const n = Number(input.defaultCreditDays);
    if (!Number.isInteger(n) || n < 0 || n > 365) errors.push('default credit days must be a whole number from 0 to 365');
    else defaultCreditDays = n;
  }
  return { ok: errors.length === 0, errors, fields, dateOrders, currency, defaultCreditDays, allOpen: input.allOpen === true };
}

// ── Row normalisation ────────────────────────────────────────────────────

function sourceKey(customerKey, number, invoiceIso, amount, occurrence) {
  const base = number ? `inv:${customerKey}|${String(number).trim().toLowerCase()}` : `row:${customerKey}|${invoiceIso}|${amount}|${occurrence}`;
  return crypto.createHash('sha256').update(base).digest('hex').slice(0, 32);
}

/**
 * Turns file rows into invoice records using a validated mapping. Pure.
 * Returns { records, rejected: [{row, reason}], warnings: {key: {count, rows}} }.
 */
function normalizeRows(headers, rows, v, { asOf = Date.now(), baseCurrency = 'INR' } = {}) {
  const col = (field) => (v.fields[field] ? headers.indexOf(v.fields[field]) : -1);
  const idx = Object.fromEntries(FIELD_KEYS.map((f) => [f, col(f)]));
  const get = (row, field) => (idx[field] === -1 ? '' : String(row[idx[field]] == null ? '' : row[idx[field]]).trim());
  const today = startOfUtcDay(asOf);
  const records = [];
  const rejected = [];
  const warnings = {};
  const warn = (key, rowNo) => {
    const w = warnings[key] || (warnings[key] = { count: 0, rows: [] });
    w.count++;
    if (w.rows.length < 5) w.rows.push(rowNo);
  };
  const reject = (rowNo, reason) => rejected.push({ row: rowNo, reason });
  const byNumber = new Map();
  const occurrences = new Map();

  rows.forEach((row, i) => {
    const rowNo = i + 2; // header is row 1 in a spreadsheet
    const customer = get(row, 'customer').replace(/\s+/g, ' ');
    if (!customer) return reject(rowNo, 'no customer name');
    if (/^(grand )?total$|^sub ?total$/i.test(customer)) return reject(rowNo, 'looks like a totals row');

    const statusRaw = statusToken(get(row, 'status'));
    if (statusRaw && VOID_TOKENS.has(statusRaw)) return reject(rowNo, `status is "${get(row, 'status')}" (not a live invoice)`);

    const amountP = idx.amount !== -1 ? parseMoney(get(row, 'amount')) : { value: null };
    const outstandingP = idx.outstanding !== -1 ? parseMoney(get(row, 'outstanding')) : { value: null };
    const paidP = idx.paid_amount !== -1 ? parseMoney(get(row, 'paid_amount')) : { value: null };
    if (amountP.error) return reject(rowNo, `amount ${amountP.error.replace(/ is not an amount$/, ' could not be read')}`);
    if (outstandingP.error) return reject(rowNo, `balance ${outstandingP.error.replace(/ is not an amount$/, ' could not be read')}`);
    if (paidP.error) return reject(rowNo, `amount paid ${paidP.error.replace(/ is not an amount$/, ' could not be read')}`);
    if (amountP.side === 'cr') return reject(rowNo, 'amount is marked Cr (a credit or receipt, not an invoice)');

    let amount = amountP.value;
    let balanceOnly = false;
    if (amount == null && outstandingP.value != null) { amount = outstandingP.value; balanceOnly = true; }
    if (amount == null) return reject(rowNo, 'no invoice amount');
    if (amount < 0) return reject(rowNo, 'negative amount (credit note or return); not imported as an invoice');
    if (amount === 0) return reject(rowNo, 'zero amount');

    const invoiceDay = parseDateWithOrder(get(row, 'invoice_date'), v.dateOrders.invoice_date);
    if (invoiceDay == null) return reject(rowNo, get(row, 'invoice_date') ? `invoice date "${get(row, 'invoice_date')}" could not be read` : 'no invoice date');
    if (invoiceDay > today + DAY_MS) return reject(rowNo, `invoice date ${toIsoDate(invoiceDay)} is in the future`);

    let dueDay = null;
    let dueDerived = false;
    if (idx.due_date !== -1 && get(row, 'due_date')) {
      dueDay = parseDateWithOrder(get(row, 'due_date'), v.dateOrders.due_date);
      if (dueDay == null) warn('dueDateUnreadable', rowNo);
      else if (dueDay < invoiceDay) { warn('dueBeforeInvoice', rowNo); dueDay = null; }
    }
    if (dueDay == null && idx.credit_days !== -1 && get(row, 'credit_days')) {
      const cd = parseMoney(get(row, 'credit_days').replace(/\s*days?$/i, ''));
      if (!cd.error && cd.value != null && cd.value >= 0 && cd.value <= 365) { dueDay = invoiceDay + Math.round(cd.value) * DAY_MS; dueDerived = true; }
    }
    if (dueDay == null && v.defaultCreditDays != null) { dueDay = invoiceDay + v.defaultCreditDays * DAY_MS; dueDerived = true; warn('dueFromDefaultTerms', rowNo); }
    if (dueDay == null) warn('noDueDate', rowNo);

    let paymentDay = null;
    if (idx.payment_date !== -1 && get(row, 'payment_date')) {
      paymentDay = parseDateWithOrder(get(row, 'payment_date'), v.dateOrders.payment_date);
      if (paymentDay == null) warn('paymentDateUnreadable', rowNo);
      else if (paymentDay > today + DAY_MS) { warn('paymentDateInFuture', rowNo); paymentDay = null; }
      else if (paymentDay < invoiceDay) warn('paymentBeforeInvoice', rowNo);
    }

    // How much has been paid. Amount columns beat the status word; a
    // disagreement is kept, counted and shown, never resolved silently.
    let paid = null;
    let basis;
    if (!balanceOnly && outstandingP.value != null) {
      if (outstandingP.value < 0) { warn('negativeBalance', rowNo); }
      paid = Math.min(Math.max(amount - Math.max(outstandingP.value, 0), 0), amount);
      basis = 'balance';
    } else if (balanceOnly) {
      paid = 0;
      basis = 'balance';
      warn('balanceOnly', rowNo);
    } else if (paidP.value != null) {
      if (paidP.value > amount) warn('paidMoreThanAmount', rowNo);
      paid = Math.min(Math.max(paidP.value, 0), amount);
      basis = 'paid_amount';
    } else if (statusRaw) {
      if (PAID_TOKENS.has(statusRaw)) paid = amount;
      else if (OPEN_TOKENS.has(statusRaw)) { paid = 0; if (PARTIAL_TOKENS.has(statusRaw)) warn('partialAmountUnknown', rowNo); }
      else return reject(rowNo, `status "${get(row, 'status')}" is not understood`);
      basis = 'status';
    } else if (paymentDay != null) {
      paid = amount;
      basis = 'payment_date';
    } else if (v.allOpen || idx.status !== -1) {
      paid = 0;
      basis = v.allOpen ? 'assumed_open' : 'status_blank';
      if (!v.allOpen) warn('statusBlank', rowNo);
    } else {
      paid = 0;
      basis = 'no_signal';
    }
    if (basis !== 'status' && statusRaw) {
      const saysPaid = PAID_TOKENS.has(statusRaw);
      const saysOpen = OPEN_TOKENS.has(statusRaw) && !PARTIAL_TOKENS.has(statusRaw);
      if ((saysPaid && paid < amount) || (saysOpen && paid >= amount)) warn('statusContradictsAmounts', rowNo);
    }
    const fullyPaid = paid >= amount - 0.005;
    if (fullyPaid && paymentDay == null) warn('paidWithoutDate', rowNo);

    const numberRaw = get(row, 'invoice_number');
    const customerKey = normalizeName(customer);
    let currency = null;
    if (idx.currency !== -1 && get(row, 'currency')) {
      const c = get(row, 'currency').toUpperCase();
      currency = /^[A-Z]{3}$/.test(c) ? c : currencyOf(c);
    }
    if (!currency) currency = currencyOf(get(row, 'amount')) || currencyOf(get(row, 'outstanding')) || v.currency || null;
    if (!currency) warn('currencyMissing', rowNo);

    const invoiceIso = toIsoDate(invoiceDay);
    const amount2 = Math.round(amount * 100) / 100;
    if (numberRaw) {
      const k = `${customerKey}|${numberRaw.toLowerCase()}`;
      const prev = byNumber.get(k);
      if (prev) {
        if (prev.invoice_amount === amount2 && prev.invoice_date === invoiceIso) { warn('duplicateRow', rowNo); return; }
        return reject(rowNo, `invoice ${numberRaw} for ${customer} appears again with a different amount or date (row ${prev._row})`);
      }
    }
    const occKey = `${customerKey}|${invoiceIso}|${amount2}`;
    const occurrence = (occurrences.get(occKey) || 0) + 1;
    occurrences.set(occKey, occurrence);
    if (!numberRaw && occurrence > 1) warn('possibleDuplicateNoNumber', rowNo);

    const rec = {
      _row: rowNo,
      source_id: sourceKey(customerKey, numberRaw, invoiceIso, amount2, occurrence),
      invoice_number: numberRaw || null,
      customer_name: customer,
      customer_phone: get(row, 'phone') ? get(row, 'phone').replace(/\D/g, '').slice(-10) || null : null,
      invoice_amount: amount2,
      payment_status: fullyPaid ? 'Paid' : 'Pending',
      payment_amount: paid > 0 ? Math.round(paid * 100) / 100 : null,
      invoice_date: invoiceIso,
      due_date: dueDay == null ? null : toIsoDate(dueDay),
      due_date_derived: dueDerived,
      payment_date: paymentDay == null ? null : toIsoDate(paymentDay),
      currency,
      paid_basis: basis,
    };
    if (numberRaw) byNumber.set(`${customerKey}|${numberRaw.toLowerCase()}`, rec);
    records.push(rec);
  });

  // Names that differ only in legal suffix or punctuation are probably one
  // customer. Shown for confirmation, never merged here.
  const possibleSameCustomer = similarNames([...new Set(records.map((r) => r.customer_name))]);
  return { records, rejected, warnings, possibleSameCustomer, baseCurrency };
}

function stripName(n) {
  return normalizeName(n).replace(/[.,&'"()-]/g, ' ').replace(/\b(pvt|private|ltd|limited|llp|inc|co|company|and|the|m s|ms)\b/g, ' ').replace(/\s+/g, ' ').trim();
}

function similarNames(names) {
  const groups = new Map();
  for (const n of names) {
    const k = stripName(n);
    if (!k) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(n);
  }
  return [...groups.values()].filter((g) => new Set(g.map(normalizeName)).size > 1).slice(0, 20);
}

// ── Profile: "what I found" ──────────────────────────────────────────────

/**
 * Describes a receivables ledger in business terms. Works on DB-shaped rows
 * (invoices table) so the same function serves the import preview and the
 * live data profile. Every number here is a count or a sum of the rows given.
 */
function profileLedger(invoices, { asOf = Date.now(), baseCurrency = 'INR', rejected = [], warnings = {}, possibleSameCustomer = [] } = {}) {
  const today = startOfUtcDay(asOf);
  const customers = new Set();
  const byCurrency = {};
  let first = null;
  let last = null;
  let paid = 0;
  let paidWithDate = 0;
  let open = 0;
  let overdue = 0;
  let noDue = 0;
  let currencyMissing = 0;
  const perCustomerPaidWithDate = new Map();
  for (const inv of invoices) {
    const ck = normalizeName(inv.customer_name);
    customers.add(ck);
    const d = parseBusinessDate(inv.invoice_date);
    const pd = parseBusinessDate(inv.payment_date);
    const due = parseBusinessDate(inv.due_date);
    for (const t of [d, pd]) {
      if (t == null) continue;
      if (first == null || t < first) first = t;
      if (last == null || t > last) last = t;
    }
    const cur = inv.currency ? String(inv.currency).toUpperCase() : null;
    if (!cur) currencyMissing++;
    const c = cur || baseCurrency;
    const bucket = byCurrency[c] || (byCurrency[c] = { invoiced: 0, open: 0, overdue: 0, openCount: 0, overdueCount: 0 });
    const amount = Number(inv.invoice_amount) || 0;
    bucket.invoiced += amount;
    if (inv.payment_status === 'Paid') {
      paid++;
      if (pd != null) { paidWithDate++; perCustomerPaidWithDate.set(ck, (perCustomerPaidWithDate.get(ck) || 0) + 1); }
    } else {
      const outstanding = Math.max(amount - (Number(inv.payment_amount) || 0), 0);
      if (outstanding <= 0) continue;
      open++;
      bucket.open += outstanding;
      bucket.openCount++;
      if (due == null) noDue++;
      else if (due < today) { overdue++; bucket.overdue += outstanding; bucket.overdueCount++; }
    }
  }
  for (const b of Object.values(byCurrency)) for (const k of ['invoiced', 'open', 'overdue']) b[k] = Math.round(b[k] * 100) / 100;
  const historyDays = first != null && last != null ? daysBetween(first, last) : 0;
  const newestAgeDays = last != null ? daysBetween(last, today) : null;
  const customersWithPaymentHistory = [...perCustomerPaidWithDate.values()].filter((n) => n >= 3).length;

  const limitations = [];
  const add = (key, severity, message, affects) => limitations.push({ key, severity, message, affects });
  if (!invoices.length) add('empty', 'blocking', 'No invoices yet.', 'everything');
  if (open && noDue === open) add('noDueDates', 'blocking', 'None of the unpaid invoices has a due date or credit days, so Starlane cannot tell what is overdue.', 'overdue amounts, aging and every receivables decision');
  else if (noDue > 0) add('someNoDueDates', 'reduces', `${noDue} unpaid invoice(s) have no due date and are left out of overdue totals.`, 'overdue totals');
  if (paid === 0 && invoices.length) add('noPaidHistory', 'reduces', 'There are no paid invoices, so Starlane cannot learn how each customer normally pays. It can still show what is overdue.', 'payment-behaviour trends, collection forecasts and historical replay');
  else if (paid > 0 && paidWithDate / paid < 0.7) add('paidWithoutDates', 'reduces', `${paid - paidWithDate} of ${paid} paid invoices have no payment date, so Starlane cannot measure how late those were paid.`, 'payment-behaviour trends and historical replay');
  if (invoices.length && historyDays < 120) add('shortHistory', 'reduces', `The data covers ${historyDays} days. Trends need about 6 months to be trusted.`, 'trend detection and historical replay');
  if (newestAgeDays != null && newestAgeDays > 14) add('oldExport', 'reduces', `The newest date in the data is ${newestAgeDays} days old. If this is an old export, today's picture may be out of date.`, 'what is overdue today');
  if (currencyMissing) add('currencyAssumed', 'info', `${currencyMissing} invoice(s) have no currency and are treated as ${baseCurrency}.`, 'totals');
  if (Object.keys(byCurrency).length > 1) add('multiCurrency', 'info', `Amounts are in ${Object.keys(byCurrency).join(', ')}. Starlane keeps them separate and never adds them together.`, 'totals');
  if (possibleSameCustomer.length) add('possibleSameCustomer', 'info', `${possibleSameCustomer.length} customer name(s) look like the same business spelled differently. They are kept separate until you merge them.`, 'per-customer totals');
  if (warnings.statusContradictsAmounts) add('statusContradicts', 'info', `${warnings.statusContradictsAmounts.count} row(s) have a status that disagrees with the amounts. The amounts were used.`, 'which invoices count as paid');
  if (warnings.balanceOnly) add('balanceOnly', 'reduces', 'The file has balances but no invoice totals, so it cannot show payment history.', 'payment-behaviour trends');

  return {
    asOf: new Date(asOf).toISOString(),
    counts: {
      customers: customers.size,
      invoices: invoices.length,
      paid,
      paidWithPaymentDate: paidWithDate,
      open,
      overdue,
      openWithoutDueDate: noDue,
      customersWithPaymentHistory,
      rowsRejected: rejected.length,
    },
    period: { from: first == null ? null : toIsoDate(first), to: last == null ? null : toIsoDate(last), historyDays, newestRecordAgeDays: newestAgeDays },
    byCurrency,
    rejectedByReason: groupRejected(rejected),
    warnings,
    possibleSameCustomer,
    limitations,
    canDetect: {
      overdue: open > 0 && noDue < open,
      paymentTrends: customersWithPaymentHistory > 0 && historyDays >= 120,
      historicalReplay: paidWithDate >= 10 && historyDays >= 120,
    },
  };
}

function groupRejected(rejected) {
  const groups = new Map();
  for (const r of rejected) {
    const key = r.reason.replace(/"[^"]*"/g, '…').replace(/\d{4}-\d{2}-\d{2}/g, '…').replace(/invoice \S+ for .+ appears/, 'an invoice number appears').replace(/\(row \d+\)/, '');
    if (!groups.has(key)) groups.set(key, { reason: key.trim(), count: 0, rows: [], example: r.reason });
    const g = groups.get(key);
    g.count++;
    if (g.rows.length < 5) g.rows.push(r.row);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

// ── Preview and commit ───────────────────────────────────────────────────

function hashBytes(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** Everything the human needs to confirm the import. Writes nothing. */
function previewLedger(buffer, filename, { asOf = Date.now(), baseCurrency = 'INR', mappingInput = null } = {}) {
  const file = readLedgerFile(buffer, filename);
  if (!file.ok) return { ok: false, error: file.error };
  const proposal = proposeMapping(file.headers, file.rows);
  const suggestedInput = {
    mapping: Object.fromEntries(Object.entries(proposal.fields).map(([f, m]) => [f, m.header])),
    dateOrders: Object.fromEntries(Object.entries(proposal.dateOrders).map(([h, d]) => [h, d.order || 'DMY'])),
    allOpen: proposal.needsConfirmation.some((n) => n.key === 'assumption:all_open'),
  };
  const input = mappingInput || suggestedInput;
  const v = validateMapping(file.headers, input);
  let profile = null;
  let sampleRecords = [];
  if (v.ok) {
    const norm = normalizeRows(file.headers, file.rows, v, { asOf, baseCurrency });
    profile = profileLedger(norm.records, { asOf, baseCurrency: v.currency || baseCurrency, rejected: norm.rejected, warnings: norm.warnings, possibleSameCustomer: norm.possibleSameCustomer });
    sampleRecords = norm.records.slice(0, 5).map((rec) => { const r = { row: rec._row, ...rec }; delete r._row; delete r.source_id; return r; });
  }
  return {
    ok: true,
    file: { name: filename, type: file.fileType, sheet: file.sheet, rows: file.rows.length, columns: file.headers, sampleRows: file.rows.slice(0, 5), hash: hashBytes(buffer) },
    proposal,
    suggestedInput,
    mappingErrors: v.ok ? [] : v.errors,
    profile,
    sampleRecords,
  };
}

async function ensureCustomer(client, userId, rec, cache) {
  const key = normalizeName(rec.customer_name);
  if (cache.has(key)) return cache.get(key);
  const found = await client.query('SELECT id FROM customers WHERE user_id = $1 AND lower(name) = lower($2) ORDER BY created_at LIMIT 1', [userId, rec.customer_name]);
  let id = found.rows[0]?.id;
  let created = false;
  if (!id) {
    const ins = await client.query(
      `INSERT INTO customers (user_id, name, phone) VALUES ($1,$2,$3)
       ON CONFLICT DO NOTHING RETURNING id`,
      [userId, rec.customer_name, rec.customer_phone]
    );
    id = ins.rows[0]?.id || (await client.query('SELECT id FROM customers WHERE user_id = $1 AND lower(name) = lower($2) LIMIT 1', [userId, rec.customer_name])).rows[0]?.id || null;
    created = !!ins.rows[0];
  }
  cache.set(key, { id, created });
  return { id, created };
}

/**
 * Writes a confirmed import in one transaction. Idempotent per file (same
 * bytes -> no-op) and per invoice (same customer + number -> update).
 */
async function commitLedger(pool, userId, buffer, filename, mappingInput, { asOf = Date.now(), baseCurrency = 'INR' } = {}) {
  const file = readLedgerFile(buffer, filename);
  if (!file.ok) return { ok: false, status: 400, error: file.error };
  const v = validateMapping(file.headers, mappingInput || {});
  if (!v.ok) return { ok: false, status: 400, error: 'The column choices need attention before importing.', errors: v.errors };
  const norm = normalizeRows(file.headers, file.rows, v, { asOf, baseCurrency });
  const hash = hashBytes(buffer);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const prior = await client.query('SELECT id, status, completed_at, rows_accepted FROM file_import_batches WHERE user_id = $1 AND file_content_hash = $2 FOR UPDATE', [userId, hash]);
    if (prior.rows[0] && prior.rows[0].status === 'COMPLETED') {
      await client.query('ROLLBACK');
      return { ok: true, alreadyImported: true, batchId: prior.rows[0].id, importedAt: prior.rows[0].completed_at, counts: { inserted: 0, updated: 0, unchanged: 0, skippedOtherSource: 0 } };
    }
    const batch = prior.rows[0]
      ? prior.rows[0]
      : (await client.query(
        `INSERT INTO file_import_batches (user_id, source_system, filename, file_type, file_content_hash, mapping_profile, status, rows_total)
         VALUES ($1,'ledger_import',$2,$3,$4,'receivables_ledger','STARTED',$5) RETURNING id`,
        [userId, String(filename).slice(0, 200), file.fileType, hash, file.rows.length]
      )).rows[0];

    const existing = await client.query(
      `SELECT id, source_id, invoice_amount, payment_status, payment_amount, payment_date, due_date, invoice_date
       FROM invoices WHERE user_id = $1 AND source_type = $2 AND source_id = ANY($3)`,
      [userId, SOURCE_TYPE, norm.records.map((r) => r.source_id)]
    );
    const bySource = new Map(existing.rows.map((r) => [r.source_id, r]));
    const numbered = norm.records.filter((r) => r.invoice_number && !bySource.has(r.source_id));
    const otherSource = numbered.length
      ? await client.query(
        `SELECT lower(customer_name) AS c, lower(invoice_number) AS n FROM invoices
         WHERE user_id = $1 AND COALESCE(source_type,'') <> $2 AND invoice_number IS NOT NULL AND lower(invoice_number) = ANY($3)`,
        [userId, SOURCE_TYPE, numbered.map((r) => r.invoice_number.toLowerCase())]
      )
      : { rows: [] };
    const otherKeys = new Set(otherSource.rows.map((r) => `${normalizeName(r.c)}|${r.n}`));

    const counts = { inserted: 0, updated: 0, unchanged: 0, skippedOtherSource: 0, customersCreated: 0, customersMatched: 0 };
    const customerCache = new Map();
    for (const rec of norm.records) {
      const cust = await ensureCustomer(client, userId, rec, customerCache);
      const prev = bySource.get(rec.source_id);
      if (prev) {
        const same = Number(prev.invoice_amount) === rec.invoice_amount && prev.payment_status === rec.payment_status
          && Number(prev.payment_amount || 0) === Number(rec.payment_amount || 0) && (prev.payment_date || null) === rec.payment_date
          && (prev.due_date || null) === rec.due_date && prev.invoice_date === rec.invoice_date;
        if (same) { counts.unchanged++; continue; }
        await client.query(
          `UPDATE invoices SET invoice_amount = $3, payment_status = $4, payment_amount = $5, payment_date = $6, due_date = $7, invoice_date = $8,
                  currency = COALESCE($9, currency), customer_id = COALESCE(customer_id, $10), updated_at = NOW()
           WHERE id = $1 AND user_id = $2`,
          [prev.id, userId, rec.invoice_amount, rec.payment_status, rec.payment_amount, rec.payment_date, rec.due_date, rec.invoice_date, rec.currency, cust.id]
        );
        counts.updated++;
        continue;
      }
      if (rec.invoice_number && otherKeys.has(`${normalizeName(rec.customer_name)}|${rec.invoice_number.toLowerCase()}`)) { counts.skippedOtherSource++; continue; }
      const dueIso = rec.due_date;
      const overdueDays = dueIso && rec.payment_status !== 'Paid' ? Math.max(0, daysBetween(parseBusinessDate(dueIso), startOfUtcDay(asOf))) : 0;
      await client.query(
        `INSERT INTO invoices (user_id, customer_id, customer_name, customer_phone, invoice_number, invoice_amount, payment_status, payment_amount,
                               invoice_date, due_date, payment_date, currency, days_overdue, source_type, source_id, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [userId, cust.id, rec.customer_name, rec.customer_phone, rec.invoice_number, rec.invoice_amount, rec.payment_status, rec.payment_amount,
          rec.invoice_date, dueIso, rec.payment_date, rec.currency, overdueDays, SOURCE_TYPE, rec.source_id,
          rec.due_date_derived ? 'due date derived from credit days' : null]
      );
      counts.inserted++;
    }
    for (const c of customerCache.values()) { if (c.created) counts.customersCreated++; else counts.customersMatched++; }

    await client.query(
      `UPDATE file_import_batches SET status = 'COMPLETED', completed_at = NOW(), rows_total = $2, rows_accepted = $3, rows_rejected = $4,
              rows_duplicate = $5, entities_created = $6, entities_matched = $7
       WHERE id = $1`,
      [batch.id, file.rows.length, counts.inserted + counts.updated + counts.unchanged, norm.rejected.length,
        (norm.warnings.duplicateRow?.count || 0) + counts.skippedOtherSource, counts.customersCreated, counts.customersMatched]
    );
    await client.query('COMMIT');
    const profile = profileLedger(norm.records, { asOf, baseCurrency: v.currency || baseCurrency, rejected: norm.rejected, warnings: norm.warnings, possibleSameCustomer: norm.possibleSameCustomer });
    return { ok: true, alreadyImported: false, batchId: batch.id, counts, profile };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  FIELDS, SOURCE_TYPE, readLedgerFile, proposeMapping, validateMapping, normalizeRows, profileLedger, previewLedger, commitLedger,
  parseMoney, parseDateWithOrder, detectDateOrder, similarNames,
};
