'use strict';
// lib/connectors/apps/zohoInventory.js — Zoho Inventory, read-only, through
// the same Zoho OAuth app as Zoho Books.
//
// Scopes: ZohoInventory.items.READ, ZohoInventory.salesorders.READ,
// ZohoInventory.purchaseorders.READ and ZohoInventory.settings.READ (to list
// the organizations). Nothing that can write is requested, and only GET
// requests are ever sent. Data centre handling (accounts-server, api_domain)
// is Zoho Books' code, reused, so the same host checks apply.
//
// What it feeds (lib/connectors/feeds):
//   products        items with their stock on hand
//   orders          open sales orders, one row per line, outstanding =
//                   ordered − shipped, promised date = the order's expected
//                   shipment date
//   purchase_lines  open purchase orders, one row per line, with quantity
//                   received and the expected delivery date
// Sales and purchase order lines are only in each order's detail, so a run
// reads at most MAX_DOCUMENTS orders of each kind and says when it stopped.
//
// Verified against Zoho Inventory's API reference and recorded fixtures
// (tests/dataFeeds.test.js); not yet run against a live Zoho organization.

const { defineConnector, ConnectorError } = require('../sdk');
const { vendorRequest, base } = require('./http');
const zoho = require('./zohoBooks');

const ID = 'zoho_inventory';
const SCOPES = ['ZohoInventory.items.READ', 'ZohoInventory.salesorders.READ', 'ZohoInventory.purchaseorders.READ', 'ZohoInventory.settings.READ'];
const PER_PAGE = 200;
const MAX_PAGES = 50;
const MAX_DOCUMENTS = 300;
// Header statuses that are not an open commitment.
const SO_CLOSED = new Set(['draft', 'void', 'fulfilled', 'closed', 'onhold_draft']);
const PO_CLOSED = new Set(['draft', 'cancelled', 'billed', 'closed', 'received']);

const env = () => ({ clientId: process.env.ZOHO_CLIENT_ID, accountsUrl: (process.env.ZOHO_ACCOUNTS_URL || 'https://accounts.zoho.com').replace(/\/+$/, '') });

function authorizeUrl({ state, redirectUri }) {
  const e = env();
  return `${base('zohoAccounts', e.accountsUrl)}/oauth/v2/auth?${new URLSearchParams({
    scope: SCOPES.join(','), client_id: e.clientId, response_type: 'code', access_type: 'offline', prompt: 'consent', redirect_uri: redirectUri, state,
  })}`;
}

function makeClient({ accessToken, config }) {
  const apiDomain = zoho.checkedApiDomain(config.apiDomain);
  return async (path, query = {}) => {
    const q = new URLSearchParams({ ...(config.organizationId ? { organization_id: config.organizationId } : {}), ...query });
    const r = await vendorRequest(`${apiDomain}/inventory/v1${path}?${q}`, { headers: { Authorization: `Zoho-oauthtoken ${accessToken}` }, label: 'Zoho Inventory' });
    if (r.json && r.json.code !== undefined && r.json.code !== 0) throw new ConnectorError('PERMANENT', `Zoho Inventory: ${String(r.json.message || r.json.code).slice(0, 200)}`);
    return r.json || {};
  };
}

async function exchangeCode({ query, redirectUri }) {
  const accountsServer = zoho.checkedAccountsServer(query['accounts-server']);
  const tok = await zoho.tokenRequest(accountsServer, { grant_type: 'authorization_code', code: String(query.code), redirect_uri: redirectUri });
  if (!tok.refresh_token) throw new ConnectorError('AUTH_EXPIRED', 'Zoho did not grant offline access. Connect again and allow access.');
  const apiDomain = zoho.checkedApiDomain(tok.api_domain);
  const get = makeClient({ accessToken: tok.access_token, config: { apiDomain } });
  const orgs = (await get('/organizations')).organizations || [];
  if (!orgs.length) throw new ConnectorError('PERMANENT', 'This Zoho account has no Zoho Inventory organization.');
  const org = orgs.find((o) => o.is_default_org) || orgs[0];
  return {
    credentials: { refreshToken: tok.refresh_token, accessToken: tok.access_token, expiresAt: Date.now() + Number(tok.expires_in || 3600) * 1000 },
    config: { accountsServer, apiDomain, organizationId: String(org.organization_id), organizations: orgs.length, currency: org.currency_code || null },
    externalAccountId: String(org.organization_id),
    label: `${org.name || 'Zoho Inventory'} (Zoho Inventory)`,
  };
}

