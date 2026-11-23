// FILE: lib/domain/decisions/store.js
// Persistence for decisions and their append-only event trail. Every query
// is scoped by user_id; no function here accepts a decision id without also
// taking the tenant's user id.

const { ENGINE_VERSION } = require('./definitions');

const AGENT = Object.freeze({ key: 'starlane.decision_engine', version: ENGINE_VERSION, model: 'deterministic (no LLM)' });
const crypto = require('crypto');
const OPEN_STATUSES = ['OPEN', 'NEEDS_INFORMATION'];
const ACTIVE_STATUSES = ['OPEN', 'NEEDS_INFORMATION', 'SELECTED', 'APPROVED', 'EXECUTING', 'SHADOWED', 'EXECUTED'];
// Chosen, approved or run: what was decided is never rewritten in place.
const CONTRACTED_STATUSES = ACTIVE_STATUSES.filter((s) => !OPEN_STATUSES.includes(s));
// Decision kinds whose chosen or run decisions are retired (superseded or
// resolved) when the facts they relied on change, instead of only being
// re-observed. Supplier delays drive customer-facing messages with concrete
// dates, so an outdated one must never stay current.
const RECONCILED_KINDS = new Set(['SUPPLIER_DELAY']);
// Customer-update drafts that have not left Starlane and can be withdrawn.
const WITHDRAWABLE_NOTICE = ['pending', 'approved'];
// Notices Starlane can no longer withdraw: marked done, being sent, or in an
// unknown send state. Starlane does not claim these reached the customer.
const NOT_WITHDRAWABLE_NOTICE = ['done', 'executing', 'execution_unknown'];

function agentActor(onBehalfOf) {
  return { type: 'agent', id: AGENT.key, onBehalfOf: onBehalfOf || null, agentKey: AGENT.key, agentVersion: AGENT.version, model: AGENT.model };
}

function humanActor(userId) {
  return { type: 'human', id: String(userId), onBehalfOf: null };
}

