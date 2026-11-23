'use strict';
// lib/routes/operations.js — real operating data for the supplier-delay loop.
//
//   POST /api/decisions/operations/import/preview   file + kind (+ options): writes nothing
//   POST /api/decisions/operations/import/commit    file + kind + confirmed options: one transaction
//   GET  /api/decisions/operations/imports          recent import batches
//   GET  /api/decisions/operations/open-orders      open customer order lines, with what is missing
//   GET  /api/decisions/purchase-lines/:id/receipts receipt history for one inbound line
//   POST /api/decisions/purchase-lines/:id/receipts record a receipt or correction
//
// Registered on the decisions router (same auth middleware, same error
// handling). The tenant is always the verified JWT's user id; nothing here
// reads a tenant id from the body, query or file. After a commit or a
// receipt, discovery re-runs so the supplier-delay decisions reflect the new
// data in the same response. Nothing here sends anything to anyone.

const multer = require('multer');
const { safeLog } = require('../observability/logger');
const { previewOperationalImport, commitOperationalImport, KINDS, KIND_ERROR } = require('../domain/operations/operationalImport');
const { recordReceipt, listReceipts } = require('../domain/inventory/goodsReceipt');

// Resource limits: one file of at most 15 MB, held in memory only for the
// request; at most 50,000 data rows (readLedgerFile). Nothing is written to
// disk. A file over the limit is refused with 413 before it is parsed.
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const multerSingle = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 10, fieldSize: 256 * 1024 } }).single('file');
function singleFile(req, res, next) {
  multerSingle(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'The file is larger than 15 MB. Split it into smaller files (up to 50,000 rows each) and import them one at a time.' });
    if (err instanceof multer.MulterError) return res.status(400).json({ error: `The upload could not be read (${err.code}). Send one file as "file".` });
    return next(err);
  });
}

function parseOptions(req) {
  if (!req.body || req.body.options == null || req.body.options === '') return null;
  if (typeof req.body.options === 'object') return req.body.options;
  try { return JSON.parse(req.body.options); } catch { const e = new Error('options must be JSON'); e.status = 400; throw e; }
}

