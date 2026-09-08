// FILE: lib/domain/intelligence/stackedFragility.js
// STARLANE Multidimensional Intelligence Expansion — Capability 2:
// Stacked Fragility Chains.
//
// Detects compounded dependency chains bounded to 2-3 hops:
//   Customer -> Product -> Supplier -> external event
// Every link is explicitly labeled OBSERVED (a real stored row/fact) or
// DERIVED (computed from real rows, e.g. a spend-share percentage) or
// UNKNOWN (the linkage table exists but has no real rows for this tenant —
// per the Day 3/Day 4 audited finding that product_suppliers/purchase_line
// linkage is empty for real tenants today). This module NEVER guesses a
// missing link — it reuses:
//   - exposureMap.js's computeSupplierExposureMateriality (spend-share concentration)
//   - worldEventConsequence.js's widenSupplierUncertaintyFromEvent (event -> exposure -> uncertainty chain)
// and adds only the bounded-hop assembly/labeling on top — no new event
// matching or concentration math is implemented here.
//
// Primary real-data proof case (per mission): the previously-proven real
// China-supplier-hazard chain (a real VERIFIED LOCATED_IN China exposure
// matched to a real ingested USGS NATURAL_HAZARD world_event) is used as the
// canonical example when a caller supplies that supplier.

const { getPool } = require('../../db/pg');
const { computeSupplierExposureMateriality, getSupplierConcentration } = require('./exposureMap');
const { widenSupplierUncertaintyFromEvent } = require('../../world/worldEventConsequence');
const { IMPACT_MODES } = require('../../world/externalSignal');

/**
 * Hop 1: Customer -> Product. Real linkage would come from sales line items
 * referencing a product referencing this supplier; this codebase has no
 * populated product/line-item linkage for real tenants (confirmed by prior
 * Day 3/Day 4 audits), so this hop is honestly reported UNKNOWN rather than
 * fabricated — never silently skipped, always present in the chain with its
 * true status.
 */
async function checkCustomerProductHop(userId, customerId) {
  if (!customerId) {
    return { hop: 'customer_to_product', label: 'UNKNOWN', reason: 'no customerId supplied for this chain', observed: false };
  }
  const pool = getPool();
  let productLineCount = 0;
  try {
    const res = await pool.query(
      `SELECT COUNT(*)::int AS c FROM information_schema.tables WHERE table_name = 'purchase_line_items'`
    );
    if (res.rows[0].c > 0) {
      const lineRes = await pool.query(
        `SELECT COUNT(*)::int AS c FROM purchase_line_items WHERE user_id = $1`, [userId]
      ).catch(() => ({ rows: [{ c: 0 }] }));
      productLineCount = lineRes.rows[0].c;
    }
  } catch (e) {
    return { hop: 'customer_to_product', label: 'UNKNOWN', reason: `linkage check failed: ${e.message}`, observed: false };
  }
  return {
    hop: 'customer_to_product',
    label: 'UNKNOWN',
    reason: productLineCount > 0
      ? `${productLineCount} purchase_line_items row(s) exist for this tenant, but resolving which specific product this customer's order depends on is not implemented — honestly unknown, not zero`
      : 'no purchase_line_items rows exist for this tenant — real customer-to-product dependency data is absent',
    observed: false,
  };
}

/**
 * Hop 2: Product -> Supplier, via exposureMap's real spend-share materiality
 * (DERIVED — a real computed percentage, not a stored fact).
 */
async function checkProductSupplierHop(userId, supplierId) {
  const materiality = await computeSupplierExposureMateriality(userId, supplierId).catch(e => ({ insufficientData: true, reason: e.message }));
  if (materiality.insufficientData) {
    return { hop: 'product_to_supplier', label: 'INSUFFICIENT_DATA', reason: materiality.reason, observed: false };
  }
  return {
    hop: 'product_to_supplier',
    label: 'DERIVED',
    reason: `real spend-share materiality: ${materiality.spendShare.evidence} -> ${materiality.materialityBand} band`,
    observed: true,
    materialityBand: materiality.materialityBand,
    spendSharePct: materiality.spendShare.sharePct,
  };
}

/**
 * Hop 3: Supplier -> external event exposure, reusing
 * widenSupplierUncertaintyFromEvent wholesale (OBSERVED for the underlying
 * real event+exposure rows; the widening direction itself is DERIVED).
 */
async function checkSupplierEventHop(userId, supplierId) {
  const widened = await widenSupplierUncertaintyFromEvent({ userId, supplierId }).catch(e => ({ impact_mode: 'ERROR', reason: e.message }));
  if (widened.impact_mode === IMPACT_MODES.NO_EFFECT || widened.impact_mode === 'ERROR') {
    return { hop: 'supplier_to_event', label: widened.impact_mode === 'ERROR' ? 'ERROR' : 'OBSERVED_NO_MATCH', reason: widened.reason, observed: widened.impact_mode !== 'ERROR', chains: null };
  }
  return {
    hop: 'supplier_to_event',
    label: 'OBSERVED+DERIVED',
    reason: widened.reason,
    observed: true,
    impact_mode: widened.impact_mode,
    chains: widened.chains,
  };
}

/**
 * Assembles the bounded 2-3 hop fragility chain for one supplier, optionally
 * anchored to a customer. Returns every hop's real status — never omits a
 * hop just because it's UNKNOWN.
 * @param {string} userId
 * @param {object} opts
 * @param {string} opts.supplierId - required; the supplier anchoring the chain
 * @param {string} [opts.customerId] - optional customer to attempt the top hop for
 */
async function buildStackedFragilityChain(userId, opts = {}) {
  if (!userId) throw new Error('buildStackedFragilityChain: userId is required');
  if (!opts.supplierId) throw new Error('buildStackedFragilityChain: opts.supplierId is required');

  const hops = [];
  if (opts.customerId) {
    hops.push(await checkCustomerProductHop(userId, opts.customerId));
  }
  const productSupplierHop = await checkProductSupplierHop(userId, opts.supplierId);
  hops.push(productSupplierHop);
  const supplierEventHop = await checkSupplierEventHop(userId, opts.supplierId);
  hops.push(supplierEventHop);

  const observedOrDerivedHops = hops.filter(h => h.label !== 'UNKNOWN' && h.label !== 'INSUFFICIENT_DATA' && h.label !== 'ERROR');
  const chainComplete = observedOrDerivedHops.length === hops.length;
  const compoundedFragility = supplierEventHop.label === 'OBSERVED+DERIVED'
    && (productSupplierHop.materialityBand === 'HIGH' || productSupplierHop.materialityBand === 'MEDIUM');

  return {
    userId,
    supplierId: opts.supplierId,
    customerId: opts.customerId || null,
    hopCount: hops.length,
    hops,
    chainComplete,
    compoundedFragility,
    statement: compoundedFragility
      ? `A ${productSupplierHop.materialityBand}-materiality real supplier dependency is ALSO exposed to a real matched external event — a compounded fragility chain, not just an isolated exposure fact.`
      : chainComplete
        ? 'All checkable hops resolved to real data, but the chain does not currently show compounded (materiality + active event) fragility.'
        : 'Chain includes at least one UNKNOWN/insufficient-data hop — reported honestly rather than assumed complete.',
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { buildStackedFragilityChain, checkCustomerProductHop, checkProductSupplierHop, checkSupplierEventHop };
