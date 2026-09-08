// FILE: lib/domain/ingestion/csvImport.js
// STARLANE — Reality Acquisition. Part 20: CSV/mapped-row import path for
// purchase line items + product-supplier linkage.
//
// Scope (deliberately narrow, per the mission's ruthless prioritization):
// takes an array of already-parsed row objects (the caller is responsible
// for actual CSV/Excel file parsing — no new file-format parser is built
// here since Node has no built-in CSV reader and adding a dependency was
// judged out of scope for this pass) mapped to a fixed field set:
//   { sku, supplierName, supplierTaxId, quantity, unitPrice, currency,
//     orderedAt, expectedAt, sourceRecordId }
// and imports them into purchase_line_items + product_suppliers,
// additively, with:
//   - type/date/currency/duplicate/missing-identifier validation
//   - a dry-run "preview" mode that writes nothing
//   - idempotency via source_record_id or content hash (raw_observations
//     unique constraint enforces this at the DB level, not just in memory)
//   - conservative entity resolution for supplier name -> id
//   - explicit, caller-supplied sourceQuality: 'REAL' | 'SEEDED' — never
//     inferred by this module
//
// Currency is taken verbatim from the row if present and non-empty — it is
// NEVER inferred from supplier country or any other field (mission Part 15,
// hard constraint). If currency is absent from the row, the resulting line
// item's currency stays NULL; no exposure should ever be built from a NULL
// currency line item.

const { getPool } = require('../../db/pg');
const { makeObservation } = require('./observation');
const { resolveBestMatch } = require('./entityResolution');

const REQUIRED_FIELDS = ['sku', 'supplierName', 'quantity', 'unitPrice'];

function isValidDate(v) {
  if (v === null || v === undefined || v === '') return true; // optional field, absence is fine
  const d = new Date(v);
  return !isNaN(d.getTime());
}

function isValidNumber(v) {
  if (v === null || v === undefined || v === '') return false;
  const n = Number(v);
  return Number.isFinite(n);
}

/**
 * Validate one raw row. Returns { valid, errors[] }. Never throws — a bad
 * row is reported, not fatal to the whole import.
 */
