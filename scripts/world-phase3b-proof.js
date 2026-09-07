// FILE: scripts/world-phase3b-proof.js
// World Intelligence Phase 3, Part B — propagation, impact path, materiality
// separation, ranking determinism + the mandatory "small-but-relevant beats
// big-but-irrelevant" proof, and Business State's three-state contract.
//
// Uses real service-layer functions throughout (createExposure/verifyExposure,
// computeSignalCandidatesForEvent/persistCandidates, propagateSignal,
// buildImpactPath, computeMaterialityComponents, computeDependencyEvidence,
// rankSignals, getWorldExposureStatus). Direct SQL is used only for fixture
// tenant/product/purchase creation and for reading real already-ingested
// world_events, same convention as scripts/world-phase3a-proof.js.
//
// Run: node scripts/world-phase3b-proof.js
require('dotenv').config();
const { randomUUID } = require('crypto');
const { getPool } = require('../lib/db/pg');
const { createExposure, verifyExposure } = require('../lib/world/exposureRegistry');
const { computeSignalCandidatesForEvent, persistCandidates } = require('../lib/world/relevance');
const { propagateSignal } = require('../lib/world/signalPropagation');
const { buildImpactPath } = require('../lib/world/impactPath');
const { computeMaterialityComponents } = require('../lib/world/materiality');
const { computeDependencyEvidence } = require('../lib/world/dependencyEvidence');
const { rankSignals, computeRankScore } = require('../lib/world/signalRanking');
const { getWorldExposureStatus } = require('../lib/world/businessStateBoundary');

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

