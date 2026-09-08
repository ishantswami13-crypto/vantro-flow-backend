// FILE: lib/domain/intelligence/interactionRules.js
// STARLANE Day 2 Multidimensional Reality Intelligence — Part 7: Interaction
// Rules. Per the prior audit's explicit recommendation, this is 2-3 small,
// hand-written, deterministic functions — NOT a generic rule registry/engine.
// cashRiskNarrative.js already covers "trajectory AND (concentration OR payer
// dependency)" for cash risk; these rules are genuinely new combinations that
// module does not already cover.

const { assessUncertainty } = require('./uncertainty');

/**
 * Rule 1 — Supplier verification-state + exposure severity.
 * IF a supplier's geography exposure is VERIFIED (not UNVERIFIED/REJECTED)
 * AND that exposure type is one considered "severe" (LOCATED_IN, i.e. the
 * supplier's own operations are physically there, as opposed to a weaker
 * OPERATES_IN/SOURCED_FROM relationship)
 * THEN this supplier is a genuine candidate for Chain-B-style geography risk
 * review, independent of whether any world event currently matches it.
 *
 * This is deliberately narrower than supplierExposureNarrative.js — it does
 * NOT require a real matching world_event. It answers a different question:
 * "which suppliers are worth watching for geography risk at all," vs. Chain
 * B's "is there a real event affecting one right now."
 */
function ruleSupplierVerifiedSevereExposure(exposureRow) {
  if (!exposureRow) return { triggered: false, reason: 'no exposure row provided' };
  const isVerified = exposureRow.verification_status === 'VERIFIED';
  const isSevere = exposureRow.exposure_type === 'LOCATED_IN';
  const triggered = isVerified && isSevere;
  return {
    triggered,
    ruleId: 'SUPPLIER_VERIFIED_SEVERE_EXPOSURE',
    reason: triggered
      ? `supplier's exposure (${exposureRow.id}) is VERIFIED and LOCATED_IN — a direct physical-location exposure, not a weaker inferred relationship`
      : `not triggered: verification_status=${exposureRow.verification_status}, exposure_type=${exposureRow.exposure_type}`,
    evidence: triggered ? [{ type: 'business_exposure', id: exposureRow.id, verification_status: exposureRow.verification_status, exposure_type: exposureRow.exposure_type }] : [],
  };
}

/**
 * Rule 2 — Receivable concentration + payment-status inconsistency (NOT
 * covered by cashRiskNarrative.js, which only combines trajectory with
 * concentration/payer-dependency — it never looks at whether a "Paid"
 * invoice actually has confirmed payment evidence).
 * IF a customer represents >25% of trailing revenue (real concentration risk)
 * AND that customer has at least one invoice marked payment_status='Paid'
 * with NO CONFIRMED payment_allocations row backing it
 * THEN flag this as a genuine "trust but verify" combination: the customer is
 * financially important (concentration) AND their payment records contain an
 * unverified/unevidenced paid claim — worth a manual reconciliation check
 * before treating that revenue as fully collected.
 */
function ruleConcentrationPlusUnevidencedPaidInvoice({ concentration, unevidencedPaidInvoices }) {
  const isConcentrated = !!concentration?.isConcentrationRisk;
  const hasUnevidenced = Array.isArray(unevidencedPaidInvoices) && unevidencedPaidInvoices.length > 0;
  const triggered = isConcentrated && hasUnevidenced;
  return {
    triggered,
    ruleId: 'CONCENTRATION_PLUS_UNEVIDENCED_PAID_INVOICE',
    reason: triggered
      ? `customer is a concentration risk (${concentration.sharePct}% of trailing revenue) AND has ${unevidencedPaidInvoices.length} invoice(s) marked Paid with no CONFIRMED payment_allocations evidence`
      : `not triggered: isConcentrationRisk=${isConcentrated}, unevidencedPaidInvoiceCount=${unevidencedPaidInvoices?.length || 0}`,
    evidence: triggered
      ? [
          { type: 'revenue_concentration', sharePct: concentration.sharePct, claim: concentration.evidence },
          ...unevidencedPaidInvoices.map(i => ({ type: 'invoice_missing_allocation_evidence', id: i.id, payment_amount: i.payment_amount })),
        ]
      : [],
  };
}

/**
 * Rule 3 — Business-exposure verification-state contradiction guard.
 * IF a business_exposure row for an entity is in REJECTED or SUPERSEDED state
 * AND some OTHER live code path (a narrative, a signal) might otherwise have
 * matched against it
 * THEN this rule explicitly blocks that use and surfaces it as a
 * would-have-matched-but-rejected case, rather than silently letting a
 * REJECTED row disappear from view. This directly supports Part 12
 * (contradiction detection) by giving contradictionDetection.js a named,
 * reusable check rather than inline logic.
 */
function ruleRejectedExposureWouldHaveMatched(exposureRow) {
  if (!exposureRow) return { triggered: false, reason: 'no exposure row provided' };
  const isRejectedOrSuperseded = exposureRow.verification_status === 'REJECTED' || exposureRow.verification_status === 'SUPERSEDED';
  return {
    triggered: isRejectedOrSuperseded,
    ruleId: 'REJECTED_EXPOSURE_WOULD_HAVE_MATCHED',
    reason: isRejectedOrSuperseded
      ? `business_exposure ${exposureRow.id} is in ${exposureRow.verification_status} state — it is correctly excluded from all live matching (loadExposuresForTenant only reads VERIFIED rows), but its existence should be surfaced, not silently forgotten`
      : `not triggered: verification_status=${exposureRow.verification_status}`,
    evidence: isRejectedOrSuperseded
      ? [{ type: 'business_exposure', id: exposureRow.id, verification_status: exposureRow.verification_status, exposure_type: exposureRow.exposure_type }]
      : [],
  };
}

module.exports = {
  ruleSupplierVerifiedSevereExposure,
  ruleConcentrationPlusUnevidencedPaidInvoice,
  ruleRejectedExposureWouldHaveMatched,
};
