// Data access layer (lib/data) against a real Postgres (DATABASE_URL, local only,
// migrations applied): tenant settings never leak onto pooled connections,
// timeouts and read-only are enforced by Postgres, repositories isolate tenants,
// and the shared Postgres cache is visible across "servers".
import { createRequire } from 'module';
import { randomUUID } from 'crypto';
import { makeChecker } from './helpers/httpHarness.mjs';

const require = createRequire(import.meta.url);
require('../lib/db/testDatabaseGuard').assertTestDatabase(process.env.DATABASE_URL);
const { Pool } = require('pg');
const { buildSanitizedPgConfig } = require('../lib/db/pgConfig');
const { withTenant, readTenant } = require('../lib/data/tenantDb');
const { defineRepository } = require('../lib/data/repository');
const { createCache, createPostgresBackend, _setLogger } = require('../lib/data/cache');
const { check, done } = makeChecker();
_setLogger(() => {});

const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };

async function main() {
  if (!process.env.DATABASE_URL) { console.log('SKIP data layer DB checks: DATABASE_URL not set'); return done(); }
  // One connection, so every transaction reuses the same server session.
  const pool = new Pool({ ...buildSanitizedPgConfig(process.env.DATABASE_URL), max: 1 });
  const table = `dl_test_${randomUUID().slice(0, 8)}`;
  const a = randomUUID();
  const b = randomUUID();
  try {
    console.log('tenant transactions');
    const inside = await withTenant(a, (db) => db.query("SELECT current_setting('app.user_id') AS t, current_setting('statement_timeout') AS st"), { pool, timeoutMs: 3000 });
    check('app.user_id is set inside the transaction', inside.rows[0].t === a, inside.rows[0]);
    check('statement_timeout is set inside the transaction', inside.rows[0].st === '3s', inside.rows[0].st);
    const after = await pool.query("SELECT current_setting('app.user_id', true) AS t, current_setting('statement_timeout') AS st");
    check('nothing leaks onto the pooled connection after commit', !after.rows[0].t && after.rows[0].st !== '3s', after.rows[0]);
    await rejects(withTenant(b, async (db) => { await db.query('SELECT 1'); throw new Error('fail'); }, { pool }));
    const afterFail = await pool.query("SELECT current_setting('app.user_id', true) AS t");
    check('nothing leaks after a rollback either', !afterFail.rows[0].t, afterFail.rows[0]);
    const slow = await rejects(withTenant(a, (db) => db.query('SELECT pg_sleep(2)'), { pool, timeoutMs: 200 }));
    check('Postgres cancels a statement past the timeout', slow && /statement timeout/i.test(slow.message), slow && slow.message);
    const ro = await rejects(readTenant(a, (db) => db.query('CREATE TEMP TABLE should_not_exist (x int)'), { pool }));
    check('readTenant transactions refuse writes', ro && /read-only/i.test(ro.message), ro && ro.message);

    console.log('\nrepositories');
    await pool.query(`CREATE TABLE ${table} (id serial PRIMARY KEY, user_id uuid NOT NULL, name text, qty numeric)`);
    const repo = defineRepository({ table, columns: ['name', 'qty'] });
    // This scratch table is not one the tenant role may use; the role path is
    // covered by dataRls.db.test.mjs.
    const asOwner = { pool, role: null };
    const rowA = await withTenant(a, (db) => repo.insert(db, { name: 'cable', qty: '250.25' }), asOwner);
    await withTenant(b, (db) => repo.insert(db, { name: 'pump', qty: 3 }), asOwner);
    check('insert stores the tenant from the handle', rowA.user_id === a && rowA.qty === '250.25', rowA);
    const seenByB = await withTenant(b, (db) => repo.findMany(db), asOwner);
    check("a tenant lists only its own rows", seenByB.length === 1 && seenByB[0].name === 'pump', seenByB);
    check("findById of another tenant's row returns nothing", (await withTenant(b, (db) => repo.findById(db, rowA.id), asOwner)) === null);
    check("update of another tenant's row changes nothing", (await withTenant(b, (db) => repo.update(db, rowA.id, { name: 'stolen' }), asOwner)) === null);
    check("remove of another tenant's row removes nothing", (await withTenant(b, (db) => repo.remove(db, rowA.id), asOwner)) === false);
    const still = await withTenant(a, (db) => repo.findById(db, rowA.id), asOwner);
    check('the owner still sees the row unchanged', still && still.name === 'cable');
    check('count is per tenant', (await withTenant(a, (db) => repo.count(db), asOwner)) === 1);

    console.log('\nshared Postgres cache');
    const reg = await pool.query("SELECT relpersistence FROM pg_class WHERE relname = 'starlane_cache'");
    check('starlane_cache exists and is UNLOGGED (migration 090)', reg.rows[0] && reg.rows[0].relpersistence === 'u', reg.rows);
    const ns = `t${randomUUID().slice(0, 6)}`;
    const server1 = createCache({ backend: createPostgresBackend({ pool }), namespace: ns });
    const server2 = createCache({ backend: createPostgresBackend({ pool }), namespace: ns });
    await server1.set(a, 'home', { total: 7, rows: [1, 2] }, 60);
    const v = await server2.get(a, 'home');
    check('a value written by one server is read by another', v && v.total === 7 && v.rows.length === 2, v);
    check('another tenant gets a miss for the same key', (await server2.get(b, 'home')) === undefined);
    await server2.clearTenant(a);
    check('an invalidation on one server is seen by the other', (await server1.get(a, 'home')) === undefined);
    await server1.set(a, 'short', 1, 0.05);
    await new Promise((r) => setTimeout(r, 120));
    check('expired values are misses', (await server1.get(a, 'short')) === undefined);
    const purged = await server1.purgeExpired();
    check('purgeExpired removes expired rows', purged >= 1, purged);
    await pool.query('DELETE FROM starlane_cache WHERE starts_with(cache_key, $1)', [`${ns}:`]);
  } finally {
    await pool.query(`DROP TABLE IF EXISTS ${table}`).catch(() => {});
    await pool.end();
  }
  done();
}

main().catch((err) => { console.error(err); process.exit(1); });
