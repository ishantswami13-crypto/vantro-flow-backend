// Live-DB integration test proving predictions are versioned, not
// duplicated: re-analyzing a signal must supersede the prior live
// prediction for each (entity, target, horizon), never leave two
// disconnected unresolved rows, and never touch an already-resolved one.
const assert = require('assert');
require('dotenv').config();
const { getPool } = require('../lib/db/pg');
const { getSignalImpact, writeDoNothingForecast } = require('../lib/domain/intelligence/supplyChainOrchestrator');
const { getPredictionHistory } = require('../lib/domain/intelligence/predictionVersioning');
const { resolvePrediction } = require('../lib/domain/intelligence/forecastEngine');

const DEMO_EMAIL = 'owner@2xa-demo-meridian.invalid';

async function main() {
  const pool = getPool();
  const userRes = await pool.query('SELECT id FROM users WHERE email = $1', [DEMO_EMAIL]);
  if (userRes.rows.length === 0) {
    console.log('[SKIP] predictionVersioning tests — demo tenant not seeded.');
    await pool.end();
    return;
  }
  const userId = userRes.rows[0].id;
  const sigRes = await pool.query('SELECT id FROM business_signals WHERE user_id = $1 LIMIT 1', [userId]);
  const signalId = sigRes.rows[0].id;
  const impact = await getSignalImpact(signalId, userId);
  const componentId = impact.components[0].component.id;

  // ── First analysis: fresh predictions, no supersession ─────────────────
  const first = await writeDoNothingForecast(userId, signalId, impact);
  const firstStockout7d = first.find((p) => p.target === 'stockout_within_horizon' && p.horizon_days === 7);
  assert.ok(firstStockout7d);
  assert.strictEqual(firstStockout7d.supersedes_id, null, 'the very first prediction in a chain has nothing to supersede');

  // ── Second analysis (re-analyze the same signal): must supersede, not duplicate ──
  const second = await writeDoNothingForecast(userId, signalId, impact);
  const secondStockout7d = second.find((p) => p.target === 'stockout_within_horizon' && p.horizon_days === 7);
  assert.strictEqual(secondStockout7d.supersedes_id, firstStockout7d.id, 'the new prediction must link back to the one it supersedes');

  const priorRow = await pool.query('SELECT superseded_by_id, revision_trigger, revision_reason, revised_at FROM predictions WHERE id = $1', [firstStockout7d.id]);
  assert.strictEqual(priorRow.rows[0].superseded_by_id, secondStockout7d.id, 'the prior prediction must record which new one superseded it');
  assert.strictEqual(priorRow.rows[0].revision_trigger, 'RECOMPUTED');
  assert.ok(priorRow.rows[0].revision_reason, 'a human-readable reason must be recorded, never silent');
  assert.ok(priorRow.rows[0].revised_at, 'revision timestamp must be recorded');

  // ── History reconstruction: "what did we know at each point in time" ───
  const history = await getPredictionHistory(userId, secondStockout7d.id);
  assert.strictEqual(history.length, 2, 'history must contain both the original and the superseding prediction');
  assert.strictEqual(history[0].id, firstStockout7d.id, 'history must be ordered oldest first');
  assert.strictEqual(history[1].id, secondStockout7d.id);

  // ── A RESOLVED prediction must never be superseded by a later re-analysis ──
  const thirdBeforeResolve = await writeDoNothingForecast(userId, signalId, impact);
  const thirdStockout7d = thirdBeforeResolve.find((p) => p.target === 'stockout_within_horizon' && p.horizon_days === 7);
  await resolvePrediction(thirdStockout7d.id, 0);

  const fourth = await writeDoNothingForecast(userId, signalId, impact);
  const fourthStockout7d = fourth.find((p) => p.target === 'stockout_within_horizon' && p.horizon_days === 7);
  assert.strictEqual(fourthStockout7d.supersedes_id, null, 'a fresh chain must start after the prior head resolved — a resolved prediction is a permanent fact, never marked superseded');

  const resolvedRowAfter = await pool.query('SELECT superseded_by_id, evaluation_status FROM predictions WHERE id = $1', [thirdStockout7d.id]);
  assert.strictEqual(resolvedRowAfter.rows[0].superseded_by_id, null, 'resolving a prediction and then re-analyzing must never retroactively mark the resolved fact as superseded');
  assert.strictEqual(resolvedRowAfter.rows[0].evaluation_status, 'RESOLVED');

  console.log('[PASS] predictionVersioning tests (real supersession chain, resolved facts stay permanent)');
  await pool.end();
}

main().catch((err) => { console.error('[FAIL] predictionVersioning tests:', err); process.exit(1); });
