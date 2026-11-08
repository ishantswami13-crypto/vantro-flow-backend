'use strict';
// lib/connectors/apps/zohoBooks.js — Zoho Books, read-only, through OAuth.
//
// Scopes: ZohoBooks.invoices.READ, ZohoBooks.contacts.READ and
// ZohoBooks.settings.READ (to list the organizations). Nothing that can write is requested, and only GET
// requests are ever sent.
//
// Zoho runs separate data centres (zoho.com, .in, .eu, .com.au, .jp, .ca,
// .sa, .uk). The owner signs in on accounts.zoho.com; Zoho sends them on to
// their own data centre and names it in the callback (accounts-server), and
// the token response names the API domain. Both are checked against Zoho's
// own hosts before they are used, so a forged callback cannot point Starlane
// anywhere else.

const { defineConnector, ConnectorError } = require('../sdk');
const { vendorRequest, base, form } = require('./http');

const ID = 'zoho_books';
const SCOPES = ['ZohoBooks.invoices.READ', 'ZohoBooks.contacts.READ', 'ZohoBooks.settings.READ'];
const ACCOUNTS_HOST_RE = /^https:\/\/accounts\.(zoho\.(com|in|eu|com\.au|jp|sa|uk|com\.cn)|zohocloud\.ca)$/;
const API_HOST_RE = /^https:\/\/www\.zohoapis\.(com|in|eu|com\.au|jp|sa|uk|ca|com\.cn)$/;
const PER_PAGE = 200;
const MAX_PAGES = 50; // 10,000 records per entity per sync
// Statuses that are not a live receivable.
const SKIP_STATUSES = new Set(['draft', 'void']);

const env = () => ({
  clientId: process.env.ZOHO_CLIENT_ID,
  clientSecret: process.env.ZOHO_CLIENT_SECRET,
  accountsUrl: (process.env.ZOHO_ACCOUNTS_URL || 'https://accounts.zoho.com').replace(/\/+$/, ''),
});

function checkedAccountsServer(raw) {
  if (base('zohoAccounts', null)) return base('zohoAccounts');
  const v = String(raw || env().accountsUrl).replace(/\/+$/, '');
  if (!ACCOUNTS_HOST_RE.test(v)) throw new ConnectorError('PERMANENT', 'Zoho named a sign-in server that is not Zoho’s.');
  return v;
}

function checkedApiDomain(raw) {
  if (base('zohoApi', null)) return base('zohoApi');
  const v = String(raw || '').replace(/\/+$/, '');
  if (!API_HOST_RE.test(v)) throw new ConnectorError('PERMANENT', 'Zoho named an API address that is not Zoho’s.');
  return v;
}

function authorizeUrl({ state, redirectUri }) {
  const e = env();
  return `${base('zohoAccounts', e.accountsUrl)}/oauth/v2/auth?${new URLSearchParams({
    scope: SCOPES.join(','), client_id: e.clientId, response_type: 'code', access_type: 'offline', prompt: 'consent', redirect_uri: redirectUri, state,
  })}`;
}

