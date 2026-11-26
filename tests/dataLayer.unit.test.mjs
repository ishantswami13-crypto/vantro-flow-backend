// Data access layer (lib/data) without a database: tenant transactions,
// tenant-scoped repositories and the L1 cache.
import { createRequire } from 'module';
import { makeChecker } from './helpers/httpHarness.mjs';

const require = createRequire(import.meta.url);
const { withTenant, readTenant, assertTenantId } = require('../lib/data/tenantDb');
const { defineRepository, MAX_LIMIT } = require('../lib/data/repository');
const { createCache, createMemoryBackend, _setLogger } = require('../lib/data/cache');
const { check, done } = makeChecker();
_setLogger(() => {});

const throws = (fn) => { try { fn(); return false; } catch { return true; } };
const rejects = async (p) => { try { await p; return false; } catch { return true; } };

function fakePool({ failOn } = {}) {
  const log = [];
  let released = 0;
  const client = {
    async query(text, params) {
      log.push({ text, params });
      if (failOn && text.includes(failOn)) throw new Error('boom');
      return { rows: [], rowCount: 0 };
    },
    release() { released += 1; },
  };
  return { log, released: () => released, connect: async () => client };
}

function fakeDb(userId = 'tenant-a', rows = []) {
  const calls = [];
  return { calls, userId, query: async (text, params) => { calls.push({ text, params }); return { rows, rowCount: rows.length }; } };
}

