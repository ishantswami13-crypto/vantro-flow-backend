// FILE: tests/fixtures/realPilot.js
// A realistic pilot dataset, delivered the way a customer would deliver it:
// a product master already in Starlane (typed in, no stock movements), plus
// an orders export (XLSX) and an open purchase-order export (CSV) from their
// own systems. Every name is invented. Dates are relative to `asOfDay`.
//
//   Nirmal Pumps assembles Pump A1 (1 motor + 1 impeller each) and resells
//   valves. Motors come from Volt Motors (PO-901: 50 ordered, 10 already
//   received in Zoho, 40 due in 5 days). Impellers from Ferro Castings
//   (PO-905: 50 due in 20 days).
//
//   Expected results are worked out by hand below the data, independently of
//   the planner, and asserted exactly by tests/operations.realData.test.js.

const XLSX = require('xlsx');

function plus(asOfDay, n) {
  return new Date(Date.parse(`${asOfDay}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}

async function seedProductMaster(db, userId) {
  const ins = async (name, sku, stock, price, category) => (await db.query(
    `INSERT INTO products (user_id, name, sku, unit_price, unit, current_stock, category) VALUES ($1,$2,$3,$4,'pcs',$5,$6) RETURNING id`,
    [userId, name, sku, price, stock, category]
  )).rows[0].id;
  const P = {
    motor: await ins('Motor 1HP', 'MTR-1HP', 4, null, 'component'),
    impeller: await ins('Impeller SS', 'IMP-SS', 30, null, 'component'),
    pump: await ins('Pump A1', 'PMP-A1', 0, 9000, 'finished'),
    valve: await ins('Valve 25mm', 'VLV-25', 40, 400, 'resale'),
    seal: await ins('Seal kit', 'SEAL-K', 0, 150, 'resale'),
    gasketRed: await ins('Gasket Red', 'GSK-1', 0, 20, 'resale'),
    gasketBlack: await ins('Gasket Black', 'GSK-1', 0, 20, 'resale'),
  };
  await db.query(
    `INSERT INTO product_components (user_id, finished_product_id, component_product_id, quantity_per_unit) VALUES ($1,$2,$3,1), ($1,$2,$4,1)`,
    [userId, P.pump, P.motor, P.impeller]
  );
  return P;
}

const toCsv = (rows) => Buffer.from(rows.map((r) => r.map((c) => (/[,"]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : String(c))).join(',')).join('\r\n') + '\r\n');

// The same product master as seedProductMaster, the way a customer would
// export it, with three rows the import must refuse: a second product on an
// existing SKU, a new product with no stock stated, and a negative stock.
function productsCsv() {
  return toCsv([
    ['SKU', 'Item Name', 'Unit', 'Category', 'Stock On Hand', 'Selling Price'],
    ['MTR-1HP', 'Motor 1HP', 'pcs', 'component', '4', ''],
    ['IMP-SS', 'Impeller SS', 'pcs', 'component', '30', ''],
    ['PMP-A1', 'Pump A1', 'pcs', 'finished', '0', '9,000.00'],
    ['VLV-25', 'Valve 25mm', 'pcs', 'resale', '40', '400'],
    ['SEAL-K', 'Seal kit', 'pcs', 'resale', '0', '150'],
    ['GSK-1', 'Gasket Red', 'pcs', 'resale', '0', '20'],
    ['GSK-1', 'Gasket Black', 'pcs', 'resale', '0', '20'],
    ['CPL-9', 'Coupling 2in', 'pcs', 'resale', '', '120'],
    ['BRK-3', 'Bracket', 'pcs', 'component', '-5', ''],
  ]);
}
const PRODUCT_MAPPING = { sku: 'SKU', product_name: 'Item Name', unit: 'Unit', category: 'Category', on_hand: 'Stock On Hand', unit_price: 'Selling Price' };

// Pump A1 = 1 motor + 1 impeller. The nut is not in the product master.
function componentsCsv() {
  return toCsv([
    ['Finished SKU', 'Finished Product', 'Component SKU', 'Component', 'Qty Per Unit'],
    ['PMP-A1', 'Pump A1', 'MTR-1HP', 'Motor 1HP', '1'],
    ['PMP-A1', 'Pump A1', 'IMP-SS', 'Impeller SS', '1'],
    ['PMP-A1', 'Pump A1', 'NUT-8', 'Nut M8', '4'],
  ]);
}
const COMPONENT_MAPPING = { finished_sku: 'Finished SKU', finished_name: 'Finished Product', component_sku: 'Component SKU', component_name: 'Component', quantity_per_unit: 'Qty Per Unit' };

function purchaseCsv(asOfDay, overrides = {}) {
  const d = (n) => plus(asOfDay, n);
  const rows = [
    ['PO No', 'Line', 'Vendor', 'GSTIN', 'Item Code', 'Item Name', 'Ordered Qty', 'Received Qty', 'Expected Date', 'PO Date', 'Rate', 'Currency'],
    ['PO-901', '1', 'Volt Motors Pvt Ltd', '27AAACV1234F1Z5', 'MTR-1HP', 'Motor 1HP', '50', '10', d(5), d(-15), '4,200.00', 'INR'],
    ['PO-901', '2', 'Volt Motors Pvt Ltd', '27AAACV1234F1Z5', 'SEAL-K', 'Seal kit', '20', '0', d(3), d(-15), '150', 'INR'],
    ['PO-905', '1', 'Ferro Castings', '', 'IMP-SS', 'Impeller SS', '50', '', overrides.impellerDate || d(20), d(-6), '800', 'INR'],
    ['PO-906', '1', 'Ferro Castings', '', 'GSK-1', 'Gasket', '100', '', d(2), d(-6), '20', 'INR'],
    ['PO-907', '1', 'Ferro Castings', '', 'UNK-9', 'Unknown part', '5', '', d(2), d(-6), '90', 'INR'],
    ['PO-908', '1', 'Volt Motors Pvt Ltd', '27AAACV1234F1Z5', 'MTR-1HP', 'Motor 1HP', '10', '12', d(9), d(-2), '4200', 'INR'],
    ['PO-909', '1', 'Ferro Castings', '', 'VLV-25', 'Valve 25mm', 'abc', '', d(9), d(-2), '300', 'INR'],
    ['PO-910', '1', 'Ferro Castings', '', 'VLV-25', 'Valve 25mm', '10', '', '2026-02-31', d(-2), '300', 'INR'],
    ['PO-777', '1', 'Volt Motors Pvt Ltd', '27AAACV1234F1Z5', 'MTR-1HP', 'Motor 1HP', '5', '', d(9), d(-2), '4200', 'INR'],
  ];
  if (overrides.dropLine) rows.splice(rows.findIndex((r) => r[0] === overrides.dropLine), 1);
  return Buffer.from(rows.map((r) => r.map((c) => (/[,"]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\r\n') + '\r\n');
}

const PURCHASE_MAPPING = {
  po_ref: 'PO No', line_ref: 'Line', supplier_name: 'Vendor', supplier_tax_id: 'GSTIN', sku: 'Item Code', product_name: 'Item Name',
  quantity: 'Ordered Qty', received_quantity: 'Received Qty', expected_date: 'Expected Date', purchase_date: 'PO Date', unit_cost: 'Rate', currency: 'Currency',
};

function ordersXlsx(asOfDay, overrides = {}) {
  const d = (n) => plus(asOfDay, n);
  const rows = [
    ['Order No', 'Line', 'Customer', 'Item Code', 'Item', 'Ordered Qty', 'Pending Qty', 'Rate', 'Currency', 'Order Date', 'Promised Date', 'Status'],
    ['SO-1', 1, 'Arora Agro', 'PMP-A1', 'Pump A1', 10, 10, 9000, 'INR', d(-10), d(6), 'Confirmed'],
    ['SO-2', 1, 'Bharat Irrigation', 'PMP-A1', 'Pump A1', 20, overrides.so2Pending ?? 15, 9000, 'INR', d(-8), d(8), 'Partially delivered'],
    ['SO-3', 1, 'Coastal Farms', 'PMP-A1', 'Pump A1', 12, '', 9000, 'INR', d(-5), d(30), 'Open'],
    ['SO-4', 1, 'Delta Nurseries', 'VLV-25', 'Valve 25mm', 15, 15, 400, 'INR', d(-3), d(2), 'Confirmed'],
    ['SO-5', 1, 'Evergreen Estates', 'PMP-A1', 'Pump A1', 5, 5, 9000, 'INR', d(-20), d(-1), 'Confirmed'],
    ['SO-6', 1, 'Farmgate Co', 'PMP-A1', 'Pump A1', 8, 0, 9000, 'INR', d(-30), d(-10), 'Delivered'],
    ['SO-7', 1, 'Ganga Traders', 'PMP-A1', 'Pump A1', 3, 3, 9000, 'INR', d(-2), '', 'Confirmed'],
    ['SO-8', 1, 'Horizon Exports', 'VLV-25', 'Valve 25mm', 10, 10, 12, 'USD', d(-2), d(25), 'Confirmed'],
  ];
  const wb = XLSX.utils.book_new();
  // A title block above the header, as real exports have.
  const ws = XLSX.utils.aoa_to_sheet([['Nirmal Pumps — Open sales orders (synthetic)'], [], ...rows]);
  XLSX.utils.book_append_sheet(wb, ws, 'Orders');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

const ORDER_MAPPING = {
  order_ref: 'Order No', line_ref: 'Line', customer_name: 'Customer', sku: 'Item Code', product_name: 'Item', quantity: 'Ordered Qty',
  outstanding_quantity: 'Pending Qty', unit_price: 'Rate', currency: 'Currency', order_date: 'Order Date', promised_date: 'Promised Date', status: 'Status',
};

// Hand-worked plan (asOf = day 0). Supply: motors 4 on hand + 40 inbound at
// +5; impellers 30 on hand + 50 at +20; valves 40 on hand. Earliest promise first:
//   SO-5  5 pumps  (-1): 4 motors on hand + 1 inbound -> ready +5, LATE
//   SO-4 15 valves (+2): on hand -> ON_TIME
//   SO-1 10 pumps  (+6): motors inbound +5 -> ON_TIME
//   SO-2 15 pumps  (+8, 15 still pending of 20): inbound +5 -> ON_TIME
//   SO-8 10 valves (+25): on hand -> ON_TIME
//   SO-3 12 pumps  (+30, no pending qty: 12 assumed): motors +5, impellers +20 -> ON_TIME
//   SO-7  3 pumps  (no promised date) -> UNKNOWN
// Volt Motors moves PO-901 line 1 from +5 to +12:
//   SO-5 still late (already at risk, not this delay's fault)
//   SO-1 ready +12 > +6 -> AT RISK, slips 6 days, needs 10 from the shipment
//   SO-2 ready +12 > +8 -> AT RISK, slips 4 days, needs 15 from the shipment
//   SO-3 ready +20 <= +30 -> on time
// Value at risk = 10 x 9000 + 15 x 9000 = 225,000 (pending, not ordered, qty).
// Then 20 motors are received today: 24 on hand.
//   SO-5 takes 5 (ready today, still late: promised yesterday); SO-1 takes 10
//   -> on time; SO-2 needs 15: 9 on hand + 6 of the 20 still inbound at +12
//   -> still AT RISK. Value at risk = 135,000.
// The remaining 20 are received: the line is closed, the delay decision resolves.
const EXPECTED = {
  afterDelay: { atRisk: ['Arora Agro', 'Bharat Irrigation'], alreadyAtRisk: ['Evergreen Estates'], unaffected: 3, unknown: 1, valueAtRisk: 225000, unitsNeededFromShipment: 25, delayDays: 7, slip: { 'Arora Agro': 6, 'Bharat Irrigation': 4 } },
  afterPartialReceipt: { atRisk: ['Bharat Irrigation'], valueAtRisk: 135000 },
};

module.exports = { plus, seedProductMaster, productsCsv, componentsCsv, purchaseCsv, ordersXlsx, PRODUCT_MAPPING, COMPONENT_MAPPING, PURCHASE_MAPPING, ORDER_MAPPING, EXPECTED };
