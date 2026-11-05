'use strict';
// lib/connectors/apps/quickbooks.js — QuickBooks Online, read-only, through
// Intuit OAuth 2.0.
//
// Scope: com.intuit.quickbooks.accounting. Intuit has no read-only variant of
// that scope, so read-only is enforced here: this connector declares READ
// only (lib/connectors/sdk.js refuses anything else) and only sends GET
// requests to the query and companyinfo endpoints.
//
// Intuit rotates the refresh token: every refresh returns a new one, which is
// saved before the old one is discarded (lib/connectors/apps/accounts.js).
// QUICKBOOKS_ENVIRONMENT=sandbox points at Intuit's sandbox companies.

const { defineConnector, ConnectorError } = require('../sdk');
const { vendorRequest, base, form } = require('./http');

const ID = 'quickbooks';
const SCOPES = ['com.intuit.quickbooks.accounting'];
const PAGE = 1000;   // Intuit's maximum per query
const MAX_PAGES = 10;
const MINOR_VERSION = '75';

const env = () => ({ clientId: process.env.QUICKBOOKS_CLIENT_ID, clientSecret: process.env.QUICKBOOKS_CLIENT_SECRET, sandbox: process.env.QUICKBOOKS_ENVIRONMENT === 'sandbox' });
const apiBase = () => base('quickbooksApi', env().sandbox ? 'https://sandbox-quickbooks.api.intuit.com' : 'https://quickbooks.api.intuit.com');
const tokenUrl = () => `${base('intuitOauth', 'https://oauth.platform.intuit.com')}/oauth2/v1/tokens/bearer`;

function authorizeUrl({ state, redirectUri }) {
  return `${base('intuitAppcenter', 'https://appcenter.intuit.com')}/connect/oauth2?${new URLSearchParams({
    client_id: env().clientId, scope: SCOPES.join(' '), redirect_uri: redirectUri, response_type: 'code', state,
  })}`;
}

