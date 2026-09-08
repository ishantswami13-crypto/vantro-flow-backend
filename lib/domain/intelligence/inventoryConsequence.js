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

module.exports = { buildStockoutProjection, buildSupplierConsequence, checkStockoutPrerequisites };
