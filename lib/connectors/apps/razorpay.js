'use strict';
// lib/connectors/apps/razorpay.js — Razorpay, read-only, with the business's
// own API key.
//
// The owner creates a key in the Razorpay Dashboard (Account & Settings ›
// API Keys) and pastes the Key ID and Key Secret. Razorpay keys are not
// scoped, so read-only is enforced here: this connector declares READ only
// and only sends GET requests, to /v1/invoices and /v1/payment_links.
// Payment links are how most Indian MSMEs ask for money on Razorpay, so both
// become receivables in Starlane with what has been paid against them.
//
// Razorpay amounts are in the currency's smallest unit (paise for INR).

const { defineConnector, ConnectorError } = require('../sdk');
const { vendorRequest, base } = require('./http');

const ID = 'razorpay';
const COUNT = 100;
const MAX_PAGES = 100;
const KEY_ID_RE = /^rzp_(live|test)_[A-Za-z0-9]{8,32}$/;

// ISO 4217 exponents that are not 2, for the currencies Razorpay settles.
const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'CLP', 'PYG', 'ISK', 'UGX', 'XAF', 'XOF', 'RWF', 'KMF', 'GNF', 'DJF', 'VUV', 'XPF', 'BIF']);
const THREE_DECIMAL = new Set(['KWD', 'BHD', 'OMR', 'JOD', 'TND', 'IQD', 'LYD']);
function fromSubunits(amount, currency) {
  if (amount === null || amount === undefined || amount === '') return null;
  const c = String(currency || 'INR').toUpperCase();
  const div = ZERO_DECIMAL.has(c) ? 1 : THREE_DECIMAL.has(c) ? 1000 : 100;
  return Math.round((Number(amount) / div) * 1000) / 1000;
}

const day = (unix) => (unix ? new Date(Number(unix) * 1000).toISOString().slice(0, 10) : null);

function makeClient({ credentials }) {
  const auth = `Basic ${Buffer.from(`${credentials.keyId}:${credentials.keySecret}`).toString('base64')}`;
  const root = `${base('razorpayApi', 'https://api.razorpay.com')}/v1`;
  return async (path, query = {}) => (await vendorRequest(`${root}${path}?${new URLSearchParams(query)}`, { headers: { Authorization: auth }, label: 'Razorpay' })).json || {};
}

const fields = [
  { name: 'keyId', label: 'Key ID', secret: false, placeholder: 'rzp_live_…', help: 'Razorpay Dashboard › Account & Settings › API Keys.' },
  { name: 'keySecret', label: 'Key Secret', secret: true, placeholder: '', help: 'Shown once when you generate the key. Starlane encrypts it and never shows it again.' },
];

/** Checks the key with one read and returns what is stored. */
async function verify(input = {}) {
  const keyId = String(input.keyId || '').trim();
  const keySecret = String(input.keySecret || '').trim();
  if (!KEY_ID_RE.test(keyId)) throw Object.assign(new Error('The Key ID starts with rzp_live_ or rzp_test_.'), { status: 400 });
  if (keySecret.length < 8 || keySecret.length > 128) throw Object.assign(new Error('Paste the Key Secret shown when the key was generated.'), { status: 400 });
  const get = makeClient({ credentials: { keyId, keySecret } });
  try {
    await get('/payments', { count: '1' });
  } catch (err) {
    if (err.kind === 'AUTH_EXPIRED') throw Object.assign(new Error('Razorpay did not accept that Key ID and Secret.'), { status: 400 });
    throw err;
  }
  const mode = keyId.startsWith('rzp_test_') ? 'test' : 'live';
  return { credentials: { keyId, keySecret }, config: { mode }, externalAccountId: keyId, label: `Razorpay (${mode} key ${keyId.slice(0, 13)}…)` };
}

async function collection(get, path, key) {
  const out = [];
  for (let p = 0; p < MAX_PAGES; p++) {
    const j = await get(path, { count: String(COUNT), skip: String(p * COUNT) });
    const rows = j[key] || [];
    out.push(...rows);
    if (rows.length < COUNT) break;
  }
  return out;
}

// Invoices and payment links that are not a live receivable.
const SKIP = new Set(['draft', 'cancelled', 'expired', 'deleted']);

function latest(payments) {
  const ts = (Array.isArray(payments) ? payments : []).map((p) => Number(p.created_at || 0)).filter(Boolean);
  return ts.length ? Math.max(...ts) : null;
}

function mapInvoice(r) {
  const isLink = String(r.id || '').startsWith('plink_');
  const currency = r.currency ? String(r.currency).toUpperCase() : 'INR';
  const cust = isLink ? r.customer || {} : r.customer_details || {};
  const amount = fromSubunits(r.amount, currency);
  const paid = fromSubunits(r.amount_paid || 0, currency);
  return {
    sourceId: String(r.id),
    customerRef: r.customer_id || cust.id || cust.contact || cust.email || cust.name || null,
    customerName: cust.name || cust.customer_name || cust.email || cust.contact || null,
    customerPhone: cust.contact || cust.customer_contact || null,
    customerEmail: cust.email || cust.customer_email || null,
    number: (isLink ? r.reference_id : r.invoice_number) || r.id,
    amount,
    balance: amount === null ? null : Math.max(0, Math.round((amount - paid) * 1000) / 1000),
    currency,
    issuedOn: day(isLink ? r.created_at : r.issued_at || r.date || r.created_at),
    dueOn: day(r.expire_by) || null,
    paidOn: r.status === 'paid' ? day(r.paid_at || latest(r.payments)) : null,
    status: r.status || null,
    kind: isLink ? 'payment_link' : 'invoice',
  };
}

const connector = defineConnector({
  id: ID,
  provider: 'Razorpay',
  version: '1.0.0',
  mode: 'api',
  authType: 'api_key',
  capabilities: ['READ'],
  rateLimit: { requestsPerMinute: 120 },
  entities: { invoice: { map: mapInvoice, sourceFields: ['id', 'amount', 'amount_paid', 'status'] } },
  async test({ credentials }) {
    await credentials.get('/payments', { count: '1' });
    return { ok: true };
  },
  async read(type, opts, { credentials }) {
    const invoices = await collection(credentials.get, '/invoices', 'items');
    const links = await collection(credentials.get, '/payment_links', 'payment_links');
    return [...invoices, ...links].filter((r) => !SKIP.has(String(r.status || '').toLowerCase()) && Number(r.amount) > 0);
  },
});

module.exports = {
  id: ID,
  authKind: 'api_key',
  flag: 'FEATURE_CONNECTOR_RAZORPAY_ENABLED',
  requiresEnv: ['OUTBOUND_CREDENTIALS_KEY'],
  entities: ['invoice'],
  fields, verify, makeClient, connector,
  mapInvoice, fromSubunits, KEY_ID_RE,
};
