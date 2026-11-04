'use strict';
// lib/domain/outbound/worker.js
// The sender. Workers are stateless and can run on any number of instances.
//
// Job lifecycle:
//   QUEUED -> RESERVED -> SENDING -> SENT
//                 |          |-> RETRY_WAIT (429 / 5xx; backoff + jitter, capped attempts)
//                 |          |-> AMBIGUOUS  (connection died after the request may have
//                 |          |               reached the provider; reconciled against the
//                 |          |               provider before anything else happens)
//                 |          |-> FAILED     (non-retryable, or out of attempts = dead letter)
//                 |-> QUEUED (outside window / rate limited / campaign paused: no attempt used)
//                 |-> CANCELLED (suppressed, stopped campaign, ineligible)
//
// Duplicate-send protection, in layers:
//   1. idempotency_key UNIQUE on outbound_send_jobs (tenant:campaign:contact:step:version);
//   2. one open job per contact (partial unique index);
//   3. reservation with FOR UPDATE SKIP LOCKED + a lease owner; every later
//      transition requires "status = X AND lease_owner = me";
//   4. SENDING is committed BEFORE the provider call, so a crash after the
//      call can never look like "not sent yet": an expired SENDING lease
//      becomes AMBIGUOUS, never QUEUED;
//   5. AMBIGUOUS is resolved by asking the provider (findSentByKey on the
//      deterministic Message-ID / X-Starlane-Key). Only a conclusive "not
//      found" allows a retry; anything else waits for a person.

const crypto = require('crypto');
const os = require('os');
const { safeLog } = require('../../observability/logger');
const { adapterFor, sinkAdapter } = require('./providers');
const { decrypt, redact } = require('./credentials');
const { classifyProviderError } = require('./classify');
const { checkEligibility } = require('./eligibility');
const { inWindow, nextWindowStart, resolveTimeZone } = require('./localTime');
const { emailLimits, acquire } = require('./rateLimiter');
const { audit, setContactState, suppress, raiseAlert, recordCost, tx } = require('./store');
const circuit = require('./circuit');
const controls = require('./controls');

const LEASE_MS = Number(process.env.OUTBOUND_LEASE_MS || 60000);
const SEND_LEASE_MS = Number(process.env.OUTBOUND_SEND_LEASE_MS || 120000);
const AMBIGUOUS_SETTLE_MS = 2 * 60000;

function workerId() {
  return `${os.hostname()}:${process.pid}:${crypto.randomBytes(3).toString('hex')}`;
}

function backoffMs(attempt, { baseMs = 60000, capMs = 3600000, rng = Math.random } = {}) {
  const exp = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp * (0.5 + 0.5 * rng()));
}

function jitterMs(rng = Math.random, min = 20000, max = 180000) {
  return Math.round(min + (max - min) * rng());
}

function log(level, msg, job, extra = {}) {
  safeLog(level, `[outbound] ${msg}`, {
    job_id: job?.id, campaign_id: job?.campaign_id, contact_id: job?.contact_id, tenant_id: job?.user_id,
    provider: job?.provider, attempt: job?.attempts, correlation_id: job?.correlation_id, ...extra,
  });
}

/**
 * Reserves up to `limit` due jobs for tenants whose engine is RUNNING and
 * whose campaign is ACTIVE, highest priority first (P0 human reply ...
 * P3 cold). Returns the reserved job ids.
 */
