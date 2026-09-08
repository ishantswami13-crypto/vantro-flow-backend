// FILE: lib/world/signalPropagation.js
// World Intelligence Phase 3, Part B — Phase 13 (Signal Propagation).
//
// A business_signal today stops at "this business_entity is exposed to this
// world_entity". This module walks whatever REAL internal relationships
// this schema actually has, starting from the signal's business entity,
// and returns a structured propagation path. It NEVER invents a missing
// relationship — every step is a real FK/column lookup, and the walk stops
// (with an explicit, honest "gap" record) the moment real data runs out.
//
// SCHEMA FACTS THIS FILE RELIES ON (verified directly against the dev DB,
// see STARLANE_WORLD_INTELLIGENCE_PHASE_3_REPORT.md for the query used):
//   - suppliers(id, user_id, name, ...) — no direct link to products.
//   - purchases(id, user_id, supplier_id UUID REFERENCES suppliers, items JSONB, ...)
//     supplier_id IS a real FK. `items` is an unstructured JSONB free-text
//     field that, in every row inspected in the dev DB, is NULL — it is NOT
//     a reliable product reference and is never treated as one here.
//   - products(id, user_id, sku, current_stock NUMERIC, low_stock_alert NUMERIC, ...)
//     — no supplier_id column. There is NO real FK from a product to a
//     supplier anywhere in this schema.
//   - orders(id, user_id, items JSONB, status, ...) — no product_id/FK
//     either; `items` is JSONB, unstructured, and not a reliable link.
//
// CONSEQUENCE (an honest, documented gap, not a workaround):
//   SUPPLIER exposure signals can propagate to real PURCHASES rows (via the
//   real supplier_id FK) but CANNOT propagate further to PRODUCT/INVENTORY/
//   OPEN_ORDERS — no real join exists. PRODUCT exposure signals CAN
//   propagate directly to real INVENTORY (current_stock/low_stock_alert)
//   but CANNOT propagate to OPEN_ORDERS — no real product<->order join
//   exists either. Both gaps are recorded as explicit `gap` steps rather
//   than silently stopping.
const { getPool } = require('../db/pg');

function gapStep(reason) {
  return { step: 'GAP', reason };
}

/**
 * @param {string} userId
 * @param {object} signal - a business_signals row (must have business_exposure_id,
 *   related_entity_type/related_entity_id or the caller can supply the exposure).
 * @param {object} [exposure] - the business_exposure row for this signal, if already loaded.
 * @returns {Promise<object[]>} propagation path steps, each { step, ...data }
 */
