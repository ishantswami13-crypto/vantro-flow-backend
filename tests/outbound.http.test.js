// FILE: tests/outbound.http.test.js
// /api/outreach over HTTP against a real server process and a real Postgres:
// auth, START refusing when the pipeline is not ready, LIVE needing an
// explicit confirmation, TEST needing the external-sending flag, /health,
// and cross-tenant access. Fixture tenants and *.invalid prospects only; the
// server runs with external sending forced off.
//
//   node --test --test-concurrency=1 tests/outbound.http.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers/outboundHarness');
const { dbReady, createTenant, startServer, client } = require('./helpers/decisionHarness');
const scheduler = require('../lib/domain/outbound/scheduler');

const SAFE_ENV = { FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED: 'false', STARLANE_GLOBAL_STOP: '', OUTBOUND_GLOBAL_STOP: '', OUTBOUND_FIXTURE_MODE: 'true' };
const NOW = new Date('2026-09-30T05:30:00Z');

let pool; let ready = false; const users = [];
test.before(async () => {
  const env = await dbReady();
  if (!env.ok) return;
  pool = env.pool;
  ready = await H.outboundReady(pool);
  if (ready) await H.resetSharedBuckets(pool);
});
test.after(async () => { if (pool) { await H.cleanupTenants(pool, users); await pool.end(); } });
const mk = async (label) => { const u = await createTenant(pool, `outreach-http-${label}`); users.push(u); return u; };

async function buildCampaignOverHttp(c, domain) {
  const acct = await c.post('/api/outreach/providers', { provider: 'sink' });
  assert.equal(acct.status, 201, JSON.stringify(acct.body));
  assert.equal(acct.body.hasCredentials, false);
  const camp = await c.post('/api/outreach/campaigns', {
    name: 'HTTP fixture outreach', goal: 'Book pilot conversations', cta: 'Would a 15-minute working session be useful?', allowedCountries: ['IN'],
    providerAccountId: acct.body.id, messageStrategy: { topic: 'inventory and working capital' },
  });
  assert.equal(camp.status, 201, JSON.stringify(camp.body));
  const imp = await c.post('/api/outreach/targets/import', { rows: [H.targetRow({ domain, first: 'Kavya' })], source: 'http-test' });
  assert.equal(imp.status, 200, JSON.stringify(imp.body));
  const contactId = imp.body.results.find((r) => r.contactId).contactId;
  assert.equal((await c.post(`/api/outreach/campaigns/${camp.body.id}/enroll`, { contactIds: [contactId] })).status, 200);
  const drafts = await c.post(`/api/outreach/campaigns/${camp.body.id}/drafts`);
  assert.equal(drafts.status, 200, JSON.stringify(drafts.body));
  const pending = (await c.get('/api/outreach/messages')).body.messages;
  assert.equal(pending.length, 1, 'one draft waiting for review');
  const rev = await c.post(`/api/outreach/messages/${pending[0].id}/review`, { decision: 'APPROVE' });
  assert.equal(rev.status, 200, JSON.stringify(rev.body));
  assert.equal((await c.post(`/api/outreach/campaigns/${camp.body.id}/start`)).status, 200);
  return { accountId: acct.body.id, campaignId: camp.body.id, contactId, messageId: pending[0].id };
}

