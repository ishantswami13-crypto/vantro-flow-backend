// FILE: lib/access/eligibility.js
// Deterministic compatibility assessment for access applications.
//
// No model, no scoring magic: a short list of explicit rules, each producing a
// plain-language reason the applicant sees. The rules are versioned; the
// version is stored with every application so a past assessment can always be
// explained even after the rules change.
//
// Tiers (what the applicant sees):
//   ready        — "Ready for Starlane": uses a system we can connect today and
//                  is willing to connect real data. Still reviewed by a person
//                  unless ACCESS_AUTO_APPROVE=true.
//   review       — "Compatible, onboarding review required": connectable, but
//                  something needs a conversation (size, only spreadsheets,
//                  outside the current launch region).
//   unsupported  — "Your systems aren't supported yet": none of the systems
//                  they named can be connected today.
//   waitlist     — "Waitlist": not ready to connect real company systems, which
//                  is the one thing Starlane cannot work without.

const { listManifests } = require('../connectors/registry');

const RULES_VERSION = 'access-rules/2026-09-27';
const LAUNCH_COUNTRIES = ['IN'];
const SUPPORTED_SIZES = ['1-10', '11-50', '51-200'];

const TIER_LABELS = {
  ready: 'Ready for Starlane',
  review: 'Compatible — onboarding review required',
  unsupported: 'Your systems aren’t supported yet',
  waitlist: 'Waitlist',
};

function assessEligibility({ systems = [], companySize, country, willConnectSystems }) {
  const manifests = listManifests();
  const byId = new Map(manifests.map((m) => [m.id, m]));
  const chosen = systems.map((id) => byId.get(id)).filter(Boolean);
  const connectable = chosen.filter((m) => m.availability === 'available' && m.authType !== 'public_feed');
  const connectableBusinessSystems = connectable.filter((m) => m.authType !== 'file_import');
  const notYet = chosen.filter((m) => m.availability !== 'available');

  const reasons = [];
  let tier;

  if (!willConnectSystems) {
    tier = 'waitlist';
    reasons.push('Starlane works from your company’s real systems; you indicated you are not ready to connect them yet.');
  } else if (connectable.length === 0) {
    tier = 'unsupported';
    reasons.push(notYet.length
      ? `None of the systems you use can be connected yet (${notYet.map((m) => m.name).join(', ')}).`
      : 'You did not select a system Starlane can connect to today.');
    reasons.push('A CSV or Excel export works today for any system — select “Spreadsheet or CSV” if you can export invoices.');
  } else {
    tier = 'ready';
    reasons.push(`Connectable today: ${connectable.map((m) => m.name).join(', ')}.`);
    if (connectableBusinessSystems.length === 0) {
      tier = 'review';
      reasons.push('Spreadsheet imports only — onboarding will confirm your exports carry what Starlane needs.');
    }
    if (!SUPPORTED_SIZES.includes(companySize)) {
      tier = 'review';
      reasons.push(`Company size ${companySize}: the current rollout is shaped around teams up to 200 people.`);
    }
    if (!LAUNCH_COUNTRIES.includes(String(country || '').toUpperCase())) {
      tier = 'review';
      reasons.push('Outside the current launch region (India): we will confirm currency, tax and data-residency fit first.');
    }
    if (notYet.length) {
      reasons.push(`Not connectable yet: ${notYet.map((m) => m.name).join(', ')}.`);
    }
  }

  return { tier, label: TIER_LABELS[tier], reasons, rules_version: RULES_VERSION };
}

module.exports = { assessEligibility, RULES_VERSION, TIER_LABELS, LAUNCH_COUNTRIES, SUPPORTED_SIZES };
