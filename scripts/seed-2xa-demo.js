// FILE: scripts/seed-2xa-demo.js
// 2xA vertical-slice demo tenant seed. Follows the exact house style of
// scripts/seed-demo-tenant.js: raw pg Client, randomUUID, real INSERTs, and
// an honest report object built from real query results — never fabricated
// narrative. Fully repeatable: run multiple times, it wipes and recreates
// only rows under its own demo email domain, never touching other tenants.
//
// Scenario: "Meridian Cycles" — a mid-size bicycle manufacturer.
//   Suppliers: 5 across countries (CN, IN, DE, US, VN)
//   Components: 10 (frames, wheels, brakes, gears, etc.)
//   Finished products: 5 (bike models), each with a real BOM
//   Customers/orders: 6 customers, several open orders referencing components
//   Disruption: earthquake in China (Sichuan) -> disrupts the CN supplier's
//     aluminum-frame component -> traces through BOM to 2 of 5 bike models
//   Negative controls (must NOT be flagged as impacted):
//     - a supplier in Germany (unrelated to the China event)
//     - a finished product with zero dependency on the disrupted component
//     - a customer/order for that unrelated product
//
// Usage: node scripts/seed-2xa-demo.js
require('dotenv').config();
const { Client } = require('pg');
const { randomUUID } = require('crypto');

