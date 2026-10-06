// Embedded selects (`rel(cols)`) through the pg shim: many-to-one and one-to-many.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Pool } = require('pg');
const { makeShim } = require('./pgSupabaseShim');

const url = process.env.DATABASE_URL;
if (!url) { console.log('SKIP needs DATABASE_URL'); process.exit(0); }
require('../testing/assertTestDatabase').assertTestDatabase(url);
const pool = new Pool({ connectionString: url });
const s = `shim_${Date.now()}`;
try {
  // Every statement names the schema. No `SET search_path`: through a pooler it
  // outlives this test on a shared connection and breaks every other client.
  await pool.query(`CREATE SCHEMA ${s}`);
  await pool.query(`CREATE TABLE ${s}.parents (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, user_id int, amount numeric(12,2) DEFAULT 10.5)`);
  await pool.query(`CREATE TABLE ${s}.parent_notes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), parent_id uuid, text text)`);
  await pool.query(`CREATE TABLE ${s}.kids (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), parent_id uuid, label text)`);
  const { rows: [a] } = await pool.query(`INSERT INTO ${s}.parents (name, user_id) VALUES ('A', 1) RETURNING id`);
  const { rows: [b] } = await pool.query(`INSERT INTO ${s}.parents (name, user_id) VALUES ('B', 1) RETURNING id`);
  await pool.query(`INSERT INTO ${s}.parent_notes (parent_id, text) VALUES ($1,'n1'),($1,'n2')`, [a.id]);
  await pool.query(`INSERT INTO ${s}.kids (parent_id, label) VALUES ($1,'k1'),(NULL,'orphan')`, [b.id]);

  const shim2 = makeShim(`${url}${url.includes('?') ? '&' : '?'}options=-c%20search_path%3D${s}`);
  const r1 = await shim2.from('parents').select('*, parent_notes(*)').eq('user_id', 1).order('name', { ascending: true });
  assert.equal(r1.error, null);
  assert.equal(r1.data.length, 2);
  assert.equal(r1.data[0].parent_notes.length, 2);
  assert.deepEqual(r1.data[1].parent_notes, []);

  const r2 = await shim2.from('kids').select('label, parent_id, parents(name)').order('label', { ascending: true });
  assert.equal(r2.error, null);
  assert.deepEqual(r2.data[0].parents, { name: 'B' });
  assert.equal(r2.data[1].parents, null);

  assert.equal(typeof r1.data[0].amount, 'number', 'NUMERIC comes back as a number, like PostgREST');
  assert.equal(r1.data[0].amount + r1.data[1].amount, 21);

  const r3 = await shim2.from('kids').select('label').eq('label', 'k1').single();
  assert.equal(r3.data.label, 'k1');
  console.log('PASS pg shim embedded selects');
} finally {
  await pool.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
  await pool.end();
}
process.exit(0);
