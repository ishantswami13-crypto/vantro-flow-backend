// FILE: tests/fixtures/meridianTrading.js
// Second, independent pilot dataset: Meridian Trading Co (invented), a
// distributor of lighting goods that resells panels, cable and drivers and
// sells one kit (10 panels + 10 drivers). Delivered as the four CSV exports
// a customer would upload. Dates are relative to `asOfDay`. Every name is
// invented. Expected results are worked out by hand at the bottom,
// independently of the planner and of tests/fixtures/realPilot.js.

const { plus } = require('./realPilot');

const toCsv = (rows) => Buffer.from(rows.map((r) => r.map((c) => (/[,"]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : String(c))).join(',')).join('\r\n') + '\r\n');

function productsCsv() {
  return toCsv([
    ['Item Code', 'Description', 'UOM', 'Closing Qty', 'Sale Rate'],
    ['LED-40W', 'LED Panel 40W', 'pcs', '120', '1,250.50'],
    ['DRV-24V', 'LED Driver 24V', 'pcs', '0', '480'],
    ['CBL-2.5', 'Cable 2.5mm', 'm', '1000.5', '32.75'],
    ['KIT-OFF', 'Office Lighting Kit', 'kit', '0', '15000'],
    ['LED-40W', 'LED Panel 40W duplicate', 'pcs', '5', '1'], // refused: same SKU, different values
  ]);
}
const PRODUCT_OPTIONS = { mapping: { sku: 'Item Code', product_name: 'Description', unit: 'UOM', on_hand: 'Closing Qty', unit_price: 'Sale Rate' }, sourceSystem: 'Busy export' };

function componentsCsv() {
  return toCsv([['Kit SKU', 'Part SKU', 'Qty'], ['KIT-OFF', 'LED-40W', '10'], ['KIT-OFF', 'DRV-24V', '10']]);
}
const COMPONENT_OPTIONS = { mapping: { finished_sku: 'Kit SKU', component_sku: 'Part SKU', quantity_per_unit: 'Qty' }, sourceSystem: 'Busy export' };

function purchaseCsv(asOfDay, { panelEta = 4 } = {}) {
  const d = (n) => plus(asOfDay, n);
  return toCsv([
    ['PO', 'Ln', 'Supplier', 'Item Code', 'Ordered', 'Received', 'ETA', 'Rate', 'Ccy'],
    ['PO-A1', '1', 'Lumen Imports', 'LED-40W', '300', '0', d(panelEta), '900', 'INR'],
    ['PO-A2', '1', 'Volta Components', 'DRV-24V', '200', '50', d(3), '300', 'INR'],
    ['PO-A3', '1', 'Lumen Imports', 'CBL-2.5', '500', '', d(10), '20', 'INR'],
    ['PO-A4', '1', 'Lumen Imports', 'LED-40W', '-5', '', d(10), '20', 'INR'], // refused: negative
  ]);
}
const PURCHASE_OPTIONS = { mapping: { po_ref: 'PO', line_ref: 'Ln', supplier_name: 'Supplier', sku: 'Item Code', quantity: 'Ordered', received_quantity: 'Received', expected_date: 'ETA', unit_cost: 'Rate', currency: 'Ccy' }, sourceSystem: 'Busy export', stockFollows: 'STARLANE' };

function ordersCsv(asOfDay, { so102Due = 6 } = {}) {
  const d = (n) => plus(asOfDay, n);
  return toCsv([
    ['SO', 'Ln', 'Party', 'Item Code', 'Qty', 'Pending', 'Rate', 'Ccy', 'Due'],
    ['SO-106', '1', 'Kiran Electricals', 'LED-40W', '10', '10', '1,250.50', 'INR', d(-2)],
    ['SO-101', '1', 'Kiran Electricals', 'LED-40W', '100', '100', '1,250.50', 'INR', d(2)],
    ['SO-102', '1', 'Pioneer Builders', 'LED-40W', '150', '150', '1,250.50', 'INR', d(so102Due)],
    ['SO-103', '1', 'Sai Contractors', 'KIT-OFF', '5', '5', '15000', 'INR', d(7)],
    ['SO-104', '1', 'Orion Hotels', 'LED-40W', '40', '40', '15.00', 'USD', d(20)],
    ['SO-105', '1', 'Metro Mall', 'CBL-2.5', '250.25', '250.25', '32.75', 'INR', d(1)],
  ]);
}
const ORDER_OPTIONS = { mapping: { order_ref: 'SO', line_ref: 'Ln', customer_name: 'Party', sku: 'Item Code', quantity: 'Qty', outstanding_quantity: 'Pending', unit_price: 'Rate', currency: 'Ccy', promised_date: 'Due' }, sourceSystem: 'Busy export' };

// Hand-worked plan (day 0 = asOf). Supply: panels 120 on hand + 300 at +4
// (PO-A1); drivers 0 on hand + 150 outstanding at +3 (50 of 200 were received
// before import and are not stock); cable 1000.5 m on hand. Earliest promise first:
//   SO-106  10 panels  (-2): on hand, ready today -> late (already at risk)
//   SO-105  250.25 m   (+1): on hand -> on time
//   SO-101 100 panels  (+2): on hand (10 left) -> on time
//   SO-102 150 panels  (+6): 10 on hand + 140 at +4 -> on time
//   SO-103   5 kits    (+7): 50 panels at +4, 50 drivers at +3 -> on time
//   SO-104  40 panels (+20, USD): at +4 -> on time
// Lumen Imports moves PO-A1 from +4 to +9 (5 days):
//   SO-102 ready +9 > +6 -> at risk, 3 days late, needs 140 from the shipment
//   SO-103 ready +9 > +7 -> at risk, 2 days late, needs 50
//   value at risk (INR) = 150 x 1,250.50 + 5 x 15,000 = 1,87,575 + 75,000 = 2,62,575
// 150 panels received today: 270 on hand, 150 still due at +9.
//   SO-106 10, SO-101 100, SO-102 150 from stock (10 left) -> on time
//   SO-103 50 panels = 10 on hand + 40 at +9 -> still 2 days late
//   value at risk = 5 x 15,000 = 75,000 (Sai Contractors only)
// The remaining 150 received: 420 on hand, PO-A1 closed -> nothing at risk.
// If instead Lumen moves the remaining 150 again, to +11: SO-103 ready +11, 4 days late.
const EXPECTED = {
  afterDelay: { atRisk: { 'Pioneer Builders': 3, 'Sai Contractors': 2 }, valueAtRisk: 262575, units: 190, delayDays: 5, drafts: 2 },
  afterPartialReceipt: { atRisk: { 'Sai Contractors': 2 }, valueAtRisk: 75000, drafts: 1 },
  afterSecondDelay: { atRisk: { 'Sai Contractors': 4 } },
  panelStock: { start: 120, afterPartial: 270, afterFull: 420 },
};

module.exports = { productsCsv, componentsCsv, purchaseCsv, ordersCsv, PRODUCT_OPTIONS, COMPONENT_OPTIONS, PURCHASE_OPTIONS, ORDER_OPTIONS, EXPECTED };
