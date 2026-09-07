// FILE: scripts/world-phase3a-proof.js
// World Intelligence Phase 3, Part A — Phase 12 MANDATORY proof.
//
// Uses the real write API (createExposure/verifyExposure), never raw SQL,
// to record exposures for a real test tenant, then runs Phase 2's real
// relevance engine against REAL already-ingested Phase 1 world_events and
// proves:
//   (A) a verified geography exposure produces a real signal from a real
//       earthquake event
//   (B) a verified currency exposure produces a real signal from a real FX
//       event
//   (C) a second tenant with zero exposures gets ZERO signals from the
//       same events
// Direct SQL is used ONLY to create/find the fixture tenants, the fixture
// supplier/purchase rows, and to look up which real world_events exist to
// target (all reads/seeds, not the exposure-creation step itself, which
// must go through the service layer per the mission's Phase 12 requirement).
//
// Run: node scripts/world-phase3a-proof.js
require('dotenv').config();
const { randomUUID } = require('crypto');
const { getPool } = require('../lib/db/pg');
const { createExposure, verifyExposure, getExposureProvenance } = require('../lib/world/exposureRegistry');
const { computeSignalCandidatesForEvent, persistCandidates } = require('../lib/world/relevance');

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
  const results = { A: null, B: null, C: null };
  const runTag = `phase3a-proof-${Date.now()}`;

  // ── Fixture tenants (direct SQL for tenant/fixture-row creation only) ──
  const tenantAId = await ensureTestUser(pool, `${runTag}-tenant-a@test.starlane.local`, 'Phase3A Proof Tenant A');
  const tenantBId = await ensureTestUser(pool, `${runTag}-tenant-b@test.starlane.local`, 'Phase3A Proof Tenant B (zero exposure)');

  const supplierRes = await pool.query(
    `INSERT INTO suppliers (user_id, name) VALUES ($1, $2) RETURNING id`,
    [tenantAId, `${runTag} China Supplier`]
  );
  const supplierId = supplierRes.rows[0].id;

  const purchaseColsRes = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name='purchases'`);
  const purchaseCols = new Set(purchaseColsRes.rows.map(r => r.column_name));
  const insertCols = ['user_id', 'supplier_id'];
  const insertVals = [tenantAId, supplierId];
  if (purchaseCols.has('supplier_name')) { insertCols.push('supplier_name'); insertVals.push(`${runTag} China Supplier`); }
  if (purchaseCols.has('total_amount')) { insertCols.push('total_amount'); insertVals.push(1000); }
  else if (purchaseCols.has('amount')) { insertCols.push('amount'); insertVals.push(1000); }
  const placeholders = insertVals.map((_, i) => `$${i + 1}`).join(',');
  const purchaseRes = await pool.query(
    `INSERT INTO purchases (${insertCols.join(',')}) VALUES (${placeholders}) RETURNING id`,
    insertVals
  );
  const purchaseId = purchaseRes.rows[0].id;

  // ── Real Phase 1 events to target ──
  const eqRes = await pool.query(
    `SELECT id, title, country_codes, observed_at FROM world_events
     WHERE event_type = 'NATURAL_HAZARD' AND 'CN' = ANY(country_codes)
     ORDER BY observed_at DESC LIMIT 1`
  );
  if (eqRes.rows.length === 0) throw new Error('Phase 12 proof requires at least one real ingested China earthquake event — none found. Run scripts/world-ingest-once.js first.');
  const earthquake = eqRes.rows[0];

  const fxRes = await pool.query(
    `SELECT id, title, observed_at FROM world_events
     WHERE event_type = 'MACROECONOMICS' AND title ILIKE 'EUR/AUD%'
     ORDER BY observed_at DESC LIMIT 1`
  );
  if (fxRes.rows.length === 0) throw new Error('Phase 12 proof requires a real ingested EUR/AUD FX event — none found. Run scripts/world-ingest-once.js first.');
  const fxEvent = fxRes.rows[0];

  console.log('Real earthquake event:', earthquake.title, earthquake.id);
  console.log('Real FX event:', fxEvent.title, fxEvent.id);

  // ── (A) Geography exposure via the REAL write API ──
  const geoExposure = await createExposure(tenantAId, {
    businessEntityType: 'supplier',
    businessEntityId: supplierId,
    exposureType: 'LOCATED_IN',
    rawValue: 'China',
    kind: 'country',
    provenanceType: 'OWNER_ENTERED',
    provenanceReference: `${runTag}:geo`,
    evidenceNotes: 'Phase 12 proof: tenant A supplier located in China',
    validFrom: '2020-01-01T00:00:00Z', // backdated so it is valid at the time of the already-ingested real earthquake event
  });
  console.log('Created geo exposure (UNVERIFIED):', geoExposure.id, 'verification_status=', geoExposure.verification_status);

  const geoBeforeVerify = await computeSignalCandidatesForEvent(earthquake.id, tenantAId);
  console.log('Candidates BEFORE verify (must be 0):', geoBeforeVerify.length);

  const verifiedGeo = await verifyExposure(tenantAId, geoExposure.id);
  console.log('Verified geo exposure:', verifiedGeo.id, 'verification_status=', verifiedGeo.verification_status);

  const geoCandidates = await computeSignalCandidatesForEvent(earthquake.id, tenantAId);
  const geoPersisted = await persistCandidates(geoCandidates);
  results.A = {
    exposureId: geoExposure.id,
    beforeVerifyCandidateCount: geoBeforeVerify.length,
    afterVerifyCandidateCount: geoCandidates.length,
    signalsCreated: geoPersisted.length,
    provenance: await getExposureProvenance(tenantAId, geoExposure.id),
  };
  console.log('(A) Geography -> earthquake signal candidates after verify:', geoCandidates.length, 'persisted signals:', geoPersisted.length);

  // ── (B) Currency exposure via the REAL write API ──
  const currExposure = await createExposure(tenantAId, {
    businessEntityType: 'purchase',
    businessEntityId: purchaseId,
    exposureType: 'CURRENCY_DENOMINATED',
    rawValue: 'AUD',
    kind: 'currency',
    provenanceType: 'OWNER_ENTERED',
    provenanceReference: `${runTag}:currency`,
    evidenceNotes: 'Phase 12 proof: tenant A purchase denominated in AUD',
    validFrom: '2020-01-01T00:00:00Z',
  });
  const currBeforeVerify = await computeSignalCandidatesForEvent(fxEvent.id, tenantAId);
  await verifyExposure(tenantAId, currExposure.id);
  const currCandidates = await computeSignalCandidatesForEvent(fxEvent.id, tenantAId);
  const currPersisted = await persistCandidates(currCandidates);
  results.B = {
    exposureId: currExposure.id,
    beforeVerifyCandidateCount: currBeforeVerify.length,
    afterVerifyCandidateCount: currCandidates.length,
    signalsCreated: currPersisted.length,
  };
  console.log('(B) Currency -> FX signal candidates after verify:', currCandidates.length, 'persisted signals:', currPersisted.length);

  // ── (C) Zero-exposure tenant gets zero signals from the SAME real events ──
  const tenantBGeoCandidates = await computeSignalCandidatesForEvent(earthquake.id, tenantBId);
  const tenantBFxCandidates = await computeSignalCandidatesForEvent(fxEvent.id, tenantBId);
  results.C = {
    tenantBGeoCandidateCount: tenantBGeoCandidates.length,
    tenantBFxCandidateCount: tenantBFxCandidates.length,
  };
  console.log('(C) Tenant B (zero exposures) candidates from same earthquake:', tenantBGeoCandidates.length, 'from same FX event:', tenantBFxCandidates.length);

  const pass =
    results.A.beforeVerifyCandidateCount === 0 &&
    results.A.afterVerifyCandidateCount > 0 &&
    results.A.signalsCreated > 0 &&
    results.B.beforeVerifyCandidateCount === 0 &&
    results.B.afterVerifyCandidateCount > 0 &&
    results.B.signalsCreated > 0 &&
    results.C.tenantBGeoCandidateCount === 0 &&
    results.C.tenantBFxCandidateCount === 0;

  console.log('\n=== PHASE 12 PROOF RESULT:', pass ? 'PASS' : 'FAIL', '===');
  console.log(JSON.stringify(results, null, 2));

  // ── Cleanup: remove every row this proof created, verify zero residue ──
  await pool.query(`DELETE FROM business_signal_status_history WHERE signal_id IN (SELECT id FROM business_signals WHERE user_id = ANY($1::uuid[]))`, [[tenantAId, tenantBId]]);
  await pool.query(`DELETE FROM business_signals WHERE user_id = ANY($1::uuid[])`, [[tenantAId, tenantBId]]);
  await pool.query(`DELETE FROM business_exposure_candidates WHERE user_id = ANY($1::uuid[])`, [[tenantAId, tenantBId]]);
  await pool.query(`DELETE FROM business_exposure WHERE user_id = ANY($1::uuid[])`, [[tenantAId, tenantBId]]);
  await pool.query(`DELETE FROM purchases WHERE user_id = ANY($1::uuid[])`, [[tenantAId, tenantBId]]);
  await pool.query(`DELETE FROM suppliers WHERE user_id = ANY($1::uuid[])`, [[tenantAId, tenantBId]]);
  await pool.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[tenantAId, tenantBId]]);

  const residue = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM business_exposure WHERE user_id = ANY($1::uuid[])) AS bexp,
       (SELECT COUNT(*) FROM business_exposure_candidates WHERE user_id = ANY($1::uuid[])) AS bcand,
       (SELECT COUNT(*) FROM business_signals WHERE user_id = ANY($1::uuid[])) AS bsig,
       (SELECT COUNT(*) FROM users WHERE id = ANY($1::uuid[])) AS usr`,
    [[tenantAId, tenantBId]]
  );
  const r = residue.rows[0];
  const clean = Number(r.bexp) === 0 && Number(r.bcand) === 0 && Number(r.bsig) === 0 && Number(r.usr) === 0;
  console.log('Cleanup residue check (all must be 0):', r, clean ? 'CLEAN' : 'RESIDUE LEFT BEHIND');

  process.exit(pass && clean ? 0 : 1);
}

main().catch(e => { console.error('PROOF SCRIPT ERROR:', e); process.exit(1); });
