// FILE: lib/world/sourceRegistry.js
// Register/lookup rows in world_sources, and record ingestion outcomes.
const { getPool } = require('../db/pg');

async function ensureSource(def) {
  const pool = getPool();
  const res = await pool.query(
    `INSERT INTO world_sources
       (provider, dataset, authority_type, homepage_url, license_notes, update_cadence,
        geographic_coverage, historical_coverage_notes, data_category, reliability_tier, schema_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (provider, dataset) DO UPDATE SET
       authority_type = EXCLUDED.authority_type,
       homepage_url = EXCLUDED.homepage_url,
       license_notes = EXCLUDED.license_notes,
       update_cadence = EXCLUDED.update_cadence,
       geographic_coverage = EXCLUDED.geographic_coverage,
       historical_coverage_notes = EXCLUDED.historical_coverage_notes,
       data_category = EXCLUDED.data_category,
       reliability_tier = EXCLUDED.reliability_tier,
       updated_at = NOW()
     RETURNING id`,
    [def.provider, def.dataset, def.authorityType || null, def.homepageUrl || null, def.licenseNotes || null,
     def.updateCadence || null, def.geographicCoverage || null, def.historicalCoverageNotes || null,
     def.dataCategory || null, def.reliabilityTier || 'unverified', def.schemaVersion || 'v1']
  );
  return res.rows[0].id;
}

async function recordSuccess(sourceId) {
  const pool = getPool();
  await pool.query(`UPDATE world_sources SET last_successful_ingestion_at = NOW(), updated_at = NOW() WHERE id = $1`, [sourceId]);
}

async function recordFailure(sourceId, reason) {
  const pool = getPool();
  await pool.query(`UPDATE world_sources SET last_failure_at = NOW(), last_failure_reason = $2, updated_at = NOW() WHERE id = $1`, [sourceId, String(reason).slice(0, 2000)]);
}

async function getCheckpoint(sourceId) {
  const pool = getPool();
  const res = await pool.query(`SELECT * FROM world_ingestion_checkpoints WHERE source_id = $1`, [sourceId]);
  return res.rows[0] || null;
}

async function upsertCheckpoint(sourceId, { cursorValue, status, lastError, recordsProcessed }) {
  const pool = getPool();
  await pool.query(
    `INSERT INTO world_ingestion_checkpoints (source_id, cursor_value, last_run_at, status, last_error, records_processed)
     VALUES ($1, $2, NOW(), $3, $4, $5)
     ON CONFLICT (source_id) DO UPDATE SET
       cursor_value = EXCLUDED.cursor_value,
       last_run_at = NOW(),
       status = EXCLUDED.status,
       last_error = EXCLUDED.last_error,
       records_processed = world_ingestion_checkpoints.records_processed + EXCLUDED.records_processed,
       updated_at = NOW()`,
    [sourceId, cursorValue || null, status || 'succeeded', lastError || null, recordsProcessed || 0]
  );
}

module.exports = { ensureSource, recordSuccess, recordFailure, getCheckpoint, upsertCheckpoint };
