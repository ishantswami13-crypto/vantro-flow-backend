// Pure tests for lib/domain/inventory/stockLedger.js (no database).
// Run: node lib/domain/inventory/stockLedger.test.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const L = require('./stockLedger.js');

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`ok ${name}`);
}

const U = 'user-1';

check('stock with no movement becomes an opening movement, and is never reset to 0', () => {
  const products = [
    { id: 'A', current_stock: 10 },   // typed in, never moved
    { id: 'B', current_stock: 0 },    // nothing to record
    { id: 'C', current_stock: 5 },    // has a ledger
  ];
  const movements = [{ product_id: 'C', movement_type: 'in', quantity: 7 }];
  const openings = L.planOpeningMovements(U, products, movements);
  assert.deepEqual(openings.map((m) => [m.product_id, m.movement_type, m.quantity, m.reference]), [['A', 'in', 10, 'OPENING-A']]);
  const updates = L.planStockUpdates(products, [...movements, ...openings]);
  assert.deepEqual(updates, [{ id: 'C', stock: 7 }], 'A keeps 10, B stays 0, only C is corrected to its ledger');
});

check('a product with no ledger at all is left alone by the recount', () => {
  assert.deepEqual(L.planStockUpdates([{ id: 'A', current_stock: 10 }], []), []);
});

check('opening movements are not planned twice', () => {
  const products = [{ id: 'A', current_stock: 10 }];
  const first = L.planOpeningMovements(U, products, []);
  assert.equal(L.planOpeningMovements(U, products, first).length, 0);
});

check('negative untracked stock is recorded as an out movement', () => {
  const [m] = L.planOpeningMovements(U, [{ id: 'A', current_stock: -3 }], []);
  assert.equal(m.movement_type, 'out');
  assert.equal(m.quantity, 3);
});

check('an open purchase order with tracked lines books nothing into stock', () => {
  const purchases = [
    { id: 1, bill_number: 'PO-1', amount: 165000, items: [{ description: 'Frame', qty: 50 }] },
    { id: 2, bill_number: 'BILL-9', amount: 900 }, // a plain bill, no tracked lines
  ];
  const lines = [{ id: 'L1', purchase_id: 1, product_id: 'FRAME', quantity: 50, received_quantity: null }];
  const r = L.planPurchaseReceipts(U, purchases, lines, []);
  assert.deepEqual(r.receiptMovements, []);
  assert.deepEqual(r.tracked.map((p) => p.id), [1]);
  assert.deepEqual(r.legacy.map((p) => p.id), [2], 'only the untracked bill uses the legacy backfill');
});

check('received quantities on tracked lines are booked once, and partial receipts book the difference', () => {
  const purchases = [{ id: 1, bill_number: 'PO-1' }];
  let lines = [{ id: 'L1', purchase_id: 1, product_id: 'FRAME', unit_price: 3300, received_quantity: 20 }];
  const first = L.planPurchaseReceipts(U, purchases, lines, []).receiptMovements;
  assert.deepEqual(first.map((m) => [m.product_id, m.quantity, m.reference]), [['FRAME', 20, 'PLI-L1']]);
  assert.equal(L.planPurchaseReceipts(U, purchases, lines, first).receiptMovements.length, 0, 'idempotent');
  lines = [{ ...lines[0], received_quantity: 50 }];
  const more = L.planPurchaseReceipts(U, purchases, lines, first).receiptMovements;
  assert.deepEqual(more.map((m) => m.quantity), [30]);
});

check('a tracked line not yet matched to a product books nothing', () => {
  const r = L.planPurchaseReceipts(U, [{ id: 1 }], [{ id: 'L1', purchase_id: 1, product_id: null, received_quantity: 5 }], []);
  assert.equal(r.receiptMovements.length, 0);
  assert.equal(r.legacy.length, 0);
});

console.log(`\n${passed} checks passed`);
