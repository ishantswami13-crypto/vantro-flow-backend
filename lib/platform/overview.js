'use strict';
// Read models for Command Center, Usage and Connections. Every number comes
// from stored rows; anything Starlane does not measure is returned as
// { available: false, reason } so the UI shows "not measured", never a guess.

const { atLeast } = require('./roles');
const agents = require('./agents');
const { getPolicy } = require('./organization');
const { flagOn } = require('./tools');
const { costOf } = require('./cost');

/** Tokens per model over a window, plus tokens recorded without a model (runs from before per-model tracking). */
const MODEL_USAGE_SQL = (where) => `
  WITH runs AS (SELECT e.* FROM platform_agent_executions e JOIN platform_agents a ON a.id = e.agent_id WHERE ${where})
  SELECT u.key AS model, SUM(COALESCE((u.value->>'calls')::bigint, 0))::bigint AS calls,
         SUM(COALESCE((u.value->>'input')::bigint, 0))::bigint AS input, SUM(COALESCE((u.value->>'output')::bigint, 0))::bigint AS output, NULL::bigint AS untracked
    FROM runs, jsonb_each(CASE WHEN jsonb_typeof(runs.state->'usage') = 'object' THEN runs.state->'usage' ELSE '{}'::jsonb END) u GROUP BY u.key
  UNION ALL
  SELECT NULL, NULL, NULL, NULL, COALESCE(SUM(input_tokens + output_tokens), 0)::bigint FROM runs
   WHERE jsonb_typeof(state->'usage') IS DISTINCT FROM 'object' OR state->'usage' = '{}'::jsonb`;

function modelCost(rows, prices) {
  const usage = {};
  let untracked = 0;
  for (const r of rows) {
    if (r.model == null) untracked += Number(r.untracked) || 0;
    else usage[r.model] = { calls: Number(r.calls), input: Number(r.input), output: Number(r.output) };
  }
  return costOf(usage, prices, { untrackedTokens: untracked });
}

async function vis(db, org, userId) {
  return [org.id, userId, atLeast(org.role, 'admin'), await agents.myTeams(db, org.id, userId)];
}
const VISIBLE = `(a.owner_user_id = $2 OR e.requested_by = $2 OR $3::boolean OR a.visibility = 'organization'
  OR (a.visibility = 'team' AND a.team_id = ANY($4::uuid[])))`;

