'use strict';
// lib/domain/outbound/scheduler.js
// The one scheduler. It decides which campaign, which prospect, which local
// time and which account, and creates SendJobs. It never sends.
//
// Leadership: a row lease in outbound_locks ('scheduler'). Only the holder
// makes schedule decisions; a lease that is not renewed within LEADER_LEASE_MS
// can be taken over by another instance. Workers scale separately.
//
// Each tick (leader only):
//   1. recover expired leases; reconcile AMBIGUOUS sends with the provider
//   2. for each RUNNING tenant (and no global stop):
//      a. circuit breakers per ACTIVE campaign, adaptive throttling per account
//      b. draft due follow-ups (no reply, not suppressed, within policy)
//      c. queue approved messages, market by market in the order of
//         recipient-local time (whoever is inside their window now goes
//         first; others get a slot at their next window opening + jitter),
//         never more than the remaining daily budget (backpressure)
//   3. raise alerts: queue stalled, job failure spike

const crypto = require('crypto');
const { safeLog } = require('../../observability/logger');
const { resolveTimeZone, inWindow, nextWindowStart, regionOf, minutesLeftInWindow } = require('./localTime');
const { checkEligibility } = require('./eligibility');
const { emailLimits, budgetView } = require('./rateLimiter');
const { audit, setContactState, raiseAlert, resolveAlert } = require('./store');
const { getCampaign, buildFollowupMessage } = require('./campaigns');
const circuit = require('./circuit');
const controls = require('./controls');
const { recoverLeases, reconcileAmbiguous, jitterMs } = require('./worker');

const LEADER_LEASE_MS = Number(process.env.OUTBOUND_LEADER_LEASE_MS || 90000);

async function acquireLeadership(pool, owner, now = new Date(), name = 'scheduler') {
  const r = await pool.query(
    `INSERT INTO outbound_locks (name, owner, acquired_at, expires_at, heartbeat_at) VALUES ($1,$2,$3,$4,$3)
     ON CONFLICT (name) DO UPDATE SET owner=EXCLUDED.owner, heartbeat_at=EXCLUDED.heartbeat_at, expires_at=EXCLUDED.expires_at,
       acquired_at=CASE WHEN outbound_locks.owner = EXCLUDED.owner THEN outbound_locks.acquired_at ELSE EXCLUDED.acquired_at END
     WHERE outbound_locks.owner = EXCLUDED.owner OR outbound_locks.expires_at < $3
     RETURNING owner`,
    [name, owner, now, new Date(now.getTime() + LEADER_LEASE_MS)]
  );
  return r.rowCount === 1;
}

async function releaseLeadership(pool, owner, name = 'scheduler') {
  await pool.query('DELETE FROM outbound_locks WHERE name=$1 AND owner=$2', [name, owner]);
}

async function heartbeat(pool, name, owner, detail = {}, ttlMs = 120000) {
  await pool.query(
    `INSERT INTO outbound_locks (name, owner, expires_at, heartbeat_at, last_tick) VALUES ($1,$2,NOW() + ($3 || ' milliseconds')::interval, NOW(), $4)
     ON CONFLICT (name) DO UPDATE SET owner=EXCLUDED.owner, expires_at=EXCLUDED.expires_at, heartbeat_at=NOW(), last_tick=EXCLUDED.last_tick`,
    [name, owner, String(ttlMs), JSON.stringify(detail)]
  );
}

function idempotencyKey(userId, campaignId, contactId, step, version) {
  return `${userId}:${campaignId}:${contactId}:${step}:${version}`;
}

/**
 * Queues approved messages of one campaign. Returns { queued, deferred, skipped }.
 */