async function reserve(pool, { owner, limit = 1, now = new Date() }) {
  const r = await pool.query(
    // The picked rows are materialized first. A plain `WHERE id IN (SELECT ...
    // LIMIT n FOR UPDATE SKIP LOCKED)` lets the planner re-run the subquery per
    // row, which can reserve more than `limit` jobs; the caller then processes
    // only the ids it asked for and the rest sit RESERVED until the lease ends.
    `WITH picked AS MATERIALIZED (
        SELECT q.id FROM outbound_send_jobs q
          JOIN outbound_tenant_state t ON t.user_id = q.user_id AND t.engine_status = 'RUNNING'
          LEFT JOIN outbound_campaigns c ON c.id = q.campaign_id AND c.user_id = q.user_id
          JOIN outbound_provider_accounts a ON a.id = q.provider_account_id AND a.user_id = q.user_id AND a.status IN ('HEALTHY','THROTTLED')
         WHERE q.status IN ('QUEUED','RETRY_WAIT') AND q.run_after <= $3
           AND (q.campaign_id IS NULL OR c.status = 'ACTIVE')
         ORDER BY q.priority, q.run_after
         LIMIT $4
         FOR UPDATE OF q SKIP LOCKED)
     UPDATE outbound_send_jobs j SET status='RESERVED', lease_owner=$1, lease_expires_at=$2, heartbeat_at=$3, updated_at=$3
       FROM picked WHERE j.id = picked.id
     RETURNING j.id`,
    [owner, new Date(now.getTime() + LEASE_MS), now, limit]
  );
  return r.rows.map((x) => x.id);
}

async function loadJob(db, jobId, { lock = false } = {}) {
  const r = await db.query(
    `SELECT j.*, a.provider, a.status AS account_status FROM outbound_send_jobs j
       LEFT JOIN outbound_provider_accounts a ON a.id = j.provider_account_id AND a.user_id = j.user_id
      WHERE j.id = $1 ${lock ? 'FOR UPDATE OF j' : ''}`,
    [jobId]
  );
  return r.rows[0] || null;
}

async function context(db, job) {
  const [campaign, contact, message, account, enrollment] = await Promise.all([
    job.campaign_id ? db.query('SELECT * FROM outbound_campaigns WHERE user_id=$1 AND id=$2', [job.user_id, job.campaign_id]).then((r) => r.rows[0] || null) : null,
    db.query('SELECT * FROM outbound_contacts WHERE user_id=$1 AND id=$2', [job.user_id, job.contact_id]).then((r) => r.rows[0] || null),
    db.query('SELECT * FROM outbound_messages WHERE user_id=$1 AND id=$2', [job.user_id, job.message_id]).then((r) => r.rows[0] || null),
    db.query('SELECT * FROM outbound_provider_accounts WHERE user_id=$1 AND id=$2', [job.user_id, job.provider_account_id]).then((r) => r.rows[0] || null),
    job.enrollment_id ? db.query('SELECT * FROM outbound_enrollments WHERE user_id=$1 AND id=$2', [job.user_id, job.enrollment_id]).then((r) => r.rows[0] || null) : null,
  ]);
  return { campaign, contact, message, account, enrollment };
}

async function transition(db, job, owner, from, set, params = []) {
  const r = await db.query(
    `UPDATE outbound_send_jobs SET ${set}, updated_at = NOW() WHERE id = $1 AND status = ANY($2::text[]) AND lease_owner IS NOT DISTINCT FROM $3 RETURNING *`,
    [job.id, Array.isArray(from) ? from : [from], owner, ...params]
  );
  return r.rows[0] || null;
}

async function requeue(db, job, owner, runAfter, reason, actor) {
  const r = await transition(db, job, owner, 'RESERVED', `status='QUEUED', run_after=$4, lease_owner=NULL, lease_expires_at=NULL, last_error=$5`, [runAfter, reason]);
  if (r) await audit(db, { userId: job.user_id, actor, action: 'JOB_DEFERRED', campaignId: job.campaign_id, contactId: job.contact_id, jobId: job.id, detail: { reason, runAfter }, correlationId: job.correlation_id });
  return r;
}

