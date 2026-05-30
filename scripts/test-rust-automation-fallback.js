#!/usr/bin/env node
// FILE: scripts/test-rust-automation-fallback.js
//
// Commit 8 — Node fallback matrix safety gate.
//
// Proves that if the Rust Automation RS sidecar is disabled, misconfigured,
// unreachable, slow, errored, or returning garbage, the Node client always
// returns null so the caller can fall through to the existing JS path. Also
// proves that a valid response is passed through.
//
// 8 cases, each isolated:
//   1. RUST_AUTOMATION_API_ENABLED=false           -> rust_disabled_fallback
//   2. enabled but RUST_AUTOMATION_BASE_URL missing-> rust_missing_base_url_fallback
//   3. Connection refused (port with no listener)  -> rust_connection_failed_fallback
//   4. Server hangs past timeout (overridden 250ms)-> rust_timeout_fallback
//   5. Server returns 500                          -> rust_http_error_fallback
//   6. Server returns malformed JSON               -> rust_invalid_json_fallback
//   7. Server returns non-object JSON              -> rust_invalid_schema_fallback
//   8. Server returns valid object JSON            -> rust_call_success
//
// No prod env, no prod DB, no secrets. Runs entirely on 127.0.0.1.
// Exit 0 on success, exit 1 on any case failure.

'use strict';

const http = require('http');
const path = require('path');

const CLIENT_PATH    = require.resolve('../lib/services/rustAutomation/rustAutomationClient');
const FLAGS_PATH     = require.resolve('../lib/featureFlags');
const LOGGER_PATH    = require.resolve('../lib/observability/logger');

// ── Harness helpers ───────────────────────────────────────────────────────────

function reloadClient() {
  // FLAGS snapshots process.env at first require — clear it too so each case
  // re-reads RUST_AUTOMATION_API_ENABLED / RUST_AUTOMATION_BASE_URL fresh.
  delete require.cache[CLIENT_PATH];
  delete require.cache[FLAGS_PATH];
  delete require.cache[LOGGER_PATH];
  return require(CLIENT_PATH);
}

function captureLogs(fn) {
  const original = console.log;
  const lines = [];
  console.log = (s) => { lines.push(String(s)); };
  return fn().finally(() => { console.log = original; })
    .then((value) => ({ value, logs: lines.map(parseSafe).filter(Boolean) }));
}

