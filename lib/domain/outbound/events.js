'use strict';
// lib/domain/outbound/events.js
// Event ingestion: delivery events, bounces, complaints, unsubscribes and
// replies, from a provider poller, a webhook or a manual entry.
//
// Every event carries a dedupe key and is stored once (UNIQUE per tenant);
// a duplicate webhook or a re-polled message has no second effect.
// Only events a provider actually reports are stored: Gmail reports no
// delivery or open events, so none are fabricated.
//
// Effects:
//   BOUNCED HARD   -> suppress HARD_BOUNCE (never retried), cancel open jobs, campaign circuit check
//   BOUNCED BLOCK  -> suppress BLOCKED, campaign circuit check (block rate)
//   BOUNCED SOFT   -> recorded; the third soft bounce in 30 days suppresses the address
//   BOUNCED UNKNOWN-> recorded, alert for a person to classify
//   COMPLAINT      -> suppress SPAM_COMPLAINT, campaign paused by the circuit breaker
//   UNSUBSCRIBED   -> suppress UNSUBSCRIBED
//   DELIVERED      -> contact DELIVERED (never downgrades engagement)
//   reply          -> classified; OPT_OUT suppresses; DECLINED suppresses as DECLINED;
//                     anything but an auto-reply stops follow-ups for that contact
//                     and lands in the attention list (Prepared)

const { normalizeEmail } = require('./normalize');
const { classifyBounce, classifyReply, REPLY_STATE } = require('./classify');
const { audit, setContactState, suppress, raiseAlert, tx } = require('./store');
const circuit = require('./circuit');

const EVENT_TYPES = ['DELIVERED', 'DEFERRED', 'BOUNCED', 'BLOCKED', 'COMPLAINT', 'OPENED', 'CLICKED', 'UNSUBSCRIBED'];

async function findJob(db, userId, { jobId, providerMessageId, rfc822MessageId, email }) {
  if (jobId) { const r = await db.query('SELECT * FROM outbound_send_jobs WHERE id=$1 AND user_id=$2', [jobId, userId]); if (r.rows[0]) return r.rows[0]; }
  if (providerMessageId) { const r = await db.query('SELECT * FROM outbound_send_jobs WHERE provider_message_id=$1 AND user_id=$2', [providerMessageId, userId]); if (r.rows[0]) return r.rows[0]; }
  if (rfc822MessageId) { const r = await db.query('SELECT * FROM outbound_send_jobs WHERE rfc822_message_id=$1 AND user_id=$2', [rfc822MessageId, userId]); if (r.rows[0]) return r.rows[0]; }
  if (email) {
    const r = await db.query(
      `SELECT j.* FROM outbound_send_jobs j JOIN outbound_contacts c ON c.id=j.contact_id AND c.user_id=j.user_id
        WHERE j.user_id=$1 AND c.email_normalized=$2 AND j.status='SENT' ORDER BY j.sent_at DESC LIMIT 1`,
      [userId, normalizeEmail(email)]
    );
    if (r.rows[0]) return r.rows[0];
  }
  return null;
}

/**
 * evt: { type, dedupeKey, source, jobId?, providerMessageId?, rfc822MessageId?, email?,
 *        bounce?: { status, diagnostic }, occurredAt?, detail? }
 */
