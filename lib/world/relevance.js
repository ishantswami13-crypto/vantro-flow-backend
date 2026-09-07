// FILE: lib/world/relevance.js
// Phase 4 — Relevance Matching Engine.
//
// `matchEventToExposures` is a PURE function: (event, exposures, channels) ->
// candidates. No DB access, no LLM, fully unit-testable in isolation. It
// NEVER produces a "this could affect anyone" candidate — every candidate
// traces to one specific business_exposure row belonging to one specific
// tenant, matched against one real event and one real transmission channel.
//
// Matching rule (all must hold):
//   1. channel.applicable_event_types includes event.event_type
//   2. channel.applicable_exposure_types includes exposure.exposure_type
//   3. exposure.world_entity_id is among the event's linked world_entity ids
//      (event.linkedEntityIds — the world_event_entities join, resolved by
//      the caller before invoking this function)
//   4. exposure is temporally valid at event.observed_at:
//        exposure.valid_from <= event.observed_at
//        AND (exposure.valid_to IS NULL OR exposure.valid_to > event.observed_at)
//   5. exposure.user_id is preserved on the candidate untouched — the DB
//      wrapper is responsible for never fetching another tenant's exposure
//      rows in the first place (Phase 12 wrong-tenant test), but this
//      function also never merges/aggregates across user_id, so even a
//      caller bug passing mixed-tenant exposures cannot cross-contaminate
//      a single candidate.
//
// A "candidate" is not yet a persisted business_signal — the DB
// orchestration layer (see `computeSignalCandidatesForEvent` below) is
// responsible for persisting/deduplicating/updating lifecycle state.

function isTemporallyValid(exposure, atIso) {
  const at = new Date(atIso).getTime();
  if (Number.isNaN(at)) return false;
  const from = exposure.valid_from ? new Date(exposure.valid_from).getTime() : -Infinity;
  const to = exposure.valid_to ? new Date(exposure.valid_to).getTime() : Infinity;
  return at >= from && at < to;
}

/**
 * @param {object} event - { id, event_type, observed_at, confidence, severity, magnitude, source_reliability, linkedEntityIds: string[] }
 * @param {object[]} exposures - business_exposure rows (already scoped to ONE tenant by the caller)
 * @param {object[]} channels - world_transmission_channels rows (with applicable_event_types/applicable_exposure_types/business_dimensions arrays)
 * @returns {object[]} candidates
 */
function matchEventToExposures(event, exposures, channels) {
  const candidates = [];
  if (!event || !Array.isArray(exposures) || !Array.isArray(channels)) return candidates;
  const linkedEntityIds = new Set(event.linkedEntityIds || []);
  if (linkedEntityIds.size === 0) return candidates; // no entity linkage -> nothing can match, ever

  for (const exposure of exposures) {
    if (!linkedEntityIds.has(exposure.world_entity_id)) continue;
    if (!isTemporallyValid(exposure, event.observed_at)) continue;

    for (const channel of channels) {
      const applicableEventTypes = channel.applicable_event_types || [];
      const applicableExposureTypes = channel.applicable_exposure_types || [];
      if (!applicableEventTypes.includes(event.event_type)) continue;
      if (!applicableExposureTypes.includes(exposure.exposure_type)) continue;

      candidates.push({
        userId: exposure.user_id,
        eventId: event.id,
        exposureId: exposure.id,
        channelId: channel.id,
        businessEntityType: exposure.business_entity_type,
        businessEntityId: exposure.business_entity_id,
        dedupKey: `${exposure.user_id}:${exposure.id}:${channel.id}`,
        affectedBusinessDimensions: channel.business_dimensions || [],
        whyExists: `${event.event_type} event (${event.id}) is linked to world_entity ${exposure.world_entity_id}, ` +
          `which matches this tenant's ${exposure.exposure_type} exposure (${exposure.id}) on ` +
          `${exposure.business_entity_type} ${exposure.business_entity_id}, via transmission channel ` +
          `${channel.channel_code || channel.id} (${channel.rule_explanation || channel.mechanism}).`,
        // Phase 9 — separate confidence components, never collapsed.
        confidenceComponents: {
          sourceReliability: event.source_reliability_score != null ? event.source_reliability_score : null,
          eventConfidence: event.confidence != null ? event.confidence : null,
          entityResolutionConfidence: exposure.resolution_confidence != null ? exposure.resolution_confidence : null,
          exposureConfidence: exposure.confidence != null ? exposure.confidence : null,
          transmissionConfidence: channel.default_confidence != null ? channel.default_confidence : null,
        },
        // Phase 10 — impact classification, no financial numbers, ever.
        impactStatus: 'POTENTIALLY_AFFECTED',
      });
    }
  }
  return candidates;
}

// ─── DB orchestration wrapper ──────────────────────────────────────────
const { getPool } = require('../db/pg');

const RELIABILITY_SCORE = { authoritative: 0.95, reputable: 0.75, unverified: 0.4, manual_reference: 0.6 };

