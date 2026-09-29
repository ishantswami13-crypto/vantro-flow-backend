'use strict';
// lib/domain/outbound/circuit.js
// Circuit breakers and adaptive throttling. Evaluated after every failure
// and bounce, and on every scheduler tick.
//
// Campaign (last 7 days, evaluated when at least MIN_SAMPLE sends exist,
// except for spikes and complaints which act at any sample size):
//   hard bounce rate  > 5%          -> PAUSED_AUTOMATICALLY
//   block rate        > 2%          -> PAUSED_AUTOMATICALLY
//   >= 3 hard bounces in 24 hours   -> PAUSED_AUTOMATICALLY (spike)
//   >= 1 spam complaint in 7 days   -> PAUSED_AUTOMATICALLY
// Account:
//   auth failure                    -> AUTH_REQUIRED (immediately, by the worker)
//   3 consecutive provider errors   -> THROTTLED, throttle factor halved
//   6 consecutive provider errors   -> PAUSED
//   bounce rate > 2.5% (n >= 20)    -> throttle factor halved (floor 0.1)
//   clean for 24h (n >= 20, < 1%)   -> throttle factor +0.25 (cap 1), THROTTLED -> HEALTHY
// Thresholds can be overridden per campaign in limits.circuit.

const { audit, raiseAlert } = require('./store');

const DEFAULTS = { minSample: 20, hardBounceRate: 0.05, blockRate: 0.02, spikeHardBounces24h: 3, complaints7d: 1, accountBounceRate: 0.025, errorsThrottle: 3, errorsPause: 6 };

async function campaignRates(db, userId, campaignId) {
  const r = await db.query(
    `SELECT
       (SELECT COUNT(*)::int FROM outbound_send_jobs WHERE user_id=$1 AND campaign_id=$2 AND status='SENT' AND sent_at >= NOW() - INTERVAL '7 days') AS sent,
       COUNT(*) FILTER (WHERE event_type='BOUNCED' AND bounce_class='HARD' AND occurred_at >= NOW() - INTERVAL '7 days')::int AS hard,
       COUNT(*) FILTER (WHERE event_type='BOUNCED' AND bounce_class='HARD' AND occurred_at >= NOW() - INTERVAL '24 hours')::int AS hard24,
       COUNT(*) FILTER (WHERE (event_type='BLOCKED' OR (event_type='BOUNCED' AND bounce_class='BLOCK')) AND occurred_at >= NOW() - INTERVAL '7 days')::int AS blocked,
       COUNT(*) FILTER (WHERE event_type='COMPLAINT' AND occurred_at >= NOW() - INTERVAL '7 days')::int AS complaints,
       COUNT(*) FILTER (WHERE event_type='PROVIDER_ERROR' AND occurred_at >= NOW() - INTERVAL '24 hours')::int AS provider_errors
     FROM outbound_delivery_events WHERE user_id=$1 AND campaign_id=$2`,
    [userId, campaignId]
  );
  return r.rows[0];
}

async function pauseCampaign(db, userId, campaignId, reason, actor) {
  const r = await db.query(
    `UPDATE outbound_campaigns SET status='PAUSED_AUTOMATICALLY', status_reason=$3, updated_at=NOW() WHERE id=$1 AND user_id=$2 AND status='ACTIVE' RETURNING id, name`,
    [campaignId, userId, reason]
  );
  if (r.rowCount) {
    await audit(db, { userId, actor, action: 'CAMPAIGN_PAUSED_AUTOMATICALLY', campaignId, detail: { reason } });
    await raiseAlert(db, { userId, kind: 'CAMPAIGN_AUTO_PAUSED', severity: 'CRITICAL', message: `Campaign "${r.rows[0].name}" was paused automatically: ${reason}`, detail: { campaignId }, dedupeKey: `campaign_paused:${campaignId}` });
  }
  return r.rowCount > 0;
}

async function evaluateCampaign(db, userId, campaign, actor = 'system:circuit') {
  if (!campaign || campaign.status !== 'ACTIVE') return { tripped: false };
  const t = { ...DEFAULTS, ...(campaign.limits?.circuit || {}) };
  const r = await campaignRates(db, userId, campaign.id);
  const reasons = [];
  if (r.complaints >= t.complaints7d) reasons.push(`${r.complaints} spam complaint(s) in 7 days`);
  if (r.hard24 >= t.spikeHardBounces24h) reasons.push(`bounce spike: ${r.hard24} hard bounces in 24 hours`);
  if (r.sent >= t.minSample) {
    if (r.hard / r.sent > t.hardBounceRate) reasons.push(`hard bounce rate ${(100 * r.hard / r.sent).toFixed(1)}% over ${r.sent} sends`);
    if (r.blocked / r.sent > t.blockRate) reasons.push(`block rate ${(100 * r.blocked / r.sent).toFixed(1)}% over ${r.sent} sends`);
  }
  if (!reasons.length) return { tripped: false, rates: r };
  await pauseCampaign(db, userId, campaign.id, reasons.join('; '), actor);
  return { tripped: true, reasons, rates: r };
}

