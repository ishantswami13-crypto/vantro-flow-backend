'use strict';
// lib/locale/region.js — where a business is, and how its money, dates and
// tax are written.
//
// Starlane serves businesses in any country. Nothing in the product should
// assume rupees, lakh/crore grouping, GST or Indian Standard Time. A tenant's
// region lives in its versioned decision definitions (base_currency,
// timezone, locale, tax_label; see lib/domain/decisions/definitions.js), so a
// historical decision stays explainable after the owner changes it.
//
// COUNTRY_DEFAULTS fills those four values when an owner picks a country at
// onboarding. Every value can be changed afterwards in Settings.

const COUNTRY_DEFAULTS = Object.freeze({
  US: { name: 'United States', currency: 'USD', locale: 'en-US', timezone: 'America/New_York', taxLabel: 'Sales tax' },
  CA: { name: 'Canada', currency: 'CAD', locale: 'en-CA', timezone: 'America/Toronto', taxLabel: 'GST/HST' },
  MX: { name: 'Mexico', currency: 'MXN', locale: 'es-MX', timezone: 'America/Mexico_City', taxLabel: 'IVA' },
  BR: { name: 'Brazil', currency: 'BRL', locale: 'pt-BR', timezone: 'America/Sao_Paulo', taxLabel: 'ICMS' },
  GB: { name: 'United Kingdom', currency: 'GBP', locale: 'en-GB', timezone: 'Europe/London', taxLabel: 'VAT' },
  IE: { name: 'Ireland', currency: 'EUR', locale: 'en-IE', timezone: 'Europe/Dublin', taxLabel: 'VAT' },
  DE: { name: 'Germany', currency: 'EUR', locale: 'de-DE', timezone: 'Europe/Berlin', taxLabel: 'USt' },
  FR: { name: 'France', currency: 'EUR', locale: 'fr-FR', timezone: 'Europe/Paris', taxLabel: 'TVA' },
  ES: { name: 'Spain', currency: 'EUR', locale: 'es-ES', timezone: 'Europe/Madrid', taxLabel: 'IVA' },
  IT: { name: 'Italy', currency: 'EUR', locale: 'it-IT', timezone: 'Europe/Rome', taxLabel: 'IVA' },
  NL: { name: 'Netherlands', currency: 'EUR', locale: 'nl-NL', timezone: 'Europe/Amsterdam', taxLabel: 'BTW' },
  CH: { name: 'Switzerland', currency: 'CHF', locale: 'de-CH', timezone: 'Europe/Zurich', taxLabel: 'MWST' },
  SE: { name: 'Sweden', currency: 'SEK', locale: 'sv-SE', timezone: 'Europe/Stockholm', taxLabel: 'Moms' },
  PL: { name: 'Poland', currency: 'PLN', locale: 'pl-PL', timezone: 'Europe/Warsaw', taxLabel: 'VAT' },
  AE: { name: 'United Arab Emirates', currency: 'AED', locale: 'en-AE', timezone: 'Asia/Dubai', taxLabel: 'VAT' },
  SA: { name: 'Saudi Arabia', currency: 'SAR', locale: 'en-SA', timezone: 'Asia/Riyadh', taxLabel: 'VAT' },
  ZA: { name: 'South Africa', currency: 'ZAR', locale: 'en-ZA', timezone: 'Africa/Johannesburg', taxLabel: 'VAT' },
  NG: { name: 'Nigeria', currency: 'NGN', locale: 'en-NG', timezone: 'Africa/Lagos', taxLabel: 'VAT' },
  KE: { name: 'Kenya', currency: 'KES', locale: 'en-KE', timezone: 'Africa/Nairobi', taxLabel: 'VAT' },
  IN: { name: 'India', currency: 'INR', locale: 'en-IN', timezone: 'Asia/Kolkata', taxLabel: 'GST' },
  SG: { name: 'Singapore', currency: 'SGD', locale: 'en-SG', timezone: 'Asia/Singapore', taxLabel: 'GST' },
  MY: { name: 'Malaysia', currency: 'MYR', locale: 'en-MY', timezone: 'Asia/Kuala_Lumpur', taxLabel: 'SST' },
  ID: { name: 'Indonesia', currency: 'IDR', locale: 'id-ID', timezone: 'Asia/Jakarta', taxLabel: 'PPN' },
  PH: { name: 'Philippines', currency: 'PHP', locale: 'en-PH', timezone: 'Asia/Manila', taxLabel: 'VAT' },
  JP: { name: 'Japan', currency: 'JPY', locale: 'ja-JP', timezone: 'Asia/Tokyo', taxLabel: 'Consumption tax' },
  HK: { name: 'Hong Kong', currency: 'HKD', locale: 'en-HK', timezone: 'Asia/Hong_Kong', taxLabel: 'Tax' },
  AU: { name: 'Australia', currency: 'AUD', locale: 'en-AU', timezone: 'Australia/Sydney', taxLabel: 'GST' },
  NZ: { name: 'New Zealand', currency: 'NZD', locale: 'en-NZ', timezone: 'Pacific/Auckland', taxLabel: 'GST' },
});

// What a tenant gets when no country is known. Starlane is a New York
// company, so the neutral default is US English and US dollars; an owner's
// country choice at onboarding replaces it.
const FALLBACK = Object.freeze({ country: null, currency: 'USD', locale: 'en-US', timezone: 'America/New_York', taxLabel: 'Tax' });

