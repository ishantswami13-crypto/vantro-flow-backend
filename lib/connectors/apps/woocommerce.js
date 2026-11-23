'use strict';
// lib/connectors/apps/woocommerce.js — WooCommerce, read-only, with a REST
// API key the owner creates with Read permission.
//
// The store lives on the owner's own domain, so its address is typed by the
// tenant: every request goes through safeHttp (https only, private and
// internal addresses refused, no redirects followed). The key is created in
// WooCommerce › Settings › Advanced › REST API with Permissions = Read, and
// is sent as HTTP Basic over https, as WooCommerce documents.
//
// What it feeds (lib/connectors/feeds): orders that are pending, processing
// or on hold become customer order lines; products (and the variations of
// variable products) become products with stock on hand where WooCommerce
// manages stock. WooCommerce has no partial fulfilment or promised date, so
// neither is invented.
//
// Verified against the WooCommerce REST API v3 reference and recorded
// fixtures (tests/dataFeeds.test.js); not yet run against a live store.

const { defineConnector, ConnectorError } = require('../sdk');
const { vendorRequest, base } = require('./http');

const ID = 'woocommerce';
const PER_PAGE = 100;
const MAX_PAGES = 100;
const MAX_VARIABLE_PRODUCTS = 200; // each needs one more request for its variations
const KEY_RE = /^ck_[a-f0-9]{20,64}$/;
const SECRET_RE = /^cs_[a-f0-9]{20,64}$/;

function storeUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
  return `${u.origin}${u.pathname.replace(/\/+$/, '').replace(/\/wp-json.*$/, '')}`;
}

function makeClient({ credentials, config }) {
  const root = base('wooApi', storeUrl(config.storeUrl));
  if (!root) throw new ConnectorError('PERMANENT', 'The store address is missing. Connect WooCommerce again.');
  const auth = `Basic ${Buffer.from(`${credentials.consumerKey}:${credentials.consumerSecret}`).toString('base64')}`;
  return async (path, query = {}) => {
    const r = await vendorRequest(`${root}/wp-json/wc/v3${path}?${new URLSearchParams(query)}`, { headers: { Authorization: auth }, label: 'WooCommerce' });
    return { json: r.json, totalPages: Number(r.headers['x-wp-totalpages'] || 0) || null };
  };
}

const fields = [
  { name: 'storeUrl', label: 'Store address', secret: false, placeholder: 'https://shop.example.com', help: 'The https address of your WordPress site.' },
  { name: 'consumerKey', label: 'Consumer key', secret: false, placeholder: 'ck_…', help: 'WooCommerce › Settings › Advanced › REST API › Add key, with Permissions set to Read.' },
  { name: 'consumerSecret', label: 'Consumer secret', secret: true, placeholder: 'cs_…', help: 'Shown once when the key is created. Starlane encrypts it and never shows it again.' },
];

async function verify(input = {}) {
  const url = storeUrl(input.storeUrl);
  const consumerKey = String(input.consumerKey || '').trim();
  const consumerSecret = String(input.consumerSecret || '').trim();
  if (!url) throw Object.assign(new Error('Enter the store address, starting with https://.'), { status: 400 });
  if (!KEY_RE.test(consumerKey)) throw Object.assign(new Error('The consumer key starts with ck_.'), { status: 400 });
  if (!SECRET_RE.test(consumerSecret)) throw Object.assign(new Error('The consumer secret starts with cs_.'), { status: 400 });
  const get = makeClient({ credentials: { consumerKey, consumerSecret }, config: { storeUrl: url } });
  let currency = null;
  try {
    const r = await get('/orders', { per_page: '1' });
    if (!Array.isArray(r.json)) throw Object.assign(new Error('That address did not answer like a WooCommerce store.'), { status: 400 });
    currency = r.json[0]?.currency ? String(r.json[0].currency).toUpperCase() : null;
  } catch (err) {
    if (err.kind === 'AUTH_EXPIRED') throw Object.assign(new Error('WooCommerce did not accept that key and secret.'), { status: 400 });
    if (err.kind === 'PERMANENT' && err.status === 404) throw Object.assign(new Error('No WooCommerce REST API at that address. Check the address and that permalinks are not set to Plain.'), { status: 400 });
    throw err;
  }
  const host = new URL(url).hostname;
  return { credentials: { consumerKey, consumerSecret }, config: { storeUrl: url, currency }, externalAccountId: host, label: `${host} (WooCommerce)` };
}

