// FILE: lib/world/worldEventConsequence.js
// STARLANE Day 3 — Part 13: World event consequence v2.
//
// Explicitly separates EVENT -> EXPOSURE -> DEPENDENCY -> POSSIBLE CONSEQUENCE
// for the supplier+geography+world-event chain, reusing
// supplierExposureNarrative.js's real matching (never reimplemented) rather
// than inventing a shipment-delay or product-impact claim when the
// product-dependency leg is honestly unknown.

const { buildSupplierExposureNarrative } = require('../domain/intelligence/supplierExposureNarrative');
const { checkStockoutPrerequisites } = require('../domain/intelligence/inventoryConsequence');
const { propagateSignalV2 } = require('./signalPropagation');
const { getPool } = require('../db/pg');
const { IMPACT_MODES, CAUSAL_LABELS } = require('./externalSignal');

async function buildWorldEventConsequenceV2({ userId, supplierId }) {
  const result = await buildSupplierExposureNarrative({ userId, supplierId });
  if (result.insufficientEvidence) {
    return {
      status: 'INSUFFICIENT_EVIDENCE',
      reasons: result.reasons,
      chain: null,
    };
  }

  const chains = result.narratives.map(n => {
    const dependencyEvidence = n.evidence.find(e => e.type === 'business_exposure');
    return {
      EVENT: n.evidence.find(e => e.type === 'world_event'),
      EXPOSURE: dependencyEvidence,
      DEPENDENCY: {
        geographyDependency: 'REAL: ' + n.dependencies.geographyLeg,
        productDependency: 'UNKNOWN: ' + n.dependencies.productDependencyLeg,
      },
      POSSIBLE_CONSEQUENCE: {
        statement: n.likely_consequence,
        language: 'possible / plausible — not a causal claim, not a quantified shipment-delay estimate',
        recommended_action: n.recommended_action,
      },
      uncertainty_band: n.uncertainty_band,
      missingContext: n.missingContext,
    };
  });

  return { status: 'CHAINS_FOUND', supplier: result.supplier, chainCount: chains.length, chains };
}

/**
 * Extends the chain down to a real business_signal's propagation (order-
 * labeled, capped depth) when a signal id is available for this exposure.
 */
async function attachPropagationV2(userId, signalId) {
  if (!signalId) return { attached: false, reason: 'no business_signal id available to propagate' };
  const pool = getPool();
  const sigRes = await pool.query(`SELECT * FROM business_signals WHERE id = $1 AND user_id = $2`, [signalId, userId]);
  const signal = sigRes.rows[0];
  if (!signal) return { attached: false, reason: 'signal not found for this tenant' };
  const propagation = await propagateSignalV2(userId, signal);
  return { attached: true, propagation };
}

/**
 * Day 4 — Part 5/6: real chain EVENT -> SUPPLIER EXPOSURE -> OPERATIONAL
 * UNCERTAINTY. Widens a supplier lead-time uncertainty BAND (never a point
 * estimate, never an invented day count) when a real matching event exists.
 * Explicitly stops at INSUFFICIENT_CONTEXT for the product-dependency leg,
 * matching the Day 3 finding in buildWorldEventConsequenceV2 above — this
 * function never invents a downstream product/shipment effect.
 */
async function widenSupplierUncertaintyFromEvent({ userId, supplierId }) {
  const consequence = await buildWorldEventConsequenceV2({ userId, supplierId });
  if (consequence.status !== 'CHAINS_FOUND' || consequence.chainCount === 0) {
    return {
      impact_mode: IMPACT_MODES.NO_EFFECT,
      label: CAUSAL_LABELS.OBSERVED,
      reason: consequence.status === 'INSUFFICIENT_EVIDENCE' ? 'no real event+exposure chain exists for this supplier' : 'no chains found',
      chain: null,
    };
  }

  const stockoutPrereqs = await checkStockoutPrerequisites(userId);

  const widenedChains = consequence.chains.map(c => ({
    EVENT: c.EVENT,
    EXPOSURE: c.EXPOSURE,
    OPERATIONAL_UNCERTAINTY: {
      before: c.uncertainty_band,
      after_direction: 'WIDENED', // qualitative only — no invented magnitude/day count
      basis: `Real ${c.EVENT?.event_type || 'world event'} matched to a real, tenant-recorded supplier exposure. This widens the operational uncertainty band around this supplier's lead time qualitatively — it does not assert a specific number of days of delay.`,
    },
    DOWNSTREAM_PRODUCT_EFFECT: stockoutPrereqs.prerequisitesMet
      ? { impact_mode: IMPACT_MODES.INSUFFICIENT_CONTEXT, reason: 'product_suppliers/purchase_line_items rows exist but this chain does not yet resolve which specific product depends on this supplier — see Day 3 productDependencyLeg finding' }
      : { impact_mode: IMPACT_MODES.INSUFFICIENT_CONTEXT, reason: `product_suppliers (${stockoutPrereqs.productSupplierLinks} rows) / purchase_line_items (${stockoutPrereqs.purchaseLineItems} rows) are data-insufficient for this tenant — chain honestly stops here rather than inventing a shipment/product effect` },
  }));

  return {
    impact_mode: IMPACT_MODES.RANGE_WIDENING,
    label: CAUSAL_LABELS.POSSIBLY_CONTRIBUTING,
    supplier: consequence.supplier,
    chains: widenedChains,
    reason: 'Real event matched to real exposure; operational uncertainty widened qualitatively. Chain honestly halts at INSUFFICIENT_CONTEXT before any product/shipment claim.',
  };
}

module.exports = { buildWorldEventConsequenceV2, attachPropagationV2, widenSupplierUncertaintyFromEvent };