function kindOf(req) {
  const k = String((req.body && req.body.kind) || '').trim();
  if (!KINDS.includes(k)) { const e = new Error(KIND_ERROR); e.status = 400; throw e; }
  return k;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function registerOperationsRoutes(router, { pool, authenticatedUserId: tenantFromJwt, sendError, discover, activeStatuses }) {
  // Every tenant id here is a users.id UUID from a verified JWT. Anything
  // else is refused before it reaches a query.
  const authenticatedUserId = (req) => {
    const id = tenantFromJwt(req);
    if (!id || !UUID_RE.test(String(id))) { const e = new Error('Sign in again: this session does not identify a business.'); e.status = 401; throw e; }
    return id;
  };
  // Discovery after a data change. A failure here never undoes the change
  // that was just saved; it is reported next to it.
  async function rediscover(req, userId) {
    try {
      const result = await discover(userId, req);
      if (result.status === 'STOPPED') return { discovery: null, discoveryError: 'Decision discovery is stopped by a kill switch, so decisions were not recalculated.' };
      return {
        discovery: { status: result.status, discovered: result.discovered, revised: result.revised, resolved: result.resolved, degraded: result.degraded, watched: (result.watched || []).filter((w) => w.kind === 'SUPPLIER_DELAY' || w.purchaseLineItemId) },
        discoveryError: null,
      };
    } catch (err) {
      safeLog('error', '[operations] discovery after change failed', { userId, error: err.message });
      return { discovery: null, discoveryError: 'Saved, but recalculating decisions failed. Run discovery again from Decisions.' };
    }
  }

  async function activeDelayDecisions(userId) {
    const r = await pool.query(
      `SELECT id, title, status, dedup_key FROM decisions WHERE user_id = $1 AND kind = 'SUPPLIER_DELAY' AND status = ANY($2)
        ORDER BY created_at DESC LIMIT 20`,
      [userId, activeStatuses]
    );
    return r.rows;
  }

  router.post('/operations/import/preview', singleFile, async (req, res) => {
    try {
      const userId = authenticatedUserId(req);
      if (!req.file) return res.status(400).json({ error: 'Attach the file as "file".' });
      const kind = kindOf(req);
      const out = await previewOperationalImport(pool, userId, kind, req.file.buffer, req.file.originalname, parseOptions(req));
      if (!out.ok) return res.status(out.status || 400).json({ error: out.error });
      res.json(out);
    } catch (err) {
      sendError(res, req, err);
    }
  });

  router.post('/operations/import/commit', singleFile, async (req, res) => {
    try {
      const userId = authenticatedUserId(req);
      if (!req.file) return res.status(400).json({ error: 'Attach the file as "file".' });
      const kind = kindOf(req);
      const options = parseOptions(req);
      if (!options) return res.status(400).json({ error: 'Send the confirmed column mapping as "options".' });
      const out = await commitOperationalImport(pool, userId, kind, req.file.buffer, req.file.originalname, options, { correlationId: req.requestId || null });
      if (!out.ok) return res.status(out.status || 400).json({ error: out.error, errors: out.errors || [] });
      const after = out.alreadyImported ? { discovery: null, discoveryError: null } : await rediscover(req, userId);
      res.json({ import: { batchId: out.batchId, alreadyImported: out.alreadyImported, importedAt: out.importedAt || null }, summary: out.summary, ...after, supplierDelayDecisions: await activeDelayDecisions(userId) });
    } catch (err) {
      sendError(res, req, err);
    }
  });

  router.get('/operations/imports', async (req, res) => {
    try {
      const userId = authenticatedUserId(req);
      const r = await pool.query(
        `SELECT id, source_system, filename, mapping_profile, status, completed_at, rows_total, rows_accepted, rows_rejected, rows_review_required, error_message
           FROM file_import_batches WHERE user_id = $1 AND source_system LIKE 'ops_import:%' ORDER BY created_at DESC LIMIT 20`,
        [userId]
      );
      res.json({ imports: r.rows.map((b) => ({ ...b, kind: b.source_system.replace('ops_import:', ''), sourceSystem: String(b.mapping_profile || '').split(':').slice(1).join(':') || null })) });
    } catch (err) {
      sendError(res, req, err);
    }
  });

  // Open order lines as the supplier-delay engine sees them, with what each
  // one is missing for a check. Observed values only; nothing computed here.
  router.get('/operations/open-orders', async (req, res) => {
    try {
      const userId = authenticatedUserId(req);
      const r = await pool.query(
        `SELECT oli.id, oli.order_id, o.customer_name, o.external_ref AS order_ref, o.status AS order_status, oli.line_status,
                oli.product_id, p.name AS product_name, p.sku, oli.sku_as_imported, oli.product_name_as_imported,
                oli.quantity, oli.outstanding_quantity, oli.unit_price, oli.currency, oli.needed_by, oli.source_system, oli.source_updated_at
           FROM order_line_items oli
           JOIN orders o ON o.id = oli.order_id AND o.user_id = oli.user_id
           LEFT JOIN products p ON p.id = oli.product_id AND p.user_id = oli.user_id
          WHERE oli.user_id = $1
            AND lower(COALESCE(o.status, '')) NOT IN ('delivered','cancelled','canceled','completed','closed','dispatched')
            AND lower(COALESCE(oli.line_status, '')) NOT IN ('delivered','cancelled','canceled','completed','closed','dispatched')
            AND COALESCE(oli.outstanding_quantity, oli.quantity) > 0
          ORDER BY oli.needed_by ASC NULLS LAST, o.customer_name LIMIT 500`,
        [userId]
      );
      const lines = r.rows.map((l) => ({
        ...l,
        missing: [
          !l.product_id && 'product link',
          !l.needed_by && 'promised date',
          l.outstanding_quantity == null && l.source_system && 'outstanding quantity (full ordered quantity assumed)',
          l.unit_price == null && 'price',
          l.unit_price != null && !l.currency && l.source_system && 'currency',
        ].filter(Boolean),
      }));
      res.json({ lines, checkable: lines.filter((l) => l.product_id && l.needed_by).length });
    } catch (err) {
      sendError(res, req, err);
    }
  });

  router.get('/purchase-lines/:id/receipts', async (req, res) => {
    try {
      const out = await listReceipts(pool, authenticatedUserId(req), req.params.id);
      if (!out) return res.status(404).json({ error: 'Purchase line not found' });
      res.json(out);
    } catch (err) {
      sendError(res, req, err);
    }
  });

  router.post('/purchase-lines/:id/receipts', async (req, res) => {
    try {
      const userId = authenticatedUserId(req);
      const out = await recordReceipt(pool, userId, req.params.id, req.body || {}, { correlationId: req.requestId || null });
      if (!out.ok) return res.status(out.status).json(out.body);
      // A retry of a receipt already recorded changes nothing, so it does not
      // re-run discovery either.
      const after = out.body.duplicate ? { discovery: null, discoveryError: null } : await rediscover(req, userId);
      res.status(out.status).json({ ...out.body, ...after, supplierDelayDecisions: await activeDelayDecisions(userId) });
    } catch (err) {
      sendError(res, req, err);
    }
  });
}

module.exports = { registerOperationsRoutes };
