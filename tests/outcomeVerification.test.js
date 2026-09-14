// Live-DB integration test for the outcome-verification loop. Requires the
// 2xA demo tenant to be seeded and triggered first (same convention as
// supplyChainOrchestrator.test.js).
const assert = require('assert');
require('dotenv').config();
const { getPool } = require('../lib/db/pg');
const { getSignalImpact, writeDoNothingForecast, createRecommendedActions } = require('../lib/domain/intelligence/supplyChainOrchestrator');
const { executeSupplyChainAction } = require('../lib/domain/automation/supplyChainExecutionAdapter');
const { verifySignalOutcomes, observeActualStockoutState } = require('../lib/domain/intelligence/outcomeVerification');

const DEMO_EMAIL = 'owner@2xa-demo-meridian.invalid';

async function main() {
  const pool = getPool();
  const userRes = await pool.query('SELECT id FROM users WHERE email = $1', [DEMO_EMAIL]);
  if (userRes.rows.length === 0) {
    console.log('[SKIP] outcomeVerification tests — demo tenant not seeded.');
    await pool.end();
    return;
  }
  const userId = userRes.rows[0].id;
  const sigRes = await pool.query('SELECT id FROM business_signals WHERE user_id = $1 LIMIT 1', [userId]);
  assert.ok(sigRes.rows.length > 0, 'demo tenant must have a signal');
  const signalId = sigRes.rows[0].id;

  const impact = await getSignalImpact(signalId, userId);
  assert.strictEqual(impact.sufficientDataForQuantification, true);
  const component = impact.components[0];

  // Fresh predictions + an executed action for this test run.
  await writeDoNothingForecast(userId, signalId, impact);
  const actions = await createRecommendedActions(userId, signalId, impact);
  assert.ok(actions.length > 0);
  await executeSupplyChainAction(userId, actions[0]);
  await pool.query(`UPDATE ai_actions SET status='done' WHERE id=$1`, [actions[0].id]);

  // ── Real observation function reflects real current_stock ──────────────
  const stockRes = await pool.query('SELECT current_stock FROM products WHERE id = $1', [component.component.id]);
  const expectedState = Number(stockRes.rows[0].current_stock) <= 0 ? 1 : 0;
  const observed = await observeActualStockoutState(userId, component.component.id);
  assert.strictEqual(observed, expectedState, 'observeActualStockoutState must reflect the real current_stock value, never a guess');

  // ── Freshly written predictions (horizons 7/14/30d from now) must NOT resolve yet ──
  const firstPass = await verifySignalOutcomes(userId, signalId);
  assert.strictEqual(firstPass.resolvedPredictions.length, 0, 'a prediction whose horizon has not elapsed must never be resolved early');
  assert.ok(firstPass.awaitingPredictions.length > 0, 'unelapsed predictions must be reported as awaiting observation');
  assert.strictEqual(firstPass.status, 'AWAITING_OBSERVATION');

  const actionAfterFirstPass = await pool.query('SELECT outcome FROM ai_actions WHERE id = $1', [actions[0].id]);
  assert.strictEqual(actionAfterFirstPass.rows[0].outcome, null, 'action outcome must stay unset while any relevant horizon is still awaiting observation');

  // ── Force one prediction's horizon into the past, then verify it resolves against real data ──
  const predRes = await pool.query(
    `SELECT id FROM predictions WHERE user_id = $1 AND target = 'stockout_within_horizon' AND horizon_days = 7 ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  await pool.query(`UPDATE predictions SET as_of = NOW() - INTERVAL '8 days' WHERE id = $1`, [predRes.rows[0].id]);

  const secondPass = await verifySignalOutcomes(userId, signalId);
  assert.ok(secondPass.resolvedPredictions.some((r) => r.predictionId === predRes.rows[0].id), 'the elapsed-horizon prediction must resolve');
  const resolvedRow = await pool.query('SELECT evaluation_status, actual_value, absolute_error FROM predictions WHERE id = $1', [predRes.rows[0].id]);
  assert.strictEqual(resolvedRow.rows[0].evaluation_status, 'RESOLVED');
  assert.strictEqual(Number(resolvedRow.rows[0].actual_value), expectedState);

  console.log('[PASS] outcomeVerification tests (real prediction resolution, never early, real observed data)');
  await pool.end();
}

main().catch((err) => { console.error('[FAIL] outcomeVerification tests:', err); process.exit(1); });