async function tokenRequest(params) {
  const e = env();
  const r = await vendorRequest(tokenUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${Buffer.from(`${e.clientId}:${e.clientSecret}`).toString('base64')}` },
    body: form(params), raw: true, label: 'Intuit',
  });
  if (r.status >= 500) throw new ConnectorError('TRANSIENT', `Intuit answered HTTP ${r.status}`);
  if (r.status === 429) throw new ConnectorError('RATE_LIMITED', 'Intuit is rate limiting sign-ins');
  if (r.status >= 400 || !r.json?.access_token) throw new ConnectorError('AUTH_EXPIRED', `Intuit refused the sign-in (${String(r.json?.error || `HTTP ${r.status}`).slice(0, 80)}). Connect QuickBooks again.`);
  return r.json;
}

const tokens = (tok) => ({
  refreshToken: tok.refresh_token,
  accessToken: tok.access_token,
  expiresAt: Date.now() + Number(tok.expires_in || 3600) * 1000,
});

const REALM_RE = /^\d{1,30}$/;

function makeClient({ accessToken, config }) {
  if (!REALM_RE.test(String(config.realmId || ''))) throw new ConnectorError('PERMANENT', 'The QuickBooks company id is missing. Connect QuickBooks again.');
  const root = `${apiBase()}/v3/company/${config.realmId}`;
  return async (path, query = {}) => {
    const r = await vendorRequest(`${root}${path}?${new URLSearchParams({ ...query, minorversion: MINOR_VERSION })}`, {
      headers: { Authorization: `Bearer ${accessToken}` }, label: 'QuickBooks',
    });
    return r.json || {};
  };
}

async function exchangeCode({ query, redirectUri }) {
  const realmId = String(query.realmId || '');
  if (!REALM_RE.test(realmId)) throw new ConnectorError('PERMANENT', 'Intuit did not say which QuickBooks company was chosen.');
  const tok = await tokenRequest({ grant_type: 'authorization_code', code: String(query.code), redirect_uri: redirectUri });
  if (!tok.refresh_token) throw new ConnectorError('AUTH_EXPIRED', 'Intuit did not grant offline access.');
  const get = makeClient({ accessToken: tok.access_token, config: { realmId } });
  const info = (await get(`/companyinfo/${realmId}`)).CompanyInfo || {};
  return {
    credentials: tokens(tok),
    config: { realmId, environment: env().sandbox ? 'sandbox' : 'production', country: info.Country || null },
    externalAccountId: realmId,
    label: info.CompanyName || 'QuickBooks company',
  };
}

async function refresh(credentials, config) {
  const tok = await tokenRequest({ grant_type: 'refresh_token', refresh_token: credentials.refreshToken });
  // A rotated refresh token replaces the old one; Intuit may also return the same.
  return { credentials: { ...tokens(tok), refreshToken: tok.refresh_token || credentials.refreshToken }, config };
}

async function queryAll(get, entity) {
  const out = [];
  for (let p = 0; p < MAX_PAGES; p++) {
    const q = `select * from ${entity} startposition ${p * PAGE + 1} maxresults ${PAGE}`;
    const rows = (await get('/query', { query: q })).QueryResponse?.[entity] || [];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

const day = (s) => (s && /^\d{4}-\d{2}-\d{2}/.test(String(s)) ? String(s).slice(0, 10) : null);
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

function mapInvoice(i) {
  return {
    sourceId: String(i.Id),
    customerRef: i.CustomerRef?.value ? String(i.CustomerRef.value) : null,
    customerName: i.CustomerRef?.name || null,
    number: i.DocNumber || null,
    amount: num(i.TotalAmt),
    balance: num(i.Balance),
    currency: i.CurrencyRef?.value ? String(i.CurrencyRef.value).toUpperCase() : null,
    issuedOn: day(i.TxnDate),
    dueOn: day(i.DueDate),
    paidOn: i.paidOn || null, // filled from linked Payments in read()
    status: num(i.Balance) === 0 ? 'paid' : 'open',
  };
}

function mapCustomer(c) {
  return {
    sourceId: String(c.Id),
    name: c.DisplayName || c.CompanyName || null,
    email: c.PrimaryEmailAddr?.Address || null,
    phone: c.Mobile?.FreeFormNumber || c.PrimaryPhone?.FreeFormNumber || null,
  };
}

// Latest payment date per invoice, from Payment.Line[].LinkedTxn.
function paidDates(payments) {
  const m = new Map();
  for (const p of payments) {
    const d = day(p.TxnDate);
    if (!d) continue;
    for (const line of p.Line || []) {
      for (const t of line.LinkedTxn || []) {
        if (t.TxnType !== 'Invoice') continue;
        const prev = m.get(String(t.TxnId));
        if (!prev || d > prev) m.set(String(t.TxnId), d);
      }
    }
  }
  return m;
}

const connector = defineConnector({
  id: ID,
  provider: 'Intuit',
  version: '1.0.0',
  mode: 'api',
  authType: 'oauth',
  capabilities: ['READ'],
  rateLimit: { requestsPerMinute: 500 },
  entities: {
    customer: { map: mapCustomer, sourceFields: ['Id', 'DisplayName'] },
    invoice: { map: mapInvoice, sourceFields: ['Id', 'CustomerRef', 'TotalAmt', 'Balance', 'TxnDate'] },
  },
  async test({ credentials }) {
    await credentials.get('/query', { query: 'select count(*) from Invoice' });
    return { ok: true };
  },
  async read(type, opts, { credentials }) {
    if (type === 'customer') return queryAll(credentials.get, 'Customer');
    const [invoices, payments] = [await queryAll(credentials.get, 'Invoice'), await queryAll(credentials.get, 'Payment')];
    const paid = paidDates(payments);
    // A voided invoice keeps its row with a zero total; it is not a receivable.
    return invoices.filter((i) => Number(i.TotalAmt) > 0).map((i) => ({ ...i, paidOn: Number(i.Balance) === 0 ? paid.get(String(i.Id)) || null : null }));
  },
});

module.exports = {
  id: ID,
  authKind: 'oauth',
  flag: 'FEATURE_CONNECTOR_QUICKBOOKS_ENABLED',
  requiresEnv: ['QUICKBOOKS_CLIENT_ID', 'QUICKBOOKS_CLIENT_SECRET', 'PUBLIC_API_URL', 'OUTBOUND_CREDENTIALS_KEY'],
  scopes: SCOPES,
  entities: ['customer', 'invoice'],
  authorizeUrl, exchangeCode, refresh, makeClient, connector,
  mapInvoice, mapCustomer, paidDates,
};
