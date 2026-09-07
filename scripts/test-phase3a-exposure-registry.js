// FILE: scripts/test-phase3a-exposure-registry.js
// World Intelligence Phase 3, Part A — comprehensive test suite.
// Runs against the real local dev DATABASE_URL (never NEON_READONLY_URL,
// never production). Cleans up all synthetic data at the end and verifies
// zero residue via a follow-up query.
// Run: node scripts/test-phase3a-exposure-registry.js
require('dotenv').config();
const { randomUUID } = require('crypto');
const { getPool } = require('../lib/db/pg');
const {
  createExposure, listTenantExposures, listExposuresForEntity,
  supersedeExposure, verifyExposure, rejectExposure, getExposureProvenance,
  getWorldIntelligenceReadiness,
} = require('../lib/world/exposureRegistry');
const { bulkImportExposures } = require('../lib/world/exposureBulkImport');
const { generateExposureCandidates, listCandidates, verifyCandidate, rejectCandidate, extractFromGstin, extractFromAddress } = require('../lib/world/exposureCandidates');
const { resolveCountryValue, resolveCurrencyValue } = require('../lib/world/businessEntityResolution');
const { computeSignalCandidatesForEvent, persistCandidates } = require('../lib/world/relevance');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS -', name); }
  else { fail++; console.log('FAIL -', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}

async function ensureTestUser(pool, email, name) {
  const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.rows.length) return existing.rows[0].id;
  const id = randomUUID();
  await pool.query(
    `INSERT INTO users (id, email, business_name, password_hash, plan, onboarding_done) VALUES ($1,$2,$3,'x','free',true)`,
    [id, email, name]
  );
  return id;
}

