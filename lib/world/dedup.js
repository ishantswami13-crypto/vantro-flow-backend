// FILE: lib/world/dedup.js
// Deterministic matching/dedup rules for world event ingestion. No LLM
// involvement anywhere in this file — matching is exact-key based only,
// per the mission's explicit "never let an LLM silently merge events" rule.
//
// SCOPE HONESTY (Phase 7): this Phase 1 implementation only handles
// same-source dedup — "did we already ingest this exact record from this
// exact source" — via the UNIQUE(source_id, source_record_id) constraint on
// world_source_records (migration 015) and UNIQUE(source_id,
// source_external_id) on world_events. True CROSS-source entity resolution
// (e.g. recognizing that a USGS earthquake and a hypothetical EMSC report
// describe the same real-world quake) is explicitly NOT implemented here.
// This is safe to skip for Phase 1 because the two vertical-slice sources
// (USGS earthquakes, FX reference rates) do not realistically report
// overlapping real-world events — an earthquake and a currency exchange rate
// are never the same event. A future phase adding a second natural-hazard
// source (e.g. EMSC alongside USGS) would need real cross-source matching
// (e.g. spatial+temporal proximity clustering) before this file's scope
// could honestly be called "cross-source dedup".
const { getPool } = require('../db/pg');
const { safeLog } = require('../observability/logger');

// Insert (or find-existing) a raw preservation record for one external
// record. Returns { id, isNew }. Idempotent via the source_id+source_record_id
// unique constraint — running the same fetch twice is a no-op the second time.
async function upsertRawRecord(sourceId, sourceRecordId, rawPayload) {
  const pool = getPool();
  const existing = await pool.query(
    `SELECT id, canonical_event_id, parse_status FROM world_source_records WHERE source_id = $1 AND source_record_id = $2`,
    [sourceId, sourceRecordId]
  );
  if (existing.rows.length > 0) {
    return { id: existing.rows[0].id, isNew: false, canonicalEventId: existing.rows[0].canonical_event_id, parseStatus: existing.rows[0].parse_status };
  }
  const res = await pool.query(
    `INSERT INTO world_source_records (source_id, source_record_id, raw_payload) VALUES ($1, $2, $3) RETURNING id`,
    [sourceId, sourceRecordId, JSON.stringify(rawPayload)]
  );
  return { id: res.rows[0].id, isNew: true, canonicalEventId: null, parseStatus: 'pending' };
}

async function markRawRecord(rawRecordId, { parseStatus, parseError, canonicalEventId }) {
  const pool = getPool();
  await pool.query(
    `UPDATE world_source_records SET parse_status = $2, parse_error = $3, canonical_event_id = COALESCE($4, canonical_event_id) WHERE id = $1`,
    [rawRecordId, parseStatus, parseError || null, canonicalEventId || null]
  );
}

module.exports = { upsertRawRecord, markRawRecord };