async function commandCenter(db, org, userId, { router = null } = {}) {
  const p = await vis(db, org, userId);
  const [agentCounts, live, week, byTrigger, failures, recent, approvals, oldApprovals, scheduled, conns, health, models, policy] = await Promise.all([
    db.query(`SELECT status, COUNT(*)::int AS n FROM platform_agents a WHERE a.organization_id = $1
                AND (a.owner_user_id = $2 OR $3::boolean OR a.visibility = 'organization' OR (a.visibility = 'team' AND a.team_id = ANY($4::uuid[])))
              GROUP BY status`, p),
    db.query(`SELECT e.status, COUNT(*)::int AS n FROM platform_agent_executions e JOIN platform_agents a ON a.id = e.agent_id
               WHERE e.organization_id = $1 AND ${VISIBLE} AND e.status IN ('queued','running','awaiting_approval') GROUP BY e.status`, p),
    db.query(`SELECT COUNT(*) FILTER (WHERE e.status = 'completed')::int AS completed,
                     COUNT(*) FILTER (WHERE e.status = 'failed')::int AS failed,
                     COUNT(*) FILTER (WHERE e.status = 'cancelled')::int AS cancelled,
                     COUNT(*) FILTER (WHERE e.status = 'completed' AND e.mode = 'live')::int AS live_completed,
                     COUNT(*) FILTER (WHERE e.status = 'failed' AND e.mode = 'live')::int AS live_failed,
                     COUNT(*) FILTER (WHERE e.created_at >= NOW() - interval '24 hours')::int AS last_24h,
                     percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (e.finished_at - e.started_at)) * 1000)
                       FILTER (WHERE e.status = 'completed') AS median_ms,
                     COALESCE(SUM(e.model_calls), 0)::int AS model_calls, COALESCE(SUM(e.tool_calls), 0)::int AS tool_calls,
                     COALESCE(SUM(e.input_tokens), 0)::bigint AS input_tokens, COALESCE(SUM(e.output_tokens), 0)::bigint AS output_tokens
                FROM platform_agent_executions e JOIN platform_agents a ON a.id = e.agent_id
               WHERE e.organization_id = $1 AND ${VISIBLE} AND e.created_at >= NOW() - interval '7 days'`, p),
    db.query(`SELECT e.trigger_kind, COUNT(*)::int AS n FROM platform_agent_executions e JOIN platform_agents a ON a.id = e.agent_id
               WHERE e.organization_id = $1 AND ${VISIBLE} AND e.created_at >= NOW() - interval '7 days' GROUP BY e.trigger_kind`, p),
    db.query(`SELECT COALESCE(e.error_class, 'UNKNOWN') AS error_class, COUNT(*)::int AS n, MAX(e.finished_at) AS last_at,
                     (array_agg(e.error_message ORDER BY e.finished_at DESC))[1] AS example, (array_agg(e.id ORDER BY e.finished_at DESC))[1] AS last_id
                FROM platform_agent_executions e JOIN platform_agents a ON a.id = e.agent_id
               WHERE e.organization_id = $1 AND ${VISIBLE} AND e.status = 'failed' AND e.finished_at >= NOW() - interval '24 hours'
               GROUP BY 1 ORDER BY n DESC`, p),
    db.query(`SELECT e.id, e.status, e.mode, e.trigger_kind, e.created_at, e.started_at, e.finished_at, e.error_class, e.model_calls, e.tool_calls,
                     e.input_tokens + e.output_tokens AS tokens, a.name AS agent_name, a.id AS agent_id
                FROM platform_agent_executions e JOIN platform_agents a ON a.id = e.agent_id
               WHERE e.organization_id = $1 AND ${VISIBLE} ORDER BY e.created_at DESC LIMIT 12`, p),
    atLeast(org.role, 'member')
      ? db.query(`SELECT COUNT(*)::int AS n FROM platform_approval_requests r JOIN platform_agents a ON a.id = r.agent_id
                   WHERE r.organization_id = $1 AND r.status = 'pending'
                     AND (a.owner_user_id = $2 OR r.requested_by = $2 OR $3::boolean OR a.visibility = 'organization' OR (a.visibility = 'team' AND a.team_id = ANY($4::uuid[])))`, p)
      : Promise.resolve({ rows: [{ n: null }] }),
    db.query(`SELECT COUNT(*)::int AS n FROM platform_approval_requests WHERE organization_id = $1 AND status = 'pending' AND created_at < NOW() - interval '24 hours'`, [org.id]),
    db.query(`SELECT a.id, a.name, a.next_scheduled_at FROM platform_agents a WHERE a.organization_id = $1 AND a.status = 'active' AND a.next_scheduled_at IS NOT NULL
                AND (a.owner_user_id = $2 OR $3::boolean OR a.visibility = 'organization' OR (a.visibility = 'team' AND a.team_id = ANY($4::uuid[])))
              ORDER BY a.next_scheduled_at LIMIT 5`, p),
    db.query(`SELECT name, last_error FROM starlane_connections WHERE user_id = $1 AND status = 'ACTIVE' AND last_error IS NOT NULL LIMIT 10`, [org.ownerUserId]).catch(() => ({ rows: [] })),
    Promise.resolve(router?.health ? router.health() : null),
    db.query(MODEL_USAGE_SQL(`e.organization_id = $1 AND ${VISIBLE} AND e.created_at >= NOW() - interval '7 days'`), p),
    getPolicy(db, org.id),
  ]);
  const weekCost = modelCost(models.rows, policy.modelPrices);
  const byStatus = Object.fromEntries(agentCounts.rows.map((r) => [r.status, r.n]));
  const liveStatus = Object.fromEntries(live.rows.map((r) => [r.status, r.n]));
  const w = week.rows[0];
  const finished = w.live_completed + w.live_failed;
  const alerts = [];
  for (const f of failures.rows) alerts.push({ kind: 'failures', severity: 'high', title: `${f.n} run${f.n === 1 ? '' : 's'} failed: ${f.error_class.replace(/_/g, ' ').toLowerCase()}`, detail: f.example, href: `/command/runs/${f.last_id}` });
  if (oldApprovals.rows[0].n && atLeast(org.role, 'member')) alerts.push({ kind: 'approvals', severity: 'normal', title: `${oldApprovals.rows[0].n} approval${oldApprovals.rows[0].n === 1 ? ' has' : 's have'} waited over 24 hours`, href: '/approvals' });
  for (const c of conns.rows) alerts.push({ kind: 'connection', severity: 'normal', title: `Connection "${c.name}" reported an error`, detail: c.last_error, href: '/connections' });
  if (health && !health.configured.length) alerts.push({ kind: 'model', severity: 'high', title: 'No AI model is configured on this server', detail: 'Agents cannot run until a provider key (for example ANTHROPIC_API_KEY) is set.', href: null });
  return {
    agents: { active: byStatus.active || 0, ready: byStatus.ready || 0, draft: byStatus.draft || 0, disabled: byStatus.disabled || 0, archived: byStatus.archived || 0 },
    executions: {
      running: liveStatus.running || 0, queued: liveStatus.queued || 0, awaitingApproval: liveStatus.awaiting_approval || 0,
      last7d: { completed: w.completed, failed: w.failed, cancelled: w.cancelled }, last24h: w.last_24h,
      successRate: finished ? { available: true, value: w.live_completed / finished, sample: finished } : { available: false, reason: 'No live runs finished in the last 7 days.' },
      medianDurationMs: w.median_ms != null ? { available: true, value: Math.round(Number(w.median_ms)) } : { available: false, reason: 'No completed runs in the last 7 days.' },
    },
    approvals: { pending: approvals.rows[0].n },
    triggers: { last7d: Object.fromEntries(byTrigger.rows.map((r) => [r.trigger_kind, r.n])), upcoming: scheduled.rows.map((s) => ({ agentId: s.id, agentName: s.name, at: s.next_scheduled_at })) },
    usage: {
      modelCalls: w.model_calls, toolCalls: w.tool_calls, inputTokens: Number(w.input_tokens), outputTokens: Number(w.output_tokens),
      cost: weekCost,
    },
    quality: {
      outcomes: { available: false, reason: 'Outcome tracking for custom agents is not built yet. Success rate above counts runs that finished without error, not business results.' },
    },
    alerts,
    recent: recent.rows.map((r) => ({ id: r.id, agentId: r.agent_id, agentName: r.agent_name, status: r.status, mode: r.mode, trigger: r.trigger_kind, createdAt: r.created_at, durationMs: r.started_at && r.finished_at ? new Date(r.finished_at) - new Date(r.started_at) : null, errorClass: r.error_class, modelCalls: r.model_calls, toolCalls: r.tool_calls, tokens: Number(r.tokens) })),
    model: health ? { configured: health.configured, preferred: health.preferred } : null,
  };
}

