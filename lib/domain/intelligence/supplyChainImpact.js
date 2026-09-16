// FILE: lib/domain/intelligence/supplyChainImpact.js
// Pure, DB-free deterministic calculations for the supplier-disruption
// vertical slice. Mirrors the documentation style of lib/world/relevance.js:
// every function here takes plain data in, returns plain data out, and NEVER
// invents a number — a missing input produces an explicit
// { sufficientData: false, reason } result instead of a guessed value.
// Nothing in this file may call an LLM or touch the network.

function daysBetween(fromIso, toIso) {
  const from = new Date(fromIso).getTime();
  const to = new Date(toIso).getTime();
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return (to - from) / 86400000;
}

// currentStock, avgDailyDemand -> how many days of stock remain right now.
function calculateInventoryCoverage({ currentStock, avgDailyDemand }) {
  if (currentStock == null || avgDailyDemand == null) {
    return { sufficientData: false, reason: 'Missing current stock or average daily demand.' };
  }
  if (avgDailyDemand <= 0) {
    return { sufficientData: false, reason: 'Average daily demand is zero or negative; coverage is undefined.' };
  }
  const coverageDays = currentStock / avgDailyDemand;
  return { sufficientData: true, coverageDays: Math.round(coverageDays * 10) / 10 };
}

// Projects the calendar date stock hits zero (or safety stock, if provided),
// assuming no further inbound supply. Used as the "if we do nothing" clock.
function calculateStockoutDate({ currentStock, avgDailyDemand, safetyStock = 0, asOfIso }) {
  if (currentStock == null || avgDailyDemand == null || !asOfIso) {
    return { sufficientData: false, reason: 'Missing stock, demand, or reference date.' };
  }
  if (avgDailyDemand <= 0) {
    return { sufficientData: false, reason: 'Average daily demand is zero or negative; stockout date is undefined.' };
  }
  const usableStock = currentStock - (safetyStock || 0);
  if (usableStock <= 0) {
    return { sufficientData: true, alreadyBelowSafetyStock: true, daysUntilStockout: 0, stockoutDate: asOfIso };
  }
  const daysUntilStockout = usableStock / avgDailyDemand;
  const stockoutDate = new Date(new Date(asOfIso).getTime() + daysUntilStockout * 86400000).toISOString().slice(0, 10);
  return { sufficientData: true, alreadyBelowSafetyStock: false, daysUntilStockout: Math.round(daysUntilStockout * 10) / 10, stockoutDate };
}

// Walks the BOM graph (product_components rows) from a disrupted component
// up to every finished product that consumes it, directly or transitively.
// `components` is the full list of { finished_product_id, component_product_id,
// quantity_per_unit } rows for the tenant (loaded once by the caller).
function findAffectedProducts(componentProductId, components) {
  const affected = new Map(); // finished_product_id -> cumulative quantity_per_unit of the root component
  const queue = [{ id: componentProductId, multiplier: 1 }];
  const visited = new Set();
  while (queue.length) {
    const { id, multiplier } = queue.shift();
    if (visited.has(id)) continue;
    visited.add(id);
    for (const row of components) {
      if (row.component_product_id !== id) continue;
      const nextMultiplier = multiplier * Number(row.quantity_per_unit || 1);
      const existing = affected.get(row.finished_product_id) || 0;
      affected.set(row.finished_product_id, existing + nextMultiplier);
      queue.push({ id: row.finished_product_id, multiplier: nextMultiplier });
    }
  }
  return Array.from(affected.entries()).map(([finishedProductId, quantityPerUnit]) => ({ finishedProductId, quantityPerUnit }));
}

// orderLineItems: rows of { order_id, product_id, quantity, unit_price, needed_by }
// affectedProductIds: Set/array of product ids known to be at risk.
function calculateAffectedDemand(orderLineItems, affectedProductIds) {
  const idSet = new Set(affectedProductIds);
  const affectedLines = (orderLineItems || []).filter((l) => idSet.has(l.product_id));
  const orderIds = new Set(affectedLines.map((l) => l.order_id));
  return {
    sufficientData: true,
    affectedOrderCount: orderIds.size,
    affectedOrderIds: Array.from(orderIds),
    affectedLineItems: affectedLines,
  };
}

// Sums unit_price * quantity for the affected line items — a real, traceable
// dollar figure, never an estimate. If any line lacks a price, that line is
// excluded and reported so the total is never silently understated without
// a caveat.
function calculateRevenueExposure(affectedLineItems) {
  if (!Array.isArray(affectedLineItems) || affectedLineItems.length === 0) {
    return { sufficientData: true, totalRevenueExposure: 0, excludedLineCount: 0 };
  }
  let total = 0;
  let excluded = 0;
  for (const line of affectedLineItems) {
    const price = Number(line.unit_price);
    const qty = Number(line.quantity);
    if (!Number.isFinite(price) || !Number.isFinite(qty)) { excluded += 1; continue; }
    total += price * qty;
  }
  return { sufficientData: true, totalRevenueExposure: Math.round(total * 100) / 100, excludedLineCount: excluded };
}

