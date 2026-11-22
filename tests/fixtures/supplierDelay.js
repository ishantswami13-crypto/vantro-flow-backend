// FILE: tests/fixtures/supplierDelay.js
// Synthetic supplier-delay scenario, written into real tables for one tenant.
// Every name is invented. Dates are relative to `asOfDay` so the scenario is
// always "live" whenever it is seeded.
//
//   Kaveri Cycle Works assembles city bikes (1 frame + 2 wheels each) and
//   resells locks. Frames come from Shenzhen Frame Co (50 due in 4 days).
//
//   Open orders                    promised   expected outcome after a 15-day delay
//   Delta Sports   5 locks         +1 day     on time (no frames involved)
//   Acme Retail    8 bikes         +2 days    on time (finished stock + frames on hand)
//   Brightwater   20 bikes         +9 days    AT RISK because of the delay (needs 16 frames from the shipment)
//   Harbour        6 bikes        +12 days    AT RISK because of the delay (needs 6 frames from the shipment)
//   Echo Fleet   100 bikes        +14 days    already at risk (not enough frames even on time)
//   Cobalt        10 bikes        +45 days    on time (the shipment still arrives first)

const crypto = require('crypto');

const BIKE_PRICE = 18500;
// Open purchase orders: the supplier has billed them, and every line is still
// inbound (purchase_line_items with no received_quantity). Opening the app
// must not book them into stock (lib/domain/inventory/stockLedger.js).
const OPEN_PO_NOTE = 'Open purchase order; goods not yet received (synthetic fixture)';
const LOCK_PRICE = 900;

