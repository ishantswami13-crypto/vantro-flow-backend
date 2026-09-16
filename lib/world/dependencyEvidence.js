// FILE: lib/world/dependencyEvidence.js
// World Intelligence Phase 3, Part B — real, queryable business-dependency
// evidence used by materiality.js and signalRanking.js. Every field here is
// a real COUNT()/SUM()/comparison against this tenant's own real tables —
// never an invented figure.
//
// Phase 3C correction: openOrdersCount used to be permanently null with the
// comment "no real FK exists" — untrue. product_suppliers (many-to-many,
// populated) links suppliers to products, and real order rows carry a real
// product_id inside their items JSONB (see signalPropagation.js's header
// comment for the live-verified schema facts). Both entity types now compute
// a real open-order count instead of an unconditional null.
const { getPool } = require('../db/pg');

const CLOSED_ORDER_STATUSES = ['delivered', 'cancelled'];

// Real count of orders (status not delivered/cancelled) whose items JSONB
// references any of the given product IDs. Empty productIds -> 0, not null
// — "this supplier has zero linked products" is a real, known fact, distinct
// from "we don't know" (which stays null elsewhere in this file).
async function countOpenOrdersForProducts(pool, userId, productIds) {
  if (!productIds || productIds.length === 0) return 0;
  const res = await pool.query(
    `SELECT COUNT(DISTINCT o.id)::int AS n
     FROM orders o, jsonb_array_elements(o.items) AS item
     WHERE o.user_id = $1 AND item->>'product_id' = ANY($2::text[]) AND o.status <> ALL($3::text[])`,
    [userId, productIds, CLOSED_ORDER_STATUSES]
  );
  return res.rows[0].n;
}

// A raw-material product is rarely ordered directly — real demand sits on
// the finished product(s) it's built into (real table: product_components).
// Given a set of component product IDs, returns that same set PLUS every
// finished_product_id that consumes any of them, so order-counting covers
// both "ordered directly" and "ordered as part of something built from it" —
// mirroring signalPropagation.js's COMPONENT_OF hop exactly, not a separate
// looser rule.
async function expandWithFinishedProducts(pool, userId, productIds) {
  if (!productIds || productIds.length === 0) return [];
  const bom = await pool.query(
    `SELECT DISTINCT finished_product_id FROM product_components WHERE user_id = $1 AND component_product_id = ANY($2::uuid[])`,
    [userId, productIds]
  );
  return [...new Set([...productIds, ...bom.rows.map(r => r.finished_product_id)])];
}

/**
 * @param {string} userId
 * @param {string} businessEntityType - 'supplier' | 'product' | other
 * @param {string} businessEntityId
 * @returns {Promise<object>} dependency evidence, fields null where not applicable to this entity type
 */
async function computeDependencyEvidence(userId, businessEntityType, businessEntityId) {
  const pool = getPool();

  const evidence = {
    isSoleOrPrimarySupplier: null,
    supplierPurchaseShare: null,
    productIsLowStock: null,
    openOrdersCount: null,
  };

  if (businessEntityType === 'supplier') {
    const [thisSupplier, allSuppliers] = await Promise.all([
      pool.query(`SELECT COALESCE(SUM(amount),0)::numeric AS total, COUNT(*)::int AS n FROM purchases WHERE user_id = $1 AND supplier_id = $2`, [userId, businessEntityId]),
      pool.query(`SELECT COALESCE(SUM(amount),0)::numeric AS total FROM purchases WHERE user_id = $1`, [userId]),
    ]);
    const thisTotal = Number(thisSupplier.rows[0].total);
    const allTotal = Number(allSuppliers.rows[0].total);
    evidence.supplierPurchaseShare = allTotal > 0 ? Number((thisTotal / allTotal).toFixed(4)) : null;

    // "Sole or primary supplier": real check — is this the only ACTIVE
    // supplier this tenant has ever purchased from (real distinct-supplier
    // count over real purchases rows), never a guess.
    const distinctSuppliers = await pool.query(
      `SELECT COUNT(DISTINCT supplier_id)::int AS n FROM purchases WHERE user_id = $1 AND supplier_id IS NOT NULL`,
      [userId]
    );
    evidence.isSoleOrPrimarySupplier = distinctSuppliers.rows[0].n <= 1 && thisSupplier.rows[0].n > 0;

    // Real path: supplier -> product_suppliers -> products this supplier is
    // linked to -> real open orders referencing any of those products.
    const linked = await pool.query(
      `SELECT product_id FROM product_suppliers WHERE user_id = $1 AND supplier_id = $2`,
      [userId, businessEntityId]
    );
    const withFinished = await expandWithFinishedProducts(pool, userId, linked.rows.map(r => r.product_id));
    evidence.openOrdersCount = await countOpenOrdersForProducts(pool, userId, withFinished);
  }

  if (businessEntityType === 'product') {
    const prod = await pool.query(`SELECT current_stock, low_stock_alert FROM products WHERE id = $1 AND user_id = $2`, [businessEntityId, userId]);
    if (prod.rows.length > 0) {
      const { current_stock, low_stock_alert } = prod.rows[0];
      evidence.productIsLowStock = current_stock != null && low_stock_alert != null
        ? Number(current_stock) <= Number(low_stock_alert)
        : null;
    }
    const withFinished = await expandWithFinishedProducts(pool, userId, [businessEntityId]);
    evidence.openOrdersCount = await countOpenOrdersForProducts(pool, userId, withFinished);
  }

  return evidence;
}

module.exports = { computeDependencyEvidence };
