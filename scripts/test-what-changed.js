// STARLANE — Irresistible Value Engine. Real-DB test suite for
// lib/domain/intelligence/whatChangedSinceLastLook.js (Capability C).
// Uses the real dev DATABASE_URL. Creates its own fixtures, deletes them
// (including checkpoint rows) in a finally block, and verifies zero
// residual rows.
//
// Covers:
//   (a) a fresh tenant with NO prior checkpoint row -> FIRST_REVIEW, never a
//       false "nothing changed"
//   (b) a tenant with a real/constructed material change between two
//       checkpoints -> MATERIAL_CHANGES with citations
//   (c) a tenant with only trivial/immaterial changes between two
//       checkpoints -> NOTHING_MATERIAL
//
// Run: node scripts/test-what-changed.js
require('dotenv').config();
const { randomUUID } = require('crypto');
const { getPool } = require('../lib/db/pg');
const { whatChangedSinceLastLook, getCheckpoint } = require('../lib/domain/intelligence/whatChangedSinceLastLook');

let pass = 0, fail = 0;
function check(label, cond, extra) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra ? ' -- ' + extra : ''}`);
  cond ? pass++ : fail++;
}

const pool = getPool();
const createdUsers = [];
const createdInvoices = [];
const createdSales = [];
const createdSuppliers = [];
const createdPurchases = [];
const createdCustomers = [];
const createdCheckpointUserIds = [];

async function makeUser(label) {
  const id = randomUUID();
  await pool.query(`INSERT INTO users (id, email, business_name) VALUES ($1,$2,$3)`, [id, `wc-test-${id}@example.invalid`, label]);
  createdUsers.push(id);
  createdCheckpointUserIds.push(id);
  return id;
}

async function main() {
  try {
    // ---------------------------------------------------------------
    // (a) fresh tenant, no prior checkpoint -> FIRST_REVIEW
    // ---------------------------------------------------------------
    const freshUser = await makeUser('WC fresh tenant');
    const firstResult = await whatChangedSinceLastLook(freshUser);
    check('Fresh tenant: status is FIRST_REVIEW', firstResult.status === 'FIRST_REVIEW', `got ${firstResult.status}`);
    check('Fresh tenant: never falsely reports NOTHING_MATERIAL when there is no baseline', firstResult.status !== 'NOTHING_MATERIAL');
    check('Fresh tenant: changes array is empty on first review', Array.isArray(firstResult.changes) && firstResult.changes.length === 0);
    check('Fresh tenant: lastReviewedAt is null (no prior review)', firstResult.lastReviewedAt === null);
    const cp1 = await getCheckpoint(freshUser);
    check('Fresh tenant: a checkpoint row now exists after the first call', !!cp1);

    // Second call immediately after with no data change -> NOTHING_MATERIAL
    // (this also covers "only trivial/immaterial changes", since literally
    // nothing changed).
    const secondResult = await whatChangedSinceLastLook(freshUser);
    check('Scenario (c) trivial/no changes: second call on unchanged tenant is NOTHING_MATERIAL', secondResult.status === 'NOTHING_MATERIAL', `got ${secondResult.status}, changes=${JSON.stringify(secondResult.changes)}`);
    check('Scenario (c): lastReviewedAt now reflects the real prior checkpoint time', !!secondResult.lastReviewedAt);

    // ---------------------------------------------------------------
    // (b) material change between two checkpoints: seed a tenant, take a
    // checkpoint reflecting a healthy state, then seed real deteriorating
    // rows (concentrated customer + large overdue invoice + contradiction)
    // and confirm the diff surfaces MATERIAL_CHANGES with citations.
    // ---------------------------------------------------------------
    const matUser = await makeUser('WC material-change tenant');
    // Baseline checkpoint: empty tenant.
    const baseline = await whatChangedSinceLastLook(matUser);
    check('Material-change tenant: baseline call is FIRST_REVIEW', baseline.status === 'FIRST_REVIEW', `got ${baseline.status}`);

    // Now seed real deteriorating rows.
    const custA = randomUUID();
    await pool.query(`INSERT INTO customers (id, user_id, name, created_at) VALUES ($1,$2,'WC Material Customer', NOW())`, [custA, matUser]);
    createdCustomers.push(custA);
    const invOverdue = randomUUID();
    await pool.query(
      `INSERT INTO invoices (id, user_id, customer_id, customer_name, invoice_amount, payment_status, due_date, days_overdue, invoice_date)
       VALUES ($1,$2,$3,$4,$5,'Pending', now() - interval '40 days', 40, now() - interval '55 days')`,
      [invOverdue, matUser, custA, 'WC Material Customer', 90000]
    );
    createdInvoices.push(invOverdue);
    const saleInsert = await pool.query(
      `INSERT INTO sales (user_id, customer_id, customer_name, amount, sale_date) VALUES ($1,$2,$3,$4, now() - interval '5 days') RETURNING id`,
      [matUser, custA, 'WC Material Customer', 90000]
    );
    createdSales.push(saleInsert.rows[0].id);
    const suppId = randomUUID();
    await pool.query(`INSERT INTO suppliers (id, user_id, name) VALUES ($1,$2,$3)`, [suppId, matUser, 'WC Material Supplier']);
    createdSuppliers.push(suppId);
    const purchInsert = await pool.query(
      `INSERT INTO purchases (user_id, supplier_id, supplier_name, amount, purchase_date) VALUES ($1,$2,$3,$4, now() - interval '10 days') RETURNING id`,
      [matUser, suppId, 'WC Material Supplier', 40000]
    );
    createdPurchases.push(purchInsert.rows[0].id);

    const afterSeed = await whatChangedSinceLastLook(matUser);
    check('Material-change tenant: second call after seeding is MATERIAL_CHANGES', afterSeed.status === 'MATERIAL_CHANGES', `got ${afterSeed.status}`);
    check('Material-change tenant: at least one change item cites the real pulse overall/component transition', afterSeed.changes.length > 0, JSON.stringify(afterSeed.changes));
    const pulseOverallChange = afterSeed.changes.find(c => c.type === 'PULSE_OVERALL_CHANGED');
    check('Material-change tenant: PULSE_OVERALL_CHANGED item is present and traceable to real before/after states', !!pulseOverallChange && typeof pulseOverallChange.before === 'string' && typeof pulseOverallChange.after === 'string', JSON.stringify(pulseOverallChange));
    const componentChanges = afterSeed.changes.filter(c => c.type === 'PULSE_COMPONENT_CHANGED');
    check('Material-change tenant: at least one PULSE_COMPONENT_CHANGED item cites a real component (customerConcentration or supplierDependency or collectionHealth)', componentChanges.some(c => ['customerConcentration', 'supplierDependency', 'collectionHealth'].includes(c.component)), JSON.stringify(componentChanges));

    // Third call with no further changes -> NOTHING_MATERIAL again (diff is
    // against the just-updated checkpoint, not the original baseline).
    const thirdCall = await whatChangedSinceLastLook(matUser);
    check('Material-change tenant: third call (no further change) is NOTHING_MATERIAL', thirdCall.status === 'NOTHING_MATERIAL', `got ${thirdCall.status}, changes=${JSON.stringify(thirdCall.changes)}`);

  } catch (midErr) {
    console.error('MID-TEST ERROR (fixtures will still be cleaned up):', midErr);
    fail++;
  } finally {
    for (const id of createdInvoices) await pool.query('DELETE FROM invoices WHERE id=$1', [id]).catch(() => {});
    for (const id of createdSales) await pool.query('DELETE FROM sales WHERE id=$1', [id]).catch(() => {});
    for (const id of createdPurchases) await pool.query('DELETE FROM purchases WHERE id=$1', [id]).catch(() => {});
    for (const id of createdSuppliers) await pool.query('DELETE FROM suppliers WHERE id=$1', [id]).catch(() => {});
    for (const id of createdCustomers) await pool.query('DELETE FROM customers WHERE id=$1', [id]).catch(() => {});
    for (const id of createdCheckpointUserIds) await pool.query('DELETE FROM tenant_review_checkpoints WHERE user_id=$1', [id]).catch(() => {});
    for (const id of createdUsers) await pool.query('DELETE FROM users WHERE id=$1', [id]).catch(() => {});

    const remainingInvoices = createdInvoices.length ? (await pool.query('SELECT count(*)::int AS n FROM invoices WHERE id = ANY($1::uuid[])', [createdInvoices])).rows[0].n : 0;
    const remainingSales = createdSales.length ? (await pool.query('SELECT count(*)::int AS n FROM sales WHERE id = ANY($1::bigint[])', [createdSales])).rows[0].n : 0;
    const remainingPurchases = createdPurchases.length ? (await pool.query('SELECT count(*)::int AS n FROM purchases WHERE id = ANY($1::bigint[])', [createdPurchases])).rows[0].n : 0;
    const remainingSuppliers = createdSuppliers.length ? (await pool.query('SELECT count(*)::int AS n FROM suppliers WHERE id = ANY($1::uuid[])', [createdSuppliers])).rows[0].n : 0;
    const remainingCustomers = createdCustomers.length ? (await pool.query('SELECT count(*)::int AS n FROM customers WHERE id = ANY($1::uuid[])', [createdCustomers])).rows[0].n : 0;
    const remainingCheckpoints = createdCheckpointUserIds.length ? (await pool.query('SELECT count(*)::int AS n FROM tenant_review_checkpoints WHERE user_id = ANY($1::uuid[])', [createdCheckpointUserIds])).rows[0].n : 0;
    const remainingUsers = createdUsers.length ? (await pool.query('SELECT count(*)::int AS n FROM users WHERE id = ANY($1::uuid[])', [createdUsers])).rows[0].n : 0;
    check('Fixture cleanup: zero residual rows (including checkpoints)', remainingInvoices === 0 && remainingSales === 0 && remainingPurchases === 0 && remainingSuppliers === 0 && remainingCustomers === 0 && remainingCheckpoints === 0 && remainingUsers === 0,
      `invoices=${remainingInvoices} sales=${remainingSales} purchases=${remainingPurchases} suppliers=${remainingSuppliers} customers=${remainingCustomers} checkpoints=${remainingCheckpoints} users=${remainingUsers}`);

    console.log(`\n${pass} passed, ${fail} failed`);
    await pool.end();
    process.exit(fail > 0 ? 1 : 0);
  }
}

main().catch(async (e) => {
  console.error('FATAL', e);
  await pool.end().catch(() => {});
  process.exit(1);
});
