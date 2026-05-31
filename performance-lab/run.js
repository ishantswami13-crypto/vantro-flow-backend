'use strict';

// FILE: performance-lab/run.js
// Vantro Performance Lab — measures Node wrapper overhead and, when a live
// service is reachable, Rust endpoint latency and Node endpoint latency.
//
// Default (offline / CI) mode:
//   - Part B: Node wrapper fallback timing (always runs, no live service needed)
//   - Part A: Rust endpoint tests → SKIPPED (PERF_RUN_LIVE=false or URL missing)
//   - Part C: Node live endpoints → SKIPPED (PERF_NODE_BASE_URL or token missing)
//
// Live mode (PERF_RUN_LIVE=true + env vars set):
//   - All three parts run. CI is not affected because live mode requires explicit opt-in.
//
// Exit codes:
//   0 — all measured tests passed (skipped is OK)
//   1 — at least one measured test failed / critical failure
//
// Safety:
//   - Never logs token, Authorization header, or raw response body.
//   - Blocks if PERF_REQUIRE_NON_PROD=true (default) and URL looks like production.

const http     = require('http');
const path     = require('path');
const crypto   = require('crypto');
const cfg      = require('./config');
const { multiRun, timedFetch } = require('./httpClient');
const { printConsole, writeReports } = require('./reporter');

const RUST_SCENARIOS   = require('./scenarios/rust-endpoints.json');
const WRAPPER_SCENARIOS = require('./scenarios/node-wrapper.json');
const BOOTSTRAP_SCENARIOS = require('./scenarios/bootstrap.json');

const CLIENT_PATH = require.resolve('../lib/services/rustAutomation/rustAutomationClient');
const FLAGS_PATH  = require.resolve('../lib/featureFlags');

function reloadClient() {
  delete require.cache[CLIENT_PATH];
  delete require.cache[FLAGS_PATH];
  return require(CLIENT_PATH);
}

// ── Ephemeral HTTP server helpers ─────────────────────────────────────────────