function plus(asOfDay, n) {
  return new Date(Date.parse(`${asOfDay}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}

async function seedSupplierDelay(db, userId, asOfDay) {
  const id = () => crypto.randomUUID();
  const P = { frame: id(), wheel: id(), bike: id(), lock: id() };
  const products = [
    [P.frame, 'Aluminium Frame 18in', 'FRM-AL-18', null, 10, 'component'],
    [P.wheel, 'Wheel 700c', 'WHL-700', null, 200, 'component'],
    [P.bike, 'City Bike C1', 'BIKE-C1', BIKE_PRICE, 2, 'finished'],
    [P.lock, 'D-Lock', 'LOCK-D', LOCK_PRICE, 100, 'resale'],
  ];
  for (const [pid, name, sku, price, stock, category] of products) {
    await db.query(
      `INSERT INTO products (id, user_id, name, sku, unit_price, unit, current_stock, category) VALUES ($1,$2,$3,$4,$5,'pcs',$6,$7)`,
      [pid, userId, name, sku, price, stock, category]
    );
    // Deliberately no stock_movements: stock typed into the product record is
    // how most owners start, and the reconcile must keep it.
  }
  await db.query(
    `INSERT INTO product_components (user_id, finished_product_id, component_product_id, quantity_per_unit) VALUES ($1,$2,$3,1), ($1,$2,$4,2)`,
    [userId, P.bike, P.frame, P.wheel]
  );

  const sup = await db.query(`INSERT INTO suppliers (user_id, name, country, currency) VALUES ($1,'Shenzhen Frame Co','CN','INR') RETURNING id`, [userId]);
  const sup2 = await db.query(`INSERT INTO suppliers (user_id, name, country, currency) VALUES ($1,'Pune Wheel Works','IN','INR') RETURNING id`, [userId]);
  await db.query(`INSERT INTO product_suppliers (user_id, product_id, supplier_id, source, evidence) VALUES ($1,$2,$3,'synthetic_fixture','synthetic'), ($1,$4,$5,'synthetic_fixture','synthetic')`,
    [userId, P.frame, sup.rows[0].id, P.wheel, sup2.rows[0].id]);

  const pu1 = await db.query(
    `INSERT INTO purchases (user_id, supplier_name, amount, status, purchase_date, bill_number, currency, notes) VALUES ($1,'Shenzhen Frame Co',165000,'unpaid',$2,'PO-7781','INR',$3) RETURNING id`,
    [userId, plus(asOfDay, -20), OPEN_PO_NOTE]
  );
  const pu2 = await db.query(
    `INSERT INTO purchases (user_id, supplier_name, amount, status, purchase_date, bill_number, currency, notes) VALUES ($1,'Pune Wheel Works',60000,'unpaid',$2,'PO-7790','INR',$3) RETURNING id`,
    [userId, plus(asOfDay, -10), OPEN_PO_NOTE]
  );
  const frameLine = await db.query(
    `INSERT INTO purchase_line_items (user_id, purchase_id, product_id, quantity, unit_price, currency, expected_at) VALUES ($1,$2,$3,50,3300,'INR',$4) RETURNING id`,
    [userId, pu1.rows[0].id, P.frame, plus(asOfDay, 4)]
  );
  const wheelLine = await db.query(
    `INSERT INTO purchase_line_items (user_id, purchase_id, product_id, quantity, unit_price, currency, expected_at) VALUES ($1,$2,$3,100,600,'INR',$4) RETURNING id`,
    [userId, pu2.rows[0].id, P.wheel, plus(asOfDay, 6)]
  );

  const orders = [
    ['Delta Sports', P.lock, 5, LOCK_PRICE, 1],
    ['Acme Retail', P.bike, 8, BIKE_PRICE, 2],
    ['Brightwater Stores', P.bike, 20, BIKE_PRICE, 9],
    ['Harbour Traders', P.bike, 6, BIKE_PRICE, 12],
    ['Echo Fleet Services', P.bike, 100, BIKE_PRICE, 14],
    ['Cobalt Rentals', P.bike, 10, BIKE_PRICE, 45],
  ];
  const byCustomer = {};
  for (const [customer, productId, qty, price, inDays] of orders) {
    const c = await db.query(`INSERT INTO customers (user_id, name) VALUES ($1,$2) RETURNING id`, [userId, customer]);
    const o = await db.query(
      `INSERT INTO orders (user_id, customer_name, items, total_amount, status, order_date, source) VALUES ($1,$2,'[]'::jsonb,$3,'confirmed',$4,'synthetic_fixture') RETURNING id`,
      [userId, customer, qty * price, plus(asOfDay, -7)]
    );
    const line = await db.query(
      `INSERT INTO order_line_items (user_id, order_id, product_id, quantity, unit_price, needed_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [userId, o.rows[0].id, productId, qty, price, plus(asOfDay, inDays)]
    );
    byCustomer[customer] = { customerId: c.rows[0].id, orderId: o.rows[0].id, orderLineId: line.rows[0].id, neededBy: plus(asOfDay, inDays), quantity: qty, value: qty * price };
  }

  return {
    products: P,
    frameLineId: frameLine.rows[0].id,
    wheelLineId: wheelLine.rows[0].id,
    frameOriginalDate: plus(asOfDay, 4),
    delayedDate: plus(asOfDay, 19),
    orders: byCustomer,
    expected: {
      atRisk: ['Brightwater Stores', 'Harbour Traders'],
      alreadyAtRisk: ['Echo Fleet Services'],
      onTime: ['Delta Sports', 'Acme Retail', 'Cobalt Rentals'],
      valueAtRisk: 26 * BIKE_PRICE,
      unitsNeededFromShipment: 22,
    },
  };
}

// purchases/products/orders etc. reference users without ON DELETE CASCADE
// on some schemas; delete children explicitly before the tenant.
async function deleteSupplierDelayData(db, userId) {
  for (const t of ['stock_movements', 'order_line_items', 'orders', 'purchase_line_items', 'purchases', 'product_suppliers', 'product_components', 'products', 'suppliers', 'customers']) {
    await db.query(`DELETE FROM ${t} WHERE user_id = $1`, [userId]).catch(() => {});
  }
}

module.exports = { seedSupplierDelay, deleteSupplierDelayData, plus, BIKE_PRICE };
