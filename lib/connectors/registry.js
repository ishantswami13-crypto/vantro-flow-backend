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
const CATEGORIES = ['accounting', 'erp', 'banking', 'payments', 'crm', 'ecommerce', 'inventory', 'spreadsheets',
  'email', 'messaging', 'communication', 'productivity', 'hr_payroll', 'support', 'logistics', 'external_signals'];

// What works today for a category whose live connectors are not built.
const FILE_FALLBACK = {
  accounting: 'Until then, upload an invoices export (CSV or Excel); QuickBooks, Xero and Zoho Books exports are recognised.',
  erp: 'Until then, upload an invoices export (CSV or Excel).',
  banking: 'Until then, bank statement import (CSV) works under Bank.',
  payments: 'Until then, upload a payouts or invoices export (CSV or Excel).',
  ecommerce: 'Until then, upload an orders export (CSV or Excel).',
  spreadsheets: 'Until then, download the sheet as CSV or Excel and upload it.',
  crm: 'Until then, upload a customers export (CSV or Excel).',
};

// [id, name, provider, category, authType, objects, how it would connect]
const PLANNED = [
  // Accounting
  ['quickbooks', 'QuickBooks Online', 'Intuit', 'accounting', 'oauth', ['invoices', 'customers', 'payments', 'bills'], 'Invoices, customers, payments and bills through Intuit’s official API.'],
  ['xero', 'Xero', 'Xero', 'accounting', 'oauth', ['invoices', 'contacts', 'payments', 'bills'], 'Invoices, contacts, payments and bills through the Xero Accounting API.'],
  ['sage', 'Sage Business Cloud', 'Sage', 'accounting', 'oauth', ['invoices', 'customers', 'payments'], 'Sales invoices, customers and payments through the Sage API.'],
  ['freshbooks', 'FreshBooks', 'FreshBooks', 'accounting', 'oauth', ['invoices', 'clients', 'payments'], 'Invoices, clients and payments through the FreshBooks API.'],
  ['zoho_books', 'Zoho Books', 'Zoho', 'accounting', 'oauth', ['invoices', 'customers', 'payments'], 'Invoices, customers and payments through the Zoho Books API.'],
  ['wave', 'Wave', 'Wave Financial', 'accounting', 'oauth', ['invoices', 'customers'], 'Invoices and customers through the Wave API.'],
  // ERP
  ['netsuite', 'Oracle NetSuite', 'Oracle', 'erp', 'oauth', ['invoices', 'customers', 'orders', 'items'], 'Invoices, customers, sales orders and items through SuiteTalk REST.'],
  ['dynamics_365', 'Microsoft Dynamics 365 Business Central', 'Microsoft', 'erp', 'oauth', ['invoices', 'customers', 'vendors', 'items'], 'Sales invoices, customers, vendors and items through the Business Central API.'],
  ['sap_business_one', 'SAP Business One', 'SAP', 'erp', 'api_key', ['invoices', 'business_partners', 'items'], 'A/R invoices, business partners and items through the Service Layer.'],
  ['odoo', 'Odoo', 'Odoo', 'erp', 'api_key', ['invoices', 'partners', 'products'], 'Invoices, partners and products through Odoo’s external API.'],
  // Banking
  ['plaid', 'Bank accounts (Plaid)', 'Plaid', 'banking', 'oauth', ['transactions', 'balances'], 'Transactions and balances from 12,000+ banks in the US, Canada and Europe through Plaid.'],
  ['open_banking', 'Open Banking (UK and EU)', 'Open Banking providers', 'banking', 'oauth', ['transactions', 'balances'], 'Transactions and balances through PSD2 / Open Banking account access.'],
  // Payments
  ['stripe', 'Stripe', 'Stripe', 'payments', 'oauth', ['charges', 'invoices', 'payouts', 'customers'], 'Payments, invoices, payouts and customers through Stripe Connect.'],
  ['paypal', 'PayPal', 'PayPal', 'payments', 'oauth', ['transactions', 'invoices'], 'Transactions and invoices through the PayPal REST API.'],
  ['square', 'Square', 'Block', 'payments', 'oauth', ['payments', 'invoices', 'customers'], 'Payments, invoices and customers through the Square API.'],
  ['razorpay', 'Razorpay', 'Razorpay', 'payments', 'api_key', ['payments', 'settlements'], 'Payments and settlements through the Razorpay API.'],
  // CRM
  ['salesforce', 'Salesforce', 'Salesforce', 'crm', 'oauth', ['accounts', 'contacts', 'opportunities'], 'Accounts, contacts and opportunities through the Salesforce REST API.'],
  ['hubspot', 'HubSpot', 'HubSpot', 'crm', 'oauth', ['companies', 'contacts', 'deals'], 'Companies, contacts and deals through the HubSpot CRM API.'],
  ['pipedrive', 'Pipedrive', 'Pipedrive', 'crm', 'oauth', ['organizations', 'persons', 'deals'], 'Organizations, people and deals through the Pipedrive API.'],
  ['zoho_crm', 'Zoho CRM', 'Zoho', 'crm', 'oauth', ['accounts', 'contacts', 'deals'], 'Accounts, contacts and deals through the Zoho CRM API.'],
  // E-commerce
  ['shopify', 'Shopify', 'Shopify', 'ecommerce', 'oauth', ['orders', 'customers', 'products', 'inventory'], 'Orders, customers, products and stock through the Shopify Admin API.'],
  ['woocommerce', 'WooCommerce', 'Automattic', 'ecommerce', 'api_key', ['orders', 'customers', 'products'], 'Orders, customers and products through the WooCommerce REST API.'],
  ['amazon_seller', 'Amazon Seller Central', 'Amazon', 'ecommerce', 'oauth', ['orders', 'settlements', 'inventory'], 'Orders, settlements and stock through the Selling Partner API.'],
  // Spreadsheets
  ['google_sheets', 'Google Sheets', 'Google', 'spreadsheets', 'oauth', ['rows'], 'Rows from a sheet you choose, kept in sync, through the Google Sheets API.'],
  ['microsoft_excel', 'Excel on Microsoft 365', 'Microsoft', 'spreadsheets', 'oauth', ['rows'], 'Rows from a workbook in OneDrive or SharePoint through Microsoft Graph.'],
  ['airtable', 'Airtable', 'Airtable', 'spreadsheets', 'oauth', ['records'], 'Records from a base you choose through the Airtable API.'],
  // Email
  ['gmail', 'Gmail', 'Google', 'email', 'oauth', ['messages'], 'Reads payment promises and disputes from customer email threads, and sends approved emails, through the Gmail API.'],
  ['outlook', 'Outlook', 'Microsoft', 'email', 'oauth', ['messages'], 'Reads customer email threads and sends approved emails through Microsoft Graph.'],
  // Messaging
  ['slack', 'Slack', 'Salesforce', 'messaging', 'oauth', ['messages'], 'Posts briefings and approval requests to a channel you choose.'],
  ['microsoft_teams', 'Microsoft Teams', 'Microsoft', 'messaging', 'oauth', ['messages'], 'Posts briefings and approval requests to a Teams channel.'],
  ['whatsapp_business', 'WhatsApp Business', 'Meta', 'messaging', 'api_key', ['messages'], 'Sends reminders you approve through the WhatsApp Business Platform.'],
  ['twilio_sms', 'SMS (Twilio)', 'Twilio', 'messaging', 'api_key', ['messages'], 'Sends reminders you approve by SMS through Twilio.'],
  // Productivity
  ['google_drive', 'Google Drive', 'Google', 'productivity', 'oauth', ['files'], 'Invoices and statements from a folder you choose.'],
  ['notion', 'Notion', 'Notion', 'productivity', 'oauth', ['pages', 'databases'], 'Pages and databases you share with Starlane.'],
  // Payroll
  ['gusto', 'Gusto', 'Gusto', 'hr_payroll', 'oauth', ['payrolls'], 'Upcoming payroll totals for cash planning.'],
  ['adp', 'ADP', 'ADP', 'hr_payroll', 'oauth', ['payrolls'], 'Upcoming payroll totals for cash planning.'],
  // Support
  ['zendesk', 'Zendesk', 'Zendesk', 'support', 'oauth', ['tickets'], 'Tickets that mention a disputed invoice.'],
  ['intercom', 'Intercom', 'Intercom', 'support', 'oauth', ['conversations'], 'Customer conversations that mention a payment.'],
  // Logistics
  ['shipstation', 'ShipStation', 'ShipStation', 'logistics', 'api_key', ['shipments'], 'Shipments and delivery status.'],
];

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
  // Everything else a business runs on. None of these is built yet; they are
  // listed so owners can see the direction and tell us what they use, and the
  // UI shows them as "Coming soon" with no connect action. Each one names the
  // official API it would use. A file export works for most of them today.
  ...PLANNED.map(([id, name, provider, category, authType, objects, via]) => ({
    id, sourceType: id.toUpperCase(), name, provider, category,
    authType, availability: 'not_available', syncMode: 'poll',
    summary: via,
    unavailableReason: FILE_FALLBACK[category]
      ? `Coming soon. ${FILE_FALLBACK[category]}`
      : 'Coming soon. Tell us you use it and it moves up the queue.',
    objects, access: [], setup: [], webhooks: false, revocable: true,
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
