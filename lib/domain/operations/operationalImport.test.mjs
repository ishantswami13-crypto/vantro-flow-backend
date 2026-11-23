// Pure tests for the operational importer's parsing, mapping and change
// planning (no database). Run: node lib/domain/operations/operationalImport.test.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const I = require('./operationalImport.js');
const D = require('./decimal.js');

let passed = 0;
function check(name, fn) { fn(); passed += 1; console.log(`ok ${name}`); }

check('decimals are exact', () => {
  assert.equal(D.fromMicro(D.toMicro('0.1') + D.toMicro('0.2')), '0.3');
  assert.equal(D.normalize('1250.500'), '1250.5');
  assert.equal(D.toMicro('1.0000001'), null, 'more than 6 dp is refused, not rounded');
  assert.equal(D.normalize('-3'), '-3');
});

check('quantities: Indian grouping and unit words read; negatives and words refused', () => {
  assert.equal(D.fromMicro(I.parseQuantity('1,25,000').micro), '125000');
  assert.equal(D.fromMicro(I.parseQuantity('50 pcs').micro), '50');
  assert.equal(D.fromMicro(I.parseQuantity('12.5').micro), '12.5');
  assert.ok(I.parseQuantity('-4').error);
  assert.ok(I.parseQuantity('ten').error);
  assert.ok(I.parseQuantity('').empty);
});

check('currency: codes and single-currency symbols accepted, shared symbols refused', () => {
  assert.equal(I.parseCurrencyCell('inr').code, 'INR');
  assert.equal(I.parseCurrencyCell('₹').code, 'INR');
  assert.equal(I.parseCurrencyCell('€').code, 'EUR');
  assert.match(I.parseCurrencyCell('$').error, /ambiguous/);
  assert.match(I.parseCurrencyCell('RUP').error, /not a recognised/);
  assert.equal(I.parsePrice('₹4,200.00').symbolCurrency, 'INR');
  assert.equal(I.parsePrice('$12').ambiguousSymbol, true);
  assert.equal(D.fromMicro(I.parsePrice('4,200.00').micro), '4200');
});

check('mapping: exact headers confirm, partial headers only suggest, nothing required is invented', () => {
  const headers = ['Order No', 'Customer', 'Item Code', 'Qty', 'Customer delivery date note'];
  const rows = [['SO-1', 'A', 'X', '5', '2026-01-01']];
  const p = I.proposeMapping('orders', headers, rows);
  assert.equal(p.fields.order_ref.verdict, 'CONFIRMED');
  assert.equal(p.fields.quantity.header, 'Qty');
  assert.ok(!p.fields.promised_date || p.fields.promised_date.verdict === 'SUGGESTED');
  const v = I.validateMapping('orders', headers, { mapping: { order_ref: 'Order No', customer_name: 'Customer', sku: 'Item Code' }, sourceSystem: 'Sheet' }, rows);
  assert.ok(v.errors.some((e) => /ordered quantity/.test(e)), 'missing mandatory field is reported');
  const noSource = I.validateMapping('orders', headers, { mapping: { order_ref: 'Order No', customer_name: 'Customer', sku: 'Item Code', quantity: 'Qty' } }, rows);
  assert.ok(noSource.errors.some((e) => /system this file came from/.test(e)));
  const po = I.validateMapping('purchase_lines', ['PO', 'Vendor', 'SKU', 'Qty'], { mapping: { po_ref: 'PO', supplier_name: 'Vendor', sku: 'SKU', quantity: 'Qty' }, sourceSystem: 'Zoho' }, []);
  assert.ok(po.errors.some((e) => /who records stock/.test(e)), 'stock ownership must be chosen, never defaulted at commit');
});

