'use strict';
// lib/connectors/feeds/tallyOps.js — Tally's orders, purchase orders and
// stock items, as the rows a data feed imports.
//
// The Starlane bridge on the shop PC (tally-connector/tally-sync.mjs) asks
// Tally for two read-only exports (TALLYREQUEST=Export) and sends the XML as
// it came, so all parsing happens here, in one tested place:
//
//   stock items   a StockItem collection: name, group, base unit, closing
//                 balance. One product row per item.
//   order vouchers a Voucher collection over a date range with Sales Orders,
//                 Purchase Orders and the vouchers that fulfil them
//                 (Delivery Notes and Sales invoices; Receipt Notes and
//                 Purchase invoices). An order line's outstanding quantity is
//                 what was ordered less what was delivered or received
//                 against that order number.
//
// How fulfilment is counted: Tally ties a delivery to an order through the
// ORDERNO on the delivery's batch allocation. A business may raise a Delivery
// Note and later a Sales invoice for the same goods, both carrying the order
// number, so notes and invoices are added up separately and the larger of the
// two is taken, never their sum.
//
// A voucher's kind is read from its base voucher type (the bridge asks Tally
// for it as STARLANEPARENT), falling back to the voucher type's own name, so
// renamed types ("GST Sales", "SO - Export") are still recognised. Optional
// vouchers (memoranda) are left out; a cancelled order's lines are sent as
// cancelled so lines imported earlier are closed.
//
// Pure functions: no network, no database.

const { decode, tag } = require('../../domain/ingestion/adapters/tallyVoucherParser');

const MAX_XML_CHARS = 10 * 1024 * 1024;
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function leadingNumber(v) {
  const m = String(v ?? '').replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

/** Tally writes dates as 20260615, 15-Jun-2026, 15-Jun-26 or 2026-06-15. */
function tallyDate(raw) {
  const s = String(raw ?? '').trim();
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = /^(\d{1,2})[-\s/]([A-Za-z]{3})[A-Za-z]*[-\s/](\d{2}|\d{4})$/.exec(s);
  if (m && MONTHS[m[2].toLowerCase()]) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return `${y}-${String(MONTHS[m[2].toLowerCase()]).padStart(2, '0')}-${String(Number(m[1])).padStart(2, '0')}`;
  }
  return null;
}

/** A date tag: its text, or its P ("printed") attribute. */
function dateTag(block, name) {
  const m = block.match(new RegExp(`<${name}((?:\\s[^>]*)?)>([\\s\\S]*?)</${name}>`, 'i'));
  if (!m) return null;
  const p = /\bP="([^"]*)"/i.exec(m[1] || '');
  return tallyDate(decode(m[2].trim())) || (p ? tallyDate(decode(p[1])) : null);
}

// Tally writes control characters as numeric entities (the Primary group is "&#4; Primary").
const clean = (s) => String(s ?? '')
  .replace(/&#(\d{1,6});/g, (_, n) => (Number(n) >= 32 ? String.fromCodePoint(Number(n)) : ''))
  .replace(/\s+/g, ' ').trim();
const fmt = (n) => (n === null || n === undefined || !Number.isFinite(n) ? '' : String(Math.round(n * 1e6) / 1e6));

function xmlOf(raw) {
  const xml = String(raw ?? '');
  if (!xml.trim()) return '';
  if (xml.length > MAX_XML_CHARS) throw Object.assign(new Error('The Tally export is larger than 10 MB. Sync a shorter date range.'), { status: 413 });
  const err = tag(xml, 'LINEERROR');
  if (err) throw Object.assign(new Error(`Tally refused the export: ${clean(err).slice(0, 200)}`), { status: 422 });
  return xml;
}

// ── Stock items → products ──────────────────────────────────────────────

/** Pure: a StockItem collection export → product rows. */
function stockRows(rawXml) {
  const xml = xmlOf(rawXml);
  const rows = [];
  const seen = new Set();
  let negative = 0;
  for (const b of xml.match(/<STOCKITEM\b[^>]*>[\s\S]*?<\/STOCKITEM>/gi) || []) {
    const attr = /<STOCKITEM\b[^>]*\bNAME="([^"]*)"/i.exec(b);
    const name = clean(attr ? decode(attr[1]) : tag(b, 'NAME'));
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const unit = clean(tag(b, 'BASEUNITS'));
    const closing = leadingNumber(tag(b, 'CLOSINGBALANCE'));
    if (closing !== null && closing < 0) negative++;
    rows.push({
      SKU: '',
      'Product Name': name,
      // Tally allows negative stock (billed before the purchase was entered); none is on hand.
      'On Hand': closing === null ? '0' : fmt(Math.max(0, closing)),
      Unit: unit,
      'Unit Price': '',
      Category: clean(tag(b, 'PARENT')).replace(/^primary$/i, ''),
    });
  }
  return { rows, negative };
}