function parseSafe(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function findCode(logs, code) {
  return logs.some(l => l && l.code === code);
}

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function stopServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function addr(server) {
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function resetRustEnv() {
  delete process.env.RUST_AUTOMATION_API_ENABLED;
  delete process.env.RUST_AUTOMATION_BASE_URL;
}

// ── Test cases ────────────────────────────────────────────────────────────────

const cases = [];

cases.push({
  name: '1. flag disabled -> rust_disabled_fallback',
  async run() {
    resetRustEnv();
    // No flag, no base URL.
    const client = reloadClient();
    const { value, logs } = await captureLogs(() =>
      client.getDashboardBootstrapRust('jwt-test-token')
    );
    assertEqual(value, null, 'must return null when disabled');
    assertTrue(findCode(logs, 'rust_disabled_fallback'), 'must log rust_disabled_fallback');
    assertNoSecret(logs);
  },
});

cases.push({
  name: '2. enabled + missing base url -> rust_missing_base_url_fallback',
  async run() {
    resetRustEnv();
    process.env.RUST_AUTOMATION_API_ENABLED = 'true';
    const client = reloadClient();
    const { value, logs } = await captureLogs(() =>
      client.getDashboardBootstrapRust('jwt-test-token')
    );
    assertEqual(value, null, 'must return null when base url missing');
    assertTrue(findCode(logs, 'rust_missing_base_url_fallback'), 'must log rust_missing_base_url_fallback');
    assertNoSecret(logs);
  },
});

cases.push({
  name: '3. connection refused -> rust_connection_failed_fallback',
  async run() {
    resetRustEnv();
    process.env.RUST_AUTOMATION_API_ENABLED = 'true';
    const port = await getFreePort();              // nothing is listening on it
    process.env.RUST_AUTOMATION_BASE_URL = `http://127.0.0.1:${port}`;
    const client = reloadClient();
    const { value, logs } = await captureLogs(() =>
      client.getDashboardBootstrapRust('jwt-test-token')
    );
    assertEqual(value, null, 'must return null on connection refused');
    assertTrue(findCode(logs, 'rust_connection_failed_fallback'), 'must log rust_connection_failed_fallback');
    assertNoSecret(logs);
  },
});

cases.push({
  name: '4. server hangs past timeout -> rust_timeout_fallback',
  async run() {
    resetRustEnv();
    process.env.RUST_AUTOMATION_API_ENABLED = 'true';
    // Server that accepts but never responds.
    const server = await startServer(() => { /* hang */ });
    process.env.RUST_AUTOMATION_BASE_URL = addr(server);
    const client = reloadClient();
    // Override the internal timeout so this case finishes fast.
    const original = client.__test__.rustFetch;
    const originalTimeout = client.__test__.TIMEOUT_MS;
    // We don't have a direct setter — instead, abort via AbortSignal.timeout in a wrapper.
    // Use the real fetch path but with a custom short timeout by patching globalThis.fetch.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (url, init = {}) => {
      const ctrl = new AbortController();
      const externalSignal = init.signal;
      const timer = setTimeout(() => ctrl.abort(), 250);
      if (externalSignal) externalSignal.addEventListener('abort', () => ctrl.abort());
      return realFetch(url, { ...init, signal: ctrl.signal })
        .finally(() => clearTimeout(timer));
    };
    try {
      const { value, logs } = await captureLogs(() =>
        client.getDashboardBootstrapRust('jwt-test-token')
      );
      assertEqual(value, null, 'must return null on timeout');
      assertTrue(
        findCode(logs, 'rust_timeout_fallback') || findCode(logs, 'rust_connection_failed_fallback'),
        'must log timeout (AbortError) — connection_failed acceptable if classifier groups it'
      );
      assertTrue(findCode(logs, 'rust_timeout_fallback'), 'must log rust_timeout_fallback specifically');
      assertNoSecret(logs);
    } finally {
      globalThis.fetch = realFetch;
      await stopServer(server);
    }
  },
});

cases.push({
  name: '5. server returns 500 -> rust_http_error_fallback',
  async run() {
    resetRustEnv();
    process.env.RUST_AUTOMATION_API_ENABLED = 'true';
    const server = await startServer((req, res) => {
      res.statusCode = 500;
      res.setHeader('content-type', 'text/plain');
      res.end('boom');
    });
    process.env.RUST_AUTOMATION_BASE_URL = addr(server);
    const client = reloadClient();
    try {
      const { value, logs } = await captureLogs(() =>
        client.getDashboardBootstrapRust('jwt-test-token')
      );
      assertEqual(value, null, 'must return null on 500');
      assertTrue(findCode(logs, 'rust_http_error_fallback'), 'must log rust_http_error_fallback');
      assertNoSecret(logs);
    } finally {
      await stopServer(server);
    }
  },
});

cases.push({
  name: '6. malformed JSON -> rust_invalid_json_fallback',
  async run() {
    resetRustEnv();
    process.env.RUST_AUTOMATION_API_ENABLED = 'true';
    const server = await startServer((req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end('{ not: valid json,,,');
    });
    process.env.RUST_AUTOMATION_BASE_URL = addr(server);
    const client = reloadClient();
    try {
      const { value, logs } = await captureLogs(() =>
        client.getDashboardBootstrapRust('jwt-test-token')
      );
      assertEqual(value, null, 'must return null on malformed JSON');
      assertTrue(findCode(logs, 'rust_invalid_json_fallback'), 'must log rust_invalid_json_fallback');
      assertNoSecret(logs);
    } finally {
      await stopServer(server);
    }
  },
});

cases.push({
  name: '7. invalid schema (array) -> rust_invalid_schema_fallback',
  async run() {
    resetRustEnv();
    process.env.RUST_AUTOMATION_API_ENABLED = 'true';
    const server = await startServer((req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end('[1,2,3]');                       // not a plain object
    });
    process.env.RUST_AUTOMATION_BASE_URL = addr(server);
    const client = reloadClient();
    try {
      const { value, logs } = await captureLogs(() =>
        client.getDashboardBootstrapRust('jwt-test-token')
      );
      assertEqual(value, null, 'must return null on non-object JSON');
      assertTrue(findCode(logs, 'rust_invalid_schema_fallback'), 'must log rust_invalid_schema_fallback');
      assertNoSecret(logs);
    } finally {
      await stopServer(server);
    }
  },
});

cases.push({
  name: '8. valid object response -> rust_call_success',
  async run() {
    resetRustEnv();
    process.env.RUST_AUTOMATION_API_ENABLED = 'true';
    const payload = { kpis: { total_outstanding: 12345 }, served_by: 'rust' };
    const server = await startServer((req, res) => {
      // Verify auth header arrives but is never echoed back / logged.
      const auth = req.headers['authorization'] || '';
      if (!auth.startsWith('Bearer ')) {
        res.statusCode = 401;
        res.end('{"error":"no auth"}');
        return;
      }
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(payload));
    });
    process.env.RUST_AUTOMATION_BASE_URL = addr(server);
    const client = reloadClient();
    try {
      const { value, logs } = await captureLogs(() =>
        client.getDashboardBootstrapRust('jwt-test-token-do-not-log')
      );
      assertDeepEqual(value, payload, 'must return parsed body on success');
      assertTrue(findCode(logs, 'rust_call_success'), 'must log rust_call_success');
      assertNoSecret(logs);
      // Payload value (the number "12345") must not appear in the success log line.
      const haystack = JSON.stringify(logs);
      if (haystack.includes('12345') || haystack.includes('served_by')) {
        throw new Error('PAYLOAD LEAK: response body fields found in logs');
      }
    } finally {
      await stopServer(server);
    }
  },
});

