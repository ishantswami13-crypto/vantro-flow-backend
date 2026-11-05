'use strict';
// lib/connectors/apps/http.js — the one way app connectors talk to a vendor.
//
// Every request goes through safeHttp (https only, private addresses refused,
// no redirects, size and time limits). Vendor hosts are fixed in each
// provider, never taken from a tenant. Failures become ConnectorError so the
// SDK runtime retries what is safe to retry and never retries a bad key.
//
// Tests replace vendor base URLs with a local server through
// __setTestOverrides; production never calls it.

const { safeRequest } = require('../safeHttp');
const { ConnectorError } = require('../sdk');
const creds = require('../../domain/outbound/credentials');

let overrides = null;
function __setTestOverrides(o) { overrides = o; }

/** A vendor base URL, or the test server standing in for it. */
function base(name, fallback) {
  return (overrides && overrides.urls && overrides.urls[name]) || fallback;
}

function httpOptions() {
  return overrides ? { allowHttp: true, allowPrivate: true } : {};
}

/**
 * One request. Returns { status, json, body, headers }. Throws ConnectorError
 * for 401/403 (AUTH_EXPIRED), 429 (RATE_LIMITED), 5xx (TRANSIENT) and other
 * 4xx (PERMANENT) unless `raw` is set, and TRANSIENT for network failures.
 */
async function vendorRequest(url, { method = 'GET', headers = {}, body = null, raw = false, timeoutMs = 20000, label = 'the app' } = {}) {
  let r;
  try {
    r = await safeRequest(url, { method, headers: { Accept: 'application/json', 'User-Agent': 'Starlane-Connectors/1.0', ...headers }, body, timeoutMs, maxBytes: 4 * 1024 * 1024, ...httpOptions() });
  } catch (err) {
    if (err.code === 'URL_REFUSED') throw new ConnectorError('PERMANENT', err.message);
    throw new ConnectorError('TRANSIENT', `Could not reach ${label}: ${err.message}`);
  }
  if (raw || (r.status >= 200 && r.status < 300)) return r;
  const detail = vendorMessage(r);
  throw ConnectorError.fromHttp(r.status, r.headers['retry-after'], `${label} answered HTTP ${r.status}${detail ? `: ${detail}` : ''}`);
}

// A short, redacted reason from a vendor error body.
function vendorMessage(r) {
  const j = r.json || {};
  const m = j.message || j.error_description || j.error?.message || j.error?.description || j.Fault?.Error?.[0]?.Message || (typeof j.error === 'string' ? j.error : '');
  return creds.redact(String(m || '')).slice(0, 200);
}

function form(obj) {
  return new URLSearchParams(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null)).toString();
}

module.exports = { vendorRequest, vendorMessage, base, form, __setTestOverrides };
