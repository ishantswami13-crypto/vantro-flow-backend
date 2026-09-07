// FILE: lib/domain/intelligence/businessState.js
// Business State read-composition layer.
//
// This introduces NO new computation. It reads and assembles output that
// is already real, wired, and verified (STARLANE_CORE_ACTIVATION_REPORT.md,
// STARLANE_WAVE_2_VERIFICATION.md):
//   - ai_actions (rules engine + agents, via emitBusinessEvent/runAllAgents)
//   - customer_scores (scoring.service.recalculate, now real post-Wave-2)
//   - cashflow.service.getWeekForecast (cashflow.service.js, unchanged)
//   - lib/brain/brainSummary.js (independent, already-correct, unchanged)
//
// Every number returned here traces back to a table this project has
// already proven correct with real HTTP end-to-end tests — this module
// only composes, it never invents.
const { safeLog } = require('../../observability/logger');
const { computeOverallState } = require('./overallState');

const PRIORITY_RANK = { urgent: 0, high: 1, medium: 2, low: 3 };
const RISK_RANK = { high: 0, medium: 1, low: 2 };

function rank(map, value) {
  return Object.prototype.hasOwnProperty.call(map, value) ? map[value] : 99;
}

/**
 * Compose the Business State view for one tenant.
 * Never throws — partial failures degrade gracefully (a failed section
 * returns its own explicit error marker rather than failing the whole
 * response), matching this codebase's established fail-closed/fail-safe
 * convention (cashflow.service, event.service, audit.service all do this).
 *
 * @param {object} supabase - the app's existing data client (lib/config/supabaseClient)
 * @param {string} userId
 * @returns {object} { rankedActions, receivablesRisk, payablesRisk, cashflow, brain, generatedAt }
 */
async function loadBusinessState(supabase, userId) {
  const [actionsResult, cashflowResult, brainResult, externalConditionsResult] = await Promise.allSettled([
    loadRankedActions(supabase, userId),
    loadCashflow(userId),
    loadBrain(supabase, userId),
    loadExternalConditions(userId),
  ]);

  const rankedActions = actionsResult.status === 'fulfilled' ? actionsResult.value : [];
  if (actionsResult.status === 'rejected') {
    safeLog('warn', '[BusinessState] ranked actions failed', { userId, error: actionsResult.reason?.message });
  }

  const cashflow = cashflowResult.status === 'fulfilled'
    ? cashflowResult.value
    : { expected_inflow: 0, expected_outflow: 0, error: 'unavailable' };
  if (cashflowResult.status === 'rejected') {
    safeLog('warn', '[BusinessState] cashflow failed', { userId, error: cashflowResult.reason?.message });
  }

  const brain = brainResult.status === 'fulfilled' ? brainResult.value : null;
  if (brainResult.status === 'rejected') {
    safeLog('warn', '[BusinessState] brain summary failed', { userId, error: brainResult.reason?.message });
  }

  const receivablesRisk = rankedActions.filter(a => a.related_entity_type === 'invoice' || a.customer);
  const payablesRisk = rankedActions.filter(a => a.related_entity_type === 'purchase');

  const overallState = computeOverallState({ rankedActions, cashflow });

  // Phase 3, Part B — additive only. externalConditions is a NEW field;
  // no existing field above (overallState, rankedActions, receivablesRisk,
  // payablesRisk, cashflow, brain, sections, generatedAt) is touched by this
  // addition. See lib/world/businessStateBoundary.js for the three-state
  // (DATA_INCOMPLETE / NO_MATERIAL_SIGNALS / signals_present) contract.
  const externalConditions = externalConditionsResult.status === 'fulfilled'
    ? externalConditionsResult.value
    : { world_exposure_status: 'DATA_INCOMPLETE', reason: 'externalConditions lookup failed', error: 'unavailable' };
  if (externalConditionsResult.status === 'rejected') {
    safeLog('warn', '[BusinessState] externalConditions failed', { userId, error: externalConditionsResult.reason?.message });
  }

  return {
    overallState,
    rankedActions,
    receivablesRisk,
    payablesRisk,
    cashflow,
    brain,
    externalConditions,
    sections: {
      rankedActions: actionsResult.status === 'fulfilled' ? 'ok' : 'error',
      cashflow: cashflowResult.status === 'fulfilled' ? 'ok' : 'error',
      brain: brainResult.status === 'fulfilled' ? (brain === null ? 'disabled' : 'ok') : 'error',
      externalConditions: externalConditionsResult.status === 'fulfilled' ? 'ok' : 'error',
    },
    generatedAt: new Date().toISOString(),
  };
}

