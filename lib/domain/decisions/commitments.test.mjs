// Pure tests for lib/domain/decisions/commitments.js (no database).
// Run: node lib/domain/decisions/commitments.test.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { expandBom, planFulfilment, assessSupplierDelay } = require('./commitments.js');

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`ok ${name}`);
}

const asOfDay = '2026-12-01';
// Synthetic trading/assembly business:
//   FRAME (component) 10 on hand; inbound PL-1: 50 frames, was due 12-05, now 12-20.
//   BIKE  (built from 1 FRAME + 2 WHEEL) 2 finished on hand.
//   WHEEL 200 on hand (never short).
//   LOCK  (bought and resold, no BOM) 100 on hand — unrelated to the delay.
const bom = [
  { finished_product_id: 'BIKE', component_product_id: 'FRAME', quantity_per_unit: 1 },
  { finished_product_id: 'BIKE', component_product_id: 'WHEEL', quantity_per_unit: 2 },
];
const stock = [
  { productId: 'FRAME', onHand: 10 },
  { productId: 'BIKE', onHand: 2 },
  { productId: 'WHEEL', onHand: 200 },
  { productId: 'LOCK', onHand: 100 },
];
const delayedLine = { purchaseLineId: 'PL-1', productId: 'FRAME', quantity: 50, receivedQuantity: 0, originalExpectedAt: '2026-12-05', expectedAt: '2026-12-20' };
const inbound = [delayedLine];
const orderLines = [
  { orderId: 'O1', customerName: 'Acme', productId: 'BIKE', quantity: 8, unitPrice: 1000, neededBy: '2026-12-03' },   // 2 finished + 6 frames on hand
  { orderId: 'O2', customerName: 'Brightwater', productId: 'BIKE', quantity: 20, unitPrice: 1000, neededBy: '2026-12-10' }, // 4 on hand + 16 from PL-1
  { orderId: 'O5', customerName: 'Echo', productId: 'BIKE', quantity: 100, unitPrice: 1000, neededBy: '2026-12-15' },  // cannot be covered at all
  { orderId: 'O3', customerName: 'Cobalt', productId: 'BIKE', quantity: 10, unitPrice: 1000, neededBy: '2027-01-15' }, // after the new date
  { orderId: 'O4', customerName: 'Delta', productId: 'LOCK', quantity: 5, unitPrice: 300, neededBy: '2026-12-02' },
  { orderId: 'O6', customerName: 'Foxtrot', productId: 'BIKE', quantity: 1, unitPrice: 1000, neededBy: null },
];

check('expandBom resolves leaf requirements and treats a BOM-less product as its own leaf', () => {
  assert.deepEqual(Object.fromEntries(expandBom('BIKE', bom)), { FRAME: 1, WHEEL: 2 });
  assert.deepEqual(Object.fromEntries(expandBom('LOCK', bom)), { LOCK: 1 });
  const nested = [...bom, { finished_product_id: 'FRAME', component_product_id: 'TUBE', quantity_per_unit: 3 }];
  assert.deepEqual(Object.fromEntries(expandBom('BIKE', nested)), { TUBE: 3, WHEEL: 2 });
  assert.throws(() => expandBom('A', [{ finished_product_id: 'A', component_product_id: 'B', quantity_per_unit: 1 }, { finished_product_id: 'B', component_product_id: 'A', quantity_per_unit: 1 }]), /cycle/);
});

check('planFulfilment allocates earliest promise first and is all-or-nothing per line', () => {
  const plan = planFulfilment({ asOfDay, orderLines, stock, inbound, bom });
  const by = Object.fromEntries(plan.map((l) => [l.orderId, l]));
  assert.equal(by.O1.status, 'ON_TIME');
  assert.equal(by.O1.readyAt, asOfDay);
  assert.equal(by.O2.status, 'LATE');
  assert.equal(by.O2.readyAt, '2026-12-20');
  assert.equal(by.O2.slipDays, 10);
  assert.equal(by.O2.fromPurchaseLines['PL-1'], 16);
  assert.equal(by.O5.status, 'NOT_COVERED');
  assert.equal(by.O5.readyAt, null);
  // O5 reserved nothing, so O3 still gets its 10 frames from PL-1.
  assert.equal(by.O3.status, 'ON_TIME');
  assert.equal(by.O3.readyAt, '2026-12-20');
  assert.equal(by.O4.status, 'ON_TIME');
  assert.equal(by.O6.status, 'UNKNOWN');
});

check('assessSupplierDelay separates orders the delay put at risk from ones already at risk', () => {
  const a = assessSupplierDelay({ asOfDay, delayedLine, orderLines, stock, inbound, bom });
  assert.equal(a.sufficientData, true);
  assert.equal(a.delayDays, 15);
  const cls = Object.fromEntries(a.lines.map((l) => [l.orderId, l.classification]));
  assert.deepEqual(cls, { O1: 'ON_TIME', O2: 'AT_RISK_FROM_DELAY', O5: 'ALREADY_AT_RISK', O3: 'ON_TIME', O4: 'ON_TIME', O6: 'UNKNOWN' });
  assert.deepEqual(a.atRisk.map((l) => l.orderId), ['O2']);
  const o2 = a.atRisk[0];
  assert.equal(o2.plannedReadyAt, '2026-12-05');
  assert.equal(o2.readyAt, '2026-12-20');
  assert.equal(o2.slipDays, 10);
  assert.equal(o2.dependsOnDelayedShipment, 16);
  assert.equal(a.valueAtRisk, 20000, 'exactly the value of the one order the delay pushed past its date');
  assert.equal(a.unitsNeededFromShipment, 16);
  assert.equal(a.earliestAtRiskNeededBy, '2026-12-10');
});

check('a delay that stock absorbs puts nothing at risk', () => {
  const a = assessSupplierDelay({ asOfDay, delayedLine, orderLines: [orderLines[0], orderLines[4]], stock, inbound, bom });
  assert.equal(a.atRisk.length, 0);
  assert.equal(a.valueAtRisk, 0);
});

check('partially received shipments only count what is still to come', () => {
  const half = { ...delayedLine, receivedQuantity: 40 }; // 10 still inbound
  const a = assessSupplierDelay({ asOfDay, delayedLine: half, orderLines: [orderLines[1]], stock, inbound: [half], bom });
  // 2 finished + 10 frames on hand + 10 inbound = 22 >= 20, ready on the inbound date.
  assert.equal(a.lines[0].plannedReadyAt, '2026-12-05');
  assert.equal(a.lines[0].classification, 'AT_RISK_FROM_DELAY');
});

check('missing dates are reported, never guessed', () => {
  const a = assessSupplierDelay({ asOfDay, delayedLine: { ...delayedLine, originalExpectedAt: null }, orderLines, stock, inbound, bom });
  assert.equal(a.sufficientData, false);
  assert.match(a.reason, /original or current expected date/);
});

console.log(`commitments: ${passed} checks passed`);
