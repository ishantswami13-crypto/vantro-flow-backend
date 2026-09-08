// FILE: lib/domain/ingestion/fileImportOrchestrator.js
// STARLANE — Real Customer Bootstrap & File Ingestion, Parts 3 + 4 + 5.
//
// Wires the new real byte-level parser (fileParser.js) and column mapper
// (columnMapping.js) into the ALREADY-APPROVED csvImport.js preview/commit
// pipeline (Reality Acquisition phase) — this module does not duplicate
// any validation/entity-resolution/idempotency logic that csvImport.js and
// entityResolution.js already provide; it only does the new work: turning
// raw file bytes into the row-object shape those modules expect, and
// recording a per-FILE batch row (file_import_batches, migration 030) for
// file-level idempotency (a stronger guarantee than the row-level content
// hash alone — the same file uploaded twice is recognized as a duplicate
// BATCH even before any row is looked at).

const crypto = require('crypto');
const { getPool } = require('../../db/pg');
const { inspectFile } = require('./fileParser');
const { mapHeaders, applyMapping } = require('./columnMapping');
const { previewImport, commitImport } = require('./csvImport');
const { resolveBestMatch } = require('./entityResolution');

function hashFileBytes(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Parse + map a raw file buffer, without touching the DB at all (pure
 * function). Returns the file inspection plus the mapped row objects ready
 * for previewImport/commitImport.
 */
function parseAndMapFile(buffer, filename, { profile = 'core' } = {}) {
  const inspection = inspectFile(buffer, filename);
  if (!inspection.supported) return { inspection, mappedRows: [], headerMapping: null };

  const headerMapping = mapHeaders(inspection.headers, { profile });
  const mappedRows = applyMapping(inspection.headers, inspection.rows, headerMapping.byField);
  return { inspection, mappedRows, headerMapping };
}

/**
 * Full dry-run preview of a file: parse, map, and run csvImport's existing
 * previewImport (writes nothing). Also computes "possible entity matches"
 * per mission Part 3, by reusing entityResolution.resolveBestMatch against
 * the tenant's existing suppliers — read-only.
 */
async function previewFile(buffer, filename, { userId, profile = 'core' } = {}) {
  if (!userId) throw new Error('previewFile: userId is required');
  const { inspection, mappedRows, headerMapping } = parseAndMapFile(buffer, filename, { profile });
  if (!inspection.supported) return { inspection, headerMapping: null, rowPreview: null, possibleMatches: [] };

  const rowPreview = previewImport(mappedRows, { userId });

  const pool = getPool();
  const existingSuppliers = (await pool.query(
    `SELECT id, name, gstin AS "taxId", email, phone FROM suppliers WHERE user_id = $1`,
    [userId]
  )).rows;

  const possibleMatches = mappedRows.map((row, i) => {
    if (!row.supplierName) return { index: i, match: null };
    const match = resolveBestMatch({ name: row.supplierName, taxId: row.supplierTaxId }, existingSuppliers);
    return { index: i, supplierName: row.supplierName, match };
  }).filter((m) => m.match !== null);

  const fileContentHash = hashFileBytes(buffer);
  const existingBatch = (await pool.query(
    `SELECT id, status, completed_at, rows_accepted FROM file_import_batches WHERE user_id = $1 AND file_content_hash = $2`,
    [userId, fileContentHash]
  )).rows[0] || null;

  return {
    inspection,
    headerMapping,
    rowPreview,
    possibleMatches,
    fileContentHash,
    alreadyImported: !!existingBatch && existingBatch.status === 'COMPLETED',
    existingBatch,
  };
}

/**
 * Full commit: parse, map, register (or detect a duplicate of) a
 * file_import_batches row, then delegate the actual row-by-row write path
 * to csvImport.commitImport verbatim (no reimplementation). Returns the
 * batch record plus csvImport's own outcome summary.
 *
 * File-level idempotency: if this exact file's bytes were already
 * COMPLETED for this tenant, this function short-circuits and returns
 * { duplicateOfBatchId } WITHOUT calling commitImport again — this is a
 * stronger, cheaper guarantee than relying on row-level content-hash
 * collisions alone (mission's "file-level idempotency" requirement).
 */
async function commitFile(buffer, filename, { userId, sourceQuality, purchaseId = null, profile = 'core' } = {}) {
  if (!userId) throw new Error('commitFile: userId is required');
  if (sourceQuality !== 'REAL' && sourceQuality !== 'SEEDED') {
    throw new Error('commitFile: sourceQuality must be "REAL" or "SEEDED" — never inferred');
  }

  const fileContentHash = hashFileBytes(buffer);
  const pool = getPool();

  const existing = (await pool.query(
    `SELECT id, status FROM file_import_batches WHERE user_id = $1 AND file_content_hash = $2`,
    [userId, fileContentHash]
  )).rows[0];
  if (existing && existing.status === 'COMPLETED') {
    return { duplicateOfBatchId: existing.id, skipped: true };
  }

  const { inspection, mappedRows, headerMapping } = parseAndMapFile(buffer, filename, { profile });
  if (!inspection.supported) {
    throw new Error(inspection.error || 'commitFile: unsupported file type');
  }

  const batchIns = await pool.query(
    `INSERT INTO file_import_batches
       (user_id, source_system, filename, file_type, file_content_hash, mapping_profile, status, rows_total)
     VALUES ($1,'file_import',$2,$3,$4,$5,'STARTED',$6)
     ON CONFLICT (user_id, file_content_hash) DO UPDATE SET status = 'STARTED'
     RETURNING id`,
    [userId, filename, inspection.fileType, fileContentHash, profile, mappedRows.length]
  );
  const batchId = batchIns.rows[0].id;

  let result;
  try {
    result = await commitImport(mappedRows, { userId, sourceQuality, purchaseId });
  } catch (err) {
    await pool.query(
      `UPDATE file_import_batches SET status = 'FAILED', error_message = $1, completed_at = now() WHERE id = $2`,
      [err.message, batchId]
    );
    throw err;
  }

  const entitiesCreated = result.outcomes.filter((o) => o.status === 'IMPORTED' && o.supplierResolution && o.supplierResolution.verdict === 'NEW_CANDIDATE').length;
  const entitiesMatched = result.outcomes.filter((o) => o.status === 'IMPORTED' && o.supplierResolution && o.supplierResolution.verdict === 'CONFIRMED_MATCH').length;

  await pool.query(
    `UPDATE file_import_batches SET
       status = 'COMPLETED', completed_at = now(),
       rows_accepted = $1, rows_rejected = $2, rows_duplicate = $3, rows_review_required = $4,
       entities_created = $5, entities_matched = $6
     WHERE id = $7`,
    [
      result.imported, result.invalid + result.errored, result.skippedDuplicate,
      result.outcomes.filter((o) => o.status === 'IMPORTED' && o.supplierResolution && ['PROBABLE_MATCH', 'POSSIBLE_MATCH'].includes(o.supplierResolution.verdict)).length,
      entitiesCreated, entitiesMatched, batchId,
    ]
  );

  return { batchId, inspection, headerMapping, importResult: result, skipped: false };
}

module.exports = { parseAndMapFile, previewFile, commitFile, hashFileBytes };