const DEMO_EMAIL_DOMAIN = '2xa-demo-meridian.invalid';

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required (real local dev instance) — refusing to run without it.');
  }
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  const report = { createdAt: new Date().toISOString() };

  try {
    // ── Wipe any prior run of this specific demo tenant (idempotent reset) ──
    const existing = await client.query(`SELECT id FROM users WHERE email LIKE $1`, [`%@${DEMO_EMAIL_DOMAIN}`]);
    for (const row of existing.rows) {
      await client.query(`DELETE FROM users WHERE id = $1`, [row.id]); // ON DELETE CASCADE covers the rest
    }
    report.wipedPriorUsers = existing.rows.length;

    // ── Tenant ────────────────────────────────────────────────────────────
    const userId = randomUUID();
    const email = `owner@${DEMO_EMAIL_DOMAIN}`;
    await client.query(
      `INSERT INTO users (id, email, business_name, plan, password_hash, phone, owner_name, created_at)
       VALUES ($1, $2, 'Meridian Cycles', 'free', 'x-not-a-real-hash', '9990002222', 'Demo Owner', NOW())`,
      [userId, email]
    );
    report.userId = userId;
    report.businessName = 'Meridian Cycles';
    console.log(`Created demo tenant: ${userId} (${email})`);

    // ── Suppliers (5 countries) ──────────────────────────────────────────
    const { createExposure, verifyExposure } = require('../lib/world/exposureRegistry');
    async function makeSupplier(name, country) {
      const id = randomUUID();
      await client.query(
        `INSERT INTO suppliers (id, user_id, name, is_active, created_at, updated_at, country)
         VALUES ($1, $2, $3, true, NOW(), NOW(), $4)`,
        [id, userId, name, country]
      );
      const exposure = await createExposure(userId, {
        businessEntityType: 'supplier',
        businessEntityId: id,
        exposureType: 'LOCATED_IN',
        rawValue: country,
        kind: 'country',
        truthState: 'OBSERVED',
        confidence: 0.9,
        provenanceType: 'OWNER_ENTERED',
        sourceOfFact: 'owner_recorded',
        evidenceNotes: `2xA demo seed: owner-recorded supplier country for ${name}.`,
        validFrom: '2015-01-01T00:00:00Z',
      });
      await verifyExposure(userId, exposure.id, { verifiedByUserId: userId });
      return id;
    }
    const supplierCN = await makeSupplier('Sichuan Alloy Works', 'CN');   // the one that gets hit
    const supplierIN = await makeSupplier('Pune Precision Components', 'IN');
    const supplierDE = await makeSupplier('Rhein Gear Systems', 'DE');    // negative control
    const supplierUS = await makeSupplier('Ohio Rubber & Tire', 'US');
    const supplierVN = await makeSupplier('Mekong Alloy Alternate', 'VN'); // alternate source for the CN component
    report.suppliers = { supplierCN, supplierIN, supplierDE, supplierUS, supplierVN };

    // ── Components (products acting as raw materials) ───────────────────
    async function makeComponent(name, sku, supplierId, { leadTimeDays, currentStock, avgDailyDemand, safetyStock, isAlternateForId = null } = {}) {
      const id = randomUUID();
      await client.query(
        `INSERT INTO products (id, user_id, name, sku, unit, current_stock, low_stock_alert, category, created_at, updated_at, lead_time_days, safety_stock, avg_daily_demand, is_alternate_for_id)
         VALUES ($1,$2,$3,$4,'unit',$5,$6,'component',NOW(),NOW(),$7,$8,$9,$10)`,
        [id, userId, name, sku, currentStock, Math.max(1, Math.round((safetyStock || 0) * 0.5)), leadTimeDays, safetyStock, avgDailyDemand, isAlternateForId]
      );
      if (supplierId) {
        await client.query(
          `INSERT INTO product_suppliers (id, user_id, product_id, supplier_id, source, first_seen_at, last_seen_at)
           VALUES ($1,$2,$3,$4,'owner_recorded',NOW(),NOW())`,
          [randomUUID(), userId, id, supplierId]
        );
      }
      // The app's existing auto-reconcile (server.js ensureConnectedBusinessData,
      // step "RECALCULATE STOCK") recomputes every product's current_stock from
      // the sum of its stock_movements on every /api/auth/me call — a real,
      // pre-existing production behavior, not something this seed can opt out
      // of. Without a matching movement row, that reconciliation would zero out
      // the current_stock we just set the moment anyone loads the app.
      if (currentStock) {
        await client.query(
          `INSERT INTO stock_movements (id, user_id, product_id, movement_type, quantity, reference, notes, moved_at)
           VALUES ($1,$2,$3,'in',$4,'2xa-demo-seed',$5,NOW())`,
          [randomUUID(), userId, id, currentStock, `Initial stock for demo seed: ${name}`]
        );
      }
      return id;
    }
    const compFrameAlloy = await makeComponent('Aluminum Frame Alloy Tube Set', 'CMP-FRAME-AL', supplierCN, { leadTimeDays: 35, currentStock: 400, avgDailyDemand: 20, safetyStock: 150 });
    const compFrameAlloyAlt = await makeComponent('Aluminum Frame Alloy (Alt Source)', 'CMP-FRAME-AL-ALT', supplierVN, { leadTimeDays: 42, currentStock: 60, avgDailyDemand: 0, safetyStock: 0, isAlternateForId: compFrameAlloy });
    const compWheelHub = await makeComponent('Precision Wheel Hub', 'CMP-HUB', supplierIN, { leadTimeDays: 18, currentStock: 900, avgDailyDemand: 30, safetyStock: 200 });
    const compBrakeCaliper = await makeComponent('Hydraulic Brake Caliper', 'CMP-BRAKE', supplierDE, { leadTimeDays: 25, currentStock: 500, avgDailyDemand: 22, safetyStock: 150 });
    const compGearSet = await makeComponent('9-Speed Gear Set', 'CMP-GEAR', supplierDE, { leadTimeDays: 28, currentStock: 300, avgDailyDemand: 15, safetyStock: 100 });
    const compTire = await makeComponent('All-Terrain Tire', 'CMP-TIRE', supplierUS, { leadTimeDays: 14, currentStock: 1200, avgDailyDemand: 60, safetyStock: 300 });
    const compSteelFrame = await makeComponent('Steel Frame Tube Set', 'CMP-FRAME-STEEL', supplierIN, { leadTimeDays: 20, currentStock: 700, avgDailyDemand: 18, safetyStock: 150 });
    const compSaddle = await makeComponent('Comfort Saddle', 'CMP-SADDLE', supplierUS, { leadTimeDays: 10, currentStock: 800, avgDailyDemand: 25, safetyStock: 150 });
    const compChain = await makeComponent('Reinforced Chain', 'CMP-CHAIN', supplierIN, { leadTimeDays: 12, currentStock: 1000, avgDailyDemand: 40, safetyStock: 250 });
    const compHandlebar = await makeComponent('Alloy Handlebar', 'CMP-BAR', supplierDE, { leadTimeDays: 20, currentStock: 600, avgDailyDemand: 20, safetyStock: 150 });
    report.components = { compFrameAlloy, compFrameAlloyAlt, compWheelHub, compBrakeCaliper, compGearSet, compTire, compSteelFrame, compSaddle, compChain, compHandlebar };

    // ── Finished products with real BOM (product_components) ────────────
    async function makeFinished(name, sku, price, bom) {
      const id = randomUUID();
      await client.query(
        `INSERT INTO products (id, user_id, name, sku, unit_price, unit, current_stock, low_stock_alert, category, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,'unit',0,5,'finished_good',NOW(),NOW())`,
        [id, userId, name, sku, price]
      );
      for (const [componentId, qty] of bom) {
        await client.query(
          `INSERT INTO product_components (id, user_id, finished_product_id, component_product_id, quantity_per_unit)
           VALUES ($1,$2,$3,$4,$5)`,
          [randomUUID(), userId, id, componentId, qty]
        );
      }
      return id;
    }
    // Uses the disrupted aluminum frame -> WILL be flagged.
    const bikeAlloyRoad = await makeFinished('Meridian Alloy Road', 'BIKE-ALLOY-ROAD', 45000, [
      [compFrameAlloy, 1], [compWheelHub, 2], [compBrakeCaliper, 2], [compGearSet, 1], [compTire, 2], [compChain, 1], [compHandlebar, 1], [compSaddle, 1],
    ]);
    const bikeAlloyGravel = await makeFinished('Meridian Alloy Gravel', 'BIKE-ALLOY-GRAVEL', 52000, [
      [compFrameAlloy, 1], [compWheelHub, 2], [compBrakeCaliper, 2], [compGearSet, 1], [compTire, 2], [compChain, 1], [compHandlebar, 1], [compSaddle, 1],
    ]);
    // Steel-frame line — NEGATIVE CONTROL: does not consume the disrupted component at all.
    const bikeSteelCommuter = await makeFinished('Meridian Steel Commuter', 'BIKE-STEEL-COMMUTER', 28000, [
      [compSteelFrame, 1], [compWheelHub, 2], [compBrakeCaliper, 2], [compTire, 2], [compChain, 1], [compHandlebar, 1], [compSaddle, 1],
    ]);
    const bikeSteelCargo = await makeFinished('Meridian Steel Cargo', 'BIKE-STEEL-CARGO', 34000, [
      [compSteelFrame, 2], [compWheelHub, 2], [compBrakeCaliper, 2], [compTire, 2], [compChain, 1], [compHandlebar, 1], [compSaddle, 1],
    ]);
    const bikeKidsSteel = await makeFinished('Meridian Kids Steel 20"', 'BIKE-KIDS-STEEL', 12000, [
      [compSteelFrame, 1], [compWheelHub, 2], [compTire, 2], [compChain, 1], [compHandlebar, 1], [compSaddle, 1],
    ]);
    report.finishedProducts = { bikeAlloyRoad, bikeAlloyGravel, bikeSteelCommuter, bikeSteelCargo, bikeKidsSteel };

    // ── Customers and orders with order_line_items ───────────────────────
    async function makeCustomer(name) {
      const id = randomUUID();
      await client.query(
        `INSERT INTO customers (id, user_id, name, is_active, created_at, updated_at) VALUES ($1,$2,$3,true,NOW(),NOW())`,
        [id, userId, name]
      );
      return id;
    }
    async function makeOrder(customerName, lines) {
      const orderId = randomUUID();
      const total = lines.reduce((s, l) => s + l.qty * l.price, 0);
      await client.query(
        `INSERT INTO orders (id, user_id, customer_name, items, total_amount, status, order_date, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,'confirmed',CURRENT_DATE,NOW(),NOW())`,
        [orderId, userId, customerName, JSON.stringify(lines.map((l) => ({ product_id: l.productId, quantity: l.qty, unit_price: l.price }))), total]
      );
      for (const l of lines) {
        await client.query(
          `INSERT INTO order_line_items (id, user_id, order_id, product_id, quantity, unit_price, needed_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [randomUUID(), userId, orderId, l.productId, l.qty, l.price, l.neededBy || null]
        );
      }
      return orderId;
    }
    const custVelo = await makeCustomer('VeloMart Retail Group');
    const custTrail = await makeCustomer('TrailBlend Distributors');
    const custUrban = await makeCustomer('Urban Cycle Co-op');       // negative control customer (steel only)
    const custSchool = await makeCustomer('Riverside School District'); // negative control (kids bikes only)
    const custRegion = await makeCustomer('Coastal Bike Rentals');
    const custExport = await makeCustomer('Alpine Export Partners');

    const orderAffected1 = await makeOrder('VeloMart Retail Group', [{ productId: bikeAlloyRoad, qty: 40, price: 45000, neededBy: '2026-10-15' }]);
    const orderAffected2 = await makeOrder('TrailBlend Distributors', [{ productId: bikeAlloyGravel, qty: 25, price: 52000, neededBy: '2026-10-20' }]);
    const orderAffected3 = await makeOrder('Coastal Bike Rentals', [{ productId: bikeAlloyRoad, qty: 10, price: 45000, neededBy: '2026-11-01' }]);
    const orderSafeSteel1 = await makeOrder('Urban Cycle Co-op', [{ productId: bikeSteelCommuter, qty: 30, price: 28000, neededBy: '2026-10-10' }]);
    const orderSafeSteel2 = await makeOrder('Riverside School District', [{ productId: bikeKidsSteel, qty: 60, price: 12000, neededBy: '2026-10-25' }]);
    const orderSafeMixed = await makeOrder('Alpine Export Partners', [{ productId: bikeSteelCargo, qty: 15, price: 34000, neededBy: '2026-11-05' }]);
    report.orders = { orderAffected1, orderAffected2, orderAffected3, orderSafeSteel1, orderSafeSteel2, orderSafeMixed };

    console.log('Seed complete. Report:');
    console.log(JSON.stringify(report, null, 2));
    console.log('\nNext: trigger the demo earthquake event via scripts/trigger-2xa-event.js to run it through the real relevance pipeline.');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('SEED FAILED:', err);
  process.exit(1);
});
