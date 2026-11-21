'use strict';
// Ready-made connection blueprints for software companies commonly use.
//
// Each entry is a short list of operations written from the vendor's public
// API reference: the base URL, how it authenticates, and a few useful calls.
// Connecting one creates an ordinary platform_app_connections row, exactly
// like an imported OpenAPI document, so every call goes through the same
// checks, logging and approval rules.
//
// Honesty: `verified: false` on every entry. These have not been exercised
// against a live account of each vendor from this codebase; the connection
// test button is what proves one works for a given organization. Anything
// not here can still be connected by importing its OpenAPI document or
// adding its MCP server.
//
// Risk: GET is read. Writes are external (approval always). A few vendors
// use POST for searches (Notion); those are marked read explicitly here
// because this file is reviewed code, unlike an imported spec.

const p = (name, where = 'query', extra = {}) => ({ name, in: where, required: where === 'path', type: 'string', ...extra });
const op = (id, method, path, summary, extra = {}) => ({ id, method, path, summary, risk: method === 'GET' ? 'read' : 'external', parameters: [], body: null, ...extra });
const jsonBody = (required = true) => ({ required, schema: { type: 'object' }, jsonOnly: true });

const CATALOG = [
  {
    key: 'slack', name: 'Slack', category: 'Messaging', docs: 'https://api.slack.com/methods',
    baseUrl: 'https://slack.com/api', auth: { type: 'bearer', hint: 'A bot token (xoxb-…) from your Slack app.' },
    operations: [
      op('conversations_list', 'GET', '/conversations.list', 'List channels', { parameters: [p('limit'), p('cursor')] }),
      op('conversations_history', 'GET', '/conversations.history', 'Read recent messages in a channel', { parameters: [p('channel', 'query', { required: true }), p('limit')] }),
      op('users_list', 'GET', '/users.list', 'List workspace members', { parameters: [p('limit'), p('cursor')] }),
      op('chat_post_message', 'POST', '/chat.postMessage', 'Post a message to a channel', { body: jsonBody() }),
    ],
  },
  {
    key: 'hubspot', name: 'HubSpot CRM', category: 'CRM', docs: 'https://developers.hubspot.com/docs/api/crm/understanding-the-crm',
    baseUrl: 'https://api.hubapi.com', auth: { type: 'bearer', hint: 'A private app access token.' },
    operations: [
      op('list_contacts', 'GET', '/crm/v3/objects/contacts', 'List contacts', { parameters: [p('limit'), p('after'), p('properties')] }),
      op('list_companies', 'GET', '/crm/v3/objects/companies', 'List companies', { parameters: [p('limit'), p('after'), p('properties')] }),
      op('list_deals', 'GET', '/crm/v3/objects/deals', 'List deals', { parameters: [p('limit'), p('after'), p('properties')] }),
      op('create_contact', 'POST', '/crm/v3/objects/contacts', 'Create a contact', { body: jsonBody() }),
      op('update_deal', 'PATCH', '/crm/v3/objects/deals/{dealId}', 'Update a deal', { parameters: [p('dealId', 'path')], body: jsonBody() }),
    ],
  },
  {
    key: 'salesforce', name: 'Salesforce', category: 'CRM', docs: 'https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/',
    baseUrl: 'https://{instance}.my.salesforce.com', baseUrlFields: [{ name: 'instance', label: 'My Domain name (the part before .my.salesforce.com)' }],
    auth: { type: 'oauth2_authorization_code', authorizeUrl: 'https://login.salesforce.com/services/oauth2/authorize', tokenUrl: 'https://login.salesforce.com/services/oauth2/token', scopes: ['api', 'refresh_token'], hint: 'Create a Connected App in Salesforce and enter its consumer key and secret.' },
    operations: [
      op('soql_query', 'GET', '/services/data/v61.0/query', 'Run a SOQL query', { parameters: [p('q', 'query', { required: true })] }),
      op('get_account', 'GET', '/services/data/v61.0/sobjects/Account/{id}', 'Read an account', { parameters: [p('id', 'path')] }),
      op('update_opportunity', 'PATCH', '/services/data/v61.0/sobjects/Opportunity/{id}', 'Update an opportunity', { parameters: [p('id', 'path')], body: jsonBody() }),
    ],
  },
  {
    key: 'stripe', name: 'Stripe', category: 'Payments', docs: 'https://docs.stripe.com/api',
    baseUrl: 'https://api.stripe.com', auth: { type: 'bearer', hint: 'A restricted key with read access is enough; Starlane only reads from Stripe.' },
    // Stripe writes take form-encoded bodies; only reads are offered.
    operations: [
      op('list_customers', 'GET', '/v1/customers', 'List customers', { parameters: [p('limit'), p('starting_after'), p('email')] }),
      op('list_invoices', 'GET', '/v1/invoices', 'List invoices', { parameters: [p('limit'), p('status'), p('customer'), p('starting_after')] }),
      op('list_charges', 'GET', '/v1/charges', 'List payments', { parameters: [p('limit'), p('customer'), p('starting_after')] }),
      op('get_balance', 'GET', '/v1/balance', 'Read the account balance'),
    ],
  },
  {
    key: 'shopify', name: 'Shopify', category: 'E-commerce', docs: 'https://shopify.dev/docs/api/admin-rest',
    baseUrl: 'https://{shop}.myshopify.com/admin/api/2024-07', baseUrlFields: [{ name: 'shop', label: 'Store name (the part before .myshopify.com)' }],
    auth: { type: 'api_key', in: 'header', name: 'X-Shopify-Access-Token', hint: 'An Admin API access token from a custom app.' },
    operations: [
      op('list_orders', 'GET', '/orders.json', 'List orders', { parameters: [p('status'), p('limit'), p('created_at_min')] }),
      op('list_customers', 'GET', '/customers.json', 'List customers', { parameters: [p('limit')] }),
      op('list_products', 'GET', '/products.json', 'List products', { parameters: [p('limit')] }),
    ],
  },
  {
    key: 'github', name: 'GitHub', category: 'Engineering', docs: 'https://docs.github.com/en/rest',
    baseUrl: 'https://api.github.com', auth: { type: 'bearer', hint: 'A fine-grained personal access token.' },
    staticHeaders: { 'X-GitHub-Api-Version': '2022-11-28', Accept: 'application/vnd.github+json' },
    operations: [
      op('list_issues', 'GET', '/repos/{owner}/{repo}/issues', 'List issues in a repository', { parameters: [p('owner', 'path'), p('repo', 'path'), p('state'), p('per_page')] }),
      op('get_issue', 'GET', '/repos/{owner}/{repo}/issues/{issue_number}', 'Read an issue', { parameters: [p('owner', 'path'), p('repo', 'path'), p('issue_number', 'path')] }),
      op('create_issue', 'POST', '/repos/{owner}/{repo}/issues', 'Open an issue', { parameters: [p('owner', 'path'), p('repo', 'path')], body: jsonBody() }),
    ],
  },
  {
    key: 'jira', name: 'Jira Cloud', category: 'Project management', docs: 'https://developer.atlassian.com/cloud/jira/platform/rest/v3/',
    baseUrl: 'https://{site}.atlassian.net', baseUrlFields: [{ name: 'site', label: 'Site name (the part before .atlassian.net)' }],
    auth: { type: 'basic', hint: 'Your Atlassian email and an API token, as email:token.' },
    operations: [
      op('search_issues', 'GET', '/rest/api/3/search/jql', 'Find issues with JQL', { parameters: [p('jql', 'query', { required: true }), p('maxResults'), p('fields')] }),
      op('get_issue', 'GET', '/rest/api/3/issue/{issueIdOrKey}', 'Read an issue', { parameters: [p('issueIdOrKey', 'path')] }),
      op('create_issue', 'POST', '/rest/api/3/issue', 'Create an issue', { body: jsonBody() }),
    ],
  },
  {
    key: 'notion', name: 'Notion', category: 'Knowledge', docs: 'https://developers.notion.com/reference',
    baseUrl: 'https://api.notion.com/v1', auth: { type: 'bearer', hint: 'An internal integration secret; share the pages you want with the integration.' },
    staticHeaders: { 'Notion-Version': '2022-06-28' },
    operations: [
      op('search', 'POST', '/search', 'Search pages and databases shared with the integration', { risk: 'read', body: jsonBody(false) }),
      op('query_database', 'POST', '/databases/{database_id}/query', 'Read rows from a database', { risk: 'read', parameters: [p('database_id', 'path')], body: jsonBody(false) }),
      op('get_page', 'GET', '/pages/{page_id}', 'Read a page', { parameters: [p('page_id', 'path')] }),
      op('create_page', 'POST', '/pages', 'Create a page', { body: jsonBody() }),
    ],
  },
  {
    key: 'airtable', name: 'Airtable', category: 'Spreadsheets', docs: 'https://airtable.com/developers/web/api/introduction',
    baseUrl: 'https://api.airtable.com/v0', auth: { type: 'bearer', hint: 'A personal access token scoped to the bases you need.' },
    operations: [
      op('list_records', 'GET', '/{baseId}/{tableIdOrName}', 'List records in a table', { parameters: [p('baseId', 'path'), p('tableIdOrName', 'path'), p('maxRecords'), p('view')] }),
      op('create_records', 'POST', '/{baseId}/{tableIdOrName}', 'Create records', { parameters: [p('baseId', 'path'), p('tableIdOrName', 'path')], body: jsonBody() }),
    ],
  },
  {
    key: 'zendesk', name: 'Zendesk Support', category: 'Support', docs: 'https://developer.zendesk.com/api-reference/',
    baseUrl: 'https://{subdomain}.zendesk.com/api/v2', baseUrlFields: [{ name: 'subdomain', label: 'Zendesk subdomain' }],
    auth: { type: 'basic', hint: 'email/token:YOUR_API_TOKEN, written as username:password.' },
    operations: [
      op('list_tickets', 'GET', '/tickets.json', 'List tickets', { parameters: [p('per_page'), p('sort_by')] }),
      op('get_ticket', 'GET', '/tickets/{ticket_id}.json', 'Read a ticket', { parameters: [p('ticket_id', 'path')] }),
      op('update_ticket', 'PUT', '/tickets/{ticket_id}.json', 'Update a ticket (status, comment)', { parameters: [p('ticket_id', 'path')], body: jsonBody() }),
    ],
  },
  {
    key: 'freshdesk', name: 'Freshdesk', category: 'Support', docs: 'https://developers.freshdesk.com/api/',
    baseUrl: 'https://{domain}.freshdesk.com/api/v2', baseUrlFields: [{ name: 'domain', label: 'Freshdesk domain' }],
    auth: { type: 'basic', hint: 'Your API key as the username and X as the password (apikey:X).' },
    operations: [
      op('list_tickets', 'GET', '/tickets', 'List tickets', { parameters: [p('per_page'), p('updated_since')] }),
      op('get_ticket', 'GET', '/tickets/{id}', 'Read a ticket', { parameters: [p('id', 'path')] }),
    ],
  },
  {
    key: 'asana', name: 'Asana', category: 'Project management', docs: 'https://developers.asana.com/reference',
    baseUrl: 'https://app.asana.com/api/1.0', auth: { type: 'bearer', hint: 'A personal access token.' },
    operations: [
      op('list_tasks', 'GET', '/tasks', 'List tasks in a project', { parameters: [p('project', 'query', { required: true }), p('limit')] }),
      op('create_task', 'POST', '/tasks', 'Create a task', { body: jsonBody() }),
    ],
  },
  {
    key: 'pipedrive', name: 'Pipedrive', category: 'CRM', docs: 'https://developers.pipedrive.com/docs/api/v1',
    baseUrl: 'https://api.pipedrive.com/v1', auth: { type: 'api_key', in: 'query', name: 'api_token', hint: 'Your personal API token.' },
    operations: [
      op('list_deals', 'GET', '/deals', 'List deals', { parameters: [p('status'), p('limit'), p('start')] }),
      op('list_persons', 'GET', '/persons', 'List people', { parameters: [p('limit'), p('start')] }),
    ],
  },
  {
    key: 'google_sheets', name: 'Google Sheets', category: 'Spreadsheets', docs: 'https://developers.google.com/sheets/api/reference/rest',
    baseUrl: 'https://sheets.googleapis.com/v4',
    auth: { type: 'oauth2_authorization_code', authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl: 'https://oauth2.googleapis.com/token', scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'], extraAuthorizeParams: { access_type: 'offline', prompt: 'consent' }, hint: 'A Google Cloud OAuth client (Web application) with this server\'s callback URL.' },
    operations: [
      op('get_values', 'GET', '/spreadsheets/{spreadsheetId}/values/{range}', 'Read cells from a sheet', { parameters: [p('spreadsheetId', 'path'), p('range', 'path')] }),
      op('get_spreadsheet', 'GET', '/spreadsheets/{spreadsheetId}', 'Read sheet names and properties', { parameters: [p('spreadsheetId', 'path')] }),
    ],
  },
  {
    key: 'microsoft_graph', name: 'Microsoft 365 (Outlook, OneDrive)', category: 'Productivity', docs: 'https://learn.microsoft.com/graph/api/overview',
    baseUrl: 'https://graph.microsoft.com/v1.0',
    auth: { type: 'oauth2_authorization_code', authorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize', tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token', scopes: ['offline_access', 'User.Read', 'Mail.Read', 'Files.Read'], hint: 'An app registration in Microsoft Entra ID with this server\'s callback URL.' },
    operations: [
      op('list_messages', 'GET', '/me/messages', 'Read recent email', { parameters: [p('$top'), p('$select')] }),
      op('list_drive_root', 'GET', '/me/drive/root/children', 'List files in OneDrive'),
    ],
  },
  {
    key: 'xero', name: 'Xero', category: 'Accounting', docs: 'https://developer.xero.com/documentation/api/accounting/overview',
    baseUrl: 'https://api.xero.com/api.xro/2.0',
    auth: { type: 'oauth2_authorization_code', authorizeUrl: 'https://login.xero.com/identity/connect/authorize', tokenUrl: 'https://identity.xero.com/connect/token', scopes: ['offline_access', 'accounting.transactions.read', 'accounting.contacts.read'], hint: 'A Xero app (Web app) with this server\'s callback URL.' },
    operations: [
      op('list_invoices', 'GET', '/Invoices', 'List invoices', { parameters: [p('xero-tenant-id', 'header', { required: true }), p('page'), p('where')] }),
      op('list_contacts', 'GET', '/Contacts', 'List contacts', { parameters: [p('xero-tenant-id', 'header', { required: true }), p('page')] }),
    ],
  },
];

const BY_KEY = new Map(CATALOG.map((c) => [c.key, c]));

function listCatalog() {
  return CATALOG.map((c) => ({
    key: c.key, name: c.name, category: c.category, docs: c.docs, baseUrl: c.baseUrl, baseUrlFields: c.baseUrlFields || [],
    auth: { type: c.auth.type, in: c.auth.in, name: c.auth.name, scopes: c.auth.scopes, hint: c.auth.hint },
    operations: c.operations.map((o) => ({ id: o.id, method: o.method, path: o.path, summary: o.summary, risk: o.risk })),
    verified: false,
  }));
}

function getCatalogEntry(key) {
  return BY_KEY.get(String(key || '')) || null;
}

module.exports = { CATALOG, listCatalog, getCatalogEntry };
