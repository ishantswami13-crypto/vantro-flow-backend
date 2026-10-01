#!/usr/bin/env node
// FILE: scripts/release-readiness.js
// `npm run release:readiness` — is Starlane ready to hand to real users?
//
// Unlike pilot:readiness (which proves the product loop on fixture tenants in
// a local database), this looks at the *deployed* system from the outside, the
// way a new customer meets it:
//
//   DATABASE           production migrations match this code (/api/version)
//   BACKEND            the API is up over HTTPS and runs this release
//   FRONTEND           the website serves its sign-in page over HTTPS
//   DESKTOP            a Windows release is published and matches this release
//   INSTALLER          that installer downloads, is a Windows executable and
//                      matches its published SHA-256 and size
//   DOWNLOAD_ENDPOINT  the website's /download/windows hands out that binary
//   AUTH               no token and a forged token are refused; a real test
//                      account signs in, loads its company, signs out
//   BRIDGE             a real (pilot) company's Bridge loads from real data
//   CONNECTOR          that company has a connector whose last sync succeeded
//                      within 48 hours
//   SCAN               Scan answers from that company's own records
//   WATCH              Watch loads for that company
//   SIMULATE           a cash simulation runs over that company's open invoices
//   MISSIONS           Missions load for that company
//   SECURITY           HTTPS + HSTS, forged tokens refused, tenant-isolation and
//                      secret scans of this code pass
//
// Every check is PASS only when it was exercised against the real system just
// now. Anything that could not be exercised is BLOCKED with the reason, and a
// BLOCKED check counts as not ready. Nothing is green by default.
//
// Verdict:
//   NOT READY             any check is not PASS
//   PILOT READY           all 14 checks PASS
//   PRODUCTION READY      PILOT READY, and the installer is code-signed, the
//                         app can update itself, and at least 3 real-business
//                         pilots are recorded as successful (RELEASE_SUCCESSFUL_PILOTS,
//                         declared by the owner, reported as declared)
//
// Configuration (flags or environment):
//   --api  RELEASE_API_URL    backend, default https://vantro-flow-backend-production.up.railway.app
//   --site RELEASE_SITE_URL   website origin (the final domain once it exists)
//   --repo RELEASE_REPO       GitHub repo holding desktop releases, default ishantswami13-crypto/vantro-flow-frontend
//   RELEASE_TEST_EMAIL / RELEASE_TEST_PASSWORD     a test account (AUTH)
//   RELEASE_PILOT_EMAIL / RELEASE_PILOT_PASSWORD   an account holding a real pilot company's data
//                                                  (BRIDGE, CONNECTOR, SCAN, WATCH, SIMULATE, MISSIONS)
//   --out FILE                 also write the results as JSON
//
// Read-only against production: it signs in, reads, runs a simulation (which is
// never persisted) and signs out. It creates, approves and sends nothing.

require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { RELEASE } = require('../lib/release');
const { validInstaller, freshHealthyConnector, downloadResult, assessVerdict } = require('./release-readiness-policy');

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i !== -1 ? args[i + 1] : null; };
const API = (opt('api') || process.env.RELEASE_API_URL || 'https://vantro-flow-backend-production.up.railway.app').replace(/\/+$/, '');
const SITE = (opt('site') || process.env.RELEASE_SITE_URL || '').replace(/\/+$/, '');
const REPO = opt('repo') || process.env.RELEASE_REPO || 'ishantswami13-crypto/vantro-flow-frontend';
const OUT = opt('out');

const CHECKS = ['DATABASE', 'BACKEND', 'FRONTEND', 'DESKTOP', 'INSTALLER', 'DOWNLOAD_ENDPOINT', 'AUTH', 'BRIDGE', 'CONNECTOR', 'SCAN', 'WATCH', 'SIMULATE', 'MISSIONS', 'SECURITY'];
const results = Object.fromEntries(CHECKS.map((c) => [c, { status: 'BLOCKED', detail: 'not reached' }]));
const set = (c, status, detail) => { results[c] = { status, detail }; };
const facts = {};

async function http(url, init = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(init.timeout || 30_000) });
  // A network egress proxy refusing the host is not the target's answer.
  if (res.headers.get('x-deny-reason')) throw new Error(`network egress from this machine blocked ${new URL(url).host} (${res.headers.get('x-deny-reason')}); run this where the host is reachable`);
  const buf = Buffer.from(await res.arrayBuffer());
  let json = null;
  try { json = JSON.parse(buf.toString('utf8')); } catch { /* not JSON */ }
  return { status: res.status, headers: res.headers, buf, json, url: res.url };
}
const reason = (e) => (e?.cause?.code || e?.name || 'error') + (e?.message ? `: ${e.message}` : '');