async function onProviderError(db, userId, accountId, cls, message) {
  if (cls === 'AUTH') {
    await db.query(`UPDATE outbound_provider_accounts SET status='AUTH_REQUIRED', status_reason=$3, last_error_at=NOW(), updated_at=NOW() WHERE id=$1 AND user_id=$2`, [accountId, userId, message.slice(0, 300)]);
    await raiseAlert(db, { userId, kind: 'PROVIDER_AUTH_FAILURE', severity: 'CRITICAL', message: 'The sending account needs to be reconnected. Sending from it has stopped.', detail: { accountId }, dedupeKey: `auth:${accountId}` });
    await audit(db, { userId, actor: 'system:circuit', action: 'ACCOUNT_AUTH_REQUIRED', detail: { accountId } });
    return;
  }
  const r = await db.query(
    `UPDATE outbound_provider_accounts SET consecutive_errors = consecutive_errors + 1, last_error_at = NOW(), updated_at = NOW()
      WHERE id=$1 AND user_id=$2 RETURNING consecutive_errors, status, throttle_factor`,
    [accountId, userId]
  );
  const a = r.rows[0];
  if (!a) return;
  if (a.consecutive_errors >= DEFAULTS.errorsPause && a.status !== 'PAUSED') {
    await db.query(`UPDATE outbound_provider_accounts SET status='PAUSED', status_reason=$3 WHERE id=$1 AND user_id=$2`, [accountId, userId, `paused after ${a.consecutive_errors} consecutive provider errors: ${message.slice(0, 200)}`]);
    await raiseAlert(db, { userId, kind: 'PROVIDER_ERRORS', severity: 'CRITICAL', message: `Sending paused after ${a.consecutive_errors} provider errors in a row.`, detail: { accountId }, dedupeKey: `provider_errors:${accountId}` });
    await audit(db, { userId, actor: 'system:circuit', action: 'ACCOUNT_PAUSED', detail: { accountId, consecutiveErrors: a.consecutive_errors } });
  } else if (a.consecutive_errors >= DEFAULTS.errorsThrottle && a.status === 'HEALTHY') {
    await db.query(`UPDATE outbound_provider_accounts SET status='THROTTLED', throttle_factor=GREATEST(0.1, throttle_factor*0.5), status_reason=$3 WHERE id=$1 AND user_id=$2`, [accountId, userId, `throttled after ${a.consecutive_errors} provider errors`]);
    await audit(db, { userId, actor: 'system:circuit', action: 'ACCOUNT_THROTTLED', detail: { accountId } });
  }
}

async function onRateLimited(db, userId, accountId, retryAfterMs, now = new Date()) {
  await db.query(
    `UPDATE outbound_provider_accounts SET status = CASE WHEN status='HEALTHY' THEN 'THROTTLED' ELSE status END,
            throttle_factor = GREATEST(0.1, throttle_factor*0.5), status_reason = $3, last_error_at = NOW(), updated_at = NOW()
      WHERE id=$1 AND user_id=$2`,
    [accountId, userId, `provider rate limit (429); retry after ${Math.round((retryAfterMs || 0) / 1000)}s`]
  );
  // Drain the account's token bucket so no worker on any instance sends
  // from this account before Retry-After has passed.
  await db.query(
    `UPDATE outbound_rate_buckets SET tokens = -(refill_per_sec * $2 / 1000.0), updated_at = $3 WHERE bucket_key = $1`,
    [`email:ACCOUNT:${userId}:${accountId}`, Math.max(1000, retryAfterMs || 60000), now]
  );
  await audit(db, { userId, actor: 'system:circuit', action: 'ACCOUNT_RATE_LIMITED', detail: { accountId, retryAfterMs } });
}

async function onSuccess(db, userId, accountId) {
  await db.query(`UPDATE outbound_provider_accounts SET consecutive_errors = 0, last_success_at = NOW() WHERE id=$1 AND user_id=$2`, [accountId, userId]);
}

async function adaptAccount(db, userId, account) {
  const r = await db.query(
    `SELECT COUNT(*) FILTER (WHERE event_type='SENT')::int AS sent,
            COUNT(*) FILTER (WHERE event_type IN ('BOUNCED','BLOCKED','COMPLAINT'))::int AS bad
       FROM outbound_delivery_events WHERE user_id=$1 AND provider_account_id=$2 AND occurred_at >= NOW() - INTERVAL '3 days'`,
    [userId, account.id]
  );
  const { sent, bad } = r.rows[0];
  if (sent < DEFAULTS.minSample) return null;
  const rate = bad / sent;
  if (rate > DEFAULTS.accountBounceRate && Number(account.throttle_factor) > 0.1) {
    await db.query(`UPDATE outbound_provider_accounts SET throttle_factor=GREATEST(0.1, throttle_factor*0.5), status=CASE WHEN status='HEALTHY' THEN 'THROTTLED' ELSE status END, status_reason=$3, updated_at=NOW() WHERE id=$1 AND user_id=$2`, [account.id, userId, `adaptive: bounce/block rate ${(rate * 100).toFixed(1)}%`]);
    return 'DOWN';
  }
  if (rate < 0.01 && Number(account.throttle_factor) < 1 && new Date(account.updated_at).getTime() < Date.now() - 86400000 && Number(account.consecutive_errors) === 0) {
    await db.query(`UPDATE outbound_provider_accounts SET throttle_factor=LEAST(1, throttle_factor+0.25), status=CASE WHEN status='THROTTLED' THEN 'HEALTHY' ELSE status END, status_reason=NULL, updated_at=NOW() WHERE id=$1 AND user_id=$2`, [account.id, userId]);
    return 'UP';
  }
  return null;
}

module.exports = { DEFAULTS, evaluateCampaign, pauseCampaign, onProviderError, onRateLimited, onSuccess, adaptAccount, campaignRates };
