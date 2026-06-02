// FILE: cortex-lab/httpClient.js
// Minimal fetch wrapper for live mode. Stamps every request with the harness
// run ID header so server-side audit logs can trace it back.

'use strict';

const { URL } = require('url');

function buildClient({ baseUrl, runId, defaultTimeoutMs = 15000 }) {
  if (!baseUrl) throw new Error('httpClient: baseUrl required');
  const root = baseUrl.replace(/\/+$/, '');

  async function request(method, pathOrUrl, { token, body, headers = {}, timeoutMs = defaultTimeoutMs } = {}) {
    const target = pathOrUrl.startsWith('http') ? pathOrUrl : root + pathOrUrl;
    const u = new URL(target);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);

    const h = {
      'content-type':    'application/json',
      'x-harness-run-id': runId,
      'x-vantro-test':    '1',
      ...headers,
    };
    if (token) h.authorization = `Bearer ${token}`;

    let res, bodyText = '', json = null;
    const startedAt = Date.now();
    try {
      res = await fetch(u, {
        method,
        headers: h,
        body: body == null ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
        signal: ctrl.signal,
      });
      bodyText = await res.text();
      try { json = JSON.parse(bodyText); } catch { json = null; }
    } catch (err) {
      clearTimeout(timer);
      return { ok: false, status: 0, error: err.message, durationMs: Date.now() - startedAt, url: u.toString() };
    }
    clearTimeout(timer);
    return {
      ok: res.ok,
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      bodyText,
      json,
      durationMs: Date.now() - startedAt,
      url: u.toString(),
    };
  }

  return {
    get:    (p, opts) => request('GET',    p, opts),
    post:   (p, opts) => request('POST',   p, opts),
    patch:  (p, opts) => request('PATCH',  p, opts),
    delete: (p, opts) => request('DELETE', p, opts),
  };
}

module.exports = { buildClient };