async function loadExternalConditions(userId) {
  const { getWorldExposureStatus } = require('../../world/businessStateBoundary');
  return getWorldExposureStatus(userId);
}

// Pending ai_actions, joined with the customer's current score/reason when
// the action references one, ranked by priority then risk_level (the
// database itself can't express this ordering via a simple index, so the
// rank mapping is applied in-process after a bounded fetch).
async function loadRankedActions(supabase, userId) {
  // Two plain queries + in-memory merge rather than an embedded-relation
  // select (`customers(...)`) — works identically whether the data layer
  // is real Supabase or a plain-Postgres client, and avoids relying on
  // Supabase-specific query-builder syntax for a single join.
  const { data, error } = await supabase
    .from('ai_actions')
    .select('id, action_type, title, description, priority, risk_level, status, requires_approval, recommended_message, related_entity_type, related_entity_id, customer_id, supplier_id, created_at')
    .eq('user_id', userId)
    .eq('status', 'pending')
    .limit(100);

  if (error) throw error;

  const rows = (data || []).map(row => ({
    id: row.id,
    action_type: row.action_type,
    title: row.title,
    description: row.description,
    priority: row.priority,
    risk_level: row.risk_level,
    requires_approval: row.requires_approval,
    recommended_message: row.recommended_message,
    related_entity_type: row.related_entity_type,
    related_entity_id: row.related_entity_id,
    customer: row.customer_id ? { id: row.customer_id } : null,
    created_at: row.created_at,
  }));

  const customerIds = [...new Set(rows.map(r => r.customer?.id).filter(Boolean))];
  if (customerIds.length) {
    const { data: customerRows } = await supabase
      .from('customers')
      .select('id, name, phone')
      .eq('user_id', userId)
      .in('id', customerIds);
    const customerById = new Map((customerRows || []).map(c => [c.id, c]));
    for (const row of rows) {
      if (row.customer && customerById.has(row.customer.id)) {
        const c = customerById.get(row.customer.id);
        row.customer.name = c.name;
        row.customer.phone = c.phone;
      }
    }
  }
  if (customerIds.length) {
    const { data: scores } = await supabase
      .from('customer_scores')
      .select('customer_id, credit_risk_score, collection_priority_score, score_reason_json')
      .eq('user_id', userId)
      .in('customer_id', customerIds);

    const scoreByCustomer = new Map((scores || []).map(s => [s.customer_id, s]));
    for (const row of rows) {
      if (row.customer && scoreByCustomer.has(row.customer.id)) {
        const s = scoreByCustomer.get(row.customer.id);
        // Postgres numeric columns come back as strings via pg/pgSupabaseShim
        // (e.g. "82.0") — coerce to actual numbers here so the response
        // matches the frontend's BusinessState.RankedActionCustomer contract
        // (credit_risk_score/collection_priority_score: number), not just a
        // value that happens to coerce correctly in relational comparisons.
        row.customer.credit_risk_score = s.credit_risk_score != null ? Number(s.credit_risk_score) : s.credit_risk_score;
        row.customer.collection_priority_score = s.collection_priority_score != null ? Number(s.collection_priority_score) : s.collection_priority_score;
        row.customer.score_reason = s.score_reason_json?.scoreReason || null;
      }
    }
  }

  rows.sort((a, b) => {
    const p = rank(PRIORITY_RANK, a.priority) - rank(PRIORITY_RANK, b.priority);
    if (p !== 0) return p;
    return rank(RISK_RANK, a.risk_level) - rank(RISK_RANK, b.risk_level);
  });

  return rows;
}

async function loadCashflow(userId) {
  const { getWeekForecast } = require('../../services/orchestrator/cashflow.service');
  return getWeekForecast(userId);
}

async function loadBrain(supabase, userId) {
  const { isEnabled } = require('../../featureFlags');
  if (!isEnabled('brain_dashboard_enabled')) return null;
  const { loadBrainSummary } = require('../../brain/brainSummary');
  return loadBrainSummary(supabase, userId);
}

module.exports = { loadBusinessState };