// ── Order vouchers → order and purchase lines ───────────────────────────

/** Pure: what a voucher is, from its base type (or its own type name). */
function voucherClass(typeName) {
  const t = String(typeName || '').toLowerCase();
  if (/order/.test(t) && /sale/.test(t)) return 'sales_order';
  if (/order/.test(t) && /purc/.test(t)) return 'purchase_order';
  if (/delivery\s*note/.test(t)) return 'delivery_note';
  if (/receipt\s*note|\bgrn\b|goods\s*receipt/.test(t)) return 'receipt_note';
  if (/order/.test(t)) return null;
  if (/purc/.test(t) && !/return|debit/.test(t)) return 'purchase_invoice';
  if (/sale/.test(t) && !/return|credit/.test(t)) return 'sales_invoice';
  return null;
}

const FULFILS = { delivery_note: 'sales_order', sales_invoice: 'sales_order', receipt_note: 'purchase_order', purchase_invoice: 'purchase_order' };

/** Pure: a Voucher collection export → parsed order and fulfilment vouchers. */
function parseOrderVouchers(rawXml) {
  const xml = xmlOf(rawXml);
  const out = [];
  for (const b of xml.match(/<VOUCHER\b[^>]*>[\s\S]*?<\/VOUCHER>/gi) || []) {
    if (!/<VOUCHER\b[^>]*VCHTYPE="/i.test(b) && !tag(b, 'VOUCHERTYPENAME')) continue; // CMPINFO counts, not vouchers
    const typeName = clean(tag(b, 'VOUCHERTYPENAME') || (/<VOUCHER\b[^>]*VCHTYPE="([^"]*)"/i.exec(b) || [])[1] || '');
    const cls = voucherClass(tag(b, 'STARLANEPARENT')) || voucherClass(typeName);
    if (!cls) continue;
    const flag = (n) => /^yes$/i.test(clean(tag(b, n)));
    if (flag('ISOPTIONAL')) continue;
    const entries = [];
    for (const e of b.match(/<(ALLINVENTORYENTRIES|INVENTORYENTRIES)\.LIST>[\s\S]*?<\/\1\.LIST>/gi) || []) {
      const item = clean(tag(e, 'STOCKITEMNAME'));
      if (!item) continue;
      const qty = Math.abs(leadingNumber(tag(e, 'BILLEDQTY') || tag(e, 'ACTUALQTY')) ?? NaN);
      const rate = leadingNumber(tag(e, 'RATE'));
      const allocations = [];
      for (const a of e.match(/<BATCHALLOCATIONS\.LIST>[\s\S]*?<\/BATCHALLOCATIONS\.LIST>/gi) || []) {
        const aq = leadingNumber(tag(a, 'BILLEDQTY') || tag(a, 'ACTUALQTY'));
        allocations.push({ orderNo: clean(tag(a, 'ORDERNO')), qty: aq === null ? null : Math.abs(aq), dueDate: dateTag(a, 'ORDERDUEDATE') });
      }
      entries.push({ item, qty: Number.isFinite(qty) ? qty : null, rate: rate === null ? null : Math.abs(rate), allocations });
    }
    out.push({
      cls, typeName, date: dateTag(b, 'DATE'), number: clean(tag(b, 'VOUCHERNUMBER')),
      party: clean(tag(b, 'PARTYLEDGERNAME') || tag(b, 'PARTYNAME')), cancelled: flag('ISCANCELLED'), entries,
    });
  }
  return out;
}

const lineKey = (orderNo, item) => `${orderNo.toLowerCase()}\u0000${item.toLowerCase()}`;

/**
 * Pure: order lines with what is still outstanding. `kind` is 'orders'
 * (Sales Orders) or 'purchase_lines' (Purchase Orders). `company` keeps two
 * Tally companies' order numbers apart.
 */
function orderRows(rawXml, kind, { company = '' } = {}) {
  const want = kind === 'orders' ? 'sales_order' : kind === 'purchase_lines' ? 'purchase_order' : null;
  if (!want) throw Object.assign(new Error('Tally can feed customer orders, purchase orders and stock items.'), { status: 400 });
  const vouchers = parseOrderVouchers(rawXml);
  const lines = new Map();
  let noNumber = 0;
  for (const v of vouchers.filter((x) => x.cls === want)) {
    if (!v.number) { noNumber++; continue; }
    for (const e of v.entries) {
      const k = lineKey(v.number, e.item);
      const prev = lines.get(k);
      const due = e.allocations.map((a) => a.dueDate).filter(Boolean).sort()[0] || null;
      if (prev) {
        // The same item twice on one order is one line to fulfil.
        prev.qty = (prev.qty ?? 0) + (e.qty ?? 0);
        prev.dueDate = [prev.dueDate, due].filter(Boolean).sort()[0] || null;
        prev.cancelled = prev.cancelled && v.cancelled;
        continue;
      }
      lines.set(k, { orderNo: v.number, party: v.party, date: v.date, item: e.item, qty: e.qty, rate: e.rate, dueDate: due, cancelled: v.cancelled });
    }
  }
  // Fulfilled quantity per order line, per fulfilling voucher class.
  const done = new Map();
  for (const v of vouchers) {
    if (FULFILS[v.cls] !== want || v.cancelled) continue;
    for (const e of v.entries) {
      const tied = e.allocations.filter((a) => a.orderNo);
      for (const a of tied) {
        const qty = a.qty ?? (tied.length === 1 ? e.qty : null);
        if (!qty) continue;
        const k = lineKey(a.orderNo, e.item);
        const m = done.get(k) || {};
        m[v.cls] = (m[v.cls] || 0) + qty;
        done.set(k, m);
      }
    }
  }
  const prefix = `tally:${company ? `${clean(company).toLowerCase()}:` : ''}${want === 'sales_order' ? 'so' : 'po'}`;
  const rows = [];
  for (const [k, l] of lines) {
    const fulfilled = Math.max(0, ...Object.values(done.get(k) || {}));
    const outstanding = l.qty === null ? null : Math.max(0, l.qty - fulfilled);
    const recordId = `${prefix}:${l.orderNo}:${l.item}`.slice(0, 300);
    if (want === 'sales_order') {
      rows.push({
        'Customer Name': l.party, 'Customer ID': '', 'Order Number': l.orderNo, 'Line Ref': l.item, 'Record ID': recordId,
        SKU: '', 'Product Name': l.item, Quantity: fmt(l.qty), 'Outstanding Qty': fmt(outstanding), 'Unit Price': fmt(l.rate),
        Currency: '', 'Order Date': l.date || '', 'Promised Date': l.dueDate || '',
        Status: l.cancelled ? 'cancelled' : outstanding === 0 ? 'fulfilled' : fulfilled > 0 ? 'partially shipped' : 'confirmed',
      });
    } else {
      rows.push({
        'Supplier Name': l.party, 'Supplier ID': '', 'Supplier GSTIN': '', 'PO Number': l.orderNo, 'Line Ref': l.item, 'Record ID': recordId,
        SKU: '', 'Product Name': l.item, Quantity: fmt(l.qty), 'Received Qty': fmt(Math.min(fulfilled, l.qty ?? fulfilled)), 'Outstanding Qty': fmt(outstanding),
        'Expected Date': l.dueDate || '', 'PO Date': l.date || '', 'Unit Cost': fmt(l.rate), Currency: '',
        Status: l.cancelled ? 'cancelled' : outstanding === 0 ? 'received' : fulfilled > 0 ? 'partially received' : 'open',
      });
    }
  }
  return { rows, orders: new Set([...lines.values()].map((l) => l.orderNo)).size, noNumber };
}

/** Pure: the rows a Tally delivery brings for a feed's kind. */
function tallyFeedRows(kind, { xml, company = '' } = {}) {
  if (kind === 'products') return stockRows(xml);
  if (kind === 'orders' || kind === 'purchase_lines') return orderRows(xml, kind, { company });
  throw Object.assign(new Error('Tally can feed customer orders, purchase orders and stock items, not bills of materials.'), { status: 400 });
}

const TALLY_KINDS = ['orders', 'purchase_lines', 'products'];

module.exports = { tallyFeedRows, stockRows, orderRows, parseOrderVouchers, voucherClass, tallyDate, TALLY_KINDS, MAX_XML_CHARS };