async function cancel(db, job, owner, reason, actor) {
  const r = await transition(db, job, owner, 'RESERVED', `status='CANCELLED', cancelled_reason=$4, lease_owner=NULL, lease_expires_at=NULL`, [reason]);
  if (r) {
    await audit(db, { userId: job.user_id, actor, action: 'JOB_CANCELLED', campaignId: job.campaign_id, contactId: job.contact_id, jobId: job.id, detail: { reason }, correlationId: job.correlation_id });
    if (job.enrollment_id) await db.query(`UPDATE outbound_enrollments SET status = CASE WHEN status IN ('QUEUED','APPROVED') THEN 'EXCLUDED' ELSE status END, status_reason=$3, updated_at=NOW() WHERE id=$1 AND user_id=$2`, [job.enrollment_id, job.user_id, reason]);
  }
  return r;
}

function providerFor(account, mode, opts) {
  if (opts.providerFor) return opts.providerFor(account, mode);
  if (mode === 'SHADOW') return sinkAdapter(account);
  return adapterFor(account, { credentials: decrypt(account.credentials_enc) });
}

async function recordSent(pool, job, owner, sent, { ctx, actor, reconciled = false, now = new Date() }) {
  return tx(pool, async (c) => {
    const upd = await c.query(
      `UPDATE outbound_send_jobs SET status='SENT', sent_at=$2, provider_message_id=$3, provider_thread_id=$4, rfc822_message_id=$5,
              lease_owner=NULL, lease_expires_at=NULL, last_error=NULL, updated_at=NOW()
        WHERE id=$1 AND status IN ('SENDING','AMBIGUOUS') RETURNING *`,
      [job.id, now, sent.providerMessageId, sent.threadId || null, sent.rfc822MessageId || null]
    );
    if (!upd.rowCount) return false;
    await c.query(
      `UPDATE outbound_send_attempts SET finished_at=NOW(), outcome=$3, provider_message_id=$4 WHERE job_id=$1 AND attempt_no=$2`,
      [job.id, job.attempts, reconciled ? 'RECONCILED_SENT' : 'SENT', sent.providerMessageId]
    );
    await c.query(
      `INSERT INTO outbound_delivery_events (user_id, job_id, message_id, contact_id, campaign_id, provider_account_id, event_type, dedupe_key, source, detail, occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,'SENT',$7,$8,$9,$10) ON CONFLICT (user_id, dedupe_key) DO NOTHING`,
      [job.user_id, job.id, job.message_id, job.contact_id, job.campaign_id, job.provider_account_id, `sent:${job.id}`, job.mode === 'SHADOW' ? 'sink' : 'provider',
        JSON.stringify({ providerMessageId: sent.providerMessageId, mode: job.mode, reconciled }), now]
    );
    await setContactState(c, job.user_id, job.contact_id, 'SENT', `job:${job.id}`);
    if (job.enrollment_id && ctx.campaign) {
      const step = ctx.message?.step || 0;
      const policy = ctx.campaign.followup_policy || {};
      const afterDays = Array.isArray(policy.afterDays) ? policy.afterDays : [];
      const nextDays = step < Number(policy.max || 0) ? Number(afterDays[step] ?? afterDays[afterDays.length - 1] ?? 0) : 0;
      await c.query(
        `UPDATE outbound_enrollments SET status='SENT', step=$3, last_sent_at=$4, thread_id=COALESCE(thread_id,$5),
                next_followup_at=$6, updated_at=NOW() WHERE id=$1 AND user_id=$2 AND status NOT IN ('REPLIED','EXCLUDED','CANCELLED','FINISHED')`,
        [job.enrollment_id, job.user_id, step, now, sent.threadId || null, nextDays > 0 ? new Date(now.getTime() + nextDays * 86400000) : null]
      );
      if (!nextDays) await c.query(`UPDATE outbound_enrollments SET status='FINISHED', status_reason='sequence complete', updated_at=NOW() WHERE id=$1 AND user_id=$2 AND status='SENT'`, [job.enrollment_id, job.user_id]);
    }
    if (job.provider_account_id) await circuit.onSuccess(c, job.user_id, job.provider_account_id);
    await recordCost(c, { userId: job.user_id, campaignId: job.campaign_id, kind: 'sending', units: 1, amountUsd: 0 });
    await audit(c, { userId: job.user_id, actor, action: reconciled ? 'SEND_RECONCILED_AS_SENT' : 'SENT', campaignId: job.campaign_id, contactId: job.contact_id, jobId: job.id, messageId: job.message_id,
      detail: { provider: job.mode === 'SHADOW' ? 'sink' : job.provider, mode: job.mode, providerMessageId: sent.providerMessageId, scheduledBy: job.scheduled_by, attempt: job.attempts }, correlationId: job.correlation_id });
    return true;
  });
}

