// FILE: tests/outbound.engine.test.js
// The outbound engine against a real Postgres (migration 062), with the sink
// provider or a counting double. Nothing is delivered anywhere.
//
//   node --test --test-concurrency=1 tests/outbound.engine.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { getPool } = require('../lib/db/pg');
const H = require('./helpers/outboundHarness');
const worker = require('../lib/domain/outbound/worker');
const scheduler = require('../lib/domain/outbound/scheduler');
const events = require('../lib/domain/outbound/events');
const campaigns = require('../lib/domain/outbound/campaigns');
const controls = require('../lib/domain/outbound/controls');
const { providerError } = require('../lib/domain/outbound/providers');

// Wednesday 30 Sep 2026, 05:30 UTC = 11:00 in India, 06:30 in London,
// 22:30 (Tue) in Los Angeles.
const NOW = new Date('2026-09-30T05:30:00Z');
const MIN = 60000;

let pool; let ready = false; const users = [];
test.before(async () => {
  if (!process.env.DATABASE_URL) return;
  pool = getPool();
  ready = await H.outboundReady(pool);
  if (ready) await H.resetSharedBuckets(pool);
});
test.after(async () => { if (pool) { await H.cleanupTenants(pool, users); await pool.end(); } });

// Each test starts with every earlier fixture tenant stopped and the shared
// buckets fresh, so tests never see each other's jobs or budgets.
async function tenant(label, opts) {
  if (!tenant.fresh) {
    await pool.query(`UPDATE outbound_tenant_state SET engine_status='STOPPED' WHERE user_id = ANY($1::uuid[])`, [users.map((u) => u.id)]);
    await H.resetSharedBuckets(pool);
    tenant.fresh = true;
  }
  const t = await H.setupTenant(pool, label, opts); users.push(t.user); return t;
}
test.beforeEach(() => { tenant.fresh = false; });
async function tickAt(now, owner = 'test-scheduler') { await pool.query(`DELETE FROM outbound_locks WHERE name='scheduler'`); return scheduler.tick(pool, { owner, now, rng: () => 0 }); }
async function jobsOf(userId) { return (await pool.query('SELECT * FROM outbound_send_jobs WHERE user_id=$1 ORDER BY created_at', [userId])).rows; }
async function runDue(now, providerFor, { owner = 'w1', max = 50 } = {}) {
  const out = [];
  for (let i = 0; i < max; i += 1) {
    const ids = await worker.reserve(pool, { owner, limit: 1, now });
    if (!ids.length) break;
    out.push(await worker.processJob(pool, ids[0], { owner, now, providerFor, rng: () => 0 }));
  }
  return out;
}

// Runs workers minute by minute, like the real runner, so per-minute
// buckets refill between rounds.
async function drain(start, providerFor, minutes = 10) {
  const out = [];
  for (let k = 0; k < minutes; k += 1) out.push(...await runDue(new Date(start.getTime() + k * MIN), providerFor));
  return out;
}
const MONDAY = new Date('2026-10-05T05:40:00Z'); // 11:10 IST, a weekday after the day-3 follow-up is due

test('end to end in SHADOW: import, verify, draft, approve, queue, send, audit', async (tc) => {
  if (!ready) return tc.skip('DATABASE_URL with migration 062 required');
  const t = await tenant('e2e');
  const { campaign, contactIds } = await H.readyCampaign(pool, t, [H.targetRow({ domain: 'alpha-e2e.invalid', first: 'Anita' }), H.targetRow({ domain: 'beta-e2e.invalid', first: 'Ravi' })]);
  assert.equal(contactIds.length, 2);
  const tick = await tickAt(NOW);
  assert.equal(tick.leader, true);
  const jobs = await jobsOf(t.user.id);
  assert.equal(jobs.length, 2, 'one job per approved contact');
  assert.ok(jobs.every((j) => j.status === 'QUEUED' && j.mode === 'SHADOW' && j.idempotency_key.startsWith(`${t.user.id}:${campaign.id}:`)));
  const cp = H.countingProvider();
  const later = new Date(NOW.getTime() + 10 * MIN);
  const res = await runDue(later, cp.providerFor);
  assert.equal(res.filter((r) => r.outcome === 'SENT').length, 2, JSON.stringify(res));
  assert.equal(cp.calls.length, 2);
  const after = await jobsOf(t.user.id);
  assert.ok(after.every((j) => j.status === 'SENT' && j.provider_message_id));
  const states = (await pool.query('SELECT state FROM outbound_contacts WHERE user_id=$1', [t.user.id])).rows.map((r) => r.state);
  assert.deepEqual(states, ['SENT', 'SENT']);
  const en = (await pool.query('SELECT next_followup_at FROM outbound_enrollments WHERE user_id=$1', [t.user.id])).rows;
  assert.ok(en.every((e) => e.next_followup_at && new Date(e.next_followup_at) - later === 3 * 86400000), 'first follow-up due after 3 days');
  const audit = (await pool.query(`SELECT action FROM outbound_audit WHERE user_id=$1`, [t.user.id])).rows.map((r) => r.action);
  for (const a of ['CAMPAIGN_CREATED', 'MESSAGE_APPROVED', 'CAMPAIGN_START', 'JOB_SCHEDULED', 'SENDING', 'SENT']) assert.ok(audit.includes(a), `audit has ${a}`);
  const ev = (await pool.query(`SELECT COUNT(*)::int AS n FROM outbound_delivery_events WHERE user_id=$1 AND event_type='SENT'`, [t.user.id])).rows[0].n;
  assert.equal(ev, 2);
});

