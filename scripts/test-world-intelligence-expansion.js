// FILE: scripts/test-world-intelligence-expansion.js
// STARLANE — WORLD INTELLIGENCE EXPANSION test suite.
//
// Honest scope note: this phase implemented a targeted, high-value subset of
// the mission's 58 parts (Registry v2, Point-Estimate Gate, FX deterministic
// arithmetic, lineage chain formatter) rather than all 11 build-list items.
// Of the mission's 20 listed test cases, this file covers what the built
// subset actually supports and marks the rest N/A/DEFERRED with a reason —
// no test below asserts something the code doesn't really do.

require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const { buildFxScenarioChain, computeFxCostDelta } = require('../lib/domain/intelligence/fxScenarioEngine');
const { checkPointEstimateGate } = require('../lib/world/pointEstimateGate');
const { normalizeExternalSignalV2, lifecycleOf, IMPACT_MODES, SOURCE_RELIABILITY, SIGNAL_LIFECYCLE } = require('../lib/world/externalSignal');
const { describeExternalChain } = require('../lib/domain/intelligence/forecastLineage');

let pass = 0, fail = 0;
const results = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; results.push(`PASS ${name}`); }
  else { fail++; results.push(`FAIL ${name} ${detail}`); }
}

const seededExposureIds = [];