async function tokenRequest(accountsServer, params) {
  const e = env();
  const r = await vendorRequest(`${accountsServer}/oauth/v2/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ ...params, client_id: e.clientId, client_secret: e.clientSecret }), raw: true, label: 'Zoho',
  });
  // Zoho reports a bad or revoked grant as HTTP 200 with { error }.
  if (r.status >= 500) throw new ConnectorError('TRANSIENT', `Zoho answered HTTP ${r.status}`);
  if (!r.json || !r.json.access_token) throw new ConnectorError('AUTH_EXPIRED', `Zoho refused the sign-in (${String(r.json?.error || `HTTP ${r.status}`).slice(0, 80)}). Connect Zoho Books again.`);
  return r.json;
}

function makeClient({ accessToken, config }) {
  const apiDomain = checkedApiDomain(config.apiDomain);
  return async (path, query = {}) => {
    const q = new URLSearchParams({ ...(config.organizationId ? { organization_id: config.organizationId } : {}), ...query });
    const r = await vendorRequest(`${apiDomain}/books/v3${path}?${q}`, { headers: { Authorization: `Zoho-oauthtoken ${accessToken}` }, label: 'Zoho Books' });
    if (r.json && r.json.code !== undefined && r.json.code !== 0) throw new ConnectorError('PERMANENT', `Zoho Books: ${String(r.json.message || r.json.code).slice(0, 200)}`);
    return r.json || {};
  };
}

/** The callback: code → tokens → the organization to read. */
async function exchangeCode({ query, redirectUri }) {
  const accountsServer = checkedAccountsServer(query['accounts-server']);
  const tok = await tokenRequest(accountsServer, { grant_type: 'authorization_code', code: String(query.code), redirect_uri: redirectUri });
  if (!tok.refresh_token) throw new ConnectorError('AUTH_EXPIRED', 'Zoho did not grant offline access. Connect again and allow access.');
  const apiDomain = checkedApiDomain(tok.api_domain);
  const get = makeClient({ accessToken: tok.access_token, config: { apiDomain } });
  const orgs = (await get('/organizations')).organizations || [];
  if (!orgs.length) throw new ConnectorError('PERMANENT', 'This Zoho account has no Zoho Books organization.');
  const org = orgs.find((o) => o.is_default_org) || orgs[0];
  return {
    credentials: { refreshToken: tok.refresh_token, accessToken: tok.access_token, expiresAt: Date.now() + Number(tok.expires_in || 3600) * 1000 },
    config: { accountsServer, apiDomain, organizationId: String(org.organization_id), organizations: orgs.length, currency: org.currency_code || null },
    externalAccountId: String(org.organization_id),
    label: org.name || 'Zoho Books',
  };
}

async function refresh(credentials, config) {
  const tok = await tokenRequest(checkedAccountsServer(config.accountsServer), { grant_type: 'refresh_token', refresh_token: credentials.refreshToken });
  return {
    credentials: { ...credentials, accessToken: tok.access_token, expiresAt: Date.now() + Number(tok.expires_in || 3600) * 1000 },
    config: tok.api_domain ? { ...config, apiDomain: checkedApiDomain(tok.api_domain) } : config,
  };
}

async function pages(get, path, key, query = {}) {
  const out = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const j = await get(path, { ...query, page: String(page), per_page: String(PER_PAGE) });
    out.push(...(j[key] || []));
    if (!j.page_context || !j.page_context.has_more_page) return { rows: out, truncated: false };
  }
  return { rows: out, truncated: true };
}

const day = (s) => (s && /^\d{4}-\d{2}-\d{2}/.test(String(s)) ? String(s).slice(0, 10) : null);
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

function mapInvoice(i) {
  return {
    sourceId: String(i.invoice_id),
    customerRef: i.customer_id ? String(i.customer_id) : null,
    customerName: i.customer_name || null,
    number: i.invoice_number || null,
    amount: num(i.total),
    balance: num(i.balance),
    currency: i.currency_code ? String(i.currency_code).toUpperCase() : null,
    issuedOn: day(i.date),
    dueOn: day(i.due_date),
    paidOn: day(i.last_payment_date),
    status: i.status || null,
  };
}

function mapCustomer(c) {
  return {
    sourceId: String(c.contact_id),
    name: c.contact_name || c.company_name || null,
    email: c.email || null,
    phone: c.mobile || c.phone || null,
    gstin: c.gst_no || null,
  };
}

const connector = defineConnector({
  id: ID,
  provider: 'Zoho',
  version: '1.0.0',
  mode: 'api',
  authType: 'oauth',
  capabilities: ['READ'],
  rateLimit: { requestsPerMinute: 100 },
  entities: {
    customer: { map: mapCustomer, sourceFields: ['contact_id', 'contact_name'] },
    invoice: { map: mapInvoice, sourceFields: ['invoice_id', 'customer_id', 'total', 'balance', 'date'] },
  },
  async test({ credentials }) {
    await credentials.get('/organizations');
    return { ok: true };
  },
  async read(type, opts, { credentials }) {
    if (type === 'customer') return (await pages(credentials.get, '/contacts', 'contacts', { contact_type: 'customer' })).rows;
    const { rows } = await pages(credentials.get, '/invoices', 'invoices');
    return rows.filter((i) => !SKIP_STATUSES.has(String(i.status || '').toLowerCase()));
  },
});

module.exports = {
  id: ID,
  authKind: 'oauth',
  flag: 'FEATURE_CONNECTOR_ZOHO_BOOKS_ENABLED',
  requiresEnv: ['ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET', 'PUBLIC_API_URL', 'OUTBOUND_CREDENTIALS_KEY'],
  scopes: SCOPES,
  entities: ['customer', 'invoice'],
  authorizeUrl, exchangeCode, refresh, makeClient, connector,
  mapInvoice, mapCustomer, ACCOUNTS_HOST_RE, API_HOST_RE,
};