async function recordFailure(pool, job, owner, err, { actor, now = new Date(), rng = Math.random }) {
  const { cls, recipientFault } = classifyProviderError(err);
  const msg = redact(err.message || String(err)).slice(0, 500);
  return tx(pool, async (c) => {
    const cur = await c.query('SELECT * FROM outbound_send_jobs WHERE id=$1 FOR UPDATE', [job.id]);
    const j = cur.rows[0];
    if (!j || j.status !== 'SENDING' || j.lease_owner !== owner) return { outcome: 'LOST_LEASE' };
    let status; let runAfter = null; let outcome;
    if (cls === 'AMBIGUOUS_OR_RETRYABLE') {
      status = 'AMBIGUOUS'; outcome = 'AMBIGUOUS'; runAfter = new Date(now.getTime() + AMBIGUOUS_SETTLE_MS);
    } else if (cls === 'RATE_LIMITED') {
      outcome = 'RATE_LIMITED';
      const wait = Number(err.retryAfterMs) > 0 ? Number(err.retryAfterMs) + jitterMs(rng, 1000, 15000) : backoffMs(j.attempts, { rng });
      if (j.attempts >= j.max_attempts + 2) { status = 'FAILED'; } else { status = 'RETRY_WAIT'; runAfter = new Date(now.getTime() + wait); }
      await circuit.onRateLimited(c, j.user_id, j.provider_account_id, wait, now);
    } else if (cls === 'RETRYABLE') {
      outcome = 'RETRYABLE';
      if (j.attempts >= j.max_attempts) status = 'FAILED';
      else { status = 'RETRY_WAIT'; runAfter = new Date(now.getTime() + backoffMs(j.attempts, { rng })); }
      await circuit.onProviderError(c, j.user_id, j.provider_account_id, cls, msg);
    } else if (cls === 'AUTH') {
      outcome = 'AUTH'; status = 'RETRY_WAIT'; runAfter = new Date(now.getTime() + 15 * 60000);
      await circuit.onProviderError(c, j.user_id, j.provider_account_id, cls, msg);
    } else {
      outcome = 'PERMANENT'; status = 'FAILED';
    }
    await c.query(
      `UPDATE outbound_send_jobs SET status=$2, run_after=COALESCE($3, run_after), last_error=$4, failure_class=$5,
              lease_owner=CASE WHEN $2='AMBIGUOUS' THEN lease_owner ELSE NULL END, lease_expires_at=NULL,
              dead_lettered_at=CASE WHEN $2='FAILED' THEN NOW() ELSE NULL END, updated_at=NOW()
        WHERE id=$1`,
      [j.id, status, runAfter, msg, cls]
    );
    await c.query(`UPDATE outbound_send_attempts SET finished_at=NOW(), outcome=$3, http_status=$4, error=$5, retry_after_ms=$6 WHERE job_id=$1 AND attempt_no=$2`,
      [j.id, j.attempts, outcome, Number(err.status) || null, msg, Number(err.retryAfterMs) || null]);
    await c.query(
      `INSERT INTO outbound_delivery_events (user_id, job_id, message_id, contact_id, campaign_id, provider_account_id, event_type, dedupe_key, source, detail)
       VALUES ($1,$2,$3,$4,$5,$6,'PROVIDER_ERROR',$7,'worker',$8) ON CONFLICT (user_id, dedupe_key) DO NOTHING`,
      [j.user_id, j.id, j.message_id, j.contact_id, j.campaign_id, j.provider_account_id, `err:${j.id}:${j.attempts}`, JSON.stringify({ cls, status: err.status || null, error: msg })]
    );
    if (recipientFault) {
      const ct = await c.query('SELECT email FROM outbound_contacts WHERE id=$1 AND user_id=$2', [j.contact_id, j.user_id]);
      if (ct.rows[0]) await suppress(c, j.user_id, { email: ct.rows[0].email, reason: 'INVALID_ADDRESS', source: 'provider_rejection', note: msg });
    }
    if (status === 'FAILED') {
      await raiseAlert(c, { userId: j.user_id, kind: 'JOB_DEAD_LETTERED', severity: 'WARNING', message: `A send failed permanently and moved to the dead-letter list: ${msg.slice(0, 160)}`, detail: { jobId: j.id }, dedupeKey: `dlq:${j.id}` });
    }
    await audit(c, { userId: j.user_id, actor, action: `SEND_${outcome}`, campaignId: j.campaign_id, contactId: j.contact_id, jobId: j.id, detail: { cls, error: msg, nextStatus: status, runAfter }, correlationId: j.correlation_id });
    return { outcome, status, runAfter };
  });
}

