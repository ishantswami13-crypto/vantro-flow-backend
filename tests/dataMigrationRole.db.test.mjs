// Migration 095's role grant, run the way a non-superuser migrator runs it
// (Supabase's postgres, a Railway user without SUPERUSER): when starlane_app
// already exists and was made by someone else, the migrator cannot grant it
// to itself. That must warn and let the migration run finish, not stop every
// later migration. Needs DATABASE_URL (local only) and a user that can CREATE
// ROLE; otherwise the checks are skipped and say so.
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { makeChecker } from './helpers/httpHarness.mjs';

const require = createRequire(import.meta.url);
require('../lib/db/testDatabaseGuard').assertTestDatabase(process.env.DATABASE_URL);
const { Client } = require('pg');
const { buildSanitizedPgConfig } = require('../lib/db/pgConfig');
const { check, done } = makeChecker();

async function main() {
  if (!process.env.DATABASE_URL) { console.log('SKIP migration role checks: DATABASE_URL not set'); return done(); }
  const sql = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'migrations', '095_data_layer_rls.sql'), 'utf8');
  const roleBlock = sql.slice(sql.indexOf('DO $$'), sql.indexOf('END $$;') + 'END $$;'.length);
  check('095 starts with the role block', /CREATE ROLE starlane_app/.test(roleBlock) && /GRANT starlane_app/.test(roleBlock));
  const client = new Client(buildSanitizedPgConfig(process.env.DATABASE_URL));
  await client.connect();
  const warnings = [];
  client.on('notice', (n) => { if (n.severity === 'WARNING') warnings.push(n.message); });
  const migrator = `t_migrator_${process.pid}`;
  try {
    const me = (await client.query("SELECT rolsuper, rolcreaterole FROM pg_roles WHERE rolname = current_user")).rows[0];
    if (!me.rolsuper) { console.log('SKIP migration role checks: the test user is not a superuser, so it cannot stage a second migrator'); return done(); }
    await client.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'starlane_app') THEN CREATE ROLE starlane_app NOLOGIN NOBYPASSRLS; END IF; END $$`);
    await client.query(`CREATE ROLE ${migrator} NOLOGIN CREATEROLE`);
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${migrator}`);
    let err = null;
    try { await client.query(roleBlock); } catch (e) { err = e; }
    const member = (await client.query("SELECT pg_has_role(current_user, 'starlane_app', 'MEMBER') AS m")).rows[0].m;
    await client.query('ROLLBACK');
    check('a migrator that cannot grant an existing starlane_app does not fail the migration', err === null, err && err.message);
    check('it is told what to run instead', warnings.some((w) => w.includes(`GRANT starlane_app TO ${migrator}`)), warnings);
    check('and it is not a member (withTenant with the role would fail closed)', member === false);
    warnings.length = 0;
    await client.query('BEGIN');
    await client.query(roleBlock);
    await client.query('ROLLBACK');
    check('a migrator that already has the role re-runs the block silently', warnings.length === 0, warnings);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.query(`DROP ROLE IF EXISTS ${migrator}`).catch(() => {});
    await client.end();
  }
  done();
}

main().catch((err) => { console.error(err); process.exit(1); });
