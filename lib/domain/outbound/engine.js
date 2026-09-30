'use strict';
// lib/domain/outbound/engine.js
// START / STOP for a tenant, and the in-process runner that hosts the
// scheduler, the workers and the mailbox poller.
//
// The runner starts inside the backend process when OUTBOUND_ENGINE_ENABLED
// is true (default off), so "START" in the app is the only operational step:
// no separate worker process, no cron. Every instance may run it: the
// scheduler acts only while it holds the leader lease, and workers share the
// queue through leases, so extra instances add send capacity but never
// duplicate decisions or sends.
//
// Concurrency is bounded (OUTBOUND_WORKER_CONCURRENCY, default 2 per
// instance; research/generation are not done by workers). When no job is
// due, workers idle; the queue is never drained faster than the rate
// limiter allows, so a growing queue slows nothing but itself.
//
// Graceful shutdown: stop reserving, let in-flight sends finish (bounded),
// release RESERVED leases so another instance picks them up at once.

const { safeLog } = require('../../observability/logger');
const { workerId, reserve, processJob, releaseOwned } = require('./worker');
const scheduler = require('./scheduler');
const { pollAccount } = require('./events');
const { adapterFor } = require('./providers');
const { decrypt } = require('./credentials');
const { audit, raiseAlert } = require('./store');
const controls = require('./controls');
const { runPreflight } = require('./preflight');

async function startOutreach(pool, userId, actorId, { mode = 'SHADOW', runnerAlive } = {}) {
  if (!['SHADOW', 'TEST', 'LIVE'].includes(mode)) throw Object.assign(new Error('mode must be SHADOW, TEST or LIVE'), { status: 400 });
  const pre = await runPreflight(pool, { userId, mode, runnerAlive });
  if (!pre.ready) {
    await audit(pool, { userId, actor: `user:${actorId}`, action: 'START_REFUSED', detail: { mode, failed: pre.checks.filter((c) => c.critical && c.status !== 'PASS').map((c) => c.name) } });
    return { started: false, preflight: pre };
  }
  await pool.query(
    `INSERT INTO outbound_tenant_state (user_id, engine_status, mode, status_reason, started_at, started_by, last_preflight, updated_at)
     VALUES ($1,'RUNNING',$2,'started by owner',NOW(),$3,$4,NOW())
     ON CONFLICT (user_id) DO UPDATE SET engine_status='RUNNING', mode=EXCLUDED.mode, status_reason=EXCLUDED.status_reason, started_at=NOW(),
       started_by=EXCLUDED.started_by, last_preflight=EXCLUDED.last_preflight, updated_at=NOW()`,
    [userId, mode, actorId, JSON.stringify(pre)]
  );
  await audit(pool, { userId, actor: `user:${actorId}`, action: 'OUTREACH_STARTED', detail: { mode } });
  return { started: true, mode, preflight: pre };
}

async function stopOutreach(pool, userId, actorId, reason = 'stopped by owner') {
  await pool.query(
    `INSERT INTO outbound_tenant_state (user_id, engine_status, status_reason, stopped_at, stopped_by, updated_at) VALUES ($1,'STOPPED_BY_OWNER',$2,NOW(),$3,NOW())
     ON CONFLICT (user_id) DO UPDATE SET engine_status='STOPPED_BY_OWNER', status_reason=EXCLUDED.status_reason, stopped_at=NOW(), stopped_by=EXCLUDED.stopped_by, updated_at=NOW()`,
    [userId, reason, actorId]
  );
  // Release reservations so nothing waits on a stopped tenant.
  const r = await pool.query(`UPDATE outbound_send_jobs SET status='QUEUED', lease_owner=NULL, lease_expires_at=NULL, updated_at=NOW() WHERE user_id=$1 AND status='RESERVED'`, [userId]);
  await audit(pool, { userId, actor: `user:${actorId}`, action: 'OUTREACH_STOPPED', detail: { reason, released: r.rowCount } });
  return { stopped: true, released: r.rowCount };
}

