// FILE: lib/domain/decisions/discovery.js
// Runs the decision engine for one tenant against its live data:
//   load ledger -> as-of snapshot -> freshness + contradictions -> detectors
//   -> persist (dedup / revise / resolve) -> collisions -> agent run record.
// Honest about partial failure: a detector that errors is reported as
// degraded in the result, never silently skipped.

const { deriveReceivablesState } = require('./snapshot');
const { discoverReceivableDecisions } = require('./detectors/receivables');
const { discoverProcessDecisions } = require('./detectors/process');
const { discoverSupplyChainDecisions } = require('./detectors/supplyChain');
const { detectDecisionContradictions } = require('./contradictions');
const { receivablesFreshness } = require('./sourceHealth');
const { getSettings, checkStops } = require('./controls');
const { AGENT, upsertDraft, resolveVanished, computeCollisions } = require('./store');
const { safeLog } = require('../../observability/logger');

async function loadRawReceivables(pool, userId) {
  const [invoices, customers, disputes, promises, allocations] = await Promise.all([
    pool.query(
      `SELECT id, invoice_number, customer_name, invoice_amount, payment_amount, payment_status, invoice_date, due_date, payment_date,
              currency, source_type, created_at, updated_at
       FROM invoices WHERE user_id = $1`, [userId]),
    pool.query('SELECT id, name, credit_limit, advance_required, escalation_paused, tags, default_payment_terms, created_at FROM customers WHERE user_id = $1', [userId]),
    pool.query('SELECT id, invoice_id, status, created_at, resolved_at FROM disputes WHERE user_id = $1', [userId]),
    pool.query('SELECT id, customer_id, status, promised_date, created_at, resolved_at FROM promises WHERE user_id = $1', [userId]),
    pool.query('SELECT invoice_id, amount, payment_date, allocation_status, reversed_at FROM payment_allocations WHERE user_id = $1', [userId]).catch(() => ({ rows: [] })),
  ]);
  return { invoices: invoices.rows, customers: customers.rows, disputes: disputes.rows, promises: promises.rows, allocations: allocations.rows };
}

async function reminderEvidence(pool, userId) {
  const res = await pool.query(
    `SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE outcome = 'effective')::int AS effective
     FROM ai_actions WHERE user_id = $1 AND action_type IN ('SEND_FIRM_REMINDER','ESCALATE_COLLECTION','ESCALATE_COLLECTION_CALL') AND outcome IN ('effective','ineffective')`,
    [userId]
  );
  return res.rows[0];
}

async function runDiscovery(pool, userId, { onBehalfOf = null, correlationId = null, externalSendEnabled = false, getSignalImpact = null } = {}) {
  const started = Date.now();
  const stops = await checkStops(pool, userId, { agentKey: AGENT.key });
  if (!stops.allowed) {
    return { status: 'STOPPED', blockedBy: stops.blockedBy, discovered: 0, revised: 0, resolved: 0 };
  }
  const settings = await getSettings(pool, userId);
  const defs = settings.definitions;
  const asOfIso = new Date().toISOString();
  const raw = await loadRawReceivables(pool, userId);
  const state = deriveReceivablesState(raw, asOfIso, { mode: 'live', baseCurrency: defs.base_currency });
  const [freshness, reminders] = await Promise.all([receivablesFreshness(pool, userId, defs), reminderEvidence(pool, userId)]);
  const contradictionsByInvoice = detectDecisionContradictions(state);
  const liveContext = { externalSendEnabled, freshness, contradictionsByInvoice, reminderEvidence: reminders };

  const degraded = [];
  const drafts = [];
  const watched = [];
  const kindsEvaluated = [];

  try {
    const r = discoverReceivableDecisions(state, defs, liveContext);
    drafts.push(...r.drafts); watched.push(...r.watched.map((w) => ({ kind: 'RECEIVABLE_RISK', ...w })));
    kindsEvaluated.push('RECEIVABLE_RISK');
  } catch (err) {
    degraded.push({ detector: 'receivables', error: err.message });
  }
  try {
    const p = discoverProcessDecisions(state, defs);
    drafts.push(...p.drafts); watched.push(...p.watched.map((w) => ({ kind: 'PROCESS_DEGRADATION', ...w })));
    kindsEvaluated.push('PROCESS_DEGRADATION');
  } catch (err) {
    degraded.push({ detector: 'process', error: err.message });
  }
  if (getSignalImpact) {
    try {
      const s = await discoverSupplyChainDecisions(userId, defs, { pool, getSignalImpact });
      drafts.push(...s.drafts); watched.push(...s.watched.map((w) => ({ kind: 'SUPPLY_STOCKOUT', ...w })));
      kindsEvaluated.push('SUPPLY_STOCKOUT');
    } catch (err) {
      degraded.push({ detector: 'supply_chain', error: err.message });
    }
  }

  const counts = { discovered: 0, revised: 0, reobserved: 0 };
  const ids = [];
  for (const draft of drafts) {
    const { row, outcome } = await upsertDraft(pool, userId, draft, { defs, asOfIso, onBehalfOf, correlationId });
    counts[outcome]++;
    ids.push(row.id);
  }
  const resolved = await resolveVanished(pool, userId, kindsEvaluated, new Set(drafts.map((d) => d.dedupKey)), { onBehalfOf, correlationId });

  // Collisions across everything currently active.
  const activeRes = await pool.query(
    `SELECT id, kind, title, affected_entities FROM decisions WHERE user_id = $1 AND status IN ('OPEN','NEEDS_INFORMATION','SELECTED','APPROVED','EXECUTING','SHADOWED','EXECUTED')`,
    [userId]
  );
  const collisions = computeCollisions(activeRes.rows);
  for (const [id, list] of collisions) {
    await pool.query('UPDATE decisions SET collisions = $3 WHERE id = $1 AND user_id = $2', [id, userId, JSON.stringify(list)]);
  }

  const result = {
    status: degraded.length ? 'DEGRADED' : 'OK',
    asOf: asOfIso,
    discovered: counts.discovered,
    revised: counts.revised,
    reobserved: counts.reobserved,
    resolved: resolved.length,
    decisionIds: ids,
    watched,
    degraded,
    freshness,
    dataQuality: state.quality,
    totalsByCurrency: state.totalsByCurrency,
    definitions: settings.definitionsLabel,
    durationMs: Date.now() - started,
  };

  await pool.query(
    `INSERT INTO agent_runs (user_id, agent_key, status, started_at, finished_at, input_json, output_json, error_text)
     VALUES ($1,$2,$3,to_timestamp($4/1000.0),NOW(),$5,$6,$7)`,
    [userId, AGENT.key, degraded.length ? 'failed' : 'completed', started,
      JSON.stringify({ agentVersion: AGENT.version, model: AGENT.model, onBehalfOf, correlationId, definitions: settings.definitionsLabel }),
      JSON.stringify({ discovered: result.discovered, revised: result.revised, resolved: result.resolved, watched: watched.length, durationMs: result.durationMs }),
      degraded.length ? JSON.stringify(degraded).slice(0, 2000) : null]
  ).catch((err) => safeLog('warn', '[decisions] agent_runs write failed', { error: err.message }));

  safeLog('info', '[decisions] discovery run', { userId, correlationId, discovered: result.discovered, revised: result.revised, resolved: result.resolved, degraded: degraded.length, durationMs: result.durationMs });
  return result;
}

module.exports = { runDiscovery, loadRawReceivables };
