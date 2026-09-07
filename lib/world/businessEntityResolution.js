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

// Phase 7 (Part A) — expanded to cover ISO 3166-1 common short names plus
// frequent aliases/misspellings/alternate spellings actually seen in trade
// data ("Viet Nam" is the ISO official short name; "Vietnam" is the common
// form). Deterministic only: every key maps to exactly one ISO2 code, no
// fuzzy matching, no scoring. Additions here are strictly additive to Phase
// 2's original table (every original key/value below is unchanged).
const COUNTRY_NAME_TO_ISO2 = {
  'india': 'IN', 'united states': 'US', 'usa': 'US', 'u.s.a.': 'US', 'us': 'US',
  'united states of america': 'US', 'america': 'US',
  'china': 'CN', "people's republic of china": 'CN', 'prc': 'CN',
  'japan': 'JP', 'germany': 'DE', 'deutschland': 'DE',
  'united kingdom': 'GB', 'uk': 'GB', 'great britain': 'GB', 'britain': 'GB', 'england': 'GB',
  'france': 'FR', 'nepal': 'NP', 'spain': 'ES', 'espana': 'ES',
  'vietnam': 'VN', 'viet nam': 'VN', 'vn': 'VN',
  'indonesia': 'ID', 'brazil': 'BR', 'brasil': 'BR', 'mexico': 'MX', 'canada': 'CA',
  'australia': 'AU', 'russia': 'RU', 'russian federation': 'RU',
  'south korea': 'KR', 'republic of korea': 'KR', 'korea, republic of': 'KR', 'korea south': 'KR',
  'north korea': 'KP', "democratic people's republic of korea": 'KP',
  'italy': 'IT', 'italia': 'IT', 'netherlands': 'NL', 'holland': 'NL',
  'singapore': 'SG', 'bangladesh': 'BD', 'pakistan': 'PK',
  'thailand': 'TH', 'malaysia': 'MY', 'philippines': 'PH', 'chile': 'CL',
  'peru': 'PE', 'colombia': 'CO', 'turkey': 'TR', 'turkiye': 'TR', 'afghanistan': 'AF',
  // ISO2 codes accepted as normalized-name lookups too (covers 3-letter input elsewhere)
  'switzerland': 'CH', 'sweden': 'SE', 'norway': 'NO', 'denmark': 'DK', 'finland': 'FI',
  'poland': 'PL', 'austria': 'AT', 'belgium': 'BE', 'portugal': 'PT', 'ireland': 'IE',
  'greece': 'GR', 'czech republic': 'CZ', 'czechia': 'CZ', 'hungary': 'HU', 'romania': 'RO',
  'ukraine': 'UA', 'egypt': 'EG', 'south africa': 'ZA', 'nigeria': 'NG', 'kenya': 'KE',
  'saudi arabia': 'SA', 'united arab emirates': 'AE', 'uae': 'AE', 'israel': 'IL',
  'iran': 'IR', 'iraq': 'IQ', 'qatar': 'QA', 'kuwait': 'KW',
  'new zealand': 'NZ', 'taiwan': 'TW', 'hong kong': 'HK', 'macau': 'MO',
  'sri lanka': 'LK', 'myanmar': 'MM', 'burma': 'MM', 'cambodia': 'KH', 'laos': 'LA',
  'argentina': 'AR', 'ecuador': 'EC', 'venezuela': 'VE', 'bolivia': 'BO', 'uruguay': 'UY',
  'paraguay': 'PY', 'costa rica': 'CR', 'panama': 'PA', 'guatemala': 'GT', 'nicaragua': 'NI',
  'ethiopia': 'ET', 'morocco': 'MA', 'algeria': 'DZ', 'tunisia': 'TN', 'ghana': 'GH',
  'iceland': 'IS', 'croatia': 'HR', 'serbia': 'RS', 'slovakia': 'SK', 'slovenia': 'SI',
  'bulgaria': 'BG', 'kazakhstan': 'KZ', 'uzbekistan': 'UZ', 'mongolia': 'MN',
  'fiji': 'FJ', 'papua new guinea': 'PG', 'tonga': 'TO', 'solomon islands': 'SB', 'vanuatu': 'VU',
};

