// FILE: tests/reps.test.js
// Team dashboard: the people who own customer accounts (lib/routes/reps.js).
//   - add, rename and remove a rep; names are unique per account;
//   - assign customers, and a customer moves between reps;
//   - one tenant can never read, change or delete another tenant's reps;
//   - bad input is refused with a 400, never stored.
//
// Run: DATABASE_URL=... JWT_SECRET=... node --test tests/reps.test.js
// Database tests skip (never pass silently) without a database.

const test = require('node:test');
const assert = require('node:assert/strict');
const { dbReady, createTenant, deleteTenant, startServer, tokenFor } = require('./helpers/decisionHarness');

function client(base, user) {
  const token = tokenFor(user);
  return async (method, url, body) => {
    const r = await fetch(`${base}${url}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { status: r.status, body: json };
  };
}
const { getPool } = require('../lib/db/pg');

test('Team dashboard: reps, customers and tenant isolation over HTTP', async (t) => {
  const ready = await dbReady();
  if (!ready.ok) { t.skip(ready.reason); return; }
  const pool = getPool();
  const a = await createTenant(pool, 'reps-a');
  const b = await createTenant(pool, 'reps-b');
  const srv = await startServer();
  try {
    const A = client(srv.base, a);
    const B = client(srv.base, b);

    let r = await A('GET', '/api/reps');
    assert.equal(r.status, 200);
    assert.equal(r.body.available, true);
    assert.deepEqual(r.body.reps, []);

    r = await A('POST', '/api/reps', { name: '  Priya   Shah ', email: 'Priya@Halden.com', region: ' North ' });
    assert.equal(r.status, 201);
    const priya = r.body.rep;
    assert.equal(priya.name, 'Priya Shah');
    assert.equal(priya.email, 'priya@halden.com');
    assert.equal(priya.region, 'North');
    assert.match(priya.color, /^#[0-9A-F]{6}$/i);

    assert.equal((await A('POST', '/api/reps', { name: 'priya shah' })).status, 409, 'names are unique per account, ignoring case');
    assert.equal((await A('POST', '/api/reps', { name: '' })).status, 400);
    assert.equal((await A('POST', '/api/reps', { name: 'Tom', email: 'not-an-email' })).status, 400);

    r = await A('POST', '/api/reps', { name: 'Tom Reid' });
    const tom = r.body.rep;

    r = await A('PUT', `/api/reps/${priya.id}/customers`, { customers: ['Arlo Freight', 'Kestrel Retail', 'arlo freight '] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.rep.customers.sort(), ['Arlo Freight', 'Kestrel Retail']);

    // Giving Kestrel to Tom moves it away from Priya.
    r = await A('PUT', `/api/reps/${tom.id}/customers`, { customers: ['KESTREL RETAIL', 'Meridian GmbH'] });
    assert.equal(r.status, 200);
    r = await A('GET', '/api/reps');
    const byName = Object.fromEntries(r.body.reps.map((x) => [x.name, x]));
    assert.deepEqual(byName['Priya Shah'].customers, ['Arlo Freight']);
    assert.deepEqual(byName['Tom Reid'].customers.sort(), ['KESTREL RETAIL', 'Meridian GmbH']);

    assert.equal((await A('PUT', `/api/reps/${priya.id}/customers`, { customers: 'Arlo' })).status, 400);

    r = await A('PATCH', `/api/reps/${priya.id}`, { name: 'Priya S.', region: null });
    assert.equal(r.status, 200);
    assert.equal(r.body.rep.name, 'Priya S.');
    assert.equal(r.body.rep.region, null);

    // Tenant B sees none of A's team and cannot touch it.
    r = await B('GET', '/api/reps');
    assert.deepEqual(r.body.reps, []);
    assert.equal((await B('PATCH', `/api/reps/${priya.id}`, { name: 'Taken' })).status, 404);
    assert.equal((await B('PUT', `/api/reps/${priya.id}/customers`, { customers: ['X'] })).status, 404);
    assert.equal((await B('DELETE', `/api/reps/${priya.id}`)).status, 404);
    assert.equal((await B('POST', '/api/reps', { name: 'Priya S.' })).status, 201, 'names are unique per account only');

    r = await A('DELETE', `/api/reps/${tom.id}`);
    assert.equal(r.status, 200);
    const left = await pool.query(`SELECT count(*)::int AS n FROM sales_rep_customers WHERE rep_id = $1`, [tom.id]);
    assert.equal(left.rows[0].n, 0, 'customers become unassigned when their rep is removed');
    r = await A('GET', '/api/reps');
    assert.deepEqual(r.body.reps.map((x) => x.name), ['Priya S.']);

    assert.equal((await A('PATCH', '/api/reps/not-a-uuid', { name: 'x' })).status, 404);
    const anon = await fetch(`${srv.base}/api/reps`);
    assert.equal(anon.status, 401);
  } finally {
    await srv.stop();
    await pool.query(`DELETE FROM sales_reps WHERE user_id = ANY($1::uuid[])`, [[a.id, b.id]]).catch(() => {});
    await deleteTenant(pool, a.id);
    await deleteTenant(pool, b.id);
  }
});
