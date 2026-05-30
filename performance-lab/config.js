'use strict';

// FILE: performance-lab/config.js
// All PERF_* env vars read once at startup. Blocks if prod URL detected.
//
// NOTE: railway.app is intentionally NOT in PROD_PATTERNS.
// Railway staging services legitimately use *.up.railway.app URLs.
// Only block known-production identifiers (custom domains, explicit prod subdomains,
// the production Supabase DB). If/when you have a known production Railway URL,
// add it explicitly below.

const PROD_PATTERNS = [
  /vantro\.in/i,       // production custom domain
  /\.prod\./i,         // explicit prod subdomain
  /production/i,       // URL contains the word production
  /supabase\.co/i,     // production Supabase DB URL
];

function looksLikeProd(url) {
  return url && PROD_PATTERNS.some(p => p.test(url));
}

const cfg = {
  nodeBaseUrl:    process.env.PERF_NODE_BASE_URL   || null,
  rustBaseUrl:    process.env.PERF_RUST_BASE_URL   || null,
  testToken:      process.env.PERF_TEST_TOKEN      || null,
  runLive:        process.env.PERF_RUN_LIVE        === 'true',
  timeoutMs:      parseInt(process.env.PERF_TIMEOUT_MS  || '3000',  10),
  iterations:     parseInt(process.env.PERF_ITERATIONS  || '5',     10),
  requireNonProd: process.env.PERF_REQUIRE_NON_PROD !== 'false',
  // When the live target's DB has no schema (fresh staging Postgres with no
  // migrations applied), DB-backed endpoints cannot be measured. Set
  // PERF_SKIP_DB=true to mark those SKIPPED (not PASS, not FAIL) with a reason.
  skipDb:         process.env.PERF_SKIP_DB === 'true',
};

if (cfg.requireNonProd) {
  if (looksLikeProd(cfg.nodeBaseUrl)) {
    console.error('[perf] BLOCKED: PERF_NODE_BASE_URL looks like production. Set PERF_REQUIRE_NON_PROD=false to override.');
    process.exit(1);
  }
  if (looksLikeProd(cfg.rustBaseUrl)) {
    console.error('[perf] BLOCKED: PERF_RUST_BASE_URL looks like production. Set PERF_REQUIRE_NON_PROD=false to override.');
    process.exit(1);
  }
}

// If live mode is explicitly requested but no targets are configured, error
// immediately rather than silently skipping everything.
if (cfg.runLive && !cfg.rustBaseUrl && !cfg.nodeBaseUrl) {
  console.error('[perf] ERROR: PERF_RUN_LIVE=true but neither PERF_RUST_BASE_URL nor PERF_NODE_BASE_URL is set. Nothing to test live. Set at least one base URL (non-prod).');
  process.exit(1);
}

// Warn (not error) if live mode on but Rust URL specifically missing.
if (cfg.runLive && !cfg.rustBaseUrl) {
  console.warn('[perf] WARNING: PERF_RUN_LIVE=true but PERF_RUST_BASE_URL not set — Rust endpoint tests will be skipped. Set PERF_RUST_BASE_URL to a non-prod Rust sidecar URL to measure live.');
}

module.exports = cfg;
