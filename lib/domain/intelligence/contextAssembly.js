// FILE: lib/domain/intelligence/contextAssembly.js
// Day 7 Intelligence Acceleration — Part 1: Context Assembly Layer.
//
// This is COMPOSITION, not new computation (per audit recommendation).
// assembleEntityContext(userId, entityType, entityId) reads/calls existing,
// already-proven functions and assembles them into one coherent object
// describing everything real that is known about one entity, plus an
// explicit list of what is NOT known (availableEvidence / missingContext).
//
// entityType currently only supports 'customer' (the highest-value case per
// the mission). Unsupported entityType values return an explicit
// unsupported marker rather than guessing.
const { supabase } = require('../../config/supabaseClient');
const { safeLog } = require('../../observability/logger');
const { getObservedPayersForCustomer } = require('../../services/paymentAllocation');

// Re-use the exact same trajectory classifier creditRiskAgent.js uses —
// no reimplementation (see lib/domain/temporal/temporalComparison.js note).
const { classifyScoreTrajectory } = require('../../services/agents/creditRiskAgent');

async function assembleEntityContext(userId, entityType, entityId) {
  if (!userId) throw new Error('assembleEntityContext: userId is required');
  if (!entityId) throw new Error('assembleEntityContext: entityId is required');

  if (entityType !== 'customer') {
    return {
      entityType,
      entityId,
      supported: false,
      reason: `assembleEntityContext does not yet support entityType='${entityType}' (only 'customer' is built in this phase).`,
    };
  }

  const availableEvidence = [];
  const missingContext = [];

  // 1. Customer identity + current state (customer_scores row)
  const { data: customer, error: custErr } = await supabase
    .from('customers')
    .select('id, name, phone')
    .eq('id', entityId)
    .eq('user_id', userId)
    .maybeSingle();
  if (custErr) throw custErr;

  if (!customer) {
    return {
      entityType: 'customer',
      entityId,
      supported: true,
      found: false,
      reason: 'No customer row found for this id under this tenant.',
      availableEvidence: [],
      missingContext: ['customer identity'],
    };
  }
  availableEvidence.push('customer identity (customers row)');

  const { data: scoreRow, error: scoreErr } = await supabase
    .from('customer_scores')
    .select('*')
    .eq('customer_id', entityId)
    .eq('user_id', userId)
    .maybeSingle();
  if (scoreErr) throw scoreErr;
  if (scoreRow) {
    availableEvidence.push('current state (customer_scores row)');
  } else {
    missingContext.push('current state (no customer_scores row for this customer)');
  }

  // 2. Relevant historical state (customer_score_history + trajectory)
  const { data: historyRows, error: histErr } = await supabase
    .from('customer_score_history')
    .select('id, credit_risk_score, promise_reliability_score, broken_promise_count, collection_priority_score, recorded_at')
    .eq('customer_id', entityId)
    .eq('user_id', userId)
    .order('recorded_at', { ascending: false })
    .limit(10);
  if (histErr) throw histErr;

  const history = historyRows || [];
  const trajectory = classifyScoreTrajectory(history);
  if (history.length >= 2) {
    availableEvidence.push(`score trajectory (2-point, from ${history.length} history rows)`);
  } else if (history.length === 1) {
    missingContext.push('score trajectory (only 1 history row — need >=2 for even a 2-point comparison)');
  } else {
    missingContext.push('score trajectory (no customer_score_history rows)');
  }

  // 3. Related entities: linked invoices + observed payers
  const { data: invoices, error: invErr } = await supabase
    .from('invoices')
    .select('id, invoice_amount, payment_status, days_overdue, due_date, currency')
    .eq('customer_id', entityId)
    .eq('user_id', userId);
  if (invErr) throw invErr;
  const invoiceRows = invoices || [];
  if (invoiceRows.length) availableEvidence.push(`${invoiceRows.length} linked invoice(s)`);
  else missingContext.push('linked invoices (none found for this customer_id)');

  const outstandingTotal = invoiceRows
    .filter(i => (i.payment_status || '').toLowerCase() !== 'paid')
    .reduce((sum, i) => sum + (Number(i.invoice_amount) || 0), 0);

  let observedPayers = { customerName: customer.name, observedPayers: [] };
  try {
    observedPayers = await getObservedPayersForCustomer({ userId, customerName: customer.name });
    if (observedPayers.observedPayers.length) {
      availableEvidence.push(`${observedPayers.observedPayers.length} observed payer pattern(s) (CONFIRMED allocations)`);
    } else {
      missingContext.push('observed payer pattern (no CONFIRMED payment_allocations rows for this customer)');
    }
  } catch (err) {
    safeLog('warn', '[contextAssembly] getObservedPayersForCustomer failed', { error: err.message, userId, entityId });
    missingContext.push('observed payer pattern (lookup failed)');
  }

  // 4. Recent events: entity_state_history (may be empty — handle gracefully)
  const { data: stateHistory, error: eshErr } = await supabase
    .from('entity_state_history')
    .select('id, event_type, observed_at, changed_fields, source')
    .eq('entity_type', 'customer')
    .eq('entity_id', entityId)
    .eq('user_id', userId)
    .order('observed_at', { ascending: false })
    .limit(20);
  if (eshErr) throw eshErr;
  const recentEvents = stateHistory || [];
  if (recentEvents.length) availableEvidence.push(`${recentEvents.length} entity_state_history event(s)`);
  else missingContext.push('entity_state_history events (table is currently empty for this entity — known project-wide gap, not specific to this customer)');

  // 5. Previous actions: ai_actions history for this customer
  const { data: actions, error: actErr } = await supabase
    .from('ai_actions')
    .select('id, action_type, title, priority, risk_level, status, outcome, created_at, reason_json')
    .eq('customer_id', entityId)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(20);
  if (actErr) throw actErr;
  const previousActions = actions || [];
  if (previousActions.length) availableEvidence.push(`${previousActions.length} previous ai_actions row(s)`);
  else missingContext.push('previous ai_actions (none found for this customer)');

  // Day 2 Multidimensional Intelligence Part 15/16 — small extension: surface
  // prior action/outcome history explicitly rather than leaving it buried in
  // the raw `previousActions` rows. Reuses the exact `outcome` field already
  // selected above (evaluationAgent.js's existing outcome-write pattern) —
  // no new mechanism, no new query.
  const actionsWithKnownOutcome = previousActions.filter(a => a.outcome === 'effective' || a.outcome === 'ineffective');
  const priorOutcomeSummary = {
    totalPriorActions: previousActions.length,
    withKnownOutcome: actionsWithKnownOutcome.length,
    effective: actionsWithKnownOutcome.filter(a => a.outcome === 'effective').length,
    ineffective: actionsWithKnownOutcome.filter(a => a.outcome === 'ineffective').length,
    unknownOrPending: previousActions.length - actionsWithKnownOutcome.length,
  };
  if (actionsWithKnownOutcome.length) {
    availableEvidence.push(`${actionsWithKnownOutcome.length} prior action(s) with a known effective/ineffective outcome`);
  } else if (previousActions.length) {
    missingContext.push('prior action outcomes (previous ai_actions exist but none have a resolved effective/ineffective outcome yet)');
  }

  // Day 3 Part 16 — action/outcome linkage for possible-future intelligence.
  // Purely additive chronology surfaced from ai_actions.reason_json.possibleFutureLink
  // (see futureProjection.js's linkProjectionToAction) — never a causal claim,
  // just "this projection/scenario existed when this action was suggested,
  // and here is its later outcome (if any)".
  const { extractLinkedFutureIntelligence } = require('./futureProjection');
  const linkedFutureIntelligence = extractLinkedFutureIntelligence(previousActions).map(link => {
    const action = previousActions.find(a => a.id === link.actionId);
    return { ...link, actionOutcome: action ? action.outcome || 'pending' : 'unknown' };
  });

  // 6. Known external exposure — may or may not exist for a customer entity type.
  // business_exposure.business_entity_type is populated for 'supplier' in the
  // real data seen this session; check honestly rather than assuming.
  const { data: exposureRows, error: expErr } = await supabase
    .from('business_exposure')
    .select('id, exposure_type, world_entity_id, verification_status, valid_from, valid_to')
    .eq('business_entity_type', 'customer')
    .eq('business_entity_id', entityId)
    .eq('user_id', userId);
  if (expErr) throw expErr;
  const externalExposure = exposureRows || [];
  if (externalExposure.length) availableEvidence.push(`${externalExposure.length} business_exposure row(s) linked to this customer`);
  else missingContext.push('external (world) exposure (no business_exposure rows linked to this customer entity — common, since exposure rows observed so far in this tenant are supplier-side)');

  return {
    entityType: 'customer',
    entityId,
    supported: true,
    found: true,
    customer: { id: customer.id, name: customer.name, phone: customer.phone },
    currentState: scoreRow || null,
    history: { rows: history, trajectory },
    relatedEntities: {
      invoices: invoiceRows,
      outstandingTotal,
      observedPayers: observedPayers.observedPayers,
    },
    recentEvents,
    previousActions,
    priorOutcomeSummary,
    linkedFutureIntelligence,
    externalExposure,
    availableEvidence,
    missingContext,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { assembleEntityContext };
