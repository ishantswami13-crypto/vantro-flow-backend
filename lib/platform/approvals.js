'use strict';
// Organization-wide approvals for agent actions.
//
// A decision is enforced here, in one transaction: the request row is locked,
// the decider's role is checked against the request's approver role, the
// decision and its audit row are written, and the paused execution is put
// back on the queue. The engine then executes exactly the arguments the
// approver saw (approved) or tells the agent the action was refused.
//
// Legacy finance approvals (ai_actions, workflow email drafts, decisions)
// keep their own screens; summary() counts them so one inbox shows
// everything waiting, with links to where each is decided.

const audit = require('./audit');
const { atLeast } = require('./roles');
const agents = require('./agents');
const { badRequest, forbidden, notFound, conflict, assertUuid } = require('./errors');

const VISIBLE = `(a.owner_user_id = $2 OR r.requested_by = $2 OR $3::boolean OR a.visibility = 'organization'
  OR (a.visibility = 'team' AND a.team_id = ANY($4::uuid[])))`;

function shape(r, org) {
  return {
    id: r.id, executionId: r.execution_id, agentId: r.agent_id, agentName: r.agent_name, tool: r.tool, toolName: r.tool,
    summary: r.summary, arguments: r.arguments, risk: r.risk, evidence: r.evidence, approverRole: r.approver_role,
    status: r.status, requestedBy: r.requested_by, requestedByEmail: r.requested_by_email, decidedBy: r.decided_by,
    decidedByEmail: r.decided_by_email, decidedAt: r.decided_at, decisionNote: r.decision_note, createdAt: r.created_at,
    executionStatus: r.execution_status, executionMode: r.execution_mode, executionInput: r.execution_input,
    canDecide: r.status === 'pending' && atLeast(org.role, r.approver_role),
  };
}

const SELECT = `SELECT r.*, a.name AS agent_name, e.status AS execution_status, e.mode AS execution_mode, e.input AS execution_input,
       ru.email AS requested_by_email, du.email AS decided_by_email
  FROM platform_approval_requests r
  JOIN platform_agents a ON a.id = r.agent_id AND a.organization_id = r.organization_id
  JOIN platform_agent_executions e ON e.id = r.execution_id
  LEFT JOIN users ru ON ru.id = r.requested_by
  LEFT JOIN users du ON du.id = r.decided_by`;

async function params(db, org, userId) {
  if (!atLeast(org.role, 'member')) throw forbidden('Viewers cannot see approvals.');
  return [org.id, userId, atLeast(org.role, 'admin'), await agents.myTeams(db, org.id, userId)];
}

async function list(db, org, userId, { status = 'pending', cursor = null, limit = 50 } = {}) {
  const p = await params(db, org, userId);
  let where = `r.organization_id = $1 AND ${VISIBLE}`;
  if (status && status !== 'all') {
    if (!['pending', 'approved', 'rejected', 'cancelled'].includes(status)) throw badRequest('Unknown status');
    p.push(status); where += ` AND r.status = $${p.length}`;
  }
  if (cursor) {
    const [ts, id] = String(cursor).split('|');
    if (!ts || Number.isNaN(Date.parse(ts))) throw badRequest('Invalid cursor');
    assertUuid(id, 'cursor');
    p.push(ts, id); where += ` AND (r.created_at, r.id) < ($${p.length - 1}::timestamptz, $${p.length}::uuid)`;
  }
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 100);
  p.push(lim + 1);
  const { rows } = await db.query(`${SELECT} WHERE ${where} ORDER BY r.created_at DESC, r.id DESC LIMIT $${p.length}`, p);
  const more = rows.length > lim;
  const page = rows.slice(0, lim);
  const last = page[page.length - 1];
  return { approvals: page.map((r) => shape(r, org)), nextCursor: more ? `${new Date(last.created_at).toISOString()}|${last.id}` : null };
}

