'use strict';

// FILE: performance-lab/config.js
// All PERF_* env vars read once at startup.
// Blocks if a URL resolves to a known production host unless PERF_ALLOW_PRODUCTION=true.
//
// DESIGN — WHY HOSTNAME-BASED, NOT PATTERN-BASED
// ───────────────────────────────────────────────
// Railway always names its single environment "production", so every Railway
// service URL contains the substring "production" in its hostname:
//
//   vantro-automation-staging-production.up.railway.app   ← staging OK
//   vantro-flow-backend-production.up.railway.app         ← production BLOCK
//
// A regex like /production/i would block both. Instead this guard maintains an
// explicit list of known production hostnames and blocks only those. Any Railway
// staging URL that is NOT in the list is allowed.
//
// ADDING A NEW PRODUCTION SERVICE
// ────────────────────────────────
// When a new production deployment is created (new Railway service, new Vercel
// deploy, new custom subdomain), add its exact hostname to PRODUCTION_HOSTNAMES
// below so the guard stays current.

// ── Known production hostnames ─────────────────────────────────────────────
// Exact hostname matches. Case-insensitive. No scheme, no path.
const PRODUCTION_HOSTNAMES = new Set([
  // Railway production services
  'vantro-flow-backend-production.up.railway.app',

  // Custom production domains
  'vantro.in',
  'www.vantro.in',
  'api.vantro.in',
  'app.vantro.in',
]);

// ── Production host patterns ──────────────────────────────────────────────
// Used for families of hostnames that can't be enumerated exactly.
// Kept minimal — exact matches above are always preferred.
const PRODUCTION_HOST_PATTERNS = [
  /\.vantro\.in$/i,    // any *.vantro.in subdomain not already in the set above
  /\.supabase\.co$/i,  // any Supabase DB/API URL (project-ID varies per project)
];

// ── User-configured additional production hosts ───────────────────────────
// PERF_PRODUCTION_HOSTS=host1.example.com,host2.railway.app
// Useful for CI jobs that want to add new prod deployments without code change.
const customProdHosts = (process.env.PERF_PRODUCTION_HOSTS || '')
  .split(',')
  .map(h => h.trim().toLowerCase())
  .filter(Boolean);

// ── PERF_ALLOW_PRODUCTION ─────────────────────────────────────────────────
// Safety escape hatch. Must be explicitly true. Prints a loud warning.
// Never set this in CI or automated pipelines.
const allowProduction = process.env.PERF_ALLOW_PRODUCTION === 'true';