async function all(get, path, query = {}) {
  const out = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { json, totalPages } = await get(path, { ...query, per_page: String(PER_PAGE), page: String(page) });
    const rows = Array.isArray(json) ? json : [];
    out.push(...rows);
    if (rows.length < PER_PAGE || (totalPages && page >= totalPages)) return { rows: out, truncated: false };
  }
  return { rows: out, truncated: true };
}

const day = (s) => (s && /^\d{4}-\d{2}-\d{2}/.test(String(s)) ? String(s).slice(0, 10) : '');
const str = (v) => (v === null || v === undefined ? '' : String(v));
const STATUS = { pending: 'pending', processing: 'processing', 'on-hold': 'on hold' };

/** Pure: WooCommerce orders → customer order rows. */
function orderRows(orders) {
  const rows = [];
  for (const o of orders) {
    const b = o.billing || {};
    const name = b.company || [b.first_name, b.last_name].filter(Boolean).join(' ').trim() || b.email || '';
    for (const li of o.line_items || []) {
      rows.push({
        'Customer Name': name,
        'Customer ID': o.customer_id ? str(o.customer_id) : '',
        'Order Number': str(o.number || o.id),
        'Line Ref': str(li.id),
        'Record ID': `woocommerce:${o.id}:${li.id}`,
        SKU: str(li.sku),
        'Product Name': str(li.name),
        Quantity: str(li.quantity),
        'Outstanding Qty': '',
        'Unit Price': li.price === undefined || li.price === null ? '' : str(li.price),
        Currency: str(o.currency),
        'Order Date': day(o.date_created),
        'Promised Date': '',
        Status: STATUS[o.status] || str(o.status),
      });
    }
  }
  return rows;
}

function productRow(name, p, category) {
  return {
    SKU: str(p.sku),
    'Product Name': name,
    'On Hand': p.manage_stock && p.stock_quantity !== null && p.stock_quantity !== undefined ? str(Math.max(0, Number(p.stock_quantity))) : '',
    Unit: '',
    'Unit Price': str(p.price),
    Category: category,
  };
}

/** Pure: products (+ variations by parent id) → product rows. */
function productRows(products, variationsByParent = new Map()) {
  const rows = [];
  for (const p of products) {
    if (p.status && p.status !== 'publish') continue;
    const category = str(p.categories?.[0]?.name);
    if (p.type === 'variable') {
      for (const v of variationsByParent.get(p.id) || []) {
        const label = (v.attributes || []).map((a) => a.option).filter(Boolean).join(', ');
        rows.push(productRow(label ? `${p.name} - ${label}` : str(p.name), v, category));
      }
    } else {
      rows.push(productRow(str(p.name), p, category));
    }
  }
  return rows;
}

async function feedRows(get, kind, config = {}) {
  if (kind === 'orders') {
    const { rows, truncated } = await all(get, '/orders', { status: 'pending,processing,on-hold' });
    return { rows: orderRows(rows), truncated, currency: config.currency || null };
  }
  if (kind === 'products') {
    const { rows, truncated } = await all(get, '/products', { status: 'publish' });
    const variable = rows.filter((p) => p.type === 'variable');
    const variations = new Map();
    for (const p of variable.slice(0, MAX_VARIABLE_PRODUCTS)) variations.set(p.id, (await all(get, `/products/${encodeURIComponent(p.id)}/variations`)).rows);
    return { rows: productRows(rows, variations), truncated: truncated || variable.length > MAX_VARIABLE_PRODUCTS, currency: config.currency || null };
  }
  throw new ConnectorError('PERMANENT', 'WooCommerce can feed customer orders and products.');
}

const connector = defineConnector({
  id: ID,
  provider: 'Automattic',
  version: '1.0.0',
  mode: 'api',
  authType: 'api_key',
  capabilities: ['READ'],
  rateLimit: { requestsPerMinute: 60 },
  entities: { order: { map: (o) => ({ sourceId: String(o.id), date: day(o.date_created) }), sourceFields: ['id', 'date_created'] } },
  async test({ credentials }) {
    await credentials.get('/orders', { per_page: '1' });
    return { ok: true };
  },
  async read(type, opts, { credentials }) {
    return (await all(credentials.get, '/orders', { status: 'pending,processing,on-hold' })).rows;
  },
});

module.exports = {
  id: ID,
  authKind: 'api_key',
  flag: 'FEATURE_CONNECTOR_WOOCOMMERCE_ENABLED',
  requiresEnv: ['OUTBOUND_CREDENTIALS_KEY'],
  entities: [],
  feedKinds: ['orders', 'products'],
  fields, verify, makeClient, connector, feedRows, orderRows, productRows, storeUrl,
};