test('duplicate send: the same job raced by two workers and two schedulers sends once', async (tc) => {
  if (!ready) return tc.skip('DATABASE_URL with migration 062 required');
  const t = await tenant('dup');
  await H.readyCampaign(pool, t, [H.targetRow({ domain: 'gamma-dup.invalid' })]);
  await pool.query(`DELETE FROM outbound_locks WHERE name='scheduler'`);
  const [a, b] = await Promise.all([scheduler.tick(pool, { owner: 's-a', now: NOW }), scheduler.tick(pool, { owner: 's-b', now: NOW })]);
  assert.equal([a.leader, b.leader].filter(Boolean).length, 1, 'exactly one scheduler leads');
  await pool.query(`DELETE FROM outbound_locks WHERE name='scheduler'`);
  await scheduler.tick(pool, { owner: 's-b', now: NOW }); // second leader re-evaluates: idempotency key blocks a second job
  assert.equal((await jobsOf(t.user.id)).length, 1);
  const cp = H.countingProvider();
  const later = new Date(NOW.getTime() + 10 * MIN);
  const [r1, r2] = await Promise.all([worker.reserve(pool, { owner: 'w-a', limit: 5, now: later }), worker.reserve(pool, { owner: 'w-b', limit: 5, now: later })]);
  assert.equal(r1.length + r2.length, 1, 'only one worker reserves the job');
  const id = (r1[0] || r2[0]);
  const owner = r1.length ? 'w-a' : 'w-b';
  const other = owner === 'w-a' ? 'w-b' : 'w-a';
  const [p1, p2] = await Promise.all([
    worker.processJob(pool, id, { owner, now: later, providerFor: cp.providerFor }),
    worker.processJob(pool, id, { owner: other, now: later, providerFor: cp.providerFor }),
  ]);
  assert.deepEqual([p1.outcome, p2.outcome].sort(), ['NOT_OWNED', 'SENT']);
  assert.equal(cp.calls.length, 1, 'ONE SEND');
});

test('worker crash after the provider accepted: reconciled as sent, never resent', async (tc) => {
  if (!ready) return tc.skip('DATABASE_URL with migration 062 required');
  const t = await tenant('crash-after');
  await H.readyCampaign(pool, t, [H.targetRow({ domain: 'delta-crash.invalid' })]);
  await tickAt(NOW);
  const cp = H.countingProvider();
  const later = new Date(NOW.getTime() + 10 * MIN);
  const [id] = await worker.reserve(pool, { owner: 'w-dies', limit: 1, now: later });
  await assert.rejects(worker.processJob(pool, id, { owner: 'w-dies', now: later, providerFor: cp.providerFor, hooks: { afterProviderAccepted: () => { throw new Error('process killed'); } } }));
  let j = (await jobsOf(t.user.id))[0];
  assert.equal(j.status, 'SENDING', 'SENDING was committed before the provider call');
  const rec = await worker.recoverLeases(pool, { now: new Date(later.getTime() + worker.SEND_LEASE_MS + 1000) });
  assert.equal(rec.ambiguous, 1);
  j = (await jobsOf(t.user.id))[0];
  assert.equal(j.status, 'AMBIGUOUS');
  const res = await worker.reconcileAmbiguous(pool, { now: new Date(later.getTime() + 60 * MIN), providerFor: cp.providerFor });
  assert.equal(res.sent, 1);
  j = (await jobsOf(t.user.id))[0];
  assert.equal(j.status, 'SENT');
  assert.equal(cp.calls.length, 1, 'provider called exactly once');
  const out = await runDue(new Date(later.getTime() + 120 * MIN), cp.providerFor);
  assert.equal(out.length, 0);
});

test('worker crash before the provider call: reconciliation finds nothing, retries once', async (tc) => {
  if (!ready) return tc.skip('DATABASE_URL with migration 062 required');
  const t = await tenant('crash-before');
  await H.readyCampaign(pool, t, [H.targetRow({ domain: 'eps-crash.invalid' })]);
  await tickAt(NOW);
  const cp = H.countingProvider();
  const later = new Date(NOW.getTime() + 10 * MIN);
  const [id] = await worker.reserve(pool, { owner: 'w-dies', limit: 1, now: later });
  await assert.rejects(worker.processJob(pool, id, { owner: 'w-dies', now: later, providerFor: cp.providerFor, hooks: { beforeProviderCall: () => { throw new Error('killed'); } } }));
  await worker.recoverLeases(pool, { now: new Date(later.getTime() + worker.SEND_LEASE_MS + 1000) });
  const res = await worker.reconcileAmbiguous(pool, { now: new Date(later.getTime() + 60 * MIN), providerFor: cp.providerFor });
  assert.equal(res.retry, 1);
  assert.equal((await jobsOf(t.user.id))[0].status, 'RETRY_WAIT');
  const out = await runDue(new Date(later.getTime() + 4 * 3600000), cp.providerFor);
  assert.equal(out.filter((r) => r.outcome === 'SENT').length, 1);
  assert.equal(cp.calls.length, 1);
});

