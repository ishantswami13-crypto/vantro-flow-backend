#!/usr/bin/env node
// FILE: scripts/demo/seed-supplier-delay.js
// `npm run demo:supplier-delay` — writes the synthetic supplier-delay demo
// tenant (Kaveri Cycle Works, invented) into a LOCAL database and prints how
// to sign in and what to do next.
//
// Uses exactly the fixture the end-to-end test uses
// (tests/fixtures/supplierDelay.js), so the demo and the test cannot drift.
// Dates are relative to today, so re-run on the morning of a meeting.
//
// Refuses to run against a non-local database (lib/db/testDatabaseGuard.js)
// unless ALLOW_REMOTE_TEST_DATABASE=1 is set deliberately for a disposable
// one. Idempotent: deletes and recreates only its own .invalid tenant.
//
// Usage: DATABASE_URL=postgres://...@127.0.0.1/... node scripts/demo/seed-supplier-delay.js
// Optional DEMO_PASSWORD (8+ characters): the demo owner can then sign in on
// the normal login page with owner@supplier-delay-demo.invalid and it.

require('dotenv').config();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { assertTestDatabase } = require('../../lib/db/testDatabaseGuard');
const { seedSupplierDelay, deleteSupplierDelayData } = require('../../tests/fixtures/supplierDelay');

const EMAIL = 'owner@supplier-delay-demo.invalid';

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required (a local database).');
  assertTestDatabase(process.env.DATABASE_URL);
  const password = process.env.DEMO_PASSWORD || '';
  if (password && password.length < 8) throw new Error('DEMO_PASSWORD must be at least 8 characters.');
  const passwordHash = password ? await bcrypt.hash(password, 10) : null;
  const { getPool } = require('../../lib/db/pg');
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const prior = await client.query('SELECT id FROM users WHERE email = $1', [EMAIL]);
    for (const row of prior.rows) {
      await deleteSupplierDelayData(client, row.id);
      await client.query('DELETE FROM users WHERE id = $1', [row.id]);
    }
    const u = await client.query(`INSERT INTO users (email, business_name, owner_name, password_hash) VALUES ($1, 'Kaveri Cycle Works (synthetic)', 'Demo Owner', $2) RETURNING id`, [EMAIL, passwordHash]);
    const userId = u.rows[0].id;
    const today = new Date().toISOString().slice(0, 10);
    const fx = await seedSupplierDelay(client, userId, today);
    await client.query('COMMIT');

    console.log(`Seeded synthetic tenant Kaveri Cycle Works: ${userId} (${EMAIL})`);
    console.log(`Frame shipment (purchase line) ${fx.frameLineId}: 50 frames from Shenzhen Frame Co, expected ${fx.frameOriginalDate}`);
    console.log(`Wheel shipment (purchase line) ${fx.wheelLineId}: 100 wheels from Pune Wheel Works (negative control)`);
    console.log('Expected after reporting the frame delay to', fx.delayedDate, ':');
    console.log(`  at risk because of the delay: ${fx.expected.atRisk.join(', ')} (₹${fx.expected.valueAtRisk.toLocaleString('en-IN')})`);
    console.log(`  already at risk regardless:   ${fx.expected.alreadyAtRisk.join(', ')}`);
    console.log(`  on time:                      ${fx.expected.onTime.join(', ')}`);
    console.log(password
      ? `\nSign in on the app's login page as ${EMAIL} with the DEMO_PASSWORD you set, then open Decisions > Inbound shipments.`
      : '\nSet DEMO_PASSWORD (8+ characters) when seeding to sign in on the normal login page.');
    if (process.env.JWT_SECRET) {
      const token = jwt.sign({ userId, email: EMAIL }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '4h' });
      console.log('\nToken (4h, local only):');
      console.log(token);
      console.log('\nReport the delay:');
      console.log(`curl -s -X POST http://localhost:3001/api/decisions/report-supplier-delay -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"purchaseLineItemId":"${fx.frameLineId}","newExpectedAt":"${fx.delayedDate}","reason":"Factory power cuts"}'`);
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => { console.error('SEED FAILED:', err.message); process.exit(1); });
