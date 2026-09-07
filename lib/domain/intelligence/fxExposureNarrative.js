// FILE: lib/domain/intelligence/fxExposureNarrative.js
// Day 7 Intelligence Acceleration — Headline Narrative 1: FX / World
// Exposure narrative.
//
// Near-zero new logic: this reuses lib/world/relevance.js's real
// matchEventToExposures() matching engine verbatim (no reimplementation).
// It composes one real business_exposure row + one real world_events row
// (already matched by a real transmission channel) into a structured
// narrative object. Returns an explicit insufficient-evidence marker if no
// real match exists for the given event/exposure pair.
const { supabase } = require('../../config/supabaseClient');
const { matchEventToExposures } = require('../../world/relevance');

/**
 * Build an FX/world-exposure narrative for one specific (event, exposure)
 * pairing that a real match already exists for (or is about to be checked
 * for). Caller supplies eventId + userId; this function loads the event
 * (with its linked entities), the tenant's exposures, and the transmission
 * channels, then runs the SAME matchEventToExposures() used by the real
 * signal-candidate pipeline (lib/world/relevance.js) to decide whether a
 * real match exists before saying anything.
 */
async function buildFxExposureNarrative({ userId, eventId }) {
  if (!userId) throw new Error('buildFxExposureNarrative: userId is required');
  if (!eventId) throw new Error('buildFxExposureNarrative: eventId is required');

  const { data: event, error: evErr } = await supabase
    .from('world_events')
    .select('id, event_type, observed_at, magnitude, confidence, severity, source_reliability')
    .eq('id', eventId)
    .maybeSingle();
  if (evErr) throw evErr;
  if (!event) return { insufficientEvidence: true, reasons: ['no world_events row found for eventId'] };

  const { data: linkedEntities, error: linkErr } = await supabase
    .from('world_event_entities')
    .select('entity_id')
    .eq('event_id', eventId);
  if (linkErr) throw linkErr;
  const linkedEntityIds = (linkedEntities || []).map(r => r.entity_id);

  const { data: exposures, error: expErr } = await supabase
    .from('business_exposure')
    .select('*')
    .eq('user_id', userId);
  if (expErr) throw expErr;

  const { data: channels, error: chanErr } = await supabase
    .from('world_transmission_channels')
    .select('*');
  if (chanErr) throw chanErr;

  const candidates = matchEventToExposures(
    { ...event, linkedEntityIds },
    exposures || [],
    channels || []
  );

  if (!candidates.length) {
    return {
      insufficientEvidence: true,
      reasons: [
        `no business_exposure row for tenant ${userId} matches event ${eventId} under any real transmission channel (checked ${(exposures || []).length} exposure row(s) against ${(channels || []).length} channel(s))`,
      ],
    };
  }

  // Take the first real candidate (matchEventToExposures does not itself
  // rank candidates — with a single event/tenant pairing there is normally
  // exactly one, and ranking beyond what it returns would be a fabrication).
  const best = candidates[0];
  const exposure = (exposures || []).find(e => e.id === best.exposureId);

  // Look up a human-readable entity name for the exposure's world_entity_id.
  let entityName = null;
  if (exposure?.world_entity_id) {
    const { data: entityRow } = await supabase
      .from('world_entities')
      .select('name, entity_type')
      .eq('id', exposure.world_entity_id)
      .maybeSingle();
    entityName = entityRow?.name || null;
  }

  const evidence = [
    { type: 'world_event', id: event.id, event_type: event.event_type, observed_at: event.observed_at, magnitude: event.magnitude, severity: event.severity },
    { type: 'business_exposure', id: exposure?.id, exposure_type: exposure?.exposure_type, business_entity_type: exposure?.business_entity_type, business_entity_id: exposure?.business_entity_id, verification_status: exposure?.verification_status },
  ];

  return {
    insufficientEvidence: false,
    observation: `A ${event.event_type} event (${entityName || 'linked entity'}) matches a real ${exposure?.exposure_type} exposure on business_entity ${exposure?.business_entity_id} via a verified transmission channel.`,
    what_changed: `world_events row ${event.id} (observed ${event.observed_at}, magnitude ${event.magnitude ?? 'n/a'}, severity ${event.severity ?? 'n/a'}) newly matches exposure ${exposure?.id}.`,
    evidence,
    relationship_context: `This tenant's ${exposure?.business_entity_type} entity is exposed to ${entityName || 'this world entity'} via a real, tenant-recorded ${exposure?.exposure_type} link — observational, not asserting any deeper corporate relationship.`,
    why_it_matters: 'A real-world event affecting an entity this business is exposed to can propagate into cost, availability, or timing risk depending on the exposure type and affected business dimensions.',
    likely_consequence: 'Hedged: the transmission channel indicates a plausible mechanism, not a guaranteed or quantified impact — treat as a flagged risk to investigate, not a forecast.',
    recommended_action: 'Review this exposure and event pairing manually before taking any pricing/sourcing/timing action based on it.',
    confidence_components: {
      exposure_verification_confidence: exposure?.verification_status === 'VERIFIED' ? 0.9 : exposure?.verification_status === 'UNVERIFIED' ? 0.4 : 0,
      event_confidence: Number(event.confidence) || 0,
      ...best.confidenceComponents,
    },
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { buildFxExposureNarrative };