test('worker crash while RESERVED: lease expires, job requeued and sent once', async (tc) => {
  if (!ready) return tc.skip('DATABASE_URL with migration 062 required');
  const t = await tenant('crash-reserved');
  await H.readyCampaign(pool, t, [H.targetRow({ domain: 'zeta-crash.invalid' })]);
  await tickAt(NOW);
  const later = new Date(NOW.getTime() + 10 * MIN);
  await worker.reserve(pool, { owner: 'w-gone', limit: 1, now: later });
  const rec = await worker.recoverLeases(pool, { now: new Date(later.getTime() + worker.LEASE_MS + 1000) });
  assert.equal(rec.requeued, 1);
  const cp = H.countingProvider();
  const out = await runDue(new Date(later.getTime() + 5 * MIN), cp.providerFor);
  assert.equal(out.filter((r) => r.outcome === 'SENT').length, 1);
  assert.equal(cp.calls.length, 1);
});

test('local time: a contact at 22:30 (and at 02:00) local time stays unsent until their window', async (tc) => {
  if (!ready) return tc.skip('DATABASE_URL with migration 062 required');
  const t = await tenant('tz');
  await H.readyCampaign(pool, t, [H.targetRow({ domain: 'eta-tz.invalid', country: 'US', timezone: 'America/Los_Angeles' })]);
  await tickAt(NOW);
  const j = (await jobsOf(t.user.id))[0];
  const runAt = new Date(j.run_after);
  // Next window opens Wed 09:00 PDT = 16:00 UTC.
  assert.ok(runAt >= new Date('2026-09-30T16:00:00Z'), `scheduled for the recipient's window, got ${runAt.toISOString()}`);
  // Force it due at 02:00 local anyway: the worker must refuse.
  const twoAm = new Date('2026-09-30T09:00:00Z');
  await pool.query('UPDATE outbound_send_jobs SET run_after=$2 WHERE id=$1', [j.id, twoAm]);
  const cp = H.countingProvider();
  const out = await runDue(twoAm, cp.providerFor);
  assert.equal(out[0].outcome, 'OUTSIDE_WINDOW');
  assert.equal(cp.calls.length, 0);
  const again = (await jobsOf(t.user.id))[0];
  assert.equal(again.status, 'QUEUED');
  assert.ok(new Date(again.run_after) >= new Date('2026-09-30T16:00:00Z'));
});

test('suppression: a hard-bounced recipient is never sent to again, in any campaign', async (tc) => {
  if (!ready) return tc.skip('DATABASE_URL with migration 062 required');
  const t = await tenant('bounce');
  const rows = [H.targetRow({ domain: 'theta-bounce.invalid', first: 'Bad' }), H.targetRow({ domain: 'iota-bounce.invalid', first: 'Good' })];
  await H.readyCampaign(pool, t, rows);
  await tickAt(NOW);
  const cp = H.countingProvider();
  const later = new Date(NOW.getTime() + 10 * MIN);
  await runDue(later, cp.providerFor);
  const bad = (await pool.query(`SELECT * FROM outbound_send_jobs j JOIN outbound_contacts c ON c.id=j.contact_id WHERE j.user_id=$1 AND c.full_name LIKE 'Bad%'`, [t.user.id])).rows[0];
  const ev = { type: 'BOUNCED', dedupeKey: `bounce-${bad.provider_message_id}`, providerMessageId: bad.provider_message_id, source: 'test', bounce: { status: '5.1.1', diagnostic: '550 5.1.1 user unknown' } };
  const r1 = await events.ingestEvent(pool, t.user.id, ev);
  assert.equal(r1.bounceClass, 'HARD');
  assert.ok(r1.effects.includes('SUPPRESSED:HARD_BOUNCE'));
  const r2 = await events.ingestEvent(pool, t.user.id, ev);
  assert.equal(r2.duplicate, true, 'duplicate webhook has no second effect');
  const c = (await pool.query(`SELECT * FROM outbound_contacts WHERE user_id=$1 AND full_name LIKE 'Bad%'`, [t.user.id])).rows[0];
  assert.equal(c.state, 'BOUNCED');
  // A second campaign that enrolls the same person must exclude them.
  const c2 = await campaigns.createCampaign(pool, t.user.id, { name: 'Second', goal: 'g', cta: 'Would a 15-minute working session be useful?', allowedCountries: ['IN'], providerAccountId: t.account.id, cooldownDays: 0 }, t.user.id);
  await campaigns.enroll(pool, t.user.id, c2.id, [c.id]);
  const d = await campaigns.generateDrafts(pool, t.user.id, c2.id);
  assert.equal(d.excluded.length, 1);
  assert.ok(d.excluded[0].reasons.includes('SUPPRESSED:HARD_BOUNCE'));
  assert.equal(cp.calls.filter((x) => x.to === c.email).length, 1, 'only the original send, never a retry');
});