// Currencies the product lets an owner pick (ISO 4217). Others are accepted
// by the API as long as Intl knows them.
const COMMON_CURRENCIES = Object.freeze(['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'NZD', 'CHF', 'SEK', 'PLN', 'JPY', 'SGD', 'HKD', 'MYR', 'IDR', 'PHP', 'INR', 'AED', 'SAR', 'ZAR', 'NGN', 'KES', 'MXN', 'BRL']);

const NAME_TO_CODE = Object.freeze(Object.fromEntries(
  Object.entries(COUNTRY_DEFAULTS).flatMap(([code, c]) => [[c.name.toLowerCase(), code], [code.toLowerCase(), code]])
    .concat([['usa', 'US'], ['united states of america', 'US'], ['uk', 'GB'], ['england', 'GB'], ['great britain', 'GB'], ['uae', 'AE'], ['bharat', 'IN']])
));

/** ISO 3166-1 alpha-2 code for a country code or name, or null. */
function countryCode(input) {
  if (!input) return null;
  return NAME_TO_CODE[String(input).trim().toLowerCase()] || null;
}

/** The default region for a country (code or name). Unknown -> FALLBACK. */
function regionForCountry(input) {
  const code = countryCode(input);
  const c = code ? COUNTRY_DEFAULTS[code] : null;
  if (!c) return { ...FALLBACK };
  return { country: code, currency: c.currency, locale: c.locale, timezone: c.timezone, taxLabel: c.taxLabel };
}

// The locale a currency is most naturally written in, used where a caller
// knows the currency but not the tenant's locale (e.g. a stored decision).
const CURRENCY_LOCALE = Object.freeze(Object.fromEntries(
  [...Object.values(COUNTRY_DEFAULTS)].reverse().map((c) => [c.currency, c.locale])
    .concat([['USD', 'en-US'], ['EUR', 'en-IE'], ['GBP', 'en-GB'], ['INR', 'en-IN']])
));

function localeForCurrency(currency) {
  return CURRENCY_LOCALE[String(currency || '').toUpperCase()] || 'en-US';
}

function isCurrency(code) {
  if (typeof code !== 'string' || !/^[A-Z]{3}$/.test(code)) return false;
  try { new Intl.NumberFormat('en-US', { style: 'currency', currency: code }); return true; } catch { return false; }
}

function isLocale(tag) {
  if (typeof tag !== 'string' || !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(tag)) return false;
  try { return Intl.NumberFormat.supportedLocalesOf([tag]).length > 0; } catch { return false; }
}

function isTimezone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

/**
 * A money amount written the way the business reads it:
 *   formatMoney(1250000, 'USD')            -> "$1,250,000"
 *   formatMoney(1250000, 'INR')            -> "₹12,50,000"
 *   formatMoney(1250000, 'EUR', 'de-DE')   -> "1.250.000 €"
 *   formatMoney(1250000, 'USD', null, { compact: true }) -> "$1.3M"
 * Whole units by default; pass { decimals: 2 } for invoice lines. With
 * compact, decimals sets the fixed fraction digits (₹4.20L with 2).
 */
function formatMoney(amount, currency = 'USD', locale = null, { compact = false, decimals = 0 } = {}) {
  const n = Number(amount);
  const value = Number.isFinite(n) ? n : 0;
  const cur = isCurrency(String(currency || '').toUpperCase()) ? String(currency).toUpperCase() : 'USD';
  const loc = locale && isLocale(locale) ? locale : localeForCurrency(cur);
  try {
    return new Intl.NumberFormat(loc, {
      style: 'currency',
      currency: cur,
      notation: compact ? 'compact' : 'standard',
      minimumFractionDigits: compact ? Math.min(decimals, 2) : decimals,
      maximumFractionDigits: compact ? Math.max(1, Math.min(decimals, 2)) : decimals,
    }).format(value);
  } catch {
    return `${cur} ${Math.round(value).toLocaleString('en-US')}`;
  }
}

/** A plain number grouped for the locale (no currency). */
function formatNumber(value, locale = 'en-US') {
  const n = Number(value);
  try { return (Number.isFinite(n) ? n : 0).toLocaleString(isLocale(locale) ? locale : 'en-US'); } catch { return String(n); }
}

/**
 * The region view of a tenant's effective definitions.
 * @param {object} defs effective decision definitions (getSettings().definitions)
 */
function regionFromDefinitions(defs = {}) {
  const currency = defs.base_currency || FALLBACK.currency;
  return {
    country: defs.country || null,
    currency,
    locale: defs.locale || localeForCurrency(currency),
    timezone: defs.timezone || FALLBACK.timezone,
    taxLabel: defs.tax_label || FALLBACK.taxLabel,
  };
}

/**
 * The tenant's base currency (its versioned definitions). Never throws: a
 * failed read returns the built-in default so a message still renders.
 */
async function tenantCurrency(pool, userId) {
  try {
    const { getSettings } = require('../domain/decisions/controls');
    return (await getSettings(pool, userId)).definitions.base_currency || FALLBACK.currency;
  } catch {
    return require('../domain/decisions/definitions').DEFAULT_DEFINITIONS.base_currency;
  }
}

/** Countries and currencies for a picker. */
function regionOptions() {
  return {
    countries: Object.entries(COUNTRY_DEFAULTS)
      .map(([code, c]) => ({ code, name: c.name, currency: c.currency, locale: c.locale, timezone: c.timezone, taxLabel: c.taxLabel }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    currencies: COMMON_CURRENCIES.slice(),
    fallback: { ...FALLBACK },
  };
}

module.exports = {
  COUNTRY_DEFAULTS, FALLBACK, COMMON_CURRENCIES,
  countryCode, regionForCountry, localeForCurrency, isCurrency, isLocale, isTimezone,
  formatMoney, formatNumber, regionFromDefinitions, regionOptions, tenantCurrency,
};
