// FILE: tests/entities.test.js
// Spaces: several companies under one account (lib/routes/entities.js).
//   - create, rename and delete a company; names are unique per account;
//   - assign customers and suppliers, and a name moves between companies;
//   - one tenant can never read, change or delete another tenant's companies;
//   - bad input is refused with a 400, never stored.
//
// Run: DATABASE_URL=... JWT_SECRET=... node --test tests/entities.test.js
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

test('Spaces: companies, members and tenant isolation over HTTP', async (t) => {
  const ready = await dbReady();
  if (!ready.ok) { t.skip(ready.reason); return; }
  const pool = getPool();
  const a = await createTenant(pool, 'entities-a');
  const b = await createTenant(pool, 'entities-b');
  const srv = await startServer();
  try {
    const A = client(srv.base, a);
    const B = client(srv.base, b);

    let r = await A('GET', '/api/entities');
    assert.equal(r.status, 200);
    assert.equal(r.body.available, true);
    assert.deepEqual(r.body.entities, []);

    r = await A('POST', '/api/entities', { name: '  Halden   UK ', currency: 'gbp', country: 'gb' });
    assert.equal(r.status, 201);
    const uk = r.body.entity;
    assert.equal(uk.name, 'Halden UK');
    assert.equal(uk.currency, 'GBP');
    assert.equal(uk.country, 'GB');
    assert.match(uk.color, /^#[0-9A-F]{6}$/i);

    r = await A('POST', '/api/entities', { name: 'halden uk' });
    assert.equal(r.status, 409, 'names are unique per account, ignoring case');
    r = await A('POST', '/api/entities', { name: '' });
    assert.equal(r.status, 400);
    r = await A('POST', '/api/entities', { name: 'Halden GmbH', currency: 'euro' });
    assert.equal(r.status, 400);

    r = await A('POST', '/api/entities', { name: 'Halden GmbH', currency: 'EUR' });
    const de = r.body.entity;

    r = await A('PUT', `/api/entities/${uk.id}/members`, { customers: ['Arlo Freight', 'Kestrel Retail', 'arlo freight '], suppliers: ['Northwind Paper'] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.entity.customers.sort(), ['Arlo Freight', 'Kestrel Retail']);
    assert.deepEqual(r.body.entity.suppliers, ['Northwind Paper']);

    // Assigning Kestrel to GmbH moves it out of UK.
    r = await A('PUT', `/api/entities/${de.id}/members`, { customers: ['KESTREL RETAIL', 'Meridian GmbH'] });
    assert.equal(r.status, 200);
    r = await A('GET', '/api/entities');
    const byName = Object.fromEntries(r.body.entities.map((e) => [e.name, e]));
    assert.deepEqual(byName['Halden UK'].customers, ['Arlo Freight']);
    assert.deepEqual(byName['Halden GmbH'].customers.sort(), ['KESTREL RETAIL', 'Meridian GmbH']);

    r = await A('PUT', `/api/entities/${uk.id}/members`, { customers: 'Arlo' });
    assert.equal(r.status, 400);

    r = await A('PATCH', `/api/entities/${uk.id}`, { name: 'Halden Trading UK', currency: null });
    assert.equal(r.status, 200);
    assert.equal(r.body.entity.name, 'Halden Trading UK');
    assert.equal(r.body.entity.currency, null);

    // Tenant B sees none of A's companies and cannot touch them.
    r = await B('GET', '/api/entities');
    assert.deepEqual(r.body.entities, []);
    assert.equal((await B('PATCH', `/api/entities/${uk.id}`, { name: 'Taken' })).status, 404);
    assert.equal((await B('PUT', `/api/entities/${uk.id}/members`, { customers: ['X'] })).status, 404);
    assert.equal((await B('DELETE', `/api/entities/${uk.id}`)).status, 404);
    // B can use the same company name; names are unique per account only.
    assert.equal((await B('POST', '/api/entities', { name: 'Halden Trading UK' })).status, 201);

    r = await A('DELETE', `/api/entities/${de.id}`);
    assert.equal(r.status, 200);
    const left = await pool.query(`SELECT count(*)::int AS n FROM business_entity_members WHERE entity_id = $1`, [de.id]);
    assert.equal(left.rows[0].n, 0, 'members leave with their company');
    r = await A('GET', '/api/entities');
    assert.deepEqual(r.body.entities.map((e) => e.name), ['Halden Trading UK']);

    assert.equal((await A('PATCH', '/api/entities/not-a-uuid', { name: 'x' })).status, 404);
    // No token, no access.
    const anon = await fetch(`${srv.base}/api/entities`);
    assert.equal(anon.status, 401);
  } finally {
    await srv.stop();
    await pool.query(`DELETE FROM business_entities WHERE user_id = ANY($1::uuid[])`, [[a.id, b.id]]).catch(() => {});
    await deleteTenant(pool, a.id);
    await deleteTenant(pool, b.id);
  }
});
