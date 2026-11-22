// FILE: lib/domain/decisions/commitments.js
// Pure, DB-free fulfilment planning for "which customer commitments can we
// still keep?". Given what is on hand, what is inbound and when, the bill of
// materials, and the open order lines with their promised dates, it allocates
// supply to orders earliest-promise-first and reports, per order line, the
// date it can be ready and whether that beats the promise.
//
// It answers the supplier-delay question by running the same plan twice:
// once with the delayed shipment at its ORIGINAL expected date (the plan the
// business was relying on) and once at its CURRENT expected date. A line that
// was on time in the first plan and late in the second is at risk BECAUSE of
// the delay; a line late in both was already at risk.
//
// Industry-neutral: a product with a bill of materials is built from its
// components; a product with none is bought and resold, so its own stock and
// inbound purchases are its supply. Nothing here calls a model or guesses a
// number: a missing promise date or product link is reported as UNKNOWN.

const DAY_MS = 86400000;

function isoDay(value) {
  if (value == null || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function daysBetween(fromDay, toDay) {
  return Math.round((Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / DAY_MS);
}

/**
 * Per-unit requirement of leaf items (things that are stocked or bought) for
 * one unit of `productId`. A product with no BOM rows is its own leaf.
 * Cycles in the BOM are reported, never followed forever.
 */
function expandBom(productId, bomRows, multiplier = 1, path = new Set()) {
  const out = new Map();
  const children = bomRows.filter((r) => String(r.finished_product_id) === String(productId));
  if (!children.length) {
    out.set(String(productId), multiplier);
    return out;
  }
  if (path.has(String(productId))) throw new Error(`Bill of materials has a cycle at product ${productId}`);
  const next = new Set(path).add(String(productId));
  for (const row of children) {
    const sub = expandBom(row.component_product_id, bomRows, multiplier * Number(row.quantity_per_unit || 1), next);
    for (const [k, v] of sub) out.set(k, (out.get(k) || 0) + v);
  }
  return out;
}

/**
 * Supply lots per item: on-hand stock (available as of today) plus each open
 * inbound purchase line at its expected date. `overrides` maps a purchase
 * line id to a different expected date (used for the "as originally planned"
 * scenario).
 */
function buildSupply({ asOfDay, stock, inbound, overrides = {} }) {
  const lots = new Map();
  const push = (itemId, lot) => {
    const k = String(itemId);
    if (!lots.has(k)) lots.set(k, []);
    lots.get(k).push(lot);
  };
  for (const s of stock) {
    const qty = Number(s.onHand);
    if (Number.isFinite(qty) && qty > 0) push(s.productId, { at: asOfDay, qty, source: 'on_hand', purchaseLineId: null });
  }
  for (const line of inbound) {
    const remaining = Number(line.quantity) - Number(line.receivedQuantity || 0);
    const at = isoDay(overrides[line.purchaseLineId] ?? line.expectedAt);
    if (!(remaining > 0) || !at) continue;
    push(line.productId, { at: at < asOfDay ? asOfDay : at, qty: remaining, source: 'inbound', purchaseLineId: line.purchaseLineId });
  }
  for (const list of lots.values()) list.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return lots;
}

// Plans taking `qty` from an item's lots, earliest arrival first, without
// changing them. Returns the date the last needed unit arrives (null when
// supply on record cannot cover it), how much each purchase line would
// contribute, and the takes to apply if the whole order line is covered.
function planDraw(lots, itemId, qty) {
  const list = lots.get(String(itemId)) || [];
  let need = qty;
  let readyAt = null;
  const takes = [];
  const fromPurchaseLines = {};
  for (const lot of list) {
    if (need <= 1e-9) break;
    if (lot.qty <= 1e-9) continue;
    const take = Math.min(lot.qty, need);
    takes.push({ lot, take });
    need -= take;
    readyAt = lot.at;
    if (lot.purchaseLineId) fromPurchaseLines[lot.purchaseLineId] = (fromPurchaseLines[lot.purchaseLineId] || 0) + take;
  }
  const covered = need <= 1e-9;
  return { covered, readyAt: covered ? readyAt : null, shortfall: covered ? 0 : Math.ceil(need * 1000) / 1000, fromPurchaseLines, takes };
}

/**
 * Allocates supply to open order lines, earliest promise first (lines with
 * no promise date go last and are reported UNKNOWN). A product with a BOM
 * first uses its own finished stock, then is built from components; it is
 * ready when the last required unit is.
 */
function planFulfilment({ asOfDay, orderLines, stock, inbound, bom, overrides }) {
  const lots = buildSupply({ asOfDay, stock, inbound, overrides });
  const ordered = orderLines
    .map((l, i) => ({ ...l, _i: i, neededDay: isoDay(l.neededBy) }))
    .sort((a, b) => {
      if (a.neededDay && b.neededDay && a.neededDay !== b.neededDay) return a.neededDay < b.neededDay ? -1 : 1;
      if (a.neededDay && !b.neededDay) return -1;
      if (!a.neededDay && b.neededDay) return 1;
      return String(a.orderId).localeCompare(String(b.orderId)) || a._i - b._i;
    });

  const results = [];
  for (const line of ordered) {
    const qty = Number(line.quantity);
    if (!line.productId || !(qty > 0)) {
      results.push({ ...line, readyAt: null, status: 'UNKNOWN', reason: !line.productId ? 'Order line is not linked to a product' : 'Order line has no quantity', fromPurchaseLines: {}, shortfalls: [] });
      continue;
    }
    // All-or-nothing: an order line that cannot be fully supplied reserves
    // nothing, so one unfillable order does not starve the ones after it.
    const draws = [];
    const hasBom = bom.some((r) => String(r.finished_product_id) === String(line.productId));
    if (hasBom) {
      const own = (lots.get(String(line.productId)) || []).filter((l) => l.source === 'on_hand');
      const fromStock = Math.min(own.reduce((s, l) => s + l.qty, 0), qty);
      if (fromStock > 0) draws.push({ itemId: line.productId, ...planDraw(new Map([[String(line.productId), own]]), line.productId, fromStock) });
      const toBuild = qty - fromStock;
      if (toBuild > 0) {
        for (const [itemId, perUnit] of expandBom(line.productId, bom)) draws.push({ itemId, ...planDraw(lots, itemId, toBuild * perUnit) });
      }
    } else {
      draws.push({ itemId: line.productId, ...planDraw(lots, line.productId, qty) });
    }
    const covered = draws.every((d) => d.covered);
    const fromPurchaseLines = {};
    for (const d of draws) for (const [k, v] of Object.entries(d.fromPurchaseLines)) fromPurchaseLines[k] = (fromPurchaseLines[k] || 0) + v;
    const shortfalls = draws.filter((d) => !d.covered).map((d) => ({ itemId: String(d.itemId), units: d.shortfall }));
    let readyAt = asOfDay;
    if (covered) {
      for (const d of draws) {
        for (const t of d.takes) t.lot.qty -= t.take;
        if (d.readyAt && d.readyAt > readyAt) readyAt = d.readyAt;
      }
    }
    const ready = covered ? readyAt : null;
    let status;
    if (!line.neededDay) status = 'UNKNOWN';
    else if (ready == null) status = 'NOT_COVERED';
    else status = ready <= line.neededDay ? 'ON_TIME' : 'LATE';
    results.push({
      ...line,
      readyAt: ready,
      status,
      slipDays: ready && line.neededDay && ready > line.neededDay ? daysBetween(line.neededDay, ready) : 0,
      reason: !line.neededDay ? 'Order line has no promised date' : null,
      fromPurchaseLines,
      shortfalls,
    });
  }
  // eslint-disable-next-line no-unused-vars
  return results.sort((a, b) => a._i - b._i).map(({ _i, ...r }) => r);
}

/**
 * The supplier-delay question for one delayed purchase line.
 * Returns every open order line with its plan-as-relied-on and current
 * outcome, and the classification:
 *   AT_RISK_FROM_DELAY  on time as planned, late (or uncovered) now
 *   ALREADY_AT_RISK     late even with the shipment on its original date
 *   ON_TIME             still on time
 *   UNKNOWN             no promise date / no product link
 */
function assessSupplierDelay({ asOfDay, delayedLine, orderLines, stock, inbound, bom }) {
  const originalDay = isoDay(delayedLine.originalExpectedAt);
  const currentDay = isoDay(delayedLine.expectedAt);
  if (!originalDay || !currentDay) return { sufficientData: false, reason: 'The delayed shipment has no original or current expected date on record.' };
  const delayDays = daysBetween(originalDay, currentDay);
  const planned = planFulfilment({ asOfDay, orderLines, stock, inbound, bom, overrides: { [delayedLine.purchaseLineId]: originalDay } });
  const current = planFulfilment({ asOfDay, orderLines, stock, inbound, bom });

  const lines = current.map((now, i) => {
    const before = planned[i];
    const okBefore = before.status === 'ON_TIME';
    const okNow = now.status === 'ON_TIME';
    let classification;
    if (now.status === 'UNKNOWN') classification = 'UNKNOWN';
    else if (okBefore && !okNow) classification = 'AT_RISK_FROM_DELAY';
    else if (!okBefore && !okNow) classification = 'ALREADY_AT_RISK';
    else classification = 'ON_TIME';
    const unitPrice = Number(now.unitPrice);
    const value = Number.isFinite(unitPrice) ? Math.round(unitPrice * Number(now.quantity) * 100) / 100 : null;
    return {
      orderId: now.orderId,
      orderLineId: now.orderLineId || null,
      customerName: now.customerName || null,
      customerId: now.customerId || null,
      productId: now.productId,
      productName: now.productName || null,
      quantity: Number(now.quantity),
      value,
      neededBy: now.neededDay,
      plannedReadyAt: before.readyAt,
      readyAt: now.readyAt,
      slipDays: now.slipDays,
      plannedStatus: before.status,
      status: now.status,
      classification,
      dependsOnDelayedShipment: Number(before.fromPurchaseLines[delayedLine.purchaseLineId] || 0),
      shortfalls: now.shortfalls,
      reason: now.reason,
    };
  });

  const atRisk = lines.filter((l) => l.classification === 'AT_RISK_FROM_DELAY');
  const sum = (arr) => Math.round(arr.reduce((s, l) => s + (l.value || 0), 0) * 100) / 100;
  return {
    sufficientData: true,
    delayDays,
    originalExpectedAt: originalDay,
    expectedAt: currentDay,
    lines,
    atRisk,
    alreadyAtRisk: lines.filter((l) => l.classification === 'ALREADY_AT_RISK'),
    unaffected: lines.filter((l) => l.classification === 'ON_TIME'),
    unknown: lines.filter((l) => l.classification === 'UNKNOWN'),
    valueAtRisk: sum(atRisk),
    valueExcluded: atRisk.filter((l) => l.value == null).length,
    unitsNeededFromShipment: Math.round(atRisk.reduce((s, l) => s + l.dependsOnDelayedShipment, 0) * 1000) / 1000,
    earliestAtRiskNeededBy: atRisk.map((l) => l.neededBy).filter(Boolean).sort()[0] || null,
  };
}

module.exports = { isoDay, daysBetween, expandBom, buildSupply, planFulfilment, assessSupplierDelay };