/**
 * Processes one reserved job end to end. Never throws for job-level
 * problems; returns { outcome }.
 */
async function processJob(pool, jobId, opts = {}) {
  const owner = opts.owner;
  const now = opts.now || new Date();
  const rng = opts.rng || Math.random;
  const actor = `worker:${owner}`;
  let job = await loadJob(pool, jobId);
  if (!job || job.status !== 'RESERVED' || job.lease_owner !== owner) return { outcome: 'NOT_OWNED' };
  const ctx = await context(pool, job);
  const { campaign, contact, message, account } = ctx;

  // --- stop switches and structural checks (no attempt used) ---
  const gs = await controls.globalStop(pool);
  if (gs.stopped) { await requeue(pool, job, owner, new Date(now.getTime() + 5 * 60000), `global stop (${gs.source})`, actor); return { outcome: 'GLOBAL_STOP' }; }
  const ts = await controls.tenantState(pool, job.user_id);
  if (ts.engine_status !== 'RUNNING') { await requeue(pool, job, owner, new Date(now.getTime() + 5 * 60000), 'tenant outbound stopped', actor); return { outcome: 'TENANT_STOPPED' }; }
  if (campaign && campaign.status === 'STOPPED') { await cancel(pool, job, owner, 'campaign stopped', actor); return { outcome: 'CAMPAIGN_STOPPED' }; }
  if (campaign && campaign.status !== 'ACTIVE') { await requeue(pool, job, owner, new Date(now.getTime() + 5 * 60000), `campaign ${campaign.status}`, actor); return { outcome: 'CAMPAIGN_NOT_ACTIVE' }; }
  if (!account || !['HEALTHY', 'THROTTLED'].includes(account.status)) { await requeue(pool, job, owner, new Date(now.getTime() + 10 * 60000), `account ${account ? account.status : 'missing'}`, actor); return { outcome: 'ACCOUNT_UNAVAILABLE' }; }
  if (!message || message.review_status !== 'APPROVED' || !message.validation?.ok) { await cancel(pool, job, owner, 'message not approved or failed validation', actor); return { outcome: 'MESSAGE_NOT_APPROVED' }; }
  const gate = controls.modeGate(job.mode, contact.email);
  if (!gate.ok) { await cancel(pool, job, owner, gate.reason, actor); return { outcome: 'MODE_REFUSED', reason: gate.reason }; }

  // --- recipient-local window ---
  const { tz } = resolveTimeZone(contact);
  if (job.priority >= 1 && !inWindow(now, tz, campaign?.send_window)) {
    const next = nextWindowStart(now, tz, campaign?.send_window);
    if (!next) { await cancel(pool, job, owner, 'no sending window for this contact', actor); return { outcome: 'NO_WINDOW' }; }
    await requeue(pool, job, owner, new Date(next.getTime() + jitterMs(rng, 30000, 600000)), 'outside recipient local window', actor);
    return { outcome: 'OUTSIDE_WINDOW', nextAt: next };
  }

  // --- thread awareness for cold sends on the real mailbox ---
  const provider = providerFor(account, job.mode, opts);
  if ((message.step || 0) === 0 && job.mode !== 'SHADOW' && provider.priorThreads) {
    try {
      const prior = await provider.priorThreads(contact.email);
      if (prior.length) {
        await cancel(pool, job, owner, `existing conversation in mailbox (${prior.length} thread(s)); not starting a cold thread`, actor);
        await setContactState(pool, job.user_id, contact.id, 'REPLIED', 'existing mailbox thread');
        return { outcome: 'ACTIVE_THREAD_IN_MAILBOX' };
      }
    } catch (err) {
      await requeue(pool, job, owner, new Date(now.getTime() + backoffMs(1, { rng })), `thread check failed: ${redact(err.message).slice(0, 120)}`, actor);
      return { outcome: 'THREAD_CHECK_FAILED' };
    }
  }

  // --- eligibility + rate limit + SENDING, atomically ---
  const kind = (message.step || 0) === 0 ? 'COLD' : 'FOLLOWUP';
  const gateResult = await tx(pool, async (c) => {
    const cur = await c.query('SELECT * FROM outbound_send_jobs WHERE id=$1 FOR UPDATE', [job.id]);
    const j = cur.rows[0];
    if (!j || j.status !== 'RESERVED' || j.lease_owner !== owner) return { outcome: 'NOT_OWNED' };
    const freshContact = (await c.query('SELECT * FROM outbound_contacts WHERE id=$1 AND user_id=$2', [j.contact_id, j.user_id])).rows[0];
    const elig = await checkEligibility(c, j.user_id, { contact: freshContact, campaign, now, kind, excludeJobId: j.id });
    if (!elig.eligible) return { outcome: 'INELIGIBLE', reasons: elig.reasons };
    const specs = await emailLimits(c, { userId: j.user_id, account, campaign, domain: freshContact.email_domain, now });
    const rl = await acquire(c, specs, {
      now,
      concurrencyCheck: async (s) => {
        if (s.scope !== 'ACCOUNT') return 0;
        const r = await c.query(`SELECT COUNT(*)::int AS n FROM outbound_send_jobs WHERE provider_account_id=$1 AND status='SENDING' AND lease_expires_at > $2`, [account.id, now]);
        return r.rows[0].n;
      },
    });
    if (!rl.ok) return { outcome: 'RATE_LIMITED_LOCAL', waitMs: rl.waitMs, blockedBy: rl.blockedBy };
    const attempt = j.attempts + 1;
    await c.query(`UPDATE outbound_send_jobs SET status='SENDING', attempts=$2, lease_expires_at=$3, heartbeat_at=$4, updated_at=NOW() WHERE id=$1`, [j.id, attempt, new Date(now.getTime() + SEND_LEASE_MS), now]);
    await c.query(`INSERT INTO outbound_send_attempts (user_id, job_id, attempt_no, worker_id) VALUES ($1,$2,$3,$4)`, [j.user_id, j.id, attempt, owner]);
    await audit(c, { userId: j.user_id, actor, action: 'SENDING', campaignId: j.campaign_id, contactId: j.contact_id, jobId: j.id, messageId: j.message_id, detail: { attempt, mode: j.mode }, correlationId: j.correlation_id });
    return { outcome: 'GO', attempt };
  });
  if (gateResult.outcome === 'NOT_OWNED') return gateResult;
  if (gateResult.outcome === 'INELIGIBLE') {
    await cancel(pool, job, owner, `ineligible: ${gateResult.reasons.join(', ')}`, actor);
    return gateResult;
  }
  if (gateResult.outcome === 'RATE_LIMITED_LOCAL') {
    // Spread naturally: wait for the limit plus bounded jitter.
    await requeue(pool, job, owner, new Date(now.getTime() + gateResult.waitMs + jitterMs(rng, 5000, 90000)), `rate limit: ${gateResult.blockedBy.map((b) => `${b.scope}.${b.limit}`).join(', ')}`, actor);
    return gateResult;
  }

  job = await loadJob(pool, job.id);
  log('info', 'sending', job, { mode: job.mode });
  if (opts.hooks?.beforeProviderCall) await opts.hooks.beforeProviderCall(job);
  const heartbeat = setInterval(() => {
    pool.query(`UPDATE outbound_send_jobs SET heartbeat_at=NOW(), lease_expires_at=NOW() + ($3 || ' milliseconds')::interval WHERE id=$1 AND lease_owner=$2 AND status='SENDING'`, [job.id, owner, String(SEND_LEASE_MS)]).catch(() => {});
  }, Math.max(1000, Math.floor(SEND_LEASE_MS / 3)));
  let sent;
  try {
    const prevJob = (message.step || 0) > 0 && job.enrollment_id
      ? (await pool.query(`SELECT rfc822_message_id FROM outbound_send_jobs WHERE user_id=$1 AND enrollment_id=$2 AND status='SENT' ORDER BY sent_at DESC LIMIT 1`, [job.user_id, job.enrollment_id])).rows[0]
      : null;
    sent = await provider.sendEmail({
      to: contact.email, subject: message.subject, body: message.body, idempotencyKey: job.idempotency_key,
      threadId: (message.step || 0) > 0 ? ctx.enrollment?.thread_id || null : null,
      inReplyTo: prevJob?.rfc822_message_id || null,
      unsubscribeMailto: account.from_address,
    });
  } catch (err) {
    clearInterval(heartbeat);
    if (opts.hooks?.afterProviderError) await opts.hooks.afterProviderError(job, err);
    const f = await recordFailure(pool, job, owner, err, { actor, now, rng });
    log('warn', 'send failed', job, { outcome: f.outcome, error: redact(err.message) });
    await circuit.evaluateCampaign(pool, job.user_id, campaign).catch(() => {});
    return f;
  }
  clearInterval(heartbeat);
  if (opts.hooks?.afterProviderAccepted) await opts.hooks.afterProviderAccepted(job, sent); // crash-injection point for tests
  const ok = await recordSent(pool, job, owner, sent, { ctx, actor, now });
  log('info', ok ? 'sent' : 'sent but job state changed underneath', job, { providerMessageId: sent.providerMessageId });
  return { outcome: ok ? 'SENT' : 'SENT_STATE_CONFLICT', providerMessageId: sent.providerMessageId };
}

