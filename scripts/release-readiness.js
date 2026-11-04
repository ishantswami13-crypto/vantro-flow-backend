#!/usr/bin/env node
// FILE: scripts/release-readiness.js
// `npm run release:readiness` — is Starlane ready to hand to real users?
//
// Unlike pilot:readiness (which proves the product loop on fixture tenants in
// a local database), this looks at the *deployed* system from the outside, the
// way a new customer meets it:
//
//   DATABASE           the production database answers through the API
//   MIGRATIONS         production migrations match this code (/api/version)
//   BACKEND            the API is up over HTTPS and runs this release
//   FRONTEND           the website serves its sign-in page over HTTPS
//   AUTH               no token and a forged token are refused; a real test
//                      account signs in, loads its company, signs out
//   TENANCY            the tenant-isolation scan passes, forged tokens are
//                      refused, and the pilot account cannot open an id it
//                      does not own (404)
//   BRIDGE             a real (pilot) company's Bridge loads from real data
//   CONNECTORS         that company has a connector whose last sync succeeded
//                      within 48 hours
//   SCAN               Scan answers from that company's own records
//   WATCH              Watch loads for that company
//   DECISIONS          that company's decisions load
//   SIMULATE           a cash simulation runs over that company's open invoices
//   PREPARED           that company's prepared work (approvals) loads
//   MISSIONS           Missions load for that company
//   AGENTS             the agent registry loads with at least one agent
//   CHAT               Ask Starlane has at least one AI model provider
//                      configured (/api/ai/health; never shows keys)
//   MEMORY             that company's memory (outcomes, knowledge) loads
//   POLICY             controls load: pilot mode and kill switches are readable
//   ACTIONS            never exercised against production by this probe (it
//                      takes no action); proved on fixtures by pilot:readiness
//   OUTCOME            the track record (verified outcomes) loads
//   DESKTOP            a Windows release is published and matches this release
//   INSTALLER          that installer downloads, is a Windows executable and
//                      matches its published SHA-256 and size
//   DOWNLOAD           the website's /download/windows hands out that binary
//   SECURITY           HTTPS + HSTS, forged tokens refused, tenant-isolation and
//                      secret scans of this code pass
//
// Statuses: PASS, FAIL, or EXTERNAL VALIDATION REQUIRED (could not be
// exercised from here, with the reason).
//
// Every check is PASS only when it was exercised against the real system just
// now. Anything that could not be exercised is EXTERNAL VALIDATION REQUIRED
// with the reason, and counts as not ready. Nothing is green by default.
//
// Verdict:
//   NOT READY             any check is not PASS, or full acceptance evidence
//                         remains outside this smoke probe. Even all checks PASS
//                         cannot certify real-PC installation, Tally sync,
//                         shadow missions or runtime tenant isolation.
//                         Manifest flags and owner-declared pilot counts are
//                         not substitutes for verified acceptance evidence.
//
// Configuration (flags or environment):
//   --api  RELEASE_API_URL    backend, default https://vantro-flow-backend-production.up.railway.app
//   --site RELEASE_SITE_URL   website origin (the final domain once it exists)
//   --repo RELEASE_REPO       GitHub repo holding desktop releases, default ishantswami13-crypto/vantro-flow-frontend
//   RELEASE_TEST_EMAIL / RELEASE_TEST_PASSWORD     a test account (AUTH)
//   RELEASE_PILOT_EMAIL / RELEASE_PILOT_PASSWORD   an account holding a real pilot company's data
//                                                  (TENANCY, BRIDGE, CONNECTORS, SCAN, WATCH, DECISIONS, SIMULATE,
//                                                   PREPARED, MISSIONS, AGENTS, CHAT, MEMORY, POLICY, OUTCOME)
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

