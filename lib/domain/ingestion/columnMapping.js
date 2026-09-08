// FILE: lib/domain/ingestion/columnMapping.js
// STARLANE — Real Customer Bootstrap & File Ingestion, Parts 4-6.
//
// Maps arbitrary file column headers to Starlane's fixed purchase-line-item
// field set (the same field set csvImport.js already accepts: sku,
// supplierName, supplierTaxId, quantity, unitPrice, currency, orderedAt,
// expectedAt, sourceRecordId). Vendor-independent core, with one adapter
// profile (Tally-style exports) layered on top as extra aliases — adding a
// future QuickBooks/Xero/Zoho profile means adding another alias list, not
// changing this module's logic.
//
// Verdicts, never silently merged:
//   CONFIRMED_MAPPING — exact (case/whitespace-insensitive) alias match
//   SUGGESTED_MAPPING — fuzzy alias match or type-clue fallback; caller
//                        should surface this for confirmation before commit
//   UNMAPPED          — no alias or type clue reached the confidence bar
//
// This module never invents data and never guesses a currency from a
// column name — currency VALUES are handled by fileParser's column-type
// detection + the caller's explicit parsing, not here.

const { similarity } = require('./entityResolution');

// Core, vendor-independent aliases.
const CORE_ALIASES = {
  sku: ['sku', 'item code', 'product code', 'item sku', 'code'],
  supplierName: ['supplier', 'supplier name', 'vendor', 'vendor name', 'party', 'party name'],
  supplierTaxId: ['gstin', 'gst no', 'tax id', 'vat number', 'gstin/uin'],
  quantity: ['quantity', 'qty', 'units'],
  unitPrice: ['unit price', 'rate', 'price', 'unit cost', 'cost'],
  currency: ['currency', 'ccy', 'curr'],
  orderedAt: ['order date', 'ordered at', 'date', 'purchase date'],
  expectedAt: ['expected date', 'expected at', 'delivery date', 'eta'],
  sourceRecordId: ['record id', 'reference', 'ref no', 'invoice no', 'bill no'],
};

// Tally-export adapter profile — additional aliases layered onto the same
// core field set (Tally has no separate concept here; its exports just use
// different header vocabulary). Kept as its own object so a future
// QuickBooks/Xero profile can be added the same way without touching CORE.
const TALLY_ALIASES = {
  supplierName: ['party ledger name', 'ledger name'],
  sku: ['stock item', 'stock item name'],
  supplierTaxId: ['gstin/uin'],
  orderedAt: ['voucher date'],
  sourceRecordId: ['voucher number', 'voucher no', 'voucher type'],
};

function mergeAliasProfiles(...profiles) {
  const merged = {};
  for (const profile of profiles) {
    for (const [field, aliases] of Object.entries(profile)) {
      merged[field] = [...new Set([...(merged[field] || []), ...aliases])];
    }
  }
  return merged;
}

function normalizeHeader(h) {
  return String(h || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Map one raw header string to a target field. Returns
 * { field, verdict, reason, confidence } or null if nothing qualifies.
 */
function mapHeader(header, aliasProfile) {
  const norm = normalizeHeader(header);
  if (!norm) return null;

  for (const [field, aliases] of Object.entries(aliasProfile)) {
    for (const alias of aliases) {
      if (normalizeHeader(alias) === norm) {
        return { field, verdict: 'CONFIRMED_MAPPING', reason: `exact alias match on "${alias}"`, confidence: 1 };
      }
    }
  }

  // fuzzy fallback across all aliases — SUGGESTED only, never CONFIRMED.
  let best = null;
  for (const [field, aliases] of Object.entries(aliasProfile)) {
    for (const alias of aliases) {
      const sim = similarity(norm, normalizeHeader(alias));
      if (sim >= 0.75 && (!best || sim > best.confidence)) {
        best = { field, verdict: 'SUGGESTED_MAPPING', reason: `fuzzy alias similarity ${sim.toFixed(2)} to "${alias}"`, confidence: sim };
      }
    }
  }
  return best;
}

/**
 * Map a full header row. Returns { mappings: {header: result|null}, byField,
 * unmapped: string[] }. `profile` is 'core' (default) or 'tally' to also
 * include the Tally alias set.
 */
function mapHeaders(headers, { profile = 'core' } = {}) {
  const aliasProfile = profile === 'tally' ? mergeAliasProfiles(CORE_ALIASES, TALLY_ALIASES) : CORE_ALIASES;
  const mappings = {};
  const byField = {};
  const unmapped = [];

  for (const header of headers) {
    const result = mapHeader(header, aliasProfile);
    mappings[header] = result;
    if (result) {
      // First confirmed mapping wins; a later SUGGESTED never overrides an
      // earlier CONFIRMED for the same target field.
      if (!byField[result.field] || (byField[result.field].verdict !== 'CONFIRMED_MAPPING' && result.verdict === 'CONFIRMED_MAPPING')) {
        byField[result.field] = { header, ...result };
      }
    } else {
      unmapped.push(header);
    }
  }

  return { mappings, byField, unmapped };
}

/**
 * Apply a resolved byField mapping to parsed CSV/XLSX rows (arrays aligned
 * to `headers`), producing the row-object shape csvImport.js expects.
 * Fields with no confirmed/suggested mapping are simply absent (undefined)
 * on the output row — csvImport.js's own validateRow will flag missing
 * required fields, this function never fabricates a value.
 */
function applyMapping(headers, rows, byField) {
  const headerIndex = new Map(headers.map((h, i) => [h, i]));
  return rows.map((row) => {
    const out = {};
    for (const [field, mapping] of Object.entries(byField)) {
      const idx = headerIndex.get(mapping.header);
      if (idx === undefined) continue;
      const raw = row[idx];
      out[field] = raw === '' ? undefined : raw;
    }
    return out;
  });
}

module.exports = { CORE_ALIASES, TALLY_ALIASES, mapHeader, mapHeaders, applyMapping, normalizeHeader };