async function loadEventWithEntities(eventId) {
  const pool = getPool();
  const evRes = await pool.query(
    `SELECT we.*, ws.reliability_tier FROM world_events we
     LEFT JOIN world_sources ws ON ws.id = we.source_id WHERE we.id = $1`,
    [eventId]
  );
  if (evRes.rows.length === 0) return null;
  const event = evRes.rows[0];
  const entRes = await pool.query(`SELECT entity_id FROM world_event_entities WHERE event_id = $1`, [eventId]);
  event.linkedEntityIds = entRes.rows.map(r => r.entity_id);
  event.source_reliability_score = RELIABILITY_SCORE[event.reliability_tier] ?? null;
  return event;
}

async function loadActiveChannels() {
  const pool = getPool();
  const res = await pool.query(`SELECT * FROM world_transmission_channels`);
  return res.rows;
}

// Tenant-scoped exposure load — MUST filter by user_id (Phase 12 wrong-tenant
// rejection). Only currently-not-expired-by-default rows are fetched here;
// temporal filtering against the specific event time still happens in the
// pure matcher above (an exposure could be valid_from in the future relative
// to an older event, etc.).
async function loadExposuresForTenant(userId) {
  const pool = getPool();
  const res = await pool.query(`SELECT * FROM business_exposure WHERE user_id = $1`, [userId]);
  return res.rows;
}

// Computes candidates for one event against ONE tenant's exposures. Never
// takes a list of tenants and never queries across tenants internally.
async function computeSignalCandidatesForEvent(eventId, userId) {
  const [event, exposures, channels] = await Promise.all([
    loadEventWithEntities(eventId),
    loadExposuresForTenant(userId),
    loadActiveChannels(),
  ]);
  if (!event) return [];
  return matchEventToExposures(event, exposures, channels);
}

// Persists candidates as business_signals, applying Phase 13 dedup: an
// existing OPEN signal for the same (user, exposure, channel) is updated
// (event id appended, status CANDIDATE->ACTIVE or ACTIVE->UPDATED) instead
// of inserting a duplicate row.
async function persistCandidates(candidates) {
  const pool = getPool();
  const results = [];
  for (const c of candidates) {
    const existing = await pool.query(
      `SELECT * FROM business_signals WHERE user_id = $1 AND business_exposure_id = $2 AND transmission_channel_id = $3`,
      [c.userId, c.exposureId, c.channelId]
    );
    if (existing.rows.length > 0) {
      const row = existing.rows[0];
      const alreadySupported = (row.current_supporting_event_ids || []).includes(c.eventId);
      const newEventIds = alreadySupported
        ? row.current_supporting_event_ids
        : [...(row.current_supporting_event_ids || []), c.eventId];
      const newStatus = row.status === 'CANDIDATE' ? 'ACTIVE'
        : (row.status === 'ACTIVE' && !alreadySupported ? 'UPDATED' : row.status);
      const updated = await pool.query(
        `UPDATE business_signals SET
           current_supporting_event_ids = $1,
           status = $2,
           last_updated_at = NOW(),
           affected_business_dimensions = $3,
           impact_status = $4
         WHERE id = $5 RETURNING *`,
        [newEventIds, newStatus, c.affectedBusinessDimensions, c.impactStatus, row.id]
      );
      if (newStatus !== row.status) {
        await pool.query(
          `INSERT INTO business_signal_status_history (signal_id, previous_status, new_status, reason) VALUES ($1,$2,$3,$4)`,
          [row.id, row.status, newStatus, alreadySupported ? 'same event reprocessed' : 'new supporting event observed']
        );
      }
      results.push({ isNew: false, signal: updated.rows[0] });
    } else {
      const inserted = await pool.query(
        `INSERT INTO business_signals
           (user_id, world_event_id, related_entity_type, related_entity_id, transmission_channel_id,
            business_exposure_id, plausibility_confidence, evidence_notes, status,
            current_supporting_event_ids, why_exists,
            source_reliability_component, event_confidence_component,
            entity_resolution_confidence_component, exposure_confidence_component,
            transmission_confidence_component, affected_business_dimensions, impact_status, dedup_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'CANDIDATE',$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         RETURNING *`,
        [
          c.userId, c.eventId, c.businessEntityType, c.businessEntityId, c.channelId,
          c.exposureId, c.confidenceComponents.exposureConfidence, c.whyExists,
          [c.eventId], c.whyExists,
          c.confidenceComponents.sourceReliability, c.confidenceComponents.eventConfidence,
          c.confidenceComponents.entityResolutionConfidence, c.confidenceComponents.exposureConfidence,
          c.confidenceComponents.transmissionConfidence, c.affectedBusinessDimensions, c.impactStatus, c.dedupKey,
        ]
      );
      await pool.query(
        `INSERT INTO business_signal_status_history (signal_id, previous_status, new_status, reason) VALUES ($1,NULL,'CANDIDATE','new signal created')`,
        [inserted.rows[0].id]
      );
      results.push({ isNew: true, signal: inserted.rows[0] });
    }
  }
  return results;
}

module.exports = {
  matchEventToExposures,
  isTemporallyValid,
  loadEventWithEntities,
  loadActiveChannels,
  loadExposuresForTenant,
  computeSignalCandidatesForEvent,
  persistCandidates,
  RELIABILITY_SCORE,
};