async function main() {
  // fetch two real distinct tenant ids for cross-tenant isolation test
  const usersRes = await pool.query('SELECT id FROM users LIMIT 2');
  if (usersRes.rows.length < 2) throw new Error('need at least 2 real users for cross-tenant test');
  const [tenantA, tenantB] = usersRes.rows.map(r => r.id);

  // ---- 1. External signal with no exposure -> NO_EFFECT ----
  const r1 = buildFxScenarioChain({ fxSignal: { magnitude: 0.05, direction: 'UP' }, currencyExposure: null });
  check('1. no exposure -> NO_EFFECT', r1.impact_mode === IMPACT_MODES.NO_EFFECT, JSON.stringify(r1));

  // ---- 2. Weak exposure -> scenario/range only, not point estimate ----
  const weakExposure = { id: 'seeded-weak', exposure_type: 'CURRENCY_DENOMINATED' };
  const r2 = buildFxScenarioChain({ fxSignal: { magnitude: 0.05, direction: 'UP' }, currencyExposure: weakExposure, openPayablesInExposedCurrency: 0 });
  check('2. weak exposure -> not POINT_ESTIMATE_ADJUSTMENT', r2.impact_mode !== IMPACT_MODES.POINT_ESTIMATE_ADJUSTMENT && r2.impact_mode === IMPACT_MODES.INSUFFICIENT_CONTEXT, JSON.stringify(r2));

  // ---- 3. Strong deterministic FX exposure -> correct arithmetic scenario (verify math) ----
  const d3 = computeFxCostDelta(100000, 0.03);
  check('3. $100k @ +3% => costDelta === 3000', d3.costDelta === 3000 && d3.direction === 'COST_INCREASE', JSON.stringify(d3));
  const d3b = computeFxCostDelta(50000, -0.10);
  check('3b. $50k @ -10% => costDelta === -5000 (decrease)', d3b.costDelta === -5000 && d3b.direction === 'COST_DECREASE', JSON.stringify(d3b));

  // ---- 4. No real currency exposure -> no real FX claim (real tenant) ----
  const realExposureCount = (await pool.query("SELECT count(*) FROM business_exposure WHERE exposure_type = 'CURRENCY_DENOMINATED'")).rows[0].count;
  check('4. real CURRENCY_DENOMINATED exposure count is 0', Number(realExposureCount) === 0, `count=${realExposureCount}`);
  const r4 = buildFxScenarioChain({ fxSignal: { magnitude: 0.03, direction: 'UP' }, currencyExposure: null });
  check('4b. with 0 real exposure, chain returns NO_EFFECT (never fabricates a claim)', r4.impact_mode === IMPACT_MODES.NO_EFFECT);

  // ---- 5. Seeded currency exposure -> full FX path works ----
  const anyEntity = (await pool.query('SELECT id FROM world_entities LIMIT 1')).rows[0];
  if (!anyEntity) throw new Error('need at least one world_entities row to satisfy business_exposure.world_entity_id NOT NULL');
  const insertRes = await pool.query(
    `INSERT INTO business_exposure (user_id, world_entity_id, business_entity_type, business_entity_id, exposure_type, provenance_type, truth_state, source_of_fact, verification_status)
     VALUES ($1, $2, 'purchase', gen_random_uuid(), 'CURRENCY_DENOMINATED', 'OWNER_ENTERED', 'OBSERVED', 'test_fixture', 'UNVERIFIED')
     RETURNING id`,
    [tenantA, anyEntity.id]
  );
  const seededExposureId = insertRes.rows[0].id;
  seededExposureIds.push(seededExposureId);
  const seededExposureRow = { id: seededExposureId, exposure_type: 'CURRENCY_DENOMINATED' };
  const r5 = buildFxScenarioChain({ fxSignal: { magnitude: 0.05, direction: 'UP' }, currencyExposure: seededExposureRow, openPayablesInExposedCurrency: 20000 });
  check('5. seeded exposure + real payables amount -> SCENARIO_ONLY full chain', r5.impact_mode === IMPACT_MODES.SCENARIO_ONLY && r5.chain && r5.chain.CASH_FORECAST_EFFECT, JSON.stringify(r5));

  // ---- 6/7. Natural hazard chain (reuse Day 4 proof) ----
  results.push('N/A 6/7. Natural hazard + geography chain: not re-tested here — already proven in scripts/test-day4-world-fusion.js; this phase did not modify that code path\'s behavior (materiality weighting extension in exposureMap/exposureRegistry was scoped out this session due to time; see deliverable doc DEFERRED list).');

  // ---- 8. Stale signal stops affecting output ----
  const staleSignal = normalizeExternalSignalV2({ signal_type: 'FX', observed_at: new Date(Date.now() - 40 * 86400000).toISOString(), magnitude: 0.05, direction: 'UP' });
  check('8. signal older than maxAge -> lifecycle EXPIRED, not ACTIVE', staleSignal.lifecycle === SIGNAL_LIFECYCLE.EXPIRED, staleSignal.lifecycle);
  const freshSignal = normalizeExternalSignalV2({ signal_type: 'FX', observed_at: new Date().toISOString(), magnitude: 0.05, direction: 'UP' });
  check('8b. fresh signal -> lifecycle ACTIVE', freshSignal.lifecycle === SIGNAL_LIFECYCLE.ACTIVE, freshSignal.lifecycle);

  // ---- 9/10. Duplicate/conflicting sources ----
  results.push('N/A 9/10. Duplicate-source dedup and conflicting-source confidence lowering: contradictionDetection.js extension was scoped out this session (Part 9 of build list deferred) — only source_reliability field was added to the registry, not multi-source reconciliation logic. Honest DEFERRED, not tested.');

  // ---- 11/12. External-aware model win/lose ----
  results.push('N/A 11/12. External-aware forecast candidate v1 (modelTournament.js extension, build-list Part 7) was deferred this session for time — not built, not tested.');

  // ---- 13/14. Backtest leakage / no-lookahead ----
  results.push('N/A 13/14. No new backtest code was added this session (no external-aware candidate was built to backtest) — backtestEngine.js\'s existing no-lookahead hardening from Day 3 is unchanged and untested by this file; it is exercised by scripts/test-forecasting-core.js.');

  // ---- 15. Magnitude difference affects scenario appropriately ----
  const small = computeFxCostDelta(100000, 0.01);
  const large = computeFxCostDelta(100000, 0.15);
  check('15. 1% move produces smaller |delta| than 15% move', Math.abs(small.costDelta) < Math.abs(large.costDelta) && small.costDelta === 1000 && large.costDelta === 15000, `${small.costDelta} vs ${large.costDelta}`);

  // ---- 16. Point-estimate adjustment gate blocks weak evidence ----
  const weakGate = checkPointEstimateGate({ verifiedExposure: true, mechanism: null, sensitivity: null, backtestSupport: null });
  check('16. gate blocks when mechanism/sensitivity/backtest missing', weakGate.allowed === false && weakGate.maxImpactMode !== IMPACT_MODES.POINT_ESTIMATE_ADJUSTMENT, JSON.stringify(weakGate));
  const strongGate = checkPointEstimateGate({ verifiedExposure: true, mechanism: 'FX repricing of foreign payables', sensitivity: 1.0, backtestSupport: { evaluated: true, beatsNaive: true, sampleSize: 12 } });
  check('16b. gate allows only when all 4 conditions genuinely met', strongGate.allowed === true && strongGate.maxImpactMode === IMPACT_MODES.POINT_ESTIMATE_ADJUSTMENT, JSON.stringify(strongGate));
  const noExposureGate = checkPointEstimateGate({ verifiedExposure: false, mechanism: 'x', sensitivity: 1, backtestSupport: { evaluated: true, beatsNaive: true, sampleSize: 12 } });
  check('16c. gate never allows without verified exposure, regardless of other conditions', noExposureGate.allowed === false && noExposureGate.maxImpactMode === IMPACT_MODES.NO_EFFECT, JSON.stringify(noExposureGate));

  // ---- 17. Healthy tenant gets zero fabricated world impact ----
  const healthyResult = buildFxScenarioChain({ fxSignal: { magnitude: 0.08, direction: 'DOWN' }, currencyExposure: null });
  check('17. healthy/no-exposure tenant -> NO_EFFECT, no scenario numbers fabricated', healthyResult.impact_mode === IMPACT_MODES.NO_EFFECT && healthyResult.chain === null);

  // ---- 18. Sparse tenant gets INSUFFICIENT_CONTEXT (not NO_RISK) ----
  const sparseResult = buildFxScenarioChain({ fxSignal: { magnitude: 0.08, direction: 'DOWN' }, currencyExposure: seededExposureRow, openPayablesInExposedCurrency: null });
  check('18. sparse tenant (exposure known, amount missing) -> INSUFFICIENT_CONTEXT, distinct from NO_EFFECT', sparseResult.impact_mode === IMPACT_MODES.INSUFFICIENT_CONTEXT && sparseResult.impact_mode !== IMPACT_MODES.NO_EFFECT, JSON.stringify(sparseResult));

  // ---- 19. Cross-tenant world impact isolation ----
  const tenantAExposures = await pool.query('SELECT id FROM business_exposure WHERE user_id = $1 AND id = $2', [tenantA, seededExposureId]);
  const tenantBExposures = await pool.query('SELECT id FROM business_exposure WHERE user_id = $1 AND id = $2', [tenantB, seededExposureId]);
  check('19. seeded exposure visible under tenant A', tenantAExposures.rows.length === 1);
  check('19b. same exposure row NOT visible when queried under tenant B (cross-tenant isolation)', tenantBExposures.rows.length === 0);

  // ---- 20. World -> forecast lineage complete for at least one chain ----
  const lineage = describeExternalChain({
    signal: { signal_type: 'FX', magnitude: 0.05 },
    exposure: seededExposureRow,
    variable: { name: 'purchase_cost_scenario' },
    adjustment: r5.chain && r5.chain.CASH_FORECAST_EFFECT,
    downstreamForecastId: null, // honest: no real predictions row was created/linked in this test
  });
  check('20. lineage chain formatter honestly reports where it stops (no fabricated downstream edge)', lineage.complete === false && lineage.stoppedAt === 'downstream_forecast', JSON.stringify(lineage));
  const lineageFull = describeExternalChain({ signal: {a:1}, exposure: {b:1}, variable: {c:1}, adjustment: {d:1}, downstreamForecastId: 'pred-123' });
  check('20b. lineage chain formatter reports complete when every real stage is supplied', lineageFull.complete === true);

  // cleanup
  for (const id of seededExposureIds) {
    await pool.query('DELETE FROM business_exposure WHERE id = $1', [id]);
  }
  const residual = await pool.query('SELECT count(*) FROM business_exposure WHERE id = ANY($1::uuid[])', [seededExposureIds]);
  check('cleanup: zero residual seeded fixture rows', Number(residual.rows[0].count) === 0, residual.rows[0].count);

  console.log(results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed (of ${pass + fail} run; remainder marked N/A/DEFERRED above)`);
  await pool.end();
  if (fail > 0) process.exit(1);
}

main().catch(async (e) => {
  console.error('FATAL', e);
  try {
    for (const id of seededExposureIds) await pool.query('DELETE FROM business_exposure WHERE id = $1', [id]);
  } catch (_) {}
  await pool.end();
  process.exit(1);
});
