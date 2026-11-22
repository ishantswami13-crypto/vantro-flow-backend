'use strict';
// FILE: lib/domain/inventory/stockLedger.js
// Pure rules for keeping products.current_stock consistent with the
// stock_movements ledger. Used by the auto-reconcile that runs when the app
// opens (server.js reconcileBusinessData) and by POST /api/reconcile/backfill.
//
// Two rules this module exists to enforce:
//
// 1. A stock level with no movement behind it is an opening balance, not an
//    error. Products created with a starting stock (the products form, an
//    import, a direct insert) never got a movement, and the recount used to
//    set them to 0 every time the owner opened the app. The recount now
//    records that balance as one OPENING-<productId> movement and keeps it.
//
// 2. A purchase whose goods are tracked line by line in purchase_line_items is
//    received only as far as those lines say (received_quantity). An open
//    purchase order (lines still inbound) books nothing into stock. The legacy
//    backfill used to read the purchase's items, or its amount as "1 x
//    Material: <supplier>", and book it as received the day it was entered.
//    Purchases with no line items keep the legacy behaviour, since for them
//    the bill is the only record that exists.

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const EPS = 1e-9;

function openingReference(productId) {
  return `OPENING-${productId}`;
}

function lineReceiptReference(lineId) {
  return `PLI-${lineId}`;
}

// Net quantity per product from a list of movements.
function stockFromMovements(movements) {
  const byProduct = new Map();
  for (const m of movements || []) {
    const k = String(m.product_id);
    const q = num(m.quantity);
    byProduct.set(k, (byProduct.get(k) || 0) + (m.movement_type === 'in' ? q : -q));
  }
  return byProduct;
}

// Movements to insert so that products holding a stock level with no
// movement at all keep that level through the recount.
function planOpeningMovements(userId, products, movements) {
  const moved = new Set((movements || []).map((m) => String(m.product_id)));
  const out = [];
  for (const p of products || []) {
    if (moved.has(String(p.id))) continue;
    const stock = num(p.current_stock);
    if (Math.abs(stock) < EPS) continue;
    out.push({
      user_id: userId,
      product_id: p.id,
      movement_type: stock > 0 ? 'in' : 'out',
      quantity: Math.abs(stock),
      reference: openingReference(p.id),
      notes: 'Opening stock recorded from the product record',
    });
  }
  return out;
}

// Products whose stored stock differs from the ledger. Call after the
// opening movements are included in `movements`, so a product never moves
// to 0 just because it had no movement.
function planStockUpdates(products, movements) {
  const byProduct = stockFromMovements(movements);
  const out = [];
  for (const p of products || []) {
    const k = String(p.id);
    if (!byProduct.has(k)) continue; // no ledger for it: nothing to correct against
    const stock = byProduct.get(k);
    if (Math.abs(stock - num(p.current_stock)) < EPS) continue;
    out.push({ id: p.id, stock });
  }
  return out;
}

// Splits purchases into those the legacy bill backfill may handle and
// movements for goods actually received on tracked purchase lines.
//   purchases:  rows from `purchases`
//   lineItems:  rows from `purchase_line_items` (id, purchase_id, product_id, received_quantity)
//   movements:  existing stock_movements with reference, movement_type, quantity
function planPurchaseReceipts(userId, purchases, lineItems, movements) {
  const linesByPurchase = new Map();
  for (const l of lineItems || []) {
    const k = String(l.purchase_id);
    if (!linesByPurchase.has(k)) linesByPurchase.set(k, []);
    linesByPurchase.get(k).push(l);
  }
  const bookedByRef = new Map();
  for (const m of movements || []) {
    if (!m.reference) continue;
    const q = num(m.quantity);
    bookedByRef.set(m.reference, (bookedByRef.get(m.reference) || 0) + (m.movement_type === 'in' ? q : -q));
  }

  const legacy = [];
  const tracked = [];
  const receiptMovements = [];
  for (const p of purchases || []) {
    const lines = linesByPurchase.get(String(p.id));
    if (!lines || !lines.length) { legacy.push(p); continue; }
    tracked.push(p);
    for (const l of lines) {
      if (!l.product_id) continue;
      const ref = lineReceiptReference(l.id);
      const delta = num(l.received_quantity) - (bookedByRef.get(ref) || 0);
      if (delta <= EPS) continue;
      receiptMovements.push({
        user_id: userId,
        product_id: l.product_id,
        movement_type: 'in',
        quantity: delta,
        unit_cost: num(l.unit_price) || null,
        reference: ref,
        notes: `Received on purchase ${p.bill_number || p.id}`,
      });
    }
  }
  return { legacy, tracked, receiptMovements };
}

module.exports = {
  openingReference,
  lineReceiptReference,
  stockFromMovements,
  planOpeningMovements,
  planStockUpdates,
  planPurchaseReceipts,
};
