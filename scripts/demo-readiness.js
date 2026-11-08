#!/usr/bin/env node
// FILE: scripts/demo-readiness.js
// `npm run demo:readiness` — the five-minute check before a meeting.
//
// Quick, read-only checks of what a live demo depends on:
//
//   DATASET        the Apex demo files exist, were made today (so overdue days
//                  are right) and their totals still add up
//   BACKEND        the API answers and runs this release
//   MIGRATIONS     the database is migrated to what this code expects
//   SIGNUP CODES   a new user can receive a sign-up code: an own email sender
//                  (not Resend's sandbox) or WhatsApp is configured
//   SIGNUP API     the sign-up endpoint answers (it is sent an empty form,
//                  which is refused before anything is created or sent)
//   WEBSITE        the public pages a guest opens load
//   FULL           with --full, also runs `npm run release:readiness` (sign-in,
//                  tenancy, Ask Starlane, desktop, installer, updater) and
//                  reports its verdict
//
// Statuses: PASS, WARN (the demo can go ahead, with the caveat shown), FAIL
// (fix before the meeting). Nothing is printed that is a secret: only whether
// something is configured.
//
// Usage:
//   npm run demo:readiness -- --api https://<backend> --site https://<website> [--full]
//   npm run demo:readiness -- --api http://localhost:4000 --site http://localhost:3000   (local fallback)
// Defaults: RELEASE_API_URL / RELEASE_SITE_URL, as for release:readiness.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { RELEASE } = require('../lib/release');

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i !== -1 ? args[i + 1] : null; };
const API = (opt('api') || process.env.RELEASE_API_URL || 'https://vantro-flow-backend-production.up.railway.app').replace(/\/+$/, '');
const SITE = (opt('site') || process.env.RELEASE_SITE_URL || '').replace(/\/+$/, '');
const DEMO_DIR = path.resolve(opt('demo-dir') || path.join(__dirname, '..', 'demo'));
const FULL = args.includes('--full');

const rows = [];
const add = (check, status, detail) => rows.push({ check, status, detail });

async function http(url, init = {}) {
  const res = await fetch(url, { redirect: 'follow', ...init, signal: AbortSignal.timeout(init.timeout || 20_000) });
  if (res.headers.get('x-deny-reason')) throw new Error(`this machine's network blocks ${new URL(url).host}`);
  let json = null;
  const text = await res.text();
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json };
}
const why = (e) => e?.message || e?.cause?.code || String(e);

function checkDataset() {
  const expectedFile = path.join(DEMO_DIR, 'expected.json');
  const csvFile = path.join(DEMO_DIR, 'apex-invoices.csv');
  const xlsxFile = path.join(DEMO_DIR, 'Apex-Bills-Receivable.xlsx');
  if (![expectedFile, csvFile, xlsxFile].every((f) => fs.existsSync(f))) {
    return add('DATASET', 'FAIL', `demo files missing in ${DEMO_DIR}; run npm run demo:dataset`);
  }
  const expected = JSON.parse(fs.readFileSync(expectedFile, 'utf8'));
  // Re-add the CSV independently of the script that wrote it.
  const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
  const asOf = new Date(`${expected.asOf}T00:00:00Z`);
  const [, ...lines] = fs.readFileSync(csvFile, 'utf8').trim().split('\n');
  let outstanding = 0, overdue = 0, count = 0;
  for (const line of lines) {
    const cells = line.match(/("([^"]|"")*"|[^,]*)(,|$)/g).map((c) => c.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"'));
    const [d, m, y] = cells[3].split('/').map(Number);
    const amount = Number(cells[4]);
    count++; outstanding += amount;
    if (Date.UTC(y, m - 1, d) < asOf.getTime()) overdue += amount;
  }
  if (count !== expected.bills || outstanding !== expected.outstanding || overdue !== expected.overdue) {
    return add('DATASET', 'FAIL', `the CSV adds up to ${count} bills, ₹${outstanding} outstanding, ₹${overdue} overdue, not what EXPECTED.md says; run npm run demo:dataset`);
  }
  if (asOf.getTime() !== today.getTime()) {
    return add('DATASET', 'WARN', `made ${expected.asOf}, so days overdue no longer match EXPECTED.md; run npm run demo:dataset this morning`);
  }
  add('DATASET', 'PASS', `${count} bills, ₹${outstanding.toLocaleString('en-IN')} outstanding, ₹${overdue.toLocaleString('en-IN')} overdue, made today`);
}