async function usage(db, org) {
  const policy = await getPolicy(db, org.id);
  const [today, days, perAgent, models, agentModels] = await Promise.all([
    db.query(`SELECT COUNT(*)::int AS n FROM platform_agent_executions WHERE organization_id = $1 AND created_at >= date_trunc('day', NOW())`, [org.id]),
    db.query(`SELECT date_trunc('day', created_at)::date AS day, COUNT(*)::int AS executions, COALESCE(SUM(input_tokens + output_tokens), 0)::bigint AS tokens,
                     COALESCE(SUM(model_calls), 0)::int AS model_calls, COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
                FROM platform_agent_executions WHERE organization_id = $1 AND created_at >= NOW() - interval '30 days' GROUP BY 1 ORDER BY 1`, [org.id]),
    db.query(`SELECT a.id, a.name, COUNT(e.id)::int AS executions, COALESCE(SUM(e.input_tokens + e.output_tokens), 0)::bigint AS tokens
                FROM platform_agents a LEFT JOIN platform_agent_executions e ON e.agent_id = a.id AND e.created_at >= NOW() - interval '30 days'
               WHERE a.organization_id = $1 GROUP BY a.id ORDER BY executions DESC LIMIT 20`, [org.id]),
    db.query(MODEL_USAGE_SQL(`e.organization_id = $1 AND e.created_at >= NOW() - interval '30 days'`), [org.id]),
    db.query(`SELECT e.agent_id, u.key AS model, SUM(COALESCE((u.value->>'input')::bigint, 0))::bigint AS input, SUM(COALESCE((u.value->>'output')::bigint, 0))::bigint AS output
                FROM platform_agent_executions e, jsonb_each(CASE WHEN jsonb_typeof(e.state->'usage') = 'object' THEN e.state->'usage' ELSE '{}'::jsonb END) u
               WHERE e.organization_id = $1 AND e.created_at >= NOW() - interval '30 days' GROUP BY 1, 2`, [org.id]),
  ]);
  const byAgent = new Map();
  for (const r of agentModels.rows) {
    const m = byAgent.get(r.agent_id) || {};
    m[r.model] = { input: Number(r.input), output: Number(r.output) };
    byAgent.set(r.agent_id, m);
  }
  return {
    limits: { dailyExecutionLimit: policy.dailyExecutionLimit, maxConcurrentExecutions: policy.maxConcurrentExecutions, ceilings: policy.ceilings, aiDailyTokenBudget: Number(process.env.AI_DAILY_TOKEN_BUDGET || 300000) },
    today: { executions: today.rows[0].n },
    daily: days.rows.map((d) => ({ day: d.day, executions: d.executions, tokens: Number(d.tokens), modelCalls: d.model_calls, failed: d.failed })),
    perAgent: perAgent.rows.map((a) => {
      const usageOf = byAgent.get(a.id) || {};
      const tracked = Object.values(usageOf).reduce((n, u) => n + u.input + u.output, 0);
      const c = costOf(usageOf, policy.modelPrices, { untrackedTokens: Math.max(0, Number(a.tokens) - tracked) });
      return { agentId: a.id, name: a.name, executions: a.executions, tokens: Number(a.tokens), cost: { available: c.available, value: c.value, currency: c.currency, reason: c.reason } };
    }),
    cost: modelCost(models.rows, policy.modelPrices),
    prices: policy.modelPrices,
  };
}