test('opt-out reply immediately cancels queued follow-ups and suppresses', async (tc) => {
  if (!ready) return tc.skip('DATABASE_URL with migration 062 required');
  const t = await tenant('optout');
  await H.readyCampaign(pool, t, [H.targetRow({ domain: 'kappa-opt.invalid', first: 'Meera' })], { requireReview: false });
  await tickAt(NOW);
  const cp = H.countingProvider();
  const later = new Date(NOW.getTime() + 10 * MIN);
  await runDue(later, cp.providerFor);
  // Three days later: follow-up drafted (auto-approved: review off) and queued.
  const d3 = MONDAY;
  await tickAt(d3);
  const open = (await jobsOf(t.user.id)).filter((j) => j.status === 'QUEUED');
  assert.equal(open.length, 1, 'follow-up queued');
  assert.equal(open[0].priority, 1, 'warm follow-up outranks cold (P1)');
  const sent = (await jobsOf(t.user.id)).find((j) => j.status === 'SENT');
  const r = await events.ingestReply(pool, t.user.id, { providerMessageId: 'reply-optout-1', threadId: sent.provider_thread_id, fromAddress: 'meera.fixture@kappa-opt.invalid', body: 'Please remove me from your list.' });
  assert.equal(r.classification, 'OPT_OUT');
  const after = await jobsOf(t.user.id);
  assert.equal(after.filter((j) => j.status === 'QUEUED').length, 0);
  assert.equal(after.filter((j) => j.cancelled_reason === 'suppressed:UNSUBSCRIBED').length, 1);
  const out = await runDue(new Date(d3.getTime() + 60 * MIN), cp.providerFor);
  assert.equal(out.length, 0);
  assert.equal(cp.calls.length, 1);
});

test('domain throttle: 10 people at one company are spread out, not sent in a burst', async (tc) => {
  if (!ready) return tc.skip('DATABASE_URL with migration 062 required');
  const t = await tenant('domain');
  // Remove the generous DOMAIN policy so the default applies (2/hour, 3/day, burst 1).
  await pool.query(`DELETE FROM outbound_rate_policies WHERE user_id=$1 AND scope='DOMAIN'`, [t.user.id]);
  const rows = Array.from({ length: 10 }, (_, i) => H.targetRow({ domain: 'samecompany-fixture.invalid', first: `P${i}`, company: 'Same Company' }));
  await H.readyCampaign(pool, t, rows, { maxPerCompany: 10, companyCooldownDays: 0 });
  await tickAt(NOW);
  const jobs = await jobsOf(t.user.id);
  assert.equal(jobs.length, 10);
  const cp = H.countingProvider();
  const later = new Date(NOW.getTime() + 60 * MIN);
  await pool.query(`UPDATE outbound_send_jobs SET run_after=$2 WHERE user_id=$1`, [t.user.id, later]);
  const out = await runDue(later, cp.providerFor);
  assert.equal(cp.calls.length, 1, 'one send to the domain now');
  assert.equal(out.filter((r) => r.outcome === 'RATE_LIMITED_LOCAL').length, 9);
  const deferred = (await jobsOf(t.user.id)).filter((j) => j.status === 'QUEUED');
  assert.ok(deferred.every((j) => new Date(j.run_after) - later >= 29 * MIN), 'the rest wait for the domain bucket (~30 min each)');
  assert.ok(deferred.every((j) => /DOMAIN\.bucket/.test(j.last_error)));
});

test('provider 429: honours Retry-After, throttles the account, never hammers', async (tc) => {
  if (!ready) return tc.skip('DATABASE_URL with migration 062 required');
  const t = await tenant('429');
  await H.readyCampaign(pool, t, [H.targetRow({ domain: 'lambda-429.invalid', first: 'A' }), H.targetRow({ domain: 'mu-429.invalid', first: 'B' })]);
  await tickAt(NOW);
  const later = new Date(NOW.getTime() + 10 * MIN);
  await pool.query(`UPDATE outbound_send_jobs SET run_after=$2 WHERE user_id=$1`, [t.user.id, later]);
  const cp = H.countingProvider({ faults: [() => providerError(429, 'rate limited', { retryAfterMs: 10 * MIN })] });
  const out = await runDue(later, cp.providerFor);
  assert.equal(cp.calls.length, 1, 'second job did not hit the provider');
  assert.equal(out[0].outcome, 'RATE_LIMITED');
  assert.equal(out[1].outcome, 'RATE_LIMITED_LOCAL', 'account bucket drained until Retry-After');
  const jobs = await jobsOf(t.user.id);
  const limited = jobs.find((j) => j.status === 'RETRY_WAIT');
  assert.ok(new Date(limited.run_after) - later >= 10 * MIN, 'waits at least Retry-After');
  const acct = (await pool.query('SELECT status, throttle_factor FROM outbound_provider_accounts WHERE id=$1', [t.account.id])).rows[0];
  assert.equal(acct.status, 'THROTTLED');
  assert.ok(Number(acct.throttle_factor) < 1);
});