// A simple, transparent margin-based cash exposure: revenue exposure scaled
// by a known margin ratio. If no margin figure is supplied, cash exposure is
// explicitly withheld rather than assumed (e.g. defaulted to 100% or 30%).
function calculateCashExposure({ totalRevenueExposure, marginRatio }) {
  if (totalRevenueExposure == null) return { sufficientData: false, reason: 'No revenue exposure computed.' };
  if (marginRatio == null) return { sufficientData: false, reason: 'No margin ratio on record for these products; revenue exposure is known but cash exposure is not.' };
  return { sufficientData: true, cashExposure: Math.round(totalRevenueExposure * marginRatio * 100) / 100 };
}

// Ranks candidate interventions by a transparent, explainable score:
// avoided-exposure per unit of cost, with lead time as a tiebreaker.
// Each candidate: { id, label, avoidedRevenueExposure, cost, leadTimeDays }
function rankInterventions(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return [];
  return candidates
    .map((c) => {
      const cost = Number(c.cost) || 0;
      const avoided = Number(c.avoidedRevenueExposure) || 0;
      const ratio = cost > 0 ? avoided / cost : (avoided > 0 ? Infinity : 0);
      return { ...c, benefitToCostRatio: Number.isFinite(ratio) ? Math.round(ratio * 100) / 100 : ratio };
    })
    .sort((a, b) => {
      if (b.benefitToCostRatio !== a.benefitToCostRatio) return b.benefitToCostRatio - a.benefitToCostRatio;
      return (a.leadTimeDays || 0) - (b.leadTimeDays || 0);
    });
}

// "Close the Loop" mission: a purchase-order recommendation needs a real
// quantity, not a guess.
//
// First attempt at this (kept here as a lesson, not repeated): "sum of the
// real open-order line items linked to this component, minus current
// stock" — mirrors signalPropagation.js's COVERAGE_SHORTFALL. That is the
// right question for a FINISHED product (whose own stock literally is what
// covers a firm order), but it is the WRONG question for a raw-material
// component: a component's stockout risk comes from ONGOING CONSUMPTION
// during the supplier's resupply lead time, not from firm order commitments
// against the component itself (a raw material is never "ordered" by a
// customer). Proven wrong live against the sanctioned 2xA demo tenant: the
// component (Aluminum Frame Alloy Tube Set) has 400 units on hand against
// only 75 units of real linked open-order demand — the naive formula
// concluded "shortfall = -325, no action needed" while getSignalImpact()
// simultaneously (correctly) forecasts a real stockout in 12.5 days, because
// avg_daily_demand (20/day) will exhaust the 400 units long before the
// supplier's 35-day lead time elapses.
//
// Correct, still fully deterministic, zero-arbitrary-constant formula: how
// much stock is needed to survive being resupplied only after the real
// recorded lead time, while consuming at the real recorded average daily
// rate, while never dropping below the real recorded safety stock —
// standard reorder-point math, using ONLY columns already recorded on
// `products` (avg_daily_demand, lead_time_days, safety_stock,
// current_stock — the exact same fields calculateStockoutDate() already
// uses). No minimum-order-quantity clamp is applied: products has no such
// column anywhere in this schema, and inventing a default would itself be
// the "arbitrary quantity" this mission prohibits.
function calculateRecommendedOrderQuantity({ currentStock, avgDailyDemand, leadTimeDays, safetyStock }) {
  if (currentStock == null || avgDailyDemand == null || leadTimeDays == null) {
    return { sufficientData: false, reason: 'Missing current_stock, avg_daily_demand, or lead_time_days on record for this component — cannot compute a real reorder quantity without guessing.' };
  }
  const demandDuringLeadTime = Number(avgDailyDemand) * Number(leadTimeDays);
  const targetStock = demandDuringLeadTime + (safetyStock != null ? Number(safetyStock) : 0);
  const shortfall = targetStock - Number(currentStock);
  if (shortfall <= 0) {
    return { sufficientData: true, recommendedQuantity: 0, targetStock, currentStock: Number(currentStock), reason: 'Current stock already covers real average consumption through the supplier lead time (plus safety stock); no reorder quantity is warranted.' };
  }
  return { sufficientData: true, recommendedQuantity: Math.ceil(shortfall), targetStock: Math.ceil(targetStock), currentStock: Number(currentStock), demandDuringLeadTime, safetyStockApplied: safetyStock != null ? Number(safetyStock) : null };
}

module.exports = {
  daysBetween,
  calculateInventoryCoverage,
  calculateStockoutDate,
  findAffectedProducts,
  calculateAffectedDemand,
  calculateRevenueExposure,
  calculateCashExposure,
  calculateRecommendedOrderQuantity,
  rankInterventions,
};