class Runner {
  constructor(pool, opts = {}) {
    this.pool = pool;
    this.id = opts.id || workerId();
    this.concurrency = Math.max(1, Math.min(8, Number(opts.concurrency || process.env.OUTBOUND_WORKER_CONCURRENCY || 2)));
    this.tickMs = Number(opts.tickMs || process.env.OUTBOUND_TICK_MS || 30000);
    this.pollMs = Number(opts.pollMs || process.env.OUTBOUND_WORKER_POLL_MS || 5000);
    this.inboxMs = Number(opts.inboxMs || process.env.OUTBOUND_INBOX_POLL_MS || 300000);
    this.providerFor = opts.providerFor;
    this.running = false;
    this.inFlight = new Set();
    this.timers = [];
    this.lastTick = null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = (fn, ms) => {
      const run = async () => {
        if (!this.running) return;
        try { await fn(); } catch (err) { safeLog('error', '[outbound] loop error', { runner: this.id, error: err.message }); }
        if (this.running) this.timers.push(setTimeout(run, ms));
      };
      this.timers.push(setTimeout(run, 1000 + Math.floor(Math.random() * 2000)));
    };
    loop(() => this.schedulerTick(), this.tickMs);
    for (let i = 0; i < this.concurrency; i += 1) loop(() => this.workOnce(i), this.pollMs);
    loop(() => this.pollInboxes(), this.inboxMs);
    safeLog('info', '[outbound] runner started', { runner: this.id, concurrency: this.concurrency });
  }

  async schedulerTick() {
    const r = await scheduler.tick(this.pool, { owner: this.id, providerFor: this.providerFor });
    this.lastTick = r;
    await scheduler.heartbeat(this.pool, `runner:${this.id}`, this.id, { leader: r.leader, at: new Date().toISOString() });
  }

  async workOnce(slot) {
    await scheduler.heartbeat(this.pool, `worker:${this.id}:${slot}`, this.id, { slot, at: new Date().toISOString() });
    // Drain while there is due work, one job at a time per slot.
    for (let n = 0; n < 20 && this.running; n += 1) {
      const ids = await reserve(this.pool, { owner: this.id, limit: 1 });
      if (!ids.length) return;
      const p = processJob(this.pool, ids[0], { owner: this.id, providerFor: this.providerFor });
      this.inFlight.add(p);
      try { await p; } finally { this.inFlight.delete(p); }
    }
  }

  async pollInboxes() {
    const gs = await controls.globalStop(this.pool);
    if (gs.stopped) return;
    // One poller at a time across instances.
    if (!(await scheduler.acquireLeadership(this.pool, this.id, new Date(), 'inbox_poller'))) return;
    const accounts = await this.pool.query(
      `SELECT a.* FROM outbound_provider_accounts a JOIN outbound_tenant_state t ON t.user_id=a.user_id AND t.engine_status='RUNNING'
        WHERE a.provider <> 'sink' AND a.status IN ('HEALTHY','THROTTLED')`
    );
    for (const a of accounts.rows) {
      try {
        const adapter = this.providerFor ? this.providerFor(a, 'LIVE') : adapterFor(a, { credentials: decrypt(a.credentials_enc) });
        await pollAccount(this.pool, a, adapter);
      } catch (err) {
        await raiseAlert(this.pool, { userId: a.user_id, kind: 'INBOX_POLL_FAILED', severity: 'WARNING', message: `Could not read replies and bounces from ${a.from_address}: ${String(err.message).slice(0, 140)}`, dedupeKey: `poll:${a.id}` });
      }
    }
  }

  async stop({ graceMs = 20000 } = {}) {
    if (!this.running) return;
    this.running = false;
    this.timers.forEach(clearTimeout);
    const deadline = Date.now() + graceMs;
    while (this.inFlight.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    const released = await releaseOwned(this.pool, this.id).catch(() => 0);
    await scheduler.releaseLeadership(this.pool, this.id).catch(() => {});
    await scheduler.releaseLeadership(this.pool, this.id, 'inbox_poller').catch(() => {});
    safeLog('info', '[outbound] runner stopped', { runner: this.id, released, stillInFlight: this.inFlight.size });
  }
}

module.exports = { startOutreach, stopOutreach, Runner };
