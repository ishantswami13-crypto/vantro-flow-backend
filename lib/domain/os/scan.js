// FILE: lib/domain/os/scan.js
// SCAN: look at the business deeply and say what was found, with real
// counts only.
//
//   ledger -> as-of state -> process reconstruction -> bottleneck and
//   documented-vs-actual -> automation candidates (with a historical
//   replay each) -> opportunities -> constraint -> decisions (the existing
//   decision engine) -> proposals written to Prepared.

const { getSettings, checkStops } = require('../decisions/controls');
const { loadRawReceivables, runDiscovery } = require('../decisions/discovery');
const { deriveReceivablesState } = require('../decisions/snapshot');
const { buildBehaviorModel } = require('../decisions/behavior');
const { discoverReceivablesProcess } = require('./processDiscovery');
const { discoverAutomations, discoverOpportunities, identifyConstraint } = require('./automationDiscovery');
const { proposeWorkflow } = require('./workflows');
const { replayWorkflow } = require('./workflowLogic');
const { safeLog } = require('../../observability/logger');

const SCAN_AGENT = 'starlane.scan';

async function observedTouches(pool, userId) {
  const q = (sql) => pool.query(sql, [userId]).then((r) => r.rows[0]?.n ?? 0).catch(() => null);
  const [reminders, followups, promises] = await Promise.all([
    q(`SELECT COUNT(*)::int AS n FROM ai_actions WHERE user_id = $1 AND action_type IN ('SEND_FIRM_REMINDER','SEND_POLITE_REMINDER','ESCALATE_COLLECTION','ESCALATE_COLLECTION_CALL') AND created_at > NOW() - INTERVAL '90 days'`),
    q(`SELECT COUNT(*)::int AS n FROM followups WHERE user_id = $1 AND created_at > NOW() - INTERVAL '90 days'`),
    q(`SELECT COUNT(*)::int AS n FROM promises WHERE user_id = $1 AND created_at > NOW() - INTERVAL '90 days'`),
  ]);
  return { reminders, followups, promises, windowDays: 90 };
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

async function runScan(pool, userId, { actorId = null, asOfIso = new Date().toISOString(), externalSendEnabled = false, getSignalImpact = null } = {}) {
  const started = Date.now();
  const stops = await checkStops(pool, userId, { agentKey: SCAN_AGENT });
  if (!stops.allowed) return { status: 'STOPPED', blockedBy: stops.blockedBy };
  const settings = await getSettings(pool, userId);
  const defs = settings.definitions;
  const raw = await loadRawReceivables(pool, userId);
  const state = deriveReceivablesState(raw, asOfIso, { mode: 'live', baseCurrency: defs.base_currency });
  const behavior = buildBehaviorModel(state);
  const touches = await observedTouches(pool, userId);

  const process = discoverReceivablesProcess(state, { touches });
  const automation = discoverAutomations(state, process);
  const opportunities = discoverOpportunities(state, behavior);
  const constraint = identifyConstraint(state, process);

  let decisions = null;
  try {
    decisions = await runDiscovery(pool, userId, { onBehalfOf: actorId, externalSendEnabled, getSignalImpact });
  } catch (err) {
    decisions = { status: 'DEGRADED', error: err.message };
  }
  const openDecisions = (await pool.query(`SELECT COUNT(*)::int AS n FROM decisions WHERE user_id = $1 AND status IN ('OPEN','NEEDS_INFORMATION')`, [userId]).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n;

  const proposals = [];
  for (const c of automation.candidates) {
    const params = { overdueDays: c.trigger.days, minBalance: c.minBalance, currency: defs.base_currency };
    const simulation = { ...replayWorkflow(raw, params, asOfIso, { baseCurrency: defs.base_currency }), ranAt: new Date().toISOString(), asOf: asOfIso, params };
    const p = await proposeWorkflow(pool, userId, {
      templateKey: c.key, params, source: 'SCAN', sourceRef: { agent: SCAN_AGENT, asOf: asOfIso },
      discovery: c, simulation, createdBy: SCAN_AGENT,
    });
    proposals.push({ key: c.key, outcome: p.outcome, workflowId: p.workflow?.id || null, status: p.workflow?.status || null, rejectedAt: p.rejectedAt || null });
  }

  const found = {
    bottlenecks: process.bottleneck ? 1 : 0,
    automationOpportunities: automation.candidates.length,
    businessOpportunities: opportunities.length,
    decisions: openDecisions,
  };
  const summary = [];
  if (process.coverage.invoices) {
    summary.push(`I reconstructed ${process.coverage.days} days of invoices (${process.coverage.from} to ${process.coverage.to}): ${plural(process.coverage.invoices, 'invoice', 'invoices')} from ${plural(process.coverage.customers, 'customer', 'customers')}.`);
    summary.push(`Found ${plural(found.bottlenecks, 'bottleneck', 'bottlenecks')}, ${plural(found.automationOpportunities, 'automation opportunity', 'automation opportunities')}, ${plural(found.businessOpportunities, 'business opportunity', 'business opportunities')} and ${plural(found.decisions, 'decision that needs you', 'decisions that need you')}.`);
  } else {
    summary.push('There are no invoices to scan yet. Upload a receivables file or connect Tally in Bridge.');
  }
  if (process.status === 'INSUFFICIENT_DATA' && process.coverage.invoices) summary.push(process.reason);

  const result = {
    status: decisions?.status === 'DEGRADED' ? 'DEGRADED' : 'OK',
    asOf: asOfIso,
    summary,
    found,
    process,
    automation,
    opportunities,
    constraint,
    decisions: decisions ? { status: decisions.status, discovered: decisions.discovered, revised: decisions.revised, resolved: decisions.resolved, open: openDecisions } : null,
    proposals,
    dataQuality: state.quality,
    durationMs: Date.now() - started,
    agent: { key: SCAN_AGENT, model: 'deterministic (no LLM)' },
  };
  await pool.query(
    `INSERT INTO agent_runs (user_id, agent_key, status, started_at, finished_at, input_json, output_json)
     VALUES ($1,$2,'completed',to_timestamp($3/1000.0),NOW(),$4,$5)`,
    [userId, SCAN_AGENT, started, JSON.stringify({ asOf: asOfIso, onBehalfOf: actorId }), JSON.stringify(result)]
  ).catch((err) => safeLog('warn', '[os] scan run write failed', { error: err.message }));
  return result;
}

async function latestScan(pool, userId) {
  const r = await pool.query(`SELECT output_json, finished_at FROM agent_runs WHERE user_id = $1 AND agent_key = $2 ORDER BY started_at DESC LIMIT 1`, [userId, SCAN_AGENT]);
  return r.rows[0] ? { ...r.rows[0].output_json, finishedAt: r.rows[0].finished_at } : null;
}

module.exports = { runScan, latestScan, SCAN_AGENT };
