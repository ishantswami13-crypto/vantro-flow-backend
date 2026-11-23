'use strict';
// lib/connectors/apps/shopify.js — Shopify, read-only, with a custom app's
// Admin API access token.
//
// The owner creates a custom app in their Shopify admin (Settings › Apps and
// sales channels › Develop apps), gives it the read_orders, read_products and
// read_inventory scopes only, installs it and pastes the Admin API access
// token (shpat_…) with the store name. Only GET requests are ever sent.
//
// What it feeds (lib/connectors/feeds): open orders become customer order
// lines (outstanding = Shopify's fulfillable quantity) and product variants
// become products with their stock on hand. Shopify has no promised delivery
// date, so none is invented: those orders show as "cannot be checked" until a
// date arrives from somewhere else.
//
// Verified against Shopify's REST Admin API reference and recorded fixtures
// (tests/dataFeeds.test.js); not yet run against a live store from this code.

const { defineConnector, ConnectorError } = require('../sdk');
const { vendorRequest, base } = require('./http');

const ID = 'shopify';
const API_VERSION = '2025-01';
const SHOP_RE = /^[a-z0-9][a-z0-9-]{0,59}$/;
const TOKEN_RE = /^shp(at|ca|pa)_[A-Za-z0-9]{16,64}$/;
const PAGE = 250;
const MAX_PAGES = 40; // 10,000 records per object per run

function shopRoot(shop) {
  return base('shopifyApi', `https://${shop}.myshopify.com`);
}

/** get(path, query) → { json, next } where next is the page_info of the next page. */
function makeClient({ credentials, config }) {
  const shop = String(config.shop || '');
  if (!SHOP_RE.test(shop)) throw new ConnectorError('PERMANENT', 'The Shopify store name is missing. Connect Shopify again.');
  const root = `${shopRoot(shop)}/admin/api/${API_VERSION}`;
  return async (path, query = {}) => {
    const r = await vendorRequest(`${root}${path}?${new URLSearchParams(query)}`, { headers: { 'X-Shopify-Access-Token': credentials.accessToken }, label: 'Shopify' });
    const link = String(r.headers.link || '');
    const m = /<[^>]*[?&]page_info=([^&>]+)[^>]*>;\s*rel="next"/.exec(link);
    return { json: r.json || {}, next: m ? decodeURIComponent(m[1]) : null };
  };
}

const fields = [
  { name: 'shop', label: 'Store name', secret: false, placeholder: 'acme-traders', help: 'The part before .myshopify.com in your admin address.' },
  { name: 'accessToken', label: 'Admin API access token', secret: true, placeholder: 'shpat_…', help: 'Settings › Apps and sales channels › Develop apps › your app › API credentials. Give the app read_orders, read_products and read_inventory only.' },
];

function cleanShop(raw) {
  return String(raw || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\.myshopify\.com.*$/, '').replace(/\/.*$/, '');
}

async function verify(input = {}) {
  const shop = cleanShop(input.shop);
  const accessToken = String(input.accessToken || '').trim();
  if (!SHOP_RE.test(shop)) throw Object.assign(new Error('Enter the store name: the part before .myshopify.com.'), { status: 400 });
  if (!TOKEN_RE.test(accessToken)) throw Object.assign(new Error('Paste the Admin API access token; it starts with shpat_.'), { status: 400 });
  const get = makeClient({ credentials: { accessToken }, config: { shop } });
  let info;
  try {
    info = (await get('/shop.json', { fields: 'name,currency,iana_timezone' })).json.shop || {};
  } catch (err) {
    if (err.kind === 'AUTH_EXPIRED') throw Object.assign(new Error('Shopify did not accept that store name and token.'), { status: 400 });
    if (err.status === 404) throw Object.assign(new Error(`There is no Shopify store called ${shop}.`), { status: 400 });
    throw err;
  }
  return {
    credentials: { accessToken },
    config: { shop, currency: info.currency ? String(info.currency).toUpperCase() : null, timezone: info.iana_timezone || null },
    externalAccountId: shop,
    label: `${info.name || shop} (Shopify)`,
  };
}

async function all(get, path, key, query) {
  const out = [];
  let q = { ...query, limit: String(PAGE) };
  for (let p = 0; p < MAX_PAGES; p++) {
    const { json, next } = await get(path, q);
    out.push(...(json[key] || []));
    if (!next) return { rows: out, truncated: false };
    // Shopify allows only limit (and fields) next to page_info.
    q = { limit: String(PAGE), page_info: next, ...(query.fields ? { fields: query.fields } : {}) };
  }
  return { rows: out, truncated: true };
}