async function appendEvent(db, { userId, decisionId, type, actor, payload = {}, policy = null, correlationId = null }) {
  const res = await db.query(
    `INSERT INTO decision_events (user_id, decision_id, event_type, actor_type, actor_id, on_behalf_of, agent_key, agent_version, model, policy, payload, correlation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [userId, decisionId, type, actor.type, actor.id, actor.onBehalfOf || null, actor.agentKey || null, actor.agentVersion || null, actor.model || null,
      policy ? JSON.stringify(policy) : null, JSON.stringify(payload), correlationId]
  );
  return res.rows[0];
}

function impactOf(draft) {
  const m = draft.materiality || {};
  return Number(m.expectedUncollected90 ?? m.workingCapitalTiedUp ?? m.revenueExposure ?? 0);
}

function attentionScore(draft) {
  const impact = impactOf(draft);
  const urgency = Number(draft.urgency || 0);
  const conf = Number(draft.confidence?.score ?? 0.5);
  return Math.round(urgency * Math.log10(1 + impact) * (0.5 + conf / 2) * 1000) / 1000;
}

const COLUMNS = (draft, defs, asOfIso) => ({
  kind: draft.kind,
  title: draft.title,
  description: draft.description || null,
  currency: draft.currency || null,
  as_of: asOfIso,
  decision_window_start: draft.window?.usefulFrom || null,
  decision_deadline: draft.window?.latestSafeAt || null,
  decision_window: JSON.stringify(draft.window || {}),
  why_now: JSON.stringify(draft.whyNow || []),
  what_if_ignored: draft.whatIfIgnored || null,
  trigger_signals: JSON.stringify(draft.triggerSignals || []),
  affected_entities: JSON.stringify(draft.affectedEntities || []),
  affected_processes: draft.affectedProcesses || [],
  objectives: JSON.stringify(draft.objectives || []),
  constraints: JSON.stringify(draft.constraints || []),
  options: JSON.stringify(draft.options || []),
  do_nothing_option: draft.doNothingKey,
  evidence: JSON.stringify(draft.evidence || []),
  unknowns: JSON.stringify(draft.unknowns || []),
  assumptions: JSON.stringify(draft.assumptions || []),
  contradictions: JSON.stringify(draft.contradictions || []),
  expected_value: draft.expectedValue ?? null,
  downside_risk: draft.downsideRisk ?? null,
  upside_potential: draft.upsidePotential ?? null,
  reversibility: draft.reversibility || null,
  blast_radius: JSON.stringify(draft.blastRadius || null),
  urgency: draft.urgency ?? null,
  materiality: JSON.stringify(draft.materiality || null),
  confidence: JSON.stringify(draft.confidence || null),
  attention_score: attentionScore(draft),
  recommendation: JSON.stringify(draft.recommendation || null),
  approval_policy: JSON.stringify((draft.options || []).find((o) => o.key === draft.recommendation?.key)?.approval || null),
  analysis: JSON.stringify(draft.analysis || null),
  definitions: JSON.stringify(defs),
  model_versions: JSON.stringify(draft.modelVersions || {}),
});

async function upsertDraft(pool, userId, draft, { defs, asOfIso, onBehalfOf, correlationId }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existingRes = await client.query(
      `SELECT * FROM decisions WHERE user_id = $1 AND dedup_key = $2 AND status = ANY($3) FOR UPDATE`,
      [userId, draft.dedupKey, ACTIVE_STATUSES]
    );
    const existing = existingRes.rows[0];
    const cols = COLUMNS(draft, defs, asOfIso);
    let row;
    let outcome;
    if (!existing) {
      const names = Object.keys(cols);
      const values = Object.values(cols);
      const status = draft.recommendation?.informationFirst ? 'NEEDS_INFORMATION' : 'OPEN';
      const res = await client.query(
        `INSERT INTO decisions (user_id, dedup_key, status, created_by, ${names.join(', ')})
         VALUES ($1,$2,$3,$4, ${names.map((_, i) => `$${i + 5}`).join(', ')}) RETURNING *`,
        [userId, draft.dedupKey, status, AGENT.key, ...values]
      );
      row = res.rows[0];
      outcome = 'discovered';
      await appendEvent(client, {
        userId, decisionId: row.id, type: 'DISCOVERED', actor: agentActor(onBehalfOf), correlationId,
        payload: { title: row.title, triggers: (draft.triggerSignals || []).map((t) => t.code), expectedValue: draft.expectedValue, recommendation: draft.recommendation?.key, confidence: draft.confidence?.band, asOf: asOfIso },
      });
    } else if (OPEN_STATUSES.includes(existing.status)) {
      // A decision that replaced an earlier one keeps that link through revisions.
      const carried = existing.analysis?.reconciliation && draft.analysis && !draft.analysis.reconciliation
        ? COLUMNS({ ...draft, analysis: { ...draft.analysis, reconciliation: existing.analysis.reconciliation } }, defs, asOfIso)
        : cols;
      const sets = Object.keys(carried).map((k, i) => `${k} = $${i + 3}`);
      const res = await client.query(
        `UPDATE decisions SET ${sets.join(', ')}, revision = revision + 1, updated_at = NOW() WHERE id = $1 AND user_id = $2 RETURNING *`,
        [existing.id, userId, ...Object.values(carried)]
      );
      row = res.rows[0];
      outcome = 'revised';
      await appendEvent(client, {
        userId, decisionId: row.id, type: 'REVISED', actor: agentActor(onBehalfOf), correlationId,
        payload: {
          revision: row.revision,
          expectedValue: { before: existing.expected_value == null ? null : Number(existing.expected_value), after: draft.expectedValue },
          recommendation: { before: existing.recommendation?.key || null, after: draft.recommendation?.key || null },
          deadline: { before: existing.decision_deadline, after: draft.window?.latestSafeAt || null },
          exposure: { before: impactOf({ materiality: existing.materiality || {} }), after: impactOf(draft) },
        },
      });
    } else if (RECONCILED_KINDS.has(draft.kind) && factsChanged(existing, draft)) {
      // Chosen, approved or run on facts that no longer hold. Keep it as
      // history (SUPERSEDED, with what it said at the time), withdraw its
      // unsent drafts, and open a new decision on the current facts. The new
      // one needs its own selection and approval.
      const newId = crypto.randomUUID();
      const retired = await retireDecision(client, userId, existing, {
        status: 'SUPERSEDED',
        reason: 'The facts changed after this decision was chosen. It is kept as history; a newer decision shows the current position.',
        noticeReason: 'Withdrawn before sending: the delivery dates or orders behind this update changed. See the newer decision for an updated draft.',
        eventType: 'SUPERSEDED', onBehalfOf, correlationId, extra: { supersededBy: newId, exposureNow: impactOf(draft) },
      });
      const reconciliation = {
        supersedes: existing.id,
        supersededStatus: existing.status,
        supersededAt: new Date().toISOString(),
        previousExposure: impactOf({ materiality: existing.materiality || {} }),
        previousOrdersAtRisk: Number(existing.materiality?.ordersAtRisk ?? 0),
        previousTitle: existing.title,
        changes: delayChangesFor(existing, draft),
        notices: retired.notices,
      };
      const next = { ...draft, analysis: { ...(draft.analysis || {}), reconciliation } };
      const ncols = COLUMNS(next, defs, asOfIso);
      const names = Object.keys(ncols);
      const status = next.recommendation?.informationFirst ? 'NEEDS_INFORMATION' : 'OPEN';
      const res = await client.query(
        `INSERT INTO decisions (id, user_id, dedup_key, status, created_by, ${names.join(', ')})
         VALUES ($1,$2,$3,$4,$5, ${names.map((_, i) => `$${i + 6}`).join(', ')}) RETURNING *`,
        [newId, userId, next.dedupKey, status, AGENT.key, ...Object.values(ncols)]
      );
      row = res.rows[0];
      outcome = 'superseded';
      await appendEvent(client, {
        userId, decisionId: row.id, type: 'DISCOVERED', actor: agentActor(onBehalfOf), correlationId,
        payload: { title: row.title, supersedes: existing.id, exposureBefore: reconciliation.previousExposure, exposureNow: impactOf(next), triggers: (next.triggerSignals || []).map((t) => t.code), recommendation: next.recommendation?.key, asOf: asOfIso },
      });
    } else {
      // Under a contract: never rewrite what was decided. Record what the
      // world looks like now so the mission monitor can compare.
      row = existing;
      outcome = 'reobserved';
      const before = impactOf({ materiality: existing.materiality || {} });
      const after = impactOf(draft);
      const drift = before > 0 ? (after - before) / before : null;
      await appendEvent(client, {
        userId, decisionId: row.id, type: 'REOBSERVED', actor: agentActor(onBehalfOf), correlationId,
        payload: { impactBefore: before, impactNow: after, drift, recommendationNow: draft.recommendation?.key, replanSuggested: drift != null && Math.abs(drift) > 0.25 },
      });
    }
    await client.query('COMMIT');
    return { row, outcome };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function resolveVanished(pool, userId, kinds, liveKeys, { onBehalfOf, correlationId }) {
  // Open decisions of every evaluated kind; chosen or run decisions only for
  // kinds that are reconciled (their unsent drafts are withdrawn too).
  const reconciled = kinds.filter((k) => RECONCILED_KINDS.has(k));
  const res = await pool.query(
    `SELECT id, dedup_key, kind, status FROM decisions WHERE user_id = $1 AND kind = ANY($3)
       AND (status = ANY($2) OR (status = ANY($4) AND kind = ANY($5)))`,
    [userId, OPEN_STATUSES, kinds, CONTRACTED_STATUSES, reconciled]
  );
  const resolved = [];
  for (const d of res.rows) {
    if (liveKeys.has(d.dedup_key)) continue;
    if (RECONCILED_KINDS.has(d.kind)) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const cur = (await client.query(`SELECT * FROM decisions WHERE id = $1 AND user_id = $2 AND status = ANY($3) FOR UPDATE`, [d.id, userId, ACTIVE_STATUSES])).rows[0];
        if (cur) {
          const why = await delayResolution(client, userId, cur);
          await retireDecision(client, userId, cur, {
            status: 'RESOLVED', reason: why.reason,
            noticeReason: `Withdrawn before sending: ${why.notice}`,
            eventType: 'RESOLVED_BY_REALITY', onBehalfOf, correlationId, extra: { cause: why.cause },
          });
          resolved.push(d.id);
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
      continue;
    }
    const upd = await pool.query(
      `UPDATE decisions SET status = 'RESOLVED', resolution_reason = $3, resolved_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND user_id = $2 AND status = ANY($4) RETURNING id`,
      [d.id, userId, 'The condition behind this decision no longer holds (for example the invoices were paid or fell below materiality).', OPEN_STATUSES]
    );
    if (upd.rows.length) {
      resolved.push(d.id);
      await appendEvent(pool, { userId, decisionId: d.id, type: 'RESOLVED_BY_REALITY', actor: agentActor(onBehalfOf), correlationId, payload: { reason: 'condition no longer detected' } });
    }
  }
  return resolved;
}

function factsChanged(existing, draft) {
  const { delayFingerprint } = require('./detectors/supplierDelay');
  return delayFingerprint(existing.analysis?.supplierDelay) !== delayFingerprint(draft.analysis?.supplierDelay);
}

function delayChangesFor(existing, draft) {
  const { delayChanges } = require('./detectors/supplierDelay');
  return delayChanges(existing.analysis?.supplierDelay, draft.analysis?.supplierDelay);
}

// Why a supplier-delay decision no longer applies, from the purchase line.
async function delayResolution(db, userId, decision) {
  const lineId = decision.analysis?.supplierDelay?.purchaseLineItemId;
  const r = lineId && /^[0-9a-f-]{36}$/i.test(String(lineId))
    ? (await db.query(`SELECT quantity, received_quantity, expected_at, original_expected_at, line_status FROM purchase_line_items WHERE id = $1 AND user_id = $2`, [lineId, userId])).rows[0]
    : null;
  if (!r) return { cause: 'LINE_REMOVED', reason: 'The delayed purchase line is no longer on record, so this decision no longer applies. Review the orders it named manually.', notice: 'the purchase line behind this update is no longer on record.' };
  if (Number(r.received_quantity || 0) >= Number(r.quantity)) return { cause: 'RECEIVED', reason: 'The delayed shipment has been received in full. No order is late because of it any more.', notice: 'the delayed goods have been received in full.' };
  if (['closed', 'cancelled'].includes(String(r.line_status || '').toLowerCase())) return { cause: 'LINE_CLOSED', reason: `The delayed purchase line was marked ${String(r.line_status).toLowerCase()}. Review the orders it named manually.`, notice: 'the purchase line behind this update was closed.' };
  if (r.expected_at == null) return { cause: 'DATE_MISSING', reason: 'The delayed shipment no longer has an expected date, so Starlane cannot say which orders are late. Review the orders it named manually.', notice: 'the shipment no longer has an expected date, so the revised date in this update cannot be confirmed.' };
  if (r.original_expected_at == null || new Date(r.expected_at) <= new Date(r.original_expected_at)) return { cause: 'RECOVERED', reason: 'The supplier is back on (or ahead of) the original date. No order is late because of this shipment any more.', notice: 'the supplier is back on the original date.' };
  return { cause: 'NO_ORDER_AT_RISK', reason: 'No promised order is late because of this shipment any more (stock or other deliveries now cover them).', notice: 'no order is late because of this shipment any more.' };
}

/**
 * Takes a decision out of the current set (SUPERSEDED or RESOLVED) inside
 * the caller's transaction. Keeps the row and its analysis as history,
 * retires its contracts, and withdraws customer-update drafts that have not
 * left Starlane. Never touches a notice that is done or being sent: a sent
 * message cannot be recalled, and the event records how many there were.
 */
async function retireDecision(db, userId, decision, { status, reason, noticeReason, eventType, onBehalfOf, correlationId, extra = {} }) {
  await db.query(
    `UPDATE decisions SET status = $3, resolution_reason = $4, resolved_at = NOW(), updated_at = NOW() WHERE id = $1 AND user_id = $2`,
    [decision.id, userId, status, reason]
  );
  await db.query(
    `UPDATE decision_contracts SET status = 'SUPERSEDED', updated_at = NOW()
     WHERE decision_id = $1 AND user_id = $2 AND status IN ('DRAFT','ACTIVE','ON_TRACK','OFF_TRACK','UNKNOWN')`,
    [decision.id, userId]
  );
  const withdrawn = await db.query(
    `UPDATE ai_actions SET status = 'expired', block_reason = $3, updated_at = NOW()
     WHERE user_id = $1 AND decision_id = $2 AND action_type = 'COMMITMENT_DELAY_NOTICE' AND status = ANY($4) RETURNING id, status`,
    [userId, decision.id, noticeReason, WITHDRAWABLE_NOTICE]
  );
  const out = await db.query(
    `SELECT id, status FROM ai_actions WHERE user_id = $1 AND decision_id = $2 AND action_type = 'COMMITMENT_DELAY_NOTICE' AND status = ANY($3)`,
    [userId, decision.id, NOT_WITHDRAWABLE_NOTICE]
  );
  const notices = { withdrawn: withdrawn.rows.length, withdrawnIds: withdrawn.rows.map((r) => r.id), cannotWithdraw: out.rows.length, cannotWithdrawIds: out.rows.map((r) => r.id) };
  const event = await appendEvent(db, {
    userId, decisionId: decision.id, type: eventType, actor: agentActor(onBehalfOf), correlationId,
    payload: {
      reason, fromStatus: decision.status,
      exposureAtDecision: impactOf({ materiality: decision.materiality || {} }),
      ordersAtRiskAtDecision: Number(decision.materiality?.ordersAtRisk ?? 0),
      notices, ...extra,
    },
  });
  return { notices, event };
}

async function getDecision(pool, userId, id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) return null;
  const res = await pool.query('SELECT * FROM decisions WHERE id = $1 AND user_id = $2', [id, userId]);
  return res.rows[0] || null;
}

async function listDecisions(pool, userId, { statuses, limit = 50 } = {}) {
  const res = await pool.query(
    `SELECT id, kind, title, description, status, currency, decision_deadline, decision_window, why_now, expected_value,
            urgency, materiality, confidence, attention_score, recommendation, selected_option, collisions, discovered_at, updated_at, revision
     FROM decisions WHERE user_id = $1 AND ($2::text[] IS NULL OR status = ANY($2))
     ORDER BY attention_score DESC NULLS LAST, updated_at DESC LIMIT $3`,
    [userId, statuses || null, Math.min(Number(limit) || 50, 200)]
  );
  return res.rows;
}

async function listEvents(pool, userId, decisionId) {
  const res = await pool.query('SELECT * FROM decision_events WHERE user_id = $1 AND decision_id = $2 ORDER BY created_at ASC', [userId, decisionId]);
  return res.rows;
}

// Pure: overlapping entities and competing claims on cash between open decisions.
function computeCollisions(decisions) {
  const out = new Map(decisions.map((d) => [d.id, []]));
  const entityKey = (e) => (e.type === 'customer' ? `customer:${e.key || e.name}` : e.id ? `${e.type}:${e.id}` : null);
  for (let i = 0; i < decisions.length; i++) {
    for (let j = i + 1; j < decisions.length; j++) {
      const a = decisions[i];
      const b = decisions[j];
      const ka = new Set((a.affected_entities || []).map(entityKey).filter(Boolean));
      const shared = (b.affected_entities || []).map(entityKey).filter((k) => k && ka.has(k));
      if (shared.length) {
        const note = { type: 'SAME_ENTITY', with: null, entities: [...new Set(shared)].slice(0, 5), detail: 'Both decisions act on the same customer or record. Decide them together so actions do not conflict.' };
        out.get(a.id).push({ ...note, with: b.id, withTitle: b.title });
        out.get(b.id).push({ ...note, with: a.id, withTitle: a.title });
      }
      const spends = (d) => d.kind === 'SUPPLY_STOCKOUT';
      const cashShort = (d) => d.kind === 'RECEIVABLE_RISK' || d.kind === 'PROCESS_DEGRADATION';
      if ((spends(a) && cashShort(b)) || (spends(b) && cashShort(a))) {
        const note = { type: 'CASH_CONTENTION', detail: 'One decision spends cash while another is about cash that may not arrive. Check both against the same cash position.' };
        out.get(a.id).push({ ...note, with: b.id, withTitle: b.title });
        out.get(b.id).push({ ...note, with: a.id, withTitle: a.title });
      }
    }
  }
  return out;
}

module.exports = { AGENT, OPEN_STATUSES, ACTIVE_STATUSES, CONTRACTED_STATUSES, RECONCILED_KINDS, WITHDRAWABLE_NOTICE, NOT_WITHDRAWABLE_NOTICE, retireDecision, factsChanged, agentActor, humanActor, appendEvent, upsertDraft, resolveVanished, getDecision, listDecisions, listEvents, computeCollisions, attentionScore };