async function refresh(credentials, config) {
  const tok = await zoho.tokenRequest(zoho.checkedAccountsServer(config.accountsServer), { grant_type: 'refresh_token', refresh_token: credentials.refreshToken });
  return {
    credentials: { ...credentials, accessToken: tok.access_token, expiresAt: Date.now() + Number(tok.expires_in || 3600) * 1000 },
    config: tok.api_domain ? { ...config, apiDomain: zoho.checkedApiDomain(tok.api_domain) } : config,
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

const day = (s) => (s && /^\d{4}-\d{2}-\d{2}/.test(String(s)) ? String(s).slice(0, 10) : '');
const str = (v) => (v === null || v === undefined ? '' : String(v));
const n = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

/** Pure: items → product rows. */
function productRows(items) {
  return items.filter((i) => String(i.status || 'active').toLowerCase() === 'active').map((i) => {
    const tracked = i.item_type === undefined || /inventory/.test(String(i.item_type)) || i.track_inventory === true;
    const stock = n(i.stock_on_hand ?? i.actual_available_stock);
    return {
      SKU: str(i.sku),
      'Product Name': str(i.name),
      'On Hand': tracked && stock !== null ? str(Math.max(0, stock)) : '',
      Unit: str(i.unit),
      'Unit Price': str(i.rate),
      Category: str(i.category_name || i.group_name),
    };
  });
}

/** Pure: sales order details → customer order rows. */
function orderRows(salesorders) {
  const rows = [];
  for (const so of salesorders) {
    for (const li of so.line_items || []) {
      const qty = n(li.quantity) || 0;
      const shipped = n(li.quantity_shipped);
      const cancelled = n(li.quantity_cancelled) || 0;
      const open = shipped === null ? null : Math.max(0, qty - shipped - cancelled);
      rows.push({
        'Customer Name': str(so.customer_name),
        'Customer ID': str(so.customer_id),
        'Order Number': str(so.salesorder_number || so.salesorder_id),
        'Line Ref': str(li.line_item_id),
        'Record ID': `zoho_inventory:so:${so.salesorder_id}:${li.line_item_id}`,
        SKU: str(li.sku),
        'Product Name': str(li.name),
        Quantity: str(qty),
        'Outstanding Qty': open === null ? '' : str(open),
        'Unit Price': str(li.rate),
        Currency: str(so.currency_code),
        'Order Date': day(so.date),
        'Promised Date': day(so.shipment_date),
        // Only words the import understands: a confirmed order not yet shipped is "confirmed".
        Status: open === 0 ? 'fulfilled' : shipped ? 'partially shipped' : 'confirmed',
      });
    }
  }
  return rows;
}

/** Pure: purchase order details → purchase line rows. */
function purchaseRows(purchaseorders) {
  const rows = [];
  for (const po of purchaseorders) {
    for (const li of po.line_items || []) {
      const qty = n(li.quantity) || 0;
      const received = n(li.quantity_received);
      rows.push({
        'Supplier Name': str(po.vendor_name),
        'Supplier ID': str(po.vendor_id),
        'Supplier GSTIN': str(po.gst_no),
        'PO Number': str(po.purchaseorder_number || po.purchaseorder_id),
        'Line Ref': str(li.line_item_id),
        'Record ID': `zoho_inventory:po:${po.purchaseorder_id}:${li.line_item_id}`,
        SKU: str(li.sku),
        'Product Name': str(li.name),
        Quantity: str(qty),
        'Received Qty': received === null ? '' : str(received),
        'Expected Date': day(po.delivery_date || po.expected_delivery_date),
        'PO Date': day(po.date),
        'Unit Cost': str(li.rate),
        Currency: str(po.currency_code),
        Status: received !== null && received >= qty ? 'received' : received ? 'partially received' : 'open',
      });
    }
  }
  return rows;
}

async function details(get, list, idKey, path, key) {
  const out = [];
  for (const d of list.slice(0, MAX_DOCUMENTS)) out.push((await get(`${path}/${encodeURIComponent(d[idKey])}`))[key] || {});
  return out;
}

async function feedRows(get, kind, config = {}) {
  if (kind === 'products') {
    const { rows, truncated } = await pages(get, '/items', 'items');
    return { rows: productRows(rows), truncated, currency: config.currency || null };
  }
  if (kind === 'orders') {
    const { rows, truncated } = await pages(get, '/salesorders', 'salesorders');
    const open = rows.filter((s) => !SO_CLOSED.has(String(s.status || '').toLowerCase()) && String(s.shipped_status || '').toLowerCase() !== 'fulfilled');
    return { rows: orderRows(await details(get, open, 'salesorder_id', '/salesorders', 'salesorder')), truncated: truncated || open.length > MAX_DOCUMENTS, currency: config.currency || null };
  }
  if (kind === 'purchase_lines') {
    const { rows, truncated } = await pages(get, '/purchaseorders', 'purchaseorders');
    const open = rows.filter((p) => !PO_CLOSED.has(String(p.status || '').toLowerCase()) && String(p.received_status || '').toLowerCase() !== 'received');
    return { rows: purchaseRows(await details(get, open, 'purchaseorder_id', '/purchaseorders', 'purchaseorder')), truncated: truncated || open.length > MAX_DOCUMENTS, currency: config.currency || null };
  }
  throw new ConnectorError('PERMANENT', 'Zoho Inventory can feed products, customer orders and purchase orders.');
}

const connector = defineConnector({
  id: ID,
  provider: 'Zoho',
  version: '1.0.0',
  mode: 'api',
  authType: 'oauth',
  capabilities: ['READ'],
  rateLimit: { requestsPerMinute: 100 },
  entities: { product: { map: (i) => ({ sourceId: String(i.item_id), name: i.name }), sourceFields: ['item_id', 'name'] } },
  async test({ credentials }) {
    await credentials.get('/organizations');
    return { ok: true };
  },
  async read(type, opts, { credentials }) {
    return (await pages(credentials.get, '/items', 'items')).rows;
  },
});

module.exports = {
  id: ID,
  authKind: 'oauth',
  flag: 'FEATURE_CONNECTOR_ZOHO_INVENTORY_ENABLED',
  requiresEnv: ['ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET', 'PUBLIC_API_URL', 'OUTBOUND_CREDENTIALS_KEY'],
  scopes: SCOPES,
  entities: [],
  feedKinds: ['products', 'orders', 'purchase_lines'],
  authorizeUrl, exchangeCode, refresh, makeClient, connector, feedRows, productRows, orderRows, purchaseRows,
};
