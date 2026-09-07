// FILE: lib/world/materiality.js
// Phase 17 — materiality components exposed as SEPARATE structured fields.
// Deliberately NOT combined into one "impact score" — see mission Phase 17.
// Pure function: takes a signal row (+ its evidence chain pieces) and
// returns a structured object. proximity is OMITTED (not faked) unless a
// real geo-distance is computable from lat/lon on both the event and a
// located business_entity — Phase 2 has no tenant-side lat/lon, so it is
// always omitted here with an explicit note, never invented.
function computeMaterialityComponents({ signal, exposure, event, channel }) {
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
    // Explicitly NOT combined: no weighted sum, no single score field.
    composition_policy: 'Components are exposed separately by design. No composition formula is implemented in Phase 2 — ' +
      'combining severity, recency, dependency, and confidence into one number would hide which factor drove a signal, ' +
      'and no single justified weighting scheme exists yet. A future phase MAY define one, but must document the exact ' +
      'formula and keep these components visible alongside it, never in place of them.',
  };
}

module.exports = { computeMaterialityComponents };
