// FILE: lib/domain/decisions/noticeFreshness.js
// Last check before a customer-update draft (COMMITMENT_DELAY_NOTICE) is
// approved or sent. The draft quotes a promised date and a revised date from
// a supplier-delay decision; if a receipt, import, feed or edit has changed
// those facts since, the draft is withdrawn (status 'expired', with a reason)
// and the caller refuses the approval or send with 409. The decision is
// reconciled so the owner sees a newer one with an updated draft that needs
// fresh approval. If the check itself cannot run, nothing is approved or
// sent (503): blocking is the safe failure.
//
// Every query is scoped by user_id. Other action types pass through.

const { safeLog } = require('../../observability/logger');

const NOTICE = 'COMMITMENT_DELAY_NOTICE';

function refusal(status, code, error, extra = {}) {
  return { ok: false, status, code, error, ...extra };
}

async function newerDecisionFor(pool, userId, decision) {
  const r = await pool.query(
    `SELECT id FROM decisions WHERE user_id = $1 AND dedup_key = $2 AND id <> $3
       AND status IN ('OPEN','NEEDS_INFORMATION','SELECTED','APPROVED','EXECUTING','SHADOWED','EXECUTED')
     ORDER BY created_at DESC LIMIT 1`,
    [userId, decision.dedup_key, decision.id]
  );
  return r.rows[0] ? r.rows[0].id : null;
}

async function withdraw(pool, userId, action, decision, why, ctx) {
  const { appendEvent, agentActor } = require('./store');
  const upd = await pool.query(
    `UPDATE ai_actions SET status = 'expired', block_reason = $3, updated_at = NOW()
     WHERE id = $1 AND user_id = $2 AND status IN ('pending','approved') RETURNING id`,
    [action.id, userId, `Withdrawn before sending: ${why}`]
  );
  if (decision) {
    await appendEvent(pool, {
      userId, decisionId: decision.id, type: 'NOTICE_BLOCKED_STALE', actor: agentActor(userId), correlationId: ctx.correlationId || null,
      payload: { aiActionId: action.id, stage: ctx.stage || null, reason: why, withdrawn: upd.rows.length === 1 },
    }).catch((err) => safeLog('warn', '[decisions] notice block event failed', { userId, error: err.message }));
  }
}

/**
 * @param {import('pg').Pool} pool
 * @param {string} userId  tenant from the verified session, never the body
 * @param {string} actionId
 * @param {{ stage?: string, correlationId?: string }} ctx
 * @returns {Promise<{ok: true} | {ok: false, status: number, code: string, error: string, newerDecisionId?: string|null}>}
 */
async function checkDelayNoticeCurrent(pool, userId, actionId, ctx = {}) {
  let action;
  try {
    const r = await pool.query(`SELECT id, action_type, status, decision_id, parameters FROM ai_actions WHERE id = $1 AND user_id = $2`, [actionId, userId]);
    action = r.rows[0];
  } catch (err) {
    safeLog('error', '[decisions] notice freshness lookup failed', { userId, actionId, error: err.message });
    return refusal(503, 'NOTICE_CHECK_FAILED', 'Starlane could not check this update, so nothing was approved or sent. Try again, or review it from its decision.');
  }
  if (!action || action.action_type !== NOTICE) return { ok: true };

  try {
    const { getDecision } = require('./store');
    const decision = action.decision_id ? await getDecision(pool, userId, action.decision_id) : null;
    if (!decision) {
      await withdraw(pool, userId, action, null, 'the decision behind this update is not on record.', ctx);
      return refusal(409, 'NOTICE_STALE', 'This update is not linked to a current decision, so it was withdrawn. Nothing was sent.');
    }
    if (decision.status !== 'EXECUTED') {
      const newer = await newerDecisionFor(pool, userId, decision);
      await withdraw(pool, userId, action, decision, `its decision is ${decision.status.toLowerCase()}${decision.resolution_reason ? ` (${decision.resolution_reason})` : ''}`, ctx);
      return refusal(409, 'NOTICE_STALE', newer
        ? 'The facts behind this update changed. It was withdrawn and nothing was sent. A newer decision has an updated draft that needs your approval.'
        : `The decision behind this update is no longer current (${decision.resolution_reason || decision.status}). It was withdrawn and nothing was sent.`, { newerDecisionId: newer });
    }

    const { recheckSupplierDelay } = require('./detectors/supplierDelay');
    const check = await recheckSupplierDelay(pool, userId, decision);
    const p = action.parameters || {};
    const line = (check.current?.atRisk || []).find((l) => String(l.orderLineId || l.orderId) === String(p.orderLineId || p.orderId));
    const lineOk = !!line && line.neededBy === p.neededBy && (line.readyAt || null) === (p.revisedDate || null);
    if (check.ok && lineOk) return { ok: true };

    // Stale. Reconcile the decision so the owner gets a newer one, then make
    // sure this draft is withdrawn even if reconciliation could not run.
    const why = !line ? 'this order is no longer late because of the shipment.' : 'the promised or revised date in this update changed.';
    try {
      const { runDiscovery } = require('./discovery');
      await runDiscovery(pool, userId, { onBehalfOf: userId, correlationId: ctx.correlationId || null });
    } catch (err) {
      safeLog('warn', '[decisions] reconcile after stale notice failed', { userId, actionId, error: err.message });
    }
    await withdraw(pool, userId, action, decision, why, ctx);
    const newer = await newerDecisionFor(pool, userId, decision);
    return refusal(409, 'NOTICE_STALE', `This update is out of date: ${why} It was withdrawn and nothing was sent.${newer ? ' A newer decision has an updated draft that needs your approval.' : ''}`, { newerDecisionId: newer, checks: check.checks });
  } catch (err) {
    safeLog('error', '[decisions] notice freshness check failed', { userId, actionId, error: err.message });
    return refusal(503, 'NOTICE_CHECK_FAILED', 'Starlane could not confirm this update is still accurate, so nothing was approved or sent. Review it from its decision.');
  }
}

module.exports = { checkDelayNoticeCurrent };