const CATEGORY_LABEL = {
  accounting: 'Accounting', erp: 'ERP', banking: 'Banking', payments: 'Payments', crm: 'CRM', ecommerce: 'E-commerce', inventory: 'Inventory',
  spreadsheets: 'Spreadsheets', email: 'Email', messaging: 'Messaging', communication: 'Communication', productivity: 'Productivity',
  hr_payroll: 'HR and payroll', support: 'Support', logistics: 'Logistics', external_signals: 'External signals', custom: 'Custom and APIs',
};

// Categories the platform names that no manifest covers yet.
const PLANNED_EXTRA = [
  { id: 'google_calendar', name: 'Google Calendar', category: 'productivity', summary: 'Meetings and availability for agents.' },
  { id: 'microsoft_365', name: 'Microsoft 365 (Outlook, SharePoint)', category: 'productivity', summary: 'Mail, calendars and documents.' },
  { id: 'google_drive', name: 'Google Drive', category: 'productivity', summary: 'Documents synced into Knowledge.' },
  { id: 'postgres_db', name: 'Databases (Postgres, MySQL)', category: 'custom', summary: 'Read-only queries against your own database.' },
];

async function connections(db, org, { flags = flagOn } = {}) {
  const { getConnectorStates } = require('../connectors/state');
  let states = [];
  let stateError = null;
  try { states = await getConnectorStates(db, org.ownerUserId); } catch (err) { stateError = 'Live connection state could not be read just now.'; console.error('[platform connections]', err.message); }
  const items = states.map((m) => {
    const canonical = m.state?.canonicalHealth;
    let status;
    let reason = null;
    if (m.availability !== 'available') { status = 'planned'; reason = m.unavailableReason || 'Not built yet.'; }
    else if (['CONNECTED', 'SYNCING', 'DEGRADED', 'STALE'].includes(canonical)) status = 'connected';
    else if (m.state?.health === 'error' || m.state?.health === 'disconnected') { status = 'configuration_required'; reason = m.state?.lastError || 'Set up but not working. Open it to fix the configuration.'; }
    else status = 'available';
    if (status !== 'planned' && ['http_api', 'slack'].includes(m.id) && !flags('workflow_http_actions_enabled')) {
      reason = 'Calls to this software are switched off on this server (FEATURE_WORKFLOW_HTTP_ACTIONS_ENABLED).';
      if (status === 'available') status = 'configuration_required';
    }
    return {
      id: m.id, name: m.name, provider: m.provider, category: m.category, categoryLabel: CATEGORY_LABEL[m.category] || m.category,
      summary: m.summary, status, reason, health: m.state?.health || null, lastSyncAt: m.state?.lastSyncAt || null,
      lastError: m.state?.lastError || null, setupHref: m.id === 'tally' ? '/sources/tally' : '/sources/connect',
      usedBy: m.id === 'http_api' ? ['Agents (Call a connected API)', 'Custom workflows'] : m.id === 'webhook_in' ? ['Custom workflows'] : ['Finance, Procurement and Ask Starlane data'],
    };
  });
  for (const p of PLANNED_EXTRA) if (!items.some((i) => i.id === p.id)) items.push({ ...p, provider: null, categoryLabel: CATEGORY_LABEL[p.category], status: 'planned', reason: 'Planned. Not built yet.', health: null, lastSyncAt: null, lastError: null, setupHref: null, usedBy: [] });
  const order = { connected: 0, configuration_required: 1, available: 2, planned: 3 };
  items.sort((a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name));
  const counts = items.reduce((acc, i) => { acc[i.status] = (acc[i.status] || 0) + 1; return acc; }, {});
  return { connections: items, counts, stateError, ownedBy: org.ownerUserId };
}

module.exports = { commandCenter, usage, connections };
