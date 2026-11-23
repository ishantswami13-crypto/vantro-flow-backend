'use strict';
// FILE: lib/domain/operations/operationalImport.js
// Imports a customer's own operational data (open customer orders, inbound
// purchase lines) from a CSV/XLSX export of their ERP, accounting system or
// spreadsheet, into the existing tables the supplier-delay engine reads:
//
//   kind 'orders'          -> customers, orders, order_line_items
//   kind 'purchase_lines'  -> suppliers, purchases, purchase_line_items, product_suppliers
//   kind 'products'        -> products (+ an OPENING stock movement)      } masterDataImport.js
//   kind 'components'      -> product_components (bill of materials)      }
//
//   preview (writes nothing): read file -> propose column mapping -> validate
//     the mapping the human sees -> normalise rows -> match products (SKU,
//     then exact name) -> compare with what is already imported -> report
//     accepted / rejected / review-required rows and every limitation.
//   commit (one transaction): only the mapping and the review answers the
//     human sent back; same row identity -> update, never duplicate.
//
// Rules this module keeps:
//   - Nothing is guessed silently. A partial header match, an unprovable
//     day/month order, an ambiguous product match, a "$" with no currency
//     code: each is a question for the human, never a default.
//   - Missing data stays missing. No promised date stays NULL ("cannot be
//     checked"); no price stays NULL; no outstanding quantity stays NULL and
//     planning says it assumed the full ordered quantity.
//   - Order and purchase imports never create products: a stock level of 0
//     for a new product would be a fabricated fact. Unknown products are held
//     for review (link to an existing product, import unlinked, or skip).
//     Products are created only by the 'products' kind, from a file that
//     states each new product's stock on hand.
//   - Every row has a stable identity (source system + record id, or source
//     system + document ref + line ref/SKU). A repeat export updates the same
//     rows; a record missing from a newer export is left alone and counted.
//   - Quantities and money are exact decimals (decimal.js), never floats.
//   - Purchase lines never attach to a bill that came from somewhere else
//     (Tally voucher, manual purchase): its goods may already be in stock.
//   - Units the source already shows as received are recorded as received
//     before tracking and never booked into stock again.
//   - Changes to a purchase line that Starlane has recorded receipts for are
//     never overwritten by a file; they are reported as conflicts.

const crypto = require('crypto');
const { readLedgerFile, parseDateWithOrder, detectDateOrder } = require('../decisions/ledgerImport');
const { normalizeName } = require('../ingestion/entityResolution');
const { makeObservation } = require('../ingestion/observation');
const { appendEvent, humanActor } = require('../decisions/store');
const { toMicro, fromMicro } = require('./decimal');

const KINDS = ['orders', 'purchase_lines', 'products', 'components'];
const MASTER_KINDS = new Set(['products', 'components']);
const KIND_ERROR = 'kind must be "products", "components", "orders" or "purchase_lines"';
const DAY_MS = 86400000;
const nOf = (n, one, many = `${one}s`) => `${n} ${Number(n) === 1 ? one : many}`;