// ── Hostname extraction ───────────────────────────────────────────────────
// Works with http/https URLs and postgresql:// DSNs.
// Returns lowercase hostname only (no port, no path, no credentials).
function extractHostname(rawUrl) {
  if (!rawUrl) return null;
  try {
    // Normalise non-http schemes so URL() can parse them.
    // postgresql://user:pass@host:5432/db  →  https://host:5432/db
    const normalised = rawUrl.replace(/^[a-z][a-z0-9+\-.]*:\/\//i, 'https://');
    return new URL(normalised).hostname.toLowerCase();
  } catch {
    // Fallback regex: take segment between // and the next /: or end.
    // Strips user:pass@ prefix if present.
    const m = rawUrl.match(/\/\/(?:[^/@]*@)?([^/:?#]+)/);
    return m ? m[1].toLowerCase() : null;
  }
}

// ── Core predicate ────────────────────────────────────────────────────────
// Returns true iff the URL resolves to a known production host.
// Does NOT log or throw — callers decide what to do.
function looksLikeProd(url) {
  if (!url) return false;
  const host = extractHostname(url);
  if (!host) return false;
  if (PRODUCTION_HOSTNAMES.has(host)) return true;
  if (customProdHosts.includes(host))  return true;
  if (PRODUCTION_HOST_PATTERNS.some(p => p.test(host))) return true;
  return false;
}

// ── Guard self-tests ──────────────────────────────────────────────────────
// Runs synchronously at module load. If any expectation fails, the process
// throws before a single perf request is made. This catches programming bugs
// in the guard itself (e.g. someone accidentally re-adds /production/i).
//
// Custom PERF_PRODUCTION_HOSTS entries are appended in a separate test block.
(function runGuardSelfTests() {
  const cases = [
    // [url, expectBlocked, label]
    // ── Staging / local — must ALLOW ──────────────────────────────────────
    ['https://vantro-automation-staging-production.up.railway.app', false, 'Railway staging Rust (contains "production" — must allow)'],
    ['http://localhost:3001',                                         false, 'localhost'],
    ['http://127.0.0.1:3002',                                         false, '127.0.0.1 loopback'],
    ['https://arbitrary-staging-production.up.railway.app',          false, 'any non-listed Railway URL'],
    // ── Production — must BLOCK ──────────────────────────────────────────
    ['https://vantro-flow-backend-production.up.railway.app',        true,  'Railway production Node backend'],
    ['https://vantro.in',                                             true,  'Production root domain'],
    ['https://api.vantro.in',                                         true,  'Production API subdomain'],
    ['https://dashboard.vantro.in',                                   true,  'Production *.vantro.in wildcard'],
    ['postgresql://u:p@db.abc123.supabase.co:5432/postgres',          true,  'Supabase production DB URL'],
    ['https://project.supabase.co/rest/v1',                           true,  'Supabase REST API URL'],
  ];

  for (const [url, expectBlocked, label] of cases) {
    const blocked = looksLikeProd(url);
    if (blocked !== expectBlocked) {
      throw new Error(
        `[perf/config] Guard self-test FAILED: "${label}"\n` +
        `  URL:      ${url}\n` +
        `  Expected: blocked=${expectBlocked}\n` +
        `  Got:      blocked=${blocked}\n` +
        `  Fix PRODUCTION_HOSTNAMES or PRODUCTION_HOST_PATTERNS in performance-lab/config.js.`
      );
    }
  }

  // Custom PERF_PRODUCTION_HOSTS: each should be blocked
  for (const host of customProdHosts) {
    const blocked = looksLikeProd(`https://${host}`);
    if (!blocked) {
      throw new Error(
        `[perf/config] Guard self-test FAILED: custom PERF_PRODUCTION_HOSTS entry "${host}" not blocked.\n` +
        `  This is a bug in extractHostname or customProdHosts parsing.`
      );
    }
  }
}());

// ── Config object ─────────────────────────────────────────────────────────
const cfg = {
  nodeBaseUrl:      process.env.PERF_NODE_BASE_URL   || null,
  rustBaseUrl:      process.env.PERF_RUST_BASE_URL   || null,
  testToken:        process.env.PERF_TEST_TOKEN      || null,
  runLive:          process.env.PERF_RUN_LIVE        === 'true',
  timeoutMs:        parseInt(process.env.PERF_TIMEOUT_MS  || '3000', 10),
  iterations:       parseInt(process.env.PERF_ITERATIONS  || '5',    10),
  requireNonProd:   process.env.PERF_REQUIRE_NON_PROD !== 'false',
  allowProduction,
  // When PERF_SKIP_DB=true, DB-backed endpoints are marked SKIPPED rather than
  // FAIL. Set when staging Postgres has no schema applied yet.
  skipDb:           process.env.PERF_SKIP_DB === 'true',
};

// ── Production URL guard ──────────────────────────────────────────────────
if (allowProduction) {
  // Loud warning — operator has deliberately bypassed the guard.
  // Still safe to run; the warning is the control.
  console.warn('');
  console.warn('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
  console.warn('[perf] WARNING: PERF_ALLOW_PRODUCTION=true');
  console.warn('[perf] The production-host safety guard is DISABLED.');
  console.warn('[perf] You may be testing against a production service.');
  console.warn('[perf] This could affect real users or expose real data.');
  console.warn('[perf] Proceed only if you have explicit authorisation.');
  console.warn('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
  console.warn('');
} else if (cfg.requireNonProd) {
  // Default path: guard is active. Block known production hosts.
  // Log only the hostname — never token, auth header, or full URL with credentials.
  if (looksLikeProd(cfg.nodeBaseUrl)) {
    const host = extractHostname(cfg.nodeBaseUrl) || '<unknown>';
    console.error(`[perf] BLOCKED: PERF_NODE_BASE_URL hostname "${host}" is a known production host.`);
    console.error('[perf] Use a non-prod staging service. Set PERF_ALLOW_PRODUCTION=true to override (not recommended).');
    process.exit(1);
  }
  if (looksLikeProd(cfg.rustBaseUrl)) {
    const host = extractHostname(cfg.rustBaseUrl) || '<unknown>';
    console.error(`[perf] BLOCKED: PERF_RUST_BASE_URL hostname "${host}" is a known production host.`);
    console.error('[perf] Use a non-prod staging service. Set PERF_ALLOW_PRODUCTION=true to override (not recommended).');
    process.exit(1);
  }
}

// ── Live-mode prerequisites ───────────────────────────────────────────────
if (cfg.runLive && !cfg.rustBaseUrl && !cfg.nodeBaseUrl) {
  console.error('[perf] ERROR: PERF_RUN_LIVE=true but neither PERF_RUST_BASE_URL nor PERF_NODE_BASE_URL is set.');
  console.error('[perf] Set at least one base URL (non-prod) to run live tests.');
  process.exit(1);
}

if (cfg.runLive && !cfg.rustBaseUrl) {
  console.warn('[perf] WARNING: PERF_RUN_LIVE=true but PERF_RUST_BASE_URL not set — Rust tests will be skipped.');
}

// ── Exports ───────────────────────────────────────────────────────────────
module.exports = { ...cfg, looksLikeProd, extractHostname };