/**
 * Lease recovery. RESERVED with an expired lease: nothing was sent, back to
 * QUEUED. SENDING with an expired lease: the worker died around the
 * provider call; it becomes AMBIGUOUS and is reconciled, never resent blind.
 */
async function recoverLeases(pool, { now = new Date() } = {}) {
  const a = await pool.query(
    `UPDATE outbound_send_jobs SET status='QUEUED', lease_owner=NULL, lease_expires_at=NULL, last_error='lease expired before send; requeued', updated_at=NOW()
      WHERE status='RESERVED' AND lease_expires_at < $1 RETURNING id, user_id`,
    [now]
  );
  const b = await pool.query(
    `UPDATE outbound_send_jobs SET status='AMBIGUOUS', last_error='worker lost during send; reconciling with provider', run_after=$1, updated_at=NOW()
      WHERE status='SENDING' AND lease_expires_at < $1 RETURNING id, user_id`,
    [now]
  );
  for (const r of b.rows) await audit(pool, { userId: r.user_id, actor: 'system:recovery', action: 'JOB_AMBIGUOUS', jobId: r.id, detail: { reason: 'SENDING lease expired' } });
  return { requeued: a.rowCount, ambiguous: b.rowCount };
}

/**
 * Resolves AMBIGUOUS jobs by asking the provider whether the message with
 * this idempotency key exists. Found -> SENT. Conclusively not found ->
 * RETRY_WAIT (safe to send). Provider cannot tell -> stays AMBIGUOUS; after
 * 24 hours an alert asks a person to decide. Never resends on a guess.
 */
