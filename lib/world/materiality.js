// FILE: lib/world/materiality.js
// Phase 17 — materiality components exposed as SEPARATE structured fields.
// Deliberately NOT combined into one "impact score" — see mission Phase 17.
// Pure function: takes a signal row (+ its evidence chain pieces) and
// returns a structured object. proximity is OMITTED (not faked) unless a
// real geo-distance is computable from lat/lon on both the event and a
// located business_entity — Phase 2 has no tenant-side lat/lon, so it is
// always omitted here with an explicit note, never invented.
function computeMaterialityComponents({ signal, exposure, event, channel, dependencyEvidence = null }) {
  const businessDependencyByExposureType = {
    LOCATED_IN: 'high', SOURCED_FROM: 'high', DEPENDS_ON: 'high',
    CURRENCY_DENOMINATED: 'medium', USES_PORT: 'medium', USES_ROUTE: 'medium',
    REGULATED_BY: 'medium', SUBJECT_TO_COMMODITY: 'medium',
  };

  const recencyHours = event && event.observed_at
    ? (Date.now() - new Date(event.observed_at).getTime()) / 36e5
    : null;

  return {
    proximity: null, // omitted: no real geo-distance is computable from current tenant data (see audit)
    proximity_note: 'Not computed — tenant business tables carry no lat/lon; never faked.',
    business_dependency: exposure ? (businessDependencyByExposureType[exposure.exposure_type] || 'unknown') : null,
    exposure_strength: exposure ? exposure.confidence : null,
    event_severity: event ? event.severity : null,
    event_magnitude: event ? event.magnitude : null,
    recency_hours: recencyHours,
    relationship_confidence: exposure ? exposure.resolution_confidence : null,
    // Phase 15 (Part B) — real business-dependency EVIDENCE, kept as
    // separate fields, never folded into business_dependency above. Each
    // field traces to a real query result (see
    // lib/world/dependencyEvidence.js): does this supplier/product carry
    // meaningful real purchase volume, is real current_stock already at or
    // below the real low_stock_alert threshold, and do real open orders
    // exist. `null` means "not applicable / not computed for this entity
    // type", never a fabricated "no".
    dependency_evidence: dependencyEvidence || {
      isSoleOrPrimarySupplier: null,
      supplierPurchaseShare: null,
      productIsLowStock: null,
      openOrdersCount: null,
      note: 'No dependencyEvidence supplied to computeMaterialityComponents for this call — see lib/world/dependencyEvidence.js.',
    },
    // Explicitly NOT combined into this function's output: no weighted sum,
    // no single score field lives here. lib/world/signalRanking.js DOES
    // define one deterministic, documented composite for ordering active
    // signals against each other — see that file's header comment for the
    // exact formula. That composite is a ranking aid only; it is never
    // surfaced as a financial or probability number, and every component
    // that feeds it remains visible here, separately.
    composition_policy: 'Components are exposed separately by design. No composition formula is implemented in this function — ' +
      'combining severity, recency, dependency, and confidence into one number here would hide which factor drove a signal. ' +
      'lib/world/signalRanking.js implements ONE documented, deterministic ranking formula over these same components, ' +
      'purely for ordering purposes — it does not replace or hide these fields.',
  };
}

module.exports = { computeMaterialityComponents };