async function main() {
  console.log('tenant transactions');
  check('a missing tenant id is refused', throws(() => assertTenantId(undefined)) && throws(() => assertTenantId('')) && throws(() => assertTenantId('undefined')));
  {
    const pool = fakePool();
    const out = await withTenant('u1', async (db) => { await db.query('SELECT 1'); return db.userId; }, { pool, timeoutMs: 5000 });
    const texts = pool.log.map((l) => l.text);
    check('runs BEGIN, sets the tenant, runs the work, COMMITs', texts[0] === 'BEGIN' && texts[1].includes("set_config('app.user_id', $1, true)") && texts[2] === 'SELECT 1' && texts[3] === 'COMMIT', texts);
    check('tenant and timeout are transaction-local (is_local = true), never session SET', texts.every((t) => !/^\s*SET\s/i.test(t)) && texts[1].includes("set_config('statement_timeout', $2, true)"));
    check('passes the tenant and timeout as bound values', pool.log[1].params[0] === 'u1' && pool.log[1].params[1] === '5000', pool.log[1].params);
    check('the handle exposes the tenant id', out === 'u1');
    check('the connection is released', pool.released() === 1);
  }
  {
    const pool = fakePool();
    await withTenant('u1', async () => {}, { pool, timeoutMs: 10 ** 9 });
    check('timeouts are capped at 120 s', pool.log[1].params[1] === '120000', pool.log[1].params);
  }
  {
    const pool = fakePool();
    const failed = await rejects(withTenant('u1', async () => { throw new Error('work failed'); }, { pool }));
    check('an error in the work rolls back and rethrows', failed && pool.log.at(-1).text === 'ROLLBACK' && pool.released() === 1);
  }
  {
    const pool = fakePool();
    await readTenant('u1', async () => {}, { pool });
    check('readTenant opens a READ ONLY transaction', pool.log[0].text === 'BEGIN READ ONLY');
  }

  console.log('\ntenant-scoped repositories');
  const orders = defineRepository({ table: 'sales_orders', columns: ['status', 'customer_name', 'amount', 'created_at'] });
  check('a repository refuses bad identifiers', throws(() => defineRepository({ table: 'x; drop', columns: ['a'] })) && throws(() => defineRepository({ table: 't', columns: ['a"b'] })));
  check('calling without a tenant handle is refused', await rejects(orders.findMany({ query: async () => ({ rows: [] }) })));
  {
    const db = fakeDb();
    await orders.findMany(db, { status: 'open', customer_name: ['A', 'B'], amount: null }, { orderBy: 'created_at desc', limit: 50 });
    const { text, params } = db.calls[0];
    check('findMany always filters by the tenant first', /WHERE "user_id" = \$1 AND/.test(text) && params[0] === 'tenant-a', text);
    check('filters are bound values; arrays use ANY, null uses IS NULL', text.includes('"status" = $2') && text.includes('"customer_name" = ANY($3)') && text.includes('"amount" IS NULL'), text);
    check('ordering is whitelisted', text.includes('ORDER BY "created_at" DESC'));
    check('limit is bound', params.at(-1) === 50);
  }
  {
    const db = fakeDb();
    await orders.findMany(db, {}, { limit: 10 ** 6 });
    check(`limit is capped at ${MAX_LIMIT}`, db.calls[0].params.at(-1) === MAX_LIMIT);
  }
  check('unknown filter columns are refused', await rejects(orders.findMany(fakeDb(), { password_hash: 'x' })));
  check('an explicit tenant filter is refused (it is implicit)', await rejects(orders.findMany(fakeDb(), { user_id: 'tenant-b' })));
  check('sort direction is validated', await rejects(orders.findMany(fakeDb(), {}, { orderBy: 'created_at; drop table users' })));
  {
    const db = fakeDb('tenant-a', [{ id: 1 }]);
    await orders.insert(db, { status: 'open', amount: 10 });
    const { text, params } = db.calls[0];
    check('insert sets user_id from the tenant handle', text.startsWith('INSERT INTO "sales_orders" ("user_id", "status", "amount")') && params[0] === 'tenant-a', text);
  }
  check('insert refuses a user_id in the row', await rejects(orders.insert(fakeDb(), { user_id: 'tenant-b', status: 'open' })));
  {
    const db = fakeDb('tenant-a', [{ id: 7 }]);
    await orders.update(db, 7, { status: 'closed' });
    const { text, params } = db.calls[0];
    check('update is scoped to the tenant and id', text.includes('SET "status" = $1 WHERE "user_id" = $2 AND "id" = $3') && params.join() === 'closed,tenant-a,7', text);
  }
  check('update cannot move a row to another tenant', await rejects(orders.update(fakeDb(), 7, { user_id: 'tenant-b' })));
  check('update cannot change the primary key', await rejects(orders.update(fakeDb(), 7, { id: 8 })));
  {
    const db = fakeDb();
    await orders.remove(db, 7);
    check('remove is scoped to the tenant and id', db.calls[0].text === 'DELETE FROM "sales_orders" WHERE "user_id" = $1 AND "id" = $2');
  }

  console.log('\nL1 cache');
  let clock = 1000;
  const cache = createCache({ backend: createMemoryBackend({ now: () => clock, maxEntries: 3 }), namespace: 'test' });
  await cache.set('t1', 'home', { total: 5 }, 60);
  check('a value comes back for its tenant', (await cache.get('t1', 'home'))?.total === 5);
  check('another tenant never sees it under the same key', (await cache.get('t2', 'home')) === undefined);
  {
    const v = await cache.get('t1', 'home');
    v.total = 999;
    check('a returned value is a copy; mutating it does not change the cache', (await cache.get('t1', 'home')).total === 5);
  }
  clock += 61000;
  check('values expire after their TTL', (await cache.get('t1', 'home')) === undefined);
  check('a call without a tenant is refused', await rejects(cache.get(undefined, 'home')));
  check('keys with spaces or quotes are refused', await rejects(cache.set('t1', "a b'", 1)));
  {
    await cache.set('t1', 'a', 1); await cache.set('t1', 'b', 2); await cache.set('t2', 'a', 3);
    await cache.clearTenant('t1');
    check('clearTenant drops only that tenant', (await cache.get('t1', 'a')) === undefined && (await cache.get('t2', 'a')) === 3);
  }
  {
    let calls = 0;
    const v1 = await cache.getOrSet('t3', 'zero', 60, async () => { calls += 1; return 0; });
    const v2 = await cache.getOrSet('t3', 'zero', 60, async () => { calls += 1; return 0; });
    check('a cached 0 is a hit (the old getOrSet refetched falsy values)', v1 === 0 && v2 === 0 && calls === 1, calls);
  }
  {
    let calls = 0;
    let release;
    const slow = () => { calls += 1; return new Promise((r) => { release = r; }); };
    const a = cache.getOrSet('t4', 'k', 60, slow);
    const b = cache.getOrSet('t4', 'k', 60, slow);
    await new Promise((r) => setImmediate(r));
    release(42);
    const [ra, rb] = await Promise.all([a, b]);
    check('concurrent misses share one fetch', calls === 1 && ra === 42 && rb === 42, calls);
  }
  {
    const lru = createMemoryBackend({ maxEntries: 2 });
    const c = createCache({ backend: lru, namespace: 'lru' });
    await c.set('t', 'a', 1); await c.set('t', 'b', 2); await c.get('t', 'a'); await c.set('t', 'c', 3);
    check('the least recently used entry is evicted past the bound', (await c.get('t', 'b')) === undefined && (await c.get('t', 'a')) === 1 && lru.size() === 2);
  }
  {
    const broken = { name: 'broken', get: async () => { throw new Error('down'); }, set: async () => { throw new Error('down'); }, del: async () => {}, clearTenant: async () => {}, purgeExpired: async () => 0 };
    const c = createCache({ backend: broken, namespace: 'x' });
    let fetched = 0;
    const v = await c.getOrSet('t', 'k', 60, async () => { fetched += 1; return 'fresh'; });
    check('a failing backend fails open: the fetcher still answers', v === 'fresh' && fetched === 1 && c.stats().errors >= 2, c.stats());
  }

  {
    const { businessToday, asOfDay } = require('../lib/data/readModels/receivables');
    // 2026-11-26 20:00 UTC is 01:30 on 27 Nov in India: the owner's day has turned.
    const late = new Date('2026-11-26T20:00:00Z');
    check('the default as-of day is the business day in Asia/Kolkata, not UTC', businessToday(late) === '2026-11-27', businessToday(late));
    check('BUSINESS_TIMEZONE is honoured', businessToday(late, 'Europe/London') === '2026-11-26');
    check('an invalid timezone falls back to UTC instead of throwing', businessToday(late, 'Not/AZone') === '2026-11-26');
    check('an explicit asOf is used as given', asOfDay('2026-01-31') === '2026-01-31');
  }
  {
    const { parseSpec } = require('../lib/data/analytics');
    const refused = (spec) => { try { parseSpec(spec); return null; } catch (e) { return e; } };
    for (const d of ['2026-13-01', '2026-02-30', '2026-11-31']) {
      const e = refused({ measures: 'invoiced', from: d });
      check(`cube refuses impossible date ${d} as a 400 (RangeError), not a SQL error`, e instanceof RangeError, e && e.message);
    }
    check('cube accepts 2028-02-29', refused({ measures: 'invoiced', to: '2028-02-29' }) === null);
  }

  done();
}

main().catch((err) => { console.error(err); process.exit(1); });