test('retry: 503s back off with growing delays, then dead-letter with an alert', async (tc) => {
  if (!ready) return tc.skip('DATABASE_URL with migration 062 required');
  const t = await tenant('503');
  await H.readyCampaign(pool, t, [H.targetRow({ domain: 'nu-503.invalid' })]);
  await tickAt(NOW);
  const f = () => providerError(503, 'backend error');
  const cp = H.countingProvider({ faults: [f, f, f, f, f] });
  let now = new Date(NOW.getTime() + 10 * MIN);
  const delays = [];
  for (let i = 0; i < 4; i += 1) {
    await pool.query(`UPDATE outbound_provider_accounts SET status='HEALTHY', consecutive_errors=0 WHERE id=$1`, [t.account.id]);
    const out = await runDue(now, cp.providerFor);
    assert.equal(out.length, 1, `attempt ${i + 1}`);
    const j = (await jobsOf(t.user.id))[0];
    if (j.status === 'RETRY_WAIT') { delays.push(new Date(j.run_after) - now); now = new Date(new Date(j.run_after).getTime() + 1000); }
  }
  const j = (await jobsOf(t.user.id))[0];
  assert.equal(j.status, 'FAILED');
  assert.ok(j.dead_lettered_at);
  assert.equal(cp.calls.length, 4, 'max 4 attempts, never infinite');
  assert.ok(delays[1] > delays[0] && delays[2] > delays[1], `exponential: ${delays}`);
  const alert = (await pool.query(`SELECT kind FROM outbound_alerts WHERE user_id=$1 AND kind='JOB_DEAD_LETTERED'`, [t.user.id])).rows;
  assert.equal(alert.length, 1);
});

test('invalid recipient rejected by the provider: suppressed, never retried', async (tc) => {
  if (!ready) return tc.skip('DATABASE_URL with migration 062 required');
  const t = await tenant('invalid');
  await H.readyCampaign(pool, t, [H.targetRow({ domain: 'xi-invalid.invalid' })]);
  await tickAt(NOW);
  const cp = H.countingProvider({ faults: [() => providerError(400, 'Invalid To header')] });
  await runDue(new Date(NOW.getTime() + 10 * MIN), cp.providerFor);
  const j = (await jobsOf(t.user.id))[0];
  assert.equal(j.status, 'FAILED');
  const s = (await pool.query(`SELECT reason FROM outbound_suppressions WHERE user_id=$1`, [t.user.id])).rows;
  assert.deepEqual(s.map((x) => x.reason), ['INVALID_ADDRESS']);
});

test('timeout mid-send becomes AMBIGUOUS and is reconciled, not resent blind', async (tc) => {
  if (!ready) return tc.skip('DATABASE_URL with migration 062 required');
  const t = await tenant('timeout');
  await H.readyCampaign(pool, t, [H.targetRow({ domain: 'omicron-to.invalid' })]);
  await tickAt(NOW);
  // The provider accepted the message but the response was lost.
  const inner = H.countingProvider();
  const provider = inner.providerFor();
  const flaky = { ...provider, async sendEmail(m) { await provider.sendEmail(m); throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }); } };
  const later = new Date(NOW.getTime() + 10 * MIN);
  const out = await runDue(later, () => flaky);
  assert.equal(out[0].outcome, 'AMBIGUOUS');
  assert.equal((await runDue(new Date(later.getTime() + MIN), () => flaky)).length, 0, 'an AMBIGUOUS job is not picked up by workers');
  const rec = await worker.reconcileAmbiguous(pool, { now: new Date(later.getTime() + 5 * MIN), providerFor: () => provider });
  assert.equal(rec.sent, 1);
  assert.equal(inner.calls.length, 1);
  assert.equal((await jobsOf(t.user.id))[0].status, 'SENT');
});

test('campaign STOP cancels queued-but-not-sent jobs; PAUSE holds them', async (tc) => {
  if (!ready) return tc.skip('DATABASE_URL with migration 062 required');
  const t = await tenant('stop');
  const { campaign } = await H.readyCampaign(pool, t, [H.targetRow({ domain: 'pi-stop.invalid' }), H.targetRow({ domain: 'rho-stop.invalid' })]);
  await tickAt(NOW);
  await campaigns.setCampaignStatus(pool, t.user.id, campaign.id, 'PAUSE', t.user.id);
  const cp = H.countingProvider();
  const later = new Date(NOW.getTime() + 10 * MIN);
  assert.equal((await runDue(later, cp.providerFor)).length, 0, 'paused: nothing reserved');
  const r = await campaigns.setCampaignStatus(pool, t.user.id, campaign.id, 'STOP', t.user.id);
  assert.equal(r.jobsCancelled, 2);
  await assert.rejects(campaigns.setCampaignStatus(pool, t.user.id, campaign.id, 'RESUME', t.user.id), /cannot resume/);
  assert.equal((await runDue(later, cp.providerFor)).length, 0);
  assert.equal(cp.calls.length, 0);
  // A job a worker had already reserved when STOP landed is cancelled at send time.
  const t2 = await tenant('stop2');
  const { campaign: c2 } = await H.readyCampaign(pool, t2, [H.targetRow({ domain: 'sigma-stop.invalid' })]);
  await tickAt(NOW);
  const [id] = await worker.reserve(pool, { owner: 'w', limit: 1, now: later });
  await pool.query(`UPDATE outbound_campaigns SET status='STOPPED' WHERE id=$1`, [c2.id]);
  const res = await worker.processJob(pool, id, { owner: 'w', now: later, providerFor: cp.providerFor });
  assert.equal(res.outcome, 'CAMPAIGN_STOPPED');
  assert.equal(cp.calls.length, 0);
});

