// Pure tests for region defaults and money formatting (no DB).
// Run: node lib/locale/region.test.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const R = require('./region');
const { validateOverrides, DEFAULT_DEFINITIONS } = require('../domain/decisions/definitions');

let pass = 0; let fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✅', name); } else { fail++; console.log('  ❌', name, detail ?? ''); }
};

check('US defaults: USD, en-US, New York, sales tax', JSON.stringify(R.regionForCountry('US')) === JSON.stringify({ country: 'US', currency: 'USD', locale: 'en-US', timezone: 'America/New_York', taxLabel: 'Sales tax' }));
check('country names resolve ("United Kingdom", "uk")', R.countryCode('United Kingdom') === 'GB' && R.countryCode('uk') === 'GB');
check('India keeps INR, en-IN, Kolkata, GST', R.regionForCountry('India').currency === 'INR' && R.regionForCountry('IN').taxLabel === 'GST');
check('unknown country falls back to USD / New York, not India', R.regionForCountry('Atlantis').currency === 'USD' && R.regionForCountry(null).timezone === 'America/New_York');
check('every country default is a valid currency, locale and timezone',
  Object.values(R.COUNTRY_DEFAULTS).every((c) => R.isCurrency(c.currency) && R.isLocale(c.locale) && R.isTimezone(c.timezone)));

const nbsp = (s) => s.replace(/ | /g, ' ');
check('USD is written $1,250,000', R.formatMoney(1250000, 'USD') === '$1,250,000', R.formatMoney(1250000, 'USD'));
check('INR keeps lakh grouping ₹12,50,000', R.formatMoney(1250000, 'INR') === '₹12,50,000', R.formatMoney(1250000, 'INR'));
check('EUR in German is 1.250.000 €', nbsp(R.formatMoney(1250000, 'EUR', 'de-DE')) === '1.250.000 €', R.formatMoney(1250000, 'EUR', 'de-DE'));
check('GBP is £', R.formatMoney(900, 'GBP').startsWith('£'));
check('compact USD is $1.3M', R.formatMoney(1250000, 'USD', null, { compact: true }) === '$1.3M', R.formatMoney(1250000, 'USD', null, { compact: true }));
check('invoice lines can carry cents', R.formatMoney(10.5, 'USD', null, { decimals: 2 }) === '$10.50');
check('a bad currency code never throws', typeof R.formatMoney(5, 'NOPE') === 'string');

check('definitions accept a region', validateOverrides({ country: 'US', locale: 'en-US', tax_label: 'Sales tax', base_currency: 'USD', timezone: 'America/New_York' }).ok);
check('definitions refuse a bad locale or country', !validateOverrides({ locale: 'not a locale' }).ok && !validateOverrides({ country: 'USA' }).ok);
check('region from defaults derives the locale from the currency', R.regionFromDefinitions(DEFAULT_DEFINITIONS).locale === R.localeForCurrency(DEFAULT_DEFINITIONS.base_currency));
check('region options list countries alphabetically', (() => { const n = R.regionOptions().countries.map((c) => c.name); return n.join() === [...n].sort((a, b) => a.localeCompare(b)).join(); })());

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