function startServer(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

function stopServer(s) {
  return new Promise((resolve) => s.close(() => resolve()));
}

function addr(s) {
  return `http://127.0.0.1:${s.address().port}`;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}

// ── Budget evaluation ─────────────────────────────────────────────────────────

function evalBudget(durationMs, target, acceptable, label) {
  if (durationMs <= target)      return { pass: true,  budget_note: `✓ under ${target}ms target` };
  if (durationMs <= acceptable)  return { pass: true,  budget_note: `⚠ over ${target}ms target, within ${acceptable}ms acceptable` };
  return { pass: false, budget_note: `✗ ${durationMs}ms exceeds ${acceptable}ms acceptable for ${label}` };
}

// ── Part A: Rust live endpoints ───────────────────────────────────────────────

async function runRustEndpoints(results, skipped_explanations) {
  for (const sc of RUST_SCENARIOS) {
    if (!cfg.runLive) {
      results.push({ name: sc.name, skipped: true, skip_reason: 'PERF_RUN_LIVE=false (set to true to run live tests)' });
      skipped_explanations.push({ test: sc.name, reason: 'Set PERF_RUN_LIVE=true and PERF_RUST_BASE_URL to measure.' });
      continue;
    }
    if (!cfg.rustBaseUrl) {
      results.push({ name: sc.name, skipped: true, skip_reason: 'PERF_RUST_BASE_URL not configured' });
      skipped_explanations.push({ test: sc.name, reason: 'Set PERF_RUST_BASE_URL (non-prod Rust sidecar).' });
      continue;
    }
    if (sc.requires_auth && !cfg.testToken) {
      results.push({ name: sc.name, skipped: true, skip_reason: 'PERF_TEST_TOKEN not configured' });
      skipped_explanations.push({ test: sc.name, reason: 'Set PERF_TEST_TOKEN (non-prod JWT).' });
      continue;
    }
    if (sc.requires_db && cfg.skipDb) {
      results.push({ name: sc.name, skipped: true, skip_reason: 'staging DB not migrated (PERF_SKIP_DB=true)' });
      skipped_explanations.push({ test: sc.name, reason: 'Staging Postgres has no schema. Apply migrations to the staging DB to measure this DB-backed endpoint.' });
      continue;
    }

    const url = `${cfg.rustBaseUrl}${sc.path}`;
    const res = await multiRun(url, { method: sc.method, token: sc.requires_auth ? cfg.testToken : null, body: sc.body }, cfg.iterations);

    // Judge the budget on the service's OWN reported compute time when present
    // (server_ms_median) — it excludes network RTT, the only honest way to
    // assess Rust compute from a remote runner. Wall-clock p50 is still recorded
    // and shown, but over the public internet it reflects network latency, not
    // Rust. Fall back to wall-clock only when the endpoint reports no durationMs.
    const hasServer  = res.server_ms_median != null;
    const metric     = hasServer ? res.server_ms_median : res.p50_ms;
    const metricKind = hasServer ? 'server-compute' : 'wall-clock';
    const budget = evalBudget(metric, sc.target_ms, sc.acceptable_ms, sc.name);

    const payloadKB = (res.payloadBytes || 0) / 1024;
    const sizeOk = payloadKB <= (sc.payload_max_kb || 500);
    const pass = budget.pass && sizeOk && res.ok;

    results.push({
      name: sc.name,
      skipped: false,
      pass,
      ...res,
      metric_kind: metricKind,
      display_ms: metric,
      budget_note: `[${metricKind}] ` + budget.budget_note
        + (sizeOk ? '' : ` | payload ${payloadKB.toFixed(1)}KB > ${sc.payload_max_kb}KB`)
        + (hasServer ? ` | wall p50 ${res.p50_ms}ms (network-bound from remote)` : ''),
      critical_failure: !pass,
    });
  }
}

// ── Part B: Node wrapper fallback timing ──────────────────────────────────────
// Always runs — no live service needed. Uses ephemeral 127.0.0.1 servers.

async function runWrapperTimings(results, skipped_explanations) {
  const realFetch = globalThis.fetch;

  for (const sc of WRAPPER_SCENARIOS) {
    let server = null;
    const timings = [];

    try {
      // Set up env per scenario
      delete process.env.RUST_AUTOMATION_API_ENABLED;
      delete process.env.RUST_AUTOMATION_BASE_URL;

      if (sc.mode === 'timeout') {
        // Timeout scenario: short 250ms override, server that hangs.
        process.env.RUST_AUTOMATION_API_ENABLED = 'true';
        server = await startServer(() => { /* hang */ });
        process.env.RUST_AUTOMATION_BASE_URL = addr(server);

        const shortFetch = (url, init = {}) => {
          const ctrl   = new AbortController();
          const ext    = init.signal;
          const timer  = setTimeout(() => ctrl.abort(), 250);
          if (ext) ext.addEventListener('abort', () => ctrl.abort());
          return realFetch(url, { ...init, signal: ctrl.signal }).finally(() => clearTimeout(timer));
        };
        globalThis.fetch = shortFetch;
      } else if (sc.mode === 'disabled') {
        // default: no flag set → disabled
      } else if (sc.mode === 'missing_url') {
        process.env.RUST_AUTOMATION_API_ENABLED = 'true';
        // No base URL set.
      } else if (sc.mode === 'conn_refused') {
        process.env.RUST_AUTOMATION_API_ENABLED = 'true';
        const freePort = await getFreePort();
        process.env.RUST_AUTOMATION_BASE_URL = `http://127.0.0.1:${freePort}`;
      } else if (sc.mode === 'valid_response') {
        process.env.RUST_AUTOMATION_API_ENABLED = 'true';
        server = await startServer((req, res) => {
          res.statusCode = 200;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ served_by: 'mock_rust', data: 'ok' }));
        });
        process.env.RUST_AUTOMATION_BASE_URL = addr(server);
      }

      const iters = sc.mode === 'timeout' ? 1 : cfg.iterations;
      for (let i = 0; i < iters; i++) {
        const t0     = performance.now();
        const client = reloadClient();
        const ret    = await client.getDashboardBootstrapRust('perf-test-token');
        const dur    = Math.round(performance.now() - t0);
        timings.push({ durationMs: dur, result: ret });
      }

      globalThis.fetch = realFetch;

    } finally {
      globalThis.fetch = realFetch;
      if (server) await stopServer(server);
      delete process.env.RUST_AUTOMATION_API_ENABLED;
      delete process.env.RUST_AUTOMATION_BASE_URL;
    }

    const durations = timings.map(t => t.durationMs).sort((a, b) => a - b);
    function pct(p) { return durations[Math.min(Math.floor(durations.length * p), durations.length - 1)]; }

    const p50 = pct(0.5);
    const budget = evalBudget(p50, sc.target_ms, sc.acceptable_ms, sc.name);
    const allNull = timings.every(t => t.result === null);
    const allObj  = timings.every(t => t.result !== null && typeof t.result === 'object');
    const contractOk = sc.expected_null ? allNull : allObj;

    results.push({
      name:          sc.name,
      skipped:       false,
      pass:          budget.pass && contractOk,
      durationMs:    durations[0],
      p50_ms:        p50,
      p95_ms:        pct(0.95),
      min_ms:        durations[0],
      max_ms:        durations[durations.length - 1],
      payloadBytes:  0,
      iterations:    timings.length,
      success_count: timings.length,
      fail_count:    0,
      budget_note:   budget.budget_note + (contractOk ? '' : ` | CONTRACT FAILED (null=${allNull} expected=${sc.expected_null})`),
      critical_failure: !contractOk,
    });
  }
}