async function ingestEvent(pool, userId, evt) {
  if (!EVENT_TYPES.includes(evt.type)) throw Object.assign(new Error(`type must be one of ${EVENT_TYPES.join(', ')}`), { status: 400 });
  if (!evt.dedupeKey || String(evt.dedupeKey).length > 300) throw Object.assign(new Error('dedupeKey is required'), { status: 400 });
  return tx(pool, async (c) => {
    const job = await findJob(c, userId, evt);
    const contact = job
      ? (await c.query('SELECT * FROM outbound_contacts WHERE id=$1 AND user_id=$2', [job.contact_id, userId])).rows[0]
      : evt.email ? (await c.query('SELECT * FROM outbound_contacts WHERE email_normalized=$1 AND user_id=$2', [normalizeEmail(evt.email), userId])).rows[0] : null;
    let type = evt.type;
    let bounceClass = null;
    if (type === 'BOUNCED') bounceClass = classifyBounce(evt.bounce || {});
    if (type === 'BLOCKED') bounceClass = 'BLOCK';
    const ins = await c.query(
      `INSERT INTO outbound_delivery_events (user_id, job_id, message_id, contact_id, campaign_id, provider_account_id, event_type, bounce_class, dedupe_key, source, detail, occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (user_id, dedupe_key) DO NOTHING RETURNING id`,
      [userId, job?.id || null, job?.message_id || null, contact?.id || null, job?.campaign_id || null, job?.provider_account_id || null, type, bounceClass,
        String(evt.dedupeKey), String(evt.source || 'api'), JSON.stringify({ ...(evt.detail || {}), bounce: evt.bounce || null }), evt.occurredAt ? new Date(evt.occurredAt) : new Date()]
    );
    if (!ins.rowCount) return { duplicate: true };
    const effects = [];
    const email = contact?.email || evt.email;
    if (type === 'BOUNCED' && bounceClass === 'HARD' && email) { await suppress(c, userId, { email, reason: 'HARD_BOUNCE', source: `bounce:${evt.source || 'api'}`, note: evt.bounce?.status || null }); effects.push('SUPPRESSED:HARD_BOUNCE'); }
    if ((type === 'BLOCKED' || bounceClass === 'BLOCK') && email) { await suppress(c, userId, { email, reason: 'BLOCKED', source: `bounce:${evt.source || 'api'}`, note: evt.bounce?.diagnostic?.slice(0, 200) || null }); effects.push('SUPPRESSED:BLOCKED'); }
    if (type === 'BOUNCED' && bounceClass === 'SOFT' && contact) {
      const n = await c.query(`SELECT COUNT(*)::int AS n FROM outbound_delivery_events WHERE user_id=$1 AND contact_id=$2 AND event_type='BOUNCED' AND bounce_class='SOFT' AND occurred_at >= NOW() - INTERVAL '30 days'`, [userId, contact.id]);
      if (n.rows[0].n >= 3) { await suppress(c, userId, { email, reason: 'INVALID_ADDRESS', source: 'repeated_soft_bounce', note: `${n.rows[0].n} soft bounces in 30 days` }); effects.push('SUPPRESSED:REPEATED_SOFT_BOUNCE'); }
    }
    if (type === 'BOUNCED' && bounceClass === 'UNKNOWN') await raiseAlert(c, { userId, kind: 'UNCLASSIFIED_BOUNCE', severity: 'WARNING', message: `A bounce for ${email || 'an unknown recipient'} could not be classified. Decide whether to suppress it.`, detail: { dedupeKey: evt.dedupeKey }, dedupeKey: `bounce_unknown:${evt.dedupeKey}` });
    if (type === 'COMPLAINT' && email) { await suppress(c, userId, { email, reason: 'SPAM_COMPLAINT', source: `complaint:${evt.source || 'api'}` }); effects.push('SUPPRESSED:SPAM_COMPLAINT'); }
    if (type === 'UNSUBSCRIBED' && email) { await suppress(c, userId, { email, reason: 'UNSUBSCRIBED', source: `unsubscribe:${evt.source || 'api'}` }); effects.push('SUPPRESSED:UNSUBSCRIBED'); }
    if (type === 'DELIVERED' && contact) await setContactState(c, userId, contact.id, 'DELIVERED', `event:${evt.dedupeKey}`);
    if (job?.campaign_id && ['BOUNCED', 'BLOCKED', 'COMPLAINT'].includes(type)) {
      const campaign = (await c.query('SELECT * FROM outbound_campaigns WHERE id=$1 AND user_id=$2', [job.campaign_id, userId])).rows[0];
      const cb = await circuit.evaluateCampaign(c, userId, campaign, 'system:events');
      if (cb.tripped) effects.push(`CAMPAIGN_PAUSED:${cb.reasons.join('; ')}`);
    }
    await audit(c, { userId, actor: `events:${evt.source || 'api'}`, action: `EVENT_${type}`, campaignId: job?.campaign_id || null, contactId: contact?.id || null, jobId: job?.id || null, detail: { bounceClass, effects, dedupeKey: evt.dedupeKey } });
    return { duplicate: false, eventId: ins.rows[0].id, bounceClass, matchedJob: job?.id || null, effects };
  });
}

/**
 * r: { providerMessageId, threadId?, fromAddress, subject?, body, headers?, inReplyTo?, receivedAt?, source? }
 * Only mail from a known contact is ingested.
 */