// Phase 7 (Part A) — expanded ISO 4217 currency names/symbols/aliases.
// Disambiguation rule for ambiguous symbols (documented, not guessed): "$"
// alone is used by USD, AUD, CAD, SGD, HKD, NZD and others — it is
// DELIBERATELY EXCLUDED from this table and always resolves to null/
// unresolved unless the caller supplies additional context (e.g. a country
// code) that a future disambiguation layer could use. Same for "£" being
// ambiguous only in principle (GBP dominates real usage) — kept OUT for the
// same reason: no guessing, ever. Currency SYMBOLS that map to exactly one
// real-world currency in overwhelming practice (€, ¥ for JPY, ₹) are
// included since there is no genuine ambiguity to guess through, but this is
// still a deterministic lookup, not inference.
const CURRENCY_NAME_TO_ISO4217 = {
  'usd': 'USD', 'us dollar': 'USD', 'u.s. dollar': 'USD', 'american dollar': 'USD',
  'eur': 'EUR', 'euro': 'EUR', '€': 'EUR',
  'gbp': 'GBP', 'pound': 'GBP', 'pound sterling': 'GBP', 'sterling': 'GBP',
  'jpy': 'JPY', 'yen': 'JPY', 'japanese yen': 'JPY', '¥': 'JPY',
  'inr': 'INR', 'rupee': 'INR', 'indian rupee': 'INR', '₹': 'INR',
  'cny': 'CNY', 'yuan': 'CNY', 'rmb': 'CNY', 'renminbi': 'CNY', 'chinese yuan': 'CNY',
  'aud': 'AUD', 'australian dollar': 'AUD',
  'cad': 'CAD', 'canadian dollar': 'CAD',
  'chf': 'CHF', 'swiss franc': 'CHF',
  'sgd': 'SGD', 'singapore dollar': 'SGD',
  'hkd': 'HKD', 'hong kong dollar': 'HKD',
  'nzd': 'NZD', 'new zealand dollar': 'NZD',
  'krw': 'KRW', 'won': 'KRW', 'south korean won': 'KRW',
  'thb': 'THB', 'baht': 'THB', 'myr': 'MYR', 'ringgit': 'MYR',
  'idr': 'IDR', 'rupiah': 'IDR', 'php': 'PHP', 'peso': 'PHP',
  'vnd': 'VND', 'dong': 'VND', 'bdt': 'BDT', 'taka': 'BDT',
  'pkr': 'PKR', 'lkr': 'LKR', 'brl': 'BRL', 'real': 'BRL',
  'mxn': 'MXN', 'mexican peso': 'MXN', 'zar': 'ZAR', 'rand': 'ZAR',
  'try': 'TRY', 'lira': 'TRY', 'rub': 'RUB', 'ruble': 'RUB', 'rouble': 'RUB',
  'sek': 'SEK', 'nok': 'NOK', 'dkk': 'DKK', 'pln': 'PLN', 'zloty': 'PLN',
  'huf': 'HUF', 'forint': 'HUF', 'czk': 'CZK', 'koruna': 'CZK', 'ron': 'RON', 'leu': 'RON',
  'ils': 'ILS', 'shekel': 'ILS', 'sar': 'SAR', 'riyal': 'SAR', 'aed': 'AED', 'dirham': 'AED',
  'egp': 'EGP', 'ngn': 'NGN', 'naira': 'NGN', 'kes': 'KES', 'shilling': 'KES',
  'isk': 'ISK',
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
  provenanceType = 'OWNER_ENTERED', provenanceReference = null, verificationStatus = 'UNVERIFIED',
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
        source_of_fact, evidence_notes, provenance_type, provenance_reference, verification_status)
     VALUES ($1,$2,$3,$4,$5, COALESCE($6, NOW()), $7, $8, $9,
             $10,$11,$12,$13, NOW(), $14,$15,$16,$17,$18)
     RETURNING *`,
    [
      userId, businessEntityType, businessEntityId, exposureType, resolved.worldEntityId,
      validFrom || null, validTo || null, truthState, resolved.confidence,
      rawValue, resolved.normalized, resolved.method, resolved.confidence,
      sourceOfFact, evidenceNotes, provenanceType, provenanceReference, verificationStatus,
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