async function checkBackend() {
  try {
    const health = await http(`${API}/api/health`);
    const version = await http(`${API}/api/version`);
    if (health.status !== 200) add('BACKEND', 'FAIL', `${API}/api/health answered ${health.status}`);
    else if (version.json?.release !== RELEASE) add('BACKEND', 'FAIL', `the API runs release ${version.json?.release || 'unknown'}, this code is ${RELEASE}; deploy the backend`);
    else add('BACKEND', 'PASS', `release ${RELEASE}${API.startsWith('https://') ? '' : ' (not HTTPS: local fallback)'}`);
    const m = version.json?.migrations;
    if (!m) add('MIGRATIONS', 'FAIL', 'the API did not report its migrations');
    else if (m.upToDate) add('MIGRATIONS', 'PASS', `applied ${m.applied}`);
    else add('MIGRATIONS', 'FAIL', `applied ${m.applied || 'none'}, expected ${m.expected}`);
  } catch (e) {
    add('BACKEND', 'FAIL', `${API} not reachable: ${why(e)}`);
    add('MIGRATIONS', 'FAIL', 'backend not reachable');
    return false;
  }
  try {
    const ready = await http(`${API}/api/ready`);
    const c = ready.json?.checks || {};
    if (!('signupEmail' in c)) add('SIGNUP CODES', 'WARN', 'this backend does not report how sign-up codes are delivered; check EMAIL_FROM on the server by hand');
    else if (c.signupEmail === 'own_sender') add('SIGNUP CODES', 'PASS', `email from your own sender${c.signupWhatsapp === 'ok' ? ', WhatsApp also set' : ''}`);
    else if (c.signupWhatsapp === 'ok') add('SIGNUP CODES', 'WARN', `email is ${c.signupEmail.replace('_', ' ')}; codes can still go by WhatsApp`);
    else add('SIGNUP CODES', 'FAIL', c.signupEmail === 'sandbox_sender'
      ? "email uses Resend's sandbox sender, which only reaches the Resend account owner; set EMAIL_FROM to an address on a verified domain"
      : 'no email provider is configured (RESEND_API_KEY) and WhatsApp is not set; nobody can receive a code');
  } catch (e) {
    add('SIGNUP CODES', 'FAIL', `could not read ${API}/api/ready: ${why(e)}`);
  }
  try {
    // An empty form is refused before anything is created or sent.
    const r = await http(`${API}/api/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    if (r.status === 400) add('SIGNUP API', 'PASS', 'answers and validates (empty form refused with 400)');
    else if (r.status === 429) add('SIGNUP API', 'WARN', 'rate-limited from this machine right now (429); it is up');
    else add('SIGNUP API', r.status >= 500 ? 'FAIL' : 'WARN', `an empty form got ${r.status}, expected 400`);
  } catch (e) {
    add('SIGNUP API', 'FAIL', `not reachable: ${why(e)}`);
  }
  return true;
}

async function checkSite() {
  if (!SITE) return add('WEBSITE', 'WARN', 'no website given (--site or RELEASE_SITE_URL)');
  const bad = [];
  for (const p of ['/', '/signup', '/login', '/download', '/privacy', '/terms']) {
    try {
      const r = await http(`${SITE}${p}`);
      if (r.status !== 200) bad.push(`${p} ${r.status}`);
    } catch (e) {
      bad.push(`${p} unreachable (${why(e)})`);
    }
  }
  add('WEBSITE', bad.length ? 'FAIL' : 'PASS', bad.length ? bad.join(', ') : `${SITE}: home, sign-up, sign-in, download, privacy and terms load`);
}

function runFull() {
  if (!FULL) return add('FULL', 'WARN', 'skipped; add --full before a meeting to also sign in and check Ask Starlane, desktop, installer and updater');
  const r = spawnSync(process.execPath, [path.join(__dirname, 'release-readiness.js'), '--api', API, ...(SITE ? ['--site', SITE] : [])], { encoding: 'utf8', env: process.env, timeout: 600_000 });
  const out = `${r.stdout || ''}`;
  const verdict = (out.match(/VERDICT: (.+)/) || [])[1] || 'no verdict';
  const failing = out.split('\n').filter((l) => /^\w[\w ]*\s{2,}(FAIL|EXTERNAL VALIDATION REQUIRED)/.test(l)).map((l) => l.trim().split(/\s{2,}/)[0]);
  add('FULL', /NOT READY/.test(verdict) ? 'WARN' : 'PASS', `release:readiness says ${verdict}${failing.length ? `; not passing: ${failing.join(', ')}` : ''}`);
}

(async () => {
  checkDataset();
  await checkBackend();
  await checkSite();
  runFull();
  const worst = rows.some((r) => r.status === 'FAIL') ? 'FAIL' : rows.some((r) => r.status === 'WARN') ? 'WARN' : 'PASS';
  console.log([
    'STARLANE DEMO READINESS',
    `run at ${new Date().toISOString()} · release ${RELEASE} · api ${API} · site ${SITE || '(not given)'}`,
    '',
    ...rows.map((r) => `${r.check.padEnd(14)} ${r.status.padEnd(5)} ${r.detail}`),
    '',
    `RESULT: ${worst}${worst === 'FAIL' ? ' (fix the FAIL lines before the meeting)' : worst === 'WARN' ? ' (the demo can go ahead; read the WARN lines)' : ''}`,
  ].join('\n'));
  process.exit(worst === 'FAIL' ? 1 : 0);
})();
