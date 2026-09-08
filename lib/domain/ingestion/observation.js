// FILE: lib/domain/ingestion/observation.js
// STARLANE — Reality Acquisition, Organizational Sensor Network & Context
// Enrichment. Part 3: Universal Observation Contract.
//
// A tiny, deliberately dumb typed structure every ingestion path (today:
// csvImport.js) normalizes rows into before they touch a domain table. It
// exists so provenance (source_system, source_record_id/content_hash,
// observed_at vs received_at, source_quality) is captured uniformly instead
// of ad hoc per-importer. Persisted into raw_observations (migration
// 029_reality_acquisition_observations.sql).
//
// source_quality is NEVER inferred here — the caller must say REAL or
// SEEDED explicitly. This module does not guess.

const crypto = require('crypto');

const VALID_SOURCE_QUALITY = ['REAL', 'SEEDED'];

/**
 * Build a content hash for idempotency when a row has no natural
 * source_record_id. Stable across re-imports of the identical row: same
 * tenant + same entity_type + same normalized field values => same hash.
 */
function computeContentHash({ userId, entityType, fields }) {
  const stableFields = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k] === undefined || fields[k] === null ? '' : String(fields[k])}`)
    .join('|');
  const payload = `${userId}::${entityType}::${stableFields}`;
  return crypto.createHash('sha256').update(payload).digest('hex');
}

/**
 * Construct a validated Observation object. Throws on structural violations
 * (missing tenant, invalid source_quality) rather than silently defaulting —
 * an ingestion bug should fail loudly, not fabricate provenance.
 */
function makeObservation({
  userId,
  sourceSystem,
  sourceRecordId = null,
  entityType,
  observedAt = null,
  sourceQuality,
  fields,
  rawReference = null,
  ingestionVersion = 'csvImport.v1',
}) {
  if (!userId) throw new Error('makeObservation: userId is required');
  if (!sourceSystem) throw new Error('makeObservation: sourceSystem is required');
  if (!entityType) throw new Error('makeObservation: entityType is required');
  if (!VALID_SOURCE_QUALITY.includes(sourceQuality)) {
    throw new Error(`makeObservation: sourceQuality must be one of ${VALID_SOURCE_QUALITY.join('/')}, got "${sourceQuality}"`);
  }
  if (!fields || typeof fields !== 'object') throw new Error('makeObservation: fields object is required');

  const contentHash = computeContentHash({ userId, entityType, fields });

  return {
    userId,
    sourceSystem,
    sourceRecordId,
    contentHash,
    entityType,
    observedAt,
    receivedAt: new Date().toISOString(), // knowledge_time — always "now", never backdated
    sourceQuality,
    fields,
    rawReference,
    ingestionVersion,
  };
}

module.exports = { makeObservation, computeContentHash, VALID_SOURCE_QUALITY };
