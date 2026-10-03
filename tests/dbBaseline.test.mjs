// Production-baseline safety tests. Each scenario builds its own throwaway
// database from the real migrations, damages it the way a hand-migrated
// database can be damaged, and checks what the preflight and the gated
// baseline do. Never touches DATABASE_URL's database beyond CREATE/DROP
// DATABASE for the scratch ones.
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { makeChecker } from './helpers/httpHarness.mjs';

const require = createRequire(import.meta.url);
const { Client } = require('pg');
const { buildSanitizedPgConfig } = require('../lib/db/pgConfig');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const { preflight, isIdempotent, buildPlan } = require('../scripts/db-preflight');
const { baseline } = require('../scripts/db-baseline');
const migrate = require('../scripts/migrate');
const { check, done } = makeChecker();
const quiet = () => {};

const adminCfg = buildSanitizedPgConfig(process.env.DATABASE_URL);
async function withScratch(name, fn) {
  const db = `bl_${name}_${randomUUID().slice(0, 8)}`;
  const admin = new Client(adminCfg); await admin.connect();
  await admin.query(`CREATE DATABASE ${db}`);
  const client = new Client({ ...adminCfg, database: db }); await client.connect();
  try { return await fn(client); }
  finally { await client.end(); await admin.query(`DROP DATABASE ${db} WITH (FORCE)`); await admin.end(); }
}

// A database migrated by hand through 048 (the production situation): no ledger.
const LAST_PROD = 'migrations/048_onboarding_profile.sql';
async function prodLike(client) {
  await migrate.run({ mode: 'apply', client, log: quiet, throughFile: LAST_PROD });
  await client.query('DROP TABLE starlane_migrations');
}
const AFTER_PROD = migrate.orderedMigrationFiles().slice(migrate.orderedMigrationFiles().indexOf(LAST_PROD) + 1);
const ledgerCount = async (c) => (await c.query(`SELECT COUNT(*)::int n FROM information_schema.tables WHERE table_name='starlane_migrations'`)).rows[0].n
  ? (await c.query('SELECT COUNT(*)::int n FROM starlane_migrations')).rows[0].n : 0;
const tableColumns = async (c, t) => (await c.query(`SELECT column_name FROM information_schema.columns WHERE table_name=$1 ORDER BY ordinal_position`, [t])).rows.map((r) => r.column_name).join();
// Production has this table, created outside the repo and empty. It is not ours.
const FOREIGN_LEDGER_DDL = 'CREATE TABLE schema_migrations (version text, checksum text, applied_at timestamptz, applied_by text)';

