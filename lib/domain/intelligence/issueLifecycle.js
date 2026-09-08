// FILE: lib/domain/intelligence/issueLifecycle.js
// STARLANE Temporal Intelligence — Part 16-18: Issue identity + lifecycle.
//
// Gives a recurring insight a STABLE, deterministic identity (issue_key,
// e.g. "CUSTOMER_<id>_PAYMENT_RISK") so it evolves across checkpoints
// (DETECTED -> WORSENING/STABLE/IMPROVING -> RESOLVED -> RECURRED) instead of
// being re-created as a "new" alert every review — the alert-fatigue failure
// mode named in Part 50. Backed by migrations/028_temporal_intelligence.sql's
// tenant_issue_lifecycle table (UNIQUE(user_id, issue_key)).
//
// This module does not decide WHETHER something is an issue — that gate is
// materiality.js / the caller's own domain logic (e.g. evidenceDrift.js).
// It only tracks identity + state transitions for issues callers report.

const { getPool } = require('../../db/pg');

function buildIssueKey(kind, entityType, entityId) {
  return `${kind}_${entityType}_${entityId}`.toUpperCase();
}

/**
 * Report one issue's current real severity direction for this checkpoint.
 * Applies the deterministic state machine:
 *   no prior row            -> DETECTED
 *   prior OPEN, worse now   -> WORSENING
 *   prior OPEN, same        -> STABLE
 *   prior OPEN, better now  -> IMPROVING
 *   prior OPEN, isPresent=false -> RESOLVED
 *   prior RESOLVED, isPresent=true -> RECURRED (recurrence_count += 1)
 *
 * @param {string} userId
 * @param {string} issueKey - from buildIssueKey
 * @param {Object} params
 * @param {boolean} params.isPresent - is the underlying condition still true this checkpoint
 * @param {'WORSE'|'SAME'|'BETTER'|null} params.direction - only meaningful when isPresent=true and a prior OPEN row exists
 * @param {Object} [params.detail] - real evidence snapshot to store
 */
async function reportIssueCheckpoint(userId, issueKey, { isPresent, direction = null, detail = {} }) {
  if (!userId || !issueKey) throw new Error('reportIssueCheckpoint: userId and issueKey are required');
  const pool = getPool();
  const existing = await pool.query(
    `SELECT * FROM tenant_issue_lifecycle WHERE user_id = $1 AND issue_key = $2`,
    [userId, issueKey]
  );
  const prior = existing.rows[0] || null;
  const now = new Date().toISOString();

  let newStatus;
  let recurrenceIncrement = 0;
  let resolvedAt = prior ? prior.resolved_at : null;

  if (!prior) {
    newStatus = isPresent ? 'DETECTED' : null; // nothing to record if it was never present
    if (!isPresent) return { skipped: true, reason: 'no prior issue and not currently present — nothing to record' };
  } else if (prior.status === 'RESOLVED') {
    if (isPresent) {
      newStatus = 'RECURRED';
      recurrenceIncrement = 1;
      resolvedAt = null;
    } else {
      return { skipped: true, reason: 'already RESOLVED and still not present — no state change' };
    }
  } else {
    // prior is open (DETECTED/WORSENING/STABLE/IMPROVING/RECURRED)
    if (!isPresent) {
      newStatus = 'RESOLVED';
      resolvedAt = now;
    } else if (direction === 'WORSE') {
      newStatus = 'WORSENING';
    } else if (direction === 'BETTER') {
      newStatus = 'IMPROVING';
    } else {
      newStatus = 'STABLE';
    }
  }

  const res = await pool.query(
    `INSERT INTO tenant_issue_lifecycle (user_id, issue_key, status, detail, first_detected_at, last_seen_at, resolved_at, recurrence_count, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $5, $6, $7, now(), now())
     ON CONFLICT (user_id, issue_key) DO UPDATE SET
       status = EXCLUDED.status,
       detail = EXCLUDED.detail,
       last_seen_at = $5,
       resolved_at = EXCLUDED.resolved_at,
       recurrence_count = tenant_issue_lifecycle.recurrence_count + $8,
       updated_at = now()
     RETURNING *`,
    [userId, issueKey, newStatus, JSON.stringify(detail), now, resolvedAt, recurrenceIncrement, recurrenceIncrement]
  );
  return res.rows[0];
}

async function getIssueHistory(userId, issueKey) {
  const pool = getPool();
  const res = await pool.query(`SELECT * FROM tenant_issue_lifecycle WHERE user_id = $1 AND issue_key = $2`, [userId, issueKey]);
  return res.rows[0] || null;
}

async function listOpenIssues(userId) {
  const pool = getPool();
  const res = await pool.query(
    `SELECT * FROM tenant_issue_lifecycle WHERE user_id = $1 AND status != 'RESOLVED' ORDER BY last_seen_at DESC`,
    [userId]
  );
  return res.rows;
}

module.exports = { buildIssueKey, reportIssueCheckpoint, getIssueHistory, listOpenIssues };
