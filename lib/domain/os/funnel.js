// FILE: lib/domain/os/funnel.js
// Product funnel and value metrics for one tenant (directive §131–133),
// read from rows the product already writes. No separate analytics store,
// no vanity counts: each step is the first time the tenant did something
// that indicates value, with the row that proves it.
//
//   connected -> scanned -> finding surfaced -> decision opened ->
//   evidence inspected -> simulation run -> approved -> mission created ->
//   action executed -> outcome verified
//
// A step with no row is null ("not yet"), never estimated.

const STEPS = [
  { key: 'connected', label: 'Connected data' },
  { key: 'scanned', label: 'Scanned' },
  { key: 'findingSurfaced', label: 'First finding surfaced' },
  { key: 'decisionOpened', label: 'Opened a decision' },
  { key: 'evidenceInspected', label: 'Inspected evidence' },
  { key: 'simulationRun', label: 'Ran a what-if' },
  { key: 'approved', label: 'Approved something' },
  { key: 'missionCreated', label: 'Started a mission' },
  { key: 'actionExecuted', label: 'An action ran (shadow or live)' },
  { key: 'outcomeVerified', label: 'An outcome was verified' },
];

async function funnel(pool, userId) {
  const first = (sql) => pool.query(sql, [userId]).then((r) => r.rows[0]?.at || null).catch(() => null);
  const firstEvent = (types) => first(`SELECT MIN(created_at) AS at FROM decision_events WHERE user_id = $1 AND event_type IN (${types.map((t) => `'${t}'`).join(',')})`);
  const [connected, connectedSource, scanned, findingSurfaced, decisionOpened, evidenceInspected, simulationRun, approvedDecision, approvedItem, missionFromDecision, missionFromWorkflow, executedDecision, executedItem, verifiedContract, verifiedItem] = await Promise.all([
    first(`SELECT MIN(created_at) AS at FROM file_import_batches WHERE user_id = $1 AND status IN ('COMPLETED','completed')`),
    first(`SELECT MIN(created_at) AS at FROM data_connections WHERE user_id = $1`),
    first(`SELECT MIN(started_at) AS at FROM agent_runs WHERE user_id = $1 AND agent_key = 'starlane.scan'`),
    first('SELECT MIN(discovered_at) AS at FROM decisions WHERE user_id = $1'),
    firstEvent(['DECISION_OPENED']),
    firstEvent(['EVIDENCE_VIEWED']),
    firstEvent(['SIMULATION_RUN']),
    firstEvent(['APPROVED']),
    first(`SELECT MIN(acted_at) AS at FROM starlane_workflow_items WHERE user_id = $1 AND status IN ('SHADOWED','PREPARED_MANUAL') AND approval IS NOT NULL`),
    firstEvent(['OPTION_SELECTED']),
    first(`SELECT MIN(deployed_at) AS at FROM starlane_workflows WHERE user_id = $1 AND deployed_at IS NOT NULL`),
    firstEvent(['SHADOW_RECORDED', 'EXECUTION_SUCCEEDED', 'EXECUTION_STARTED']),
    first(`SELECT MIN(acted_at) AS at FROM starlane_workflow_items WHERE user_id = $1 AND status IN ('SHADOWED','PREPARED_MANUAL')`),
    first(`SELECT MIN(verified_at) AS at FROM decision_contracts WHERE user_id = $1 AND status IN ('MET','NOT_MET')`),
    first(`SELECT MIN(verified_at) AS at FROM starlane_workflow_items WHERE user_id = $1 AND outcome_status IN ('MET','NOT_MET')`),
  ]);
  const min = (...xs) => xs.filter(Boolean).map((x) => new Date(x)).sort((a, b) => a - b)[0] || null;
  const at = {
    connected: min(connected, connectedSource),
    scanned,
    findingSurfaced,
    decisionOpened,
    evidenceInspected,
    simulationRun,
    approved: min(approvedDecision, approvedItem),
    missionCreated: min(missionFromDecision, missionFromWorkflow),
    actionExecuted: min(executedDecision, executedItem),
    outcomeVerified: min(verifiedContract, verifiedItem),
  };
  const steps = STEPS.map((s) => ({ ...s, at: at[s.key] ? new Date(at[s.key]).toISOString() : null }));
  const minutesBetween = (a, b) => (a && b ? Math.round((new Date(b) - new Date(a)) / 60000) : null);

  // Human judgement on what Starlane surfaced.
  const fb = await pool.query(
    `SELECT payload->>'kind' AS kind, COUNT(*)::int AS n FROM decision_events WHERE user_id = $1 AND event_type = 'HUMAN_FEEDBACK' GROUP BY 1`,
    [userId]
  ).then((r) => Object.fromEntries(r.rows.map((x) => [x.kind, x.n]))).catch(() => ({}));
  const feedbackTotal = Object.values(fb).reduce((a, b) => a + b, 0);
  const counts = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM decisions WHERE user_id = $1) AS discovered,
       (SELECT COUNT(DISTINCT decision_id)::int FROM decision_events WHERE user_id = $1 AND event_type = 'APPROVED') AS approved,
       (SELECT COUNT(*)::int FROM decision_contracts WHERE user_id = $1 AND status IN ('MET','NOT_MET')) AS verified_contracts,
       (SELECT COUNT(*)::int FROM starlane_workflow_items WHERE user_id = $1 AND outcome_status IN ('MET','NOT_MET')) AS verified_items,
       (SELECT COUNT(*)::int FROM starlane_workflow_items WHERE user_id = $1) AS actions_prepared,
       (SELECT COUNT(DISTINCT date_trunc('day', created_at))::int FROM decision_events WHERE user_id = $1 AND actor_type = 'human' AND created_at > NOW() - INTERVAL '28 days') AS active_days_28`,
    [userId]
  ).then((r) => r.rows[0]).catch(() => ({}));

  return {
    steps,
    reached: steps.filter((s) => s.at).length,
    metrics: {
      minutesToFirstFinding: minutesBetween(at.connected, at.findingSurfaced),
      minutesToFirstDecisionOpened: minutesBetween(at.connected, at.decisionOpened),
      decisionsDiscovered: counts.discovered ?? null,
      decisionsApproved: counts.approved ?? null,
      humanAcceptance: counts.discovered ? Math.round((counts.approved / counts.discovered) * 100) / 100 : null,
      // Of the decisions people gave feedback on, the share they called wrong
      // or not important. Null until someone has given feedback.
      falsePositiveRate: feedbackTotal ? Math.round((((fb.WRONG || 0) + (fb.NOT_IMPORTANT || 0)) / feedbackTotal) * 100) / 100 : null,
      feedback: fb,
      actionsPrepared: counts.actions_prepared ?? null,
      outcomesVerified: (counts.verified_contracts || 0) + (counts.verified_items || 0),
      activeDaysLast28: counts.active_days_28 ?? null,
    },
  };
}

module.exports = { funnel, STEPS };
