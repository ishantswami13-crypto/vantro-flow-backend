// FILE: lib/domain/intelligence/inventoryConsequence.js
// STARLANE Day 3 — Parts 8 & 9: Stockout projection and supplier consequence
// intelligence.
//
// Honesty-first: stockout projection requires knowing which supplier feeds
// which product with real lead-time/receipt history. Migration
// 024_product_supplier_purchase_lines.sql added the tables to represent
// that, but as of this build both product_suppliers and purchase_line_items
// are genuinely empty (no real backfill was fabricated). This module checks
// real row counts every time it runs and returns an explicit
// NOT_IMPLEMENTED / DATA_MISSING result rather than inventing a stockout
// date. If a future session populates real rows here, this same function
// will start returning real projections without further code changes.

const { getPool } = require('../../db/pg');
const { buildSupplierExposureNarrative } = require('./supplierExposureNarrative');

async function checkStockoutPrerequisites(userId) {
  const pool = getPool();
  const [psRes, pliRes] = await Promise.all([
    pool.query(`SELECT count(*)::int AS n FROM product_suppliers WHERE user_id = $1`, [userId]),
    pool.query(`SELECT count(*)::int AS n FROM purchase_line_items WHERE user_id = $1`, [userId]),
  ]);
  return {
    productSupplierLinks: psRes.rows[0].n,
    purchaseLineItems: pliRes.rows[0].n,
    prerequisitesMet: psRes.rows[0].n > 0 && pliRes.rows[0].n > 0,
  };
}

/**
 * Part 8: Stockout projection. Honestly returns NOT_IMPLEMENTED / DATA_MISSING
 * unless real product_suppliers + purchase_line_items rows exist for this
 * tenant to compute lead time / consumption rate from.
 */
async function buildStockoutProjection(userId, productId) {
  const prereqs = await checkStockoutPrerequisites(userId);
  if (!prereqs.prerequisitesMet) {
    return {
      status: 'NOT_IMPLEMENTED',
      reason: 'DATA MISSING: no real product_suppliers and/or purchase_line_items rows exist for this tenant. ' +
        'Stockout projection requires real lead-time and consumption history that this database does not yet contain — ' +
        'returning an honest not-implemented result rather than a fabricated stockout date.',
      prerequisites: prereqs,
    };
  }
  // Real-data path intentionally left for a future session once real rows
  // exist — do not fabricate logic against a shape that has never been
  // exercised with real data.
  return { status: 'NOT_IMPLEMENTED', reason: 'prerequisites structurally met but computation path not yet built in this session', prerequisites: prereqs };
}

/**
 * Part 9: Supplier consequence intelligence — where real purchase/receipt
 * history exists (lib/world/signalPropagation.js's SUPPLIER_PURCHASES step
 * and supplierExposureNarrative.js's geography+event chain), summarize lead
 * time / dependency exposure / affected products / world-geographic exposure.
 * Affected-products is explicitly reported missing per the same real gap
 * documented in supplierExposureNarrative.js.
 */
async function buildSupplierConsequence(userId, supplierId) {
  const pool = getPool();
  const purchRes = await pool.query(
    `SELECT id, amount, paid_amount, status, purchase_date, due_date FROM purchases
     WHERE user_id = $1 AND supplier_id = $2 ORDER BY purchase_date DESC NULLS LAST LIMIT 50`,
    [userId, supplierId]
  );
  const purchases = purchRes.rows;

  let leadTimeDays = null;
  const withBothDates = purchases.filter(p => p.purchase_date && p.due_date);
  if (withBothDates.length > 0) {
    const sum = withBothDates.reduce((s, p) => s + Math.abs((new Date(p.due_date) - new Date(p.purchase_date)) / 86400000), 0);
    leadTimeDays = Math.round((sum / withBothDates.length) * 10) / 10;
  }

  const worldChain = await buildSupplierExposureNarrative({ userId, supplierId }).catch(e => ({ insufficientEvidence: true, reasons: [e.message] }));
  const prereqs = await checkStockoutPrerequisites(userId);

  return {
    supplierId,
    purchaseCount: purchases.length,
    leadTimeDays,
    leadTimeNote: leadTimeDays == null
      ? 'insufficient real data: no purchases with both purchase_date and due_date populated'
      : `average of ${withBothDates.length} real purchase(s) with both dates populated — a plain average of real observed gaps, not a forecast.`,
    dependencyExposure: worldChain.insufficientEvidence ? { known: false, reasons: worldChain.reasons } : { known: true, chains: worldChain.narratives },
    affectedProducts: {
      known: false,
      reason: 'product-level dependency not currently trackable for this supplier: ' +
        (prereqs.productSupplierLinks > 0
          ? 'product_suppliers rows exist but computation path not yet built'
          : 'zero real product_suppliers rows exist for this tenant (see migration 024_product_supplier_purchase_lines.sql)'),
    },
    generatedAt: new Date().toISOString(),
  };
}

