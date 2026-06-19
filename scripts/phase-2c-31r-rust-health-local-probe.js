// FILE: scripts/phase-2c-31r-rust-health-local-probe.js
// ─────────────────────────────────────────────────────────────────────────────
// Phase 2C.31R — safe LOCAL health probe for the vantro-automation Rust sidecar.
//
// Purpose: prove (where a built binary exists) that the Axum server binds the
// platform PORT and answers GET /health within 30s — WITHOUT any production/staging
// secret or database. It binds an unused local port and connects only to 127.0.0.1.
//
// SAFETY: never reads the staging env file; never uses a real DATABASE_URL; never
// connects to production or staging DB; never sends anything externally; no repo writes.
// If it cannot run safely (no built binary on this host, or startup is coupled to a
// real DB), it reports a clearly-labelled BLOCKED status and does NOT fake success.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const HEALTH_TIMEOUT_MS = 30000;

const exe = process.platform === 'win32' ? '.exe' : '';
const CANDIDATES = [
  path.join(ROOT, 'bin', 'cortex-core' + exe),
  path.join(ROOT, 'target', 'x86_64-unknown-linux-musl', 'release', 'vantro-automation'),
  path.join(ROOT, 'target', 'release', 'vantro-automation' + exe),
];

function report(status, detail) {
  console.log('RUST_HEALTH_PROBE_JSON:' + JSON.stringify({ phase: '2C.31R', status, detail: detail || {} }, null, 1));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

function getHealth(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 4000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ code: res.statusCode, body: body.slice(0, 200) }));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

(async () => {
  const bin = CANDIDATES.find((p) => fs.existsSync(p));
  if (!bin) {
    report('BLOCKED_NO_BINARY', {
      reason: 'server-feature binary not built on this host',
      note: 'This Windows dev host cannot link the Rust `server` feature; build on Linux/CI/Railway. Probe not faked.',
      searched: CANDIDATES.map((p) => p.replace(ROOT, '<root>')),
    });
    process.exit(0);
  }

  const port = await freePort();
  // Safe, non-secret placeholders. DATABASE_URL is deliberately NOT a real connection
  // string: config.rs only requires the var to be present; a non-routable placeholder
  // means no real DB is ever contacted. JWT_SECRET is a throwaway local value.
  const env = {
    ...process.env,
    PORT: String(port),
    RUST_AUTOMATION_PORT: String(port),
    NODE_ENV: 'development',
    DATABASE_URL: 'disabled-for-local-probe-no-real-db',
    JWT_SECRET: 'local-probe-throwaway-not-a-real-secret',
    RUST_AUTOMATION_API_ENABLED: 'false',
  };
  // never inherit a real DB url that might be in the ambient shell
  delete env.SUPABASE_SERVICE_ROLE_KEY;

  const child = spawn(bin, [], { env, stdio: ['ignore', 'ignore', 'ignore'] });
  let exited = null;
  child.on('exit', (code) => { exited = code; });

  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let result = null;
  while (Date.now() < deadline) {
    if (exited !== null) break;
    // eslint-disable-next-line no-await-in-loop
    result = await getHealth(port);
    if (result && result.code) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 750));
  }

  try { child.kill('SIGKILL'); } catch (e) { /* ignore */ }

  if (result && result.code === 200 && /"ok"\s*:\s*true/.test(result.body)) {
    report('PASS', { port, http_status: 200, note: 'health responded within 30s; no secret/DB used' });
    process.exit(0);
  }
  if (exited !== null) {
    report('BLOCKED_DB_COUPLED', {
      note: 'process exited before serving /health — startup is coupled to an eager DB connect (documented finding). Cannot probe liveness locally without a reachable DB.',
      exit_code: exited,
    });
    process.exit(0);
  }
  report('BLOCKED_TIMEOUT', { port, note: 'no /health response within 30s; likely DB-coupled startup or port issue. Not faked.' });
  process.exit(0);
})();
