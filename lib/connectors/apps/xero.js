'use strict';
// lib/connectors/apps/xero.js — Xero, read-only, through Xero OAuth 2.0.
//
// What it reads:
//   invoice sync  sales invoices (ACCREC) with what is still due and when
//                 they were paid, and customer contacts with phone and email
//   data feeds    inventory items with quantity on hand, and approved
//                 purchase orders (lib/connectors/feeds)
//
// Scopes are read-only (*.read) plus offline_access for the refresh token.
// Xero rotates the refresh token on every refresh; the new one is saved
// before the old one is dropped (lib/connectors/apps/accounts.js). Xero
// apps created after its 2026 scope change may need granular scopes;
// XERO_SCOPES overrides the list without a code change.
//
// One Xero sign-in can grant several organisations; Starlane reads the first
// organisation the owner chose (its tenant id is stored on the account) and
// only ever sends GET requests, with that tenant id on each.

const { defineConnector, ConnectorError } = require('../sdk');
const { vendorRequest, base, form } = require('./http');

const ID = 'xero';
const DEFAULT_SCOPES = ['offline_access', 'accounting.transactions.read', 'accounting.contacts.read', 'accounting.settings.read'];
const MAX_PAGES = 50;   // Xero pages are 100 records
const TENANT_RE = /^[0-9a-f-]{36}$/i;

const env = () => ({ clientId: process.env.XERO_CLIENT_ID, clientSecret: process.env.XERO_CLIENT_SECRET });
const scopes = () => (process.env.XERO_SCOPES ? process.env.XERO_SCOPES.split(/[\s,]+/).filter(Boolean) : DEFAULT_SCOPES);
const apiRoot = () => base('xeroApi', 'https://api.xero.com');

function authorizeUrl({ state, redirectUri }) {
  return `${base('xeroLogin', 'https://login.xero.com')}/identity/connect/authorize?${new URLSearchParams({
    response_type: 'code', client_id: env().clientId, redirect_uri: redirectUri, scope: scopes().join(' '), state,
  })}`;
}

async function tokenRequest(params) {
  const e = env();
  const r = await vendorRequest(`${base('xeroIdentity', 'https://identity.xero.com')}/connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${Buffer.from(`${e.clientId}:${e.clientSecret}`).toString('base64')}` },
    body: form(params), raw: true, label: 'Xero',
  });
  if (r.status >= 500) throw new ConnectorError('TRANSIENT', `Xero answered HTTP ${r.status}`);
  if (r.status === 429) throw new ConnectorError('RATE_LIMITED', 'Xero is rate limiting sign-ins');
  if (r.status >= 400 || !r.json?.access_token) throw new ConnectorError('AUTH_EXPIRED', `Xero refused the sign-in (${String(r.json?.error || `HTTP ${r.status}`).slice(0, 80)}). Connect Xero again.`);
  return r.json;
}

const tokens = (tok) => ({ refreshToken: tok.refresh_token, accessToken: tok.access_token, expiresAt: Date.now() + Number(tok.expires_in || 1800) * 1000 });

function makeClient({ accessToken, config }) {
  if (!TENANT_RE.test(String(config.tenantId || ''))) throw new ConnectorError('PERMANENT', 'The Xero organisation is missing. Connect Xero again.');
  return async (path, query = {}) => {
    const qs = new URLSearchParams(query).toString();
    const r = await vendorRequest(`${apiRoot()}/api.xro/2.0${path}${qs ? `?${qs}` : ''}`, {
      headers: { Authorization: `Bearer ${accessToken}`, 'xero-tenant-id': config.tenantId }, label: 'Xero',
    });
    return r.json || {};
  };
}

