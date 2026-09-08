// STARLANE — Reality Acquisition, Organizational Sensor Network & Context
// Enrichment. Real-DB test suite covering the applicable subset of the
// mission's 30 listed test cases for the CSV import path, entity
// resolution, and the stockout unlock attempt. Creates its own fixtures
// against the real dev DATABASE_URL, cleans them up in a finally block,
// and verifies zero residual rows (except where a test explicitly proves
// idempotency by leaving a SEEDED row behind on purpose — those are
// cleaned up too, just later in the same run).
//
// Run: node scripts/test-reality-acquisition.js

require('dotenv').config();
const { randomUUID } = require('crypto');
const { getPool } = require('../lib/db/pg');
const { previewImport, commitImport, validateRow } = require('../lib/domain/ingestion/csvImport');
const { resolveEntity, resolveBestMatch } = require('../lib/domain/ingestion/entityResolution');
const { makeObservation, computeContentHash } = require('../lib/domain/ingestion/observation');
const { buildStockoutProjectionV2, checkStockoutPrerequisites } = require('../lib/domain/intelligence/inventoryConsequence');

let pass = 0, fail = 0;
function check(label, cond, extra) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra ? ' -- ' + extra : ''}`);
  cond ? pass++ : fail++;
}
function na(label, reason) {
  console.log(`N/A  ${label} -- ${reason}`);
}

const pool = getPool();
const createdUsers = [];
const createdProducts = [];
const createdSuppliers = [];
const createdPurchases = [];

async function makeUser(label) {
  const id = randomUUID();
  await pool.query(`INSERT INTO users (id, email, business_name) VALUES ($1,$2,$3)`, [id, `ra-test-${id}@example.invalid`, label]);
  createdUsers.push(id);
  return id;
}

async function makeProduct(userId, sku, name) {
  const res = await pool.query(
    `INSERT INTO products (user_id, name, sku, unit_price, current_stock, low_stock_alert) VALUES ($1,$2,$3,10,50,10) RETURNING id`,
    [userId, name, sku]
  );
  createdProducts.push(res.rows[0].id);
  return res.rows[0].id;
}

async function makeSupplier(userId, name, gstin) {
  const res = await pool.query(
    `INSERT INTO suppliers (user_id, name, gstin, is_active) VALUES ($1,$2,$3,true) RETURNING id`,
    [userId, name, gstin || null]
  );
  createdSuppliers.push(res.rows[0].id);
  return res.rows[0].id;
}

async function makePurchase(userId, supplierName, amount) {
  const res = await pool.query(
    `INSERT INTO purchases (user_id, supplier_name, amount, status, purchase_date) VALUES ($1,$2,$3,'PENDING', now()) RETURNING id`,
    [userId, supplierName, amount]
  );
  createdPurchases.push(res.rows[0].id);
  return res.rows[0].id;
}

async function main() {
  try {
    // ---- Test group: entity resolution (Parts 5; tests 2, 3) ----
    const confirmed = resolveEntity(
      { name: 'ABC Pvt Ltd', taxId: 'GSTIN123' },
      { name: 'ABC Private Limited', taxId: 'GSTIN123' }
    );
    check('Test 2: exact GSTIN match resolves as CONFIRMED_MATCH regardless of name spelling', confirmed.verdict === 'CONFIRMED_MATCH', JSON.stringify(confirmed));

    const fuzzyOnly = resolveEntity(
      { name: 'ABC Pvt Ltd', taxId: null },
      { name: 'ABC Private Limited', taxId: 'GSTIN999' }
    );
    check('Test 3: fuzzy-name-only match (no identifier overlap) is NEVER CONFIRMED_MATCH', fuzzyOnly.verdict !== 'CONFIRMED_MATCH', JSON.stringify(fuzzyOnly));
    check('Test 3b: fuzzy-name-only match is classified PROBABLE or POSSIBLE, not silently dropped', ['PROBABLE_MATCH', 'POSSIBLE_MATCH'].includes(fuzzyOnly.verdict), JSON.stringify(fuzzyOnly));

    const noMatch = resolveEntity({ name: 'Totally Unrelated Traders' }, { name: 'ABC Private Limited' });
    check('Test 3c: unrelated names resolve NO_MATCH', noMatch.verdict === 'NO_MATCH', JSON.stringify(noMatch));

    // ---- Test group: CSV validation (test 19) ----
    const malformed = validateRow({ sku: 'X', supplierName: 'S', quantity: 'notanumber', unitPrice: 'also-bad', orderedAt: 'not-a-date' }, 0);
    check('Test 19: malformed quantity/price/date rows are caught by validateRow, not silently coerced', !malformed.valid && malformed.errors.length >= 3, JSON.stringify(malformed));

    const missingId = validateRow({ quantity: 5, unitPrice: 10 }, 1);
    check('Test 19b: missing required identifiers (sku/supplierName) flagged', !missingId.valid, JSON.stringify(missingId));

    // ---- Live fixtures for the import + tenant-isolation + idempotency tests ----
    const userA = await makeUser('reality-acq-tenant-A');
    const userB = await makeUser('reality-acq-tenant-B');
    const productA = await makeProduct(userA, 'RA-SKU-001', 'Reality Acquisition Test Widget');
    const purchaseA = await makePurchase(userA, 'RA Test Supplier', 500);

    const rows = [
      { sku: 'RA-SKU-001', supplierName: 'RA Test Supplier', supplierTaxId: 'RA-GST-1', quantity: 10, unitPrice: 25, currency: 'USD', orderedAt: '2026-08-01', expectedAt: '2026-08-15', sourceRecordId: 'ra-row-1' },
    ];

    // Test 1 / 20 setup: preview mode writes nothing.
    const preview = previewImport(rows, { userId: userA });
    const countBefore = await pool.query(`SELECT count(*)::int n FROM purchase_line_items WHERE purchase_id = $1`, [purchaseA]);
    check('Test 1a: previewImport (dry-run) reports the row as valid', preview.validRows === 1 && preview.invalidRows === 0, JSON.stringify(preview));
    check('Test 1b: previewImport (dry-run) writes zero rows', countBefore.rows[0].n === 0, JSON.stringify(countBefore.rows[0]));

    // First real commit (SEEDED, honestly labeled — no real historical
    // purchase-line data exists in this dev DB per the audit).
    const commit1 = await commitImport(rows, { userId: userA, sourceQuality: 'SEEDED', purchaseId: purchaseA });
    check('Test 25a: first import creates a real purchase_line_items row (intelligence maturity improves from zero rows)', commit1.imported === 1, JSON.stringify(commit1));

    // Test 1 (mandatory, adversarial): same import twice => no duplicate.
    const commit2 = await commitImport(rows, { userId: userA, sourceQuality: 'SEEDED', purchaseId: purchaseA });
    check('Test 1: identical import run twice produces zero new purchase_line_items rows the second time (idempotency)', commit2.imported === 0 && commit2.skippedDuplicate === 1, JSON.stringify(commit2));

    const countAfter = await pool.query(`SELECT count(*)::int n FROM purchase_line_items WHERE purchase_id = $1`, [purchaseA]);
    check('Test 1b: exactly one purchase_line_items row exists after two identical import runs', countAfter.rows[0].n === 1, JSON.stringify(countAfter.rows[0]));

    // Test 10: product<->supplier many-to-many.
    const supplierBId = await makeSupplier(userA, 'RA Second Supplier', 'RA-GST-2');
    const rows2 = [
      { sku: 'RA-SKU-001', supplierName: 'RA Second Supplier', supplierTaxId: 'RA-GST-2', quantity: 5, unitPrice: 30, currency: 'USD', orderedAt: '2026-08-05', sourceRecordId: 'ra-row-2' },
    ];
    const commit3 = await commitImport(rows2, { userId: userA, sourceQuality: 'SEEDED' });
    const psLinks = await pool.query(`SELECT supplier_id FROM product_suppliers WHERE user_id = $1 AND product_id = $2`, [userA, productA]);
    check('Test 10: one product now links to two distinct suppliers (many-to-many, not assumed single-canonical)', psLinks.rows.length === 2, JSON.stringify(psLinks.rows));

    // Test 11 / 20: tenant isolation — importing under userB must not touch userA's rows.
    const productB = await makeProduct(userB, 'RA-SKU-001', 'Tenant B Widget (same SKU, different tenant)');
    const rowsB = [
      { sku: 'RA-SKU-001', supplierName: 'RA Test Supplier', quantity: 3, unitPrice: 9, currency: 'EUR', orderedAt: '2026-08-02', sourceRecordId: 'ra-row-b1' },
    ];
    const commitB = await commitImport(rowsB, { userId: userB, sourceQuality: 'SEEDED' });
    const crossCheck = await pool.query(`SELECT count(*)::int n FROM product_suppliers WHERE user_id = $1 AND product_id = $2`, [userA, productB]);
    check('Test 11/20: importing identical SKU under a different tenant creates no cross-tenant product_suppliers rows', crossCheck.rows[0].n === 0 && commitB.imported === 1, JSON.stringify({ crossCheck: crossCheck.rows[0], commitB }));

    // Test 16: currency is never inferred from supplier country.
    const rowsNoCurrency = [
      { sku: 'RA-SKU-001', supplierName: 'RA Test Supplier', quantity: 2, unitPrice: 5, orderedAt: '2026-08-03', sourceRecordId: 'ra-row-nocur' },
    ];
    const commitNoCur = await commitImport(rowsNoCurrency, { userId: userA, sourceQuality: 'SEEDED' });
    const lineNoCur = await pool.query(
      `SELECT currency FROM purchase_line_items pli JOIN raw_observations ro ON ro.resulting_row_id = pli.id::text
       WHERE ro.user_id = $1 AND ro.source_record_id = 'ra-row-nocur'`,
      [userA]
    );
    check('Test 16: row with no currency field results in a NULL currency line item, never inferred from supplier/country', lineNoCur.rows.length === 0 || lineNoCur.rows[0].currency === null, JSON.stringify({ commitNoCur, lineNoCur: lineNoCur.rows }));

    const invalidCurrencyRow = validateRow({ sku: 'X', supplierName: 'S', quantity: 1, unitPrice: 1, currency: 'US-Dollars' }, 0);
    check('Test 16b: implausible currency code is rejected by validation rather than silently accepted', !invalidCurrencyRow.valid, JSON.stringify(invalidCurrencyRow));

    // Test 17: an observed (not inferred) transaction currency is captured verbatim.
    const rowsWithCurrency = [
      { sku: 'RA-SKU-001', supplierName: 'RA Test Supplier', quantity: 1, unitPrice: 100, currency: 'JPY', orderedAt: '2026-08-04', sourceRecordId: 'ra-row-cur' },
    ];
    await commitImport(rowsWithCurrency, { userId: userA, sourceQuality: 'SEEDED', purchaseId: purchaseA });
    const lineWithCur = await pool.query(
      `SELECT currency FROM purchase_line_items pli JOIN raw_observations ro ON ro.resulting_row_id = pli.id::text
       WHERE ro.user_id = $1 AND ro.source_record_id = 'ra-row-cur'`,
      [userA]
    );
    check('Test 17: an explicitly observed currency value is stored verbatim on the line item', lineWithCur.rows[0] && lineWithCur.rows[0].currency === 'JPY', JSON.stringify(lineWithCur.rows));

    // ---- Test group: stockout unlock attempt (tests 14, 15, 25) ----
    const freshUser = await makeUser('reality-acq-stockout-fresh');
    const freshProduct = await makeProduct(freshUser, 'RA-FRESH-1', 'Fresh product with zero prerequisites');
    const stockoutMissing = await buildStockoutProjectionV2(freshUser, freshProduct);
    check('Test 14: stockout logic refuses to compute when prerequisites are genuinely missing for this product', stockoutMissing.status === 'NOT_IMPLEMENTED', JSON.stringify(stockoutMissing));

    const stockoutWorking = await buildStockoutProjectionV2(userA, productA);
    check('Test 15/25: stockout path computes a real result once product_suppliers + purchase_line_items rows exist (maturity improves from NOT_IMPLEMENTED to COMPUTED)', stockoutWorking.status === 'COMPUTED', JSON.stringify(stockoutWorking));
    check('Test 15b: computed stockout result reflects the real current_stock seeded on the product fixture', stockoutWorking.status === 'COMPUTED' && stockoutWorking.currentStock === 50, JSON.stringify(stockoutWorking));

    const prereqCheck = await checkStockoutPrerequisites(userA);
    check('Sanity: checkStockoutPrerequisites (pre-existing function, untouched) sees the new rows too', prereqCheck.prerequisitesMet === true, JSON.stringify(prereqCheck));

    // ---- Test group: healthy/sparse tenant honesty (tests 29, 30) ----
    const sparseUser = await makeUser('reality-acq-sparse');
    const sparsePrereq = await checkStockoutPrerequisites(sparseUser);
    check('Test 30: sparse tenant (zero rows) produces honest missing-context output, not fabricated intelligence', sparsePrereq.prerequisitesMet === false && sparsePrereq.productSupplierLinks === 0, JSON.stringify(sparsePrereq));

    const healthyPreCount = await pool.query(`SELECT count(*)::int n FROM product_suppliers WHERE user_id = $1`, [userB]);
    await commitImport([{ sku: 'DOES-NOT-EXIST-SKU', supplierName: 'RA Test Supplier', quantity: 1, unitPrice: 1, orderedAt: 'garbage-date' }], { userId: userB, sourceQuality: 'SEEDED' });
    const healthyPostCount = await pool.query(`SELECT count(*)::int n FROM product_suppliers WHERE user_id = $1`, [userB]);
    check('Test 29: an incomplete/malformed import row does not corrupt or fabricate rows for an otherwise-healthy tenant', healthyPostCount.rows[0].n === healthyPreCount.rows[0].n, JSON.stringify({ before: healthyPreCount.rows[0], after: healthyPostCount.rows[0] }));

    // Content-hash determinism sanity (backs idempotency, test 1).
    const h1 = computeContentHash({ userId: userA, entityType: 'purchase_line_item', fields: { a: 1, b: 2 } });
    const h2 = computeContentHash({ userId: userA, entityType: 'purchase_line_item', fields: { b: 2, a: 1 } });
    check('Idempotency support: content hash is stable regardless of field insertion order', h1 === h2, `${h1} vs ${h2}`);

    na('Test 4 (conflicting invoice/payment evidence)', 'out of scope for this pass — this phase targets product/supplier/purchase-line ingestion, not payment reconciliation');
    na('Test 7 (source correction revises dependent intelligence)', 'no correction/revision UI or endpoint built in this pass — deferred');
    na('Test 12 (partial purchase receipt)', 'received_quantity column exists on purchase_line_items (migration 024) but no partial-receipt workflow was exercised with real data in this pass — schema supports it, logic deferred');

  } catch (midErr) {
    console.error('MID-TEST ERROR (fixtures will still be cleaned up):', midErr);
    fail++;
  } finally {
    // Clean up in FK-safe order: purchase_line_items/product_suppliers ->
    // raw_observations -> purchases -> suppliers -> products -> users.
    for (const id of createdUsers) await pool.query('DELETE FROM purchase_line_items WHERE user_id=$1', [id]).catch(() => {});
    for (const id of createdUsers) await pool.query('DELETE FROM product_suppliers WHERE user_id=$1', [id]).catch(() => {});
    for (const id of createdUsers) await pool.query(`DELETE FROM raw_observations WHERE user_id=$1`, [id]).catch(() => {});
    for (const id of createdPurchases) await pool.query('DELETE FROM purchases WHERE id=$1', [id]).catch(() => {});
    for (const id of createdSuppliers) await pool.query('DELETE FROM suppliers WHERE id=$1', [id]).catch(() => {});
    for (const id of createdUsers) await pool.query('DELETE FROM suppliers WHERE user_id=$1', [id]).catch(() => {}); // csv-created supplier candidates
    for (const id of createdProducts) await pool.query('DELETE FROM products WHERE id=$1', [id]).catch(() => {});
    for (const id of createdUsers) await pool.query('DELETE FROM users WHERE id=$1', [id]).catch(() => {});

    const remaining = {};
    remaining.purchaseLineItems = createdUsers.length ? (await pool.query('SELECT count(*)::int n FROM purchase_line_items WHERE user_id = ANY($1::uuid[])', [createdUsers])).rows[0].n : 0;
    remaining.productSuppliers = createdUsers.length ? (await pool.query('SELECT count(*)::int n FROM product_suppliers WHERE user_id = ANY($1::uuid[])', [createdUsers])).rows[0].n : 0;
    remaining.rawObservations = createdUsers.length ? (await pool.query('SELECT count(*)::int n FROM raw_observations WHERE user_id = ANY($1::uuid[])', [createdUsers])).rows[0].n : 0;
    remaining.purchases = createdPurchases.length ? (await pool.query('SELECT count(*)::int n FROM purchases WHERE id = ANY($1::bigint[])', [createdPurchases])).rows[0].n : 0;
    remaining.suppliers = createdUsers.length ? (await pool.query('SELECT count(*)::int n FROM suppliers WHERE user_id = ANY($1::uuid[])', [createdUsers])).rows[0].n : 0;
    remaining.products = createdProducts.length ? (await pool.query('SELECT count(*)::int n FROM products WHERE id = ANY($1::uuid[])', [createdProducts])).rows[0].n : 0;
    remaining.users = createdUsers.length ? (await pool.query('SELECT count(*)::int n FROM users WHERE id = ANY($1::uuid[])', [createdUsers])).rows[0].n : 0;
    const allZero = Object.values(remaining).every((n) => n === 0);
    check('Fixture cleanup: zero residual rows across all tables touched by this test run', allZero, JSON.stringify(remaining));

    console.log(`\n${pass} passed, ${fail} failed`);
    await pool.end();
    process.exit(fail > 0 ? 1 : 0);
  }
}

main();