test('STOP ALL OUTBOUND (tenant) and the global stop both stop new sends', async (tc) => {
  if (!ready) return tc.skip('DATABASE_URL with migration 062 required');
  const t = await tenant('gstop');
  await H.readyCampaign(pool, t, [H.targetRow({ domain: 'tau-stop.invalid' })]);
  await tickAt(NOW);
  const cp = H.countingProvider();
  const later = new Date(NOW.getTime() + 10 * MIN);
  await controls.setGlobalStop(pool, true, { reason: 'test', setBy: 'test' });
  try {
    const [id] = await worker.reserve(pool, { owner: 'w', limit: 1, now: later });
    const r = await worker.processJob(pool, id, { owner: 'w', now: later, providerFor: cp.providerFor });
    assert.equal(r.outcome, 'GLOBAL_STOP');
    const tick = await tickAt(later);
    assert.ok(tick.globalStop);
  } finally {
    await controls.setGlobalStop(pool, false, { setBy: 'test' });
  }
  const { stopOutreach } = require('../lib/domain/outbound/engine');
  await stopOutreach(pool, t.user.id, t.user.id);
  const out = await runDue(new Date(later.getTime() + 10 * MIN), cp.providerFor);
  assert.equal(out.length, 0, 'a stopped tenant has nothing reserved');
  assert.equal(cp.calls.length, 0);
  assert.equal((await jobsOf(t.user.id))[0].status, 'QUEUED', 'held, not lost');
});

test('circuit breaker: a bounce spike pauses the campaign automatically', async (tc) => {
  if (!ready) return tc.skip('DATABASE_URL with migration 062 required');
  const t = await tenant('circuit');
  const rows = Array.from({ length: 4 }, (_, i) => H.targetRow({ domain: `circ${i}-fixture.invalid`, first: `C${i}` }));
  const { campaign } = await H.readyCampaign(pool, t, rows);
  await tickAt(NOW);
  const cp = H.countingProvider();
  await drain(new Date(NOW.getTime() + 10 * MIN), cp.providerFor);
  const sent = (await jobsOf(t.user.id)).filter((j) => j.status === 'SENT');
  assert.equal(sent.length, 4);
  for (const j of sent.slice(0, 3)) {
    await events.ingestEvent(pool, t.user.id, { type: 'BOUNCED', dedupeKey: `b-${j.id}`, jobId: j.id, source: 'test', bounce: { status: '5.1.1', diagnostic: 'no such user' } });
  }
  const c = (await pool.query('SELECT status, status_reason FROM outbound_campaigns WHERE id=$1', [campaign.id])).rows[0];
  assert.equal(c.status, 'PAUSED_AUTOMATICALLY');
  assert.match(c.status_reason, /bounce spike/);
});

test('warm-up: a new account never exceeds its day-one cap', async (tc) => {
  if (!ready) return tc.skip('DATABASE_URL with migration 062 required');
  const t = await tenant('warmup', { warmup: true });
  await pool.query(`DELETE FROM outbound_rate_policies WHERE user_id=$1 AND scope='ACCOUNT'`, [t.user.id]);
  await pool.query(`INSERT INTO outbound_rate_policies (user_id, service, scope, scope_key, per_minute, per_hour, burst, concurrency) VALUES ($1,'email','ACCOUNT','*',60,1000,50,4)`, [t.user.id]);
  await pool.query(`UPDATE outbound_provider_accounts SET warmup_started_on=$2 WHERE id=$1`, [t.account.id, NOW.toISOString().slice(0, 10)]);
  const rows = Array.from({ length: 7 }, (_, i) => H.targetRow({ domain: `warm${i}-fixture.invalid`, first: `W${i}` }));
  await H.readyCampaign(pool, t, rows);
  await tickAt(NOW);
  assert.equal((await jobsOf(t.user.id)).length, 5, 'backpressure: only the day-one budget (5) is queued');
  const cp = H.countingProvider();
  const later = new Date(NOW.getTime() + 10 * MIN);
  await pool.query(`UPDATE outbound_send_jobs SET run_after=$2 WHERE user_id=$1`, [t.user.id, later]);
  await drain(later, cp.providerFor, 30);
  assert.equal(cp.calls.length, 5);
  await tickAt(new Date(later.getTime() + 5 * MIN));
  assert.equal((await jobsOf(t.user.id)).length, 5, 'nothing more queued today');
});