async function exchangeCode({ query, redirectUri }) {
  const tok = await tokenRequest({ grant_type: 'authorization_code', code: String(query.code || ''), redirect_uri: redirectUri });
  if (!tok.refresh_token) throw new ConnectorError('AUTH_EXPIRED', 'Xero did not grant offline access.');
  const r = await vendorRequest(`${apiRoot()}/connections`, { headers: { Authorization: `Bearer ${tok.access_token}` }, label: 'Xero' });
  const orgs = (Array.isArray(r.json) ? r.json : []).filter((c) => c.tenantType === 'ORGANISATION' && TENANT_RE.test(String(c.tenantId || '')));
  if (!orgs.length) throw new ConnectorError('PERMANENT', 'No Xero organisation was chosen. Connect Xero again and pick the organisation.');
  const org = orgs[0];
  let currency = null;
  try {
    const get = makeClient({ accessToken: tok.access_token, config: { tenantId: org.tenantId } });
    currency = (await get('/Organisation')).Organisations?.[0]?.BaseCurrency || null;
  } catch { /* the currency is a convenience; the import asks when it is missing */ }
  return {
    credentials: tokens(tok),
    config: { tenantId: org.tenantId, currency, organisations: orgs.length },
    externalAccountId: org.tenantId,
    label: org.tenantName || 'Xero organisation',
  };
}

async function refresh(credentials, config) {
  const tok = await tokenRequest({ grant_type: 'refresh_token', refresh_token: credentials.refreshToken });
  return { credentials: { ...tokens(tok), refreshToken: tok.refresh_token || credentials.refreshToken }, config };
}

async function pages(get, path, key, query = {}) {
  const out = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const rows = (await get(path, { ...query, page: String(page) }))[key] || [];
    out.push(...rows);
    if (rows.length < 100) return { rows: out, truncated: false };
  }
  return { rows: out, truncated: true };
}

