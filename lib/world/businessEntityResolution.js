// FILE: lib/world/businessEntityResolution.js
// Phase 6 — Business Entity Resolution.
//
// Given a raw tenant-provided fact value (e.g. a country name string a test
// fixture or an owner provides, such as "Vietnam" or "USD"), resolve it to a
// canonical world_entities row. Deterministic only — exact code match, then
// a small normalized name lookup table. No LLM, no fuzzy/embedding search.
//
// Design choice: resolution provenance (raw_value, normalized_value,
// resolution_method, resolution_confidence, resolved_at) is stored directly
// on the business_exposure row that this resolution produces (migration 017
// added those columns to business_exposure) rather than as a separate
// table. Justification: in this schema a business_exposure row IS the
// resolution act — one raw tenant value resolves to exactly one exposure
// row pointing at exactly one world_entities row. There is no case yet where
// one raw value needs multiple candidate resolutions tracked over time; if
// that need arises (e.g. disambiguating "Georgia" country vs. US state),
// promote this into its own `business_entity_resolutions` table then. Never
// mutates original tenant tables (customers/suppliers/etc.) — resolution
// only ever produces/updates business_exposure rows.
const { getPool } = require('../db/pg');
const { upsertCountry, upsertCurrency } = require('./entities');

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

const COUNTRY_NAME_TO_ISO2 = {
  'india': 'IN', 'united states': 'US', 'usa': 'US', 'u.s.a.': 'US', 'us': 'US',
  'china': 'CN', 'japan': 'JP', 'germany': 'DE', 'united kingdom': 'GB', 'uk': 'GB',
  'france': 'FR', 'nepal': 'NP', 'spain': 'ES', 'vietnam': 'VN', 'indonesia': 'ID',
  'brazil': 'BR', 'mexico': 'MX', 'canada': 'CA', 'australia': 'AU', 'russia': 'RU',
  'south korea': 'KR', 'italy': 'IT', 'netherlands': 'NL', 'singapore': 'SG',
  'bangladesh': 'BD', 'pakistan': 'PK', 'thailand': 'TH', 'malaysia': 'MY',
  'philippines': 'PH', 'chile': 'CL', 'peru': 'PE', 'colombia': 'CO', 'turkey': 'TR',
  'afghanistan': 'AF',
};

const CURRENCY_NAME_TO_ISO4217 = {
  'usd': 'USD', 'us dollar': 'USD', 'dollar': 'USD', 'eur': 'EUR', 'euro': 'EUR',
  'gbp': 'GBP', 'pound': 'GBP', 'pound sterling': 'GBP', 'jpy': 'JPY', 'yen': 'JPY',
  'inr': 'INR', 'rupee': 'INR', 'cny': 'CNY', 'yuan': 'CNY', 'aud': 'AUD', 'cad': 'CAD',
  'chf': 'CHF', 'sgd': 'SGD',
};

// Resolve a country-shaped value. Returns
// { worldEntityId, code, method, confidence } or null if unresolvable
// (never guesses — an unresolved value must surface as null, not a wrong
// country).
async function resolveCountryValue(rawValue) {
  const normalized = normalize(rawValue);
  if (!normalized) return null;

  // 1. exact ISO 3166-1 alpha-2 code already
  if (/^[a-z]{2}$/i.test(rawValue.trim())) {
    const code = rawValue.trim().toUpperCase();
    const id = await upsertCountry(code);
    return { worldEntityId: id, code, method: 'exact_code_match', confidence: 0.95, normalized };
  }

  // 2. normalized name lookup
  const code = COUNTRY_NAME_TO_ISO2[normalized];
  if (code) {
    const id = await upsertCountry(code);
    return { worldEntityId: id, code, method: 'name_lookup_table', confidence: 0.85, normalized };
  }

  return null;
}

// Resolve a currency-shaped value similarly.
async function resolveCurrencyValue(rawValue) {
  const normalized = normalize(rawValue);
  if (!normalized) return null;

  if (/^[a-z]{3}$/i.test(rawValue.trim())) {
    const code = rawValue.trim().toUpperCase();
    const id = await upsertCurrency(code);
    return { worldEntityId: id, code, method: 'exact_code_match', confidence: 0.95, normalized };
  }

  const code = CURRENCY_NAME_TO_ISO4217[normalized];
  if (code) {
    const id = await upsertCurrency(code);
    return { worldEntityId: id, code, method: 'name_lookup_table', confidence: 0.85, normalized };
  }

  return null;
}

// Convenience: resolve + write a business_exposure row in one call. Used by
// the Phase 11 fixture script and available to any future "owner records a
// fact" feature. `kind` is 'country' or 'currency'.
async function resolveAndRecordExposure({
  userId, businessEntityType, businessEntityId, exposureType, kind, rawValue,
  validFrom, validTo, sourceOfFact = 'test_fixture', evidenceNotes = null, truthState = 'OBSERVED',
}) {
  const resolver = kind === 'currency' ? resolveCurrencyValue : resolveCountryValue;
  const resolved = await resolver(rawValue);
  if (!resolved) {
    return { ok: false, reason: `could not resolve ${kind} value "${rawValue}"` };
  }
  const pool = getPool();
  const res = await pool.query(
    `INSERT INTO business_exposure
       (user_id, business_entity_type, business_entity_id, exposure_type, world_entity_id,
        valid_from, valid_to, truth_state, confidence,
        raw_value, normalized_value, resolution_method, resolution_confidence, resolved_at,
        source_of_fact, evidence_notes)
     VALUES ($1,$2,$3,$4,$5, COALESCE($6, NOW()), $7, $8, $9,
             $10,$11,$12,$13, NOW(), $14,$15)
     RETURNING *`,
    [
      userId, businessEntityType, businessEntityId, exposureType, resolved.worldEntityId,
      validFrom || null, validTo || null, truthState, resolved.confidence,
      rawValue, resolved.normalized, resolved.method, resolved.confidence,
      sourceOfFact, evidenceNotes,
    ]
  );
  return { ok: true, exposure: res.rows[0], resolution: resolved };
}

module.exports = {
  normalize,
  resolveCountryValue,
  resolveCurrencyValue,
  resolveAndRecordExposure,
  COUNTRY_NAME_TO_ISO2,
  CURRENCY_NAME_TO_ISO4217,
};
