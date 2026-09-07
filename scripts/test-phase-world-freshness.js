// Integration test (real dev DB, via DATABASE_URL — never NEON_READONLY_URL,
// never production) for lib/world/freshnessCheck.js.
//
// Seeds four synthetic world_sources rows covering the four cases the
// mission called for:
//   1. recent last_successful_ingestion_at within cadence -> FRESH
//   2. last_successful_ingestion_at far in the past        -> STALE
//   3. last_successful_ingestion_at null                   -> NEVER_SUCCEEDED
//   4. recent last_failure_at AFTER a recent last_success   -> STALE
//      (currently-failing source, even though its last success is "fresh"
//      by elapsed time alone)
//
// All seeded rows are deleted in a `finally` block; a final SELECT confirms
// zero residue by provider prefix.
require('dotenv').config();
const { randomUUID } = require('crypto');
const { getPool } = require('../lib/db/pg');
const { checkSourceFreshness, evaluateSourceFreshness, parseCadenceHours } = require('../lib/world/freshnessCheck');

let pass = 0, fail = 0;
function check(label, cond) {
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  cond ? pass++ : fail++;
}

const PROVIDER_PREFIX = 'TESTFRESH_';
const seededIds = [];

async function seedSource(pool, { dataset, updateCadence, lastSuccess, lastFailure, lastFailureReason }) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO world_sources
       (id, provider, dataset, authority_type, update_cadence, reliability_tier,
        last_successful_ingestion_at, last_failure_at, last_failure_reason)
     VALUES ($1, $2, $3, 'commercial', $4, 'unverified', $5, $6, $7)`,
    [id, `${PROVIDER_PREFIX}${dataset}`, dataset, updateCadence, lastSuccess, lastFailure, lastFailureReason || null]
  );
  seededIds.push(id);
  return id;
}

async function main() {
  const pool = getPool();
  const now = Date.now();

  try {
    // --- Unit-level cadence parsing sanity (no DB) ---
    check('parseCadenceHours("every 5 minutes (feed)...") clamps to 1h floor',
      parseCadenceHours('every 5 minutes (feed), significant-event definition per USGS').hours === 1);
    check('parseCadenceHours("daily, ~16:00 CET...") -> 24h',
      parseCadenceHours('daily, ~16:00 CET on ECB business days').hours === 24);
    check('parseCadenceHours(garbage) falls back to 24h default',
      parseCadenceHours('who knows').hours === 24);
    check('parseCadenceHours(null) falls back to 24h default',
      parseCadenceHours(null).hours === 24);

    // --- Pure evaluateSourceFreshness (no DB) ---
    const freshRow = { id: 'x', provider: 'P', dataset: 'd', update_cadence: 'hourly',
      last_successful_ingestion_at: new Date(now - 30 * 60 * 1000), last_failure_at: null, last_failure_reason: null };
    check('evaluateSourceFreshness: 30min old, hourly cadence -> FRESH',
      evaluateSourceFreshness(freshRow, new Date(now)).status === 'FRESH');

    // --- DB-backed cases via checkSourceFreshness() ---
    const caseFreshId = await seedSource(pool, {
      dataset: 'fresh_case', updateCadence: 'hourly',
      lastSuccess: new Date(now - 30 * 60 * 1000), lastFailure: null,
    });
    const caseStaleId = await seedSource(pool, {
      dataset: 'stale_case', updateCadence: 'daily, ~16:00 CET on ECB business days',
      lastSuccess: new Date(now - 10 * 24 * 60 * 60 * 1000), lastFailure: null, // 10 days ago, way past 72h threshold
    });
    const caseNeverId = await seedSource(pool, {
      dataset: 'never_case', updateCadence: 'every 5 minutes (feed)',
      lastSuccess: null, lastFailure: null,
    });
    const caseRecentFailureId = await seedSource(pool, {
      dataset: 'recent_failure_case', updateCadence: 'hourly',
      lastSuccess: new Date(now - 45 * 60 * 1000),   // 45 min ago — would be FRESH on time alone
      lastFailure: new Date(now - 10 * 60 * 1000),    // but failed again 10 min ago, AFTER that success
      lastFailureReason: 'synthetic test failure: HTTP 503',
    });

    const results = await checkSourceFreshness();
    const byId = Object.fromEntries(results.map(r => [r.source_id, r]));

    check('DB case 1 (recent success, hourly cadence) -> FRESH', byId[caseFreshId]?.status === 'FRESH');
    check('DB case 2 (10-day-old success, daily cadence) -> STALE', byId[caseStaleId]?.status === 'STALE');
    check('DB case 3 (null last_success) -> NEVER_SUCCEEDED', byId[caseNeverId]?.status === 'NEVER_SUCCEEDED');
    check('DB case 4 (failure after recent success) -> STALE', byId[caseRecentFailureId]?.status === 'STALE');
    check('DB case 4 carries the failure reason through', byId[caseRecentFailureId]?.last_failure_reason === 'synthetic test failure: HTTP 503');
    check('DB case 3 has staleness_hours = null (never succeeded)', byId[caseNeverId]?.staleness_hours === null);
    check('DB case 2 has a positive staleness_hours well above its threshold',
      byId[caseStaleId]?.staleness_hours > byId[caseStaleId]?.threshold_hours);

  } finally {
    // Cleanup: delete every row we seeded, then verify zero residue.
    if (seededIds.length > 0) {
      await pool.query(`DELETE FROM world_sources WHERE id = ANY($1::uuid[])`, [seededIds]);
    }
    const residue = await pool.query(`SELECT id FROM world_sources WHERE provider LIKE $1`, [`${PROVIDER_PREFIX}%`]);
    check('cleanup: zero residual synthetic world_sources rows', residue.rows.length === 0);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('FATAL', err);
  process.exit(1);
});
