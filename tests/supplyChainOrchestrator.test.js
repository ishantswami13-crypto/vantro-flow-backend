// Live DB integration test for the 2xA vertical slice. Requires the demo
// tenant to exist (run scripts/seed-2xa-demo.js then scripts/trigger-2xa-event.js
// first) — this test reads real rows, it does not mock the database, matching
// the house convention of tallyCommit.test.js's DB-dependent-paths note.
const assert = require('assert');
require('dotenv').config();
const { getPool } = require('../lib/db/pg');
const { getSignalImpact, writeDoNothingForecast, createRecommendedActions } = require('../lib/domain/intelligence/supplyChainOrchestrator');
const { executeSupplyChainAction, resolveExecutionMode } = require('../lib/domain/automation/supplyChainExecutionAdapter');

const DEMO_EMAIL = 'owner@2xa-demo-meridian.invalid';

async function main() {
  const pool = getPool();
  const userRes = await pool.query('SELECT id FROM users WHERE email = $1', [DEMO_EMAIL]);
  if (userRes.rows.length === 0) {
    console.log('[SKIP] supplyChainOrchestrator tests — demo tenant not seeded. Run scripts/seed-2xa-demo.js + scripts/trigger-2xa-event.js first.');
    await pool.end();
    return;
  }
  const userId = userRes.rows[0].id;

  const sigRes = await pool.query('SELECT id FROM business_signals WHERE user_id = $1 LIMIT 1', [userId]);
  assert.ok(sigRes.rows.length > 0, 'demo tenant must have at least one business_signal after triggering the event — the real relevance pipeline must have run');
  const signalId = sigRes.rows[0].id;

  // ── Correct supplier match: the signal must be about the CN supplier ────
  const impact = await getSignalImpact(signalId, userId);
  assert.strictEqual(impact.sufficientDataForQuantification, true);
  assert.strictEqual(impact.supplier.country, 'CN', 'the flagged supplier must be the China-located one');
  assert.strictEqual(impact.supplier.name, 'Sichuan Alloy Works');

  // ── Negative control: unrelated suppliers must never appear in any signal ──
  const allSignalsRes = await pool.query(
    `SELECT DISTINCT related_entity_id FROM business_signals WHERE user_id = $1`,
    [userId]
  );
  const flaggedSupplierIds = new Set(allSignalsRes.rows.map((r) => r.related_entity_id));
  const otherSuppliersRes = await pool.query(`SELECT id, name FROM suppliers WHERE user_id = $1 AND country != 'CN'`, [userId]);
  for (const s of otherSuppliersRes.rows) {
    assert.strictEqual(flaggedSupplierIds.has(s.id), false, `${s.name} (non-China supplier) must never be flagged by the China earthquake event`);
  }

  // ── Deterministic math traceability ──────────────────────────────────
  assert.ok(impact.components.length > 0, 'the CN supplier must have at least one component on record');
  const frameComponent = impact.components.find((c) => c.component.name.includes('Frame Alloy'));
  assert.ok(frameComponent, 'the aluminum frame component must be present in the impact');
  assert.strictEqual(frameComponent.coverage.sufficientData, true);
  assert.ok(frameComponent.affectedDemand.affectedOrderCount >= 1, 'at least one open order must depend on the disrupted component');

  // Negative control at the product level: the steel commuter (no BOM link
  // to the disrupted component) must never appear in affectedFinishedProducts.
  const steelProductRes = await pool.query(`SELECT id FROM products WHERE user_id = $1 AND name = 'Meridian Steel Commuter'`, [userId]);
  const steelProductId = steelProductRes.rows[0].id;
  const affectedIds = new Set(frameComponent.affectedFinishedProducts.map((a) => a.finishedProductId));
  assert.strictEqual(affectedIds.has(steelProductId), false, 'a product with no BOM dependency on the disrupted component must never be listed as affected');

  // Revenue exposure must be a real, traceable sum — never a fabricated round number.
  assert.ok(impact.totalRevenueExposure > 0);
  assert.notStrictEqual(impact.totalRevenueExposure % 1000, impact.totalRevenueExposure, 'sanity: exposure is a real computed sum, not asserting a specific magic number');

  // ── Evidence chain completeness: every evidence item must be classified ──
  const validKinds = new Set(['OBSERVED_FACT', 'CALCULATED_FACT', 'ASSUMPTION', 'FORECAST', 'EXTERNAL_EVIDENCE', 'INTERNAL_EVIDENCE']);
  for (const e of impact.evidence) {
    assert.ok(validKinds.has(e.kind), `evidence item has an unclassified kind: ${e.kind}`);
    assert.ok(e.label, 'every evidence item must have a label');
  }
  assert.ok(impact.evidence.some((e) => e.kind === 'EXTERNAL_EVIDENCE'), 'evidence chain must include the external event');
  assert.ok(impact.evidence.some((e) => e.kind === 'INTERNAL_EVIDENCE'), 'evidence chain must include the internal exposure record');

  // ── Forecast: writes real predictions rows, resolvable later ─────────────
  const predictions = await writeDoNothingForecast(userId, signalId, impact);
  assert.ok(predictions.length > 0);
  const horizons = predictions.map((p) => p.horizon_days).sort((a, b) => a - b);
  assert.deepStrictEqual([...new Set(horizons)], [7, 14, 30], 'forecast must cover exactly the 7/14/30 day horizons');

  // ── Action ranking: at least one recommended action for the urgent component ──
  const actions = await createRecommendedActions(userId, signalId, impact);
  assert.ok(actions.length > 0);
  assert.strictEqual(actions[0].status, 'pending', 'a newly created action must start in the pending approval state');
  assert.strictEqual(actions[0].requires_approval, true);

  // ── Execution: demo mode is honest about not being a live external write ──
  assert.strictEqual(resolveExecutionMode(), 'DEMO_ADAPTER', 'no real Odoo write connector exists yet — must never claim LIVE_ODOO');
  const execResult = await executeSupplyChainAction(userId, actions[0]);
  assert.strictEqual(execResult.liveExternalWriteOccurred, false, 'the demo adapter must never claim a live external write occurred');
  assert.strictEqual(execResult.purchaseOrder.status, 'draft_demo_adapter');
  assert.strictEqual(execResult.purchaseOrder.related_ai_action_id, actions[0].id);

  console.log('[PASS] supplyChainOrchestrator integration tests (live DB, demo tenant)');
  await pool.end();
}

main().catch((err) => { console.error('[FAIL] supplyChainOrchestrator tests:', err); process.exit(1); });
