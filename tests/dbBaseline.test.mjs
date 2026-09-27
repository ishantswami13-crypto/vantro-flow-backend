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
const { preflight } = require('../scripts/db-preflight');
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

// A database migrated by hand through 048 (the production situation): no ledger, no 049/050.
async function prodLike(client) {
  await migrate.run({ mode: 'apply', client, log: quiet });
  await client.query(`DROP TABLE schema_migrations;
    DROP TABLE access_download_events, access_entitlements, access_application_events, access_applications;
    DROP INDEX idx_invoices_user_customer; ALTER TABLE invoices DROP COLUMN customer_id;`);
}
const ledgerCount = async (c) => (await c.query(`SELECT COUNT(*)::int n FROM information_schema.tables WHERE table_name='schema_migrations'`)).rows[0].n
  ? (await c.query('SELECT COUNT(*)::int n FROM schema_migrations')).rows[0].n : 0;

async function main() {
  await withScratch('happy', async (c) => {
    await prodLike(c);
    const r = await preflight(c);
    check('prod-like: PASS', r.plan.pass, r.plan.failures);
    check('prod-like: cut-off is 048', r.plan.baselineThrough === 'migrations/048_onboarding_profile.sql', r.plan.baselineThrough);
    check('prod-like: only 049 and 050 to apply', r.plan.apply.map((a) => a.file).join() === 'migrations/049_invoices_customer_link.sql,migrations/050_access_applications.sql');
    check('preflight wrote nothing (no ledger table)', await ledgerCount(c) === 0);
    let err = null;
    try { await baseline(c, { through: 'migrations/047_connector_devices.sql', log: quiet }); } catch (e) { err = e; }
    check('baseline refuses a cut-off that differs from the plan', /must equal/.test(err?.message || '') && await ledgerCount(c) === 0);
    await baseline(c, { through: 'migrations/048_onboarding_profile.sql', log: quiet });
    check('baseline records exactly the planned files', await ledgerCount(c) === r.plan.record.length);
    const applied = await migrate.run({ mode: 'apply', client: c, log: quiet });
    check('migrate then applies only 049 and 050', applied.applied.length === 2);
    const cols = await c.query(`SELECT data_type FROM information_schema.columns WHERE table_name='invoices' AND column_name='customer_id'`);
    check('invoices.customer_id now exists as uuid', cols.rows[0]?.data_type === 'uuid');
    let again = null;
    try { await baseline(c, { through: 'migrations/050_access_applications.sql', log: quiet }); } catch (e) { again = e; }
    check('baseline refuses a database already on the ledger', !!again);
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
    check('a partially-applied migration FAILS preflight', !r.plan.pass && r.plan.failures.some((f) => f.includes('031_data_connections')), r.plan.failures);
    let err = null;
    try { await baseline(c, { through: 'migrations/048_onboarding_profile.sql', log: quiet }); } catch (e) { err = e; }
    check('baseline refuses when preflight fails; nothing written', !!err && await ledgerCount(c) === 0);
  });

  await withScratch('gap', async (c) => {
    await prodLike(c);
    await c.query('DROP TABLE customer_score_history CASCADE'); // created by 011; 013+ present
    const r = await preflight(c);
    check('a pre-020 gap with later files present FAILS (would re-run non-idempotent files)', !r.plan.pass && r.plan.failures.some((f) => /not known to be safe/.test(f)), r.plan.failures);
  });

  await withScratch('empty', async (c) => {
    const r = await preflight(c);
    check('an empty database FAILS (use migrate.js, not a baseline)', !r.plan.pass);
  });
}

main().then(done).catch((e) => { console.error('Test run crashed:', e); process.exitCode = 1; });
