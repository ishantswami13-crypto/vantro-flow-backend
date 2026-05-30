'use strict';

// FILE: performance-lab/httpClient.js
// Timed fetch wrapper. Never logs token, auth header, or response body.
// Returns structured timing/size result; never throws.

const cfg = require('./config');

async function timedFetch(url, { method = 'GET', token, body, timeoutMs } = {}) {
  const ctrl  = new AbortController();
  const limit = timeoutMs ?? cfg.timeoutMs;
  const timer = setTimeout(() => ctrl.abort(), limit);
  const start = performance.now();

  try {
    const headers = { 'content-type': 'application/json' };
    if (token) headers['authorization'] = `Bearer ${token}`;

    const res = await fetch(url, {
      method,
      headers,
      body: body != null ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });

    const raw       = await res.text();
    const durationMs = Math.round(performance.now() - start);
    const payloadBytes = Buffer.byteLength(raw, 'utf8');

    let source = null;
    try { const j = JSON.parse(raw); source = j.source || j.served_by || null; } catch {}

    return { ok: res.ok, status: res.status, durationMs, payloadBytes, source, errorType: null };
  } catch (err) {
    const durationMs = Math.round(performance.now() - start);
    const errorType  = err.name === 'AbortError' ? 'timeout' : 'network_error';
    return { ok: false, status: null, durationMs, payloadBytes: 0, source: null, errorType, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

// Run `iterations` times and compute stats on the durations.
async function multiRun(url, opts, iterations) {
  const samples = [];
  for (let i = 0; i < iterations; i++) {
    samples.push(await timedFetch(url, opts));
  }

  const durations = samples.map(s => s.durationMs).sort((a, b) => a - b);
  const last      = samples[samples.length - 1];

  function pct(p) { return durations[Math.min(Math.floor(durations.length * p), durations.length - 1)]; }

  return {
    ...last,
    p50_ms:        pct(0.50),
    p95_ms:        pct(0.95),
    min_ms:        durations[0],
    max_ms:        durations[durations.length - 1],
    success_count: samples.filter(s => s.ok).length,
    fail_count:    samples.filter(s => !s.ok).length,
    iterations,
  };
}

module.exports = { timedFetch, multiRun };
