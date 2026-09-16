// FILE: scripts/test-ingest-lock.js
// World Intelligence Phase 3C — proves lib/world/ingestLock.js actually
// prevents two concurrent ingestion runs for the same source, and that an
// unrelated source is not blocked by it (locks are per-source, not global).
// Uses fake in-process fn()s, not the real usgsEarthquakes/fxRates ingest()
// (which hit real external APIs) — this test is about the locking primitive
// itself, not the sources. No DB rows are written or need cleanup: the lock
// key lives in pg_locks for the duration of the transaction only.
require('dotenv').config();
const { withIngestLock } = require('../lib/world/ingestLock');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`PASS - ${name}` + (detail ? ` :: ${JSON.stringify(detail)}` : '')); }
  else { failed++; console.log(`FAIL - ${name}` + (detail ? ` :: ${JSON.stringify(detail)}` : '')); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // Two concurrent calls for the SAME source: second must be skipped, not queued or duplicated.
  let concurrentRunCount = 0;
  const slowFn = async () => { concurrentRunCount++; await sleep(1500); return 'ran'; };

  const p1 = withIngestLock('usgs_earthquakes', slowFn);
  await sleep(200);
  const p2 = withIngestLock('usgs_earthquakes', slowFn);
  const [r1, r2] = await Promise.all([p1, p2]);

  check('First concurrent call acquires the lock and runs', r1.ran === true);
  check('Second concurrent call for the SAME source is skipped, not run', r2.ran === false && r2.reason === 'locked');
  check('The skipped call never actually invoked its fn (no duplicate ingestion work)', concurrentRunCount === 1, { concurrentRunCount });

  // Lock is released after the first call completes — a later call for the same source succeeds.
  const r3 = await withIngestLock('usgs_earthquakes', async () => 'ran-again');
  check('Lock is released after the holder finishes, allowing a subsequent run', r3.ran === true && r3.result === 'ran-again');

  // Locks are per-source: a DIFFERENT source is not blocked while usgs_earthquakes holds its lock.
  const holdFn = async () => { await sleep(1000); return 'held'; };
  const pHold = withIngestLock('usgs_earthquakes', holdFn);
  await sleep(200);
  const rOther = await withIngestLock('fx_rates', async () => 'fx-ran-independently');
  await pHold;
  check('A different source is NOT blocked by another source holding its own lock', rOther.ran === true && rOther.result === 'fx-ran-independently');

  // An unknown source name is a programmer error, not a silent no-op.
  let threw = false;
  try { await withIngestLock('not_a_real_source', async () => {}); } catch { threw = true; }
  check('Unknown source name throws instead of silently skipping the lock', threw);

  console.log(`\n=== INGEST LOCK TEST RESULT: ${failed === 0 ? 'PASS' : 'FAIL'} (${passed}/${passed + failed}) ===`);
  console.log('No DB rows written by this test — nothing to clean up.');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error('FATAL', err); process.exit(1); });
