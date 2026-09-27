'use strict';
// scripts/migrate.js — the single, ordered, ledgered schema migration runner.
//
// Why this exists: schema was previously applied by hand-maintained file lists
// (scripts/setup-fresh-database.js, scripts/staging-migrate.js, ad-hoc Supabase
// SQL editor runs). Those lists drifted — 046_watches, 047_connector_devices and
// 048_onboarding_profile were missing from the fresh-database bootstrap, so a new
// environment silently lacked tables that live routes query. There was also no
// record of what had been applied where.
//
// This runner:
//   - derives the order from one list (PRELUDE_FILES, then every migrations/*.sql
//     sorted by filename), so a new migration file is picked up automatically;
//   - records each applied file in schema_migrations with a SHA-256 checksum;
//   - applies each pending file inside its own transaction and STOPS on the first
//     failure (no "warning (continuing)" — a half-applied schema is not a state we
//     want to discover later from a 500);
//   - warns when an already-applied file's contents changed since it was applied.
//
// Usage:
//   node scripts/migrate.js            apply all pending migrations
//   node scripts/migrate.js --status   list applied / pending / drifted, change nothing
//   node scripts/migrate.js --baseline=migrations/048_onboarding_profile.sql
//                                      record every file UP TO AND INCLUDING the named one
//                                      as applied WITHOUT running it. One-time, for a
//                                      database migrated by hand before this ledger
//                                      existed. The cut-off is mandatory so a baseline
//                                      can never swallow a migration the DB never saw.
//                                      (Not every legacy file is safe to re-run — e.g.
//                                      015 adds constraints without IF NOT EXISTS — so an
//                                      existing database must be baselined, not re-applied.)
//
// Never prints DATABASE_URL or any credential.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');
const { buildSanitizedPgConfig } = require('../lib/db/pgConfig');

const ROOT = path.join(__dirname, '..');

// Files that predate the numbered migrations directory but are part of the
// schema. Order matters: base schema, then cortex 001-005, then the two
// standalone rollouts that the 006+ migrations depend on.
const PRELUDE_FILES = [
  'supabase-schema.sql',
  'migrations/001_cortex_foundation.sql',
  'migrations/002_cortex_extension.sql',
  'migrations/003_evaluation.sql',
  'migrations/004_schema_repair.sql',
  'migrations/005_cortex_x_extensions.sql',
  'supabase-phase2c32-schema.sql',
  'supabase-error-events-rollout.sql',
];

function orderedMigrationFiles() {
  const numbered = fs.readdirSync(path.join(ROOT, 'migrations'))
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => `migrations/${f}`);
  const seen = new Set(PRELUDE_FILES);
  return [...PRELUDE_FILES, ...numbered.filter((f) => !seen.has(f))];
}

function checksum(sql) {
  return crypto.createHash('sha256').update(sql).digest('hex');
}

const LEDGER_DDL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename   TEXT PRIMARY KEY,
    checksum   TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;

// Supabase provisions these roles and the auth.uid() helper; a plain Postgres
// (local dev, CI) does not, and RLS policies/GRANTs in the migrations reference
// them. Create them only when missing, so this is a no-op on Supabase itself.
// The auth.uid() stand-in reads the same request.jwt.claim.sub setting that
// Supabase's implementation reads; the backend connects as the table owner /
// service role, which bypasses RLS either way.
const PLATFORM_COMPAT_SQL = `
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  END $$;
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'auth') THEN
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
        $f$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $f$;
      CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS
        $f$ SELECT NULLIF(current_setting('request.jwt.claim.role', true), '')::text $f$;
      CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS
        $f$ SELECT COALESCE(NULLIF(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $f$;
    END IF;
  END $$;`;

async function connect() {
  const cfg = buildSanitizedPgConfig(process.env.DATABASE_URL);
  if (!cfg) throw new Error('DATABASE_URL is not set');
  const client = new Client(cfg);
  await client.connect();
  return client;
}

async function plan(client) {
  await client.query(LEDGER_DDL);
  await client.query(PLATFORM_COMPAT_SQL);
  const { rows } = await client.query('SELECT filename, checksum FROM schema_migrations');
  const applied = new Map(rows.map((r) => [r.filename, r.checksum]));
  return orderedMigrationFiles().map((file) => {
    const sql = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const sum = checksum(sql);
    const prior = applied.get(file);
    const state = !prior ? 'pending' : prior === sum ? 'applied' : 'drifted';
    return { file, sql, sum, state };
  });
}

async function run({ mode = 'apply', baselineThrough = null, log = console.log, client: injected } = {}) {
  const client = injected || await connect();
  try {
    const steps = await plan(client);
    const drifted = steps.filter((s) => s.state === 'drifted');
    for (const d of drifted) log(`! drifted since applied (not re-run): ${d.file}`);

    if (mode === 'status') {
      for (const s of steps) log(`${s.state.padEnd(8)} ${s.file}`);
      return { steps: steps.map(({ file, state }) => ({ file, state })) };
    }

    const pending = steps.filter((s) => s.state === 'pending');
    if (mode === 'baseline') {
      const cutoff = steps.findIndex((s) => s.file === baselineThrough);
      if (cutoff === -1) throw new Error(`--baseline needs a known migration file as its cut-off (got ${baselineThrough || 'nothing'})`);
      for (const s of steps.slice(0, cutoff + 1).filter((x) => x.state === 'pending')) {
        await client.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2) ON CONFLICT DO NOTHING', [s.file, s.sum]);
        log(`baselined ${s.file}`);
      }
      return { applied: [], baselined: steps.slice(0, cutoff + 1).filter((x) => x.state === 'pending').map((x) => x.file) };
    }

    const appliedNow = [];
    for (const s of pending) {
      try {
        await client.query('BEGIN');
        await client.query(s.sql);
        await client.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [s.file, s.sum]);
        await client.query('COMMIT');
        appliedNow.push(s.file);
        log(`applied  ${s.file}`);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        const e = new Error(`Migration failed in ${s.file}: ${String(err.message).split('\n')[0]}`);
        e.file = s.file;
        e.appliedBeforeFailure = appliedNow;
        throw e;
      }
    }
    if (!pending.length) log('Schema is up to date.');
    return { applied: appliedNow };
  } finally {
    if (!injected) await client.end();
  }
}

if (require.main === module) {
  const baselineArg = process.argv.find((a) => a.startsWith('--baseline'));
  const mode = process.argv.includes('--status') ? 'status' : baselineArg ? 'baseline' : 'apply';
  const baselineThrough = baselineArg && baselineArg.includes('=') ? baselineArg.split('=')[1] : null;
  run({ mode, baselineThrough }).catch((err) => {
    console.error(`✖ ${err.message}`);
    process.exit(1);
  });
}

module.exports = { run, orderedMigrationFiles, PRELUDE_FILES };
