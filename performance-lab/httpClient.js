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

    // serverMs = compute time the service reports in its own body (durationMs).
    // This isolates real work from network RTT — essential when the test runner
    // is not in the same region/network as the target (public-internet RTT can
    // dwarf sub-millisecond compute).
    let source = null, serverMs = null;
    try {
      const j = JSON.parse(raw);
      source = j.source || j.served_by || null;
      if (typeof j.durationMs === 'number') serverMs = j.durationMs;
    } catch {}

    return { ok: res.ok, status: res.status, durationMs, payloadBytes, source, serverMs, errorType: null };
  } catch (err) {
    const durationMs = Math.round(performance.now() - start);
    const errorType  = err.name === 'AbortError' ? 'timeout' : 'network_error';
    return { ok: false, status: null, durationMs, payloadBytes: 0, source: null, serverMs: null, errorType, error: err.message };
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

  // Server-reported compute times (only present if the endpoint echoes durationMs).
  const serverSamples = samples.map(s => s.serverMs).filter(x => typeof x === 'number').sort((a, b) => a - b);
  const serverMedian  = serverSamples.length ? serverSamples[Math.floor(serverSamples.length * 0.5)] : null;
  const serverMax     = serverSamples.length ? serverSamples[serverSamples.length - 1] : null;

  return {
    ...last,
    p50_ms:        pct(0.50),
    p95_ms:        pct(0.95),
    min_ms:        durations[0],
    max_ms:        durations[durations.length - 1],
    server_ms_median: serverMedian,
    server_ms_max:    serverMax,
    success_count: samples.filter(s => s.ok).length,
    fail_count:    samples.filter(s => !s.ok).length,
    iterations,
  };
}

module.exports = { timedFetch, multiRun };
