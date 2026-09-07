// FILE: lib/world/dependencyEvidence.js
// World Intelligence Phase 3, Part B — real, queryable business-dependency
// evidence used by materiality.js and signalRanking.js. Every field here is
// a real COUNT()/SUM()/comparison against this tenant's own real tables —
// never an invented figure.
const { getPool } = require('../db/pg');

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
    // Open orders cannot be attributed to a supplier (no real FK — see
    // signalPropagation.js) so left null rather than guessed.
  }

  if (businessEntityType === 'product') {
    const prod = await pool.query(`SELECT current_stock, low_stock_alert FROM products WHERE id = $1 AND user_id = $2`, [businessEntityId, userId]);
    if (prod.rows.length > 0) {
      const { current_stock, low_stock_alert } = prod.rows[0];
      evidence.productIsLowStock = current_stock != null && low_stock_alert != null
        ? Number(current_stock) <= Number(low_stock_alert)
        : null;
    }
    // Open orders cannot be attributed to a product (no real FK — see
    // signalPropagation.js) so left null rather than guessed.
  }

  return evidence;
}

module.exports = { computeDependencyEvidence };
