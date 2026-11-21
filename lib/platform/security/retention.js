'use strict';
// Data retention: how long operational data is kept before it is removed.
//
// Data classes and what "removed" means for each:
//   connectorCallsDays   rows in platform_connector_calls are deleted
//   webhookEventsDays    rows in starlane_connection_events (webhook and
//                        mailbox payloads) for the organization's owner are
//                        deleted
//   executionTraceDays   for agent runs that finished that long ago, the
//                        input and output of each step (tool arguments and
//                        results) are replaced with a retention marker; the
//                        run, its status and its approvals stay
// Audit events are not removed by this job. They are kept for the life of
// the organization (minimum one year is what SOC 2 / ISO 27001 auditors
// usually expect) and only go when the organization is erased.

const audit = require('../audit');
const { badRequest } = require('../errors');

const CLASSES = {
  connectorCallsDays: { label: 'Connector call log', min: 30, max: 3650, default: 90 },
  webhookEventsDays: { label: 'Incoming webhook and mailbox payloads', min: 7, max: 3650, default: 90 },
  executionTraceDays: { label: 'Agent run step inputs and outputs', min: 30, max: 3650, default: 180 },
};

function defaults() {
  return Object.fromEntries(Object.entries(CLASSES).map(([k, v]) => [k, v.default]));
}

async function getPolicy(db, orgId) {
  const { rows } = await db.query('SELECT policy, updated_at FROM platform_retention_policies WHERE organization_id = $1', [orgId]);
  return { ...defaults(), ...(rows[0]?.policy || {}), updatedAt: rows[0]?.updated_at || null, configured: !!rows[0] };
}

async function setPolicy(db, org, userId, input = {}) {
  const current = await getPolicy(db, org.id);
  const next = {};
  for (const [k, spec] of Object.entries(CLASSES)) {
    const v = k in input ? Number(input[k]) : current[k];
    if (!Number.isInteger(v) || v < spec.min || v > spec.max) throw badRequest(`${spec.label}: keep between ${spec.min} and ${spec.max} days.`);
    next[k] = v;
  }
  await db.query(
    `INSERT INTO platform_retention_policies (organization_id, policy, updated_by, updated_at) VALUES ($1,$2,$3,NOW())
     ON CONFLICT (organization_id) DO UPDATE SET policy = EXCLUDED.policy, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [org.id, JSON.stringify(next), userId],
  );
  await audit.recordSoft(db, { organizationId: org.id, actorUserId: userId, action: 'retention.policy_updated', resourceType: 'retention', detail: next });
  return getPolicy(db, org.id);
}

/** Applies one organization's policy. Returns counts per data class. */
async function applyForOrganization(db, org, { now = new Date(), actorUserId = null } = {}) {
  const p = await getPolicy(db, org.id);
  const cutoff = (days) => new Date(now.getTime() - days * 86400000);
  const counts = {};
  counts.connectorCalls = (await db.query('DELETE FROM platform_connector_calls WHERE organization_id = $1 AND created_at < $2', [org.id, cutoff(p.connectorCallsDays)])).rowCount;
  counts.webhookEvents = (await db.query('DELETE FROM starlane_connection_events WHERE user_id = $1 AND received_at < $2', [org.ownerUserId, cutoff(p.webhookEventsDays)]).catch(() => ({ rowCount: 0 }))).rowCount;
  counts.executionSteps = (await db.query(
    `UPDATE platform_execution_steps s SET input = '{"removed":"retention"}'::jsonb, output = '{"removed":"retention"}'::jsonb, updated_at = NOW()
       FROM platform_agent_executions e
      WHERE s.organization_id = $1 AND e.organization_id = s.organization_id AND e.id = s.execution_id
        AND e.finished_at IS NOT NULL AND e.finished_at < $2
        AND (s.input IS DISTINCT FROM '{"removed":"retention"}'::jsonb OR s.output IS DISTINCT FROM '{"removed":"retention"}'::jsonb)`,
    [org.id, cutoff(p.executionTraceDays)],
  )).rowCount;
  if (Object.values(counts).some((n) => n > 0) || actorUserId) {
    await audit.recordSoft(db, { organizationId: org.id, actorUserId, actorKind: actorUserId ? 'user' : 'system', action: 'retention.applied', resourceType: 'retention', detail: { policy: { connectorCallsDays: p.connectorCallsDays, webhookEventsDays: p.webhookEventsDays, executionTraceDays: p.executionTraceDays }, removed: counts } });
  }
  return { policy: p, removed: counts, ranAt: now.toISOString() };
}

/** The daily job: every organization, then expired OAuth states. */
async function runAll(pool, { now = new Date() } = {}) {
  const { rows } = await pool.query('SELECT id, owner_user_id FROM organizations');
  let orgs = 0;
  for (const o of rows) {
    try { await applyForOrganization(pool, { id: o.id, ownerUserId: o.owner_user_id }, { now }); orgs += 1; } catch { /* next organization */ }
  }
  const states = await pool.query('DELETE FROM platform_oauth_states WHERE expires_at < $1', [now]).catch(() => ({ rowCount: 0 }));
  return { organizations: orgs, oauthStatesRemoved: states.rowCount };
}

module.exports = { CLASSES, defaults, getPolicy, setPolicy, applyForOrganization, runAll };
