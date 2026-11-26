'use strict';
// scripts/data-rebuild.js — rebuild the L3 read models (migration 092) for
// every tenant whose rows are missing or out of date. Safe to run at any time
// and on a live database: each tenant is rebuilt in its own short transaction,
// and read models are derived data only.
//
// Usage: npm run data:rebuild            (only stale tenants)
//        npm run data:rebuild -- --all   (every tenant: clears the refresh state first)
// Never prints DATABASE_URL or any credential.

require('dotenv').config();
const { getPool } = require('../lib/db/pg');
const { sweepStale } = require('../lib/data/readModels');

async function main() {
  const pool = getPool();
  if (process.argv.includes('--all')) {
    await pool.query("DELETE FROM rm_refresh_state WHERE model = 'receivables'");
  }
  let total = 0;
  let failures = 0;
  for (;;) {
    const r = await sweepStale(pool, { limit: 200 });
    total += r.rebuilt;
    failures += r.failed.length;
    for (const f of r.failed) console.error(`  failed tenant …${String(f.userId).slice(-6)}: ${f.error}`);
    if (r.candidates === 0 || r.rebuilt === 0) break;
  }
  console.log(`read models rebuilt for ${total} tenant(s), ${failures} failure(s)`);
  await pool.end();
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