async function get(db, org, userId, id) {
  assertUuid(id, 'approvalId');
  const p = await params(db, org, userId);
  p.push(id);
  const { rows } = await db.query(`${SELECT} WHERE r.organization_id = $1 AND ${VISIBLE} AND r.id = $5`, p);
  if (!rows[0]) throw notFound('That approval');
  const history = await audit.list(db, org.id, { resourceType: 'approval', resourceId: id, limit: 20 });
  return { ...shape(rows[0], org), history: history.events };
}

async function decide(db, org, userId, id, { decision, note = null }) {
  if (!['approve', 'reject'].includes(decision)) throw badRequest('decision must be approve or reject');
  if (note != null && (typeof note !== 'string' || note.length > 1000)) throw badRequest('note must be text up to 1000 characters');
  await get(db, org, userId, id); // visibility (404 when not visible)
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM platform_approval_requests WHERE organization_id = $1 AND id = $2 FOR UPDATE', [org.id, id]);
    const r = rows[0];
    if (!r) throw notFound('That approval');
    if (r.status !== 'pending') throw conflict(`This request was already ${r.status}.`, 'ALREADY_DECIDED');
    if (!atLeast(org.role, r.approver_role)) throw forbidden(`This needs approval from a ${r.approver_role} or above.`);
    const status = decision === 'approve' ? 'approved' : 'rejected';
    await client.query(
      `UPDATE platform_approval_requests SET status = $3, decided_by = $4, decided_at = NOW(), decision_note = $5 WHERE organization_id = $1 AND id = $2`,
      [org.id, id, status, userId, note ? note.trim() : null],
    );
    await client.query(
      `UPDATE platform_execution_steps SET status = $3, output = $4, updated_at = NOW() WHERE execution_id = $1 AND step_key = $2`,
      [r.execution_id, `approval:${r.step_key}`, status === 'approved' ? 'completed' : 'blocked', JSON.stringify({ decision: status, by: userId, note: note || null })],
    );
    const resumed = await client.query(
      `UPDATE platform_agent_executions SET status = 'queued', run_after = NOW(), updated_at = NOW()
        WHERE id = $1 AND organization_id = $2 AND status = 'awaiting_approval' RETURNING id`,
      [r.execution_id, org.id],
    );
    await audit.record(client, { organizationId: org.id, actorUserId: userId, action: `approval.${status}`, resourceType: 'approval', resourceId: id, detail: { executionId: r.execution_id, tool: r.tool, note: note || null } });
    await client.query('COMMIT');
    return { status, executionResumed: resumed.rowCount > 0 };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Counts across every approval queue in Starlane, with where to decide each. */
async function summary(db, org, userId) {
  const p = await params(db, org, userId);
  const agentPending = await db.query(`SELECT COUNT(*)::int AS n FROM platform_approval_requests r JOIN platform_agents a ON a.id = r.agent_id WHERE r.organization_id = $1 AND r.status = 'pending' AND ${VISIBLE}`, p);
  const queues = [{ key: 'agents', label: 'Agent actions', pending: agentPending.rows[0].n, href: '/approvals' }];
  // Finance queues belong to the organization owner's account (legacy tenant key).
  if (userId === org.ownerUserId) {
    const count = (sql) => db.query(sql, [userId]).then((r) => r.rows[0].n).catch(() => null);
    const [actions, drafts] = await Promise.all([
      count(`SELECT COUNT(*)::int AS n FROM ai_actions WHERE user_id = $1 AND status = 'pending'`),
      count(`SELECT COUNT(*)::int AS n FROM starlane_workflow_approvals WHERE user_id = $1 AND status = 'PENDING'`),
    ]);
    if (actions != null) queues.push({ key: 'finance_actions', label: 'Finance actions', pending: actions, href: '/control/approvals' });
    if (drafts != null) queues.push({ key: 'workflow_drafts', label: 'Workflow email drafts', pending: drafts, href: '/workflows' });
  }
  return { queues, total: queues.reduce((s, q) => s + (q.pending || 0), 0) };
}

module.exports = { list, get, decide, summary };