// ── Assertions ────────────────────────────────────────────────────────────────

function assertTrue(cond, msg) {
  if (!cond) throw new Error(`assert true failed: ${msg}`);
}

function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(`assert equal failed: ${msg} — got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`);
}

function assertDeepEqual(a, b, msg) {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(`assert deep equal failed: ${msg} — got ${sa} expected ${sb}`);
}

function assertNoSecret(logs) {
  // No log line may contain the literal token string. safeLog redacts 'authorization'
  // entirely; this catches accidental nesting that bypasses the redactor.
  const haystack = JSON.stringify(logs);
  if (haystack.includes('jwt-test-token')) {
    throw new Error('SECRET LEAK: jwt-test-token found in logs');
  }
  if (haystack.includes('do-not-log')) {
    throw new Error('SECRET LEAK: do-not-log token suffix found in logs');
  }
}

// ── Runner ────────────────────────────────────────────────────────────────────

(async function main() {
  const results = [];
  for (const c of cases) {
    process.stdout.write(`\n[case] ${c.name}\n`);
    try {
      await c.run();
      results.push({ name: c.name, ok: true });
      process.stdout.write(`  ✓ PASS\n`);
    } catch (err) {
      results.push({ name: c.name, ok: false, err: err.message });
      process.stdout.write(`  ✗ FAIL: ${err.message}\n`);
    } finally {
      resetRustEnv();
    }
  }

  const passed = results.filter(r => r.ok).length;
  const total  = results.length;
  process.stdout.write(`\n────────────\nFallback matrix: ${passed}/${total} passed\n`);
  if (passed !== total) {
    for (const r of results.filter(r => !r.ok)) {
      process.stdout.write(`  FAILED: ${r.name} — ${r.err}\n`);
    }
    process.exit(1);
  }
})().catch((err) => {
  process.stderr.write(`Harness crashed: ${err.stack || err.message}\n`);
  process.exit(1);
});