async function reconcileAmbiguous(pool, opts = {}) {
  const now = opts.now || new Date();
  const r = await pool.query(
    `SELECT j.*, a.provider FROM outbound_send_jobs j LEFT JOIN outbound_provider_accounts a ON a.id=j.provider_account_id AND a.user_id=j.user_id
      WHERE j.status='AMBIGUOUS' AND j.run_after <= $1 ORDER BY j.updated_at LIMIT 20`,
    [now]
  );
  const out = { sent: 0, retry: 0, unresolved: 0 };
  for (const job of r.rows) {
    const ctx = await context(pool, job);
    let res;
    try {
      const provider = providerFor(ctx.account, job.mode, opts);
      res = await provider.findSentByKey({ idempotencyKey: job.idempotency_key, to: ctx.contact.email, subject: ctx.message.subject, sentAfter: job.created_at });
    } catch (err) {
      res = { found: false, conclusive: false, error: redact(err.message) };
    }
    if (res.found) {
      await recordSent(pool, job, job.lease_owner, { providerMessageId: res.providerMessageId, threadId: res.threadId }, { ctx, actor: 'system:reconcile', reconciled: true, now });
      out.sent += 1;
    } else if (res.conclusive) {
      const exhausted = job.attempts >= job.max_attempts;
      await pool.query(
        `UPDATE outbound_send_jobs SET status=$2, lease_owner=NULL, lease_expires_at=NULL, run_after=$3, last_error='provider has no record of this message; safe to retry',
                dead_lettered_at=CASE WHEN $2='FAILED' THEN NOW() ELSE NULL END, updated_at=NOW() WHERE id=$1 AND status='AMBIGUOUS'`,
        [job.id, exhausted ? 'FAILED' : 'RETRY_WAIT', new Date(now.getTime() + backoffMs(job.attempts))]
      );
      await audit(pool, { userId: job.user_id, actor: 'system:reconcile', action: 'AMBIGUOUS_NOT_SENT', jobId: job.id, detail: { next: exhausted ? 'FAILED' : 'RETRY_WAIT' } });
      out.retry += 1;
    } else {
      await pool.query(`UPDATE outbound_send_jobs SET run_after=$2, updated_at=NOW() WHERE id=$1 AND status='AMBIGUOUS'`, [job.id, new Date(now.getTime() + 15 * 60000)]);
      if (now.getTime() - new Date(job.created_at).getTime() > 24 * 3600000) {
        await raiseAlert(pool, { userId: job.user_id, kind: 'AMBIGUOUS_SEND', severity: 'WARNING', message: 'A send could not be confirmed with the provider for 24 hours. Check the Sent folder, then mark it sent or retry it.', detail: { jobId: job.id }, dedupeKey: `ambiguous:${job.id}` });
      }
      out.unresolved += 1;
    }
  }
  return out;
}

/** Releases every RESERVED job this worker holds (graceful shutdown). */
async function releaseOwned(pool, owner) {
  const r = await pool.query(`UPDATE outbound_send_jobs SET status='QUEUED', lease_owner=NULL, lease_expires_at=NULL, updated_at=NOW() WHERE status='RESERVED' AND lease_owner=$1`, [owner]);
  return r.rowCount;
}

module.exports = { workerId, reserve, processJob, recoverLeases, reconcileAmbiguous, releaseOwned, backoffMs, jitterMs, LEASE_MS, SEND_LEASE_MS };
