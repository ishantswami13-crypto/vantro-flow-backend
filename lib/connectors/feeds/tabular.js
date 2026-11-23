'use strict';
// lib/connectors/feeds/tabular.js — turn what a source sends into the one
// shape the operational import reads: a CSV file.
//
// A feed never writes data itself. Every source (an app's records, a JSON
// API, rows pushed by another tool) is converted to CSV here and handed to
// previewOperationalImport / commitOperationalImport, exactly as if the owner
// had uploaded that file. So a feed gets the same column mapping, value
// checks, row identity, dedup, review questions and audit trail as an upload.
//
// Pure functions; no I/O.

const MAX_ROWS = 50000;
const MAX_COLUMNS = 200;
const MAX_DEPTH = 3;

// Column names the import recognises without asking, per kind. App adapters
// emit exactly these, and they are what the push API documents.
const CANONICAL = {
  orders: {
    customer_name: 'Customer Name', customer_ref: 'Customer ID', order_ref: 'Order Number', line_ref: 'Line Ref', record_id: 'Record ID',
    sku: 'SKU', product_name: 'Product Name', quantity: 'Quantity', outstanding_quantity: 'Outstanding Qty', unit_price: 'Unit Price',
    currency: 'Currency', order_date: 'Order Date', promised_date: 'Promised Date', status: 'Status',
  },
  purchase_lines: {
    supplier_name: 'Supplier Name', supplier_ref: 'Supplier ID', supplier_tax_id: 'Supplier GSTIN', po_ref: 'PO Number', line_ref: 'Line Ref',
    record_id: 'Record ID', sku: 'SKU', product_name: 'Product Name', quantity: 'Quantity', received_quantity: 'Received Qty',
    outstanding_quantity: 'Outstanding Qty', expected_date: 'Expected Date', purchase_date: 'PO Date', unit_cost: 'Unit Cost',
    currency: 'Currency', status: 'Status',
  },
  products: { sku: 'SKU', product_name: 'Product Name', on_hand: 'On Hand', unit: 'Unit', unit_price: 'Unit Price', category: 'Category' },
  components: { finished_sku: 'Finished SKU', finished_name: 'Finished Product', component_sku: 'Component SKU', component_name: 'Component Name', quantity_per_unit: 'Qty Per Unit' },
};
const DATE_FIELDS = { orders: ['order_date', 'promised_date'], purchase_lines: ['purchase_date', 'expected_date'], products: [], components: [] };

function feedError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);

function cell(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10);
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 500);
  return String(v);
}

/** Flattens nested objects to "a.b" keys (to MAX_DEPTH); arrays of values join with ", ". */
function flatten(obj, prefix = '', out = {}, depth = 0) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (isPlainObject(v) && depth < MAX_DEPTH) flatten(v, key, out, depth + 1);
    else if (Array.isArray(v) && v.every((x) => !isPlainObject(x) && !Array.isArray(x))) out[key] = v.map(cell).join(', ');
    else out[key] = v;
  }
  return out;
}

/**
 * One record → one or more flat rows. A record with exactly one list of
 * objects (an order with its lines) becomes one row per item: the item's
 * fields, plus the record's own fields; a record field with the same name as
 * an item field is kept as "parent.<name>".
 */
function explode(record) {
  const lists = Object.entries(record).filter(([, v]) => Array.isArray(v) && v.length && v.every(isPlainObject));
  if (lists.length !== 1) return [flatten(record)];
  const [listKey, items] = lists[0];
  const parent = {};
  for (const [k, v] of Object.entries(record)) if (k !== listKey) parent[k] = v;
  const flatParent = flatten(parent);
  return items.map((item) => {
    const flatItem = flatten(item);
    const row = {};
    for (const [k, v] of Object.entries(flatParent)) row[Object.prototype.hasOwnProperty.call(flatItem, k) ? `parent.${k}` : k] = v;
    return Object.assign(row, flatItem);
  });
}

/** Finds the list of records in a JSON document. */
function recordsFromJson(doc) {
  if (Array.isArray(doc)) return doc;
  if (isPlainObject(doc)) {
    for (const key of ['rows', 'records', 'data', 'items', 'results', 'value', 'orders', 'products', 'lines', 'purchase_orders', 'purchaseOrders']) {
      if (Array.isArray(doc[key])) return doc[key];
      if (isPlainObject(doc[key])) for (const inner of ['rows', 'records', 'items', 'results']) if (Array.isArray(doc[key][inner])) return doc[key][inner];
    }
    return [doc];
  }
  throw feedError('Send a JSON list of records, or an object with a "rows" list.');
}

/** JSON records → flat rows. */
function rowsFromJson(doc) {
  const records = recordsFromJson(doc);
  const rows = [];
  for (const r of records) {
    if (!isPlainObject(r)) throw feedError('Each record must be a JSON object (column name → value).');
    rows.push(...explode(r));
    if (rows.length > MAX_ROWS) throw feedError(`More than ${MAX_ROWS} rows. Send them in smaller batches.`, 413);
  }
  return rows;
}

function escapeCsv(s) {
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Flat rows → CSV bytes. Columns in order of first appearance. */
function rowsToCsv(rows) {
  if (rows.length > MAX_ROWS) throw feedError(`More than ${MAX_ROWS} rows. Send them in smaller batches.`, 413);
  const headers = [];
  const seen = new Set();
  for (const r of rows) for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); headers.push(k); }
  if (headers.length > MAX_COLUMNS) throw feedError(`More than ${MAX_COLUMNS} columns; send only the fields Starlane needs.`);
  const lines = [headers.map(escapeCsv).join(',')];
  for (const r of rows) lines.push(headers.map((h) => escapeCsv(cell(r[h]))).join(','));
  return Buffer.from(`${lines.join('\r\n')}\r\n`, 'utf8');
}

/**
 * The confirmed import input for rows that use CANONICAL column names
 * (app adapters). Every present canonical column is mapped; ISO dates make
 * day/month order irrelevant, so DMY is stated only to satisfy the import's
 * rule that an unprovable order is never assumed silently.
 */
function canonicalInput(kind, headers, { sourceSystem, currency = null, stockFollows = undefined } = {}) {
  const map = CANONICAL[kind];
  const mapping = {};
  const dateOrders = {};
  for (const [field, header] of Object.entries(map)) {
    if (!headers.includes(header)) continue;
    mapping[field] = header;
    if (DATE_FIELDS[kind].includes(field)) dateOrders[header] = 'DMY';
  }
  return { mapping, dateOrders, sourceSystem, currency, ...(kind === 'purchase_lines' ? { stockFollows } : {}), reviewChoices: {} };
}

module.exports = { CANONICAL, DATE_FIELDS, MAX_ROWS, flatten, explode, recordsFromJson, rowsFromJson, rowsToCsv, canonicalInput, feedError };
