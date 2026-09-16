// FILE: lib/world/signalPropagation.js
// World Intelligence Phase 3, Part B — Phase 13 (Signal Propagation).
//
// A business_signal today stops at "this business_entity is exposed to this
// world_entity". This module walks whatever REAL internal relationships
// this schema actually has, starting from the signal's business entity,
// and returns a structured propagation path. It NEVER invents a missing
// relationship — every step is a real FK/column/JSONB-field lookup, and the
// walk stops (with an explicit, honest "gap" record) the moment real data
// runs out.
//
// CORRECTION (Phase 3C): the original version of this file claimed "no real
// supplier->product relationship exists" and "no real product->order
// relationship exists" and stopped at a GAP in both cases. Re-inspecting the
// actual dev DB schema (not just the columns this file's author already knew
// about) found both relationships DO exist, just not as a direct FK on
// `products`/`orders`:
//   - product_suppliers(product_id, supplier_id, user_id, source, first_seen_at, ...)
//     is a real, populated (10 rows in dev DB) many-to-many join table —
//     already used elsewhere in the codebase (lib/domain/intelligence/
//     supplyChainOrchestrator.js, lib/world/worldEventConsequence.js) but
//     never wired into this propagation engine. `source` carries real
//     provenance ('owner_recorded' in the seeded dev data) — this file
//     surfaces it rather than treating every edge as equally certain.
//   - orders.items is JSONB, but unlike purchases.items/sales.items (which
//     really are empty free text in this DB), orders.items in real order
//     rows is an array of {quantity, product_id, unit_price} objects — a
//     real, structured product reference. Confirmed live: 6 of 8 real order
//     rows carry a real product_id inside items.
// purchases.items and sales.items remain genuinely unstructured/empty in
// this DB and are still never treated as a join key — that part of the
// original finding was correct and is unchanged.
const { getPool } = require('../db/pg');

// Orders whose lifecycle has already ended are not "active demand" — an
// earthquake today cannot affect a customer commitment already delivered or
// cancelled. Real status vocabulary used elsewhere in server.js (see e.g.
// the /api/today income calc): new, confirmed, delivered, cancelled.
const CLOSED_ORDER_STATUSES = ['delivered', 'cancelled'];

function gapStep(reason) {
  return { step: 'GAP', reason };
}

// Shared by both the SUPPLIER->product_suppliers path and the direct
// PRODUCT exposure path so INVENTORY/OPEN_ORDERS logic exists in exactly
// one place. Returns [INVENTORY step, OPEN_ORDERS step or GAP step].
async function propagateFromProduct(pool, userId, product) {
  const steps = [];
  const currentStock = product.current_stock != null ? Number(product.current_stock) : null;
  const lowStockAlert = product.low_stock_alert != null ? Number(product.low_stock_alert) : null;
  const isLowStock = currentStock != null && lowStockAlert != null && currentStock <= lowStockAlert;
  steps.push({
    step: 'INVENTORY',
    productId: product.id,
    current_stock: currentStock,
    low_stock_alert: lowStockAlert,
    isLowStock,
    note: 'current_stock/low_stock_alert are real stored products columns, surfaced as-is — never recomputed or estimated.',
  });

  // Real edge: orders.items is JSONB but real order rows store an array of
  // {quantity, product_id, unit_price} objects (confirmed live against the
  // dev DB — unlike purchases.items/sales.items, which really are empty in
  // this DB). jsonb_array_elements + ->>'product_id' reads that structure
  // directly; nothing here parses free text or guesses a match.
  const orderRes = await pool.query(
    `SELECT o.id, o.status, o.customer_name, o.order_date, o.total_amount, item->>'quantity' AS qty, item->>'unit_price' AS unit_price
     FROM orders o, jsonb_array_elements(o.items) AS item
     WHERE o.user_id = $1 AND item->>'product_id' = $2 AND o.status <> ALL($3::text[])
     ORDER BY o.order_date DESC NULLS LAST LIMIT 50`,
    [userId, product.id, CLOSED_ORDER_STATUSES]
  );

  if (orderRes.rows.length > 0) {
    steps.push(...ordersToSteps(orderRes.rows, currentStock));
    return steps;
  }

  // No direct order for this exact product — but this product may be a raw
  // material/component consumed inside a finished product's bill of
  // materials (real table: product_components(finished_product_id,
  // component_product_id, quantity_per_unit), populated in the dev DB).
  // A component itself is rarely ordered by a customer directly; the real
  // demand sits on the finished good it's built into. Walk that real edge
  // before giving up.
  const bomRes = await pool.query(
    `SELECT pc.finished_product_id, pc.quantity_per_unit, p.name, p.sku, p.current_stock, p.low_stock_alert
     FROM product_components pc JOIN products p ON p.id = pc.finished_product_id
     WHERE pc.user_id = $1 AND pc.component_product_id = $2`,
    [userId, product.id]
  );

  if (bomRes.rows.length === 0) {
    steps.push(gapStep(
      'No open order references this product_id directly, and no product_components row uses it as a component ' +
      'in any finished product, for this tenant — propagation honestly stops here rather than guessing an exposed order.'
    ));
    return steps;
  }

  for (const bom of bomRes.rows) {
    steps.push({
      step: 'COMPONENT_OF',
      finishedProductId: bom.finished_product_id,
      finishedProductName: bom.name,
      finishedProductSku: bom.sku,
      quantityPerUnit: bom.quantity_per_unit != null ? Number(bom.quantity_per_unit) : null,
      note: 'Real product_components row — this product is consumed as a raw material inside the named finished product, not itself directly ordered.',
    });
    const finishedOrderRes = await pool.query(
      `SELECT o.id, o.status, o.order_date, item->>'quantity' AS qty, item->>'unit_price' AS unit_price
       FROM orders o, jsonb_array_elements(o.items) AS item
       WHERE o.user_id = $1 AND item->>'product_id' = $2 AND o.status <> ALL($3::text[])
       ORDER BY o.order_date DESC NULLS LAST LIMIT 50`,
      [userId, bom.finished_product_id, CLOSED_ORDER_STATUSES]
    );
    const finishedStock = bom.current_stock != null ? Number(bom.current_stock) : null;
    if (finishedOrderRes.rows.length === 0) {
      steps.push(gapStep(`No open order references finished product ${bom.finished_product_id} (${bom.name}) — propagation stops here for this component/finished-product pair.`));
      continue;
    }
    steps.push(...ordersToSteps(finishedOrderRes.rows, finishedStock, bom.finished_product_id));
  }
  return steps;
}