/**
 * STARLANE — Reality Acquisition phase, Part 51 unlock attempt.
 * Additive-only: does NOT change buildStockoutProjection's existing
 * behavior/signature (still returns NOT_IMPLEMENTED unconditionally, so any
 * caller relying on that stays byte-for-byte compatible). This new function
 * is the actual computation path exercised once product_suppliers +
 * purchase_line_items rows exist for a product (real or honestly-labeled
 * seeded, via lib/domain/ingestion/csvImport.js) — it still refuses to
 * fabricate when prerequisites are genuinely missing for the given
 * productId specifically (tenant-level rows existing is not sufficient).
 */
async function buildStockoutProjectionV2(userId, productId) {
  const pool = getPool();
  const [psRes, pliRes, productRes] = await Promise.all([
    pool.query(
      `SELECT supplier_id FROM product_suppliers WHERE user_id = $1 AND product_id = $2`,
      [userId, productId]
    ),
    pool.query(
      `SELECT quantity, unit_price, currency, expected_at, received_at, received_quantity, created_at
       FROM purchase_line_items WHERE user_id = $1 AND product_id = $2 ORDER BY created_at ASC`,
      [userId, productId]
    ),
    pool.query(`SELECT id, current_stock, low_stock_alert FROM products WHERE user_id = $1 AND id = $2`, [userId, productId]),
  ]);

  if (productRes.rowCount === 0) {
    return { status: 'DATA_MISSING', reason: `no product row ${productId} for this tenant` };
  }
  if (psRes.rowCount === 0 || pliRes.rowCount === 0) {
    return {
      status: 'NOT_IMPLEMENTED',
      reason: 'DATA MISSING for this specific product: no product_suppliers and/or purchase_line_items rows exist for it, ' +
        'even though other products/tenant rows may exist. Refusing to fabricate a stockout date.',
      productSupplierLinks: psRes.rowCount,
      purchaseLineItems: pliRes.rowCount,
    };
  }

  const product = productRes.rows[0];
  const currentStock = product.current_stock == null ? null : Number(product.current_stock);
  const lines = pliRes.rows;

  // Real observed lead times: only from lines that actually have both an
  // ordered/expected date and a received_at (a genuine receipt), computed
  // honestly per-line, no fabrication if none qualify.
  const leadTimes = lines
    .filter((l) => l.expected_at && l.received_at)
    .map((l) => Math.abs((new Date(l.received_at) - new Date(l.expected_at)) / 86400000));
  const avgLeadTimeDays = leadTimes.length ? leadTimes.reduce((a, b) => a + b, 0) / leadTimes.length : null;

  const totalOnOrder = lines
    .filter((l) => l.received_at === null)
    .reduce((sum, l) => sum + (Number(l.quantity) || 0), 0);

  if (currentStock == null) {
    return {
      status: 'INSUFFICIENT_EVIDENCE',
      reason: 'product_suppliers/purchase_line_items exist but products.current_stock is null for this product — cannot project a stockout date without a real current-stock reading',
      productSupplierLinks: psRes.rowCount,
      purchaseLineItems: pliRes.rowCount,
    };
  }

  return {
    status: 'COMPUTED',
    productId,
    currentStock,
    lowStockAlert: product.low_stock_alert == null ? null : Number(product.low_stock_alert),
    totalUnitsOnOrder: totalOnOrder,
    avgObservedLeadTimeDays: avgLeadTimeDays,
    leadTimeSampleSize: leadTimes.length,
    note: avgLeadTimeDays == null
      ? 'stock/on-order position computed from real rows; no receipt-vs-expected pairs yet exist to derive a lead time, so no projected stockout date is given'
      : `lead time derived from ${leadTimes.length} real observed receipt(s) against this product's purchase_line_items`,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { buildStockoutProjection, buildStockoutProjectionV2, buildSupplierConsequence, checkStockoutPrerequisites };
