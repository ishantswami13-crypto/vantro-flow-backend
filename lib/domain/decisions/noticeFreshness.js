// FILE: lib/domain/decisions/noticeFreshness.js
// Last check before a decision-prepared customer message is approved or
// sent. Each message type a decision can prepare registers one checker in
// DRAFT_CHECKERS below; the shared part (load the draft, find its decision,
// withdraw it with a reason, record the event, refuse with 409, fail closed
// with 503) is the same for every workflow.
//
//   COMMITMENT_DELAY_NOTICE  supplier-delay update to a customer. The dates
//                            it quotes must still be what Starlane calculates
//                            now; if not, the decision is reconciled so the
//                            owner sees a newer one with a fresh draft.
//   SEND_FIRM_REMINDER       payment reminder prepared by a receivables
//                            decision. Every invoice it names must still be
//                            unpaid, undisputed and owe exactly the amount the
//                            message quotes, and escalation must not be paused
//                            for the customer.
//
// If a check cannot run, nothing is approved or sent (503): blocking is the
// safe failure. Every query is scoped by user_id. Action types without a
// checker, and reminders not prepared by a decision, pass through unchanged.

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
      payload: { aiActionId: action.id, actionType: action.action_type, stage: ctx.stage || null, reason: why, withdrawn: upd.rows.length === 1 },
    }).catch((err) => safeLog('warn', '[decisions] notice block event failed', { userId, error: err.message }));
  }
}

async function checkCommitmentNotice(pool, userId, action, ctx) {
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

const RETIRED_DECISION = ['RESOLVED', 'SUPERSEDED', 'REJECTED', 'EXPIRED'];
const round2 = (n) => Math.round(Number(n) * 100) / 100;

/**
 * Pure: is a decision-prepared payment reminder still true to the ledger?
 * `quoted` is what the decision recorded per invoice when the message was
 * written; `current` is the same invoice derived now by the snapshot (the
 * arithmetic the decision itself used). Returns the first reason it is not.
 */
function reminderStaleReason(quoted, current, { escalationPaused = false } = {}) {
  if (escalationPaused) return 'you paused escalation for this customer.';
  if (!quoted.length) return 'it names no invoice Starlane can check.';
  for (const q of quoted) {
    const label = q.number || String(q.id).slice(0, 8);
    const now = current.get(String(q.id));
    if (!now) return `invoice ${label} is no longer on record.`;
    if (now.status === 'paid' || now.outstanding <= 0) return `invoice ${label} has been paid.`;
    if (now.disputeOpen) return `invoice ${label} is now disputed.`;
    if (round2(now.outstanding) !== round2(q.outstanding)) return `the amount owed on invoice ${label} changed since this reminder was written.`;
  }
  return null;
}

async function checkCollectionReminder(pool, userId, action, ctx) {
  if (!action.decision_id) return { ok: true }; // not prepared by a decision
  try {
    const { getDecision } = require('./store');
    const decision = await getDecision(pool, userId, action.decision_id);
    if (!decision) {
      await withdraw(pool, userId, action, null, 'the decision behind this reminder is not on record.', ctx);
      return refusal(409, 'NOTICE_STALE', 'This reminder is not linked to a current decision, so it was withdrawn. Nothing was sent.');
    }
    if (RETIRED_DECISION.includes(decision.status)) {
      await withdraw(pool, userId, action, decision, `its decision is ${decision.status.toLowerCase()}${decision.resolution_reason ? ` (${decision.resolution_reason})` : ''}`, ctx);
      return refusal(409, 'NOTICE_STALE', `The decision behind this reminder is no longer current (${decision.resolution_reason || decision.status}). It was withdrawn and nothing was sent.`);
    }

    const entities = Array.isArray(decision.affected_entities) ? decision.affected_entities : [];
    const named = new Set(((action.parameters || {}).invoices || []).map(String));
    const quoted = entities.filter((e) => e.type === 'invoice' && (named.size === 0 || named.has(String(e.id))));
    const customer = entities.find((e) => e.type === 'customer');

    const { loadRawReceivables } = require('./discovery');
    const { deriveReceivablesState } = require('./snapshot');
    const { getSettings } = require('./controls');
    const settings = await getSettings(pool, userId);
    const raw = await loadRawReceivables(pool, userId);
    const state = deriveReceivablesState(raw, new Date().toISOString(), { mode: 'live', baseCurrency: settings.definitions.base_currency });
    const current = new Map(state.invoices.map((i) => [i.id, i]));
    const paused = customer?.id ? !!raw.customers.find((c) => String(c.id) === String(customer.id))?.escalation_paused : false;

    const why = reminderStaleReason(quoted, current, { escalationPaused: paused });
    if (!why) return { ok: true };
    await withdraw(pool, userId, action, decision, why, ctx);
    return refusal(409, 'NOTICE_STALE', `This reminder is out of date: ${why} It was withdrawn and nothing was sent. Run discovery again for a decision on the current position.`);
  } catch (err) {
    safeLog('error', '[decisions] reminder freshness check failed', { userId, actionId: action.id, error: err.message });
    return refusal(503, 'NOTICE_CHECK_FAILED', 'Starlane could not confirm this reminder is still accurate, so nothing was approved or sent. Review it from its decision.');
  }
}

// One checker per message type a decision can prepare. Adding a workflow's
// message here is all it takes to put it behind the same approve/send gate.
const DRAFT_CHECKERS = Object.freeze({
  [NOTICE]: checkCommitmentNotice,
  SEND_FIRM_REMINDER: checkCollectionReminder,
});

/**
 * @param {import('pg').Pool} pool
 * @param {string} userId  tenant from the verified session, never the body
 * @param {string} actionId
 * @param {{ stage?: string, correlationId?: string }} ctx
 * @returns {Promise<{ok: true} | {ok: false, status: number, code: string, error: string, newerDecisionId?: string|null}>}
 */
async function checkDraftCurrent(pool, userId, actionId, ctx = {}) {
  let action;
  try {
    const r = await pool.query(`SELECT id, action_type, status, decision_id, parameters FROM ai_actions WHERE id = $1 AND user_id = $2`, [actionId, userId]);
    action = r.rows[0];
  } catch (err) {
    safeLog('error', '[decisions] draft freshness lookup failed', { userId, actionId, error: err.message });
    return refusal(503, 'NOTICE_CHECK_FAILED', 'Starlane could not check this update, so nothing was approved or sent. Try again, or review it from its decision.');
  }
  const checker = action && DRAFT_CHECKERS[action.action_type];
  if (!checker) return { ok: true };
  return checker(pool, userId, action, ctx);
}

module.exports = { checkDraftCurrent, checkDelayNoticeCurrent: checkDraftCurrent, reminderStaleReason, DRAFT_CHECKERS };
