// FILE: lib/domain/intelligence/cashRiskNarrative.js
// Day 7 Intelligence Acceleration — Headline Narrative 2: Payment
// Deterioration + Concentration + Payer Dependency.
//
// Pure composition of three already-real, already-tested functions:
//   - creditRiskAgent.js's classifyScoreTrajectory (honest 2-point trajectory)
//   - revenueIntelligence.service.js's getRevenueIntelligenceForCustomer
//     (real 90-day trailing concentration)
//   - paymentAllocation.js's getObservedPayersForCustomer (real CONFIRMED
//     allocation-based payer pattern)
//
// No new computation of scores/percentages happens here — this module only
// decides whether there is enough real evidence to say something, and if so,
// assembles it into one narrative object. When evidence is insufficient it
// returns an explicit `{ insufficientEvidence: true, reasons: [...] }`
// marker — NEVER a weak/fabricated conclusion (mission invariant + Part 12
// guardrail).
const { supabase } = require('../../config/supabaseClient');
const { getObservedPayersForCustomer } = require('../../services/paymentAllocation');
const { getRevenueIntelligenceForCustomer } = require('../../services/orchestrator/revenueIntelligence.service');
const { classifyScoreTrajectory } = require('../../services/agents/creditRiskAgent');

async function buildCashRiskNarrative({ userId, customerId }) {
  if (!userId) throw new Error('buildCashRiskNarrative: userId is required');
  if (!customerId) throw new Error('buildCashRiskNarrative: customerId is required');

  const reasonsInsufficient = [];

  const { data: customer, error: custErr } = await supabase
    .from('customers')
    .select('id, name')
    .eq('id', customerId)
    .eq('user_id', userId)
    .maybeSingle();
  if (custErr) throw custErr;
  if (!customer) {
    return { insufficientEvidence: true, reasons: ['no customer row found for this id/tenant'] };
  }

  const { data: historyRows, error: histErr } = await supabase
    .from('customer_score_history')
    .select('id, credit_risk_score, recorded_at')
    .eq('customer_id', customerId)
    .eq('user_id', userId)
    .order('recorded_at', { ascending: false })
    .limit(2);
  if (histErr) throw histErr;

  const trajectory = classifyScoreTrajectory(historyRows || []);
  if (trajectory === 'UNKNOWN') {
    reasonsInsufficient.push(
      (historyRows || []).length < 2
        ? `only ${(historyRows || []).length} customer_score_history row(s) exist — need >=2 for even a 2-point trajectory`
        : 'customer_score_history values are non-numeric/malformed'
    );
  }

  const revIntel = await getRevenueIntelligenceForCustomer(userId, customerId, customer.name);
  const concentration = revIntel?.concentration || null;
  if (!concentration || !concentration.isConcentrationRisk) {
    reasonsInsufficient.push('no real concentration risk (>25% of trailing-90-day tenant revenue) for this customer');
  }

  let observedPayers = [];
  try {
    const payerResult = await getObservedPayersForCustomer({ userId, customerName: customer.name });
    observedPayers = payerResult.observedPayers || [];
  } catch (err) {
    // non-fatal: absence of payer data is itself informative, not an error to throw
  }
  const topPayer = observedPayers[0] || null;
  const hasPayerDependency = !!topPayer && observedPayers.length > 0 &&
    topPayer.count >= 2; // require >=2 confirmed allocations before calling it a "pattern"
  if (!hasPayerDependency) {
    reasonsInsufficient.push('no repeated (>=2 confirmed allocations) observed third-party payer pattern for this customer');
  }

  // Guardrail (Part 12): a narrative requires trajectory known/deteriorating
  // AND at least one of {concentration risk, payer dependency} to be real —
  // otherwise this is not an honest "cash risk" story, just noise.
  const hasSignal = trajectory !== 'UNKNOWN' && (concentration?.isConcentrationRisk || hasPayerDependency);
  if (!hasSignal) {
    return {
      insufficientEvidence: true,
      reasons: reasonsInsufficient.length ? reasonsInsufficient : ['no combination of trajectory/concentration/payer-dependency signal cleared the evidence bar'],
    };
  }

  const evidence = [];
  evidence.push({
    type: 'score_trajectory',
    claim: `credit risk trajectory is ${trajectory}`,
    sourceRows: (historyRows || []).map(r => ({ table: 'customer_score_history', id: r.id, recorded_at: r.recorded_at, credit_risk_score: r.credit_risk_score })),
    honestyNote: '2-point comparison only (latest vs one prior row) — not a multi-point trend, per current data volume.',
  });
  if (concentration?.isConcentrationRisk) {
    evidence.push({
      type: 'revenue_concentration',
      claim: concentration.evidence,
      sharePct: concentration.sharePct,
    });
  }
  if (hasPayerDependency) {
    evidence.push({
      type: 'observed_payer_pattern',
      claim: `${topPayer.count} confirmed payment(s) totalling ${topPayer.total_amount} observed from payer reference "${topPayer.payer_reference}" for this customer's invoices/sales`,
      payer_reference: topPayer.payer_reference,
      count: topPayer.count,
      total_amount: topPayer.total_amount,
    });
  }

  const relationship_context = hasPayerDependency
    ? `Payments attributed to this customer have, on ${topPayer.count} confirmed occasion(s), been observed coming from payer reference "${topPayer.payer_reference}" rather than the customer's own name. This is an observed payment pattern only — it is not evidence of ownership or a corporate relationship between the two.`
    : 'No repeated third-party payer pattern observed for this customer.';

  const likely_consequence = trajectory === 'DETERIORATING'
    ? 'If this pattern continues, collection difficulty for this customer may increase further — this is a directional read from a single prior data point, not a projected timeline.'
    : trajectory === 'IMPROVING'
      ? 'Risk appears to be easing based on the single available prior comparison point.'
      : 'Risk level appears unchanged based on the single available prior comparison point.';

  const recommended_action = concentration?.isConcentrationRisk
    ? 'Treat this customer as a concentration risk: prioritize collections/communication and avoid further exposure concentration until trailing revenue share drops.'
    : 'Monitor: no immediate concentration action indicated, but the trajectory/payer pattern above is worth watching.';

  return {
    insufficientEvidence: false,
    trajectory,
    observation: `Customer "${customer.name}" shows a ${trajectory.toLowerCase()} credit-risk trajectory${concentration?.isConcentrationRisk ? ` and represents ${concentration.sharePct}% of trailing-90-day revenue` : ''}.`,
    what_changed: trajectory !== 'UNKNOWN'
      ? `credit_risk_score moved from ${historyRows[1]?.credit_risk_score} to ${historyRows[0]?.credit_risk_score} between the two most recent recorded points.`
      : 'no trajectory change available',
    evidence,
    relationship_context,
    why_it_matters: concentration?.isConcentrationRisk
      ? 'This customer is a large share of recent revenue, so a real deterioration here has outsized cashflow impact relative to other customers.'
      : 'A payer-dependency or trajectory shift on this customer is worth tracking even without concentration risk today.',
    likely_consequence,
    recommended_action,
    confidence_components: {
      trajectory_confidence: trajectory === 'UNKNOWN' ? 0 : 0.5, // 2-point only, honestly capped below "high"
      concentration_confidence: concentration?.isConcentrationRisk ? 0.9 : 0,
      payer_pattern_confidence: hasPayerDependency ? Math.min(0.9, 0.3 + topPayer.count * 0.1) : 0,
    },
    customer: { id: customer.id, name: customer.name },
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { buildCashRiskNarrative };