async function queueCampaign(pool, userId, campaign, { owner, now, mode, rng = Math.random }) {
  const out = { queued: 0, skipped: [], markets: {} };
  const account = (await pool.query('SELECT * FROM outbound_provider_accounts WHERE id=$1 AND user_id=$2', [campaign.provider_account_id, userId])).rows[0];
  if (!account || !['HEALTHY', 'THROTTLED'].includes(account.status)) return { ...out, blocked: `account ${account ? account.status : 'missing'}` };

  // Backpressure: never hold more open jobs than can be sent today.
  const specs = await emailLimits(pool, { userId, account, campaign, domain: '*', now });
  const view = await budgetView(pool, specs.filter((s) => ['ACCOUNT', 'CAMPAIGN', 'TENANT'].includes(s.scope)), now);
  const remaining = Math.min(...view.map((v) => (v.remainingToday == null ? Infinity : v.remainingToday)));
  const open = (await pool.query(`SELECT COUNT(*)::int AS n FROM outbound_send_jobs WHERE user_id=$1 AND provider_account_id=$2 AND status IN ('QUEUED','RESERVED','SENDING','RETRY_WAIT')`, [userId, account.id])).rows[0].n;
  let capacity = Math.max(0, (Number.isFinite(remaining) ? remaining : 50) - open);
  if (capacity === 0) return { ...out, blocked: 'daily budget fully queued or used' };

  const perHour = specs.find((s) => s.scope === 'ACCOUNT')?.perHour || 20;
  const spacingMs = Math.max(60000, Math.floor(3600000 / perHour));

  const cands = await pool.query(
    `SELECT e.id AS enrollment_id, e.step, m.id AS message_id, m.version, m.step AS message_step, row_to_json(c) AS contact, co.fit_score
       FROM outbound_enrollments e
       JOIN outbound_messages m ON m.enrollment_id = e.id AND m.user_id = e.user_id AND m.review_status = 'APPROVED'
       JOIN outbound_contacts c ON c.id = e.contact_id AND c.user_id = e.user_id
       LEFT JOIN outbound_companies co ON co.id = c.company_id AND co.user_id = c.user_id
      WHERE e.user_id=$1 AND e.campaign_id=$2
        AND ((e.status='APPROVED' AND m.step = 0) OR (e.status='SENT' AND m.step = e.step + 1))
        AND NOT EXISTS (SELECT 1 FROM outbound_send_jobs j WHERE j.message_id = m.id)
      ORDER BY m.step DESC, co.fit_score DESC NULLS LAST, e.created_at
      LIMIT 500`,
    [userId, campaign.id]
  );

  // Market rotation: contacts whose local window is open now come first
  // (most window left first), then the rest by when their window opens.
  const rows = cands.rows.map((r) => {
    const { tz } = resolveTimeZone(r.contact);
    const open = tz ? inWindow(now, tz, campaign.send_window) : false;
    const next = tz ? nextWindowStart(now, tz, campaign.send_window) : null;
    return { ...r, tz, open, next, left: open ? minutesLeftInWindow(now, tz, campaign.send_window) : 0, region: regionOf(tz) };
  }).sort((a, b) => (a.open !== b.open ? (a.open ? -1 : 1) : a.open ? b.left - a.left : (a.next?.getTime() || Infinity) - (b.next?.getTime() || Infinity)));

  let slot = 0;
  for (const r of rows) {
    if (capacity <= 0) { out.skipped.push({ enrollmentId: r.enrollment_id, reason: 'BACKPRESSURE' }); continue; }
    const kind = r.message_step === 0 ? 'COLD' : 'FOLLOWUP';
    const elig = await checkEligibility(pool, userId, { contact: r.contact, campaign, now, kind });
    if (!elig.eligible) {
      out.skipped.push({ enrollmentId: r.enrollment_id, reasons: elig.reasons });
      if (elig.reasons.some((x) => x.startsWith('SUPPRESSED') || x.startsWith('STATE:') || ['UNVERIFIED_EMAIL', 'NO_TIMEZONE', 'COUNTRY_NOT_ALLOWED', 'GENERIC_INBOX', 'INVALID_ADDRESS', 'ACTIVE_THREAD', 'REPLIED_SINCE_LAST_SEND', 'DUPLICATE_PERSON'].includes(x))) {
        await pool.query(`UPDATE outbound_enrollments SET status='EXCLUDED', status_reason=$3, updated_at=NOW() WHERE id=$1 AND user_id=$2`, [r.enrollment_id, userId, elig.reasons.join(', ')]);
      }
      continue;
    }
    if (!r.next) { out.skipped.push({ enrollmentId: r.enrollment_id, reason: 'NO_WINDOW' }); continue; }
    const base = r.open ? new Date(now.getTime() + slot * spacingMs) : r.next;
    const runAfter = new Date(base.getTime() + jitterMs(rng, 15000, Math.min(spacingMs, 300000)));
    const key = idempotencyKey(userId, campaign.id, r.contact.id, r.message_step, r.version);
    const correlationId = crypto.randomUUID();
    try {
      const ins = await pool.query(
        `INSERT INTO outbound_send_jobs (user_id, campaign_id, contact_id, enrollment_id, message_id, provider_account_id, idempotency_key, priority, status, mode, run_after, scheduled_by, correlation_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'QUEUED',$9,$10,$11,$12) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
        [userId, campaign.id, r.contact.id, r.enrollment_id, r.message_id, account.id, key, kind === 'COLD' ? 3 : 1, mode, runAfter, `scheduler:${owner}`, correlationId]
      );
      if (!ins.rowCount) { out.skipped.push({ enrollmentId: r.enrollment_id, reason: 'ALREADY_QUEUED' }); continue; }
      await pool.query(`UPDATE outbound_enrollments SET status=CASE WHEN status='APPROVED' THEN 'QUEUED' ELSE status END, updated_at=NOW() WHERE id=$1 AND user_id=$2`, [r.enrollment_id, userId]);
      await setContactState(pool, userId, r.contact.id, 'QUEUED', `job:${ins.rows[0].id}`);
      await audit(pool, { userId, actor: `scheduler:${owner}`, action: 'JOB_SCHEDULED', campaignId: campaign.id, contactId: r.contact.id, jobId: ins.rows[0].id, messageId: r.message_id,
        detail: { runAfter, market: r.region.label, localWindowOpen: r.open, step: r.message_step, mode }, correlationId });
      out.queued += 1; capacity -= 1; if (r.open) slot += 1;
      out.markets[r.region.label] = (out.markets[r.region.label] || 0) + 1;
    } catch (err) {
      if (err.code === '23505') { out.skipped.push({ enrollmentId: r.enrollment_id, reason: 'OPEN_JOB_EXISTS' }); continue; }
      throw err;
    }
  }
  return out;
}

async function draftDueFollowups(pool, userId, campaign, now) {
  const policy = campaign.followup_policy || {};
  if (!Number(policy.max)) return 0;
  const due = await pool.query(
    `SELECT e.* FROM outbound_enrollments e
      WHERE e.user_id=$1 AND e.campaign_id=$2 AND e.status='SENT' AND e.next_followup_at <= $3 AND e.step < $4
        AND NOT EXISTS (SELECT 1 FROM outbound_messages m WHERE m.enrollment_id=e.id AND m.step=e.step+1 AND m.review_status IN ('PENDING_REVIEW','APPROVED'))
      LIMIT 100`,
    [userId, campaign.id, now, Number(policy.max)]
  );
  let n = 0;
  for (const e of due.rows) {
    const contact = (await pool.query('SELECT * FROM outbound_contacts WHERE id=$1 AND user_id=$2', [e.contact_id, userId])).rows[0];
    const elig = await checkEligibility(pool, userId, { contact, campaign, now, kind: 'FOLLOWUP' });
    if (!elig.eligible) {
      await pool.query(`UPDATE outbound_enrollments SET status=CASE WHEN $3 LIKE '%REPLIED%' THEN 'REPLIED' ELSE 'FINISHED' END, status_reason=$3, next_followup_at=NULL, updated_at=NOW() WHERE id=$1 AND user_id=$2`, [e.id, userId, elig.reasons.join(', ')]);
      continue;
    }
    await buildFollowupMessage(pool, userId, campaign, e);
    n += 1;
  }
  return n;
}

async function tenantTick(pool, userId, { owner, now, rng }) {
  const ts = await controls.tenantState(pool, userId);
  const summary = { userId, campaigns: [] };
  const cs = await pool.query(`SELECT id FROM outbound_campaigns WHERE user_id=$1 AND status='ACTIVE'`, [userId]);
  for (const { id } of cs.rows) {
    const campaign = await getCampaign(pool, userId, id);
    const cb = await circuit.evaluateCampaign(pool, userId, campaign, `scheduler:${owner}`);
    if (cb.tripped) { summary.campaigns.push({ id, paused: cb.reasons }); continue; }
    const followups = await draftDueFollowups(pool, userId, campaign, now);
    const q = await queueCampaign(pool, userId, campaign, { owner, now, mode: ts.mode, rng });
    summary.campaigns.push({ id, followupsDrafted: followups, queued: q.queued, blocked: q.blocked || null, markets: q.markets, skipped: q.skipped.length });
  }
  const accounts = await pool.query(`SELECT * FROM outbound_provider_accounts WHERE user_id=$1 AND status IN ('HEALTHY','THROTTLED')`, [userId]);
  for (const a of accounts.rows) await circuit.adaptAccount(pool, userId, a);

  // Queue stalled: due jobs untouched for 30+ minutes while everything is up.
  const stalled = await pool.query(
    `SELECT COUNT(*)::int AS n FROM outbound_send_jobs j JOIN outbound_campaigns c ON c.id=j.campaign_id AND c.status='ACTIVE'
       JOIN outbound_provider_accounts a ON a.id=j.provider_account_id AND a.status IN ('HEALTHY','THROTTLED')
      WHERE j.user_id=$1 AND j.status='QUEUED' AND j.run_after < $2`,
    [userId, new Date(now.getTime() - 30 * 60000)]
  );
  if (stalled.rows[0].n > 0) await raiseAlert(pool, { userId, kind: 'QUEUE_STALLED', severity: 'CRITICAL', message: `${stalled.rows[0].n} due send(s) have waited over 30 minutes. Workers may not be running.`, dedupeKey: 'queue_stalled' });
  else await resolveAlert(pool, userId, 'queue_stalled');
  const failures = await pool.query(`SELECT COUNT(*)::int AS n FROM outbound_send_jobs WHERE user_id=$1 AND status='FAILED' AND dead_lettered_at >= $2`, [userId, new Date(now.getTime() - 3600000)]);
  if (failures.rows[0].n >= 5) await raiseAlert(pool, { userId, kind: 'JOB_FAILURE_SPIKE', severity: 'CRITICAL', message: `${failures.rows[0].n} sends failed permanently in the last hour.`, dedupeKey: `failure_spike:${now.toISOString().slice(0, 13)}` });
  return summary;
}

/**
 * One scheduler tick. Safe to call from every instance: only the leader acts.
 */
async function tick(pool, { owner, now = new Date(), rng = Math.random, providerFor } = {}) {
  if (!(await acquireLeadership(pool, owner, now))) return { leader: false };
  const started = Date.now();
  const result = { leader: true, at: now.toISOString(), tenants: [] };
  try {
    result.recovered = await recoverLeases(pool, { now });
    result.reconciled = await reconcileAmbiguous(pool, { now, providerFor });
    const gs = await controls.globalStop(pool);
    if (gs.stopped) { result.globalStop = gs.source; }
    else {
      const tenants = await pool.query(`SELECT user_id FROM outbound_tenant_state WHERE engine_status='RUNNING'`);
      for (const t of tenants.rows) {
        try { result.tenants.push(await tenantTick(pool, t.user_id, { owner, now, rng })); } catch (err) {
          safeLog('error', '[outbound] tenant tick failed', { tenant_id: t.user_id, error: err.message });
          await raiseAlert(pool, { userId: t.user_id, kind: 'SCHEDULER_ERROR', severity: 'CRITICAL', message: `The outreach scheduler hit an error: ${err.message.slice(0, 160)}`, dedupeKey: 'scheduler_error' }).catch(() => {});
          result.tenants.push({ userId: t.user_id, error: err.message });
        }
      }
    }
  } finally {
    result.ms = Date.now() - started;
    await pool.query(`UPDATE outbound_locks SET last_tick=$2 WHERE name='scheduler' AND owner=$1`, [owner, JSON.stringify({ at: result.at, ms: result.ms, tenants: result.tenants.length, globalStop: result.globalStop || null })]).catch(() => {});
  }
  return result;
}

module.exports = { acquireLeadership, releaseLeadership, heartbeat, tick, queueCampaign, draftDueFollowups, idempotencyKey, LEADER_LEASE_MS };