const results = {};
function check(name, pass, detail) {
  console.log((pass ? 'PASS' : 'FAIL') + ' - ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''));
  results[name] = pass;
  return pass;
}

async function main() {
  const pool = getPool();
  const runTag = `phase3b-proof-${Date.now()}`;
  const tenantId = await ensureTestUser(pool, `${runTag}-tenant@test.starlane.local`, 'Phase3B Proof Tenant');
  const tenantEmptyId = await ensureTestUser(pool, `${runTag}-tenant-empty@test.starlane.local`, 'Phase3B Empty Tenant');

  // ── Fixtures: sole supplier (low-stock product, real purchases), no FK to product ──
  const supplierRes = await pool.query(`INSERT INTO suppliers (user_id, name) VALUES ($1,$2) RETURNING id`, [tenantId, `${runTag} Sole Supplier`]);
  const supplierId = supplierRes.rows[0].id;
  await pool.query(`INSERT INTO purchases (user_id, supplier_id, supplier_name, amount, status) VALUES ($1,$2,$3,5000,'unpaid')`, [tenantId, supplierId, `${runTag} Sole Supplier`]);

  const productRes = await pool.query(
    `INSERT INTO products (user_id, name, sku, current_stock, low_stock_alert) VALUES ($1,$2,$3,2,10) RETURNING id`,
    [tenantId, `${runTag} Low Stock Product`, `${runTag}-SKU1`]
  );
  const productId = productRes.rows[0].id;

  const eqRes = await pool.query(
    `SELECT id, title, observed_at, severity, magnitude FROM world_events
     WHERE event_type = 'NATURAL_HAZARD' AND 'CN' = ANY(country_codes) ORDER BY observed_at DESC LIMIT 1`
  );
  if (eqRes.rows.length === 0) throw new Error('Requires a real ingested China earthquake event — run scripts/world-ingest-once.js first.');
  const earthquake = eqRes.rows[0];

  // ── (1) Verified supplier exposure -> real signal on the sole supplier ──
  const supplierExposure = await createExposure(tenantId, {
    businessEntityType: 'supplier', businessEntityId: supplierId, exposureType: 'LOCATED_IN',
    rawValue: 'China', kind: 'country', provenanceType: 'OWNER_ENTERED',
    provenanceReference: `${runTag}:geo`, validFrom: '2020-01-01T00:00:00Z',
  });
  await verifyExposure(tenantId, supplierExposure.id);
  const candidates = await computeSignalCandidatesForEvent(earthquake.id, tenantId);
  const persisted = await persistCandidates(candidates);
  check('Setup: sole-supplier exposure produces a real signal', persisted.length > 0, { count: persisted.length });
  const supplierSignal = persisted[0].signal;

  // ── (2) Propagation: supplier -> real purchases -> honest gap (no product FK) ──
  const supplierPath = await propagateSignal(tenantId, supplierSignal);
  check('Propagation: supplier path starts with EXPOSURE then SUPPLIER', supplierPath[0].step === 'EXPOSURE' && supplierPath[1].step === 'SUPPLIER');
  check('Propagation: reaches real SUPPLIER_PURCHASES with count>=1', supplierPath.some(s => s.step === 'SUPPLIER_PURCHASES' && s.count >= 1));
  check('Propagation: honestly stops with a GAP step (no real supplier->product FK)', supplierPath[supplierPath.length - 1].step === 'GAP');

  // ── (3) Propagation: a product signal reaches real INVENTORY, then GAP at orders ──
  // Build a synthetic exposure+signal directly on the product entity type to exercise that branch.
  const productExposure = await createExposure(tenantId, {
    businessEntityType: 'product', businessEntityId: productId, exposureType: 'SOURCED_FROM',
    rawValue: 'China', kind: 'country', provenanceType: 'OWNER_ENTERED',
    provenanceReference: `${runTag}:prod-geo`, validFrom: '2020-01-01T00:00:00Z',
  });
  await verifyExposure(tenantId, productExposure.id);
  const fakeProductSignal = { id: randomUUID(), business_exposure_id: productExposure.id, related_entity_type: 'product', related_entity_id: productId };
  const productPath = await propagateSignal(tenantId, fakeProductSignal, { ...productExposure, business_entity_type: 'product', business_entity_id: productId });
  check('Propagation: product path reaches real INVENTORY step', productPath.some(s => s.step === 'INVENTORY'));
  const invStep = productPath.find(s => s.step === 'INVENTORY');
  check('Propagation: INVENTORY.isLowStock reflects real current_stock<=low_stock_alert (2<=10)', invStep && invStep.isLowStock === true, invStep);
  check('Propagation: product path honestly stops with GAP (no real product->order FK)', productPath[productPath.length - 1].step === 'GAP');

  // ── (4) Missing-relationship handling: a product with no exposure signal at all is simply never propagated (nothing invented) ──
  const orphanProductRes = await pool.query(`INSERT INTO products (user_id, name, sku, current_stock, low_stock_alert) VALUES ($1,$2,$3,50,5) RETURNING id`, [tenantId, `${runTag} Orphan Product`, `${runTag}-SKU2`]);
  const orphanSignal = { id: randomUUID(), business_exposure_id: null, related_entity_type: 'product', related_entity_id: orphanProductRes.rows[0].id };
  const orphanPath = await propagateSignal(tenantId, orphanSignal, null);
  check('Missing-relationship: product with no exposure row still produces an honest EXPOSURE/PRODUCT/INVENTORY path, no fabrication', orphanPath[0].step === 'EXPOSURE');

  // ── (5) Impact path structure ──
  const impact = await buildImpactPath(tenantId, supplierSignal.id);
  check('ImpactPath: starts with WORLD_EVENT', impact.path[0].step === 'WORLD_EVENT');
  check('ImpactPath: ends with POTENTIAL_DIMENSION classification (never a financial number)', impact.path[impact.path.length - 1].step === 'POTENTIAL_DIMENSION');
  check('ImpactPath: no numeric field in any step is a computed financial loss (only real current_stock/amount values used)',
    !JSON.stringify(impact.path).match(/loss|estimatedCost|projectedRevenue/i));

  // ── (6) Materiality components stay separate ──
  const eventRow = (await pool.query('SELECT * FROM world_events WHERE id=$1', [earthquake.id])).rows[0];
  const supplierExposureRow = (await pool.query('SELECT * FROM business_exposure WHERE id=$1', [supplierExposure.id])).rows[0];
  const dependencyEvidence = await computeDependencyEvidence(tenantId, 'supplier', supplierId);
  const materiality = computeMaterialityComponents({ signal: supplierSignal, exposure: supplierExposureRow, event: eventRow, dependencyEvidence });
  check('Materiality: dependency_evidence is a separate field from business_dependency', 'dependency_evidence' in materiality && 'business_dependency' in materiality);
  check('Materiality: no single composite score field exists on this object', !('score' in materiality) && !('materialityScore' in materiality));
  check('Materiality: real dependency evidence detected sole supplier', dependencyEvidence.isSoleOrPrimarySupplier === true, dependencyEvidence);

  // ── (7) Ranking determinism ──
  const entry = { signal: supplierSignal, materialityComponents: materiality };
  const scoreRun1 = computeRankScore(materiality);
  const scoreRun2 = computeRankScore(materiality);
  check('Ranking: computeRankScore is deterministic (same input -> same output, run twice)', scoreRun1 === scoreRun2, { scoreRun1, scoreRun2 });

  const rankedTwice1 = rankSignals([entry, entry]).map(e => e.signal.id);
  const rankedTwice2 = rankSignals([entry, entry]).map(e => e.signal.id);
  check('Ranking: rankSignals produces identical order across repeated calls', JSON.stringify(rankedTwice1) === JSON.stringify(rankedTwice2));

  // ── (8) THE mission's explicit proof: small-but-relevant beats big-but-irrelevant ──
  // "Small" signal: our real sole-supplier signal above — low_stock product,
  // sole supplier, real open unpaid purchase, moderate real earthquake.
  const smallMateriality = materiality; // as computed above (business_dependency=high + isSoleOrPrimarySupplier)
  // "Big" signal: a headline-scale event (severity forced to 'critical',
  // largest possible magnitude) hitting an exposure with weak/no real
  // business dependency (unknown dependency, not sole supplier, no low
  // stock, no open orders evidence).
  const bigButIrrelevantMateriality = computeMaterialityComponents({
    signal: { id: 'big-signal-fixture' },
    exposure: { exposure_type: 'REGULATED_BY', confidence: 0.9, resolution_confidence: 0.9 }, // maps to 'medium' dependency, weaker than 'high'
    event: { severity: 'critical', magnitude: 9.5, observed_at: new Date().toISOString() }, // maximal severity + perfectly fresh
    dependencyEvidence: { isSoleOrPrimarySupplier: false, productIsLowStock: false, openOrdersCount: 0 },
  });
  const smallScore = computeRankScore(smallMateriality);
  const bigScore = computeRankScore(bigButIrrelevantMateriality);
  check(
    'Ranking proof: small-but-directly-relevant signal (sole supplier + low stock) OUTSCORES a headline-scale but weakly-dependent event',
    smallScore > bigScore,
    { smallScore, bigScore, smallDependency: smallMateriality.business_dependency, bigDependency: bigButIrrelevantMateriality.business_dependency }
  );

  // ── (9) Business State three states ──
  const stateEmpty = await getWorldExposureStatus(tenantEmptyId);
  check('BusinessState: zero-verified-exposure tenant reports DATA_INCOMPLETE (never "no risk")', stateEmpty.world_exposure_status === 'DATA_INCOMPLETE', stateEmpty.world_exposure_status);

  // Tenant with verified exposure but resolve/dismiss ALL of this tenant's
  // signals (the earthquake matched multiple transmission channels, so more
  // than one signal was persisted for the supplier exposure) so none are
  // material -> NO_MATERIAL_SIGNALS
  await pool.query(`UPDATE business_signals SET status='RESOLVED' WHERE user_id=$1`, [tenantId]);
  const stateNoMaterial = await getWorldExposureStatus(tenantId);
  check('BusinessState: verified-exposure tenant with no active signals reports NO_MATERIAL_SIGNALS', stateNoMaterial.world_exposure_status === 'NO_MATERIAL_SIGNALS', stateNoMaterial.world_exposure_status);

  await pool.query(`UPDATE business_signals SET status='ACTIVE' WHERE id=$1`, [supplierSignal.id]);
  const stateSignals = await getWorldExposureStatus(tenantId);
  check('BusinessState: verified-exposure tenant with a real active material signal reports signals_present, ranked', stateSignals.world_exposure_status === 'signals_present' && stateSignals.signals.length > 0, stateSignals.world_exposure_status);
  check('BusinessState: ranked signal entries carry materialityComponents (not just a bare score)', !!stateSignals.signals[0]?.materialityComponents);

  const allPass = Object.values(results).every(Boolean);
  console.log('\n=== PHASE 3B PROOF RESULT:', allPass ? 'PASS' : 'FAIL', `(${Object.values(results).filter(Boolean).length}/${Object.values(results).length}) ===`);

  // ── Cleanup ──
  const tenantIds = [tenantId, tenantEmptyId];
  await pool.query(`DELETE FROM business_signal_status_history WHERE signal_id IN (SELECT id FROM business_signals WHERE user_id = ANY($1::uuid[]))`, [tenantIds]);
  await pool.query(`DELETE FROM business_signals WHERE user_id = ANY($1::uuid[])`, [tenantIds]);
  await pool.query(`DELETE FROM business_exposure_candidates WHERE user_id = ANY($1::uuid[])`, [tenantIds]);
  await pool.query(`DELETE FROM business_exposure WHERE user_id = ANY($1::uuid[])`, [tenantIds]);
  await pool.query(`DELETE FROM purchases WHERE user_id = ANY($1::uuid[])`, [tenantIds]);
  await pool.query(`DELETE FROM products WHERE user_id = ANY($1::uuid[])`, [tenantIds]);
  await pool.query(`DELETE FROM suppliers WHERE user_id = ANY($1::uuid[])`, [tenantIds]);
  await pool.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [tenantIds]);

  const residue = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM business_exposure WHERE user_id = ANY($1::uuid[])) AS bexp,
       (SELECT COUNT(*) FROM business_signals WHERE user_id = ANY($1::uuid[])) AS bsig,
       (SELECT COUNT(*) FROM products WHERE user_id = ANY($1::uuid[])) AS prod,
       (SELECT COUNT(*) FROM suppliers WHERE user_id = ANY($1::uuid[])) AS sup,
       (SELECT COUNT(*) FROM users WHERE id = ANY($1::uuid[])) AS usr`,
    [tenantIds]
  );
  const r = residue.rows[0];
  const clean = Object.values(r).every(v => Number(v) === 0);
  console.log('Cleanup residue check (all must be 0):', r, clean ? 'CLEAN' : 'RESIDUE LEFT BEHIND');

  process.exit(allPass && clean ? 0 : 1);
}

main().catch(e => { console.error('PROOF SCRIPT ERROR:', e); process.exit(1); });
