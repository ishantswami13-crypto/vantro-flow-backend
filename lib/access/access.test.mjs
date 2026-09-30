// Pure unit tests: access eligibility rules and application validation.
// Run: node lib/access/access.test.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { assessEligibility, RULES_VERSION } = require('./eligibility');
const { validateApplication } = require('./validation');

let pass = 0; let fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✅', name); } else { fail++; console.log('  ❌', name, detail === undefined ? '' : JSON.stringify(detail)); }
};

const base = { systems: ['tally'], companySize: '11-50', country: 'IN', willConnectSystems: true };
const e = (over) => assessEligibility({ ...base, ...over });

check('Tally, 11-50, India, willing -> ready', e({}).tier === 'ready', e({}));
check('every result carries the rules version', e({}).rules_version === RULES_VERSION);
check('every result explains itself', [e({}), e({ willConnectSystems: false }), e({ systems: ['xero'] })].every((r) => r.reasons.length > 0));
check('not willing to connect -> waitlist (regardless of fit)', e({ willConnectSystems: false }).tier === 'waitlist');
check('only unbuilt systems -> unsupported', e({ systems: ['xero', 'crm'] }).tier === 'unsupported');
check('unsupported names the systems', e({ systems: ['xero'] }).reasons[0].includes('Xero'));
check('no systems at all -> unsupported', e({ systems: [] }).tier === 'unsupported');
check('spreadsheet only -> review', e({ systems: ['file_import'] }).tier === 'review');
check('201-1000 -> review', e({ companySize: '201-1000' }).tier === 'review');
check('outside launch region -> review', e({ country: 'US' }).tier === 'review');
check('Tally + an unbuilt system -> still ready, and says what is not connectable', (() => { const r = e({ systems: ['tally', 'xero'] }); return r.tier === 'ready' && r.reasons.some((x) => x.includes('Xero')); })());
check('public feeds never count as a company system', e({ systems: ['usgs_earthquakes'] }).tier === 'unsupported');

const good = {
  name: 'Asha Rao', email: ' Asha@Example.IN ', company: 'Rao Distributors', website: 'raodist.in',
  role: 'Owner', companySize: '11-50', industry: 'Distribution', country: 'in', systems: ['tally', 'tally'],
  problem: 'We never know which customers will actually pay this month.', desiredOutcome: 'Collect faster without losing customers.',
  willConnectSystems: true,
};
const ok = validateApplication(good);
check('valid application passes', ok.ok, ok.errors);
check('email normalised to lower case, trimmed', ok.value.email === 'asha@example.in');
check('country upper-cased', ok.value.country === 'IN');
check('website normalised to an https origin', ok.value.website === 'https://raodist.in');
check('duplicate systems collapsed', ok.value.systems.length === 1);

const bad = validateApplication({ ...good, email: 'nope', companySize: '5', country: 'India', systems: ['made_up'], problem: 'short', willConnectSystems: 'yes', website: 'javascript:alert(1)' });
check('all field errors reported together', ['email', 'companySize', 'country', 'systems', 'problem', 'willConnectSystems', 'website'].every((f) => bad.errors[f]), bad.errors);
check('public feeds are not selectable as company systems', validateApplication({ ...good, systems: ['ecb_fx'] }).errors.systems);
check('free-text system accepted when none selected', validateApplication({ ...good, systems: [], otherSystems: 'Marg ERP' }).ok);
check('oversized field rejected', validateApplication({ ...good, notes: 'x'.repeat(2001) }).errors.notes);
check('non-object body handled', validateApplication(null).ok === false);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
