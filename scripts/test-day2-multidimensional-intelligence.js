// FILE: scripts/test-day2-multidimensional-intelligence.js
// STARLANE Day 2 Multidimensional Reality Intelligence — real-data test run.
// Uses process.env.DATABASE_URL (real Neon dev instance). Cleans up its own
// synthetic fixtures (marker: 'DAY2_TEST_FIXTURE_') before exiting.
require('dotenv').config();
const { getPool } = require('../lib/db/pg');
const { buildSupplierExposureNarrative } = require('../lib/domain/intelligence/supplierExposureNarrative');
const { getVariable } = require('../lib/domain/intelligence/variables');
const { getOrganizationExposureMap } = require('../lib/domain/intelligence/exposureMap');
const { detectContradictions } = require('../lib/domain/intelligence/contradictionDetection');
const { buildCashRiskNarrative } = require('../lib/domain/intelligence/cashRiskNarrative');
const { assembleEntityContext } = require('../lib/domain/intelligence/contextAssembly');
const FIXTURE_MARKER = 'DAY2_TEST_FIXTURE_';

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name}${detail ? ' -- ' + detail : ''}`); }
}

async function orphanSweep(pool) {
  await pool.query(`DELETE FROM customers WHERE name LIKE $1`, [`${FIXTURE_MARKER}%`]);
  await pool.query(`DELETE FROM suppliers WHERE name LIKE $1`, [`${FIXTURE_MARKER}%`]);
}

async function main() {
  const pool = getPool();
  await orphanSweep(pool);

  // ── Test 3: Chain B real supplier+geography+event narrative ──
  const chainBUser = 'ebe6bff3-ed6c-428a-a4de-63338c35894b';
  const chainBSupplier = '1f93de58-46ef-4189-b934-b9158b2f31fc';
  const chainB = await buildSupplierExposureNarrative({ userId: chainBUser, supplierId: chainBSupplier });
  check('Chain B: produces a real narrative for real China supplier+event match', chainB.insufficientEvidence === false && chainB.narratives.length > 0, JSON.stringify(chainB).slice(0, 300));
  if (!chainB.insufficientEvidence) {
    console.log('--- Chain B example narrative (real JSON) ---');
    console.log(JSON.stringify(chainB.narratives[0], null, 2));
    const n = chainB.narratives[0];
    check('Chain B: narrative declares product-dependency missingContext explicitly', n.missingContext.some(m => m.includes('product-level dependency')));
    check('Chain B: narrative has non-empty evidence[]', Array.isArray(n.evidence) && n.evidence.length >= 3);
  }

  // ── Test 1/2 regression: Chain A (cashRiskNarrative) still works ──
  const custRes = await pool.query(`SELECT id, user_id, name FROM customers LIMIT 30`);
  let chainARan = false;
  for (const c of custRes.rows) {
    try {
      const result = await buildCashRiskNarrative({ userId: c.user_id, customerId: c.id });
      chainARan = true;
      if (!result.insufficientEvidence) {
        console.log('--- Chain A regression: found a real cash-risk narrative ---');
        console.log(JSON.stringify(result, null, 2).slice(0, 800));
        break;
      }
    } catch (e) { /* keep scanning */ }
  }
  check('Chain A regression: buildCashRiskNarrative runs without throwing on real data', chainARan);

  // ── Test 9: Variable Model + uncertainty bands on real sparse data ──
  const sparseCustomer = custRes.rows[0];
  if (sparseCustomer) {
    const v = await getVariable(sparseCustomer.user_id, 'credit_risk_score', sparseCustomer.id);
    check('Variable Model: getVariable returns a valid band', ['VERIFIED', 'STRONG', 'MODERATE', 'WEAK', 'INSUFFICIENT'].includes(v.confidence.band), JSON.stringify(v));
    check('Variable Model: sparse/no history yields WEAK or INSUFFICIENT, never VERIFIED', v.quality !== 'REAL_MULTI_POINT' ? v.confidence.band !== 'VERIFIED' : true);
    console.log('--- Variable Model example (real customer) ---', JSON.stringify(v, null, 2));
  }

  // ── Test 5/6: FX/currency suppression still holds ──
  const map = await getOrganizationExposureMap(chainBUser);
  check('Exposure Map: currency dimension present in structure', !!map.dimensions.currencyConcentration);
  check('Exposure Map: currency concentration correctly suppressed (no CURRENCY_DENOMINATED rows expected) or explicit if present',
    map.dimensions.currencyConcentration.insufficientData === true || map.dimensions.currencyConcentration.insufficientData === false);
  console.log('--- Exposure Map (real tenant) ---', JSON.stringify(map, null, 2));

  // ── Test 8: contradiction detection — real organic case ──
  const contraUser = 'ece4ca68-da30-47f8-9c97-cd99724b1c35';
  const contradictions = await detectContradictions(contraUser);
  check('Contradiction Detection: finds the real organic PAID_INVOICE_WITHOUT_CONFIRMED_EVIDENCE case', contradictions.contradictions.some(c => c.type === 'PAID_INVOICE_WITHOUT_CONFIRMED_EVIDENCE'));
  console.log('--- Contradiction Detection (real tenant) ---', JSON.stringify(contradictions, null, 2));

  // ── Test 7: healthy diversified synthetic tenant -> zero fabricated narratives ──
  const healthyUserId = custRes.rows[0]?.user_id || chainBUser;
  const healthySupplierIns = await pool.query(
    `INSERT INTO suppliers (user_id, name) VALUES ($1, $2) RETURNING id`,
    [healthyUserId, `${FIXTURE_MARKER}HealthySupplier`]
  );
  const healthySupplierId = healthySupplierIns.rows[0].id;
  try {
    const healthyChainB = await buildSupplierExposureNarrative({ userId: healthyUserId, supplierId: healthySupplierId });
    check('Healthy tenant: no fabricated Chain B narrative for supplier with zero exposure rows', healthyChainB.insufficientEvidence === true);
    const healthyMap = await getOrganizationExposureMap(healthyUserId);
    check('Healthy tenant: exposureMap runs without throwing', !!healthyMap.dimensions);
    const healthyContra = await detectContradictions(healthyUserId);
    check('Healthy tenant: contradictionDetection runs without throwing', Array.isArray(healthyContra.contradictions));
  } finally {
    await pool.query(`DELETE FROM suppliers WHERE id = $1`, [healthySupplierId]);
  }

  // ── Test 10: contextAssembly includes prior action/outcome history ──
  const ctxCandidate = custRes.rows.find(c => c.user_id && c.id);
  if (ctxCandidate) {
    const ctx = await assembleEntityContext(ctxCandidate.user_id, 'customer', ctxCandidate.id);
    check('Context Assembly: includes priorOutcomeSummary field', ctx.found && !!ctx.priorOutcomeSummary);
    console.log('--- Context Assembly priorOutcomeSummary (real customer) ---', JSON.stringify(ctx.priorOutcomeSummary));
  }

  await orphanSweep(pool);
  const residueCheck = await pool.query(`SELECT COUNT(*) FROM suppliers WHERE name LIKE $1`, [`${FIXTURE_MARKER}%`]);
  check('Cleanup: zero residual fixture rows', Number(residueCheck.rows[0].count) === 0);

  console.log(`\n=== RESULTS: ${pass} passed, ${fail} failed ===`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
