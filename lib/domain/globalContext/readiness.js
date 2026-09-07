// FILE: lib/domain/globalContext/readiness.js
// STARLANE Global Context + Temporal Foundation -- Part D.
//
// getIntelligenceReadiness(userId) computes an HONEST summary of how much
// real geographic/currency context this tenant has recorded, from real
// COUNT() queries only -- never fabricated, never inferred. This is
// distinct from lib/world/exposureRegistry.js's getWorldIntelligenceReadiness
// (which measures VERIFIED business_exposure coverage); this function
// measures the raw customers/suppliers.country/currency + organization
// columns added in migrations 021/022, one layer below exposure.
const { getPool } = require('../../db/pg');
const { getOrCreateOrganizationContext } = require('./organization');

async function getIntelligenceReadiness(userId) {
  if (!userId) throw new Error('getIntelligenceReadiness: userId is required');
  const pool = getPool();

  const org = await getOrCreateOrganizationContext(userId);

  // Part M -- bulk COUNT queries, no per-row/N+1 scans.
  const [suppliersRes, customersRes] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(country)::int AS with_country,
              COUNT(currency)::int AS with_currency
       FROM suppliers WHERE user_id = $1`,
      [userId]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(country)::int AS with_country,
              COUNT(currency)::int AS with_currency
       FROM customers WHERE user_id = $1`,
      [userId]
    ),
  ]);

  const s = suppliersRes.rows[0];
  const c = customersRes.rows[0];

  const organizationCountryKnown = !!org.home_country;
  const baseCurrencyKnown = !!org.base_currency;

  const fmt = (known, total) => `${known}/${total}`;

  // external_intelligence_ready: honest three-tier verdict.
  //  'none'    -- organization context itself is unknown (can't even place the tenant)
  //  'partial' -- organization known, but zero counterparties have country/currency
  //  'full'    -- organization known AND at least one supplier or customer has both
  let externalIntelligenceReady = 'none';
  if (organizationCountryKnown && baseCurrencyKnown) {
    const anyCounterpartyContext =
      s.with_country > 0 || s.with_currency > 0 || c.with_country > 0 || c.with_currency > 0;
    externalIntelligenceReady = anyCounterpartyContext ? 'full' : 'partial';
  }

  return {
    organization_country: organizationCountryKnown ? 'known' : 'unknown',
    base_currency: baseCurrencyKnown ? 'known' : 'unknown',
    suppliers_with_country: fmt(s.with_country, s.total),
    suppliers_with_currency: fmt(s.with_currency, s.total),
    customers_with_country: fmt(c.with_country, c.total),
    customers_with_currency: fmt(c.with_currency, c.total),
    external_intelligence_ready: externalIntelligenceReady,
    generated_at: new Date().toISOString(),
  };
}

module.exports = { getIntelligenceReadiness };