async function propagateSignal(userId, signal, exposure = null) {
  const pool = getPool();
  const path = [];

  if (!exposure && signal.business_exposure_id) {
    const res = await pool.query(
      `SELECT * FROM business_exposure WHERE id = $1 AND user_id = $2`,
      [signal.business_exposure_id, userId]
    );
    exposure = res.rows[0] || null;
  }

  const entityType = exposure ? exposure.business_entity_type : signal.related_entity_type;
  const entityId = exposure ? exposure.business_entity_id : signal.related_entity_id;

  path.push({ step: 'EXPOSURE', businessEntityType: entityType, businessEntityId: entityId, exposureId: exposure ? exposure.id : null });

  if (entityType === 'supplier') {
    const supRes = await pool.query(`SELECT * FROM suppliers WHERE id = $1 AND user_id = $2`, [entityId, userId]);
    const supplier = supRes.rows[0];
    if (!supplier) {
      path.push(gapStep(`supplier ${entityId} not found for this tenant — cannot propagate further`));
      return path;
    }
    path.push({ step: 'SUPPLIER', id: supplier.id, name: supplier.name, isActive: supplier.is_active });

    const purchRes = await pool.query(
      `SELECT id, amount, paid_amount, status, purchase_date FROM purchases
       WHERE user_id = $1 AND supplier_id = $2 ORDER BY purchase_date DESC NULLS LAST LIMIT 50`,
      [userId, supplier.id]
    );
    path.push({
      step: 'SUPPLIER_PURCHASES',
      count: purchRes.rows.length,
      unpaidCount: purchRes.rows.filter(r => r.status === 'unpaid').length,
      totalAmount: purchRes.rows.reduce((s, r) => s + Number(r.amount || 0), 0),
      // real column values only, no derived financial estimate
      note: 'Real purchases.supplier_id FK — count/amount are real stored values, not estimates.',
    });

    // Real gap: no supplier_id/FK exists on products, and purchases.items is
    // unstructured JSONB (observed NULL in practice) — never treated as a join key.
    path.push(gapStep(
      'No real supplier->product relationship exists in this schema (products has no supplier_id column; ' +
      'purchases.items is unstructured JSONB and is never treated as a product reference). ' +
      'Propagation honestly stops here rather than guessing which products this supplier affects.'
    ));
    return path;
  }

  if (entityType === 'product') {
    const prodRes = await pool.query(`SELECT * FROM products WHERE id = $1 AND user_id = $2`, [entityId, userId]);
    const product = prodRes.rows[0];
    if (!product) {
      path.push(gapStep(`product ${entityId} not found for this tenant — cannot propagate further`));
      return path;
    }
    path.push({ step: 'PRODUCT', id: product.id, name: product.name, sku: product.sku });

    const currentStock = product.current_stock != null ? Number(product.current_stock) : null;
    const lowStockAlert = product.low_stock_alert != null ? Number(product.low_stock_alert) : null;
    const isLowStock = currentStock != null && lowStockAlert != null && currentStock <= lowStockAlert;
    path.push({
      step: 'INVENTORY',
      current_stock: currentStock,
      low_stock_alert: lowStockAlert,
      isLowStock,
      note: 'current_stock/low_stock_alert are real stored products columns, surfaced as-is — never recomputed or estimated.',
    });

    // Real gap: orders has no product_id/FK; orders.items is unstructured JSONB.
    path.push(gapStep(
      'No real product->order relationship exists in this schema (orders has no product_id column; ' +
      'orders.items is unstructured JSONB and is never treated as a product reference). ' +
      'Propagation honestly stops here rather than guessing which open orders depend on this product.'
    ));
    return path;
  }

  // Other business_entity_type values (customer, purchase, sale, order) —
  // no further propagation rule is implemented for them yet; document, don't guess.
  path.push(gapStep(`No propagation rule implemented for business_entity_type "${entityType}" yet.`));
  return path;
}

// STARLANE Day 3 — Part 6: Propagation v2.
// Extends (does not duplicate) propagateSignal with explicit order labeling
// (0 = exposure/source, 1 = first-order real relationship, 2 = second-order
// real relationship) and "may affect"/"creates exposure" language instead of
// causal claims. Depth is capped at 3 real steps beyond the source per the
// spec; since this schema's real FKs bottom out after one hop (supplier->
// purchases, product->inventory) today, second-order steps are honestly
// reported as GAP rather than invented.
function withOrderLabels(path) {
  let order = 0;
  return path.map((step) => {
    if (step.step === 'EXPOSURE') {
      return { ...step, order: 0, relationship: 'SOURCE', language: 'This is the exposed business entity itself.' };
    }
    if (step.step === 'GAP') {
      order += 1;
      return { ...step, order, relationship: 'UNKNOWN', language: 'No further real relationship exists to walk — reported as a gap, not invented.' };
    }
    order += 1;
    const relationship = order === 1 ? 'FIRST_ORDER' : order === 2 ? 'SECOND_ORDER' : `ORDER_${order}`;
    const language = step.step === 'SUPPLIER_PURCHASES' || step.step === 'INVENTORY'
      ? 'may affect / creates exposure for'
      : 'is directly related to';
    return { ...step, order, relationship, language };
  });
}

async function propagateSignalV2(userId, signal, exposure = null) {
  const basePath = await propagateSignal(userId, signal, exposure);
  const MAX_DEPTH = 3;
  const labeled = withOrderLabels(basePath).filter(s => (s.order == null || s.order <= MAX_DEPTH));
  return {
    maxDepth: MAX_DEPTH,
    steps: labeled,
    note: 'Each step past order 0 is an explicit real relationship (or an honest GAP). Language is "may affect"/"creates exposure for", never a causal claim.',
  };
}

module.exports = { propagateSignal, propagateSignalV2 };
