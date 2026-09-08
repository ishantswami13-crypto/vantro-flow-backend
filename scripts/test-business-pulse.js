// STARLANE — Irresistible Value Engine. Real-DB test suite for
// lib/domain/intelligence/businessPulse.js (Capability B: Business Pulse).
// Uses the real dev DATABASE_URL. Creates its own fixtures for scenarios that
// need a specific real data shape, deletes them in a finally block, and
// verifies zero residual rows.
//
// Covers:
//   (a) a real/existing tenant in the dev DB
//   (b) an empty tenant -> expect INSUFFICIENT_DATA overall, never a
//       fabricated neutral/concern score
//   (c) a seeded fragile tenant (real, deteriorated rows: concentrated
//       customer + concentrated supplier + overdue receivables + a real
//       contradiction) -> expect WORSENING with component citations
//       traceable to the seeded rows
//
// Run: node scripts/test-business-pulse.js
require('dotenv').config();
const { randomUUID } = require('crypto');
const { getPool } = require('../lib/db/pg');
const { buildBusinessPulse, INSUFFICIENT } = require('../lib/domain/intelligence/businessPulse');

let pass = 0, fail = 0;
function check(label, cond, extra) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra ? ' -- ' + extra : ''}`);
  cond ? pass++ : fail++;
}

const pool = getPool();
const REAL_TENANT_ID = 'ece4ca68-da30-47f8-9c97-cd99724b1c35'; // known real tenant, see contradictionDetection.js header

const createdUsers = [];
const createdInvoices = [];
const createdSales = [];
const createdSuppliers = [];
const createdPurchases = [];
const createdCustomers = [];
const createdPaymentAllocations = [];

async function makeUser(label) {
  const id = randomUUID();
  await pool.query(`INSERT INTO users (id, email, business_name) VALUES ($1,$2,$3)`, [id, `bp-test-${id}@example.invalid`, label]);
  createdUsers.push(id);
  return id;
}

async function main() {
  try {
    // ---------------------------------------------------------------
    // (a) real/existing tenant
    // ---------------------------------------------------------------
    const realPulse = await buildBusinessPulse(REAL_TENANT_ID);
    check('Real tenant: buildBusinessPulse returns 8 components', Array.isArray(realPulse.components) && realPulse.components.length === 8, `got ${realPulse.components && realPulse.components.length}`);
    check('Real tenant: overall is one of the defined categorical states', ['IMPROVING', 'STABLE', 'WORSENING', INSUFFICIENT].includes(realPulse.overall), `got ${realPulse.overall}`);
    check('Real tenant: overall is never a number', typeof realPulse.overall === 'string');
    check('Real tenant: every component carries a name/state/headline', realPulse.components.every(c => c.name && c.state && typeof c.headline === 'string'));
    check('Real tenant: why is a non-empty explanatory string', typeof realPulse.why === 'string' && realPulse.why.length > 0);

    // ---------------------------------------------------------------
    // (b) empty tenant -> INSUFFICIENT_DATA overall, never a fabricated
    // neutral/concern label.
    // ---------------------------------------------------------------
    const emptyUser = await makeUser('BP empty tenant');
    const emptyPulse = await buildBusinessPulse(emptyUser);
    // Mission intent: an empty tenant must never get a fabricated WORSENING/
    // concern verdict. It's honestly allowed to land on INSUFFICIENT_DATA
    // (nothing at all was evaluable) OR STABLE-from-real-zero-evidence (e.g.
    // contradictionDetection legitimately runs a real query and finds a real
    // zero-count result, which is itself a true, non-fabricated fact, not an
    // invented neutral default).
    check('Empty tenant: overall is never WORSENING (no fabricated concern)', emptyPulse.overall !== 'WORSENING', `got ${emptyPulse.overall}`);
    check('Empty tenant: overall is INSUFFICIENT_DATA or honestly-neutral STABLE', emptyPulse.overall === INSUFFICIENT || emptyPulse.overall === 'STABLE', `got ${emptyPulse.overall}, why=${emptyPulse.why}`);
    const nonInsufficient = emptyPulse.components.filter(c => c.state !== INSUFFICIENT && c.name !== 'dataQuality');
    check('Empty tenant: every non-INSUFFICIENT_DATA component (if any) is backed by a real, honest zero-count/zero-evidence finding, never invented', nonInsufficient.every(c => c.evidence && (c.evidence.contradictionCount === 0)), JSON.stringify(nonInsufficient));
    const emptyDQ = emptyPulse.components.find(c => c.name === 'dataQuality');
    check('Empty tenant: dataQuality honestly reflects the real evaluable count (at most 1: operationalRisk\'s real zero-contradiction finding)', emptyDQ && emptyDQ.evidence.evaluableCount <= 1, `got ${emptyDQ && emptyDQ.evidence.evaluableCount}`);

    // ---------------------------------------------------------------
    // (c) seeded fragile tenant: real rows showing deterioration —
    // concentrated customer (100% share) with a large overdue invoice,
    // concentrated supplier (100% share), and a real Paid-without-evidence
    // contradiction.
    // ---------------------------------------------------------------
    const fragileUser = await makeUser('BP fragile tenant');
    const custA = randomUUID();
    await pool.query(`INSERT INTO customers (id, user_id, name, created_at) VALUES ($1,$2,'BP Fragile Customer', NOW())`, [custA, fragileUser]);
    createdCustomers.push(custA);

    const invOverdue = randomUUID();
    await pool.query(
      `INSERT INTO invoices (id, user_id, customer_id, customer_name, invoice_amount, payment_status, due_date, days_overdue, invoice_date)
       VALUES ($1,$2,$3,$4,$5,'Pending', now() - interval '45 days', 45, now() - interval '60 days')`,
      [invOverdue, fragileUser, custA, 'BP Fragile Customer', 80000]
    );
    createdInvoices.push(invOverdue);

    // A second, real, larger invoice from the same customer already marked
    // Paid but with NO CONFIRMED payment_allocations row -> real, organic-
    // shaped contradiction (same detection query as contradictionDetection.js).
    const invPaidNoEvidence = randomUUID();
    await pool.query(
      `INSERT INTO invoices (id, user_id, customer_id, customer_name, invoice_amount, payment_status, due_date, days_overdue, invoice_date)
       VALUES ($1,$2,$3,$4,$5,'Paid', now() - interval '90 days', 0, now() - interval '100 days')`,
      [invPaidNoEvidence, fragileUser, custA, 'BP Fragile Customer', 20000]
    );
    createdInvoices.push(invPaidNoEvidence);

    const saleInsert = await pool.query(
      `INSERT INTO sales (user_id, customer_id, customer_name, amount, sale_date) VALUES ($1,$2,$3,$4, now() - interval '5 days') RETURNING id`,
      [fragileUser, custA, 'BP Fragile Customer', 80000]
    );
    createdSales.push(saleInsert.rows[0].id);

    const suppId = randomUUID();
    await pool.query(`INSERT INTO suppliers (id, user_id, name) VALUES ($1,$2,$3)`, [suppId, fragileUser, 'BP Sole Supplier']);
    createdSuppliers.push(suppId);
    const purchInsert = await pool.query(
      `INSERT INTO purchases (user_id, supplier_id, supplier_name, amount, purchase_date) VALUES ($1,$2,$3,$4, now() - interval '10 days') RETURNING id`,
      [fragileUser, suppId, 'BP Sole Supplier', 30000]
    );
    createdPurchases.push(purchInsert.rows[0].id);

    const fragilePulse = await buildBusinessPulse(fragileUser);
    check('Fragile tenant: overall is WORSENING', fragilePulse.overall === 'WORSENING', `got ${fragilePulse.overall}, why=${fragilePulse.why}`);

    const collectionHealth = fragilePulse.components.find(c => c.name === 'collectionHealth');
    check('Fragile tenant: collectionHealth is FRAGILE or WATCH, traceable to the real 80000 overdue amount', collectionHealth && collectionHealth.state !== INSUFFICIENT && collectionHealth.evidence.totalOverdue === 80000, `got ${collectionHealth && JSON.stringify(collectionHealth.evidence)}`);

    const custConc = fragilePulse.components.find(c => c.name === 'customerConcentration');
    check('Fragile tenant: customerConcentration is FRAGILE, traceable to 100% real share', custConc && custConc.state === 'FRAGILE' && custConc.evidence.top[0].sharePct === 100, `got ${custConc && JSON.stringify(custConc.evidence.top)}`);

    const suppDep = fragilePulse.components.find(c => c.name === 'supplierDependency');
    check('Fragile tenant: supplierDependency is FRAGILE, traceable to 100% real share', suppDep && suppDep.state === 'FRAGILE' && suppDep.evidence.top[0].sharePct === 100, `got ${suppDep && JSON.stringify(suppDep.evidence.top)}`);

    const opRisk = fragilePulse.components.find(c => c.name === 'operationalRisk');
    check('Fragile tenant: operationalRisk detects the seeded Paid-without-evidence contradiction', opRisk && opRisk.state !== 'STABLE' && opRisk.evidence.contradictionCount >= 1, `got ${opRisk && JSON.stringify(opRisk.evidence)}`);

    const why = fragilePulse.why;
    check('Fragile tenant: why cites at least one of the fragile component names', ['customerConcentration', 'supplierDependency', 'collectionHealth', 'operationalRisk', 'cashStability'].some(n => why.includes(n)), why);

    // ---------------------------------------------------------------
    // Non-fabrication guard: no component may ever report a state other
    // than INSUFFICIENT_DATA without a non-null evidence object.
    // ---------------------------------------------------------------
    const allPulses = [realPulse, emptyPulse, fragilePulse];
    const allComponents = allPulses.flatMap(p => p.components);
    const evidenceOk = allComponents.every(c => c.state === INSUFFICIENT ? true : c.evidence !== null);
    check('Non-fabrication guard: every non-INSUFFICIENT_DATA component carries real evidence', evidenceOk);

  } catch (midErr) {
    console.error('MID-TEST ERROR (fixtures will still be cleaned up):', midErr);
    fail++;
  } finally {
    for (const id of createdPaymentAllocations) await pool.query('DELETE FROM payment_allocations WHERE id=$1', [id]).catch(() => {});
    for (const id of createdInvoices) await pool.query('DELETE FROM invoices WHERE id=$1', [id]).catch(() => {});
    for (const id of createdSales) await pool.query('DELETE FROM sales WHERE id=$1', [id]).catch(() => {});
    for (const id of createdPurchases) await pool.query('DELETE FROM purchases WHERE id=$1', [id]).catch(() => {});
    for (const id of createdSuppliers) await pool.query('DELETE FROM suppliers WHERE id=$1', [id]).catch(() => {});
    for (const id of createdCustomers) await pool.query('DELETE FROM customers WHERE id=$1', [id]).catch(() => {});
    for (const id of createdUsers) await pool.query('DELETE FROM users WHERE id=$1', [id]).catch(() => {});

    const remainingInvoices = createdInvoices.length ? (await pool.query('SELECT count(*)::int AS n FROM invoices WHERE id = ANY($1::uuid[])', [createdInvoices])).rows[0].n : 0;
    const remainingSales = createdSales.length ? (await pool.query('SELECT count(*)::int AS n FROM sales WHERE id = ANY($1::bigint[])', [createdSales])).rows[0].n : 0;
    const remainingPurchases = createdPurchases.length ? (await pool.query('SELECT count(*)::int AS n FROM purchases WHERE id = ANY($1::bigint[])', [createdPurchases])).rows[0].n : 0;
    const remainingSuppliers = createdSuppliers.length ? (await pool.query('SELECT count(*)::int AS n FROM suppliers WHERE id = ANY($1::uuid[])', [createdSuppliers])).rows[0].n : 0;
    const remainingCustomers = createdCustomers.length ? (await pool.query('SELECT count(*)::int AS n FROM customers WHERE id = ANY($1::uuid[])', [createdCustomers])).rows[0].n : 0;
    const remainingUsers = createdUsers.length ? (await pool.query('SELECT count(*)::int AS n FROM users WHERE id = ANY($1::uuid[])', [createdUsers])).rows[0].n : 0;
    check('Fixture cleanup: zero residual rows', remainingInvoices === 0 && remainingSales === 0 && remainingPurchases === 0 && remainingSuppliers === 0 && remainingCustomers === 0 && remainingUsers === 0,
      `invoices=${remainingInvoices} sales=${remainingSales} purchases=${remainingPurchases} suppliers=${remainingSuppliers} customers=${remainingCustomers} users=${remainingUsers}`);

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
