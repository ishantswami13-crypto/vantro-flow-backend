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
//   3. in ONE transaction: for each PARTIALLY present file it records, runs
//      that file's additive statements (CREATE … IF NOT EXISTS, ADD COLUMN IF
//      NOT EXISTS) and checks every missing object now exists; then creates
//      starlane_migrations and records each file up to the cut-off with the
//      SHA-256 of its current contents. Any error rolls all of it back;
//   4. runs nothing else. Pending files are applied afterwards by
//      `node scripts/migrate.js`, which stops on the first failure.
//
// Writes the starlane_migrations table, plus the missing objects of partial
// files (additive only). An unrelated schema_migrations table is left
// untouched. Never prints credentials.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');
const { buildSanitizedPgConfig } = require('../lib/db/pgConfig');
const { preflight, printReport } = require('./db-preflight');
const { LEDGER_TABLE, LEDGER_DDL, adoptEarlierLedger } = require('../lib/db/migrationLedger');

const ROOT = path.join(__dirname, '..');
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, file), 'utf8')).digest('hex');

async function objectExists(client, obj) {
  const [kind, name] = obj.split(' ');
  if (kind === 'column') {
    const [table, column] = name.split('.');
    const { rows } = await client.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`, [table, column]);
    return rows.length > 0;
  }
  const { rows } = await client.query('SELECT to_regclass($1) IS NOT NULL AS ok', [name]);
  return rows[0].ok;
}

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
    // Partial files being recorded: create what they are missing, using their
    // additive statements only (see repairPlan in db-preflight.js), then check
    // every object the plan promised now exists before anything is recorded.
    for (const x of r.plan.repair) {
      for (const st of x.statements) await client.query(st);
      const still = [];
      for (const obj of x.creates) if (!(await objectExists(client, obj))) still.push(obj);
      if (still.length) throw new Error(`${x.file}: still missing after repair: ${still.slice(0, 6).join(', ')}. Nothing was written.`);
      log(`Repaired ${x.file}: created ${x.creates.length} missing object(s).`);
    }
    await adoptEarlierLedger(client);
    await client.query(LEDGER_DDL);
    const existing = await client.query(`SELECT COUNT(*)::int AS n FROM ${LEDGER_TABLE}`);
    if (existing.rows[0].n > 0) throw new Error(`${LEDGER_TABLE} is not empty — this database is already on the ledger.`);
    for (const file of r.plan.record) {
      await client.query(`INSERT INTO ${LEDGER_TABLE} (filename, checksum) VALUES ($1, $2)`, [file, sha(file)]);
    }
    const written = await client.query(`SELECT COUNT(*)::int AS n FROM ${LEDGER_TABLE}`);
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
