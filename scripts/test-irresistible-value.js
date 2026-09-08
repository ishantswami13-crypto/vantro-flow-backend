// STARLANE — Irresistible Value Engine. Real-DB test suite for
// lib/domain/intelligence/revelationEngine.js (Capability A: Morning
// Revelation Engine). Uses the real local dev DATABASE_URL. Creates its own
// fixtures for scenarios that need a specific real data shape, deletes them
// in a finally block, and verifies zero residual rows.
//
// Covers the mission's WOW-scenario analogs that are applicable to what was
// actually built in this pass:
//   A — hidden cash fragility (concentration + overdue receivables) -> one composed revelation
//   C — supplier concentration dependency -> composed revelation, only when genuinely concentrated
//   D — healthy/empty tenant -> NOTHING_MATERIAL, never a manufactured revelation
//   (contradiction-based revelation is checked against the REAL tenant's
//    known real contradiction rather than being fabricated)
//
// Run: node scripts/test-irresistible-value.js
require('dotenv').config();
const { randomUUID } = require('crypto');
const { getPool } = require('../lib/db/pg');
const { buildMorningRevelations } = require('../lib/domain/intelligence/revelationEngine');

let pass = 0, fail = 0;
function check(label, cond, extra) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra ? ' -- ' + extra : ''}`);
  cond ? pass++ : fail++;
}

const pool = getPool();
const REAL_TENANT_ID = 'ece4ca68-da30-47f8-9c97-cd99724b1c35'; // known real tenant w/ known real contradiction (see contradictionDetection.js header)
const createdUsers = [];
const createdInvoices = [];
const createdSales = [];
const createdSuppliers = [];
const createdPurchases = [];
const createdCustomers = [];

async function makeUser(label) {
  const id = randomUUID();
  await pool.query(`INSERT INTO users (id, email, business_name) VALUES ($1,$2,$3)`, [id, `irv-test-${id}@example.invalid`, label]);
  createdUsers.push(id);
  return id;
}

async function main() {
  try {
    // ---------------------------------------------------------------
    // Scenario D: healthy/empty tenant — zero invoices, zero sales,
    // zero purchases. Must get NOTHING_MATERIAL, never a fabricated entry.
    // ---------------------------------------------------------------
    const emptyUser = await makeUser('IRV empty tenant');
    const emptyResult = await buildMorningRevelations(emptyUser);
    check('Scenario D: empty tenant status is NOTHING_MATERIAL', emptyResult.status === 'NOTHING_MATERIAL', `got ${emptyResult.status}`);
    check('Scenario D: empty tenant revelations array is empty', Array.isArray(emptyResult.revelations) && emptyResult.revelations.length === 0);
    check('Scenario D: empty tenant carries an honest reason string', typeof emptyResult.reason === 'string' && emptyResult.reason.length > 0);

    // ---------------------------------------------------------------
    // Scenario A: hidden cash fragility — one dominant customer with a real
    // overdue open invoice, no other receivables. Concentration will be
    // 100% (single customer), stress case will exceed baseline because a
    // real overdue balance exists while total open also includes it, so we
    // additionally add a second, non-overdue open invoice from a different
    // customer to create a genuine baseline-vs-stress gap.
    // ---------------------------------------------------------------
    const fragileUser = await makeUser('IRV cash fragility tenant');
    const custA = randomUUID();
    const custB = randomUUID();
    await pool.query(`INSERT INTO customers (id, user_id, name, created_at) VALUES ($1,$2,'Fragility Test Customer A', NOW())`, [custA, fragileUser]);
    createdCustomers.push(custA);
    await pool.query(`INSERT INTO customers (id, user_id, name, created_at) VALUES ($1,$2,'Fragility Test Customer B', NOW())`, [custB, fragileUser]);
    createdCustomers.push(custB);
    const invOverdue = randomUUID();
    const invNotYetDue = randomUUID();
    await pool.query(
      `INSERT INTO invoices (id, user_id, customer_id, customer_name, invoice_amount, payment_status, due_date, days_overdue, invoice_date)
       VALUES ($1,$2,$3,$4,$5,'Pending', now() - interval '20 days', 20, now() - interval '35 days')`,
      [invOverdue, fragileUser, custA, 'Fragility Test Customer A', 50000]
    );
    createdInvoices.push(invOverdue);
    await pool.query(
      `INSERT INTO invoices (id, user_id, customer_id, customer_name, invoice_amount, payment_status, due_date, days_overdue, invoice_date)
       VALUES ($1,$2,$3,$4,$5,'Pending', now() + interval '10 days', 0, now() - interval '5 days')`,
      [invNotYetDue, fragileUser, custB, 'Fragility Test Customer B', 10000]
    );
    createdInvoices.push(invNotYetDue);
    // Sales rows so customer concentration has data in its trailing window.
    const saleInsert = await pool.query(
      `INSERT INTO sales (user_id, customer_id, customer_name, amount, sale_date) VALUES ($1,$2,$3,$4, now() - interval '5 days') RETURNING id`,
      [fragileUser, custA, 'Fragility Test Customer A', 50000]
    );
    createdSales.push(saleInsert.rows[0].id);

    const fragileResult = await buildMorningRevelations(fragileUser);
    const cashRevelation = fragileResult.revelations.find(r => r.id === 'CASH_FRAGILITY');
    check('Scenario A: fragile tenant surfaces a CASH_FRAGILITY revelation', !!cashRevelation, JSON.stringify(fragileResult.revelations.map(r => r.id)));
    if (cashRevelation) {
      check('Scenario A: revelation evidence references the real overdue invoice amount', cashRevelation.evidence.totalOverdue === 50000, `got ${cashRevelation.evidence.totalOverdue}`);
      check('Scenario A: revelation carries an explicit howSure/uncertainty label (no fake certainty)', typeof cashRevelation.howSure === 'string' && cashRevelation.howSure.length > 0);
      check('Scenario A: revelation whatToDo references the real invoice id', cashRevelation.whatToDo.includes(invOverdue) || cashRevelation.evidence.cases.baseline.keyDependency?.invoiceId === invOverdue);
    }

    // ---------------------------------------------------------------
    // Scenario C: supplier dependency — single supplier at 100% of spend.
    // ---------------------------------------------------------------
    const suppUser = await makeUser('IRV supplier dependency tenant');
    const suppId = randomUUID();
    await pool.query(`INSERT INTO suppliers (id, user_id, name) VALUES ($1,$2,$3)`, [suppId, suppUser, 'Sole Supplier Co']);
    createdSuppliers.push(suppId);
    const purchInsert = await pool.query(
      `INSERT INTO purchases (user_id, supplier_id, supplier_name, amount, purchase_date) VALUES ($1,$2,$3,$4, now() - interval '10 days') RETURNING id`,
      [suppUser, suppId, 'Sole Supplier Co', 25000]
    );
    createdPurchases.push(purchInsert.rows[0].id);

    const suppResult = await buildMorningRevelations(suppUser);
    const suppRevelation = suppResult.revelations.find(r => r.id === 'SUPPLIER_DEPENDENCY');
    check('Scenario C: single-supplier tenant surfaces a SUPPLIER_DEPENDENCY revelation', !!suppRevelation, JSON.stringify(suppResult.revelations.map(r => r.id)));
    if (suppRevelation) {
      check('Scenario C: revelation is genuinely falsifiable on real sharePct (100%)', suppRevelation.evidence.top[0].sharePct === 100, `got ${suppRevelation.evidence.top[0].sharePct}`);
    }

    // ---------------------------------------------------------------
    // Scenario: real tenant with known real contradiction (no fixture
    // creation — REAL_TENANT_ID's contradiction is documented as organic
    // in contradictionDetection.js's header). We only assert IF the
    // contradiction still exists in the live DB (data may have been fixed
    // since) — this keeps the test honest rather than hardcoding a result
    // that could go stale.
    // ---------------------------------------------------------------
    const realResult = await buildMorningRevelations(REAL_TENANT_ID);
    const contradictionCheck = await pool.query(
      `SELECT count(*)::int AS n FROM invoices i WHERE i.user_id = $1 AND i.payment_status = 'Paid'
       AND NOT EXISTS (SELECT 1 FROM payment_allocations pa WHERE pa.invoice_id = i.id AND pa.allocation_status = 'CONFIRMED')`,
      [REAL_TENANT_ID]
    );
    const stillHasContradiction = contradictionCheck.rows[0].n > 0;
    if (stillHasContradiction) {
      const dataRevelation = realResult.revelations.find(r => r.id === 'DATA_CONTRADICTION');
      check('Real tenant: known real contradiction surfaces as DATA_CONTRADICTION revelation', !!dataRevelation);
    } else {
      console.log('N/A  Real tenant contradiction check -- underlying data no longer exhibits the contradiction (test remains honest, not hardcoded)');
    }
    check('Real tenant: revelation list never exceeds cap of 5', realResult.revelations.length <= 5, `got ${realResult.revelations.length}`);

    // ---------------------------------------------------------------
    // Non-fabrication self-check: every revelation across all scenarios
    // must carry non-empty evidence and a non-empty howSure — a structural
    // guard against the "manufactured concern" failure mode.
    // ---------------------------------------------------------------
    const allRevelations = [...emptyResult.revelations, ...fragileResult.revelations, ...suppResult.revelations, ...realResult.revelations];
    const allHaveEvidence = allRevelations.every(r => r.evidence && Object.keys(r.evidence).length > 0);
    const allHaveHowSure = allRevelations.every(r => typeof r.howSure === 'string' && r.howSure.length > 0);
    check('Non-fabrication guard: every revelation carries non-empty evidence', allHaveEvidence);
    check('Non-fabrication guard: every revelation carries an explicit howSure', allHaveHowSure);

  } catch (midErr) {
    console.error('MID-TEST ERROR (fixtures will still be cleaned up):', midErr);
    fail++;
  } finally {
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
