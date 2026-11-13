'use strict';
// Business applications an organization can activate on the platform.
//
// The platform (Ask, Agents, Knowledge, Workflows, Command Center,
// Approvals, Connections) is the same for every organization. Applications
// are optional modules built on it. Each lists the existing routes it owns
// so current links keep working, and whether it is available today.
// 'planned' applications have no screens yet and cannot be enabled.

const APPS = Object.freeze([
  {
    key: 'finance',
    name: 'Finance',
    summary: 'Receivables review, bank matching, receivable decisions and finance monitors over your ledger.',
    status: 'available',
    items: [
      { href: '/review', label: 'Receivables review' },
      { href: '/decisions', label: 'Decisions' },
      { href: '/reconcile', label: 'Bank matching' },
      { href: '/watch', label: 'Finance monitors' },
      { href: '/command/finance', label: 'Finance overview' },
    ],
    requires: 'An invoices ledger: Tally, a live accounting connector or a CSV/Excel import.',
  },
  {
    key: 'procurement',
    name: 'Procurement',
    summary: 'Supplier payment runs from your purchase bills.',
    status: 'available',
    items: [{ href: '/payables', label: 'Supplier run' }],
    requires: 'Purchase bills from Tally, a connector or an import.',
  },
  {
    key: 'sales',
    name: 'Sales',
    summary: 'Outbound campaigns with review, rate limits and reply tracking through your own mailbox.',
    status: 'available',
    items: [{ href: '/outreach', label: 'Outreach' }],
    requires: 'A connected Gmail mailbox for sending; nothing is sent without your review.',
  },
  {
    key: 'operations',
    name: 'Operations',
    summary: 'Operations monitoring apps. Today, use Agents with schedule triggers for monitoring work.',
    status: 'planned',
    items: [],
    requires: null,
  },
  {
    key: 'legal',
    name: 'Legal',
    summary: 'Matter and contract review apps. Today, use Knowledge collections and a Document research agent.',
    status: 'planned',
    items: [],
    requires: null,
  },
]);

const BY_KEY = new Map(APPS.map((a) => [a.key, a]));

// What we suggest at setup for an industry. Only a suggestion: nothing is
// enabled unless an admin picks it.
const INDUSTRY_SUGGESTIONS = [
  [/distribut|wholesal|manufactur|industrial|trading|supply/i, ['finance', 'procurement']],
  [/e-?commerce|retail|d2c|online store|shop/i, ['sales', 'finance']],
  [/law|legal|consult|professional|agency|services|account/i, []],
  [/saas|software|technology/i, ['sales']],
];

function suggestedApps(industry) {
  if (!industry) return [];
  for (const [re, apps] of INDUSTRY_SUGGESTIONS) if (re.test(industry)) return apps;
  return [];
}

function getApp(key) { return BY_KEY.get(key) || null; }

/** Map of app key -> enabled for one organization. */
async function enabledApps(db, organizationId) {
  const { rows } = await db.query('SELECT app_key, enabled FROM organization_apps WHERE organization_id = $1', [organizationId]);
  return new Set(rows.filter((r) => r.enabled && BY_KEY.get(r.app_key)?.status === 'available').map((r) => r.app_key));
}

function catalogFor(enabled, industry) {
  const suggested = new Set(suggestedApps(industry));
  return APPS.map((a) => ({
    key: a.key, name: a.name, summary: a.summary, status: a.status, requires: a.requires,
    items: a.items, enabled: enabled.has(a.key), suggested: suggested.has(a.key),
  }));
}

/** The app that owns a route, if any (used by the frontend gate and tests). */
function appForRoute(path) {
  for (const a of APPS) {
    if (a.items.some((i) => path === i.href || path.startsWith(`${i.href}/`))) return a.key;
  }
  return null;
}

module.exports = { APPS, getApp, enabledApps, catalogFor, suggestedApps, appForRoute };