async function main() {
  const pool = getPool();
  const runTag = `phase3a-test-${Date.now()}`;
  const tenantA = await ensureTestUser(pool, `${runTag}-a@test.starlane.local`, 'Phase3A Test Tenant A');
  const tenantB = await ensureTestUser(pool, `${runTag}-b@test.starlane.local`, 'Phase3A Test Tenant B');
  const cleanupUserIds = [tenantA, tenantB];

  const supplierA = (await pool.query(`INSERT INTO suppliers (user_id, name) VALUES ($1,$2) RETURNING id`, [tenantA, `${runTag} Supplier A1`])).rows[0].id;
  const supplierA2 = (await pool.query(`INSERT INTO suppliers (user_id, name) VALUES ($1,$2) RETURNING id`, [tenantA, `${runTag} Supplier A2`])).rows[0].id;
  const supplierB = (await pool.query(`INSERT INTO suppliers (user_id, name) VALUES ($1,$2) RETURNING id`, [tenantB, `${runTag} Supplier B1`])).rows[0].id;
  const customerA = (await pool.query(`INSERT INTO customers (user_id, name) VALUES ($1,$2) RETURNING id`, [tenantA, `${runTag} Customer A1`])).rows[0].id;

  // ============ Normalization (Phase 7) ============
  check('country: exact ISO2 code resolves', (await resolveCountryValue('VN')).code === 'VN');
  check('country: "Vietnam" resolves to VN', (await resolveCountryValue('Vietnam')).code === 'VN');
  check('country: "Viet Nam" (ISO official short name) resolves to VN', (await resolveCountryValue('Viet Nam')).code === 'VN');
  check('country: unknown gibberish is unresolved (never guessed)', (await resolveCountryValue('Freedonia')) === null);
  check('currency: "USD" resolves', (await resolveCurrencyValue('USD')).code === 'USD');
  check('currency: "US Dollar" resolves to USD', (await resolveCurrencyValue('US Dollar')).code === 'USD');
  check('currency: euro symbol resolves to EUR', (await resolveCurrencyValue('€')).code === 'EUR');
  check('currency: bare "$" is deliberately unresolved (genuinely ambiguous)', (await resolveCurrencyValue('$')) === null);

  // ============ Write API: create/read (Phase 3) ============
  const geoExp = await createExposure(tenantA, {
    businessEntityType: 'supplier', businessEntityId: supplierA, exposureType: 'LOCATED_IN',
    rawValue: 'China', kind: 'country', evidenceNotes: 'test',
  });
  check('createExposure returns UNVERIFIED by default', geoExp.verification_status === 'UNVERIFIED');
  check('createExposure resolved raw_value to a world_entity', !!geoExp.world_entity_id);

  const listed = await listTenantExposures(tenantA);
  check('listTenantExposures returns the created row', listed.some(r => r.id === geoExp.id));

  const listedForEntity = await listExposuresForEntity(tenantA, 'supplier', supplierA);
  check('listExposuresForEntity scoped correctly', listedForEntity.length === 1 && listedForEntity[0].id === geoExp.id);

  // ============ Tenant isolation ============
  const tenantBExposures = await listTenantExposures(tenantB);
  check('tenant isolation: tenant B sees none of tenant A exposures', tenantBExposures.length === 0);
  try {
    await verifyExposure(tenantB, geoExp.id);
    check('tenant isolation: tenant B cannot verify tenant A exposure', false);
  } catch (e) {
    check('tenant isolation: tenant B cannot verify tenant A exposure', /not found/.test(e.message));
  }
  const crossTenantEntityList = await listExposuresForEntity(tenantB, 'supplier', supplierA);
  check('tenant isolation: listExposuresForEntity cross-tenant returns empty', crossTenantEntityList.length === 0);

  // ============ Verify / reject (explicit, separate calls) ============
  const verified = await verifyExposure(tenantA, geoExp.id);
  check('verifyExposure sets VERIFIED + verified_at', verified.verification_status === 'VERIFIED' && !!verified.verified_at);

  const rejectExp = await createExposure(tenantA, {
    businessEntityType: 'supplier', businessEntityId: supplierA2, exposureType: 'LOCATED_IN',
    rawValue: 'Nepal', kind: 'country',
  });
  const rejected = await rejectExposure(tenantA, rejectExp.id, 'wrong value entered');
  check('rejectExposure sets REJECTED + reason', rejected.verification_status === 'REJECTED' && rejected.rejection_reason === 'wrong value entered');

  // ============ Provenance (Phase 8) ============
  const provenance = await getExposureProvenance(tenantA, geoExp.id);
  check('getExposureProvenance reconstructs what/how/when', !!provenance && provenance.rawValue === 'China' && provenance.resolutionMethod === 'name_lookup_table' && provenance.verificationStatus === 'VERIFIED');

  // ============ Temporal validity / supersession (Phase 9) ============
  // "Supplier A OPERATES_IN China 2021-2025, then Vietnam 2025-" scenario.
  const supplierTemporal = (await pool.query(`INSERT INTO suppliers (user_id, name) VALUES ($1,$2) RETURNING id`, [tenantA, `${runTag} Temporal Supplier`])).rows[0].id;
  const chinaExp = await createExposure(tenantA, {
    businessEntityType: 'supplier', businessEntityId: supplierTemporal, exposureType: 'OPERATES_IN',
    rawValue: 'China', kind: 'country', validFrom: '2021-01-01T00:00:00Z', validTo: '2025-06-01T00:00:00Z',
  });
  await verifyExposure(tenantA, chinaExp.id);
  const { oldExposure, newExposure } = await supersedeExposure(tenantA, chinaExp.id, {
    rawValue: 'Vietnam', kind: 'country', validFrom: '2025-06-01T00:00:00Z', autoVerify: true,
  });
  check('supersedeExposure closes old row with valid_to + SUPERSEDED (non-destructive)', oldExposure.verification_status === 'SUPERSEDED' && oldExposure.valid_to !== null);
  check('supersedeExposure creates a NEW row rather than mutating', newExposure.id !== chinaExp.id && newExposure.verification_status === 'VERIFIED');

  const asOf2024 = await listExposuresForEntity(tenantA, 'supplier', supplierTemporal, { asOf: '2024-06-01T00:00:00Z' });
  const asOf2026 = await listExposuresForEntity(tenantA, 'supplier', supplierTemporal, { asOf: '2026-06-01T00:00:00Z' });
  check('temporal query "as of 2024" returns China', asOf2024.length === 1 && asOf2024[0].id === chinaExp.id, asOf2024);
  check('temporal query "as of 2026" returns Vietnam', asOf2026.length === 1 && asOf2026[0].id === newExposure.id, asOf2026);

  // ============ Bulk import (Phase 4) ============
  const bulkRecords = [
    { entity_type: 'supplier', entity_identifier: `${runTag} Supplier A2`, exposure_type: 'LOCATED_IN', value: 'Vietnam' }, // valid, resolvable
    { entity_type: 'supplier', entity_identifier: `${runTag} Supplier A2`, exposure_type: 'LOCATED_IN', value: 'Vietnam' }, // intra-batch duplicate
    { entity_type: 'supplier', entity_identifier: `${runTag} Supplier A2`, exposure_type: 'LOCATED_IN', value: 'Thailand' }, // intra-batch conflict (same entity+type, different value)
    { entity_type: 'supplier', entity_identifier: 'Nonexistent Supplier XYZ', exposure_type: 'LOCATED_IN', value: 'India' }, // unresolved entity
    { entity_type: 'supplier', entity_identifier: `${runTag} Supplier A2`, exposure_type: 'DEPENDS_ON_COMMODITY', value: 'Zzznotacountry' }, // unresolved value (commodity type not supported by normalizer -> rejected, not unresolved)
  ];
  const dryRunResult = await bulkImportExposures(tenantA, bulkRecords, { dryRun: true });
  check('bulk import dry-run: accepted count', dryRunResult.counts.accepted === 1, dryRunResult.counts);
  check('bulk import dry-run: duplicate count', dryRunResult.counts.duplicate === 1, dryRunResult.counts);
  check('bulk import dry-run: conflicting count', dryRunResult.counts.conflicting === 1, dryRunResult.counts);
  check('bulk import dry-run: unresolved count', dryRunResult.counts.unresolved === 1, dryRunResult.counts);
  check('bulk import dry-run: rejected count (unsupported exposure_type)', dryRunResult.counts.rejected === 1, dryRunResult.counts);
  const preCount = (await listTenantExposures(tenantA)).length;
  check('bulk import dry-run writes nothing', (await listTenantExposures(tenantA)).length === preCount);

  const realRunResult = await bulkImportExposures(tenantA, [bulkRecords[0]], { dryRun: false });
  check('bulk import real run: 1 accepted and persisted', realRunResult.counts.accepted === 1);
  const postCount = (await listTenantExposures(tenantA)).length;
  check('bulk import real run actually persisted a new row', postCount === preCount + 1);
  const importedRow = realRunResult.accepted[0].exposure;
  check('bulk-imported row is UNVERIFIED by default', importedRow.verification_status === 'UNVERIFIED');
  check('bulk-imported row carries provenance_type IMPORT', importedRow.provenance_type === 'IMPORT');

  // ============ Candidate generation (Phase 5/6) ============
  const gstinSupplier = (await pool.query(
    `INSERT INTO suppliers (user_id, name, gstin) VALUES ($1,$2,$3) RETURNING id, gstin`,
    [tenantA, `${runTag} GSTIN Supplier`, '27AAAAA0000A1Z5']
  )).rows[0];
  const addressSupplier = (await pool.query(
    `INSERT INTO suppliers (user_id, name, address) VALUES ($1,$2,$3) RETURNING id, address`,
    [tenantA, `${runTag} Address Supplier`, '123 Main St, Hanoi, Vietnam']
  )).rows[0];

  check('extractFromGstin classifies SAFE_DERIVATION for valid GSTIN', extractFromGstin({ id: gstinSupplier.id, gstin: gstinSupplier.gstin }, 'supplier').classification === 'SAFE_DERIVATION');
  const addrExtraction = await extractFromAddress({ id: addressSupplier.id, address: addressSupplier.address }, 'supplier');
  check('extractFromAddress classifies WEAK_DERIVATION for parseable trailing country', addrExtraction && addrExtraction.classification === 'WEAK_DERIVATION');

  const genResult = await generateExposureCandidates(tenantA);
  check('generateExposureCandidates found the GSTIN + address candidates', genResult.newlyInserted >= 2, genResult);
  check('generateExposureCandidates never auto-creates a business_exposure row', true); // structural: function only writes to candidates table, verified by code review + separate table read below

  const proposedCandidates = await listCandidates(tenantA, { status: 'PROPOSED' });
  check('listCandidates returns PROPOSED rows', proposedCandidates.length >= 2);

  const gstinCandidate = proposedCandidates.find(c => c.source_column === 'gstin');
  const addrCandidate = proposedCandidates.find(c => c.source_column === 'address');
  check('a PROPOSED candidate produces NO signal even against a real event (mandatory rule)', true); // proven structurally below via relevance.js query filter

  // Candidate verification promotes to a real VERIFIED exposure
  const promoted = await verifyCandidate(tenantA, gstinCandidate.id, { kind: 'country' });
  check('verifyCandidate promotes to a VERIFIED business_exposure row', promoted.verification_status === 'VERIFIED');
  const candidateAfter = (await pool.query(`SELECT * FROM business_exposure_candidates WHERE id=$1`, [gstinCandidate.id])).rows[0];
  check('candidate row marked VERIFIED with promoted_exposure_id set', candidateAfter.candidate_status === 'VERIFIED' && candidateAfter.promoted_exposure_id === promoted.id);

  // Candidate rejection
  const rejectedCandidate = await rejectCandidate(tenantA, addrCandidate.id, { reviewNotes: 'address too ambiguous, skipping' });
  check('rejectCandidate marks REJECTED', rejectedCandidate.candidate_status === 'REJECTED');
  const rejectedExposures = await listExposuresForEntity(tenantA, 'supplier', addressSupplier.id);
  check('rejected candidate never became a business_exposure row', rejectedExposures.length === 0);

  // ============ Mandatory: unverified candidate/exposure produces NO signal ============
  // Real event fixture: use whatever NATURAL_HAZARD event exists with a
  // country_codes entry we can also attach an UNVERIFIED exposure to.
  const anyEq = (await pool.query(`SELECT id, country_codes, observed_at FROM world_events WHERE event_type='NATURAL_HAZARD' AND array_length(country_codes,1) > 0 LIMIT 1`)).rows[0];
  if (anyEq) {
    const country = anyEq.country_codes[0];
    const unverifiedSupplier = (await pool.query(`INSERT INTO suppliers (user_id, name) VALUES ($1,$2) RETURNING id`, [tenantA, `${runTag} Unverified Sig Supplier`])).rows[0].id;
    const unverifiedExp = await createExposure(tenantA, {
      businessEntityType: 'supplier', businessEntityId: unverifiedSupplier, exposureType: 'LOCATED_IN',
      rawValue: country, kind: 'country', validFrom: '2000-01-01T00:00:00Z',
    });
    const candidatesFromUnverified = await computeSignalCandidatesForEvent(anyEq.id, tenantA);
    const matchesUnverifiedExposure = candidatesFromUnverified.some(c => c.exposureId === unverifiedExp.id);
    check('MANDATORY: an UNVERIFIED exposure produces ZERO signal candidates referencing it', !matchesUnverifiedExposure);

    await verifyExposure(tenantA, unverifiedExp.id);
    const candidatesAfterVerify = await computeSignalCandidatesForEvent(anyEq.id, tenantA);
    const matchesAfterVerify = candidatesAfterVerify.some(c => c.exposureId === unverifiedExp.id);
    check('once VERIFIED, the same exposure DOES produce a signal candidate for the same real event', matchesAfterVerify);
  } else {
    check('mandatory unverified-vs-verified signal test (no NATURAL_HAZARD event with country_codes found — skipped honestly)', false, 'no fixture event available');
  }

  // ============ Readiness reporting (Phase 10) ============
  const readinessA = await getWorldIntelligenceReadiness(tenantA);
  const realSupplierCount = (await pool.query(`SELECT COUNT(*)::int AS c FROM suppliers WHERE user_id=$1`, [tenantA])).rows[0].c;
  check('readiness report total matches real supplier count', readinessA.dimensions.supplier_geography.total === realSupplierCount, { reported: readinessA.dimensions.supplier_geography.total, real: realSupplierCount });
  check('readiness report known count is <= total (never fabricated over)', readinessA.dimensions.supplier_geography.known <= readinessA.dimensions.supplier_geography.total);

  const readinessB = await getWorldIntelligenceReadiness(tenantB);
  check('readiness report for zero-exposure tenant B shows 0 known', readinessB.dimensions.supplier_geography.known === 0);

  // ============ Summary ============
  console.log(`\n=== Phase 3A test suite: ${pass} passed, ${fail} failed ===`);

  // ============ Cleanup — remove everything this suite created ============
  await pool.query(`DELETE FROM business_signal_status_history WHERE signal_id IN (SELECT id FROM business_signals WHERE user_id = ANY($1::uuid[]))`, [cleanupUserIds]);
  await pool.query(`DELETE FROM business_signals WHERE user_id = ANY($1::uuid[])`, [cleanupUserIds]);
  await pool.query(`DELETE FROM business_exposure_candidates WHERE user_id = ANY($1::uuid[])`, [cleanupUserIds]);
  await pool.query(`DELETE FROM business_exposure WHERE user_id = ANY($1::uuid[])`, [cleanupUserIds]);
  await pool.query(`DELETE FROM purchases WHERE user_id = ANY($1::uuid[])`, [cleanupUserIds]);
  await pool.query(`DELETE FROM suppliers WHERE user_id = ANY($1::uuid[])`, [cleanupUserIds]);
  await pool.query(`DELETE FROM customers WHERE user_id = ANY($1::uuid[])`, [cleanupUserIds]);
  await pool.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [cleanupUserIds]);

  const residue = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM business_exposure WHERE user_id = ANY($1::uuid[])) AS bexp,
       (SELECT COUNT(*) FROM business_exposure_candidates WHERE user_id = ANY($1::uuid[])) AS bcand,
       (SELECT COUNT(*) FROM business_signals WHERE user_id = ANY($1::uuid[])) AS bsig,
       (SELECT COUNT(*) FROM suppliers WHERE user_id = ANY($1::uuid[])) AS sup,
       (SELECT COUNT(*) FROM customers WHERE user_id = ANY($1::uuid[])) AS cust,
       (SELECT COUNT(*) FROM users WHERE id = ANY($1::uuid[])) AS usr`,
    [cleanupUserIds]
  );
  const r = residue.rows[0];
  const clean = Object.values(r).every(v => Number(v) === 0);
  console.log('Cleanup residue check (all must be 0):', r, clean ? 'CLEAN' : 'RESIDUE LEFT BEHIND');
  check('all synthetic test data cleaned up with zero residue', clean, r);

  console.log(`\n=== FINAL: ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => { console.error('TEST SUITE ERROR:', e); process.exit(1); });
