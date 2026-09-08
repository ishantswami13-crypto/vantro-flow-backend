// FILE: lib/domain/intelligence/exposureMap.js
// STARLANE Day 2 Multidimensional Reality Intelligence — Part 13/14: Hidden
// Dependency / Exposure Map.
//
// getOrganizationExposureMap(userId) computes REAL concentration across
// dimensions from real data only:
//   - customer concentration: reuses revenueIntelligence.service.js's
//     computeConcentration (no reimplementation)
//   - supplier concentration: groups real purchases.amount by real
//     purchases.supplier_id (purchases.supplier_id IS populated/real per audit)
//   - country/currency concentration: counts real business_exposure rows by
//     exposure_type/world_entity (country); currency concentration is
//     structurally reported as insufficient data because there are zero real
//     CURRENCY_DENOMINATED business_exposure rows today (same invariant as
//     fxExposureNarrative.js — never assert an FX/currency claim without real
//     CURRENCY_DENOMINATED exposure data).
//
// Every dimension is ALWAYS present in the output structure. A dimension with
// insufficient data reports { insufficientData: true, reason } rather than
// being omitted.

const { getPool } = require('../../db/pg');
const { supabase } = require('../../config/supabaseClient');
const {
  computeTenantWindowRevenue,
  computeConcentration,
  REVENUE_WINDOW_DAYS,
} = require('../../services/orchestrator/revenueIntelligence.service');

async function getCustomerConcentration(userId) {
  const pool = getPool();
  const since = new Date(Date.now() - REVENUE_WINDOW_DAYS * 86400000).toISOString();
  const res = await pool.query(
    `SELECT customer_id, customer_name, SUM(amount) AS revenue, COUNT(*) AS orders
     FROM sales WHERE user_id = $1 AND sale_date >= $2
     GROUP BY customer_id, customer_name ORDER BY revenue DESC LIMIT 5`,
    [userId, since]
  );
  if (res.rows.length === 0) {
    return { insufficientData: true, reason: `no sales rows in the trailing ${REVENUE_WINDOW_DAYS} days for this tenant` };
  }
  const tenantRevenue = await computeTenantWindowRevenue(userId, REVENUE_WINDOW_DAYS).catch(() => null);
  const total = tenantRevenue != null ? tenantRevenue : res.rows.reduce((s, r) => s + Number(r.revenue), 0);
  const top = res.rows.map(r => {
    const c = computeConcentration(Number(r.revenue), total, REVENUE_WINDOW_DAYS);
    return { customerId: r.customer_id, customerName: r.customer_name, revenue: Math.round(Number(r.revenue)), orders: Number(r.orders), sharePct: c.sharePct, isConcentrationRisk: c.isConcentrationRisk, evidence: c.evidence };
  });
  return { insufficientData: false, windowDays: REVENUE_WINDOW_DAYS, tenantRevenue: Math.round(total), top };
}

async function getSupplierConcentration(userId) {
  const pool = getPool();
  const res = await pool.query(
    `SELECT p.supplier_id, s.name AS supplier_name, SUM(p.amount) AS total, COUNT(*) AS purchases
     FROM purchases p LEFT JOIN suppliers s ON s.id = p.supplier_id
     WHERE p.user_id = $1 AND p.supplier_id IS NOT NULL
     GROUP BY p.supplier_id, s.name ORDER BY total DESC LIMIT 5`,
    [userId]
  );
  if (res.rows.length === 0) {
    return { insufficientData: true, reason: 'no purchases rows with a populated supplier_id for this tenant' };
  }
  const grandTotalRes = await pool.query(
    `SELECT SUM(amount) AS total FROM purchases WHERE user_id = $1 AND supplier_id IS NOT NULL`,
    [userId]
  );
  const grandTotal = Number(grandTotalRes.rows[0]?.total) || 0;
  const top = res.rows.map(r => {
    const total = Number(r.total);
    const sharePct = grandTotal > 0 ? Math.round((total / grandTotal) * 1000) / 10 : 0;
    return {
      supplierId: r.supplier_id,
      supplierName: r.supplier_name || '(unnamed)',
      total: Math.round(total),
      purchases: Number(r.purchases),
      sharePct,
      evidence: `${Math.round(total)} of ${Math.round(grandTotal)} total real purchase amount (${sharePct}%) is with this one supplier, across ${r.purchases} real purchase row(s).`,
    };
  });
  return { insufficientData: false, grandTotal: Math.round(grandTotal), top };
}

async function getCountryConcentration(userId) {
  const { data: rows, error } = await supabase
    .from('business_exposure')
    .select('id, world_entity_id, business_entity_type, exposure_type, verification_status')
    .eq('user_id', userId)
    .eq('verification_status', 'VERIFIED')
    .in('exposure_type', ['LOCATED_IN', 'OPERATES_IN']);
  if (error) throw error;
  if (!rows || rows.length === 0) {
    return { insufficientData: true, reason: 'no VERIFIED LOCATED_IN/OPERATES_IN business_exposure rows for this tenant' };
  }
  const pool = getPool();
  const entityIds = [...new Set(rows.map(r => r.world_entity_id))];
  const entRes = await pool.query(`SELECT id, name, code FROM world_entities WHERE id = ANY($1::uuid[])`, [entityIds]);
  const entMap = new Map(entRes.rows.map(e => [e.id, e.name || e.code]));

  const byCountry = new Map();
  for (const r of rows) {
    const label = entMap.get(r.world_entity_id) || r.world_entity_id;
    byCountry.set(label, (byCountry.get(label) || 0) + 1);
  }
  const total = rows.length;
  const top = [...byCountry.entries()]
    .map(([country, count]) => ({ country, count, sharePct: Math.round((count / total) * 1000) / 10 }))
    .sort((a, b) => b.count - a.count);
  return { insufficientData: false, totalVerifiedExposureRows: total, top };
}

async function getCurrencyConcentration(userId) {
  const { data: rows, error } = await supabase
    .from('business_exposure')
    .select('id')
    .eq('user_id', userId)
    .eq('exposure_type', 'CURRENCY_DENOMINATED');
  if (error) throw error;
  if (!rows || rows.length === 0) {
    return {
      insufficientData: true,
      reason: 'zero real CURRENCY_DENOMINATED business_exposure rows exist for this tenant (or in this database at all) — per the FX-exposure invariant, no currency concentration claim can be asserted without real currency exposure data.',
    };
  }
  return { insufficientData: false, note: 'real CURRENCY_DENOMINATED rows found but per-currency aggregation not yet implemented in this build', rowCount: rows.length };
}

async function getOrganizationExposureMap(userId) {
  if (!userId) throw new Error('getOrganizationExposureMap: userId is required');
  const [customer, supplier, country, currency] = await Promise.all([
    getCustomerConcentration(userId).catch(e => ({ insufficientData: true, reason: `error computing customer concentration: ${e.message}` })),
    getSupplierConcentration(userId).catch(e => ({ insufficientData: true, reason: `error computing supplier concentration: ${e.message}` })),
    getCountryConcentration(userId).catch(e => ({ insufficientData: true, reason: `error computing country concentration: ${e.message}` })),
    getCurrencyConcentration(userId).catch(e => ({ insufficientData: true, reason: `error computing currency concentration: ${e.message}` })),
  ]);
  return {
    userId,
    dimensions: { customerConcentration: customer, supplierConcentration: supplier, countryConcentration: country, currencyConcentration: currency },
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { getOrganizationExposureMap, getCustomerConcentration, getSupplierConcentration, getCountryConcentration, getCurrencyConcentration };