test('concurrent workers respect the account concurrency and burst', async (tc) => {
  if (!ready) return tc.skip('DATABASE_URL with migration 062 required');
  const t = await tenant('conc');
  await pool.query(`UPDATE outbound_rate_policies SET per_minute=3, burst=3, concurrency=1 WHERE user_id=$1 AND scope='ACCOUNT'`, [t.user.id]);
  const rows = Array.from({ length: 6 }, (_, i) => H.targetRow({ domain: `conc${i}-fixture.invalid`, first: `K${i}` }));
  await H.readyCampaign(pool, t, rows);
  await tickAt(NOW);
  const later = new Date(NOW.getTime() + 10 * MIN);
  await pool.query(`UPDATE outbound_send_jobs SET run_after=$2 WHERE user_id=$1`, [t.user.id, later]);
  let inFlight = 0; let maxInFlight = 0;
  const base = H.countingProvider();
  const slow = { ...base.providerFor(), async sendEmail(m) { inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight); await new Promise((r) => setTimeout(r, 50)); inFlight -= 1; return base.providerFor().sendEmail(m); } };
  const perMinute = [];
  for (let k = 0; k < 8; k += 1) {
    const at = new Date(later.getTime() + k * MIN);
    const before = base.calls.length;
    await Promise.all(['a', 'b', 'c', 'd'].map((o) => runDue(at, () => slow, { owner: `w-${o}` })));
    perMinute.push(base.calls.length - before);
  }
  assert.equal(maxInFlight, 1, 'concurrency 1 across four workers');
  assert.ok(perMinute.every((n) => n <= 3), `never more than the burst of 3 in a minute: ${perMinute}`);
  assert.equal(base.calls.length, 6, 'all six are eventually sent');
});

test('follow-up: sent in the same thread after the delay, stops after max, not after a reply', async (tc) => {
  if (!ready) return tc.skip('DATABASE_URL with migration 062 required');
  const t = await tenant('followup');
  await H.readyCampaign(pool, t, [H.targetRow({ domain: 'upsilon-fu.invalid', first: 'Farah' })]);
  await tickAt(NOW);
  const cp = H.countingProvider();
  const t0 = new Date(NOW.getTime() + 10 * MIN);
  await runDue(t0, cp.providerFor);
  // Day 3: follow-up drafted for review (require_review is on by default).
  const d3 = MONDAY;
  await tickAt(d3);
  const pending = (await pool.query(`SELECT id, step, subject FROM outbound_messages WHERE user_id=$1 AND review_status='PENDING_REVIEW'`, [t.user.id])).rows;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].step, 1);
  assert.match(pending[0].subject, /^Re: /);
  await campaigns.reviewMessage(pool, t.user.id, pending[0].id, { decision: 'APPROVE' }, t.user.id);
  await tickAt(new Date(d3.getTime() + MIN));
  await runDue(new Date(d3.getTime() + 20 * MIN), cp.providerFor);
  assert.equal(cp.calls.length, 2);
  assert.ok(cp.calls[1].threadId, 'follow-up continues the original thread');
  assert.ok(cp.calls[1].inReplyTo);
  // A reply arrives: the day-7 follow-up is never drafted.
  await events.ingestReply(pool, t.user.id, { providerMessageId: 'r-fu-1', fromAddress: 'farah.fixture@upsilon-fu.invalid', body: 'Sounds interesting, can you send more details?' });
  await tickAt(new Date(d3.getTime() + 8 * 86400000));
  const drafts = (await pool.query(`SELECT COUNT(*)::int AS n FROM outbound_messages WHERE user_id=$1 AND step=2`, [t.user.id])).rows[0].n;
  assert.equal(drafts, 0);
  const c = (await pool.query('SELECT state FROM outbound_contacts WHERE user_id=$1', [t.user.id])).rows[0];
  assert.equal(c.state, 'INTERESTED');
});

test('eligibility: unverified, generic, no timezone, duplicate person and same company are refused', async (tc) => {
  if (!ready) return tc.skip('DATABASE_URL with migration 062 required');
  const t = await tenant('elig');
  const rows = [
    H.targetRow({ domain: 'phi-elig.invalid', first: 'Unverified', verified: false }),
    H.targetRow({ domain: 'chi-elig.invalid', first: 'NoTz', country: 'US' }),
    H.targetRow({ domain: 'psi-elig.invalid', first: 'Same', last: 'Person' }),
    H.targetRow({ domain: 'psi-elig.invalid', first: 'Same', last: 'Person', email: 'same.p@psi-elig.invalid' }),
    H.targetRow({ domain: 'omega-elig.invalid', first: 'Colleague1' }),
    H.targetRow({ domain: 'omega-elig.invalid', first: 'Colleague2' }),
  ];
  const generic = H.targetRow({ domain: 'gen-elig.invalid', email: 'info@gen-elig.invalid' });
  const imp = await campaigns.importTargets(pool, t.user.id, [generic]);
  assert.equal(imp.rejected, 1, 'generic inbox rejected at import');
  const { drafts } = await H.readyCampaign(pool, t, rows);
  const reasons = drafts.excluded.flatMap((x) => x.reasons);
  assert.ok(reasons.includes('UNVERIFIED_EMAIL'));
  assert.ok(reasons.includes('NO_TIMEZONE'));
  await tickAt(NOW);
  const jobs = await jobsOf(t.user.id);
  const names = (await pool.query(`SELECT c.full_name FROM outbound_send_jobs j JOIN outbound_contacts c ON c.id=j.contact_id WHERE j.user_id=$1`, [t.user.id])).rows.map((r) => r.full_name);
  assert.equal(names.filter((n) => n.startsWith('Same')).length, 1, 'same person under two addresses: one job');
  assert.equal(names.filter((n) => n.startsWith('Colleague')).length, 1, 'one person per company in the window');
  assert.equal(jobs.length, 2);
});