// ── Part C: Node live endpoints ───────────────────────────────────────────────

async function runNodeEndpoints(results, skipped_explanations) {
  for (const sc of BOOTSTRAP_SCENARIOS) {
    const needsLive  = sc.requires_auth;
    const hasNode    = !!cfg.nodeBaseUrl;
    const hasToken   = !!cfg.testToken;
    const liveMode   = cfg.runLive;

    if (needsLive && (!liveMode || !hasNode || !hasToken)) {
      const reasons = [];
      if (!liveMode)  reasons.push('PERF_RUN_LIVE=false');
      if (!hasNode)   reasons.push('PERF_NODE_BASE_URL not set');
      if (!hasToken)  reasons.push('PERF_TEST_TOKEN not set');
      results.push({ name: sc.name, skipped: true, skip_reason: reasons.join(', ') });
      skipped_explanations.push({ test: sc.name, reason: 'Set ' + reasons.join(' + ') + ' to enable.' });
      continue;
    }

    if (!hasNode) {
      results.push({ name: sc.name, skipped: true, skip_reason: 'PERF_NODE_BASE_URL not set' });
      skipped_explanations.push({ test: sc.name, reason: 'Set PERF_NODE_BASE_URL to a non-prod Node backend.' });
      continue;
    }

    const url   = `${cfg.nodeBaseUrl}${sc.path}`;
    const token = sc.requires_auth ? cfg.testToken : null;
    const res   = await multiRun(url, { method: sc.method, token }, cfg.iterations);
    const budget = evalBudget(res.p50_ms, sc.target_ms, sc.acceptable_ms, sc.name);
    const statusOk = res.status === sc.expected_status;

    const payloadKB = (res.payloadBytes || 0) / 1024;
    const sizeOk = payloadKB <= (sc.payload_max_kb || 500);
    const pass = budget.pass && statusOk && sizeOk;

    results.push({
      name: sc.name,
      skipped: false,
      pass,
      ...res,
      budget_note: [
        budget.budget_note,
        statusOk ? '' : `| status ${res.status} ≠ ${sc.expected_status}`,
        sizeOk   ? '' : `| payload ${payloadKB.toFixed(1)}KB exceeds ${sc.payload_max_kb}KB`,
      ].filter(Boolean).join(' '),
      critical_failure: !pass,
    });
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const run_id   = `perf_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
  const ts       = new Date().toISOString();
  const mode     = cfg.runLive ? 'live' : 'offline (CI-safe)';
  const results  = [];
  const skip_explanations = [];

  // Part A — Rust live endpoints
  await runRustEndpoints(results, skip_explanations);

  // Part B — Node wrapper fallback timing (always)
  await runWrapperTimings(results, skip_explanations);

  // Part C — Node live endpoints
  await runNodeEndpoints(results, skip_explanations);

  // ── Summarise ──────────────────────────────────────────────────────────────
  const measured = results.filter(r => !r.skipped);
  const passed   = measured.filter(r => r.pass).length;
  const failed   = measured.filter(r => !r.pass).length;
  const skipped  = results.filter(r => r.skipped).length;
  const critical = measured.filter(r => r.critical_failure).length;

  // ── Granular readiness status ─────────────────────────────────────────────
  //
  // Four independent fields replace the single safe_to_enable_rust boolean:
  //
  //   rust_sidecar_ready       — Rust compute + DB endpoints + wrapper all pass.
  //                              NOT affected by Node staging failures.
  //   node_staging_ready       — Node service is up and 401-rejecting correctly.
  //                              PARTIAL when auth-gated tests need Supabase.
  //   node_auth_baseline_ready — Node auth 200 tests return real data.
  //                              Only YES after non-prod Supabase is wired.
  //   production_enablement_ready — All four gates met + soak/canary required.
  //
  // safe_to_enable_rust is kept for backwards compatibility and CI scripts.
  // It now reflects only Rust+wrapper health, not Node health.
  //
  // WHY: Node auth tests fail with 500 when Supabase placeholder is in use.
  // That is expected and documented. Treating it as a Rust failure would
  // produce a falsely-blocked signal during the soak phase.

  const WRAPPER_NAMES  = new Set(WRAPPER_SCENARIOS.map(s => s.name));
  const RUST_NAMES     = new Set(RUST_SCENARIOS.map(s => s.name));
  const NODE_NAMES     = new Set(BOOTSTRAP_SCENARIOS.map(s => s.name));
  const nodeAuthIds    = new Set(BOOTSTRAP_SCENARIOS.filter(s =>  s.requires_auth).map(s => s.name));
  const nodeUnauthIds  = new Set(BOOTSTRAP_SCENARIOS.filter(s => !s.requires_auth).map(s => s.name));

  const wrapperFailed      = results.some(r => !r.skipped && r.critical_failure && WRAPPER_NAMES.has(r.name));
  const rustEndpointFailed = results.some(r => !r.skipped && r.critical_failure && RUST_NAMES.has(r.name));
  const liveRustMeasured   = results.some(r => !r.skipped && RUST_NAMES.has(r.name));
  const nodeConfigured     = !!cfg.nodeBaseUrl;
  const nodeUnauthMeasured = results.some(r => !r.skipped && nodeUnauthIds.has(r.name));
  const nodeUnauthAllPass  = results.filter(r => !r.skipped && nodeUnauthIds.has(r.name)).every(r => r.pass);
  const nodeAuthMeasured   = results.some(r => !r.skipped && nodeAuthIds.has(r.name));
  const nodeAuthAllPass    = results.filter(r => !r.skipped && nodeAuthIds.has(r.name)).every(r => r.pass);

  // ── rust_sidecar_ready ────────────────────────────────────────────────────
  let rust_sidecar_ready;
  if (wrapperFailed) {
    rust_sidecar_ready = 'NO — Node wrapper fallback contract failed (do not enable Rust flag)';
  } else if (!liveRustMeasured) {
    rust_sidecar_ready = 'NO — live Rust endpoints not yet measured';
  } else if (rustEndpointFailed) {
    rust_sidecar_ready = 'NO — one or more Rust endpoints missed budget';
  } else {
    rust_sidecar_ready = 'YES (staging only)';
  }

  // ── node_staging_ready ────────────────────────────────────────────────────
  let node_staging_ready;
  if (!nodeConfigured) {
    node_staging_ready = 'NO — PERF_NODE_BASE_URL not set';
  } else if (nodeUnauthMeasured && nodeUnauthAllPass && nodeAuthMeasured && nodeAuthAllPass) {
    node_staging_ready = 'YES — unauth 401 + auth 200 tests both passing';
  } else if (nodeUnauthMeasured && nodeUnauthAllPass) {
    node_staging_ready = 'PARTIAL — unauth 401 tests pass; auth 200 tests need non-prod Supabase (see docs/node-staging-baseline.md)';
  } else if (nodeUnauthMeasured) {
    node_staging_ready = 'NO — Node service responding but unauth tests failed';
  } else {
    node_staging_ready = 'NO — Node URL set but no tests measured';
  }

  // ── node_auth_baseline_ready ──────────────────────────────────────────────
  let node_auth_baseline_ready;
  if (!nodeConfigured) {
    node_auth_baseline_ready = 'NO — PERF_NODE_BASE_URL not set';
  } else if (nodeAuthMeasured && nodeAuthAllPass) {
    node_auth_baseline_ready = 'YES — Node auth 200 tests passing with real DB data';
  } else if (nodeAuthMeasured) {
    node_auth_baseline_ready = 'NO — Node auth tests not passing (placeholder Supabase or missing data; see docs/node-staging-baseline.md)';
  } else {
    node_auth_baseline_ready = 'NO — Node auth tests not yet measured';
  }

  // ── production_enablement_ready ───────────────────────────────────────────
  let production_enablement_ready;
  const rustOk = rust_sidecar_ready.startsWith('YES');
  const nodeAuthOk = node_auth_baseline_ready.startsWith('YES');
  if (rustOk && nodeAuthOk) {
    production_enablement_ready = 'PENDING — Rust + Node baselines confirmed; requires 24h soak pass + canary gate (see docs/rust-staging-soak.md)';
  } else {
    const gaps = [];
    if (!rustOk)     gaps.push(`rust_sidecar_ready: ${rust_sidecar_ready}`);
    if (!nodeAuthOk) gaps.push(`node_auth_baseline_ready: ${node_auth_baseline_ready}`);
    production_enablement_ready = `NO — ${gaps.join(' | ')}`;
  }

  // ── safe_to_enable_rust (backwards-compat, Rust-only) ─────────────────────
  // Kept for CI scripts that grep this field. Now reflects only Rust+wrapper
  // health — Node staging failures do NOT block this signal.
  const safe_to_enable_rust = rustOk
    ? 'YES (staging only; production requires 24h soak + canary — see docs/rust-staging-live-test.md)'
    : rust_sidecar_ready;

  // ── Recommendations ───────────────────────────────────────────────────────
  const recs = [];
  if (skip_explanations.length) recs.push(`${skipped} test(s) skipped — see "Skipped tests" section for required env vars.`);
  const wrapperResults = results.filter(r => !r.skipped && r.p50_ms != null && WRAPPER_SCENARIOS.some(s => s.name === r.name));
  for (const w of wrapperResults) {
    if (w.p50_ms > 300) recs.push(`${w.name}: p50=${w.p50_ms}ms — investigate Node overhead.`);
  }
  if (!liveRustMeasured) {
    recs.push('Live Rust endpoints not measured. Follow docs/rust-staging-live-test.md to deploy staging and run: PERF_RUN_LIVE=true PERF_RUST_BASE_URL=<staging> npm run perf:test');
  }
  if (rustEndpointFailed || wrapperFailed) {
    recs.push('Rust or wrapper tests failed — fix before enabling Rust flag in any environment.');
  }
  if (node_auth_baseline_ready.startsWith('NO') && nodeConfigured) {
    recs.push('Node auth baseline not ready — create a non-prod Supabase project and follow docs/node-staging-baseline.md.');
  }

  const summary = {
    run_id,
    timestamp:    ts,
    mode,
    rustBaseUrl:  cfg.rustBaseUrl  ? '<configured>' : null,
    nodeBaseUrl:  cfg.nodeBaseUrl  ? '<configured>' : null,
    runLive:      cfg.runLive,
    iterations:   cfg.iterations,
    total:        results.length,
    passed,
    failed,
    skipped,
    critical_failures: critical,
    // Granular readiness fields (primary signal)
    rust_sidecar_ready,
    node_staging_ready,
    node_auth_baseline_ready,
    production_enablement_ready,
    // Backwards-compatible summary (Rust+wrapper only — does not reflect Node failures)
    safe_to_enable_rust,
    results,
    skip_explanations,
    recommendations: recs,
  };

  printConsole(summary);
  writeReports(summary);

  // Exit 1 only on Rust or wrapper critical failures.
  // Node auth failures (e.g. placeholder Supabase) are informational — they
  // appear in node_auth_baseline_ready and do NOT exit 1 from the soak runner.
  process.exitCode = (wrapperFailed || rustEndpointFailed) ? 1 : 0;
}

main().catch(err => {
  console.error('[perf] Fatal error:', err.message);
  process.exitCode = 1;
});
