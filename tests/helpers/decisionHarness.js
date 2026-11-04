// FILE: tests/helpers/decisionHarness.js
// Shared setup for the decision-loop tests: a real Postgres (DATABASE_URL),
// throwaway tenants on the reserved .invalid domain, the golden fixture
// written into real tables, and a real server process on a random port.
// Nothing here talks to production or any external service.

require('dotenv').config();
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');
const { getPool } = require('../../lib/db/pg');
const { buildGoldenReceivables } = require('../fixtures/goldenReceivables');

async function dbReady() {
  if (!process.env.DATABASE_URL) return { ok: false, reason: 'DATABASE_URL not set' };
  try {
    const pool = getPool();
    const r = await pool.query(`SELECT to_regclass('public.decisions') AS t`);
    if (!r.rows[0].t) return { ok: false, reason: 'migration 060_decision_core.sql not applied' };
    return { ok: true, pool };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

async function createTenant(pool, label = 'tenant') {
  const email = `decisions-${label}-${crypto.randomBytes(4).toString('hex')}@golden-fixture.invalid`;
  const r = await pool.query(`INSERT INTO users (email, business_name) VALUES ($1, $2) RETURNING id`, [email, `Golden Fixture ${label}`]);
  return { id: r.rows[0].id, email };
}

async function deleteTenant(pool, userId) {
  for (const t of ['promises', 'tasks', 'ai_actions', 'followups', 'business_memory', 'predictions', 'agent_runs', 'payment_plans', 'dunning_rules']) {
    await pool.query(`DELETE FROM ${t} WHERE user_id = $1`, [userId]).catch(() => {});
  }
  await pool.query('DELETE FROM users WHERE id = $1', [userId]);
}

/**
 * Writes the golden fixture for one tenant. `asOfIso` is the date the
 * fixture is centred on (normally today, so live discovery sees it as now).
 */
async function seedGolden(pool, userId, asOfIso) {
  const fx = buildGoldenReceivables(asOfIso, { next: () => crypto.randomUUID() });
  for (const c of fx.raw.customers) {
    await pool.query(
      `INSERT INTO customers (id, user_id, name, advance_required, escalation_paused, tags) VALUES ($1,$2,$3,$4,$5,$6)`,
      [c.id, userId, c.name, c.advance_required, c.escalation_paused, c.tags]
    );
  }
  for (const i of fx.raw.invoices) {
    await pool.query(
      `INSERT INTO invoices (id, user_id, invoice_number, customer_name, invoice_amount, payment_status, invoice_date, due_date, payment_date, payment_amount, currency, created_at, updated_at, source_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'golden_fixture')`,
      [i.id, userId, i.invoice_number, i.customer_name, i.invoice_amount, i.payment_status, i.invoice_date, i.due_date, i.payment_date, i.payment_amount, i.currency, i.created_at, i.updated_at]
    );
  }
  for (const d of fx.raw.disputes) {
    await pool.query(
      `INSERT INTO disputes (id, user_id, invoice_id, customer_name, disputed_amount, reason, status, created_at, resolved_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [d.id, userId, d.invoice_id, d.customer_name, d.disputed_amount, d.reason, d.status, d.created_at, d.resolved_at]
    );
  }
  for (const p of fx.raw.promises) {
    await pool.query(
      `INSERT INTO promises (id, user_id, customer_id, promised_amount, promised_date, status, created_at, resolved_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [p.id, userId, p.customer_id, p.promised_amount, p.promised_date, p.status, p.created_at, p.resolved_at]
    );
  }
  return fx;
}

function tokenFor(user) {
  return jwt.sign({ userId: user.id, email: user.email }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
}

async function startServer(extraEnv = {}) {
  const port = 4100 + Math.floor(Math.random() * 800);
  const child = spawn(process.execPath, [path.join(__dirname, '..', '..', 'server.js')], {
    env: { ...process.env, PORT: String(port), NODE_ENV: process.env.NODE_ENV || 'test', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`server exited early:\n${log.slice(-2000)}`);
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.status < 500) break;
    } catch { /* not up yet */ }
    await new Promise((res) => setTimeout(res, 250));
  }
  return {
    base,
    log: () => log,
    async stop() {
      child.kill('SIGTERM');
      await new Promise((res) => { if (child.exitCode != null) res(); else child.once('exit', res); });
    },
  };
}

function client(base, user) {
  const token = tokenFor(user);
  async function call(method, url, body) {
    const r = await fetch(`${base}${url}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { status: r.status, body: json };
  }
  return {
    get: (u) => call('GET', u),
    post: (u, b = {}) => call('POST', u, b),
    put: (u, b = {}) => call('PUT', u, b),
  };
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

module.exports = { dbReady, createTenant, deleteTenant, seedGolden, startServer, client, tokenFor, todayIso };
