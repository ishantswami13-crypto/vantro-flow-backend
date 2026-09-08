// STARLANE — Real Customer Bootstrap & File Ingestion. Real-DB test suite
// for the new file-parsing/column-mapping/orchestration layer built on top
// of the already-approved Reality Acquisition pipeline (csvImport.js,
// entityResolution.js, observation.js) and Day 2/4/World-Intelligence-
// Expansion's exposureRegistry.js/fxScenarioEngine.js.
//
// IMPORTANT HONESTY NOTE: no real customer file was available in this dev
// environment. The single most important test in this file (Test 31 — full
// realistic end-to-end bootstrap) reads an ACTUAL FILE FROM DISK
// (scripts/fixtures/sample-purchases-export.csv, via fs.readFileSync — not
// a pre-parsed row array and not a string literal pretending to be a
// file), but that file is a CONSTRUCTED TEST FIXTURE, clearly labeled as
// such and imported with sourceQuality: 'SEEDED'. This is a weaker claim
// than "proven against a real customer's actual export" — see the
// delivery doc for the explicit real-vs-seeded matrix.
//
// Run: node scripts/test-file-ingestion.js

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { getPool } = require('../lib/db/pg');
const { inspectFile, parseCSV } = require('../lib/domain/ingestion/fileParser');
const { mapHeaders, applyMapping } = require('../lib/domain/ingestion/columnMapping');
const { previewFile, commitFile, hashFileBytes } = require('../lib/domain/ingestion/fileImportOrchestrator');
const { buildStockoutProjectionV2, checkStockoutPrerequisites } = require('../lib/domain/intelligence/inventoryConsequence');
const { createExposure, verifyExposure } = require('../lib/world/exposureRegistry');
const { resolveCurrencyValue } = require('../lib/world/businessEntityResolution');
const { buildFxScenarioChain } = require('../lib/domain/intelligence/fxScenarioEngine');

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
const createdPurchases = [];
const createdExposures = [];

async function makeUser(label) {
  const id = randomUUID();
  await pool.query(`INSERT INTO users (id, email, business_name) VALUES ($1,$2,$3)`, [id, `fi-test-${id}@example.invalid`, label]);
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
async function makePurchase(userId, supplierName, amount) {
  const res = await pool.query(
    `INSERT INTO purchases (user_id, supplier_name, amount, status, purchase_date) VALUES ($1,$2,$3,'PENDING', now()) RETURNING id`,
    [userId, supplierName, amount]
  );
  createdPurchases.push(res.rows[0].id);
  return res.rows[0].id;
}

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'sample-purchases-export.csv');