test('tenancy: one tenant cannot reach another tenant\'s contacts, jobs or suppressions', async (tc) => {
  if (!ready) return tc.skip('DATABASE_URL with migration 062 required');
  const a = await tenant('ten-a');
  const b = await tenant('ten-b');
  const { campaign, contactIds } = await H.readyCampaign(pool, a, [H.targetRow({ domain: 'tenant-a.invalid' })]);
  await assert.rejects(campaigns.getCampaign(pool, b.user.id, campaign.id), /not found/);
  const e = await campaigns.enroll(pool, b.user.id, (await campaigns.createCampaign(pool, b.user.id, { name: 'B', goal: 'g', cta: 'Would a 15-minute working session be useful?', allowedCountries: ['IN'] }, b.user.id)).id, contactIds);
  assert.equal(e.enrolled, 0);
  assert.equal(e.skipped[0].reason, 'NOT_FOUND');
  // B suppressing A's address only affects B.
  const store = require('../lib/domain/outbound/store');
  const aEmail = (await pool.query('SELECT email FROM outbound_contacts WHERE id=$1', [contactIds[0]])).rows[0].email;
  const before = (await pool.query('SELECT state FROM outbound_contacts WHERE id=$1', [contactIds[0]])).rows[0].state;
  await store.tx(pool, (db) => store.suppress(db, b.user.id, { email: aEmail, reason: 'EXPLICIT_DO_NOT_CONTACT', source: 'test' }));
  assert.equal((await pool.query('SELECT state FROM outbound_contacts WHERE id=$1', [contactIds[0]])).rows[0].state, before, "A's contact untouched");
  const aSup = (await pool.query('SELECT COUNT(*)::int AS n FROM outbound_suppressions WHERE user_id=$1', [a.user.id])).rows[0].n;
  assert.equal(aSup, 0);
  // B's reply ingestion ignores A's contact.
  const r = await events.ingestReply(pool, b.user.id, { providerMessageId: 'x-tenant', fromAddress: aEmail, body: 'hi' });
  assert.equal(r.ignored, true);
  const ev = await events.ingestEvent(pool, b.user.id, { type: 'UNSUBSCRIBED', dedupeKey: 'x-tenant-ev', email: aEmail, source: 'test' });
  assert.equal(ev.matchedJob, null);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM outbound_suppressions WHERE user_id=$1', [a.user.id])).rows[0].n, 0);
});

test('leader lock: one scheduler at a time; takeover only after the lease expires', async (tc) => {
  if (!ready) return tc.skip('DATABASE_URL with migration 062 required');
  await pool.query(`DELETE FROM outbound_locks WHERE name='scheduler'`);
  assert.equal(await scheduler.acquireLeadership(pool, 'inst-1', NOW), true);
  assert.equal(await scheduler.acquireLeadership(pool, 'inst-2', NOW), false);
  assert.equal(await scheduler.acquireLeadership(pool, 'inst-1', new Date(NOW.getTime() + 30000)), true, 'renewal');
  assert.equal(await scheduler.acquireLeadership(pool, 'inst-2', new Date(NOW.getTime() + 30000 + scheduler.LEADER_LEASE_MS + 1000)), true, 'takeover after expiry');
  await pool.query(`DELETE FROM outbound_locks WHERE name='scheduler'`);
});

test('experiments: assignment is persisted, deterministic and changes one variable', async (tc) => {
  if (!ready) return tc.skip('DATABASE_URL with migration 062 required');
  const t = await tenant('exp');
  const c = await campaigns.createCampaign(pool, t.user.id, { name: 'Exp', goal: 'g', cta: 'Would a 15-minute working session be useful?', allowedCountries: ['IN'], providerAccountId: t.account.id }, t.user.id);
  const exp = await campaigns.createExperiment(pool, t.user.id, c.id, { variable: 'subject', variants: [{ key: 'A', value: 'Inventory decisions at your plants' }, { key: 'B', value: 'A question about working capital' }] });
  const imp = await campaigns.importTargets(pool, t.user.id, Array.from({ length: 12 }, (_, i) => H.targetRow({ domain: `exp${i}-fixture.invalid`, first: `E${i}` })));
  const ids = imp.results.map((r) => r.contactId);
  await campaigns.enroll(pool, t.user.id, c.id, ids);
  const en = (await pool.query('SELECT contact_id, variant_key FROM outbound_enrollments WHERE campaign_id=$1', [c.id])).rows;
  for (const e of en) assert.equal(e.variant_key, campaigns.assignVariant(exp, e.contact_id));
  assert.equal(new Set(en.map((e) => e.variant_key)).size, 2);
  await campaigns.generateDrafts(pool, t.user.id, c.id);
  const msgs = (await pool.query('SELECT variant_key, subject, body FROM outbound_messages WHERE campaign_id=$1', [c.id])).rows;
  for (const m of msgs) assert.equal(m.subject, exp.variants.find((v) => v.key === m.variant_key).value);
  assert.equal(new Set(msgs.map((m) => m.body.replace(/Hi \w+,/, '').replace(/exp\d+/g, ''))).size <= 12, true);
});