// Downloads a URL to the end and checks it is a Windows installer.
async function checkBinary(url, expect) {
  const r = await http(url, { timeout: 180_000, redirect: 'follow' });
  const ctype = (r.headers.get('content-type') || '').toLowerCase();
  if (r.status !== 200) return `status ${r.status}`;
  if (/text\/html|application\/json|text\/plain/.test(ctype)) return `served ${ctype}, not a binary`;
  if (!r.buf.length) return 'zero-byte file';
  if (r.buf.subarray(0, 2).toString('latin1') !== 'MZ') return 'not a Windows executable';
  const sha = crypto.createHash('sha256').update(r.buf).digest('hex');
  if (expect && (sha !== expect.sha256.toLowerCase() || r.buf.length !== expect.size)) return `SHA-256/size ${sha}/${r.buf.length} do not match the manifest ${expect.sha256}/${expect.size}`;
  return { sha, size: r.buf.length };
}

async function run() {
  // ── DATABASE + BACKEND ────────────────────────────────────────────────
  try {
    const health = await http(`${API}/api/health`);
    const version = await http(`${API}/api/version`);
    facts.backend = version.json;
    if (!API.startsWith('https://')) set('BACKEND', 'FAIL', `${API} is not HTTPS`);
    else if (health.status !== 200) set('BACKEND', 'FAIL', `/api/health answered ${health.status}`);
    else if (version.json?.release !== RELEASE) set('BACKEND', 'FAIL', `deployed release ${version.json?.release} is not this release ${RELEASE}`);
    else set('BACKEND', 'PASS', `release ${RELEASE}, git ${version.json.gitSha || 'unknown'}`);
    const m = version.json?.migrations;
    if (!m) set('DATABASE', 'FAIL', '/api/version did not report migrations');
    else if (m.upToDate) set('DATABASE', 'PASS', `applied ${m.applied} = expected ${m.expected}`);
    else set('DATABASE', 'FAIL', `applied ${m.applied || 'none (not baselined)'}, this code expects ${m.expected}`);
  } catch (e) {
    set('BACKEND', 'BLOCKED', `${API} not reachable (${reason(e)})`);
    set('DATABASE', 'BLOCKED', 'backend not reachable');
  }

  // ── FRONTEND ──────────────────────────────────────────────────────────
  if (!SITE) set('FRONTEND', 'BLOCKED', 'no website URL (--site or RELEASE_SITE_URL)');
  else {
    try {
      const r = await http(`${SITE}/login`);
      facts.hsts = r.headers.get('strict-transport-security');
      const html = /text\/html/.test(r.headers.get('content-type') || '');
      if (!SITE.startsWith('https://')) set('FRONTEND', 'FAIL', `${SITE} is not HTTPS`);
      else if (r.status !== 200 || !html) set('FRONTEND', 'FAIL', `/login answered ${r.status} ${r.headers.get('content-type')}`);
      else set('FRONTEND', 'PASS', `${SITE}/login 200`);
    } catch (e) { set('FRONTEND', 'BLOCKED', `${SITE} not reachable (${reason(e)})`); }
  }

  // ── DESKTOP + INSTALLER ───────────────────────────────────────────────
  let manifest = null;
  const latest = `https://github.com/${REPO}/releases/latest/download`;
  try {
    const r = await http(`${latest}/starlane-release.json`, { redirect: 'follow' });
    if (r.status === 404) set('DESKTOP', 'FAIL', `no desktop release published on ${REPO} (releases/latest has no starlane-release.json)`);
    else if (r.status !== 200 || !validInstaller(r.json?.platforms?.windows?.x64?.installer)) set('DESKTOP', 'FAIL', `the published manifest has no valid Windows installer identity (status ${r.status})`);
    else {
      manifest = r.json;
      facts.desktop = { version: manifest.version, label: manifest.label, signed: manifest.signed, updater: manifest.updater, published_at: manifest.published_at };
      if (manifest.version !== RELEASE) set('DESKTOP', 'FAIL', `published desktop ${manifest.version} does not match backend release ${RELEASE}`);
      else set('DESKTOP', 'PASS', `${manifest.label}, published ${manifest.published_at}${manifest.signed ? ', code-signed' : ', NOT code-signed'}${manifest.updater ? ', self-updating' : ', no self-update'}`);
    }
  } catch (e) { set('DESKTOP', 'BLOCKED', `GitHub not reachable (${reason(e)})`); }

  if (!manifest) set('INSTALLER', results.DESKTOP.status === 'BLOCKED' ? 'BLOCKED' : 'FAIL', 'no published installer to check');
  else {
    const inst = manifest.platforms.windows.x64.installer;
    try {
      const got = await checkBinary(`${latest}/${inst.filename}`, inst);
      if (typeof got === 'string') set('INSTALLER', 'FAIL', got);
      else set('INSTALLER', 'PASS', `${inst.filename}, ${got.size} bytes, sha256 ${got.sha}`);
    } catch (e) { set('INSTALLER', 'BLOCKED', `download failed (${reason(e)})`); }
  }

  // ── DOWNLOAD_ENDPOINT ─────────────────────────────────────────────────
  if (!SITE) set('DOWNLOAD_ENDPOINT', 'BLOCKED', 'no website URL (--site or RELEASE_SITE_URL)');
  else {
    try {
      const got = await checkBinary(`${SITE}/download/windows`, manifest?.platforms.windows.x64.installer);
      const assessed = downloadResult(got, manifest?.platforms.windows.x64.installer);
      set('DOWNLOAD_ENDPOINT', assessed.status, `${SITE}/download/windows: ${assessed.detail}`);
    } catch (e) { set('DOWNLOAD_ENDPOINT', 'BLOCKED', `${SITE}/download/windows not reachable (${reason(e)})`); }
  }

  // ── AUTH ──────────────────────────────────────────────────────────────
  let forgedRefused = null;
  try {
    const none = await http(`${API}/api/client/bootstrap`);
    const forged = await http(`${API}/api/client/bootstrap`, { headers: { Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOiIwMDAwIn0.forged' } });
    forgedRefused = none.status === 401 && forged.status === 401;
    const email = process.env.RELEASE_TEST_EMAIL || process.env.RELEASE_PILOT_EMAIL;
    const password = process.env.RELEASE_TEST_PASSWORD || process.env.RELEASE_PILOT_PASSWORD;
    if (!forgedRefused) set('AUTH', 'FAIL', `no token -> ${none.status}, forged token -> ${forged.status} (both must be 401)`);
    else if (!email || !password) set('AUTH', 'BLOCKED', 'no token and forged token are refused (401), but no test account is configured (RELEASE_TEST_EMAIL/PASSWORD), so sign-in was not exercised');
    else {
      const wrong = await http(`${API}/api/auth/native/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: `${password}-wrong` }) });
      const s = await signIn(email, password);
      if (wrong.status !== 401) set('AUTH', 'FAIL', `a wrong password answered ${wrong.status}`);
      else if (!s.token) set('AUTH', 'FAIL', `sign-in failed: ${s.error}`);
      else {
        const boot = await http(`${API}/api/client/bootstrap`, { headers: { Authorization: `Bearer ${s.token}` } });
        await http(`${API}/api/auth/native/logout`, { method: 'POST', headers: { Authorization: `Bearer ${s.token}` } });
        const after = await http(`${API}/api/client/bootstrap`, { headers: { Authorization: `Bearer ${s.token}` } });
        if (boot.status !== 200) set('AUTH', 'FAIL', `signed-in bootstrap answered ${boot.status}`);
        else if (after.status !== 401) set('AUTH', 'FAIL', `the session still works after sign-out (${after.status})`);
        else set('AUTH', 'PASS', 'no/forged token 401, wrong password 401, sign-in 200, company loads, sign-out ends the session');
      }
    }
  } catch (e) { set('AUTH', 'BLOCKED', `backend not reachable (${reason(e)})`); }

  // ── Real company: BRIDGE, CONNECTOR, SCAN, WATCH, SIMULATE, MISSIONS ──
  const product = ['BRIDGE', 'CONNECTOR', 'SCAN', 'WATCH', 'SIMULATE', 'MISSIONS'];
  const pe = process.env.RELEASE_PILOT_EMAIL; const pp = process.env.RELEASE_PILOT_PASSWORD;
  if (!pe || !pp) for (const c of product) set(c, 'BLOCKED', 'no real pilot account configured (RELEASE_PILOT_EMAIL/PASSWORD); fixture proof is pilot:readiness, which says nothing about a real business');
  else {
    try {
      const s = await signIn(pe, pp);
      if (!s.token) throw new Error(`pilot sign-in failed: ${s.error}`);
      const get = (p) => http(`${API}${p}`, { headers: { Authorization: `Bearer ${s.token}` } });
      const bridge = await get('/api/client/bridge');
      const b = bridge.json || {};
      if (bridge.status !== 200) set('BRIDGE', 'FAIL', `answered ${bridge.status}`);
      else if (!b.dataAsOf) set('BRIDGE', 'FAIL', 'loads, but the company has no imported data yet');
      else set('BRIDGE', 'PASS', `real data as of ${b.dataAsOf} (${b.freshness})`);

      const conns = await get('/api/connectors');
      const list = conns.json?.connectors || [];
      const fresh = list.filter((c) => freshHealthyConnector(c));
      if (conns.status !== 200) set('CONNECTOR', 'FAIL', `answered ${conns.status}`);
      else if (!fresh.length) set('CONNECTOR', 'FAIL', `no connector synced successfully in the last 48 h (${list.filter((c) => c.state?.health && c.state.health !== 'not_connected' && c.state.health !== 'unavailable').map((c) => `${c.name}: ${c.state.health}`).join(', ') || 'none connected'})`);
      else set('CONNECTOR', 'PASS', fresh.map((c) => `${c.name} ${c.state.health}, last success ${c.state.lastSuccessAt}`).join('; '));

      const invoices = await get('/api/client/scan/search?q=' + encodeURIComponent('in'));
      const hits = (invoices.json?.customers?.length || 0) + (invoices.json?.invoices?.length || 0);
      if (invoices.status !== 200) set('SCAN', 'FAIL', `search answered ${invoices.status}`);
      else if (!hits) set('SCAN', 'FAIL', 'search found nothing in this company\'s records');
      else set('SCAN', 'PASS', `search answers from the company's own records (${hits} matches)`);

      const w = await get('/api/client/watch');
      set('WATCH', w.status === 200 ? 'PASS' : 'FAIL', w.status === 200 ? `${(w.json?.events || []).length} active events` : `answered ${w.status}`);

      const sim = await http(`${API}/api/client/simulate`, { method: 'POST', headers: { Authorization: `Bearer ${s.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      if (sim.status !== 200) set('SIMULATE', 'FAIL', `answered ${sim.status}`);
      else if (!sim.json?.simulation) set('SIMULATE', 'FAIL', `no simulation (${sim.json?.emptyReason || `${sim.json?.invoiceCount} open invoices`})`);
      else set('SIMULATE', 'PASS', `simulated ${sim.json.invoiceCount} open invoices (not persisted)`);

      const mi = await get('/api/client/missions');
      set('MISSIONS', mi.status === 200 ? 'PASS' : 'FAIL', mi.status === 200 ? `${(mi.json?.missions || []).length} missions` : `answered ${mi.status}`);
      await http(`${API}/api/auth/native/logout`, { method: 'POST', headers: { Authorization: `Bearer ${s.token}` } }).catch(() => {});
    } catch (e) { for (const c of product) if (results[c].detail === 'not reached') set(c, 'BLOCKED', reason(e)); }
  }

  // ── SECURITY ──────────────────────────────────────────────────────────
  const problems = [];
  const blocked = [];
  if (!API.startsWith('https://')) problems.push('API is not HTTPS');
  if (SITE && !SITE.startsWith('https://')) problems.push('website is not HTTPS');
  if (!SITE) blocked.push('website not given, HSTS not checked');
  else if (results.FRONTEND.status !== 'PASS') blocked.push('website could not be verified, HSTS not checked');
  else if (results.FRONTEND.status === 'PASS' && !/max-age=\d{7,}/.test(facts.hsts || '')) problems.push('website sends no long HSTS header');
  if (forgedRefused === false) problems.push('a forged token was not refused');
  if (forgedRefused === null) blocked.push('backend not reachable, token handling not checked');
  for (const [name, script] of [['tenant isolation', 'check-tenant-isolation.js'], ['secret scan', 'security-secret-scan.js']]) {
    const r = spawnSync(process.execPath, [path.join(__dirname, script)], { encoding: 'utf8', timeout: 120_000 });
    if (r.status !== 0) problems.push(`${name} failed`);
  }
  if (problems.length) set('SECURITY', 'FAIL', problems.join('; '));
  else if (blocked.length) set('SECURITY', 'BLOCKED', `tenant isolation and secret scans pass; ${blocked.join('; ')}`);
  else set('SECURITY', 'PASS', 'HTTPS + HSTS, forged tokens refused, tenant-isolation and secret scans pass');
}

async function signIn(email, password) {
  const r = await http(`${API}/api/auth/native/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, client: 'desktop', platform: 'release-readiness', deviceName: 'release readiness check', appVersion: RELEASE }) });
  return { token: r.json?.accessToken || null, error: r.json?.error || `status ${r.status}` };
}

function verdict() {
  return assessVerdict(CHECKS, results);
}

run()
  .catch((e) => { console.error('release-readiness crashed:', e); })
  .finally(() => {
    const v = verdict();
    const lines = [
      'STARLANE RELEASE READINESS',
      `run at ${new Date().toISOString()} · release ${RELEASE} · api ${API} · site ${SITE || '(not given)'} · releases ${REPO}`,
      '',
      ...CHECKS.map((c) => `${c.padEnd(18)} ${results[c].status.padEnd(8)} ${results[c].detail}`),
      '',
      `VERDICT: ${v.verdict}`,
      v.why,
    ];
    console.log(lines.join('\n'));
    if (OUT) fs.writeFileSync(OUT, JSON.stringify({ ranAt: new Date().toISOString(), release: RELEASE, api: API, site: SITE || null, results, facts, ...v }, null, 2));
    process.exit(v.verdict === 'NOT READY' ? 1 : 0);
  });
