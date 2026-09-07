// FILE: lib/world/events.js
// Insert/update world_events rows, with revision tracking on correction.
const { getPool } = require('../db/pg');

const REVISABLE_FIELDS = ['title', 'summary', 'magnitude', 'magnitude_unit', 'severity', 'status', 'confidence'];

// Insert a new canonical event if (source_id, source_external_id) doesn't
// already exist; otherwise update in place, writing a world_event_revisions
// row for every changed field in REVISABLE_FIELDS BEFORE applying the
// update (Phase 5/15 — never destructively overwrite without a trail).
async function upsertCanonicalEvent(fields) {
  const pool = getPool();
  const existing = await pool.query(
    `SELECT * FROM world_events WHERE source_id = $1 AND source_external_id = $2`,
    [fields.sourceId, fields.sourceExternalId]
  );

  if (existing.rows.length === 0) {
    const res = await pool.query(
      `INSERT INTO world_events
        (event_type, event_subtype, title, summary, observed_at, started_at, ended_at,
         valid_from, valid_to, temporal_precision, published_at, country_codes, region_codes,
         latitude, longitude, source_id, source_external_id, raw_record_id, source_url,
         source_published_at, confidence, source_reliability, truth_state, severity,
         magnitude, magnitude_unit, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
       RETURNING id`,
      [fields.eventType, fields.eventSubtype || null, fields.title, fields.summary || null,
       fields.observedAt || null, fields.startedAt || null, fields.endedAt || null,
       fields.validFrom || null, fields.validTo || null, fields.temporalPrecision || 'exact',
       fields.publishedAt || null, fields.countryCodes || [], fields.regionCodes || [],
       fields.latitude ?? null, fields.longitude ?? null, fields.sourceId, fields.sourceExternalId || null,
       fields.rawRecordId || null, fields.sourceUrl || null, fields.sourcePublishedAt || null,
       fields.confidence ?? null, fields.sourceReliability || null, fields.truthState || 'OBSERVED',
       fields.severity || null, fields.magnitude ?? null, fields.magnitudeUnit || null, fields.status || 'active']
    );
    return { id: res.rows[0].id, isNew: true, revisedFields: [] };
  }

  const row = existing.rows[0];
  const revisedFields = [];
  const updates = {
    title: fields.title, summary: fields.summary, magnitude: fields.magnitude,
    magnitude_unit: fields.magnitudeUnit, severity: fields.severity, status: fields.status,
    confidence: fields.confidence,
  };
  for (const field of REVISABLE_FIELDS) {
    const newVal = updates[field] ?? null;
    const oldVal = row[field];
    const oldStr = oldVal === null || oldVal === undefined ? null : String(oldVal);
    const newStr = newVal === null || newVal === undefined ? null : String(newVal);
    if (oldStr !== newStr) {
      revisedFields.push({ field, oldStr, newStr });
    }
  }

  if (revisedFields.length > 0) {
    for (const rf of revisedFields) {
      await pool.query(
        `INSERT INTO world_event_revisions (event_id, field_name, previous_value, new_value, source_id)
         VALUES ($1,$2,$3,$4,$5)`,
        [row.id, rf.field, rf.oldStr, rf.newStr, fields.sourceId]
      );
    }
    await pool.query(
      `UPDATE world_events SET title=$2, summary=$3, magnitude=$4, magnitude_unit=$5,
         severity=$6, status=$7, confidence=$8, updated_at=NOW() WHERE id=$1`,
      [row.id, fields.title, fields.summary || null, fields.magnitude ?? null, fields.magnitudeUnit || null,
       fields.severity || null, fields.status || row.status, fields.confidence ?? null]
    );
  }

  return { id: row.id, isNew: false, revisedFields: revisedFields.map(r => r.field) };
}

module.exports = { upsertCanonicalEvent, REVISABLE_FIELDS };
