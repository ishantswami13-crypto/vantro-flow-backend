'use strict';
// scripts/db-baseline.js — one-time adoption of the migration ledger on a
// database that was migrated by hand.
//
//   node scripts/db-baseline.js                       plan only (read-only; same as db-preflight)
//   node scripts/db-baseline.js --execute --through=<file>
//
// --execute:
//   1. re-runs the read-only preflight and refuses unless it PASSES;
//   2. refuses unless --through equals the preflight's computed cut-off
//      exactly (the operator confirms the plan they reviewed; a changed
//      database or a typo stops here);
//   3. in ONE transaction, creates schema_migrations and records each file up
//      to the cut-off with the SHA-256 of its current contents;
//   4. runs nothing else. Pending files are applied afterwards by
//      `node scripts/migrate.js`, which stops on the first failure.
//
// Writes only the schema_migrations table. Never prints credentials.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');
const { buildSanitizedPgConfig } = require('../lib/db/pgConfig');
const { preflight, printReport } = require('./db-preflight');

const ROOT = path.join(__dirname, '..');
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, file), 'utf8')).digest('hex');

async function baseline(client, { through, log = console.log }) {
  const r = await preflight(client);
  if (!r.plan.pass) {
    printReport(r, log);
    throw new Error('Preflight FAILED — nothing was written.');
  }
  if (!through || through !== r.plan.baselineThrough) {
    throw new Error(`--through must equal the reviewed plan's cut-off (${r.plan.baselineThrough}); got ${through || 'nothing'}. Nothing was written.`);
  }
  await client.query('BEGIN');
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const existing = await client.query('SELECT COUNT(*)::int AS n FROM schema_migrations');
    if (existing.rows[0].n > 0) throw new Error('schema_migrations is not empty — this database is already on the ledger.');
    for (const file of r.plan.record) {
      await client.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [file, sha(file)]);
    }
    const written = await client.query('SELECT COUNT(*)::int AS n FROM schema_migrations');
    if (written.rows[0].n !== r.plan.record.length) throw new Error('Ledger row count mismatch after insert.');
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  }
  log(`Recorded ${r.plan.record.length} file(s) through ${through}.`);
  log(`Next: node scripts/migrate.js   (will apply ${r.plan.apply.length}: ${r.plan.apply.map((a) => path.basename(a.file)).join(', ') || 'none'})`);
  return r.plan;
}

if (require.main === module) {
  (async () => {
    const cfg = buildSanitizedPgConfig(process.env.DATABASE_URL);
    if (!cfg) { console.error('DATABASE_URL is not set'); process.exit(2); }
    const client = new Client(cfg);
    await client.connect();
    try {
      if (!process.argv.includes('--execute')) {
        const r = await preflight(client);
        printReport(r);
        process.exitCode = r.plan.pass ? 0 : 1;
        return;
      }
      const throughArg = process.argv.find((a) => a.startsWith('--through='));
      await baseline(client, { through: throughArg ? throughArg.slice('--through='.length) : null });
    } finally { await client.end(); }
  })().catch((e) => { console.error(`✖ ${String(e.message).split('\n')[0]}`); process.exit(1); });
}

module.exports = { baseline };