check('date order: proven from the data, asked when ambiguous, contradicting choice refused', () => {
  const headers = ['Order No', 'Customer', 'SKU', 'Qty', 'Promised Date'];
  const base = { mapping: { order_ref: 'Order No', customer_name: 'Customer', sku: 'SKU', quantity: 'Qty', promised_date: 'Promised Date' }, sourceSystem: 'Sheet' };
  const ambiguous = [['1', 'A', 'X', '1', '03/04/2026']];
  assert.ok(I.validateMapping('orders', headers, base, ambiguous).errors.some((e) => /day\/month or month\/day/.test(e)));
  assert.ok(I.validateMapping('orders', headers, { ...base, dateOrders: { 'Promised Date': 'DMY' } }, ambiguous).ok);
  const proven = [['1', 'A', 'X', '1', '13/04/2026']];
  assert.ok(I.validateMapping('orders', headers, base, proven).ok);
  assert.ok(I.validateMapping('orders', headers, { ...base, dateOrders: { 'Promised Date': 'MDY' } }, proven).errors.some((e) => /can only be day\/month/.test(e)));
  const v = I.validateMapping('orders', headers, base, proven);
  const n = I.normalizeRows('orders', headers, proven, v);
  assert.equal(n.records[0].dueDate, '2026-04-13');
});

check('purchase quantities must agree; missing received/outstanding is an explicit assumption', () => {
  const headers = ['PO', 'Vendor', 'SKU', 'Qty', 'Received', 'Pending'];
  const v = I.validateMapping('purchase_lines', headers, { mapping: { po_ref: 'PO', supplier_name: 'Vendor', sku: 'SKU', quantity: 'Qty', received_quantity: 'Received', outstanding_quantity: 'Pending' }, sourceSystem: 'Zoho', stockFollows: 'STARLANE' }, []);
  const n = I.normalizeRows('purchase_lines', headers, [
    ['P1', 'V', 'A', '10', '4', '6'],
    ['P2', 'V', 'A', '10', '4', '5'],
    ['P3', 'V', 'A', '10', '', '3'],
    ['P4', 'V', 'A', '10', '', ''],
  ], v);
  assert.deepEqual(n.records.map((r) => [r.docRef, r.received, r.outstanding]), [['P1', '4', '6'], ['P3', '7', '3'], ['P4', '0', '10']]);
  assert.match(n.rejected[0].reason, /quantities disagree/);
  assert.equal(n.warnings.receivedAssumedZero.count, 1);
});

check('row identity: same line twice with the same values counts once; with different values is refused', () => {
  const headers = ['Order No', 'Customer', 'SKU', 'Qty'];
  const v = I.validateMapping('orders', headers, { mapping: { order_ref: 'Order No', customer_name: 'Customer', sku: 'SKU', quantity: 'Qty' }, sourceSystem: 'Sheet' }, []);
  const n = I.normalizeRows('orders', headers, [['S1', 'A', 'X', '2'], ['S1', 'A', 'X', '2'], ['S1', 'A', 'X', '3']], v);
  assert.equal(n.records.length, 1);
  assert.equal(n.warnings.duplicateRow.count, 1);
  assert.match(n.rejected[0].reason, /appears again with different values/);
  const other = I.validateMapping('orders', headers, { mapping: { order_ref: 'Order No', customer_name: 'Customer', sku: 'SKU', quantity: 'Qty' }, sourceSystem: 'Other ERP' }, []);
  assert.notEqual(I.normalizeRows('orders', headers, [['S1', 'A', 'X', '2']], other).records[0].lineKey, n.records[0].lineKey, 'different source systems never collide');
});

check('change planning protects Starlane-recorded receipts from a file', () => {
  const rec = { lineKey: 'k', quantity: '50', received: '10', outstanding: '40', price: '1', currency: 'INR', dueDate: '2026-01-10', status: null, _row: 2, externalRef: 'P/1' };
  const products = new Map([[rec, { status: 'MATCHED', productId: 'p1' }]]);
  const existing = new Map([['k', { id: 'x', product_id: 'p1', quantity: '50', received_quantity: '30', starlane_received: '20', unit_price: '1', currency: 'INR', expected_at: '2026-01-10T00:00:00Z', line_status: null }]]);
  const [p] = I.planRecords('purchase_lines', [rec], products, existing);
  assert.equal(p.action, 'CONFLICT');
  assert.match(p.conflicts[0], /kept Starlane's receipts/);
});

console.log(`\n${passed} checks passed`);
