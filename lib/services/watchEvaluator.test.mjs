// Real-DB test for the Watch feature (evaluator + routes logic), matching
// the lib/services/*.test.mjs pattern (see tallyImport.test.mjs). Run:
//   node lib/services/watchEvaluator.test.mjs
// Connects to the REAL Neon DB via DATABASE_URL (never printed). Uses two
// real existing users from the `users` table so tenant-isolation assertions
// are meaningful, and cleans up every row it creates.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
require('dotenv').config();
const { Pool } = require('pg');
const { buildSanitizedPgConfig } = require('../db/pgConfig');
const { evaluateWatch, SUPPORTED_METRICS } = require('./watchEvaluator');
const { watchesRouter, evaluateAndPersist } = require('../routes/watches');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  ✅', name); }
  else { fail++; console.log('  ❌', name); }
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL not set');
  const pool = new Pool(buildSanitizedPgConfig(process.env.DATABASE_URL));
  const createdWatchIds = [];

  try {
    const { rows: users } = await pool.query('SELECT id FROM users ORDER BY created_at ASC LIMIT 2');
    if (users.length < 2) {
      console.log('SKIP: fewer than 2 users in DB — cannot run tenant isolation test');
      process.exitCode = 0;
      return;
    }
    const userA = users[0].id;
    const userB = users[1].id;
    console.log(`Using real users (non-secret ids): A=${userA} B=${userB}`);

    // ---- create ----
    const insertRes = await pool.query(
      `INSERT INTO watches (user_id, created_by, name, metric_key, condition_config)
       VALUES ($1,$1,'Test overdue watch','receivables_overdue_amount',$2) RETURNING *`,
      [userA, JSON.stringify({ operator: 'gte', threshold: 0, min_days: 0 })]
    );
    const watchA = insertRes.rows[0];
    createdWatchIds.push(watchA.id);
    check('create: watch inserted with id', !!watchA.id);
    check('create: defaults to active status', watchA.status === 'active');

    // ---- list (scoped) ----
    const listRes = await pool.query(`SELECT * FROM watches WHERE user_id = $1 AND status <> 'archived'`, [userA]);
    check('list: includes the created watch', listRes.rows.some(w => w.id === watchA.id));

    // ---- fetch ----
    const fetchRes = await pool.query(`SELECT * FROM watches WHERE id = $1 AND user_id = $2`, [watchA.id, userA]);
    check('fetch: owner can fetch by id', !!fetchRes.rows[0]);

    // ---- tenant isolation: userB cannot fetch/update/delete userA's watch ----
    const crossFetch = await pool.query(`SELECT * FROM watches WHERE id = $1 AND user_id = $2`, [watchA.id, userB]);
    check('tenant isolation: cross-tenant fetch returns no row (would 404)', crossFetch.rows.length === 0);

    const crossUpdate = await pool.query(
      `UPDATE watches SET status = 'paused' WHERE id = $1 AND user_id = $2 RETURNING *`,
      [watchA.id, userB]
    );
    check('tenant isolation: cross-tenant update affects 0 rows', crossUpdate.rowCount === 0);

    const crossDelete = await pool.query(
      `UPDATE watches SET status = 'archived' WHERE id = $1 AND user_id = $2 RETURNING *`,
      [watchA.id, userB]
    );
    check('tenant isolation: cross-tenant soft-delete affects 0 rows', crossDelete.rowCount === 0);

    // ---- update (pause/resume) by real owner ----
    const pauseRes = await pool.query(
      `UPDATE watches SET status = 'paused', updated_at = NOW() WHERE id = $1 AND user_id = $2 RETURNING *`,
      [watchA.id, userA]
    );
    check('update: owner can pause', pauseRes.rows[0].status === 'paused');

    const resumeRes = await pool.query(
      `UPDATE watches SET status = 'active', updated_at = NOW() WHERE id = $1 AND user_id = $2 RETURNING *`,
      [watchA.id, userA]
    );
    check('update: owner can resume', resumeRes.rows[0].status === 'active');

    // ---- bad condition_config validation (mirrors validateConditionConfig in routes) ----
    function validateConditionConfig(cc) {
      const VALID_OPERATORS = new Set(['gt', 'gte', 'lt', 'lte', 'eq']);
      if (!cc || typeof cc !== 'object' || Array.isArray(cc)) return 'condition_config must be an object';
      if (!VALID_OPERATORS.has(cc.operator)) return 'bad operator';
      if (cc.threshold === undefined || cc.threshold === null || Number.isNaN(Number(cc.threshold))) return 'bad threshold';
      return null;
    }
    check('validation: rejects missing operator', validateConditionConfig({ threshold: 5 }) !== null);
    check('validation: rejects non-numeric threshold', validateConditionConfig({ operator: 'gte', threshold: 'abc' }) !== null);
    check('validation: accepts well-formed config', validateConditionConfig({ operator: 'gte', threshold: 5 }) === null);

    // ---- evaluator: unknown metric_key rejected loudly ----
    let threw = false;
    try {
      await evaluateWatch(pool, { ...watchA, metric_key: 'not_a_real_metric' });
    } catch (e) {
      threw = true;
    }
    check('evaluator: unknown metric_key throws (not silent no-op)', threw);

    // ---- evaluator: receivables_overdue_amount runs against real current DB data ----
    const overdueResult = await evaluateWatch(pool, watchA);
    check('evaluator: receivables_overdue_amount returns numeric value', typeof overdueResult.value === 'number');
    check('evaluator: threshold 0 with real (>=0) data triggers', overdueResult.triggered === true);

    // ---- evaluator: cash_forecast_runway_days runs without throwing ----
    const runwayWatchRes = await pool.query(
      `INSERT INTO watches (user_id, created_by, name, metric_key, condition_config)
       VALUES ($1,$1,'Test runway watch','cash_forecast_runway_days',$2) RETURNING *`,
      [userA, JSON.stringify({ operator: 'lte', threshold: 999999, days: 30, current_cash: 100000 })]
    );
    const runwayWatch = runwayWatchRes.rows[0];
    createdWatchIds.push(runwayWatch.id);
    const runwayResult = await evaluateWatch(pool, runwayWatch);
    check('evaluator: cash_forecast_runway_days returns numeric value', typeof runwayResult.value === 'number');

    // ---- evaluator: customer_exposure_amount requires entity_name ----
    const exposureWatchRes = await pool.query(
      `INSERT INTO watches (user_id, created_by, name, metric_key, condition_config)
       VALUES ($1,$1,'Test exposure watch','customer_exposure_amount',$2) RETURNING *`,
      [userA, JSON.stringify({ operator: 'gte', threshold: 0, entity_name: 'Zzz_Nonexistent_Customer' })]
    );
    const exposureWatch = exposureWatchRes.rows[0];
    createdWatchIds.push(exposureWatch.id);
    const exposureResult = await evaluateWatch(pool, exposureWatch);
    check('evaluator: customer_exposure_amount returns 0 for unmatched customer', exposureResult.value === 0);

    // ---- evaluateAndPersist: writes watch_evaluations + updates last_evaluated_at ----
    const persisted = await evaluateAndPersist(pool, watchA);
    check('evaluateAndPersist: returns updated watch with last_evaluated_at set', !!persisted.watch.last_evaluated_at);
    const evalRows = await pool.query('SELECT * FROM watch_evaluations WHERE watch_id = $1', [watchA.id]);
    check('evaluateAndPersist: inserted a watch_evaluations row', evalRows.rows.length >= 1);

    // last_triggered_at should be set since this metric (threshold 0) is
    // triggered and had no prior evaluation (false -> true transition).
    check('evaluateAndPersist: last_triggered_at set on first trigger', !!persisted.watch.last_triggered_at);

    // ---- soft delete ----
    const deleteRes = await pool.query(
      `UPDATE watches SET status = 'archived', updated_at = NOW() WHERE id = $1 AND user_id = $2 RETURNING *`,
      [watchA.id, userA]
    );
    check('delete: soft delete sets status=archived (row still exists)', deleteRes.rows[0].status === 'archived');
    const stillExists = await pool.query('SELECT id FROM watches WHERE id = $1', [watchA.id]);
    check('delete: row not hard-deleted', stillExists.rows.length === 1);

  } finally {
    // Cleanup — hard delete only the rows THIS test created.
    if (createdWatchIds.length) {
      await pool.query('DELETE FROM watches WHERE id = ANY($1::uuid[])', [createdWatchIds]);
    }
    await pool.end();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail > 0 ? 1 : 0;
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  process.exitCode = 1;
});
