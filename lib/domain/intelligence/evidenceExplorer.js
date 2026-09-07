// FILE: lib/domain/intelligence/evidenceExplorer.js
// Day 7 Intelligence Acceleration — Part 8: Generalized Internal Evidence
// Chain.
//
// Generalizes the pattern already proven by paymentAllocation.js's
// getAllocationEvidence() and World Intelligence's evidence-chain lookups
// (lib/world/evidenceChain.js) into one entry point:
//   getInsightEvidence(insightType, context) -> { insightType, items: [...] }
// Every item traces to one real row id in one real table — never opaque
// prose. This does not recompute anything; it flattens the `evidence` arrays
// already produced by cashRiskNarrative.js / fxExposureNarrative.js (and,
// for allocation-level detail, re-fetches the full row via the existing
// getAllocationEvidence()).
const { getAllocationEvidence } = require('../../services/paymentAllocation');

const SUPPORTED_TYPES = new Set(['cash_risk', 'fx_exposure']);

/**
 * @param {string} insightType - 'cash_risk' | 'fx_exposure'
 * @param {object} context - { userId, narrative } where `narrative` is the
 *   object returned by buildCashRiskNarrative()/buildFxExposureNarrative().
 */
async function getInsightEvidence(insightType, context) {
  if (!SUPPORTED_TYPES.has(insightType)) {
    return { insightType, supported: false, items: [], reason: `unsupported insightType '${insightType}'` };
  }
  const { userId, narrative } = context || {};
  if (!narrative) {
    return { insightType, supported: true, items: [], reason: 'no narrative provided' };
  }
  if (narrative.insufficientEvidence) {
    return { insightType, supported: true, items: [], reason: 'source narrative was insufficient-evidence — nothing to trace' };
  }

  const items = [];
  for (const ev of narrative.evidence || []) {
    if (ev.type === 'score_trajectory') {
      for (const row of ev.sourceRows || []) {
        items.push({ table: row.table, id: row.id, field: 'credit_risk_score', value: row.credit_risk_score, recorded_at: row.recorded_at, claim: ev.claim });
      }
    } else if (ev.type === 'revenue_concentration') {
      items.push({ table: 'sales', field: 'aggregate_90d_revenue', claim: ev.claim, sharePct: ev.sharePct });
    } else if (ev.type === 'observed_payer_pattern') {
      // Re-fetch full allocation-level evidence when an allocationId is
      // available (not always — this narrative aggregates across possibly
      // multiple allocations); otherwise expose the aggregate claim as-is.
      items.push({
        table: 'payment_allocations',
        field: 'payer_reference',
        claim: ev.claim,
        payer_reference: ev.payer_reference,
        count: ev.count,
        total_amount: ev.total_amount,
      });
    } else if (ev.type === 'world_event') {
      items.push({ table: 'world_events', id: ev.id, field: 'event_type/observed_at/magnitude', claim: `${ev.event_type} observed ${ev.observed_at} (magnitude ${ev.magnitude ?? 'n/a'}, severity ${ev.severity ?? 'n/a'})` });
    } else if (ev.type === 'business_exposure') {
      items.push({ table: 'business_exposure', id: ev.id, field: 'exposure_type/verification_status', claim: `${ev.exposure_type} exposure on ${ev.business_entity_type} ${ev.business_entity_id}, verification_status=${ev.verification_status}` });
    } else {
      items.push({ table: 'unknown', claim: JSON.stringify(ev) });
    }
  }

  return { insightType, supported: true, items, generatedAt: new Date().toISOString() };
}

/**
 * Optional deeper drill-down: given one allocationId surfaced in a cash-risk
 * narrative's evidence, return the full allocation-level evidence trail
 * (reuses the existing, already-tested getAllocationEvidence()).
 */
async function getAllocationDrilldown({ allocationId, userId }) {
  return getAllocationEvidence({ allocationId, userId });
}

module.exports = { getInsightEvidence, getAllocationDrilldown };