/** Xero dates come as "2026-06-15T00:00:00" (…String fields) or "/Date(1781481600000+0000)/". */
function day(v) {
  if (!v) return null;
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = /\/Date\((-?\d+)/.exec(s);
  return m ? new Date(Number(m[1])).toISOString().slice(0, 10) : null;
}
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const str = (v) => (v === null || v === undefined ? '' : String(v));

function mapInvoice(i) {
  const due = num(i.AmountDue);
  return {
    sourceId: String(i.InvoiceID),
    customerRef: i.Contact?.ContactID ? String(i.Contact.ContactID) : null,
    customerName: i.Contact?.Name || null,
    number: i.InvoiceNumber || null,
    amount: num(i.Total),
    balance: due,
    currency: i.CurrencyCode ? String(i.CurrencyCode).toUpperCase() : null,
    issuedOn: day(i.DateString || i.Date),
    dueOn: day(i.DueDateString || i.DueDate),
    paidOn: due === 0 ? day(i.FullyPaidOnDate) : null,
    status: i.Status === 'PAID' || due === 0 ? 'paid' : 'open',
  };
}

function mapCustomer(c) {
  const phones = c.Phones || [];
  const phone = (p) => (p && p.PhoneNumber ? [p.PhoneCountryCode ? `+${String(p.PhoneCountryCode).replace(/^\+/, '')}` : '', p.PhoneAreaCode || '', p.PhoneNumber].join(' ').replace(/\s+/g, ' ').trim() : null);
  return {
    sourceId: String(c.ContactID),
    name: c.Name || null,
    email: c.EmailAddress || null,
    phone: phone(phones.find((p) => p.PhoneType === 'MOBILE' && p.PhoneNumber)) || phone(phones.find((p) => p.PhoneType === 'DEFAULT' && p.PhoneNumber)),
  };
}

// ── Operational feeds ───────────────────────────────────────────────────
// Xero has no sales orders (quotes are not orders), so it feeds products
// and purchase orders.

/** Pure: Items → product rows. Only tracked inventory carries stock. */
function productRows(items) {
  return items.filter((i) => i.IsTrackedAsInventory && (i.Code || i.Name)).map((i) => ({
    SKU: str(i.Code),
    'Product Name': str(i.Name || i.Code),
    'On Hand': i.QuantityOnHand === null || i.QuantityOnHand === undefined ? '' : str(Math.max(0, Number(i.QuantityOnHand))),
    Unit: '',
    'Unit Price': str(i.SalesDetails?.UnitPrice ?? ''),
    Category: '',
  }));
}

/**
 * Pure: approved purchase orders → purchase line rows. Xero does not say how
 * much of a purchase order has arrived, so received stays blank; a billed
 * order is no longer AUTHORISED and drops out (closed).
 */
function purchaseRows(purchaseOrders) {
  const rows = [];
  for (const po of purchaseOrders) {
    if (po.Status !== 'AUTHORISED') continue;
    (po.LineItems || []).forEach((line, idx) => {
      if (!line.ItemCode && !line.Description) return;
      const lineId = line.LineItemID || String(idx + 1);
      rows.push({
        'Supplier Name': str(po.Contact?.Name),
        'Supplier ID': str(po.Contact?.ContactID),
        'PO Number': str(po.PurchaseOrderNumber || po.PurchaseOrderID),
        'Line Ref': str(lineId),
        'Record ID': `xero:po:${po.PurchaseOrderID}:${lineId}`,
        SKU: str(line.ItemCode),
        'Product Name': str(line.ItemCode ? '' : line.Description).slice(0, 200),
        Quantity: str(line.Quantity),
        'Expected Date': day(po.DeliveryDateString || po.DeliveryDate) || '',
        'PO Date': day(po.DateString || po.Date) || '',
        'Unit Cost': str(line.UnitAmount),
        Currency: str(po.CurrencyCode),
        Status: 'open',
      });
    });
  }
  return rows;
}

async function feedRows(get, kind, config = {}) {
  const currency = config.currency || null;
  if (kind === 'products') {
    const items = (await get('/Items')).Items || [];
    return { rows: productRows(items), truncated: false, currency };
  }
  if (kind === 'purchase_lines') {
    const got = await pages(get, '/PurchaseOrders', 'PurchaseOrders', { status: 'AUTHORISED' });
    return { rows: purchaseRows(got.rows), truncated: got.truncated, currency };
  }
  throw new ConnectorError('PERMANENT', 'Xero can feed products and purchase orders (it has no sales orders).');
}

const connector = defineConnector({
  id: ID,
  provider: 'Xero',
  version: '1.0.0',
  mode: 'api',
  authType: 'oauth',
  capabilities: ['READ'],
  rateLimit: { requestsPerMinute: 55 },   // Xero allows 60 a minute per organisation
  entities: {
    customer: { map: mapCustomer, sourceFields: ['ContactID', 'Name'] },
    invoice: { map: mapInvoice, sourceFields: ['InvoiceID', 'Contact', 'Total', 'AmountDue', 'Date'] },
  },
  async test({ credentials }) {
    await credentials.get('/Organisation');
    return { ok: true };
  },
  async read(type, opts, { credentials }) {
    if (type === 'customer') return (await pages(credentials.get, '/Contacts', 'Contacts', { where: 'IsCustomer==true' })).rows;
    const got = await pages(credentials.get, '/Invoices', 'Invoices', { where: 'Type=="ACCREC"', Statuses: 'AUTHORISED,PAID', summaryOnly: 'true' });
    // A voided or zero invoice is not a receivable.
    return got.rows.filter((i) => Number(i.Total) > 0);
  },
});

module.exports = {
  id: ID,
  authKind: 'oauth',
  flag: 'FEATURE_CONNECTOR_XERO_ENABLED',
  requiresEnv: ['XERO_CLIENT_ID', 'XERO_CLIENT_SECRET', 'PUBLIC_API_URL', 'OUTBOUND_CREDENTIALS_KEY'],
  get scopes() { return scopes(); },
  entities: ['customer', 'invoice'],
  feedKinds: ['products', 'purchase_lines'],
  authorizeUrl, exchangeCode, refresh, makeClient, connector,
  mapInvoice, mapCustomer, feedRows, productRows, purchaseRows, day,
};