async function main() {
  await withScratch('syncdevice', async (c) => {
    await migrate.run({ mode: 'apply', client: c, log: quiet,
      throughFile: 'migrations/062_outbound_engine.sql' });
    const userId = randomUUID();
    await c.query('INSERT INTO users (id, email) VALUES ($1, $2)', [userId, `${userId}@example.invalid`]);
    const historical = (await c.query(
      "INSERT INTO connector_sync_runs (user_id, connector_id, status) VALUES ($1, 'tally', 'succeeded') RETURNING id",
      [userId])).rows[0].id;
    // Reproduce a legacy table that 051's CREATE TABLE IF NOT EXISTS cannot repair.
    await c.query('ALTER TABLE connector_sync_runs DROP COLUMN device_id, DROP COLUMN client_version');
    const insertRun = () => c.query(
      "INSERT INTO connector_sync_runs (user_id, connector_id, device_id, client_version) VALUES ($1, 'tally', $2, $3) RETURNING id, started_at",
      [userId, null, '0.1.1']);
    let failure;
    try { await insertRun(); } catch (e) { failure = e; }
    check('legacy sync table reproduces missing column failure', failure?.code === '42703');
    const applied = await migrate.run({ mode: 'apply', client: c, log: quiet });
    check('forward repair is picked up by migration runner', applied.applied.includes('migrations/063_connector_sync_device_columns.sql'));
    const run = await insertRun();
    check('device sync insert works after repair', !!run.rows[0]?.id && !!run.rows[0]?.started_at);
    const repair = fs.readFileSync(path.join(ROOT, 'migrations/063_connector_sync_device_columns.sql'), 'utf8');
    await c.query(repair);
    const old = (await c.query('SELECT status, device_id, client_version FROM connector_sync_runs WHERE id=$1', [historical])).rows[0];
    check('repair is repeatable and preserves historical rows', old?.status === 'succeeded' && old.device_id === null && old.client_version === null);
    const rls = await c.query("SELECT relrowsecurity FROM pg_class WHERE oid='connector_sync_runs'::regclass");
    check('repair preserves row-level security', rls.rows[0].relrowsecurity === true);
    let invalidDevice;
    try {
      await c.query("INSERT INTO connector_sync_runs (user_id, connector_id, device_id) VALUES ($1, 'tally', $2)", [userId, randomUUID()]);
    } catch (e) { invalidDevice = e; }
    check('new device column enforces device foreign key', invalidDevice?.code === '23503');
  });
  await withScratch('happy', async (c) => {
    await prodLike(c);
    const r = await preflight(c);
    check('prod-like: PASS', r.plan.pass, r.plan.failures);
    check('prod-like: cut-off is 048', r.plan.baselineThrough === 'migrations/048_onboarding_profile.sql', r.plan.baselineThrough);
    check('prod-like: applies exactly the files after 048', r.plan.apply.map((a) => a.file).join() === AFTER_PROD.join() && AFTER_PROD[0] === 'migrations/049_invoices_customer_link.sql', r.plan.apply);
    check('preflight wrote nothing (no ledger table)', await ledgerCount(c) === 0);
    let err = null;
    try { await baseline(c, { through: 'migrations/047_connector_devices.sql', log: quiet }); } catch (e) { err = e; }
    check('baseline refuses a cut-off that differs from the plan', /must equal/.test(err?.message || '') && await ledgerCount(c) === 0);
    await baseline(c, { through: 'migrations/048_onboarding_profile.sql', log: quiet });
    check('baseline records exactly the planned files', await ledgerCount(c) === r.plan.record.length);
    const applied = await migrate.run({ mode: 'apply', client: c, log: quiet });
    check('migrate then applies exactly those files', applied.applied.join() === AFTER_PROD.join());
    const cols = await c.query(`SELECT data_type FROM information_schema.columns WHERE table_name='invoices' AND column_name='customer_id'`);
    check('invoices.customer_id now exists as uuid', cols.rows[0]?.data_type === 'uuid');
    let again = null;
    try { await baseline(c, { through: 'migrations/050_access_applications.sql', log: quiet }); } catch (e) { again = e; }
    check('baseline refuses a database already on the ledger', !!again);
    const pre = await c.query(`SELECT COUNT(*)::int n FROM information_schema.tables WHERE table_name IN ('auth_sessions','notification_events','product_events')`);
    check('client-platform tables exist after the upgrade', pre.rows[0].n === 3);
  });

  await withScratch('foreign', async (c) => {
    await prodLike(c);
    await c.query(FOREIGN_LEDGER_DDL);
    const r = await preflight(c);
    check('production shape (unrelated empty schema_migrations): preflight PASSES with cut-off 048', r.plan.pass && r.plan.baselineThrough === LAST_PROD, r.plan.failures);
    check('preflight reports that table as another tool\'s', r.hazards.some((h) => h.id === 'schema_migrations' && h.value === 'other tool'));
    await baseline(c, { through: LAST_PROD, log: quiet });
    const applied = await migrate.run({ mode: 'apply', client: c, log: quiet });
    check('baseline then migrate apply exactly the files after 048', applied.applied.join() === AFTER_PROD.join());
    check('the unrelated table is untouched: same columns, still empty',
      await tableColumns(c, 'schema_migrations') === 'version,checksum,applied_at,applied_by'
      && (await c.query('SELECT COUNT(*)::int n FROM schema_migrations')).rows[0].n === 0);
  });

  await withScratch('earlier', async (c) => {
    await migrate.run({ mode: 'apply', client: c, log: quiet });
    const recorded = await ledgerCount(c);
    await c.query('ALTER TABLE starlane_migrations RENAME TO schema_migrations'); // how the first revision left it
    const r = await preflight(c);
    check('a ledger under the earlier name is recognised read-only (no baseline offered)', r.ledgerExists && r.ledgerRows === recorded);
    const st = await migrate.run({ mode: 'status', client: c, log: quiet });
    check('migrate adopts it: renamed, every row kept, nothing pending',
      await ledgerCount(c) === recorded && (await c.query(`SELECT to_regclass('public.schema_migrations') AS t`)).rows[0].t === null
      && st.steps.every((x) => x.state === 'applied'));
  });

  await withScratch('missing020', async (c) => {
    await prodLike(c);
    await c.query('DROP TABLE purchase_line_items, product_suppliers, payment_allocations CASCADE');
    const r = await preflight(c);
    check('020/024 tables missing: PASS with cut-off 019', r.plan.pass && r.plan.baselineThrough === 'migrations/019_ai_actions_suggested_by_widen.sql', r.plan);
    await baseline(c, { through: r.plan.baselineThrough, log: quiet });
    await migrate.run({ mode: 'apply', client: c, log: quiet });
    const t = await c.query(`SELECT COUNT(*)::int n FROM information_schema.tables WHERE table_name IN ('payment_allocations','product_suppliers','purchase_line_items')`);
    check('020/024 tables recreated by migrate after baseline', t.rows[0].n === 3);
  });

  await withScratch('partial', async (c) => {
    await prodLike(c);
    await c.query('DROP INDEX IF EXISTS idx_data_connections_user');
    const r = await preflight(c);
    check('an idempotent file after 020 missing an index: PASS, cut moves before it and it runs again',
      r.plan.pass && r.plan.baselineThrough === 'migrations/030_import_batches.sql' && r.plan.apply[0]?.file === 'migrations/031_data_connections.sql', r.plan);
    await baseline(c, { through: r.plan.baselineThrough, log: quiet });
    await migrate.run({ mode: 'apply', client: c, log: quiet });
    check('…and migrate recreates the index', (await c.query(`SELECT to_regclass('public.idx_data_connections_user') AS t`)).rows[0].t !== null);
  });

  await withScratch('guarded', async (c) => {
    await prodLike(c);
    await c.query('DROP INDEX IF EXISTS idx_bills_user_number'); // only built inside a guarded DO block, on a table that exists
    const r = await preflight(c);
    check('a missing object only a guarded block creates on an existing table FAILS preflight', !r.plan.pass && r.plan.failures.some((f) => f.includes('supabase-schema.sql') && f.includes('idx_bills_user_number')), r.plan.failures);
    let err = null;
    try { await baseline(c, { through: 'migrations/048_onboarding_profile.sql', log: quiet }); } catch (e) { err = e; }
    check('baseline refuses when preflight fails; nothing written', !!err && await ledgerCount(c) === 0);
  });

  await withScratch('production', async (c) => {
    // The shape production's read-only preflight reported on 2026-09-29: base
    // tables never created, a table and indexes missing from recorded files,
    // 049/051 half-applied, the error-events rollout never run, and the
    // unrelated schema_migrations table.
    await prodLike(c);
    await c.query(`DROP TABLE billing_history, attendance, expenses, business_vocabulary, brain_rules, prospect_notes CASCADE;
      DROP INDEX idx_customer_score_history_user_customer; DROP TABLE IF EXISTS error_events CASCADE;`);
    await c.query(FOREIGN_LEDGER_DDL);
    const rlsOf = async () => (await c.query(`SELECT relname, relrowsecurity FROM pg_class WHERE relkind='r' AND relnamespace='public'::regnamespace`)).rows;
    const before = await rlsOf();
    const r = await preflight(c);
    const repaired = r.plan.repair.map((x) => x.file).join();
    check('production shape: PASS, repairing the base schema, 006_boot and 011 additively',
      r.plan.pass && repaired === 'supabase-schema.sql,migrations/006_boot_migration_promoted.sql,migrations/011_customer_score_history.sql', { failures: r.plan.failures, repaired });
    check('no repair statement toggles RLS, drops, or changes constraints or rows',
      r.plan.repair.flatMap((x) => x.statements).every((st) =>
        /^(CREATE (UNIQUE )?INDEX IF NOT EXISTS|CREATE TABLE IF NOT EXISTS|CREATE EXTENSION IF NOT EXISTS|ALTER TABLE \S+ ADD COLUMN IF NOT EXISTS)\b/i.test(st)
        && !/ROW\s+LEVEL\s+SECURITY|\bPOLICY\b/i.test(st)));
    await baseline(c, { through: r.plan.baselineThrough, log: quiet });
    await migrate.run({ mode: 'apply', client: c, log: quiet });
    const st = await migrate.run({ mode: 'status', client: c, log: quiet });
    check('after baseline and migrate nothing is pending', st.steps.every((x) => x.state === 'applied'));
    const again = await preflight(c);
    check('every file is now fully present', again.files.every((f) => f.state === 'present' || f.state === 'n/a'), again.files.filter((f) => f.state !== 'present' && f.state !== 'n/a'));
    const after = new Map((await rlsOf()).map((x) => [x.relname, x.relrowsecurity]));
    check('RLS is unchanged on every table that existed before', before.every((x) => after.get(x.relname) === x.relrowsecurity));
    check('the unrelated schema_migrations table is untouched',
      await tableColumns(c, 'schema_migrations') === 'version,checksum,applied_at,applied_by'
      && (await c.query('SELECT COUNT(*)::int n FROM schema_migrations')).rows[0].n === 0);
  });

  await withScratch('gap', async (c) => {
    await prodLike(c);
    await c.query('DROP TABLE customer_score_history CASCADE'); // created by 011; 013+ present
    const r = await preflight(c);
    const ooo = r.plan.apply.filter((a) => a.outOfOrder).map((a) => a.file);
    check('a pre-020 gap in an idempotent file: it runs out of order, later present files are recorded, not re-run',
      r.plan.pass && ooo.length === 1 && ooo[0] === 'migrations/011_customer_score_history.sql'
      && r.plan.record.includes('migrations/013_orders_and_workers.sql') && !r.plan.apply.some((a) => a.file === 'migrations/013_orders_and_workers.sql'), { ooo, failures: r.plan.failures });
    await baseline(c, { through: r.plan.baselineThrough, log: quiet });
    await migrate.run({ mode: 'apply', client: c, log: quiet });
    check('…and the migration run recreates it', (await c.query(`SELECT to_regclass('public.customer_score_history') AS t`)).rows[0].t !== null);
  });

  console.log('— which files may run out of order');
  const fileSql = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  check('idempotent: 011 (CREATE TABLE/INDEX IF NOT EXISTS), error-events rollout (plus RLS policies)', isIdempotent(fileSql('migrations/011_customer_score_history.sql')) && isIdempotent(fileSql('supabase-error-events-rollout.sql')));
  check('not idempotent: 015 (constraints without IF NOT EXISTS), 016 (seed data), 019 (constraint swap), 006 (RLS on existing tables)',
    !isIdempotent(fileSql('migrations/015_world_intelligence_core.sql')) && !isIdempotent(fileSql('migrations/016_world_transmission_channels_seed.sql'))
    && !isIdempotent(fileSql('migrations/019_ai_actions_suggested_by_widen.sql')) && !isIdempotent(fileSql('migrations/006_cortex_rls.sql')));
  const synth = (states) => buildPlan({ ledgerExists: false, ledgerRows: 0, hazards: [],
    files: states.map(([file, state, idempotent]) => ({ file, state, idempotent, missing: [] })) });
  const unsafeGap = synth([['supabase-schema.sql', 'present', false], ['migrations/015_x.sql', 'absent', false], ['migrations/017_y.sql', 'present', false], ['migrations/020_payment_allocations.sql', 'absent', true]]);
  check('a gap in a non-idempotent file with later files present FAILS', !unsafeGap.pass && unsafeGap.failures.some((f) => /not safe to run out of order/.test(f)), unsafeGap.failures);
  const blocked = buildPlan({ ledgerExists: false, ledgerRows: 0, hazards: [{ id: 'suggested_by check', value: 'BLOCKS' }],
    files: [{ file: 'supabase-schema.sql', state: 'present', idempotent: false, missing: [] }] });
  check('a suggested_by constraint that blocks collections_agent FAILS (019 not applied)', !blocked.pass && blocked.failures.some((f) => /019/.test(f)), blocked.failures);

  await withScratch('empty', async (c) => {
    const r = await preflight(c);
    check('an empty database FAILS (use migrate.js, not a baseline)', !r.plan.pass);
  });
}

main().then(done).catch((e) => { console.error('Test run crashed:', e); process.exitCode = 1; });
