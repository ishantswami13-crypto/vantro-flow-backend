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

const AUTH_TYPES = ['local_bridge', 'file_import', 'oauth', 'api_key', 'public_feed', 'webhook', 'link'];
const CATEGORIES = ['accounting', 'erp', 'banking', 'payments', 'crm', 'ecommerce', 'inventory', 'spreadsheets',
  'email', 'messaging', 'communication', 'productivity', 'hr_payroll', 'support', 'logistics', 'external_signals', 'custom'];

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
  ['xero', 'Xero', 'Xero', 'accounting', 'oauth', ['invoices', 'contacts', 'payments', 'bills'], 'Invoices, contacts, payments and bills through the Xero Accounting API.'],
  ['sage', 'Sage Business Cloud', 'Sage', 'accounting', 'oauth', ['invoices', 'customers', 'payments'], 'Sales invoices, customers and payments through the Sage API.'],
  ['freshbooks', 'FreshBooks', 'FreshBooks', 'accounting', 'oauth', ['invoices', 'clients', 'payments'], 'Invoices, clients and payments through the FreshBooks API.'],
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
  ['microsoft_excel', 'Excel on Microsoft 365', 'Microsoft', 'spreadsheets', 'oauth', ['rows'], 'Rows from a workbook in OneDrive or SharePoint through Microsoft Graph.'],
  ['airtable', 'Airtable', 'Airtable', 'spreadsheets', 'oauth', ['records'], 'Records from a base you choose through the Airtable API.'],
  // Email
  ['outlook', 'Outlook', 'Microsoft', 'email', 'oauth', ['messages'], 'Reads customer email threads and sends approved emails through Microsoft Graph.'],
  // Messaging
  ['microsoft_teams', 'Microsoft Teams', 'Microsoft', 'messaging', 'oauth', ['messages'], 'Posts briefings and approval requests to a Teams channel.'],
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
  {
    id: 'gmail',
    sourceType: 'GMAIL',
    name: 'Gmail',
    provider: 'Google',
    category: 'email',
    authType: 'oauth',
    availability: 'available',
    syncMode: 'poll',
    summary: 'Reads new emails so workflows can triage invoices, payment promises and disputes, and sends the emails you approve from your own address.',
    objects: ['messages'],
    connect: { kind: 'oauth', path: '/api/outreach/providers/gmail/connect-url?returnTo=sources', requiresEnv: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_OAUTH_REDIRECT_URI', 'OUTBOUND_CREDENTIALS_KEY'] },
    access: [
      'Google OAuth with two scopes: read your mail (gmail.readonly) and send as you (gmail.send).',
      'Starlane reads new inbox messages only for workflows you turn on, and keeps the first 4,000 characters of each.',
      'Nothing is sent until you approve that email, and only while customer messaging is switched on.',
      'Disconnect any time from your Google account (Security › Third-party access).',
    ],
    setup: ['Press Connect Gmail and pick the Google account.', 'Build a workflow that starts "When an email arrives in Gmail".'],
    webhooks: false,
    revocable: true,
  },
  {
    id: 'google_sheets',
    sourceType: 'GOOGLE_SHEETS',
    name: 'Google Sheets',
    provider: 'Google',
    category: 'spreadsheets',
    authType: 'link',
    availability: 'available',
    syncMode: 'upload',
    summary: 'Invoices and customers from a Google Sheet, imported from its share link with the same column mapping as a file upload.',
    objects: ['invoices', 'customers'],
    connect: { kind: 'sheet_link', path: '/decisions/import' },
    access: [
      'Only the sheet whose link you paste, read once per import as CSV.',
      'The sheet must be shared as "Anyone with the link can view"; Starlane has no access to the rest of your Google Drive.',
    ],
    setup: ['In Google Sheets, Share › Anyone with the link › Viewer.', 'Paste the link under Import, then confirm the column mapping.'],
    webhooks: false,
    revocable: false,
  },
  {
    id: 'webhook_in',
    sourceType: null,
    name: 'Incoming webhook (any app)',
    provider: 'Starlane',
    category: 'custom',
    authType: 'webhook',
    availability: 'available',
    syncMode: 'push',
    summary: 'A private address any tool can send data to: Zapier, Make, n8n, Stripe, Shopify, your CRM, or a script. Each delivery can start a workflow.',
    objects: ['events'],
    connect: { kind: 'webhook_in' },
    access: [
      'Only what the other app sends to the address. Starlane does not log in to that app.',
      'The address contains a secret; only its hash is stored. Rotate it to cut off the old one.',
      'Optional HMAC-SHA256 signature (X-Starlane-Signature) rejects anything not signed with your secret.',
    ],
    setup: ['Add an incoming webhook and copy its address.', 'Paste it into the other app’s webhook or "HTTP request" setting.'],
    webhooks: true,
    revocable: true,
  },
  {
    id: 'http_api',
    sourceType: null,
    name: 'Any REST API',
    provider: 'Starlane',
    category: 'custom',
    authType: 'api_key',
    availability: 'available',
    syncMode: 'push',
    summary: 'Lets workflows call any software with a REST API, with an API key, bearer token, basic auth or OAuth2 client credentials.',
    objects: ['requests'],
    connect: { kind: 'http_api' },
    access: [
      'Starlane calls only the base address you enter, and only from workflow steps you add.',
      'The key or secret is encrypted at rest and never shown again.',
      'https only; private and internal network addresses are refused.',
    ],
    setup: ['Add an API connection with its base address and key.', 'Use "Call an API" in a workflow.'],
    webhooks: false,
    revocable: true,
  },
  {
    id: 'slack',
    sourceType: null,
    name: 'Slack',
    provider: 'Salesforce',
    category: 'messaging',
    authType: 'webhook',
    availability: 'available',
    syncMode: 'push',
    summary: 'Posts workflow results to a Slack channel through an incoming webhook.',
    objects: ['messages'],
    connect: { kind: 'http_api', preset: 'slack' },
    access: [
      'Posts only to the channel of the incoming webhook you create in Slack.',
      'Starlane cannot read Slack messages.',
    ],
    setup: ['In Slack, add the Incoming Webhooks app to a channel and copy its URL.', 'Add it here, then use "Post to Slack" in a workflow.'],
    webhooks: false,
    revocable: true,
  },
  // Live app connectors (lib/connectors/apps). Each is read-only, and each
  // shows as Coming soon until its feature flag is on and its developer app
  // credentials are set (see apps/index.js isLive); only then does
  // listManifests() report it 'available'.
  {
    id: 'zoho_books',
    sourceType: 'ZOHO_BOOKS',
    name: 'Zoho Books',
    provider: 'Zoho',
    category: 'accounting',
    authType: 'oauth',
    app: true,
    syncMode: 'poll',
    summary: 'Invoices, what has been paid against them, and customers with their phone and email, read from Zoho Books.',
    objects: ['invoices', 'customers'],
    connect: { kind: 'oauth', path: '/api/connectors/zoho_books/connect-url' },
    access: [
      'Zoho sign-in with read-only scopes: invoices, contacts and organization settings.',
      'Starlane only reads. It never creates, edits or deletes anything in Zoho Books.',
      'Syncs every 30 minutes, and when you press Sync now.',
      'Disconnect here; you can also revoke Starlane in Zoho Accounts › Connected Apps.',
    ],
    setup: ['Press Connect and sign in to Zoho.', 'Pick the organization; Starlane reads its invoices and customers.'],
    webhooks: false,
    revocable: true,
  },
  {
    id: 'quickbooks',
    sourceType: 'QUICKBOOKS',
    name: 'QuickBooks Online',
    provider: 'Intuit',
    category: 'accounting',
    authType: 'oauth',
    app: true,
    syncMode: 'poll',
    summary: 'Invoices, balances, payment dates and customers, read from QuickBooks Online.',
    objects: ['invoices', 'customers', 'payments'],
    connect: { kind: 'oauth', path: '/api/connectors/quickbooks/connect-url' },
    access: [
      'Intuit sign-in for the company you choose (accounting scope).',
      'Starlane only sends read requests. It never creates, edits or deletes anything in QuickBooks.',
      'Syncs every 30 minutes, and when you press Sync now.',
      'Disconnect here; you can also remove Starlane under Apps in QuickBooks.',
    ],
    setup: ['Press Connect and sign in to Intuit.', 'Choose the company; Starlane reads its invoices, payments and customers.'],
    webhooks: false,
    revocable: true,
  },
  {
    id: 'razorpay',
    sourceType: 'RAZORPAY',
    name: 'Razorpay',
    provider: 'Razorpay',
    category: 'payments',
    authType: 'api_key',
    app: true,
    syncMode: 'poll',
    summary: 'Razorpay invoices and payment links, with what customers have paid against each.',
    objects: ['invoices', 'payment_links'],
    connect: { kind: 'api_key', path: '/api/connectors/razorpay/credentials' },
    access: [
      'Your own Razorpay API key (Key ID and Key Secret), encrypted at rest and never shown again.',
      'Starlane only sends read requests. It never creates payment links, refunds or anything else in Razorpay.',
      'Syncs every 30 minutes, and when you press Sync now. Delete the key in Razorpay to cut access at once.',
    ],
    setup: ['In the Razorpay Dashboard, Account & Settings › API Keys › Generate key.', 'Paste the Key ID and Key Secret here.'],
    webhooks: false,
    revocable: true,
  },
  {
    id: 'whatsapp_business',
    sourceType: 'WHATSAPP_BUSINESS',
    name: 'WhatsApp Business',
    provider: 'Meta',
    category: 'messaging',
    authType: 'api_key',
    app: true,
    syncMode: 'push',
    summary: 'Receives the messages customers send your WhatsApp Business number and matches each one to the customer.',
    objects: ['messages'],
    connect: { kind: 'api_key', path: '/api/connectors/whatsapp_business/credentials' },
    access: [
      'Your WhatsApp Business Platform number (Cloud API) and a permanent access token, encrypted at rest.',
      'Receive only: Starlane reads incoming customer messages and sends nothing from this connection.',
      'Every delivery is checked against Meta’s signature before it is stored.',
    ],
    setup: ['In Meta Business Settings, create a System User token with WhatsApp access.', 'Paste the phone number ID and the token here.'],
    webhooks: true,
    revocable: true,
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

// App connectors are Live only while their flag is on and their developer
// credentials are set; until then they read exactly like a planned connector.
function resolve(m, env = process.env) {
  if (!m.app) return { ...m };
  const { isLive, provider } = require('./apps');
  if (isLive(m.id, env)) {
    // API-key apps carry the fields the owner fills in (never a secret value).
    const fields = m.connect?.kind === 'api_key' ? provider(m.id).fields.map((f) => ({ ...f })) : undefined;
    return { ...m, availability: 'available', unavailableReason: null, connect: { ...m.connect, ...(fields ? { fields } : {}) } };
  }
  const { connect, ...rest } = m;
  return {
    ...rest,
    availability: 'not_available',
    unavailableReason: FILE_FALLBACK[m.category] ? `Coming soon. ${FILE_FALLBACK[m.category]}` : 'Coming soon. Tell us you use it and it moves up the queue.',
  };
}

function listManifests(env = process.env) {
  return MANIFESTS.map((m) => resolve(m, env));
}

function getManifest(id, env = process.env) {
  const m = MANIFESTS.find((x) => x.id === id);
  return m ? resolve(m, env) : null;
}

module.exports = { listManifests, getManifest, validateManifest, AUTH_TYPES, CATEGORIES };