test('auth, START refusal, LIVE confirmation, health, and tenant isolation over HTTP', async (tc) => {
  if (!ready) return tc.skip('needs a database with the app schema (migration 060+) and 062, so the server can boot');
  const server = await startServer({ ...SAFE_ENV, OUTBOUND_ENGINE_ENABLED: 'false' });
  try {
    const a = await mk('a');
    const b = await mk('b');
    const ca = client(server.base, a);
    const cb = client(server.base, b);

    // Auth
    assert.equal((await fetch(`${server.base}/api/outreach/status`)).status, 401);
    assert.equal((await fetch(`${server.base}/api/outreach/start`, { method: 'POST' })).status, 401);
    assert.equal((await fetch(`${server.base}/api/outreach/status`, { headers: { Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOiJ4In0.bad' } })).status, 401);

    const A = await buildCampaignOverHttp(ca, 'omega-http.invalid');

    // Health: DB, migrations and queue are fine; no runner in this process.
    const health = await ca.get('/api/outreach/health');
    assert.equal(health.status, 200, JSON.stringify(health.body));
    assert.equal(health.body.runnerInThisProcess, false);
    assert.equal(health.body.scheduler.status, 'BLOCKED');

    // START is refused while no scheduler/worker is running, and says why.
    const start = await ca.post('/api/outreach/start', { mode: 'SHADOW' });
    assert.equal(start.status, 409);
    assert.equal(start.body.started, false);
    const failed = start.body.preflight.checks.filter((x) => x.critical && x.status !== 'PASS').map((x) => x.name);
    assert.ok(failed.includes('SCHEDULER') && failed.includes('WORKERS'), failed.join(','));
    const refused = await pool.query(`SELECT COUNT(*)::int AS n FROM outbound_audit WHERE user_id=$1 AND action='START_REFUSED'`, [a.id]);
    assert.equal(refused.rows[0].n, 1, 'refusal is audited');

    // LIVE needs the typed confirmation; TEST/LIVE need the external-sending flag.
    const live = await ca.post('/api/outreach/start', { mode: 'LIVE' });
    assert.equal(live.status, 400);
    assert.match(live.body.error, /SEND TO REAL PROSPECTS/);
    const liveConfirmed = await ca.post('/api/outreach/start', { mode: 'LIVE', confirm: 'SEND TO REAL PROSPECTS' });
    assert.equal(liveConfirmed.status, 409);
    assert.equal(liveConfirmed.body.preflight.checks.find((x) => x.name === 'SENDING MODE').status, 'BLOCKED');

    // Gmail connect is refused cleanly when OAuth is not configured.
    const gmail = await ca.get('/api/outreach/providers/gmail/connect-url');
    assert.equal(gmail.status, 503);
    // Outlook is honestly not supported.
    assert.equal((await ca.post('/api/outreach/providers', { provider: 'outlook' })).status, 501);

    // Queue A's job so there is something for B to try to touch.
    await pool.query(`INSERT INTO outbound_tenant_state (user_id, engine_status, mode) VALUES ($1,'RUNNING','SHADOW') ON CONFLICT (user_id) DO UPDATE SET engine_status='RUNNING', mode='SHADOW'`, [a.id]);
    await pool.query(`DELETE FROM outbound_locks WHERE name='scheduler'`);
    await scheduler.tick(pool, { owner: 'http-test', now: NOW, rng: () => 0 });
    await pool.query(`DELETE FROM outbound_locks WHERE name='scheduler'`);
    const job = (await pool.query('SELECT * FROM outbound_send_jobs WHERE user_id=$1', [a.id])).rows[0];
    assert.ok(job, 'A has a queued job');

    // Tenant isolation: B cannot read or act on anything of A's.
    const r = await Promise.all([
      cb.get(`/api/outreach/campaigns/${A.campaignId}`),
      cb.post(`/api/outreach/campaigns/${A.campaignId}/stop`),
      cb.post(`/api/outreach/campaigns/${A.campaignId}/drafts`),
      cb.post(`/api/outreach/messages/${A.messageId}/review`, { decision: 'REJECT' }),
      cb.post(`/api/outreach/contacts/${A.contactId}/suppress`),
      cb.post(`/api/outreach/providers/${A.accountId}/pause`),
      cb.post(`/api/outreach/jobs/${job.id}/resolve`, { action: 'RETRY' }),
    ]);
    assert.deepEqual(r.map((x) => x.status), [404, 404, 404, 404, 404, 404, 404]);
    const cancel = await cb.post(`/api/outreach/jobs/${job.id}/cancel`);
    assert.equal(cancel.status, 409, 'B cannot cancel A\'s job');
    const seen = {
      campaigns: (await cb.get('/api/outreach/campaigns')).body.campaigns.length,
      contacts: (await cb.get('/api/outreach/contacts')).body.contacts.length,
      jobs: (await cb.get('/api/outreach/jobs')).body.jobs.length,
      messages: (await cb.get('/api/outreach/messages?status=APPROVED')).body.messages.length,
      providers: (await cb.get('/api/outreach/providers')).body.accounts.length,
      audit: ((await cb.get('/api/outreach/audit')).body.audit || []).length,
    };
    assert.deepEqual(seen, { campaigns: 0, contacts: 0, jobs: 0, messages: 0, providers: 0, audit: 0 });
    // Nothing of A's changed.
    const after = (await pool.query('SELECT status FROM outbound_send_jobs WHERE id=$1', [job.id])).rows[0].status;
    assert.equal(after, 'QUEUED');
    assert.equal((await pool.query('SELECT status FROM outbound_campaigns WHERE id=$1', [A.campaignId])).rows[0].status, 'ACTIVE');
    assert.equal((await pool.query('SELECT review_status FROM outbound_messages WHERE id=$1', [A.messageId])).rows[0].review_status, 'APPROVED');
    assert.equal((await pool.query('SELECT status FROM outbound_provider_accounts WHERE id=$1', [A.accountId])).rows[0].status, 'HEALTHY');
    const provs = await ca.get('/api/outreach/providers');
    assert.ok(!JSON.stringify(provs.body).includes('credentials_enc'), 'credentials are never returned');
  } finally {
    await server.stop();
  }
});

test('START works once the runner is up, and STOP ALL OUTBOUND stops it', async (tc) => {
  if (!ready) return tc.skip('needs a database with the app schema (migration 060+) and 062, so the server can boot');
  // The runner in this server uses the real clock and the sink provider;
  // TEST/LIVE stay blocked because external sending is forced off.
  const server = await startServer({ ...SAFE_ENV, OUTBOUND_ENGINE_ENABLED: 'true', OUTBOUND_TICK_MS: '2000', OUTBOUND_WORKER_POLL_MS: '2000' });
  try {
    const u = await mk('start');
    const c = client(server.base, u);
    await buildCampaignOverHttp(c, 'sigma-http.invalid');
    const start = await c.post('/api/outreach/start', { mode: 'SHADOW' });
    assert.equal(start.status, 200, JSON.stringify(start.body.preflight?.checks?.filter((x) => x.status !== 'PASS')));
    assert.equal(start.body.started, true);
    const test2 = await c.post('/api/outreach/start', { mode: 'TEST' });
    assert.equal(test2.status, 409, 'TEST needs FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED');
    const status = await c.get('/api/outreach/status');
    assert.equal(status.status, 200);
    const stop = await c.post('/api/outreach/stop-all', { reason: 'test' });
    assert.equal(stop.body.stopped, true);
    const st = (await pool.query('SELECT engine_status FROM outbound_tenant_state WHERE user_id=$1', [u.id])).rows[0].engine_status;
    assert.equal(st, 'STOPPED_BY_OWNER');
    // Nothing reached a real provider: every sent job for this tenant used the sink.
    const modes = (await pool.query(`SELECT DISTINCT mode FROM outbound_send_jobs WHERE user_id=$1`, [u.id])).rows.map((x) => x.mode);
    assert.ok(modes.every((m) => m === 'SHADOW'), modes.join(','));
  } finally {
    await server.stop();
    await pool.query(`DELETE FROM outbound_locks`).catch(() => {});
  }
});
