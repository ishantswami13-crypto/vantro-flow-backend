'use strict';
// lib/domain/outbound/store.js
// Shared writes: audit, contact state machine, suppression, alerts.
// Every function takes userId and filters by it; `db` is a pool or a client
// inside the caller's transaction.

const { normalizeEmail, emailDomain } = require('./normalize');

const CONTACT_STATES = ['NEW', 'RESEARCHED', 'VERIFIED', 'ELIGIBLE', 'QUEUED', 'SENT', 'DELIVERED', 'REPLIED', 'INTERESTED', 'MEETING', 'DECLINED', 'BOUNCED', 'BLOCKED', 'OPTED_OUT', 'SUPPRESSED'];
// Terminal states: nothing moves a contact out of these automatically.
const TERMINAL = new Set(['BOUNCED', 'BLOCKED', 'OPTED_OUT', 'SUPPRESSED', 'DECLINED']);
// Engagement states: an automated send (e.g. SENT after a follow-up) never
// downgrades these.
const ENGAGED = new Set(['REPLIED', 'INTERESTED', 'MEETING']);

const SUPPRESSION_REASONS = ['UNSUBSCRIBED', 'HARD_BOUNCE', 'SPAM_COMPLAINT', 'BLOCKED', 'EXPLICIT_DO_NOT_CONTACT', 'LEGAL_SUPPRESSION', 'INVALID_ADDRESS', 'DECLINED'];
const REASON_STATE = { UNSUBSCRIBED: 'OPTED_OUT', HARD_BOUNCE: 'BOUNCED', SPAM_COMPLAINT: 'OPTED_OUT', BLOCKED: 'BLOCKED', EXPLICIT_DO_NOT_CONTACT: 'SUPPRESSED', LEGAL_SUPPRESSION: 'SUPPRESSED', INVALID_ADDRESS: 'SUPPRESSED', DECLINED: 'DECLINED' };