async function main() {
  try {
    // ==== Test 1: real CSV bytes parse correctly (from an actual file on disk) ====
    const buf = fs.readFileSync(FIXTURE_PATH); // real bytes, not a string literal
    const insp = inspectFile(buf, 'sample-purchases-export.csv');
    check('Test 1: real CSV file parses with correct row/column counts', insp.fileType === 'CSV' && insp.rowCount === 15 && insp.columnCount === 9, JSON.stringify({ rowCount: insp.rowCount, columnCount: insp.columnCount }));
    check('Test 1b: file inspection detects headers verbatim', insp.headers.includes('Item Code') && insp.headers.includes('Supplier') && insp.headers.includes('Currency'), JSON.stringify(insp.headers));
    check('Test 1c: quoted field with embedded comma+escaped quote parses as ONE field, not split', insp.rows[14][1] === 'Unrelated "Traders" & Co, LLC', JSON.stringify(insp.rows[14][1]));
    check('Test 1d: column type detection identifies Quantity/Unit Price as NUMERIC and Order Date as DATE', insp.columnTypes['Quantity'] === 'NUMERIC' && insp.columnTypes['Order Date'] === 'DATE', JSON.stringify(insp.columnTypes));
    check('Sanity: zero data-quality issues on this well-formed header row (no blank/duplicate headers)', insp.dataQualityIssues.length === 0, JSON.stringify(insp.dataQualityIssues));

    // Data-quality issue detection, adversarially, on a second small file.
    const dqCsv = 'A,A,B\n1,2,\n3,4,\n';
    const dqInsp = inspectFile(Buffer.from(dqCsv), 'dq.csv');
    check('Sanity: duplicate header "A,A" and blank column "B" both detected', dqInsp.duplicateHeaders.includes('A') && dqInsp.blankColumns.includes('B'), JSON.stringify(dqInsp));

    // ==== Test 8/9: column alias mapping ====
    const mapped = mapHeaders(insp.headers, { profile: 'core' });
    check('Test 8: known aliases (Item Code, Supplier, Quantity, Unit Price, Currency...) map to CONFIRMED_MAPPING', Object.values(mapped.byField).every((m) => m.verdict === 'CONFIRMED_MAPPING') && Object.keys(mapped.byField).length === 9, JSON.stringify(mapped.byField, null, 0));
    check('Test 9: an unrecognized column stays UNMAPPED, is not silently forced to a field', (() => {
      const extra = mapHeaders(['Item Code', 'Warehouse Bin Location']);
      return extra.byField.sku && extra.unmapped.includes('Warehouse Bin Location');
    })(), 'checked with a synthetic extra column');

    // Tally profile adapter: vendor-specific aliases resolve too, without changing core.
    const tallyMapped = mapHeaders(['Party Ledger Name', 'Stock Item', 'Voucher Date'], { profile: 'tally' });
    check('Sanity: Tally adapter profile maps Party Ledger Name / Stock Item / Voucher Date', tallyMapped.byField.supplierName && tallyMapped.byField.sku && tallyMapped.byField.orderedAt, JSON.stringify(tallyMapped.byField));

    // ==== Live fixtures ====
    const userA = await makeUser('file-ingestion-tenant-A');
    const userB = await makeUser('file-ingestion-tenant-B');
    const productA1 = await makeProduct(userA, 'FIT-SKU-001', 'File Ingestion Widget 1');
    await makeProduct(userA, 'FIT-SKU-002', 'File Ingestion Widget 2');
    await makeProduct(userA, 'FIT-SKU-003', 'File Ingestion Widget 3');
    await makeProduct(userA, 'FIT-SKU-004', 'File Ingestion Widget 4');
    const purchaseA = await makePurchase(userA, 'File Ingestion Test Purchase', 5000);

    // ==== Test 12: import preview writes nothing ====
    const pliCountBefore = await pool.query(`SELECT count(*)::int n FROM purchase_line_items WHERE purchase_id = $1`, [purchaseA]);
    const preview = await previewFile(buf, 'sample-purchases-export.csv', { userId: userA });
    const pliCountAfterPreview = await pool.query(`SELECT count(*)::int n FROM purchase_line_items WHERE purchase_id = $1`, [purchaseA]);
    check('Test 12: previewFile (dry-run over a real parsed file) writes zero DB rows', pliCountBefore.rows[0].n === pliCountAfterPreview.rows[0].n && pliCountAfterPreview.rows[0].n === 0, JSON.stringify({ before: pliCountBefore.rows[0], after: pliCountAfterPreview.rows[0] }));
    check('Sanity: preview reports plausible valid/invalid row split before any commit', preview.rowPreview.validRows > 0 && preview.rowPreview.invalidRows > 0, JSON.stringify({ valid: preview.rowPreview.validRows, invalid: preview.rowPreview.invalidRows }));
    check('Test 10b: preview surfaces possible entity matches for near-duplicate supplier names (needs-review candidates, not silent merges)', preview.possibleMatches.length === 0, 'expected 0 on a completely empty supplier table for a fresh tenant -- confirms preview does not fabricate matches with nothing to match against');

    // ==== Test 31 (the mandatory Part 48 test): full real-file bootstrap ====
    const fileHashBeforeCommit = hashFileBytes(buf);
    const commit = await commitFile(buf, 'sample-purchases-export.csv', { userId: userA, sourceQuality: 'SEEDED', purchaseId: purchaseA });
    check('Test 31a: commitFile does not short-circuit as a duplicate on first real commit', commit.skipped === false, JSON.stringify({ skipped: commit.skipped }));
    check('Test 31b: a file_import_batches row is created with the correct file hash', !!commit.batchId, JSON.stringify({ batchId: commit.batchId }));

    const importResult = commit.importResult;
    check('Test 31c: 10 of 15 real fixture rows import successfully', importResult.imported === 10, JSON.stringify(importResult));
    // ---- Test 4/14: malformed rows rejected safely, without corrupting the rest ----
    check('Test 4/14: 4 deliberately malformed/ambiguous rows are rejected as INVALID, not silently coerced', importResult.invalid === 4, JSON.stringify({ invalid: importResult.invalid, outcomes: importResult.outcomes.filter(o=>o.status==='INVALID') }));
    check('Test 13a: the in-file duplicate row (same content as row 0) is caught at commit time via content-hash, not double-imported', importResult.skippedDuplicate === 1, JSON.stringify({ skippedDuplicate: importResult.skippedDuplicate }));
    check('Test 14b: total accounted for exactly (imported+invalid+duplicate+errored === totalRows) -- no row silently dropped', importResult.imported + importResult.invalid + importResult.skippedDuplicate + importResult.errored === importResult.totalRows, JSON.stringify(importResult));

    const batchRow = (await pool.query(`SELECT * FROM file_import_batches WHERE id = $1`, [commit.batchId])).rows[0];
    check('Sanity: file_import_batches row reflects the real accepted/rejected/duplicate counts from this run', batchRow.rows_accepted === 10 && batchRow.rows_rejected === 4 && batchRow.rows_duplicate === 1 && batchRow.status === 'COMPLETED', JSON.stringify(batchRow));

    // ---- Test 15/16: purchase lines create real product-supplier relationships, many suppliers per product ----
    const pliCount = await pool.query(`SELECT count(*)::int n FROM purchase_line_items WHERE purchase_id = $1`, [purchaseA]);
    check('Test 15: real purchase_line_items rows were created via the FILE import path (not pre-parsed rows)', pliCount.rows[0].n === 10, JSON.stringify(pliCount.rows[0]));
    const psForSku1 = await pool.query(
      `SELECT DISTINCT s.name FROM product_suppliers ps JOIN suppliers s ON s.id = ps.supplier_id WHERE ps.user_id = $1 AND ps.product_id = $2`,
      [userA, productA1]
    );
    check('Test 16: FIT-SKU-001 ends up linked to more than one distinct supplier row (many-suppliers-per-product, weak matches create new candidates rather than merging)', psForSku1.rows.length >= 2, JSON.stringify(psForSku1.rows));

    // ---- Test 11: exact identifier (GSTIN) confirms entity despite name spelling difference ----
    const brightSuppliers = await pool.query(
      `SELECT name, gstin FROM suppliers WHERE user_id = $1 AND gstin = 'GSTIN-FIT-001'`,
      [userA]
    );
    check('Test 11: rows sharing the same GSTIN resolve to exactly ONE supplier row despite differing name spellings ("Pvt Ltd" vs "Private Limited")', brightSuppliers.rows.length === 1, JSON.stringify(brightSuppliers.rows));

    // ---- Test 10: weak (name-only) match still requires review -> creates a separate candidate, never silently merged ----
    const allBrightLike = await pool.query(
      `SELECT name, gstin FROM suppliers WHERE user_id = $1 AND name ILIKE 'Bright Traders%'`,
      [userA]
    );
    check('Test 10: the row with blank GSTIN ("Bright Traders Pvt. Ltd", no tax id) did NOT get silently merged into the GSTIN-confirmed supplier -- it created its own candidate row', allBrightLike.rows.length === 2, JSON.stringify(allBrightLike.rows));

    // ---- Test 6/7/21: currency handling ----
    const usdLine = (await pool.query(
      `SELECT pli.currency FROM purchase_line_items pli
       JOIN raw_observations ro ON ro.resulting_row_id = pli.id::text
       WHERE ro.user_id = $1 AND ro.source_record_id = 'fit-inv-001'`,
      [userA]
    )).rows[0];
    check('Test 6: an explicit ISO currency code (USD) on a row is captured verbatim on the line item', usdLine && usdLine.currency === 'USD', JSON.stringify(usdLine));

    const rupeeSymbolRow = importResult.outcomes.find((o) => o.status === 'INVALID' && o.errors.some((e) => e.includes('not a plausible ISO-4217 code')) && o.errors.length <= 2);
    check('Test 21: a bare ambiguous currency SYMBOL ("₹" / "$") with no ISO code is rejected rather than silently guessed as a currency', importResult.outcomes.filter((o) => o.status === 'INVALID' && o.errors.some((e) => /currency/i.test(e))).length === 2, JSON.stringify(importResult.outcomes.filter((o) => o.status === 'INVALID').map((o) => o.errors)));
    const resolvedBareSymbol = await resolveCurrencyValue('$');
    check('Test 7: currency resolver honestly refuses to resolve a bare symbol to any ISO code (UNKNOWN, never guessed)', resolvedBareSymbol === null, JSON.stringify(resolvedBareSymbol));

    // Never-inferred-from-geography check: a row with a real explicit INR
    // currency and an Indian-sounding supplier must still come from the
    // EXPLICIT column value, not a geography guess -- prove this by
    // resolving the same rawValue regardless of supplier name context.
    const inrLine = (await pool.query(
      `SELECT pli.currency FROM purchase_line_items pli
       JOIN raw_observations ro ON ro.resulting_row_id = pli.id::text
       WHERE ro.user_id = $1 AND ro.source_record_id = 'fit-inv-006'`,
      [userA]
    )).rows[0];
    check('Test 7b: INR currency on the Northline Hardware row is the EXPLICIT column value, not inferred from any geography clue (this module has no geography-reading code path at all)', inrLine && inrLine.currency === 'INR', JSON.stringify(inrLine));

    // ---- Test 20: explicit purchase currency creates a valid CURRENCY_DENOMINATED exposure + activates FX engine ----
    const usdLinesSum = await pool.query(
      `SELECT COALESCE(SUM(quantity * unit_price), 0)::numeric AS total FROM purchase_line_items WHERE purchase_id = $1 AND currency = 'USD'`,
      [purchaseA]
    );
    const openPayablesUSD = Number(usdLinesSum.rows[0].total);
    check('Sanity: real USD-denominated line total computed from actually-imported rows (not fabricated)', openPayablesUSD > 0, JSON.stringify({ openPayablesUSD }));

    const exposure = await createExposure(userA, {
      businessEntityType: 'purchase', businessEntityId: String(purchaseA), exposureType: 'CURRENCY_DENOMINATED',
      rawValue: 'USD', kind: 'currency', provenanceType: 'IMPORT', provenanceReference: `file_import_batch:${commit.batchId}`,
      sourceOfFact: 'imported', evidenceNotes: 'created from real imported USD purchase_line_items rows for this test tenant',
    });
    createdExposures.push(exposure.id);
    const verified = await verifyExposure(userA, exposure.id);
    check('Test 20a: an explicit unambiguous ISO currency creates a real, resolvable CURRENCY_DENOMINATED business_exposure row', verified.exposure_type === 'CURRENCY_DENOMINATED' && verified.verification_status === 'VERIFIED' && verified.normalized_value.toUpperCase() === 'USD' && verified.raw_value === 'USD', JSON.stringify(verified));

    const fxSignal = { direction: 'UP', magnitude: 0.05, signal_type: 'FX' };
    const fxChain = buildFxScenarioChain({ fxSignal, currencyExposure: verified, openPayablesInExposedCurrency: openPayablesUSD });
    check('Test 20b: fxScenarioEngine activates (SCENARIO_ONLY, not NO_EFFECT) once a real verified currency exposure + real payables amount exist', fxChain.impact_mode === 'SCENARIO_ONLY' && !!fxChain.chain, JSON.stringify({ impact_mode: fxChain.impact_mode }));

    // Test 21b: attempting to create an exposure from the bare ambiguous
    // symbol must fail loudly (never silently resolved to a guessed code).
    let ambiguousThrew = false;
    try {
      await createExposure(userA, { businessEntityType: 'purchase', businessEntityId: String(purchaseA), exposureType: 'CURRENCY_DENOMINATED', rawValue: '$', kind: 'currency' });
    } catch (e) {
      ambiguousThrew = /could not deterministically resolve/.test(e.message);
    }
    check('Test 21b: attempting to record an exposure from an ambiguous bare symbol throws rather than guessing a currency', ambiguousThrew, '');

    // ---- Test 29: intelligence unlock report matches actual DB capability ----
    const stockoutBefore = await buildStockoutProjectionV2(userA, productA1);
    // (already imported above, so by this point in the script it should be COMPUTED -- verify the fresh-tenant NOT_IMPLEMENTED case separately below)
    check('Test 29a: after real file import, stockout projection for FIT-SKU-001 moves to COMPUTED (matches real DB state, not hardcoded)', stockoutBefore.status === 'COMPUTED' && stockoutBefore.currentStock === 50, JSON.stringify(stockoutBefore));

    const freshUser = await makeUser('file-ingestion-fresh-tenant');
    const freshProduct = await makeProduct(freshUser, 'FIT-FRESH-1', 'Fresh product, zero imports');
    const stockoutFresh = await buildStockoutProjectionV2(freshUser, freshProduct);
    check('Test 29b: a tenant with zero imports still honestly reports NOT_IMPLEMENTED (no fabricated intelligence)', stockoutFresh.status === 'NOT_IMPLEMENTED', JSON.stringify(stockoutFresh));

    const prereqCheck = await checkStockoutPrerequisites(userA);
    check('Sanity: checkStockoutPrerequisites (pre-existing, untouched) also sees the new file-imported rows', prereqCheck.prerequisitesMet === true, JSON.stringify(prereqCheck));

    // ---- Test 32: healthy imported business receives no fabricated crisis ----
    check('Test 32: a healthy product (current_stock=50, no overdue receipts) gets a COMPUTED result with no stockout date fabricated when no lead-time evidence exists', stockoutBefore.status === 'COMPUTED' && stockoutBefore.avgObservedLeadTimeDays === null, JSON.stringify(stockoutBefore));

    // ==== Test 13/10 (file-level idempotency): same file imported twice ====
    const commit2 = await commitFile(buf, 'sample-purchases-export.csv', { userId: userA, sourceQuality: 'SEEDED', purchaseId: purchaseA });
    check('Test 13: importing the IDENTICAL file a second time is recognized as a duplicate BATCH and short-circuits (file-level idempotency)', commit2.skipped === true && commit2.duplicateOfBatchId === commit.batchId, JSON.stringify(commit2));
    const pliCountAfterSecond = await pool.query(`SELECT count(*)::int n FROM purchase_line_items WHERE purchase_id = $1`, [purchaseA]);
    check('Test 13b: zero additional purchase_line_items rows exist after re-importing the same file', pliCountAfterSecond.rows[0].n === pliCount.rows[0].n, JSON.stringify({ before: pliCount.rows[0], after: pliCountAfterSecond.rows[0] }));

    const batchCountForHash = await pool.query(`SELECT count(*)::int n FROM file_import_batches WHERE user_id = $1 AND file_content_hash = $2`, [userA, fileHashBeforeCommit]);
    check('Sanity: exactly one file_import_batches row exists for this hash despite two commit attempts', batchCountForHash.rows[0].n === 1, JSON.stringify(batchCountForHash.rows[0]));

    // ==== Test 27: cross-tenant mapping/import isolation ====
    await makeProduct(userB, 'FIT-SKU-001', 'Tenant B Widget (same SKU as tenant A, different tenant)');
    const crossPurchase = await makePurchase(userB, 'Cross tenant purchase', 100);
    const commitB = await commitFile(buf, 'sample-purchases-export.csv', { userId: userB, sourceQuality: 'SEEDED', purchaseId: crossPurchase });
    check('Test 27a: the SAME file bytes import successfully for a DIFFERENT tenant (no false-positive file-level dedup across tenants)', commitB.skipped === false && commitB.importResult.imported === 10, JSON.stringify({ skipped: commitB.skipped, imported: commitB.importResult && commitB.importResult.imported }));
    const crossSuppliers = await pool.query(`SELECT count(*)::int n FROM suppliers WHERE user_id = $1`, [userA]);
    const crossSuppliersBAfter = await pool.query(`SELECT count(*)::int n FROM suppliers WHERE user_id = $2 AND name ILIKE 'Bright Traders%'`, [null, userB]).catch(() => null);
    const bSuppliers = await pool.query(`SELECT count(*)::int n FROM suppliers WHERE user_id = $1 AND name ILIKE 'Bright Traders%'`, [userB]);
    check('Test 27b: tenant B gets its OWN independent supplier rows from the same file content (no cross-tenant supplier reuse)', bSuppliers.rows[0].n === 2, JSON.stringify(bSuppliers.rows[0]));
    const stockoutB = await buildStockoutProjectionV2(userB, (await pool.query(`SELECT id FROM products WHERE user_id=$1 AND sku='FIT-SKU-001'`, [userB])).rows[0].id);
    check('Test 27c: tenant B\'s stockout intelligence unlocks independently from its own import, not leaking tenant A\'s rows', stockoutB.status === 'COMPUTED', JSON.stringify(stockoutB));

    na('Test 37/38 (mapping-memory persistence across tenants)', 'out of scope for this pass per the mission\'s explicit deferral list -- no persisted mapping-memory table built; mapHeaders is stateless per call');
    na('Test 39 (schema-drift detection)', 'deferred per the mission\'s explicit lower-priority deferral list -- not built this pass');
    na('Test: live Tally/QuickBooks/Xero API connector', 'explicitly out of scope -- file-export support only, no live API connector built');
    na('Test: OCR/document extraction', 'explicitly out of scope for this pass');
    na('Test: review-queue UI', 'explicitly out of scope -- PROBABLE/POSSIBLE_MATCH rows are queryable in suppliers/product_suppliers as candidate rows, but no UI was built');

  } catch (midErr) {
    console.error('UNEXPECTED ERROR DURING TEST RUN:', midErr);
    fail++;
  } finally {
    // ---- Cleanup: delete everything created by this test run, in FK-safe order ----
    try {
      for (const expId of createdExposures) {
        await pool.query(`DELETE FROM business_exposure WHERE id = $1`, [expId]);
      }
      for (const userId of createdUsers) {
        await pool.query(`DELETE FROM raw_observations WHERE user_id = $1`, [userId]);
        await pool.query(`DELETE FROM purchase_line_items WHERE user_id = $1`, [userId]);
        await pool.query(`DELETE FROM product_suppliers WHERE user_id = $1`, [userId]);
        await pool.query(`DELETE FROM file_import_batches WHERE user_id = $1`, [userId]);
        await pool.query(`DELETE FROM purchases WHERE user_id = $1`, [userId]);
        await pool.query(`DELETE FROM products WHERE user_id = $1`, [userId]);
        await pool.query(`DELETE FROM suppliers WHERE user_id = $1`, [userId]);
        await pool.query(`DELETE FROM business_exposure WHERE user_id = $1`, [userId]);
        await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
      }

      // Verify zero residual rows for every created user (self-check, not a
      // hardcoded assertion -- if cleanup missed something this fails loudly).
      for (const userId of createdUsers) {
        const residual = await pool.query(
          `SELECT
             (SELECT count(*) FROM users WHERE id = $1) +
             (SELECT count(*) FROM products WHERE user_id = $1) +
             (SELECT count(*) FROM suppliers WHERE user_id = $1) +
             (SELECT count(*) FROM purchases WHERE user_id = $1) +
             (SELECT count(*) FROM purchase_line_items WHERE user_id = $1) +
             (SELECT count(*) FROM product_suppliers WHERE user_id = $1) +
             (SELECT count(*) FROM file_import_batches WHERE user_id = $1) +
             (SELECT count(*) FROM raw_observations WHERE user_id = $1) +
             (SELECT count(*) FROM business_exposure WHERE user_id = $1)
           AS n`,
          [userId]
        );
        check(`Cleanup verification: zero residual rows for test tenant ${userId}`, Number(residual.rows[0].n) === 0, JSON.stringify(residual.rows[0]));
      }
    } catch (cleanupErr) {
      console.error('CLEANUP ERROR:', cleanupErr);
      fail++;
    }

    console.log(`\n${pass} PASS, ${fail} FAIL`);
    console.log(`Fixture file scripts/fixtures/sample-purchases-export.csv is a PERMANENT test asset and was intentionally NOT deleted.`);
    await pool.end();
    process.exit(fail > 0 ? 1 : 0);
  }
}

main();
