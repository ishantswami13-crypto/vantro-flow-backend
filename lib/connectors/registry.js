// FILE: lib/connectors/registry.js
// Connector manifests — the single description of every source Starlane can
// (or explicitly cannot yet) connect to. The frontend Sources page, the
// onboarding "what does your company use?" step, and the access application
// all read this, so the product never advertises an integration that does not
// exist, and never shows a connected state that nothing actually reported.
//
// Honesty contract:
//   availability 'available'      — works end to end today.
//   availability 'not_available'  — listed so owners can tell us they use it;
//                                   there is NO integration behind it and the
//                                   UI must not offer a connect action.
// A connector's live state never comes from here; it comes from
// data_connections / connector_devices / file_import_batches / world_sources
// (see state.js).

const AUTH_TYPES = ['local_bridge', 'file_import', 'oauth', 'api_key', 'public_feed'];
const CATEGORIES = ['accounting', 'erp', 'banking', 'crm', 'inventory', 'spreadsheets',
  'communication', 'ecommerce', 'support', 'logistics', 'external_signals'];

const MANIFESTS = [
  {
    id: 'tally',
    sourceType: 'TALLY',
    name: 'TallyPrime',
    provider: 'Tally Solutions',
    category: 'accounting',
    authType: 'local_bridge',
    availability: 'available',
    syncMode: 'push',
    summary: 'Sales, purchases, receipts, payments and stock items from the Tally company on your computer.',
    objects: ['sales_vouchers', 'purchase_vouchers', 'receipts', 'payments', 'stock_items'],
    access: [
      'Reads vouchers and stock items through Tally’s local XML export port (localhost:9000).',
      'Read-only: Starlane never creates, edits or deletes anything in Tally.',
      'The bridge authenticates with its own revocable device credential — never your Starlane password.',
    ],
    setup: [
      'Enable the XML/ODBC server in TallyPrime (F1 › Settings › Connectivity, port 9000).',
      'Download the Starlane Tally bridge and run it once with the pairing code shown in Starlane.',
      'Leave it running with --watch to sync every 30 minutes.',
    ],
    webhooks: false,
    revocable: true,
  },
  {
    id: 'file_import',
    sourceType: 'FILE_IMPORT',
    name: 'Spreadsheet or CSV',
    provider: 'Starlane',
    category: 'spreadsheets',
    authType: 'file_import',
    availability: 'available',
    syncMode: 'upload',
    summary: 'Invoices and customers from a CSV or Excel export of any system.',
    objects: ['invoices', 'customers'],
    access: [
      'Only the file you upload. Nothing else on your computer or in other systems is read.',
      'Identical files are recognised and never imported twice.',
    ],
    setup: ['Export invoices from your system as CSV or XLSX.', 'Upload it and confirm the column mapping.'],
    webhooks: false,
    revocable: false,
  },
  ...[
    ['quickbooks', 'QUICKBOOKS', 'QuickBooks Online', 'Intuit'],
    ['zoho_books', 'ZOHO_BOOKS', 'Zoho Books', 'Zoho'],
    ['xero', 'XERO', 'Xero', 'Xero'],
  ].map(([id, sourceType, name, provider]) => ({
    id, sourceType, name, provider,
    category: 'accounting',
    authType: 'oauth',
    availability: 'not_available',
    syncMode: 'poll',
    summary: `${name} via ${provider}’s official OAuth API.`,
    unavailableReason: 'Not built yet. Tell us you use it and it moves up the queue; until then, a CSV export works today.',
    objects: ['invoices', 'customers', 'payments'],
    access: [],
    setup: [],
    webhooks: false,
    revocable: true,
  })),
  ...[
    ['bank_feeds', 'Bank account feeds', 'banking', 'Bank statement import (CSV) works today under Bank; live feeds are not built.'],
    ['crm', 'CRM (HubSpot, Zoho CRM, Salesforce)', 'crm', 'Not built yet.'],
    ['ecommerce', 'E-commerce (Shopify, WooCommerce)', 'ecommerce', 'Not built yet.'],
    ['erp', 'ERP (SAP Business One, Odoo)', 'erp', 'Not built yet.'],
    ['logistics', 'Logistics and shipping', 'logistics', 'Not built yet.'],
    ['support', 'Customer support desk', 'support', 'Not built yet.'],
  ].map(([id, name, category, unavailableReason]) => ({
    id, sourceType: null, name, provider: null, category,
    authType: 'oauth', availability: 'not_available', syncMode: 'poll',
    summary: name, unavailableReason, objects: [], access: [], setup: [], webhooks: false, revocable: true,
  })),
  {
    id: 'usgs_earthquakes',
    sourceType: null,
    worldSource: { provider: 'USGS', dataset: 'significant_earthquakes_month' },
    name: 'Earthquakes (USGS)',
    provider: 'U.S. Geological Survey',
    category: 'external_signals',
    authType: 'public_feed',
    availability: 'available',
    syncMode: 'poll',
    summary: 'Significant earthquakes worldwide, matched against your suppliers’ locations.',
    objects: ['world_events'],
    access: ['Public data feed. Nothing about your company is sent to USGS.'],
    setup: [],
    webhooks: false,
    revocable: false,
  },
  {
    id: 'ecb_fx',
    sourceType: null,
    worldSource: { provider: 'Frankfurter/ECB' },
    name: 'Exchange rates (ECB)',
    provider: 'European Central Bank via Frankfurter',
    category: 'external_signals',
    authType: 'public_feed',
    availability: 'available',
    syncMode: 'poll',
    summary: 'Daily reference exchange rates for currency exposure.',
    objects: ['fx_rates'],
    access: ['Public data feed. Nothing about your company is sent to the provider.'],
    setup: [],
    webhooks: false,
    revocable: false,
  },
];

function validateManifest(m) {
  const errors = [];
  if (!m.id || !/^[a-z0-9_]+$/.test(m.id)) errors.push('id');
  if (!AUTH_TYPES.includes(m.authType)) errors.push('authType');
  if (!CATEGORIES.includes(m.category)) errors.push('category');
  if (!['available', 'not_available'].includes(m.availability)) errors.push('availability');
  if (m.availability === 'not_available' && !m.unavailableReason) errors.push('unavailableReason');
  if (m.availability === 'available' && m.authType !== 'public_feed' && !m.access.length) errors.push('access');
  return errors;
}

function listManifests() {
  return MANIFESTS.map((m) => ({ ...m }));
}

function getManifest(id) {
  const m = MANIFESTS.find((x) => x.id === id);
  return m ? { ...m } : null;
}

module.exports = { listManifests, getManifest, validateManifest, AUTH_TYPES, CATEGORIES };