const CHECKS = ['DATABASE', 'MIGRATIONS', 'BACKEND', 'FRONTEND', 'AUTH', 'TENANCY', 'BRIDGE', 'CONNECTORS', 'SCAN', 'WATCH', 'DECISIONS', 'SIMULATE', 'PREPARED', 'MISSIONS', 'AGENTS', 'CHAT', 'MEMORY', 'POLICY', 'ACTIONS', 'OUTCOME', 'DESKTOP', 'INSTALLER', 'DOWNLOAD', 'SECURITY'];
const EVR = 'EXTERNAL VALIDATION REQUIRED';
const results = Object.fromEntries(CHECKS.map((c) => [c, { status: EVR, detail: 'not reached' }]));
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
    if (!m) { set('DATABASE', 'FAIL', '/api/version could not read the migration ledger'); set('MIGRATIONS', 'FAIL', '/api/version did not report migrations'); }
    else {
      set('DATABASE', 'PASS', 'the API reads the production migration ledger');
      if (m.upToDate) set('MIGRATIONS', 'PASS', `applied ${m.applied} = expected ${m.expected}`);
      else set('MIGRATIONS', 'FAIL', `applied ${m.applied || 'none (not baselined)'}, this code expects ${m.expected}`);
    }
  } catch (e) {
    set('BACKEND', EVR, `${API} not reachable (${reason(e)})`);
    set('DATABASE', EVR, 'backend not reachable');
    set('MIGRATIONS', EVR, 'backend not reachable');
  }

  // ── FRONTEND ──────────────────────────────────────────────────────────
  if (!SITE) set('FRONTEND', EVR, 'no website URL (--site or RELEASE_SITE_URL)');
  else {
    try {
      const r = await http(`${SITE}/login`);
      facts.hsts = r.headers.get('strict-transport-security');
      const html = /text\/html/.test(r.headers.get('content-type') || '');
      if (!SITE.startsWith('https://')) set('FRONTEND', 'FAIL', `${SITE} is not HTTPS`);
      else if (r.status !== 200 || !html) set('FRONTEND', 'FAIL', `/login answered ${r.status} ${r.headers.get('content-type')}`);
      else set('FRONTEND', 'PASS', `${SITE}/login 200`);
    } catch (e) { set('FRONTEND', EVR, `${SITE} not reachable (${reason(e)})`); }
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
  } catch (e) { set('DESKTOP', EVR, `GitHub not reachable (${reason(e)})`); }

  if (!manifest) set('INSTALLER', results.DESKTOP.status === EVR ? EVR : 'FAIL', 'no published installer to check');
  else {
    const inst = manifest.platforms.windows.x64.installer;
    try {
      const got = await checkBinary(`${latest}/${inst.filename}`, inst);
      if (typeof got === 'string') set('INSTALLER', 'FAIL', got);
      else set('INSTALLER', 'PASS', `${inst.filename}, ${got.size} bytes, sha256 ${got.sha}`);
    } catch (e) { set('INSTALLER', EVR, `download failed (${reason(e)})`); }
  }

  // ── DOWNLOAD ─────────────────────────────────────────────────────────
  if (!SITE) set('DOWNLOAD', EVR, 'no website URL (--site or RELEASE_SITE_URL)');
  else {
    try {
      const got = await checkBinary(`${SITE}/download/windows`, manifest?.platforms.windows.x64.installer);
      const assessed = downloadResult(got, manifest?.platforms.windows.x64.installer);
      set('DOWNLOAD', assessed.status, `${SITE}/download/windows: ${assessed.detail}`);
    } catch (e) { set('DOWNLOAD', EVR, `${SITE}/download/windows not reachable (${reason(e)})`); }
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
    else if (!email || !password) set('AUTH', EVR, 'no token and forged token are refused (401), but no test account is configured (RELEASE_TEST_EMAIL/PASSWORD), so sign-in was not exercised');
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
  } catch (e) { set('AUTH', EVR, `backend not reachable (${reason(e)})`); }

  // ── Real company: BRIDGE, CONNECTOR, SCAN, WATCH, SIMULATE, MISSIONS ──
  const product = ['BRIDGE', 'CONNECTORS', 'SCAN', 'WATCH', 'DECISIONS', 'SIMULATE', 'PREPARED', 'MISSIONS', 'AGENTS', 'CHAT', 'MEMORY', 'POLICY', 'OUTCOME'];
  let pilotForeignId = null;
  const pe = process.env.RELEASE_PILOT_EMAIL; const pp = process.env.RELEASE_PILOT_PASSWORD;
  if (!pe || !pp) for (const c of product) set(c, EVR, 'no real pilot account configured (RELEASE_PILOT_EMAIL/PASSWORD); fixture proof is pilot:readiness, which says nothing about a real business');
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
      if (conns.status !== 200) set('CONNECTORS', 'FAIL', `answered ${conns.status}`);
      else if (!fresh.length) set('CONNECTORS', 'FAIL', `no connector synced successfully in the last 48 h (${list.filter((c) => c.state?.health && c.state.health !== 'not_connected' && c.state.health !== 'unavailable').map((c) => `${c.name}: ${c.state.health}`).join(', ') || 'none connected'})`);
      else set('CONNECTORS', 'PASS', fresh.map((c) => `${c.name} ${c.state.health}, last success ${c.state.lastSuccessAt}`).join('; '));

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

      // The unified list the Missions screen shows (decisions being handled,
      // workflows and collection missions), not only the legacy table.
      const mi = await get('/api/os/missions');
      set('MISSIONS', mi.status === 200 ? 'PASS' : 'FAIL', mi.status === 200 ? `${(mi.json?.missions || []).length} missions${Object.keys(mi.json?.byState || {}).length ? ` (${Object.entries(mi.json.byState).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(', ')})` : ''}` : `answered ${mi.status}`);

      const ai = await get('/api/ai/health');
      if (ai.status !== 200) set('CHAT', 'FAIL', `/api/ai/health answered ${ai.status}`);
      else if (!(ai.json?.configured || []).length) set('CHAT', 'FAIL', 'no AI model provider is configured, so Ask Starlane answers "No AI model is set up" (set GROQ_API_KEY, GEMINI_API_KEY or ANTHROPIC_API_KEY)');
      else set('CHAT', 'PASS', `providers ${ai.json.configured.join(' > ')}; usage ledger ${ai.json.usageLedger}`);
      const loads = async (check, p, describe) => {
        const r = await get(p);
        if (r.status !== 200) set(check, 'FAIL', `${p} answered ${r.status}`);
        else set(check, 'PASS', describe(r.json || {}));
      };
      await loads('DECISIONS', '/api/decisions', (j) => `${(j.decisions || []).length} active decisions`);
      await loads('PREPARED', '/api/os/workflows/items', (j) => `${(j.items || []).length} prepared items`);
      await loads('MEMORY', '/api/os/memory', (j) => `${(j.recentOutcomes || []).length} recent outcomes, ${(j.decisionContracts || []).length} decision contracts`);
      await loads('POLICY', '/api/decisions/controls', (j) => `pilot mode ${j.pilotMode || 'unknown'}, external sending ${j.externalSendEnabled ? 'ON' : 'off'}, global stop ${j.globalStop ? 'ON' : 'off'}, ${(j.controls || []).filter((c) => c.stopped).length} kill switches on`);
      await loads('OUTCOME', '/api/decisions/track-record', (j) => `track record loads: ${j.contracts ?? 0} decision contracts`);
      const ag = await get('/api/os/agents');
      if (ag.status !== 200) set('AGENTS', 'FAIL', `/api/os/agents answered ${ag.status}`);
      else if (!(ag.json?.agents || []).length) set('AGENTS', 'FAIL', 'no agents registered');
      else set('AGENTS', 'PASS', `${ag.json.agents.length} agents: ${ag.json.agents.map((a) => `${a.name} ${a.status}`).join(', ')}`);
      // TENANCY (runtime part): an id this account does not own is a 404, never data.
      const foreign = await get(`/api/decisions/${crypto.randomUUID()}`);
      pilotForeignId = foreign.status;
      await http(`${API}/api/auth/native/logout`, { method: 'POST', headers: { Authorization: `Bearer ${s.token}` } }).catch(() => {});
    } catch (e) { for (const c of product) if (results[c].detail === 'not reached') set(c, EVR, reason(e)); }
  }

  // ── ACTIONS: this probe never acts on production ──────────────────────
  set('ACTIONS', EVR, 'not exercised against production on purpose (this probe takes no action). Approval gate, kill switches, stale-data block, idempotency and shadow mode are proved on fixtures by pilot:readiness ACTIONS and tests/realityProof.test.mjs');

  // ── TENANCY ───────────────────────────────────────────────────────────
  {
    const scan = spawnSync(process.execPath, [path.join(__dirname, 'check-tenant-isolation.js')], { encoding: 'utf8', timeout: 120_000 });
    if (scan.status !== 0) set('TENANCY', 'FAIL', 'tenant-isolation scan of this code failed');
    else if (forgedRefused === false) set('TENANCY', 'FAIL', 'a forged token was accepted');
    else if (pilotForeignId != null && pilotForeignId !== 404) set('TENANCY', 'FAIL', `an id the pilot account does not own answered ${pilotForeignId}, not 404`);
    else if (forgedRefused === null || pilotForeignId == null) set('TENANCY', EVR, 'tenant-isolation scan passes; runtime check needs the backend and a pilot account (RELEASE_PILOT_EMAIL/PASSWORD)');
    else set('TENANCY', 'PASS', 'tenant-isolation scan passes, forged token refused, a foreign id is 404');
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
  else if (blocked.length) set('SECURITY', EVR, `tenant isolation and secret scans pass; ${blocked.join('; ')}`);
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
      ...CHECKS.map((c) => `${c.padEnd(18)} ${results[c].status.padEnd(29)} ${results[c].detail}`),
      '',
      `VERDICT: ${v.verdict}`,
      v.why,
    ];
    console.log(lines.join('\n'));
    if (OUT) fs.writeFileSync(OUT, JSON.stringify({ ranAt: new Date().toISOString(), release: RELEASE, api: API, site: SITE || null, results, facts, ...v }, null, 2));
    process.exit(v.verdict === 'NOT READY' ? 1 : 0);
  });