async function ingestReply(pool, userId, r) {
  if (!r.providerMessageId || !r.fromAddress) throw Object.assign(new Error('providerMessageId and fromAddress are required'), { status: 400 });
  return tx(pool, async (c) => {
    const contact = (await c.query('SELECT * FROM outbound_contacts WHERE user_id=$1 AND email_normalized=$2', [userId, normalizeEmail(r.fromAddress)])).rows[0];
    if (!contact) return { ignored: true, reason: 'sender is not an outreach contact' };
    let job = null;
    if (r.threadId) job = (await c.query(`SELECT * FROM outbound_send_jobs WHERE user_id=$1 AND provider_thread_id=$2 ORDER BY sent_at DESC NULLS LAST LIMIT 1`, [userId, r.threadId])).rows[0] || null;
    if (!job && r.inReplyTo) job = (await c.query('SELECT * FROM outbound_send_jobs WHERE user_id=$1 AND rfc822_message_id=$2', [userId, r.inReplyTo])).rows[0] || null;
    if (!job) job = (await c.query(`SELECT * FROM outbound_send_jobs WHERE user_id=$1 AND contact_id=$2 AND status='SENT' ORDER BY sent_at DESC LIMIT 1`, [userId, contact.id])).rows[0] || null;
    const cls = classifyReply({ body: r.body, subject: r.subject, headers: r.headers });
    const ins = await c.query(
      `INSERT INTO outbound_replies (user_id, contact_id, campaign_id, message_id, job_id, provider_message_id, thread_id, from_address, subject, snippet, classification, classifier_version, matched_rule, needs_attention, received_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT (user_id, provider_message_id) DO NOTHING RETURNING id`,
      [userId, contact.id, job?.campaign_id || null, job?.message_id || null, job?.id || null, String(r.providerMessageId), r.threadId || null, normalizeEmail(r.fromAddress),
        r.subject ? String(r.subject).slice(0, 300) : null, String(r.body || '').slice(0, 500), cls.classification, cls.version, cls.matchedRule, cls.needsAttention,
        r.receivedAt ? new Date(r.receivedAt) : new Date()]
    );
    if (!ins.rowCount) return { duplicate: true };
    const effects = [];
    if (cls.classification === 'OPT_OUT') { await suppress(c, userId, { email: contact.email, reason: 'UNSUBSCRIBED', source: 'reply_opt_out' }); effects.push('SUPPRESSED:UNSUBSCRIBED'); }
    else if (cls.classification === 'DECLINED') { await suppress(c, userId, { email: contact.email, reason: 'DECLINED', source: 'reply_declined', hard: false }); effects.push('SUPPRESSED:DECLINED'); }
    if (cls.classification !== 'AUTO_REPLY') {
      const nextState = REPLY_STATE[cls.classification];
      if (nextState && !['OPTED_OUT', 'DECLINED'].includes(nextState)) await setContactState(c, userId, contact.id, nextState, `reply:${cls.classification}`, { manual: true });
      // Stop every automated follow-up to this person, in every campaign.
      const cancelled = await c.query(
        `UPDATE outbound_send_jobs j SET status='CANCELLED', cancelled_reason='contact replied', lease_owner=NULL, lease_expires_at=NULL, updated_at=NOW()
          WHERE j.user_id=$1 AND j.contact_id=$2 AND j.status IN ('QUEUED','RETRY_WAIT','RESERVED') RETURNING id`,
        [userId, contact.id]
      );
      await c.query(`UPDATE outbound_enrollments SET status='REPLIED', status_reason=$3, next_followup_at=NULL, updated_at=NOW() WHERE user_id=$1 AND contact_id=$2 AND status NOT IN ('EXCLUDED','CANCELLED')`, [userId, contact.id, `reply:${cls.classification}`]);
      if (cancelled.rowCount) effects.push(`FOLLOWUPS_CANCELLED:${cancelled.rowCount}`);
      await c.query(
        `INSERT INTO outbound_delivery_events (user_id, job_id, message_id, contact_id, campaign_id, provider_account_id, event_type, dedupe_key, source, detail, occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,'REPLIED',$7,$8,$9,$10) ON CONFLICT (user_id, dedupe_key) DO NOTHING`,
        [userId, job?.id || null, job?.message_id || null, contact.id, job?.campaign_id || null, job?.provider_account_id || null, `reply:${r.providerMessageId}`, r.source || 'api',
          JSON.stringify({ classification: cls.classification }), r.receivedAt ? new Date(r.receivedAt) : new Date()]
      );
    }
    await audit(c, { userId, actor: `events:${r.source || 'api'}`, action: 'REPLY_RECEIVED', campaignId: job?.campaign_id || null, contactId: contact.id, jobId: job?.id || null, detail: { classification: cls.classification, rule: cls.matchedRule, effects } });
    return { duplicate: false, replyId: ins.rows[0].id, classification: cls.classification, needsAttention: cls.needsAttention, effects };
  });
}

/**
 * Polls one real mailbox for bounce reports and replies since the last
 * poll. The cursor only advances after every message was ingested.
 */
async function pollAccount(pool, account, adapter) {
  const since = account.last_poll_at || new Date(Date.now() - 2 * 86400000);
  const { messages, cursor } = await adapter.listInbound({ since });
  const out = { bounces: 0, replies: 0, ignored: 0, duplicates: 0 };
  for (const m of messages) {
    if (m.isBounce && m.dsn) {
      const r = await ingestEvent(pool, account.user_id, { type: 'BOUNCED', dedupeKey: `gmail-bounce:${m.id}`, source: 'gmail_poll', rfc822MessageId: m.dsn.originalMessageId, email: m.dsn.recipient, bounce: { status: m.dsn.status, diagnostic: m.dsn.diagnostic }, occurredAt: m.receivedAt });
      if (r.duplicate) out.duplicates += 1; else out.bounces += 1;
    } else {
      const r = await ingestReply(pool, account.user_id, { providerMessageId: m.id, threadId: m.threadId, fromAddress: m.fromAddress, subject: m.subject, body: m.body, headers: m.headers, inReplyTo: m.inReplyTo, receivedAt: m.receivedAt, source: 'gmail_poll' });
      if (r.ignored) out.ignored += 1; else if (r.duplicate) out.duplicates += 1; else out.replies += 1;
    }
  }
  await pool.query('UPDATE outbound_provider_accounts SET last_poll_at=$3, updated_at=NOW() WHERE id=$1 AND user_id=$2', [account.id, account.user_id, cursor ? new Date(cursor) : new Date()]);
  return out;
}

module.exports = { EVENT_TYPES, ingestEvent, ingestReply, pollAccount, findJob };