// ISO 4217 codes accepted from a file. A three-letter word outside this list
// (e.g. "RUP", "DOL") is rejected rather than trusted.
const ISO_CURRENCIES = new Set(['INR', 'USD', 'EUR', 'GBP', 'AED', 'SAR', 'QAR', 'OMR', 'KWD', 'BHD', 'SGD', 'MYR', 'THB', 'IDR', 'PHP', 'VND', 'CNY', 'HKD', 'TWD', 'JPY', 'KRW', 'AUD', 'NZD', 'CAD', 'MXN', 'BRL', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF', 'TRY', 'ZAR', 'NGN', 'KES', 'EGP', 'BDT', 'LKR', 'NPR', 'PKR', 'RUB', 'ILS']);
// Symbols that name exactly one currency. "$", "¥", "kr" name several and are
// never resolved on their own.
const UNAMBIGUOUS_SYMBOLS = [[/₹|\brs\.?(?=\s|\d|$)|\binr\b/i, 'INR'], [/€/, 'EUR'], [/£/, 'GBP'], [/\baed\b|د\.إ/i, 'AED']];
const AMBIGUOUS_SYMBOLS = /\$|¥|\bkr\b/i;

const COMMON = {
  sku: { kind: 'text', aliases: ['sku', 'item code', 'product code', 'part no', 'part number', 'material code', 'article no', 'article number', 'stock code', 'item sku', 'product sku'] },
  product_name: { kind: 'text', aliases: ['product', 'product name', 'item', 'item name', 'description', 'item description', 'stock item', 'stock item name', 'material', 'material description', 'name of item'] },
  line_ref: { kind: 'text', aliases: ['line', 'line no', 'line number', 'line id', 'line ref', 'line reference', 'item line', 'position'] },
  record_id: { kind: 'text', aliases: ['record id', 'external id', 'source id', 'unique id', 'row id', 'line uid', 'source record id'] },
  currency: { kind: 'currency', aliases: ['currency', 'ccy', 'curr', 'currency code'] },
};

const FIELDS = {
  orders: {
    customer_name: { required: true, kind: 'text', aliases: ['customer', 'customer name', 'party', 'party name', 'buyer', 'buyer name', 'client', 'client name', 'bill to', 'sold to', 'account name', 'party ledger name'] },
    customer_ref: { kind: 'text', aliases: ['customer id', 'customer code', 'customer no', 'customer number', 'customer ref', 'party code', 'account code', 'client id', 'client code'] },
    order_ref: { required: true, kind: 'text', aliases: ['order no', 'order number', 'order #', 'order', 'order id', 'order ref', 'order reference', 'so no', 'so number', 'so #', 'sales order', 'sales order no', 'sales order number'] },
    ...COMMON,
    quantity: { required: true, kind: 'quantity', aliases: ['quantity', 'qty', 'ordered qty', 'order qty', 'ordered quantity', 'qty ordered', 'units'] },
    outstanding_quantity: { kind: 'quantity', aliases: ['outstanding qty', 'outstanding quantity', 'pending qty', 'pending quantity', 'balance qty', 'open qty', 'qty pending', 'remaining qty', 'backorder qty', 'qty to deliver', 'to deliver', 'undelivered qty'] },
    unit_price: { kind: 'money', aliases: ['unit price', 'rate', 'price', 'selling price', 'unit rate', 'price per unit', 'sale price'] },
    order_date: { kind: 'date', aliases: ['order date', 'so date', 'ordered on', 'date', 'order placed'] },
    promised_date: { kind: 'date', aliases: ['promised date', 'promise date', 'delivery date', 'committed date', 'commit date', 'required by', 'need by', 'needed by', 'required date', 'expected delivery', 'ship by', 'delivery due', 'due date', 'dispatch date'] },
    status: { kind: 'status', aliases: ['status', 'order status', 'line status', 'state'] },
  },
  purchase_lines: {
    supplier_name: { required: true, kind: 'text', aliases: ['supplier', 'supplier name', 'vendor', 'vendor name', 'party', 'party name', 'party ledger name'] },
    supplier_ref: { kind: 'text', aliases: ['supplier code', 'supplier id', 'vendor code', 'vendor id', 'supplier no', 'vendor no'] },
    supplier_tax_id: { kind: 'text', aliases: ['gstin', 'supplier gstin', 'gst no', 'gstin uin', 'vat number', 'vat no', 'tax id'] },
    po_ref: { required: true, kind: 'text', aliases: ['po no', 'po number', 'po #', 'po', 'po ref', 'po id', 'purchase order', 'purchase order no', 'purchase order number', 'order no', 'order number'] },
    ...COMMON,
    quantity: { required: true, kind: 'quantity', aliases: ['quantity', 'qty', 'ordered qty', 'order qty', 'po qty', 'qty ordered', 'ordered quantity'] },
    received_quantity: { kind: 'quantity', aliases: ['received qty', 'qty received', 'received quantity', 'grn qty', 'delivered qty', 'supplied qty', 'received'] },
    outstanding_quantity: { kind: 'quantity', aliases: ['pending qty', 'pending quantity', 'balance qty', 'outstanding qty', 'outstanding quantity', 'open qty', 'qty pending', 'remaining qty', 'due qty', 'qty due'] },
    expected_date: { kind: 'date', aliases: ['expected date', 'eta', 'expected delivery', 'expected delivery date', 'delivery date', 'expected on', 'arrival date', 'expected at', 'due date', 'schedule date', 'scheduled date'] },
    purchase_date: { kind: 'date', aliases: ['po date', 'purchase date', 'order date', 'date'] },
    unit_cost: { kind: 'money', aliases: ['unit cost', 'rate', 'price', 'unit price', 'cost', 'purchase rate', 'cost price', 'purchase price'] },
    status: { kind: 'status', aliases: ['status', 'line status', 'po status', 'state'] },
  },
  // Product master with physical stock on hand. Goods still on order are
  // never stock: they belong in the purchase-line import.
  products: {
    sku: COMMON.sku,
    product_name: { required: true, kind: 'text', aliases: COMMON.product_name.aliases },
    on_hand: { kind: 'quantity', aliases: ['on hand', 'stock on hand', 'qty on hand', 'quantity on hand', 'current stock', 'stock', 'closing stock', 'closing balance', 'closing qty', 'stock qty', 'in stock', 'available qty', 'physical stock'] },
    unit: { kind: 'text', aliases: ['unit', 'uom', 'unit of measure', 'units'] },
    unit_price: { kind: 'money', aliases: ['selling price', 'sale price', 'unit price', 'price', 'rate', 'mrp'] },
    category: { kind: 'text', aliases: ['category', 'item group', 'stock group', 'product group', 'group', 'type', 'item type'] },
  },
  // Bill of materials: one row per (finished product, component).
  components: {
    finished_sku: { kind: 'text', aliases: ['finished sku', 'finished item code', 'parent sku', 'parent item code', 'assembly sku', 'product sku', 'fg sku', 'fg code'] },
    finished_name: { kind: 'text', aliases: ['finished product', 'finished item', 'finished good', 'parent item', 'parent product', 'assembly', 'fg name'] },
    component_sku: { kind: 'text', aliases: ['component sku', 'component code', 'component item code', 'child sku', 'part code', 'raw material code', 'rm code'] },
    component_name: { kind: 'text', aliases: ['component', 'component name', 'component item', 'child item', 'part', 'part name', 'raw material', 'rm name'] },
    quantity_per_unit: { required: true, kind: 'quantity', aliases: ['qty per unit', 'quantity per unit', 'qty per', 'usage', 'qty required', 'quantity required', 'qty', 'quantity'] },
  },
};
const DATE_FIELDS = { orders: ['order_date', 'promised_date'], purchase_lines: ['purchase_date', 'expected_date'], products: [], components: [] };

// Order status words -> the orders.status vocabulary every existing screen
// knows (new | confirmed | dispatched | delivered | cancelled).
const ORDER_STATUS = new Map([
  ...['new', 'open', 'pending', 'draft order', 'received', 'entered'].map((t) => [t, 'new']),
  ...['confirmed', 'approved', 'accepted', 'booked', 'released', 'in progress', 'processing', 'in production', 'partially delivered', 'partly delivered', 'partially shipped', 'partially dispatched', 'partial', 'back order', 'backorder', 'backordered', 'on hold'].map((t) => [t, 'confirmed']),
  ...['dispatched', 'shipped', 'in transit', 'out for delivery'].map((t) => [t, 'dispatched']),
  ...['delivered', 'completed', 'complete', 'closed', 'fulfilled', 'done'].map((t) => [t, 'delivered']),
  ...['cancelled', 'canceled', 'void', 'voided', 'rejected', 'lost'].map((t) => [t, 'cancelled']),
]);
const CLOSED_ORDER_STATUSES = new Set(['dispatched', 'delivered', 'cancelled']);
// Purchase-line status words -> NULL (open) | closed | cancelled.
const PO_STATUS = new Map([
  ...['open', 'pending', 'ordered', 'confirmed', 'approved', 'released', 'sent', 'in transit', 'shipped', 'dispatched', 'partially received', 'partly received', 'partial', 'delayed', 'on order'].map((t) => [t, null]),
  ...['closed', 'short closed', 'short-closed', 'completed', 'complete', 'received', 'fully received', 'done'].map((t) => [t, 'closed']),
  ...['cancelled', 'canceled', 'void', 'voided', 'rejected'].map((t) => [t, 'cancelled']),
]);

function token(v) {
  return String(v == null ? '' : v).trim().toLowerCase().replace(/[_]+/g, ' ').replace(/\s+/g, ' ');
}

function normHeader(h) {
  return String(h || '').toLowerCase().replace(/['’`]s\b/g, '').replace(/['’`]/g, '')
    .replace(/[_./\\()[\]:#-]+/g, (m) => (m.includes('#') ? ' # ' : ' ')).replace(/\s+/g, ' ').trim();
}

function sha(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// ── Value parsing (pure) ─────────────────────────────────────────────────

const UNIT_SUFFIX = /\s*(pcs?|nos?|units?|ea|each|qty)\.?$/i;

/** Quantity: exact decimal >= 0. Returns { micro } | { empty } | { error }. */
function parseQuantity(raw) {
  const s0 = String(raw == null ? '' : raw).trim();
  if (!s0 || s0 === '-' || s0 === '—') return { empty: true };
  const s = s0.replace(UNIT_SUFFIX, '').replace(/[\s,]/g, '');
  if (s.startsWith('-')) return { error: `"${s0}" is negative` };
  const micro = toMicro(s);
  if (micro == null) return { error: `"${s0}" is not a quantity` };
  return { micro };
}

/** Money: exact decimal >= 0 plus the currency its symbol names, if any. */
function parsePrice(raw) {
  const s0 = String(raw == null ? '' : raw).trim();
  if (!s0 || s0 === '-' || s0 === '—') return { empty: true };
  let symbolCurrency = null;
  let ambiguousSymbol = false;
  for (const [re, code] of UNAMBIGUOUS_SYMBOLS) if (re.test(s0)) symbolCurrency = code;
  if (!symbolCurrency && AMBIGUOUS_SYMBOLS.test(s0)) ambiguousSymbol = true;
  const codeMatch = s0.match(/\b([A-Z]{3})\b/);
  if (codeMatch && ISO_CURRENCIES.has(codeMatch[1])) symbolCurrency = symbolCurrency && symbolCurrency !== codeMatch[1] ? 'CONFLICT' : codeMatch[1];
  const s = s0.replace(/₹|€|£|\$|¥|د\.إ|\brs\.?|\b[A-Za-z]{3}\b/gi, '').replace(/[\s,]/g, '');
  if (s.startsWith('-') || /^\(.*\)$/.test(s)) return { error: `"${s0}" is negative` };
  const micro = toMicro(s);
  if (micro == null) return { error: `"${s0}" is not an amount` };
  return { micro, symbolCurrency, ambiguousSymbol };
}

/** A currency cell. Returns { code } | { empty } | { error }. */
function parseCurrencyCell(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return { empty: true };
  const up = s.toUpperCase();
  if (/^[A-Z]{3}$/.test(up)) return ISO_CURRENCIES.has(up) ? { code: up } : { error: `currency "${s}" is not a recognised ISO code` };
  for (const [re, code] of UNAMBIGUOUS_SYMBOLS) if (re.test(s) && s.replace(re, '').trim() === '') return { code };
  if (AMBIGUOUS_SYMBOLS.test(s)) return { error: `currency "${s}" is ambiguous (used by several currencies); use a code such as USD or SGD` };
  return { error: `currency "${s}" is not understood` };
}

// ── Mapping (pure) ───────────────────────────────────────────────────────

function columnValues(rows, idx) {
  return rows.map((r) => r[idx]).filter((v) => v != null && String(v).trim() !== '');
}

function kindFit(kind, values) {
  if (!values.length) return 0;
  const sample = values.slice(0, 500);
  let ok = 0;
  for (const v of sample) {
    if (kind === 'quantity') { if (parseQuantity(v).micro != null) ok++; }
    else if (kind === 'money') { if (parsePrice(v).micro != null) ok++; }
    else if (kind === 'date') { if (parseDateWithOrder(v, 'DMY') != null || parseDateWithOrder(v, 'MDY') != null) ok++; }
    else if (kind === 'currency') { if (parseCurrencyCell(v).code || AMBIGUOUS_SYMBOLS.test(String(v))) ok++; }
    else ok++;
  }
  return ok / sample.length;
}

function fieldLabel(kind, field) {
  return ({
    customer_name: 'customer name', customer_ref: 'customer code', order_ref: 'order number', line_ref: 'line number', record_id: 'record id',
    product_name: 'product name', sku: 'SKU / item code', quantity: 'ordered quantity', outstanding_quantity: 'quantity still outstanding',
    unit_price: 'unit price', currency: 'currency', order_date: 'order date', promised_date: 'promised delivery date', status: 'status',
    supplier_name: 'supplier name', supplier_ref: 'supplier code', supplier_tax_id: 'supplier GSTIN / tax id', po_ref: 'purchase order number',
    received_quantity: 'quantity already received', expected_date: 'expected delivery date', purchase_date: 'purchase order date', unit_cost: 'unit cost',
    on_hand: 'stock on hand', unit: 'unit of measure', category: 'category', finished_sku: 'finished product SKU', finished_name: 'finished product name',
    component_sku: 'component SKU', component_name: 'component name', quantity_per_unit: 'quantity per finished unit',
  })[field] || (kind === 'products' && field === 'unit_price' ? 'selling price' : field);
}

/**
 * Proposes which column holds which field. Exact header match + values that
 * fit -> CONFIRMED; anything weaker -> SUGGESTED (must be confirmed).
 */
function proposeMapping(kind, headers, rows) {
  const defs = FIELDS[kind];
  const candidates = [];
  headers.forEach((header, idx) => {
    const h = normHeader(header);
    const values = columnValues(rows, idx);
    for (const [field, def] of Object.entries(defs)) {
      let match = null;
      for (const alias of def.aliases) if (h === normHeader(alias)) { match = { strength: 2, alias }; break; }
      if (!match) {
        for (const alias of def.aliases) {
          const a = normHeader(alias);
          if (a.length >= 4 && (h.startsWith(`${a} `) || h.endsWith(` ${a}`) || h.includes(` ${a} `))) {
            if (!match || a.length > match.alias.length) match = { strength: 1, alias: a };
          }
        }
      }
      if (!match) continue;
      const fit = kindFit(def.kind, values);
      if (values.length && fit < 0.5) continue;
      candidates.push({ field, header, strength: match.strength, alias: match.alias, fit });
    }
  });
  candidates.sort((a, b) => b.strength - a.strength || b.alias.length - a.alias.length || b.fit - a.fit);
  const fields = {};
  const used = new Set();
  for (const c of candidates) {
    if (fields[c.field] || used.has(c.header)) continue;
    const confirmed = c.strength === 2 && c.fit >= 0.9;
    fields[c.field] = {
      header: c.header,
      verdict: confirmed ? 'CONFIRMED' : 'SUGGESTED',
      reason: c.strength === 2
        ? `column is named "${c.header}"${c.fit < 0.9 ? `, but only ${Math.round(c.fit * 100)}% of its values look like a ${fieldLabel(kind, c.field)}` : ''}`
        : `column "${c.header}" looks like the ${fieldLabel(kind, c.field)} (partial name match)`,
      fit: Math.round(c.fit * 100) / 100,
    };
    used.add(c.header);
  }
  const dateOrders = {};
  for (const f of DATE_FIELDS[kind]) {
    if (!fields[f]) continue;
    dateOrders[fields[f].header] = detectDateOrder(columnValues(rows, headers.indexOf(fields[f].header)));
  }
  const needsConfirmation = [];
  for (const [field, m] of Object.entries(fields)) {
    if (m.verdict !== 'CONFIRMED') needsConfirmation.push({ key: `field:${field}`, field, header: m.header, message: `Is "${m.header}" the ${fieldLabel(kind, field)}?`, reason: m.reason });
  }
  for (const [header, d] of Object.entries(dateOrders)) {
    if (d.verdict === 'ASSUMED') needsConfirmation.push({ key: `dateOrder:${header}`, header, message: `Are dates in "${header}" written day/month (e.g. 03/04 = 3 April)?`, reason: d.reason });
  }
  const missingRequired = Object.entries(defs).filter(([f, d]) => d.required && !fields[f]).map(([f]) => f);
  if (kind === 'components') {
    if (!fields.finished_sku && !fields.finished_name) missingRequired.push('finished_sku_or_name');
    if (!fields.component_sku && !fields.component_name) missingRequired.push('component_sku_or_name');
  } else if (!fields.sku && !fields.product_name) missingRequired.push('sku_or_product_name');
  return { fields, dateOrders, unmapped: headers.filter((h) => !used.has(h)), needsConfirmation, missingRequired };
}

/**
 * Validates the mapping and options the human confirmed.
 * input: { mapping: {field: header|null}, dateOrders: {header: 'DMY'|'MDY'},
 *          sourceSystem, currency, stockFollows (purchase_lines), reviewChoices }
 */
function validateMapping(kind, headers, input = {}, rows = null) {
  const defs = FIELDS[kind];
  const errors = [];
  const fields = {};
  for (const [field, header] of Object.entries(input.mapping || {})) {
    if (!defs[field]) { errors.push(`unknown field "${field}"`); continue; }
    if (header == null || header === '') continue;
    if (!headers.includes(header)) { errors.push(`column "${header}" is not in the file`); continue; }
    fields[field] = header;
  }
  const seen = new Map();
  for (const [f, h] of Object.entries(fields)) {
    if (seen.has(h)) errors.push(`column "${h}" is used for both the ${fieldLabel(kind, seen.get(h))} and the ${fieldLabel(kind, f)}`);
    seen.set(h, f);
  }
  for (const [f, d] of Object.entries(defs)) if (d.required && !fields[f]) errors.push(`choose the ${fieldLabel(kind, f)} column`);
  if (kind === 'components') {
    if (!fields.finished_sku && !fields.finished_name) errors.push('choose the finished product SKU column or the finished product name column');
    if (!fields.component_sku && !fields.component_name) errors.push('choose the component SKU column or the component name column');
  } else if (!fields.sku && !fields.product_name) errors.push('choose the SKU / item code column or the product name column (or both)');
  // Day/month order: taken from the data when the data proves it (or has no
  // ambiguous dates at all); otherwise the human must say. A choice that the
  // data contradicts is refused.
  const dateOrders = {};
  for (const f of DATE_FIELDS[kind]) {
    if (!fields[f]) continue;
    const given = input.dateOrders && input.dateOrders[fields[f]];
    const detected = rows ? detectDateOrder(columnValues(rows, headers.indexOf(fields[f]))) : { verdict: 'ASSUMED' };
    if (given && given !== 'DMY' && given !== 'MDY') { errors.push(`date order for "${fields[f]}" must be DMY or MDY`); continue; }
    if (detected.verdict === 'PROVEN' && given && given !== detected.order) { errors.push(`"${fields[f]}" has dates that can only be ${detected.order === 'DMY' ? 'day/month' : 'month/day'} (${detected.reason})`); continue; }
    if (detected.verdict === 'PROVEN' || detected.verdict === 'NOT_NEEDED') { dateOrders[f] = given || detected.order; continue; }
    if (!given) { errors.push(`say whether "${fields[f]}" is day/month or month/day`); continue; }
    dateOrders[f] = given;
  }
  const sourceSystem = String(input.sourceSystem == null ? '' : input.sourceSystem).trim().replace(/\s+/g, ' ');
  if (!sourceSystem || sourceSystem.length > 60 || !/^[\p{L}\p{N} ._&()/-]+$/u.test(sourceSystem)) errors.push('name the system this file came from (for example "Tally", "Zoho Inventory" or "Orders sheet"), up to 60 characters');
  let currency = null;
  if (input.currency != null && input.currency !== '') {
    const c = String(input.currency).toUpperCase();
    if (!ISO_CURRENCIES.has(c)) errors.push(`default currency "${input.currency}" is not a recognised ISO code`);
    else currency = c;
  }
  let stockFollows = null;
  if (kind === 'purchase_lines') {
    stockFollows = input.stockFollows === 'STARLANE' || input.stockFollows === 'EXTERNAL' ? input.stockFollows : null;
    if (!stockFollows) errors.push('say who records stock when these goods arrive: Starlane (record receipts here) or your accounting system (e.g. Tally purchase vouchers)');
  }
  const reviewChoices = input.reviewChoices && typeof input.reviewChoices === 'object' ? input.reviewChoices : {};
  return { ok: errors.length === 0, errors, fields, dateOrders, sourceSystem, currency, stockFollows, reviewChoices };
}

// ── Row normalisation (pure) ─────────────────────────────────────────────

function cleanText(v, max = 200) {
  const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
}

function keyOf(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Turns file rows into records using a validated mapping.
 * Returns { records, rejected: [{row, reason}], warnings: {key: {count, rows}} }.
 */
function normalizeRows(kind, headers, rows, v, { asOf = Date.now() } = {}) {
  const idx = Object.fromEntries(Object.keys(FIELDS[kind]).map((f) => [f, v.fields[f] ? headers.indexOf(v.fields[f]) : -1]));
  const get = (row, f) => (idx[f] === -1 ? '' : String(row[idx[f]] == null ? '' : row[idx[f]]).trim());
  const records = [];
  const rejected = [];
  const warnings = {};
  const warn = (key, rowNo) => { const w = warnings[key] || (warnings[key] = { count: 0, rows: [] }); w.count++; if (w.rows.length < 5) w.rows.push(rowNo); };
  const reject = (rowNo, reason) => rejected.push({ row: rowNo, reason });
  const byKey = new Map();
  const partyField = kind === 'orders' ? 'customer_name' : 'supplier_name';
  const partyRefField = kind === 'orders' ? 'customer_ref' : 'supplier_ref';
  const docField = kind === 'orders' ? 'order_ref' : 'po_ref';
  const priceField = kind === 'orders' ? 'unit_price' : 'unit_cost';
  const ss = keyOf(v.sourceSystem);

  rows.forEach((row, i) => {
    const rowNo = i + 2;
    const party = cleanText(get(row, partyField));
    if (!party) return reject(rowNo, kind === 'orders' ? 'no customer name' : 'no supplier name');
    if (/^(grand )?total$|^sub ?total$/i.test(party)) return reject(rowNo, 'looks like a totals row');
    const docRef = cleanText(get(row, docField), 80);
    if (!docRef) return reject(rowNo, kind === 'orders' ? 'no order number' : 'no purchase order number');
    const sku = cleanText(get(row, 'sku'), 80);
    const productName = cleanText(get(row, 'product_name'));
    if (!sku && !productName) return reject(rowNo, 'no SKU or product name');

    const qty = parseQuantity(get(row, 'quantity'));
    if (qty.error) return reject(rowNo, `ordered quantity ${qty.error}`);
    if (qty.empty) return reject(rowNo, 'no ordered quantity');
    if (qty.micro === 0n) return reject(rowNo, 'ordered quantity is 0');

    const out = idx.outstanding_quantity !== -1 ? parseQuantity(get(row, 'outstanding_quantity')) : { empty: true };
    if (out.error) return reject(rowNo, `outstanding quantity ${out.error}`);
    let outstanding = out.empty ? null : out.micro;
    if (outstanding != null && outstanding > qty.micro) return reject(rowNo, `outstanding quantity ${fromMicro(outstanding)} is more than the ordered ${fromMicro(qty.micro)}`);

    let received = null;
    if (kind === 'purchase_lines') {
      const rec = idx.received_quantity !== -1 ? parseQuantity(get(row, 'received_quantity')) : { empty: true };
      if (rec.error) return reject(rowNo, `received quantity ${rec.error}`);
      received = rec.empty ? null : rec.micro;
      if (received != null && received > qty.micro) return reject(rowNo, `received quantity ${fromMicro(received)} is more than the ordered ${fromMicro(qty.micro)}`);
      if (received != null && outstanding != null && received + outstanding !== qty.micro) {
        return reject(rowNo, `quantities disagree: ordered ${fromMicro(qty.micro)}, received ${fromMicro(received)}, outstanding ${fromMicro(outstanding)}`);
      }
      if (received == null && outstanding != null) received = qty.micro - outstanding;
      if (outstanding == null && received != null) outstanding = qty.micro - received;
      if (received == null && outstanding == null) { received = 0n; outstanding = qty.micro; warn('receivedAssumedZero', rowNo); }
    } else if (outstanding == null) warn('outstandingNotReported', rowNo);

    // Status
    const statusRaw = token(get(row, 'status'));
    let status = null;
    if (statusRaw) {
      const map = kind === 'orders' ? ORDER_STATUS : PO_STATUS;
      if (!map.has(statusRaw)) return reject(rowNo, `status "${get(row, 'status')}" is not understood`);
      status = map.get(statusRaw);
    }

    // Price + currency
    let price = null;
    let currency = null;
    const p = parsePrice(get(row, priceField));
    if (p.error) return reject(rowNo, `${kind === 'orders' ? 'unit price' : 'unit cost'} ${p.error}`);
    const cc = idx.currency !== -1 ? parseCurrencyCell(get(row, 'currency')) : { empty: true };
    if (cc.error) return reject(rowNo, cc.error);
    if (!p.empty) {
      price = p.micro;
      if (p.symbolCurrency === 'CONFLICT') return reject(rowNo, `price "${get(row, priceField)}" names two currencies`);
      if (cc.code && p.symbolCurrency && cc.code !== p.symbolCurrency) return reject(rowNo, `currency column says ${cc.code} but the price is written in ${p.symbolCurrency}`);
      currency = cc.code || p.symbolCurrency || null;
      if (!currency && p.ambiguousSymbol) return reject(rowNo, `price "${get(row, priceField)}" uses a symbol several currencies share; add a currency column or code`);
      if (!currency) currency = v.currency;
      if (!currency) warn('priceWithoutCurrency', rowNo);
    } else if (cc.code) currency = cc.code;

    // Dates
    const dateOf = (f) => {
      if (idx[f] === -1 || !get(row, f)) return { day: null };
      const t = parseDateWithOrder(get(row, f), v.dateOrders[f]);
      return t == null ? { error: `${fieldLabel(kind, f)} "${get(row, f)}" could not be read` } : { day: new Date(t).toISOString().slice(0, 10), t };
    };
    const docDate = dateOf(kind === 'orders' ? 'order_date' : 'purchase_date');
    if (docDate.error) return reject(rowNo, docDate.error);
    if (docDate.t != null && docDate.t > asOf + DAY_MS) return reject(rowNo, `${kind === 'orders' ? 'order' : 'purchase order'} date ${docDate.day} is in the future`);
    const due = dateOf(kind === 'orders' ? 'promised_date' : 'expected_date');
    if (due.error) return reject(rowNo, due.error);
    if (!due.day) warn(kind === 'orders' ? 'noPromisedDate' : 'noExpectedDate', rowNo);
    if (due.t != null && docDate.t != null && due.t < docDate.t) warn(kind === 'orders' ? 'promisedBeforeOrder' : 'expectedBeforePurchase', rowNo);

    // Identity
    const partyRef = cleanText(get(row, partyRefField), 80);
    const partyKey = partyRef ? `ref:${keyOf(partyRef)}` : `name:${normalizeName(party)}`;
    const lineRef = cleanText(get(row, 'line_ref'), 80);
    const recordId = cleanText(get(row, 'record_id'), 120);
    const docKey = sha(`${kind}|doc|${ss}|${partyKey}|${keyOf(docRef)}`);
    const lineIdentity = recordId ? `rec:${keyOf(recordId)}` : lineRef ? `${partyKey}|${keyOf(docRef)}|line:${keyOf(lineRef)}` : `${partyKey}|${keyOf(docRef)}|item:${keyOf(sku || productName)}`;
    const lineKey = sha(`${kind}|line|${ss}|${lineIdentity}`);

    const rec = {
      _row: rowNo,
      lineKey,
      docKey,
      party,
      partyRef,
      taxId: kind === 'purchase_lines' ? cleanText(get(row, 'supplier_tax_id'), 30) : null,
      docRef,
      lineRef,
      recordId,
      externalRef: recordId || (lineRef ? `${docRef}/${lineRef}` : docRef),
      sku,
      productName,
      quantity: fromMicro(qty.micro),
      outstanding: outstanding == null ? null : fromMicro(outstanding),
      received: received == null ? null : fromMicro(received),
      price: price == null ? null : fromMicro(price),
      currency,
      docDate: docDate.day,
      dueDate: due.day,
      status,
    };
    const fingerprint = JSON.stringify([rec.party, rec.sku, rec.productName, rec.quantity, rec.outstanding, rec.received, rec.price, rec.currency, rec.docDate, rec.dueDate, rec.status]);
    const prev = byKey.get(lineKey);
    if (prev) {
      if (prev.fingerprint === fingerprint) { warn('duplicateRow', rowNo); return; }
      return reject(rowNo, `the same line (${lineRef ? `${docRef} line ${lineRef}` : `${docRef} ${sku || productName}`}) appears again with different values (row ${prev.rec._row})${lineRef || recordId ? '' : '; add a line number column if one order has the same item twice'}`);
    }
    byKey.set(lineKey, { fingerprint, rec });
    rec.fingerprint = sha(fingerprint);
    records.push(rec);
  });
  return { records, rejected, warnings };
}

// ── Database-aware analysis (read-only) ──────────────────────────────────

/**
 * Matches each record to a product: exact SKU (case-insensitive), then exact
 * normalised name. Never fuzzy. Returns Map(record -> resolution).
 * resolution: { status: 'MATCHED', productId, basis } | { status: 'REVIEW',
 * reviewKey, reason, candidates } where review answers come from
 * v.reviewChoices[reviewKey] = productId | 'UNLINKED' | 'SKIP'.
 */
async function resolveProducts(db, userId, records, reviewChoices = {}) {
  const products = (await db.query('SELECT id, name, sku FROM products WHERE user_id = $1', [userId])).rows;
  const bySku = new Map();
  const byName = new Map();
  for (const p of products) {
    if (p.sku) { const k = keyOf(p.sku); if (!bySku.has(k)) bySku.set(k, []); bySku.get(k).push(p); }
    const n = normalizeName(p.name);
    if (n) { if (!byName.has(n)) byName.set(n, []); byName.get(n).push(p); }
  }
  const ids = new Set(products.map((p) => String(p.id)));
  const out = new Map();
  for (const r of records) {
    const skuHits = r.sku ? (bySku.get(keyOf(r.sku)) || []) : [];
    const nameHits = r.productName ? (byName.get(normalizeName(r.productName)) || []) : [];
    const reviewKey = `product:${keyOf(r.sku || '')}|${normalizeName(r.productName || '')}`;
    const label = [r.sku, r.productName].filter(Boolean).join(' · ');
    let res;
    if (skuHits.length === 1) {
      const p = skuHits[0];
      if (r.productName && nameHits.length && !nameHits.some((n) => String(n.id) === String(p.id))) {
        res = { status: 'REVIEW', reviewKey, reason: `SKU ${r.sku} is "${p.name}", but the name "${r.productName}" belongs to a different product`, candidates: [p, ...nameHits].map(pub) };
      } else res = { status: 'MATCHED', productId: p.id, productName: p.name, basis: 'sku' };
    } else if (skuHits.length > 1) {
      res = { status: 'REVIEW', reviewKey, reason: `${skuHits.length} products share SKU ${r.sku}`, candidates: skuHits.map(pub) };
    } else if (nameHits.length === 1 && !(r.sku && nameHits[0].sku && keyOf(nameHits[0].sku) !== keyOf(r.sku))) {
      res = { status: 'MATCHED', productId: nameHits[0].id, productName: nameHits[0].name, basis: 'name' };
    } else if (nameHits.length === 1) {
      res = { status: 'REVIEW', reviewKey, reason: `"${r.productName}" exists with a different SKU (${nameHits[0].sku}) than the file's ${r.sku}`, candidates: nameHits.map(pub) };
    } else if (nameHits.length > 1) {
      res = { status: 'REVIEW', reviewKey, reason: `${nameHits.length} products are named "${r.productName}"`, candidates: nameHits.map(pub) };
    } else {
      res = { status: 'REVIEW', reviewKey, reason: `No product with ${r.sku ? `SKU ${r.sku}` : ''}${r.sku && r.productName ? ' or ' : ''}${r.productName ? `name "${r.productName}"` : ''} exists in Starlane`, candidates: [], unknown: true };
    }
    if (res.status === 'REVIEW') {
      res.label = label;
      const choice = reviewChoices[reviewKey];
      if (choice === 'UNLINKED') res = { ...res, status: 'UNLINKED' };
      else if (choice === 'SKIP') res = { ...res, status: 'SKIPPED' };
      else if (choice && ids.has(String(choice))) {
        const p = products.find((x) => String(x.id) === String(choice));
        res = { status: 'MATCHED', productId: p.id, productName: p.name, basis: 'confirmed_by_owner', reviewKey };
      }
    }
    out.set(r, res);
  }
  return out;
}

function pub(p) {
  return { id: p.id, name: p.name, sku: p.sku || null };
}

/** Existing rows with these import keys, for change detection. */
async function loadExisting(db, userId, kind, records) {
  const keys = records.map((r) => r.lineKey);
  if (kind === 'orders') {
    const r = await db.query(
      `SELECT oli.*, o.status AS order_status, o.import_key AS order_import_key FROM order_line_items oli JOIN orders o ON o.id = oli.order_id AND o.user_id = oli.user_id
        WHERE oli.user_id = $1 AND oli.import_key = ANY($2)`,
      [userId, keys]
    );
    return new Map(r.rows.map((x) => [x.import_key, x]));
  }
  const r = await db.query(
    `SELECT pli.*, COALESCE((SELECT SUM(quantity) FROM purchase_line_receipts plr WHERE plr.user_id = pli.user_id AND plr.purchase_line_id = pli.id), 0) AS starlane_received
       FROM purchase_line_items pli WHERE pli.user_id = $1 AND pli.import_key = ANY($2)`,
    [userId, keys]
  );
  return new Map(r.rows.map((x) => [x.import_key, x]));
}

const eqDec = (a, b) => (a == null && b == null) || (a != null && b != null && toMicro(a) === toMicro(b));
const dayOf = (v) => (v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

/**
 * Decides what happens to each record. Pure given its inputs.
 * action: INSERT | UPDATE | UNCHANGED | SKIP_CLOSED | REVIEW | SKIPPED | CONFLICT
 */
function planRecords(kind, records, products, existing) {
  const plan = [];
  for (const r of records) {
    const prod = products.get(r);
    const ex = existing.get(r.lineKey) || null;
    const entry = { rec: r, product: prod, existing: ex, action: null, changes: [], conflicts: [] };
    if (prod.status === 'REVIEW') { entry.action = 'REVIEW'; plan.push(entry); continue; }
    if (prod.status === 'SKIPPED') { entry.action = 'SKIPPED'; plan.push(entry); continue; }
    const productId = prod.status === 'MATCHED' ? prod.productId : null;
    entry.productId = productId;
    const closed = kind === 'orders' ? CLOSED_ORDER_STATUSES.has(r.status) : (r.status === 'closed' || r.status === 'cancelled' || (r.outstanding != null && toMicro(r.outstanding) === 0n));
    if (!ex) { entry.action = closed ? 'SKIP_CLOSED' : 'INSERT'; plan.push(entry); continue; }

    const diff = (label, a, b) => { entry.changes.push({ field: label, from: a, to: b }); };
    if (kind === 'orders') {
      if (String(ex.product_id || '') !== String(productId || '')) diff('product', ex.product_id, productId);
      if (!eqDec(ex.quantity, r.quantity)) diff('quantity', ex.quantity, r.quantity);
      if (!eqDec(ex.outstanding_quantity, r.outstanding)) diff('outstanding', ex.outstanding_quantity, r.outstanding);
      if (!eqDec(ex.unit_price, r.price)) diff('unit price', ex.unit_price, r.price);
      if ((ex.currency || null) !== (r.currency || null)) diff('currency', ex.currency, r.currency);
      if (dayOf(ex.needed_by) !== r.dueDate) diff('promised date', dayOf(ex.needed_by), r.dueDate);
      if ((ex.line_status || null) !== (r.status || null) && r.status) diff('status', ex.line_status, r.status);
    } else {
      const starlaneReceived = toMicro(ex.starlane_received) ?? 0n;
      const curReceived = toMicro(ex.received_quantity) ?? 0n;
      const fileReceived = toMicro(r.received) ?? 0n;
      if (String(ex.product_id || '') !== String(productId || '')) {
        if (starlaneReceived !== 0n) entry.conflicts.push(`the product changed in the file, but Starlane has recorded receipts into the current product's stock; kept the current product`);
        else diff('product', ex.product_id, productId);
      }
      if (!eqDec(ex.quantity, r.quantity)) {
        if (toMicro(r.quantity) < curReceived) entry.conflicts.push(`the file orders ${r.quantity}, less than the ${fromMicro(curReceived)} already received; kept ${ex.quantity}`);
        else diff('quantity', ex.quantity, r.quantity);
      }
      if (fileReceived !== curReceived) {
        if (starlaneReceived !== 0n) entry.conflicts.push(`the file says ${fromMicro(fileReceived)} received, Starlane has recorded ${fromMicro(curReceived)}; kept Starlane's receipts`);
        else if (fileReceived < curReceived) entry.conflicts.push(`the file says ${fromMicro(fileReceived)} received, fewer than the ${fromMicro(curReceived)} on record; kept ${fromMicro(curReceived)}`);
        else diff('received outside Starlane', fromMicro(curReceived), fromMicro(fileReceived));
      }
      if (!eqDec(ex.unit_price, r.price)) diff('unit cost', ex.unit_price, r.price);
      if ((ex.currency || null) !== (r.currency || null)) diff('currency', ex.currency, r.currency);
      if (dayOf(ex.expected_at) !== r.dueDate && r.dueDate) diff('expected date', dayOf(ex.expected_at), r.dueDate);
      if ((ex.line_status || null) !== (r.status || null)) diff('status', ex.line_status, r.status);
    }
    entry.action = entry.changes.length ? 'UPDATE' : entry.conflicts.length ? 'CONFLICT' : 'UNCHANGED';
    plan.push(entry);
  }
  return plan;
}

function groupRejected(rejected) {
  const groups = new Map();
  for (const r of rejected) {
    const key = r.reason.replace(/"[^"]*"/g, '…').replace(/\d+(\.\d+)?/g, '#').replace(/\(row #\)/, '').trim();
    if (!groups.has(key)) groups.set(key, { reason: key, count: 0, rows: [], example: r.reason });
    const g = groups.get(key);
    g.count++;
    if (g.rows.length < 5) g.rows.push(r.row);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

const WARNING_TEXT = {
  outstandingNotReported: (n) => ({ severity: 'reduces', message: `${nOf(n, 'order line')} ${n === 1 ? 'has' : 'have'} no outstanding quantity. Starlane will assume the full ordered quantity is still to deliver, and says so on every decision.` }),
  noPromisedDate: (n) => ({ severity: 'reduces', message: `${nOf(n, 'order line')} ${n === 1 ? 'has' : 'have'} no promised date. ${n === 1 ? 'It is' : 'They are'} imported but cannot be checked against a supplier delay.` }),
  noExpectedDate: (n) => ({ severity: 'reduces', message: `${nOf(n, 'purchase line')} ${n === 1 ? 'has' : 'have'} no expected date. ${n === 1 ? 'It is' : 'They are'} imported but not counted as incoming supply until a date is added, and a delay cannot be reported on ${n === 1 ? 'it' : 'them'}.` }),
  receivedAssumedZero: (n) => ({ severity: 'info', message: `${nOf(n, 'purchase line')} ${n === 1 ? 'has' : 'have'} no received or outstanding quantity; nothing is treated as received yet.` }),
  priceWithoutCurrency: (n) => ({ severity: 'info', message: `${nOf(n, 'line')} ${n === 1 ? 'has a price' : 'have prices'} but no currency. Prices are kept, but left out of money totals until a currency is known.` }),
  duplicateRow: (n) => ({ severity: 'info', message: `${nOf(n, 'row')} ${n === 1 ? 'repeats' : 'repeat'} an earlier row exactly and ${n === 1 ? 'was' : 'were'} counted once.` }),
  promisedBeforeOrder: (n) => ({ severity: 'info', message: `${nOf(n, 'order line')} ${n === 1 ? 'is' : 'are'} promised before ${n === 1 ? 'its' : 'their'} order date. Check the date columns.` }),
  expectedBeforePurchase: (n) => ({ severity: 'info', message: `${nOf(n, 'purchase line')} ${n === 1 ? 'is' : 'are'} expected before ${n === 1 ? 'its' : 'their'} purchase order date. Check the date columns.` }),
};

function summarize(kind, plan, norm, extra = {}) {
  const count = (a) => plan.filter((p) => p.action === a).length;
  const review = new Map();
  for (const p of plan) {
    if (p.action !== 'REVIEW') continue;
    const k = p.product.reviewKey;
    if (!review.has(k)) review.set(k, { key: k, label: p.product.label, reason: p.product.reason, candidates: p.product.candidates, unknown: !!p.product.unknown, rows: [], count: 0 });
    const g = review.get(k);
    g.count++;
    if (g.rows.length < 5) g.rows.push(p.rec._row);
  }
  const limitations = [];
  for (const [k, w] of Object.entries(norm.warnings)) {
    if (!WARNING_TEXT[k]) continue;
    limitations.push({ key: k, ...WARNING_TEXT[k](w.count), rows: w.rows });
  }
  const unlinked = plan.filter((p) => (p.action === 'INSERT' || p.action === 'UPDATE') && !p.productId).length;
  if (unlinked) limitations.push({ key: 'unlinked', severity: 'reduces', message: `${nOf(unlinked, 'line')} will be imported without a product link. ${unlinked === 1 ? 'It' : 'They'} cannot be checked against stock or supplier delays until linked.` });
  const outsideReceipts = plan.filter((p) => p.changes.some((c) => c.field === 'received outside Starlane')).length;
  if (outsideReceipts) limitations.push({ key: 'receivedOutsideStarlane', severity: 'reduces', message: `${nOf(outsideReceipts, 'purchase line')} ${outsideReceipts === 1 ? 'shows' : 'show'} goods received in your system since the last import. Outstanding quantities are updated; stock is not changed by an import. Record the receipt in Starlane or adjust stock if Starlane should count those goods.` });
  return {
    kind,
    counts: {
      rows: extra.rowsTotal ?? null,
      accepted: count('INSERT') + count('UPDATE') + count('UNCHANGED'),
      new: count('INSERT'),
      updated: count('UPDATE'),
      unchanged: count('UNCHANGED'),
      closedSkipped: count('SKIP_CLOSED'),
      reviewRequired: count('REVIEW'),
      skippedByChoice: count('SKIPPED'),
      conflicts: plan.filter((p) => p.conflicts.length).length,
      rejected: norm.rejected.length,
      duplicateRows: norm.warnings.duplicateRow?.count || 0,
      unlinked,
    },
    review: [...review.values()],
    rejectedByReason: groupRejected(norm.rejected),
    conflicts: plan.filter((p) => p.conflicts.length).slice(0, 50).map((p) => ({ row: p.rec._row, ref: p.rec.externalRef, details: p.conflicts })),
    changes: plan.filter((p) => p.action === 'UPDATE').slice(0, 50).map((p) => ({ row: p.rec._row, ref: p.rec.externalRef, changes: p.changes })),
    limitations,
    sample: plan.filter((p) => p.action === 'INSERT' || p.action === 'UPDATE').slice(0, 8).map((p) => ({
      row: p.rec._row, action: p.action, party: p.rec.party, ref: p.rec.externalRef, product: p.product.productName || null, productBasis: p.product.basis || null,
      sku: p.rec.sku, productNameInFile: p.rec.productName, quantity: p.rec.quantity, outstanding: p.rec.outstanding, received: p.rec.received,
      price: p.rec.price, currency: p.rec.currency, dueDate: p.rec.dueDate, status: p.rec.status,
    })),
  };
}

function hashBytes(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function suggestedInputFrom(kind, proposal, { hasTallyStock }) {
  return {
    mapping: Object.fromEntries(Object.entries(proposal.fields).map(([f, m]) => [f, m.header])),
    dateOrders: Object.fromEntries(Object.entries(proposal.dateOrders).map(([h, d]) => [h, d.order || 'DMY'])),
    sourceSystem: '',
    currency: null,
    stockFollows: kind === 'purchase_lines' ? (hasTallyStock ? 'EXTERNAL' : 'STARLANE') : undefined,
    reviewChoices: {},
  };
}

async function tenantContext(db, userId) {
  const r = await db.query(
    `SELECT EXISTS (SELECT 1 FROM stock_movements WHERE user_id = $1 AND reference LIKE 'TLY-%') AS tally_stock,
            EXISTS (SELECT 1 FROM purchases WHERE user_id = $1 AND bill_number LIKE 'TLY-%') AS tally_purchases`,
    [userId]
  );
  return { hasTallyStock: !!r.rows[0].tally_stock, hasTallyPurchases: !!r.rows[0].tally_purchases };
}

/** Everything the human needs to confirm an import. Writes nothing. */
async function previewOperationalImport(pool, userId, kind, buffer, filename, mappingInput, { asOf = Date.now() } = {}) {
  if (!KINDS.includes(kind)) return { ok: false, status: 400, error: KIND_ERROR };
  const file = readLedgerFile(buffer, filename);
  if (!file.ok) return { ok: false, status: 400, error: file.error };
  if (MASTER_KINDS.has(kind)) return require('./masterDataImport').previewMasterData(pool, userId, kind, file, buffer, filename, mappingInput);
  const proposal = proposeMapping(kind, file.headers, file.rows);
  const ctx = await tenantContext(pool, userId);
  const suggestedInput = suggestedInputFrom(kind, proposal, ctx);
  const input = mappingInput || suggestedInput;
  const v = validateMapping(kind, file.headers, input, file.rows);
  const fileHash = hashBytes(buffer);
  const prior = (await pool.query(
    `SELECT id, filename, completed_at FROM file_import_batches WHERE user_id = $1 AND source_system = $2 AND status = 'COMPLETED' AND file_content_hash LIKE $3 ORDER BY completed_at DESC LIMIT 1`,
    [userId, `ops_import:${kind}`, `${fileHash}%`]
  )).rows[0] || null;
  let summary = null;
  if (v.ok) {
    const norm = normalizeRows(kind, file.headers, file.rows, v, { asOf });
    const products = await resolveProducts(pool, userId, norm.records, v.reviewChoices);
    const existing = await loadExisting(pool, userId, kind, norm.records);
    const plan = planRecords(kind, norm.records, products, existing);
    await markForeignBills(pool, userId, kind, plan, v);
    summary = summarize(kind, plan, norm, { rowsTotal: file.rows.length });
    summary.notInThisFile = await countNotInFile(pool, userId, kind, v.sourceSystem, norm.records);
  }
  return {
    ok: true,
    kind,
    file: { name: filename, type: file.fileType, sheet: file.sheet, rows: file.rows.length, columns: file.headers, sampleRows: file.rows.slice(0, 5), hash: fileHash },
    alreadyImported: prior ? { batchId: prior.id, filename: prior.filename, at: prior.completed_at } : null,
    proposal,
    suggestedInput,
    tenant: ctx,
    mappingErrors: v.ok ? [] : v.errors,
    summary,
  };
}

// A purchase order number that already exists as a bill entered elsewhere
// (manual purchase, Tally voucher) may already have put its goods in stock.
// Those lines are never attached to it; they become conflicts the owner sees.
async function markForeignBills(db, userId, kind, plan, v) {
  if (kind !== 'purchase_lines') return;
  const inserts = plan.filter((p) => p.action === 'INSERT');
  if (!inserts.length) return;
  const refs = [...new Set(inserts.map((p) => keyOf(p.rec.docRef)))];
  const r = await db.query(
    `SELECT lower(btrim(bill_number)) AS ref, lower(btrim(supplier_name)) AS supplier, bill_number
       FROM purchases WHERE user_id = $1 AND import_key IS NULL AND bill_number IS NOT NULL AND lower(btrim(bill_number)) = ANY($2)`,
    [userId, refs]
  );
  if (!r.rows.length) return;
  for (const p of inserts) {
    const hit = r.rows.find((x) => x.ref === keyOf(p.rec.docRef) && normalizeName(x.supplier) === normalizeName(p.rec.party));
    if (!hit) continue;
    p.action = 'CONFLICT';
    p.conflicts.push(`purchase ${hit.bill_number} from ${p.rec.party} already exists as a bill entered in Starlane or synced from your accounting system; its goods may already be in stock, so this line was not imported`);
  }
  void v;
}

async function countNotInFile(db, userId, kind, sourceSystem, records) {
  const table = kind === 'orders' ? 'order_line_items' : 'purchase_line_items';
  const r = await db.query(
    `SELECT COUNT(*)::int AS n FROM ${table} WHERE user_id = $1 AND lower(source_system) = lower($2) AND import_key IS NOT NULL AND NOT (import_key = ANY($3))`,
    [userId, sourceSystem, records.map((x) => x.lineKey)]
  );
  return r.rows[0].n;
}

// ── Commit ───────────────────────────────────────────────────────────────

async function ensureCustomer(client, userId, name, cache) {
  const key = normalizeName(name);
  if (cache.has(key)) return cache.get(key);
  let row = (await client.query('SELECT id FROM customers WHERE user_id = $1 AND lower(name) = lower($2) ORDER BY created_at LIMIT 1', [userId, name])).rows[0];
  let created = false;
  if (!row) {
    row = (await client.query('INSERT INTO customers (user_id, name) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING id', [userId, name])).rows[0]
      || (await client.query('SELECT id FROM customers WHERE user_id = $1 AND lower(name) = lower($2) LIMIT 1', [userId, name])).rows[0];
    created = true;
  }
  cache.set(key, { id: row ? row.id : null, created: false });
  return { id: row ? row.id : null, created };
}

async function ensureSupplier(client, userId, rec, cache) {
  const key = rec.taxId ? `tax:${rec.taxId.toUpperCase()}` : `name:${normalizeName(rec.party)}`;
  if (cache.has(key)) return cache.get(key);
  let row = null;
  if (rec.taxId) row = (await client.query('SELECT id, name FROM suppliers WHERE user_id = $1 AND upper(btrim(gstin)) = $2 ORDER BY id LIMIT 1', [userId, rec.taxId.toUpperCase()])).rows[0];
  if (!row) {
    const same = (await client.query('SELECT id, name, gstin FROM suppliers WHERE user_id = $1', [userId])).rows
      .filter((s) => normalizeName(s.name) === normalizeName(rec.party) && (!rec.taxId || !s.gstin || s.gstin.toUpperCase() === rec.taxId.toUpperCase()));
    if (same.length === 1) row = same[0];
  }
  let created = false;
  if (!row) {
    row = (await client.query('INSERT INTO suppliers (user_id, name, gstin) VALUES ($1,$2,$3) RETURNING id, name', [userId, rec.party, rec.taxId])).rows[0];
    created = true;
  }
  cache.set(key, { id: row.id, name: row.name, created: false });
  return { id: row.id, name: row.name, created };
}

const utcMidnight = (day) => (day ? `${day}T00:00:00Z` : null);

/**
 * Writes a confirmed import in ONE transaction. Any error rolls back every
 * row of this file; the failure is then recorded on its own.
 */
async function commitOperationalImport(pool, userId, kind, buffer, filename, mappingInput, { asOf = Date.now(), correlationId = null, actor = null, recheckKey = null } = {}) {
  if (!KINDS.includes(kind)) return { ok: false, status: 400, error: KIND_ERROR };
  const file = readLedgerFile(buffer, filename);
  if (!file.ok) return { ok: false, status: 400, error: file.error };
  if (MASTER_KINDS.has(kind)) return require('./masterDataImport').commitMasterData(pool, userId, kind, file, buffer, filename, mappingInput, { correlationId, actor });
  const v = validateMapping(kind, file.headers, mappingInput || {}, file.rows);
  if (!v.ok) return { ok: false, status: 400, error: 'The column choices need attention before importing.', errors: v.errors };
  const fileHash = hashBytes(buffer);
  // The same bytes with the same confirmed choices are one import. Different
  // choices (a corrected mapping) are a new batch; row identities keep it idempotent.
  // recheckKey (data feeds): the same file is looked at again when what it
  // depends on changed, e.g. products added since lines were held for review.
  const batchHash = `${fileHash}:${sha(JSON.stringify([kind, v.fields, v.dateOrders, keyOf(v.sourceSystem), v.currency, v.stockFollows, v.reviewChoices])).slice(0, 16)}${recheckKey ? `:${sha(String(recheckKey)).slice(0, 12)}` : ''}`;
  const norm = normalizeRows(kind, file.headers, file.rows, v, { asOf });
  const sourceTag = `ops_import:${kind}`;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // One import per tenant at a time: two uploads racing would otherwise both
    // decide a line is new.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`ops_import:${userId}`]);
    const prior = (await client.query('SELECT id, status, completed_at FROM file_import_batches WHERE user_id = $1 AND file_content_hash = $2 FOR UPDATE', [userId, batchHash])).rows[0];
    if (prior && prior.status === 'COMPLETED') {
      await client.query('ROLLBACK');
      return { ok: true, alreadyImported: true, batchId: prior.id, importedAt: prior.completed_at, summary: null };
    }
    const batch = prior || (await client.query(
      `INSERT INTO file_import_batches (user_id, source_system, filename, file_type, file_content_hash, mapping_profile, status, rows_total)
       VALUES ($1,$2,$3,$4,$5,$6,'STARTED',$7) RETURNING id`,
      [userId, sourceTag, String(filename).slice(0, 200), file.fileType, batchHash, `${kind}:${v.sourceSystem}`.slice(0, 120), file.rows.length]
    )).rows[0];

    const products = await resolveProducts(client, userId, norm.records, v.reviewChoices);
    const existing = await loadExisting(client, userId, kind, norm.records);
    const plan = planRecords(kind, norm.records, products, existing);
    await markForeignBills(client, userId, kind, plan, v);

    const custCache = new Map();
    const supCache = new Map();
    const docCache = new Map();
    const entities = { customersCreated: 0, suppliersCreated: 0, documentsCreated: 0, productSupplierLinks: 0 };

    for (const p of plan) {
      if (p.action !== 'INSERT' && p.action !== 'UPDATE') continue;
      const r = p.rec;
      if (kind === 'orders') {
        let order = docCache.get(r.docKey);
        if (!order) {
          const cust = await ensureCustomer(client, userId, r.party, custCache);
          if (cust.created) entities.customersCreated++;
          order = (await client.query('SELECT id, status FROM orders WHERE user_id = $1 AND import_key = $2', [userId, r.docKey])).rows[0];
          if (!order) {
            order = (await client.query(
              `INSERT INTO orders (user_id, customer_name, items, status, order_date, source_system, external_ref, customer_external_ref, import_key, special_instructions)
               VALUES ($1,$2,'[]'::jsonb,$3,COALESCE($4::date, CURRENT_DATE),$5,$6,$7,$8,$9) RETURNING id, status`,
              [userId, r.party, r.status && r.status !== 'dispatched' && r.status !== 'delivered' && r.status !== 'cancelled' ? r.status : 'new', r.docDate, v.sourceSystem, r.docRef, r.partyRef, r.docKey,
                `Imported from ${v.sourceSystem}${r.docDate ? '' : ' (no order date in the file; order date shows the import day)'}`]
            )).rows[0];
            entities.documentsCreated++;
          }
          docCache.set(r.docKey, order);
        }
        if (p.action === 'INSERT') {
          await client.query(
            `INSERT INTO order_line_items (user_id, order_id, product_id, quantity, unit_price, needed_by, source_system, external_ref, import_key,
                                           sku_as_imported, product_name_as_imported, outstanding_quantity, currency, line_status, last_import_batch_id, source_updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW())`,
            [userId, order.id, p.productId, r.quantity, r.price, r.dueDate, v.sourceSystem, r.externalRef, r.lineKey, r.sku, r.productName, r.outstanding, r.currency, r.status, batch.id]
          );
        } else {
          await client.query(
            `UPDATE order_line_items SET product_id = $3, quantity = $4, unit_price = $5, needed_by = $6, outstanding_quantity = $7, currency = $8,
                    line_status = COALESCE($9, line_status), sku_as_imported = $10, product_name_as_imported = $11, last_import_batch_id = $12, source_updated_at = NOW()
              WHERE id = $1 AND user_id = $2`,
            [p.existing.id, userId, p.productId, r.quantity, r.price, r.dueDate, r.outstanding, r.currency, r.status, r.sku, r.productName, batch.id]
          );
        }
        // An order is closed when every line of it in this file is closed.
        if (r.status && CLOSED_ORDER_STATUSES.has(r.status)) {
          await client.query(
            `UPDATE orders o SET status = $3, updated_at = NOW() WHERE o.id = $1 AND o.user_id = $2
               AND NOT EXISTS (SELECT 1 FROM order_line_items x WHERE x.order_id = o.id AND x.user_id = o.user_id AND COALESCE(x.line_status, 'open') NOT IN ('dispatched','delivered','cancelled'))`,
            [order.id, userId, r.status]
          );
        }
      } else {
        const sup = await ensureSupplier(client, userId, r, supCache);
        if (sup.created) entities.suppliersCreated++;
        let purchase = docCache.get(r.docKey);
        if (!purchase) {
          purchase = (await client.query('SELECT id FROM purchases WHERE user_id = $1 AND import_key = $2', [userId, r.docKey])).rows[0];
          if (!purchase) {
            // An open purchase order is not a bill: amount 0 and status
            // "ordered", so payables and working capital are unchanged.
            purchase = (await client.query(
              `INSERT INTO purchases (user_id, supplier_name, amount, paid_amount, status, purchase_date, bill_number, supplier_gstin, currency, notes, category,
                                      source_system, external_ref, import_key)
               VALUES ($1,$2,0,0,'ordered',COALESCE($3::date, CURRENT_DATE),$4,$5,$6,$7,'purchase_order',$8,$9,$10) RETURNING id`,
              [userId, r.party, r.docDate, r.docRef, r.taxId, r.currency,
                `Open purchase order imported from ${v.sourceSystem}. Not a bill: no amount is payable from this record; line values are on its purchase lines.`,
                v.sourceSystem, r.docRef, r.docKey]
            )).rows[0];
            entities.documentsCreated++;
          }
          docCache.set(r.docKey, purchase);
        }
        if (p.action === 'INSERT') {
          await client.query(
            `INSERT INTO purchase_line_items (user_id, purchase_id, product_id, quantity, unit_price, currency, expected_at, received_quantity, received_before_tracking,
                                              stock_follows, source_system, external_ref, import_key, sku_as_imported, product_name_as_imported, line_status,
                                              last_import_batch_id, source_updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW())`,
            [userId, purchase.id, p.productId, r.quantity, r.price, r.currency, utcMidnight(r.dueDate), r.received || '0', v.stockFollows, v.sourceSystem,
              r.externalRef, r.lineKey, r.sku, r.productName, r.status, batch.id]
          );
        } else {
          const ex = p.existing;
          const changed = new Set(p.changes.map((c) => c.field));
          const newReceived = changed.has('received outside Starlane') ? r.received : null;
          const dateLater = changed.has('expected date') && ex.expected_at && r.dueDate > dayOf(ex.expected_at);
          await client.query(
            `UPDATE purchase_line_items SET
                product_id = CASE WHEN $3::boolean THEN $4::uuid ELSE product_id END,
                quantity = CASE WHEN $5::boolean THEN $6::numeric ELSE quantity END,
                received_before_tracking = CASE WHEN $7::numeric IS NULL THEN received_before_tracking ELSE received_before_tracking + ($7::numeric - COALESCE(received_quantity, 0)) END,
                received_quantity = COALESCE($7::numeric, received_quantity),
                unit_price = $8, currency = $9,
                original_expected_at = CASE WHEN $11::boolean THEN COALESCE(original_expected_at, expected_at) ELSE original_expected_at END,
                delay_reported_at = CASE WHEN $11::boolean THEN NOW() ELSE delay_reported_at END,
                delay_reason = CASE WHEN $11::boolean THEN $12 ELSE delay_reason END,
                expected_at = COALESCE($10::timestamptz, expected_at),
                line_status = $13, sku_as_imported = $14, product_name_as_imported = $15, last_import_batch_id = $16, source_updated_at = NOW()
              WHERE id = $1 AND user_id = $2`,
            [ex.id, userId, changed.has('product'), p.productId, changed.has('quantity'), r.quantity, newReceived, r.price, r.currency,
              changed.has('expected date') ? utcMidnight(r.dueDate) : null, !!dateLater, `Expected date moved in ${v.sourceSystem} export (${filename})`.slice(0, 500),
              r.status, r.sku, r.productName, batch.id]
          );
        }
        if (p.productId) {
          const link = await client.query(
            `INSERT INTO product_suppliers (user_id, product_id, supplier_id, evidence, source, first_seen_at, last_seen_at)
             VALUES ($1,$2,$3,$4,'ops_import', NOW(), NOW())
             ON CONFLICT (user_id, product_id, supplier_id) DO UPDATE SET last_seen_at = NOW() RETURNING (xmax = 0) AS inserted`,
            [userId, p.productId, sup.id, `purchase order ${r.docRef} imported from ${v.sourceSystem}`]
          );
          if (link.rows[0]?.inserted) entities.productSupplierLinks++;
        }
      }
      const obs = makeObservation({
        userId, sourceSystem: `${sourceTag}:${keyOf(v.sourceSystem)}`.slice(0, 120), sourceRecordId: r.externalRef, entityType: kind === 'orders' ? 'order_line_item' : 'purchase_line_item',
        observedAt: r.docDate ? utcMidnight(r.docDate) : null, sourceQuality: 'REAL',
        fields: { lineKey: r.lineKey, party: r.party, docRef: r.docRef, lineRef: r.lineRef, sku: r.sku, productName: r.productName, quantity: r.quantity, outstanding: r.outstanding, received: r.received, price: r.price, currency: r.currency, docDate: r.docDate, dueDate: r.dueDate, status: r.status },
        rawReference: { row: r._row, file: String(filename).slice(0, 200), batchId: batch.id }, ingestionVersion: 'operationalImport.v1',
      });
      await client.query(
        `INSERT INTO raw_observations (user_id, source_system, source_record_id, content_hash, entity_type, observed_at, received_at, source_quality, fields, raw_reference, ingestion_version, resulting_table)
         VALUES ($1,$2,$3,$4,$5,$6,NOW(),$7,$8,$9,$10,$11) ON CONFLICT (user_id, source_system, content_hash) DO NOTHING`,
        [userId, obs.sourceSystem, obs.sourceRecordId, obs.contentHash, obs.entityType, obs.observedAt, obs.sourceQuality, JSON.stringify(obs.fields), JSON.stringify(obs.rawReference), obs.ingestionVersion,
          kind === 'orders' ? 'order_line_items' : 'purchase_line_items']
      );
    }

    const summary = summarize(kind, plan, norm, { rowsTotal: file.rows.length });
    summary.notInThisFile = await countNotInFile(client, userId, kind, v.sourceSystem, norm.records);
    summary.entities = entities;
    await client.query(
      `UPDATE file_import_batches SET status = 'COMPLETED', completed_at = NOW(), rows_total = $2, rows_accepted = $3, rows_rejected = $4,
              rows_review_required = $5, rows_duplicate = $6, entities_created = $7, entities_matched = $8, error_message = NULL
        WHERE id = $1`,
      [batch.id, file.rows.length, summary.counts.accepted, summary.counts.rejected, summary.counts.reviewRequired, summary.counts.duplicateRows,
        entities.customersCreated + entities.suppliersCreated + entities.documentsCreated, summary.counts.accepted - summary.counts.new]
    );
    await appendEvent(client, {
      userId, decisionId: null, type: 'OPERATIONS_IMPORTED', actor: actor || humanActor(userId), correlationId,
      payload: { batchId: batch.id, kind, sourceSystem: v.sourceSystem, filename: String(filename).slice(0, 200), fileHash, counts: summary.counts, entities, stockFollows: v.stockFollows },
    });
    await client.query('COMMIT');
    return { ok: true, alreadyImported: false, batchId: batch.id, summary };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    await pool.query(
      `INSERT INTO file_import_batches (user_id, source_system, filename, file_type, file_content_hash, mapping_profile, status, rows_total, error_message, completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,'FAILED',$7,$8,NOW())
       ON CONFLICT (user_id, file_content_hash) DO UPDATE SET status = 'FAILED', error_message = EXCLUDED.error_message, completed_at = NOW()`,
      [userId, sourceTag, String(filename).slice(0, 200), file.fileType, batchHash, `${kind}:${v.sourceSystem}`.slice(0, 120), file.rows.length, String(err.message || err).slice(0, 500)]
    ).catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  KINDS, FIELDS, ISO_CURRENCIES, KIND_ERROR,
  keyOf, cleanText, sha, hashBytes, nOf, groupRejected,
  parseQuantity, parsePrice, parseCurrencyCell, proposeMapping, validateMapping, normalizeRows, planRecords,
  resolveProducts, previewOperationalImport, commitOperationalImport,
};