async function audit(db, { userId, actor, action, campaignId = null, contactId = null, jobId = null, messageId = null, detail = {}, correlationId = null }) {
  await db.query(
    `INSERT INTO outbound_audit (user_id, actor, action, campaign_id, contact_id, job_id, message_id, detail, correlation_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [userId, actor, action, campaignId, contactId, jobId, messageId, JSON.stringify(detail), correlationId]
  );
}

/**
 * Moves a contact to `to` unless the move is not allowed:
 * terminal states are sticky (except an explicit manual override), and
 * automated progress (QUEUED/SENT/DELIVERED) never overwrites engagement.
 */
async function setContactState(db, userId, contactId, to, reason, { manual = false } = {}) {
  if (!CONTACT_STATES.includes(to)) throw new Error(`bad contact state ${to}`);
  const cur = await db.query('SELECT state FROM outbound_contacts WHERE id = $1 AND user_id = $2 FOR UPDATE', [contactId, userId]);
  if (!cur.rows[0]) return null;
  const from = cur.rows[0].state;
  if (from === to) return from;
  if (TERMINAL.has(from) && !manual) return from;
  if (ENGAGED.has(from) && ['QUEUED', 'SENT', 'DELIVERED', 'ELIGIBLE', 'VERIFIED'].includes(to) && !manual) return from;
  await db.query('UPDATE outbound_contacts SET state = $3, updated_at = NOW() WHERE id = $1 AND user_id = $2', [contactId, userId, to]);
  await db.query('INSERT INTO outbound_contact_state_history (user_id, contact_id, from_state, to_state, reason) VALUES ($1,$2,$3,$4,$5)', [userId, contactId, from, to, reason || null]);
  return to;
}

/**
 * Adds a suppression and applies it everywhere at once: the contact moves to
 * the matching terminal state and every open job for that address (any
 * campaign) is cancelled in the same transaction. Idempotent.
 */
async function suppress(db, userId, { email = null, domain = null, reason, source, note = null, actorId = null, hard = true }) {
  if (!SUPPRESSION_REASONS.includes(reason)) throw Object.assign(new Error(`reason must be one of ${SUPPRESSION_REASONS.join(', ')}`), { status: 400 });
  const en = email ? normalizeEmail(email) : null;
  const dom = domain ? String(domain).toLowerCase().trim() : null;
  if (!en && !dom) throw Object.assign(new Error('email or domain is required'), { status: 400 });
  if (en) {
    await db.query(
      `INSERT INTO outbound_suppressions (user_id, email_normalized, reason, hard, source, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (user_id, email_normalized, reason) WHERE email_normalized IS NOT NULL DO NOTHING`,
      [userId, en, reason, hard, source, note, actorId]
    );
  } else {
    await db.query(
      `INSERT INTO outbound_suppressions (user_id, domain, reason, hard, source, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (user_id, domain, reason) WHERE email_normalized IS NULL DO NOTHING`,
      [userId, dom, reason, hard, source, note, actorId]
    );
  }
  const contacts = await db.query(
    en ? 'SELECT id FROM outbound_contacts WHERE user_id = $1 AND email_normalized = $2' : 'SELECT id FROM outbound_contacts WHERE user_id = $1 AND email_domain = $2',
    [userId, en || dom]
  );
  const state = REASON_STATE[reason];
  for (const c of contacts.rows) await setContactState(db, userId, c.id, state, `suppressed:${reason}`, { manual: true });
  const cancelled = await db.query(
    `UPDATE outbound_send_jobs SET status = 'CANCELLED', cancelled_reason = $3, lease_owner = NULL, lease_expires_at = NULL, updated_at = NOW()
      WHERE user_id = $1 AND contact_id = ANY($2::uuid[]) AND status IN ('QUEUED','RETRY_WAIT','RESERVED')
      RETURNING id`,
    [userId, contacts.rows.map((c) => c.id), `suppressed:${reason}`]
  );
  if (contacts.rows.length) {
    await db.query(
      `UPDATE outbound_enrollments SET status = 'EXCLUDED', status_reason = $3, next_followup_at = NULL, updated_at = NOW()
        WHERE user_id = $1 AND contact_id = ANY($2::uuid[]) AND status NOT IN ('FINISHED','CANCELLED','EXCLUDED')`,
      [userId, contacts.rows.map((c) => c.id), `suppressed:${reason}`]
    );
  }
  await audit(db, { userId, actor: actorId ? `user:${actorId}` : source, action: 'SUPPRESS', detail: { email: en, domain: dom, reason, contacts: contacts.rows.length, jobsCancelled: cancelled.rowCount } });
  return { contacts: contacts.rows.length, jobsCancelled: cancelled.rowCount };
}

async function suppressionFor(db, userId, email) {
  const en = normalizeEmail(email);
  const dom = emailDomain(email);
  const r = await db.query(
    `SELECT reason, hard, email_normalized, domain FROM outbound_suppressions
      WHERE user_id = $1 AND (email_normalized = $2 OR (email_normalized IS NULL AND domain = $3))`,
    [userId, en, dom]
  );
  return r.rows;
}

async function raiseAlert(db, { userId = null, kind, severity, message, detail = {}, dedupeKey }) {
  await db.query(
    `INSERT INTO outbound_alerts (user_id, kind, severity, message, detail, dedupe_key) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid), dedupe_key) WHERE resolved_at IS NULL DO NOTHING`,
    [userId, kind, severity, message, JSON.stringify(detail), dedupeKey || kind]
  );
}

async function resolveAlert(db, userId, dedupeKey) {
  await db.query(`UPDATE outbound_alerts SET resolved_at = NOW() WHERE COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE($1::uuid, '00000000-0000-0000-0000-000000000000'::uuid) AND dedupe_key = $2 AND resolved_at IS NULL`, [userId, dedupeKey]);
}

async function recordCost(db, { userId, campaignId = null, kind, units = 1, amountUsd = 0, model = null }) {
  await db.query('INSERT INTO outbound_costs (user_id, campaign_id, kind, units, amount_usd, model) VALUES ($1,$2,$3,$4,$5,$6)', [userId, campaignId, kind, units, amountUsd, model]);
}

async function tx(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { CONTACT_STATES, TERMINAL, ENGAGED, SUPPRESSION_REASONS, REASON_STATE, audit, setContactState, suppress, suppressionFor, raiseAlert, resolveAlert, recordCost, tx };
