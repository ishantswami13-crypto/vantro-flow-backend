// L2 event log (lib/data/events) against a real Postgres (DATABASE_URL, local
// only, migrations applied): transactional outbox, idempotency, tenant reads,
// commit-order delivery, exactly-once projections, retries, multi-server
// consumers, broadcast cache invalidation and LISTEN/NOTIFY wake-ups.
import { createRequire } from 'module';
import { randomUUID } from 'crypto';
import { makeChecker } from './helpers/httpHarness.mjs';

const require = createRequire(import.meta.url);
require('../lib/db/testDatabaseGuard').assertTestDatabase(process.env.DATABASE_URL);
const { Pool } = require('pg');
const { buildSanitizedPgConfig } = require('../lib/db/pgConfig');
const { withTenant } = require('../lib/data/tenantDb');
const { appendEvent, readStream, recentEvents, createDispatcher, cacheInvalidationConsumer } = require('../lib/data/events');
const { createCache, createMemoryBackend } = require('../lib/data/cache');
const { check, done } = makeChecker();

const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = () => {};

async function main() {
  if (!process.env.DATABASE_URL) { console.log('SKIP event log DB checks: DATABASE_URL not set'); return done(); }
  const config = buildSanitizedPgConfig(process.env.DATABASE_URL);
  const pool = new Pool({ ...config, max: 6 });
  const a = randomUUID();
  const b = randomUUID();
  const run = randomUUID().slice(0, 8);
  const type = (t) => `test.r${run}.${t}`;
  const proj = `dl_proj_${run}`;
  const consumerNames = [];
  try {
    console.log('transactional outbox');
    await rejects(withTenant(a, async (db) => {
      await appendEvent(db, { stream: 'order:1', type: type('created'), payload: { n: 1 } });
      throw new Error('the business change failed');
    }, { pool }));
    const afterRollback = await pool.query('SELECT count(*)::int AS n FROM event_log WHERE event_type = $1', [type('created')]);
    check('an event appended in a rolled-back transaction does not exist', afterRollback.rows[0].n === 0);

    const first = await withTenant(a, (db) => appendEvent(db, { stream: 'order:1', type: type('created'), payload: { n: 1 }, idempotencyKey: `k-${run}` }), { pool });
    const again = await withTenant(a, (db) => appendEvent(db, { stream: 'order:1', type: type('created'), payload: { n: 99 }, idempotencyKey: `k-${run}` }), { pool });
    check('the same idempotency key returns the first event and writes nothing', !first.duplicate && again.duplicate && again.event.eventId === first.event.eventId && again.event.payload.n === 1);
    const otherTenant = await withTenant(b, (db) => appendEvent(db, { stream: 'order:1', type: type('created'), payload: { n: 2 }, idempotencyKey: `k-${run}` }), { pool });
    check('idempotency keys are per tenant', !otherTenant.duplicate);
    check('events carry the tenant from the handle', first.event.userId === a && otherTenant.event.userId === b);
    check('an invalid event type is refused', !!(await rejects(withTenant(a, (db) => appendEvent(db, { stream: 's', type: 'Bad Type!' }), { pool }))));
    check('a payload over 64 KB is refused', !!(await rejects(withTenant(a, (db) => appendEvent(db, { stream: 's', type: type('big'), payload: { x: 'y'.repeat(70000) } }), { pool }))));
    const streamA = await withTenant(a, (db) => readStream(db, 'order:1'), { pool });
    check("readStream returns only this tenant's events", streamA.length === 1 && streamA[0].userId === a, streamA.length);
    const recentB = await withTenant(b, (db) => recentEvents(db, { types: [type('created')] }), { pool });
    check("recentEvents returns only this tenant's events", recentB.length === 1 && recentB[0].payload.n === 2);

    console.log('\ndurable consumers');
    await pool.query(`CREATE TABLE ${proj} (user_id uuid PRIMARY KEY, orders int NOT NULL DEFAULT 0)`);
    const seen = [];
    let failNext = false;
    const projector = (name) => ({
      name,
      types: [type('placed')],
      async handle(event, { db }) {
        seen.push(`${name}:${event.payload.n}`);
        await db.query(`INSERT INTO ${proj} (user_id, orders) VALUES ($1, 1) ON CONFLICT (user_id) DO UPDATE SET orders = ${proj}.orders + 1`, [event.userId]);
        if (failNext && event.payload.n === 3) { failNext = false; throw new Error('handler failed once'); }
      },
    });
    const pname = `test.proj-${run}`;
    consumerNames.push(pname);
    const server1 = createDispatcher({ pool, consumers: [projector(pname)], batchSize: 2, log: quiet });
    const server2 = createDispatcher({ pool, consumers: [projector(pname)], batchSize: 2, log: quiet });
    for (let n = 1; n <= 5; n += 1) {
      await withTenant(n % 2 ? a : b, (db) => appendEvent(db, { stream: `order:${n}`, type: type('placed'), payload: { n } }), { pool });
    }
    failNext = true;
    await server1.runAll();
    const mid = await pool.query(`SELECT coalesce(sum(orders), 0)::int AS n FROM ${proj}`);
    const cur = await pool.query('SELECT last_error FROM event_consumers WHERE name = $1', [pname]);
    check('a failing handler stops the consumer at that event and its write is rolled back', mid.rows[0].n === 2 && /failed once/.test(cur.rows[0].last_error || ''), { projected: mid.rows[0].n });
    check('the failure is visible in stats', server1.stats()[pname].errors === 1);
    await Promise.all([server1.runAll(), server2.runAll()]);
    const total = await pool.query(`SELECT user_id, orders FROM ${proj} ORDER BY orders DESC`);
    const sum = total.rows.reduce((s, r) => s + r.orders, 0);
    check('after the retry every event is projected exactly once, even with two servers racing', sum === 5, total.rows);
    check('per-tenant projection is right (a: 3, b: 2)', total.rows.find((r) => r.user_id === a)?.orders === 3 && total.rows.find((r) => r.user_id === b)?.orders === 2);
    const order = seen.map((s) => Number(s.split(':')[1]));
    check('events are handled in commit order', order.slice(0, 2).join() === '1,2' && order.at(-1) === 5, order);
    const cleared = await pool.query('SELECT last_error, processed FROM event_consumers WHERE name = $1', [pname]);
    check('the consumer records progress and clears its error', cleared.rows[0].last_error === null && Number(cleared.rows[0].processed) === 5, cleared.rows[0]);
    await server1.runAll();
    const unchanged = await pool.query(`SELECT sum(orders)::int AS n FROM ${proj}`);
    check('running again with nothing new changes nothing', unchanged.rows[0].n === 5);

    console.log('\ncommit order');
    const cname = `test.order-${run}`;
    consumerNames.push(cname);
    const got = [];
    const orderD = createDispatcher({ pool, consumers: [{ name: cname, types: [type('slow'), type('fast')], handle: (e) => { got.push(e.payload.label); } }], log: quiet });
    const slow = await pool.connect();
    const fast = await pool.connect();
    try {
      await slow.query('BEGIN');
      await slow.query(`INSERT INTO event_log (user_id, stream, event_type, payload) VALUES ($1, 's', $2, '{"label":"slow"}')`, [a, type('slow')]);
      await fast.query('BEGIN');
      await fast.query(`INSERT INTO event_log (user_id, stream, event_type, payload) VALUES ($1, 's', $2, '{"label":"fast"}')`, [a, type('fast')]);
      await fast.query('COMMIT');
      await orderD.runAll();
      check('a later commit is held back while an earlier transaction is still open', got.length === 0, got);
      await slow.query('COMMIT');
      await orderD.runAll();
      check('once it commits, neither event is skipped', got.length === 2 && got.includes('slow') && got.includes('fast'), got);
    } finally {
      slow.release(); fast.release();
    }

    console.log('\nbroadcast cache invalidation');
    const cache1 = createCache({ backend: createMemoryBackend(), namespace: 'srv1' });
    const cache2 = createCache({ backend: createMemoryBackend(), namespace: 'srv2' });
    const d1 = createDispatcher({ pool, consumers: [cacheInvalidationConsumer(cache1)], pollMs: 60000, log: quiet });
    const d2 = createDispatcher({ pool, consumers: [cacheInvalidationConsumer(cache2)], pollMs: 60000, log: quiet, listen: config });
    await d1.start(); await d2.start();
    try {
      await cache1.set(a, 'home', 1); await cache2.set(a, 'home', 1); await cache2.set(b, 'home', 2);
      await d1.runAll(); await d2.runAll();
      check('broadcast consumers start at now and do not replay history', (await cache1.get(a, 'home')) === 1 && (await cache2.get(a, 'home')) === 1);
      await withTenant(a, (db) => appendEvent(db, { stream: 'order:9', type: type('paid'), payload: {} }), { pool });
      await d1.runAll();
      check("an event clears that tenant's cache on server 1", (await cache1.get(a, 'home')) === undefined);
      let woke = false;
      for (let i = 0; i < 40 && !woke; i += 1) { await sleep(50); woke = (await cache2.get(a, 'home')) === undefined; }
      check('LISTEN/NOTIFY wakes server 2 without waiting for a poll', d2.isListening() && woke);
      check("other tenants' cache entries are untouched", (await cache2.get(b, 'home')) === 2);
    } finally {
      await d1.stop(); await d2.stop();
    }
    check('consumer names are validated', !!(await rejects((async () => createDispatcher({ pool, consumers: [{ name: 'Bad Name', handle() {} }] }))())));
  } finally {
    await pool.query(`DROP TABLE IF EXISTS ${proj}`).catch(() => {});
    await pool.query('DELETE FROM event_consumers WHERE name = ANY($1)', [consumerNames]).catch(() => {});
    await pool.query('DELETE FROM event_log WHERE user_id = ANY($1)', [[a, b]]).catch(() => {});
    await pool.end();
  }
  done();
}

main().catch((err) => { console.error(err); process.exit(1); });