const day = (s) => (s && /^\d{4}-\d{2}-\d{2}/.test(String(s)) ? String(s).slice(0, 10) : '');
const str = (v) => (v === null || v === undefined ? '' : String(v));

function customerName(o) {
  const c = o.customer || {};
  const b = o.billing_address || {};
  return [c.first_name, c.last_name].filter(Boolean).join(' ').trim()
    || b.company || b.name || [b.first_name, b.last_name].filter(Boolean).join(' ').trim()
    || o.email || c.email || '';
}

/** Pure: Shopify orders → customer order rows (canonical column names). */
function orderRows(orders, { currency = null } = {}) {
  const rows = [];
  for (const o of orders) {
    if (o.cancelled_at) continue;
    for (const li of o.line_items || []) {
      if (li.requires_shipping === false && li.product_exists === false) continue;
      const qty = Number(li.quantity || 0);
      const open = li.fulfillable_quantity === undefined || li.fulfillable_quantity === null ? null : Number(li.fulfillable_quantity);
      const status = open === 0 ? 'fulfilled' : open !== null && open < qty ? 'partial' : 'open';
      rows.push({
        'Customer Name': customerName(o),
        'Customer ID': o.customer?.id ? str(o.customer.id) : '',
        'Order Number': str(o.name || o.order_number || o.id),
        'Line Ref': str(li.id),
        'Record ID': `shopify:${o.id}:${li.id}`,
        SKU: str(li.sku),
        'Product Name': [li.title, li.variant_title].filter(Boolean).join(' - '),
        Quantity: str(qty),
        'Outstanding Qty': open === null ? '' : str(open),
        'Unit Price': str(li.price),
        Currency: str(o.currency || currency || ''),
        'Order Date': day(o.created_at),
        'Promised Date': '',
        Status: status,
      });
    }
  }
  return rows;
}

/** Pure: Shopify products → product rows, one per variant. */
function productRows(products) {
  const rows = [];
  for (const p of products) {
    if (p.status && p.status !== 'active') continue;
    for (const v of p.variants || []) {
      const tracked = v.inventory_management === 'shopify';
      rows.push({
        SKU: str(v.sku),
        'Product Name': v.title && v.title !== 'Default Title' ? `${p.title} - ${v.title}` : str(p.title),
        // Stock only when Shopify tracks it; an untracked variant has no stated stock.
        'On Hand': tracked && v.inventory_quantity !== null && v.inventory_quantity !== undefined ? str(Math.max(0, Number(v.inventory_quantity))) : '',
        Unit: '',
        'Unit Price': str(v.price),
        Category: str(p.product_type),
      });
    }
  }
  return rows;
}

/** Rows for one feed kind. */
async function feedRows(get, kind, config = {}) {
  if (kind === 'orders') {
    const { rows, truncated } = await all(get, '/orders.json', 'orders', { status: 'open' });
    return { rows: orderRows(rows, { currency: config.currency }), truncated, currency: config.currency || null };
  }
  if (kind === 'products') {
    const { rows, truncated } = await all(get, '/products.json', 'products', { status: 'active' });
    return { rows: productRows(rows), truncated, currency: config.currency || null };
  }
  throw new ConnectorError('PERMANENT', 'Shopify can feed customer orders and products.');
}

const connector = defineConnector({
  id: ID,
  provider: 'Shopify',
  version: '1.0.0',
  mode: 'api',
  authType: 'api_key',
  capabilities: ['READ'],
  rateLimit: { requestsPerMinute: 120 },
  entities: { order: { map: (o) => ({ sourceId: String(o.id), date: day(o.created_at) }), sourceFields: ['id', 'created_at'] } },
  async test({ credentials }) {
    await credentials.get('/shop.json', { fields: 'name' });
    return { ok: true };
  },
  async read(type, opts, { credentials }) {
    return (await all(credentials.get, '/orders.json', 'orders', { status: 'open' })).rows;
  },
});

module.exports = {
  id: ID,
  authKind: 'api_key',
  flag: 'FEATURE_CONNECTOR_SHOPIFY_ENABLED',
  requiresEnv: ['OUTBOUND_CREDENTIALS_KEY'],
  entities: [],
  feedKinds: ['orders', 'products'],
  fields, verify, makeClient, connector, feedRows, orderRows, productRows, cleanShop,
};