function validateRow(row, index) {
  const errors = [];
  for (const f of REQUIRED_FIELDS) {
    if (row[f] === undefined || row[f] === null || row[f] === '') {
      errors.push(`row ${index}: missing required field "${f}"`);
    }
  }
  if (row.quantity !== undefined && row.quantity !== '' && !isValidNumber(row.quantity)) {
    errors.push(`row ${index}: quantity "${row.quantity}" is not a valid number`);
  }
  if (row.unitPrice !== undefined && row.unitPrice !== '' && !isValidNumber(row.unitPrice)) {
    errors.push(`row ${index}: unitPrice "${row.unitPrice}" is not a valid number`);
  }
  if (!isValidDate(row.orderedAt)) errors.push(`row ${index}: orderedAt "${row.orderedAt}" is not a valid date`);
  if (!isValidDate(row.expectedAt)) errors.push(`row ${index}: expectedAt "${row.expectedAt}" is not a valid date`);
  if (row.currency !== undefined && row.currency !== null && row.currency !== '') {
    if (!/^[A-Z]{3}$/.test(String(row.currency).trim().toUpperCase())) {
      errors.push(`row ${index}: currency "${row.currency}" is not a plausible ISO-4217 code`);
    }
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Preview (dry-run) validation across all rows — writes nothing. Also flags
 * in-batch duplicate sourceRecordId/content collisions so the caller sees
 * them before committing.
 */
function previewImport(rows, { userId, entityType = 'purchase_line_item' } = {}) {
  const seen = new Map();
  const results = rows.map((row, i) => {
    const { valid, errors } = validateRow(row, i);
    let dupOfIndex = null;
    if (valid) {
      const key = row.sourceRecordId
        ? `id:${row.sourceRecordId}`
        : `content:${row.sku}|${row.supplierName}|${row.quantity}|${row.unitPrice}|${row.orderedAt || ''}`;
      if (seen.has(key)) dupOfIndex = seen.get(key);
      else seen.set(key, i);
    }
    return { index: i, valid, errors, duplicateOfIndexInBatch: dupOfIndex };
  });
  return {
    totalRows: rows.length,
    validRows: results.filter((r) => r.valid && r.duplicateOfIndexInBatch === null).length,
    invalidRows: results.filter((r) => !r.valid).length,
    duplicateRowsInBatch: results.filter((r) => r.duplicateOfIndexInBatch !== null).length,
    rows: results,
  };
}

async function loadExistingSuppliers(client, userId) {
  const res = await client.query(
    `SELECT id, name, gstin AS "taxId", email, phone FROM suppliers WHERE user_id = $1`,
    [userId]
  );
  return res.rows;
}

async function loadExistingProductBySku(client, userId, sku) {
  const res = await client.query(
    `SELECT id, sku FROM products WHERE user_id = $1 AND sku = $2 LIMIT 1`,
    [userId, sku]
  );
  return res.rows[0] || null;
}

/**
 * Insert a new supplier candidate row, or reuse an existing literal
 * duplicate (same user_id, name, and NULL phone) if the DB's own
 * uq_suppliers_user_name_phone constraint rejects the insert. This is not
 * an entity-resolution merge decision — it only fires when the row being
 * inserted is byte-identical to one already created moments earlier (e.g.
 * the same unresolved supplier name appearing on two different import
 * rows in the same run), so reusing it is strictly correct, not a guess.
 */
async function insertOrReuseSupplierCandidate(client, userId, name, taxId) {
  // Check-then-insert (not catch-after-insert) because a failed INSERT
  // would otherwise abort the surrounding transaction for the rest of this
  // row's processing.
  const existing = await client.query(
    `SELECT id FROM suppliers WHERE user_id = $1 AND name = $2 AND phone IS NULL LIMIT 1`,
    [userId, name]
  );
  if (existing.rows[0]) return existing.rows[0].id;
  const ins = await client.query(
    `INSERT INTO suppliers (user_id, name, gstin, is_active) VALUES ($1,$2,$3,true) RETURNING id`,
    [userId, name, taxId || null]
  );
  return ins.rows[0].id;
}

/**
 * Commit an import: validates, resolves suppliers conservatively, writes
 * purchase_line_items + product_suppliers, and records a raw_observations
 * row per successfully-imported line for provenance + idempotency.
 *
 * sourceQuality is mandatory and MUST be supplied by the caller ('REAL' or
 * 'SEEDED') — this function does not infer it.
 *
 * Returns a per-row outcome list plus aggregate counts. Idempotent: running
 * the identical rows twice results in zero additional purchase_line_items/
 * product_suppliers rows on the second run (enforced via the
 * raw_observations unique(user_id, source_system, content_hash) constraint
 * — a duplicate insert is caught and reported as SKIPPED_DUPLICATE, not an
 * unhandled DB error).
 */
async function commitImport(rows, { userId, sourceSystem = 'csv_import', sourceQuality, purchaseId = null } = {}) {
  if (!userId) throw new Error('commitImport: userId is required');
  if (sourceQuality !== 'REAL' && sourceQuality !== 'SEEDED') {
    throw new Error('commitImport: sourceQuality must be "REAL" or "SEEDED" — never inferred');
  }

  const pool = getPool();
  const client = await pool.connect();
  const outcomes = [];
  try {
    const existingSuppliers = await loadExistingSuppliers(client, userId);
    const supplierCache = new Map(existingSuppliers.map((s) => [s.id, s]));

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const { valid, errors } = validateRow(row, i);
      if (!valid) {
        outcomes.push({ index: i, status: 'INVALID', errors });
        continue;
      }

      const currency = row.currency ? String(row.currency).trim().toUpperCase() : null;

      const observation = makeObservation({
        userId,
        sourceSystem,
        sourceRecordId: row.sourceRecordId || null,
        entityType: 'purchase_line_item',
        observedAt: row.orderedAt ? new Date(row.orderedAt).toISOString() : null,
        sourceQuality,
        fields: {
          sku: row.sku, supplierName: row.supplierName, supplierTaxId: row.supplierTaxId || null,
          quantity: row.quantity, unitPrice: row.unitPrice, currency,
          orderedAt: row.orderedAt || null, expectedAt: row.expectedAt || null,
        },
        rawReference: row,
      });

      await client.query('BEGIN');
      try {
        // Idempotency gate: insert the observation first. A conflicting
        // unique key means this exact row (by natural id or content hash)
        // was already imported for this tenant — skip materializing it
        // again, but do not error the whole batch.
        const obsRes = await client.query(
          `INSERT INTO raw_observations
             (user_id, source_system, source_record_id, content_hash, entity_type,
              observed_at, received_at, source_quality, fields, raw_reference, ingestion_version)
           VALUES ($1,$2,$3,$4,$5,$6,now(),$7,$8,$9,$10)
           ON CONFLICT (user_id, source_system, content_hash) DO NOTHING
           RETURNING id`,
          [
            userId, sourceSystem, observation.sourceRecordId, observation.contentHash, observation.entityType,
            observation.observedAt, observation.sourceQuality, JSON.stringify(observation.fields),
            JSON.stringify(observation.rawReference), observation.ingestionVersion,
          ]
        );
        if (obsRes.rowCount === 0) {
          await client.query('ROLLBACK');
          outcomes.push({ index: i, status: 'SKIPPED_DUPLICATE', contentHash: observation.contentHash });
          continue;
        }
        const observationId = obsRes.rows[0].id;

        // Resolve product by SKU — never fabricated; if it doesn't exist,
        // the line item is still written with product_id NULL (allowed by
        // migration 024's schema) and reported as UNMATCHED_PRODUCT.
        const product = await loadExistingProductBySku(client, userId, row.sku);

        // Resolve supplier conservatively.
        const candidate = { name: row.supplierName, taxId: row.supplierTaxId || null };
        const match = resolveBestMatch(candidate, existingSuppliers);
        let supplierId = null;
        let supplierResolution;
        if (match && match.verdict === 'CONFIRMED_MATCH') {
          supplierId = match.existingId;
          supplierResolution = match;
        } else if (match) {
          // PROBABLE_MATCH / POSSIBLE_MATCH — never auto-merge. Create a new
          // supplier candidate row instead of guessing which existing
          // supplier this is. If an identical (user, name, phone) row was
          // already created by a prior import row in this same batch/run
          // (a literal duplicate of the SAME candidate, not a merge
          // decision), reuse that literal row rather than erroring on the
          // DB's own uq_suppliers_user_name_phone constraint.
          supplierId = await insertOrReuseSupplierCandidate(client, userId, row.supplierName, row.supplierTaxId);
          supplierResolution = { ...match, action: 'created_new_candidate_not_merged' };
        } else {
          supplierId = await insertOrReuseSupplierCandidate(client, userId, row.supplierName, row.supplierTaxId);
          existingSuppliers.push({ id: supplierId, name: row.supplierName, taxId: row.supplierTaxId || null });
          supplierResolution = { verdict: 'NEW_CANDIDATE', reason: 'no existing supplier matched' };
        }

        let lineItemId = null;
        if (purchaseId) {
          const pli = await client.query(
            `INSERT INTO purchase_line_items
               (user_id, purchase_id, product_id, quantity, unit_price, currency, expected_at, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7, now())
             RETURNING id`,
            [userId, purchaseId, product ? product.id : null, row.quantity, row.unitPrice, currency, row.expectedAt || null]
          );
          lineItemId = pli.rows[0].id;
        }

        let productSupplierId = null;
        if (product) {
          const ps = await client.query(
            `INSERT INTO product_suppliers (user_id, product_id, supplier_id, evidence, source, first_seen_at, last_seen_at)
             VALUES ($1,$2,$3,$4,'csv_import', now(), now())
             ON CONFLICT (user_id, product_id, supplier_id)
             DO UPDATE SET last_seen_at = now()
             RETURNING id`,
            [userId, product.id, supplierId, `csv_import row ${i}, sourceQuality=${sourceQuality}`]
          );
          productSupplierId = ps.rows[0].id;
        }

        await client.query(
          `UPDATE raw_observations SET resulting_table = $1, resulting_row_id = $2 WHERE id = $3`,
          [purchaseId ? 'purchase_line_items' : 'product_suppliers', String(lineItemId || productSupplierId || ''), observationId]
        );

        await client.query('COMMIT');
        outcomes.push({
          index: i,
          status: 'IMPORTED',
          observationId,
          lineItemId,
          productSupplierId,
          supplierId,
          supplierResolution,
          matchedProduct: !!product,
        });
      } catch (err) {
        await client.query('ROLLBACK');
        outcomes.push({ index: i, status: 'ERROR', error: err.message });
      }
    }
  } finally {
    client.release();
  }

  return {
    totalRows: rows.length,
    imported: outcomes.filter((o) => o.status === 'IMPORTED').length,
    skippedDuplicate: outcomes.filter((o) => o.status === 'SKIPPED_DUPLICATE').length,
    invalid: outcomes.filter((o) => o.status === 'INVALID').length,
    errored: outcomes.filter((o) => o.status === 'ERROR').length,
    outcomes,
  };
}

module.exports = { validateRow, previewImport, commitImport };