function ordersToSteps(orderRows, currentStock, productId) {
  const steps = [];
  const totalQty = orderRows.reduce((s, r) => s + Number(r.qty || 0), 0);
  const totalValue = orderRows.reduce((s, r) => s + Number(r.qty || 0) * Number(r.unit_price || 0), 0);
  steps.push({
    step: 'OPEN_ORDERS',
    productId: productId || undefined,
    count: orderRows.length,
    totalQuantity: totalQty,
    totalValue,
    orderIds: orderRows.map(r => r.id),
    note: 'Real orders rows whose items JSONB references this exact product_id, status filtered to exclude delivered/cancelled. Quantity/value are real stored order-line values, not estimates.',
  });
  if (currentStock != null && totalQty > currentStock) {
    steps.push({
      step: 'COVERAGE_SHORTFALL',
      currentStock,
      openOrderQuantity: totalQty,
      shortfall: totalQty - currentStock,
      note: 'CALCULATED from real current_stock and real summed open-order quantity — a plain subtraction, not a model.',
    });
  }
  return steps;
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

    // Real many-to-many edge: product_suppliers. Distinct from purchases —
    // a supplier can be linked to a product with zero purchase history yet
    // (e.g. newly onboarded), so this is queried independently, not derived
    // from SUPPLIER_PURCHASES above.
    const linkRes = await pool.query(
      `SELECT ps.product_id, ps.source, ps.first_seen_at, p.name, p.sku, p.current_stock, p.low_stock_alert
       FROM product_suppliers ps JOIN products p ON p.id = ps.product_id
       WHERE ps.user_id = $1 AND ps.supplier_id = $2`,
      [userId, supplier.id]
    );
    if (linkRes.rows.length === 0) {
      path.push(gapStep(
        'No product_suppliers row links this supplier to any product for this tenant — propagation honestly ' +
        'stops here rather than guessing which products this supplier affects.'
      ));
      return path;
    }
    for (const link of linkRes.rows) {
      path.push({
        step: 'SUPPLIER_PRODUCT',
        productId: link.product_id,
        productName: link.name,
        sku: link.sku,
        provenance: link.source || 'unknown',
        firstSeenAt: link.first_seen_at,
        note: 'Real product_suppliers row — a many-to-many edge, not a guess. `provenance` shows how the edge was recorded (e.g. owner_recorded), never upgraded to a stronger claim than its source.',
      });
      const productSteps = await propagateFromProduct(pool, userId, {
        id: link.product_id, name: link.name, sku: link.sku,
        current_stock: link.current_stock, low_stock_alert: link.low_stock_alert,
      });
      path.push(...productSteps);
    }
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
    path.push(...(await propagateFromProduct(pool, userId, product)));
    return path;
  }

  // Other business_entity_type values (customer, purchase, sale, order) —
  // no further propagation rule is implemented for them yet; document, don't guess.
  path.push(gapStep(`No propagation rule implemented for business_entity_type "${entityType}" yet.`));
  return path;
}

// STARLANE Day 3 — Part 6: Propagation v2.
// Extends (does not duplicate) propagateSignal with explicit order labeling
// (0 = exposure/source, 1 = first-order real relationship, 2 = second-order,
// ...) and "may affect"/"creates exposure" language instead of causal claims.
//
// MAX_DEPTH raised 3 -> 8 (Phase 3C): with product_suppliers and orders.items
// now wired in, a real full chain is EXPOSURE -> SUPPLIER -> SUPPLIER_PURCHASES
// -> SUPPLIER_PRODUCT -> INVENTORY -> OPEN_ORDERS -> COVERAGE_SHORTFALL, i.e.
// 6 real steps past the source — the old cap of 3 would have silently
// truncated genuine, non-fabricated data, which is exactly the kind of
// "stop when real data runs out" violation this file exists to prevent.
function withOrderLabels(path) {
  let order = 0;
  const EXPOSURE_LANGUAGE_STEPS = new Set(['SUPPLIER_PURCHASES', 'INVENTORY', 'COMPONENT_OF', 'OPEN_ORDERS', 'COVERAGE_SHORTFALL']);
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
    const language = EXPOSURE_LANGUAGE_STEPS.has(step.step)
      ? 'may affect / creates exposure for'
      : 'is directly related to';
    return { ...step, order, relationship, language };
  });
}

async function propagateSignalV2(userId, signal, exposure = null) {
  const basePath = await propagateSignal(userId, signal, exposure);
  const MAX_DEPTH = 16;
  const labeled = withOrderLabels(basePath).filter(s => (s.order == null || s.order <= MAX_DEPTH));
  return {
    maxDepth: MAX_DEPTH,
    steps: labeled,
    note: 'Each step past order 0 is an explicit real relationship (or an honest GAP). Language is "may affect"/"creates exposure for", never a causal claim.',
  };
}

module.exports = { propagateSignal, propagateSignalV2 };
