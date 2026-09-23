#!/usr/bin/env node
/**
 * Starlane Tally Connector v2
 * ---------------------------
 * Runs on the laptop where TallyPrime is installed. Pulls Sales, Purchase,
 * Receipt, and Payment vouchers (with stock items) from Tally's XML port and
 * pushes them to Starlane's /api/import/tally route, which lands them
 * idempotently in invoices / purchases / bank_transactions / products /
 * stock_movements. Safe to re-run — nothing is ever imported twice.
 *
 * Zero dependencies — plain Node.js (v18+).
 *
 * Usage:
 *   node tally-sync.mjs --enroll <code>   # one-time: claim an enrollment code from the
 *                                         # "Connect Tally" button, store a device
 *                                         # credential in .vantro-device-credentials.json,
 *                                         # then run one sync
 *   node tally-sync.mjs --test      # offline: parse sample-daybook.xml, print payload (no Tally, no internet)
 *   node tally-sync.mjs --dry-run   # pull from Tally + parse, but DON'T send (print what would be sent)
 *   node tally-sync.mjs             # full sync: Tally -> Starlane, once (uses stored device
 *                                   # credential if present, else falls back to
 *                                   # starlane.email/password or starlane.token in config.json)
 *   node tally-sync.mjs --watch     # full sync on a loop every config.intervalMinutes
 *
 * Auth: the preferred path is `--enroll <code>` once, which claims a device
 * credential (deviceId + deviceSecret) via POST /api/connectors/tally/claim
 * and stores it locally in .vantro-device-credentials.json (gitignored,
 * next to this script). Every subsequent run reuses that credential and
 * authenticates as `Authorization: VantroDevice <deviceId>.<deviceSecret>`.
 * The old email+password / static-token config (starlane.email/password/
 * token in config.json) still works as a fallback for anyone already
 * relying on it, but is no longer the recommended path — a device
 * credential doesn't require storing your Starlane account password on
 * the shop PC.
 */

import http from 'node:http';
import https from 'node:https';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const args = new Set(argv);
const MODE = args.has('--test') ? 'test' : args.has('--dry-run') ? 'dry-run' : args.has('--watch') ? 'watch' : 'once';
const enrollIndex = argv.indexOf('--enroll');
const ENROLLMENT_CODE = enrollIndex >= 0 ? argv[enrollIndex + 1] : null;
const CREDENTIALS_PATH = join(HERE, '.vantro-device-credentials.json');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const TEST_CONFIG = {
  tally: { host: 'localhost', port: 9000 },
  companies: [''],
  starlane: { apiBase: 'http://localhost:8787', email: '', password: '', token: '' },
  voucherTypes: ['Sales', 'Purchase', 'Receipt', 'Payment', 'Credit Note', 'Debit Note'],
  fromDate: financialYearStart(),
  toDate: today(),
  intervalMinutes: 30,
};

function loadConfig() {
  const p = join(HERE, 'config.json');
  if (!existsSync(p)) {
    if (MODE === 'test') return TEST_CONFIG;
    console.error('❌ config.json not found. Copy config.example.json to config.json and fill it in.');
    process.exit(1);
  }
  try {
    const cfg = { ...TEST_CONFIG, ...JSON.parse(readFileSync(p, 'utf-8')) };
    if (!cfg.fromDate) cfg.fromDate = financialYearStart();
    if (!cfg.toDate) cfg.toDate = today();
    if (!Array.isArray(cfg.companies) || cfg.companies.length === 0) cfg.companies = [''];
    if (!Array.isArray(cfg.voucherTypes) || cfg.voucherTypes.length === 0) cfg.voucherTypes = TEST_CONFIG.voucherTypes;
    cfg.starlane = { ...TEST_CONFIG.starlane, ...(cfg.starlane || {}) };
    cfg.tally = { ...TEST_CONFIG.tally, ...(cfg.tally || {}) };
    return cfg;
  } catch (e) {
    console.error('❌ config.json is not valid JSON:', e.message);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Date helpers (Tally wants YYYYMMDD)
// ---------------------------------------------------------------------------
function today() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}
function financialYearStart() {
  // Indian FY starts 1 April
  const d = new Date();
  const y = d.getMonth() + 1 >= 4 ? d.getFullYear() : d.getFullYear() - 1;
  return `${y}0401`;
}
function tallyDateToISO(yyyymmdd) {
  const s = String(yyyymmdd || '').trim();
  if (!/^\d{8}$/.test(s)) return null;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

// ---------------------------------------------------------------------------
// Tally XML request
// ---------------------------------------------------------------------------
function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function dayBookRequestXML(fromDate, toDate, company) {
  const companyTag = company ? `<SVCURRENTCOMPANY>${escapeXml(company)}</SVCURRENTCOMPANY>` : '';
  return `<ENVELOPE>
 <HEADER>
  <VERSION>1</VERSION>
  <TALLYREQUEST>Export</TALLYREQUEST>
  <TYPE>Data</TYPE>
  <ID>Day Book</ID>
 </HEADER>
 <BODY>
  <DESC>
   <STATICVARIABLES>
    <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
    <SVFROMDATE TYPE="Date">${fromDate}</SVFROMDATE>
    <SVTODATE TYPE="Date">${toDate}</SVTODATE>
    ${companyTag}
   </STATICVARIABLES>
  </DESC>
 </BODY>
</ENVELOPE>`;
}

function fetchTallyDayBook(cfg, company) {
  const body = dayBookRequestXML(cfg.fromDate, cfg.toDate, company);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: cfg.tally.host, port: cfg.tally.port, method: 'POST', headers: { 'Content-Type': 'text/xml', 'Content-Length': Buffer.byteLength(body) }, timeout: 60000 },
      (res) => {
        let data = '';
        res.setEncoding('utf-8');
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve(data));
      }
    );
    req.on('error', (e) => reject(new Error(`Cannot reach Tally at ${cfg.tally.host}:${cfg.tally.port} — is TallyPrime open and is "Act as Server" ON? (${e.code || e.message})`)));
    req.on('timeout', () => { req.destroy(); reject(new Error('Tally took too long to respond (timeout).')); });
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// XML parsing (regex-based, zero-dependency)
// ---------------------------------------------------------------------------
function decode(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#4;/g, '').trim();
}
function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decode(m[1]) : null;
}
function num(v) {
  if (v == null) return NaN;
  return parseFloat(String(v).replace(/[₹,\s]/g, ''));
}
/** Tally quantities look like " 5 nos" or "5.00 pcs" — take the number. */
function qtyNum(v) {
  if (v == null) return NaN;
  const m = String(v).match(/-?[\d.]+/);
  return m ? Math.abs(parseFloat(m[0])) : NaN;
}

/** Parse a Tally Day Book XML export into normalised voucher objects. */
function parseVouchers(xml) {
  const out = [];
  const blocks = xml.match(/<VOUCHER\b[\s\S]*?<\/VOUCHER>/gi) || [];
  for (const b of blocks) {
    const vchType = tag(b, 'VOUCHERTYPENAME') || (b.match(/<VOUCHER[^>]*VCHTYPE="([^"]*)"/i)?.[1] ?? '');
    const date = tag(b, 'DATE');
    const party = tag(b, 'PARTYLEDGERNAME') || tag(b, 'PARTYNAME');
    const vchNo = tag(b, 'VOUCHERNUMBER') || tag(b, 'MASTERID') || '';

    // Amount: prefer the party ledger's own amount; else the largest absolute ledger amount.
    let amount = NaN;
    const entries = b.match(/<ALLLEDGERENTRIES\.LIST>[\s\S]*?<\/ALLLEDGERENTRIES\.LIST>/gi)
      || b.match(/<LEDGERENTRIES\.LIST>[\s\S]*?<\/LEDGERENTRIES\.LIST>/gi) || [];
    let maxAbs = NaN;
    for (const e of entries) {
      const ln = tag(e, 'LEDGERNAME');
      const amt = num(tag(e, 'AMOUNT'));
      if (!isNaN(amt)) {
        if (isNaN(maxAbs) || Math.abs(amt) > Math.abs(maxAbs)) maxAbs = amt;
        if (party && ln && ln.toLowerCase() === party.toLowerCase()) amount = amt;
      }
    }
    if (isNaN(amount)) amount = maxAbs;
    if (isNaN(amount)) amount = num(tag(b, 'AMOUNT'));

    // Stock items (Sales/Purchase vouchers carry ALLINVENTORYENTRIES.LIST)
    const items = [];
    const invEntries = b.match(/<ALLINVENTORYENTRIES\.LIST>[\s\S]*?<\/ALLINVENTORYENTRIES\.LIST>/gi)
      || b.match(/<INVENTORYENTRIES\.LIST>[\s\S]*?<\/INVENTORYENTRIES\.LIST>/gi) || [];
    for (const e of invEntries) {
      const name = tag(e, 'STOCKITEMNAME');
      const qty = qtyNum(tag(e, 'ACTUALQTY') || tag(e, 'BILLEDQTY'));
      const rate = num(tag(e, 'RATE'));
      if (name && !isNaN(qty) && qty > 0) items.push({ name, qty, rate: isNaN(rate) ? 0 : Math.abs(rate) });
    }

    out.push({
      type: decode(vchType), date, party, voucherNo: vchNo,
      amount: isNaN(amount) ? null : Math.abs(amount), items,
    });
  }
  return out;
}

/** Keep only wanted voucher types with usable party + amount + date, as API payload rows. */
function toApiVouchers(vouchers, wantedTypes) {
  const wanted = wantedTypes.map((t) => t.toLowerCase());
  const rows = [];
  const skipped = [];
  for (const v of vouchers) {
    const typeMatch = wanted.some((w) => (v.type || '').toLowerCase().includes(w));
    const iso = tallyDateToISO(v.date);
    if (!typeMatch || !v.party || !v.amount || !iso || v.amount <= 0) { skipped.push(v); continue; }
    rows.push({ type: v.type, date: iso, party: v.party, voucherNo: v.voucherNo, amount: v.amount, items: v.items });
  }
  return { rows, skipped };
}

// ---------------------------------------------------------------------------
// Starlane API
// ---------------------------------------------------------------------------
function apiRequest(apiBase, path, { method = 'GET', authHeader, json } = {}) {
  const url = new URL(path, apiBase.replace(/\/+$/, '') + '/');
  const lib = url.protocol === 'https:' ? https : http;
  let body, headers = { accept: 'application/json' };
  if (authHeader) headers.authorization = authHeader;
  if (json) { body = Buffer.from(JSON.stringify(json)); headers['content-type'] = 'application/json'; headers['content-length'] = body.length; }
  return new Promise((resolve, reject) => {
    const req = lib.request(url, { method, headers, timeout: 60000 }, (res) => {
      let data = '';
      res.setEncoding('utf-8');
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let parsed; try { parsed = JSON.parse(data); } catch { parsed = data; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Starlane request timed out.')); });
    if (body) req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Device-credential enrollment (preferred auth path)
// ---------------------------------------------------------------------------
function loadDeviceCredentials() {
  if (!existsSync(CREDENTIALS_PATH)) return null;
  try {
    const { deviceId, deviceSecret } = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf-8'));
    if (!deviceId || !deviceSecret) return null;
    return { deviceId, deviceSecret };
  } catch {
    return null;
  }
}

async function claimEnrollment(apiBase, enrollmentCode) {
  const r = await apiRequest(apiBase, '/api/connectors/tally/claim', {
    method: 'POST',
    json: { enrollmentCode, deviceName: process.env.COMPUTERNAME || process.env.HOSTNAME || 'Tally connector script' },
  });
  if (r.status !== 201 || !r.body?.deviceId) throw new Error(`Enrollment claim failed (${r.status}): ${r.body?.error || JSON.stringify(r.body)}`);
  return { deviceId: r.body.deviceId, deviceSecret: r.body.deviceSecret };
}

/** Resolve an Authorization header, preferring a stored device credential over
 * email/password or a static token — a device credential never puts the
 * Starlane account password on the shop PC and can be revoked per-device
 * from Settings without touching the account login. */
async function getAuthHeader(cfg) {
  const device = loadDeviceCredentials();
  if (device) return `VantroDevice ${device.deviceId}.${device.deviceSecret}`;
  if (cfg.starlane.token) return `Bearer ${cfg.starlane.token}`;
  if (!cfg.starlane.email || !cfg.starlane.password) {
    throw new Error('Not paired. Run `node tally-sync.mjs --enroll <code>` with the code from the "Connect Tally" button (or set starlane.email + starlane.password / starlane.token in config.json as a fallback).');
  }
  const r = await apiRequest(cfg.starlane.apiBase, '/api/auth/login', { method: 'POST', json: { email: cfg.starlane.email, password: cfg.starlane.password } });
  if (r.status !== 200 || !r.body?.token) throw new Error(`Login failed (${r.status}): ${r.body?.error || JSON.stringify(r.body)}`);
  return `Bearer ${r.body.token}`;
}

async function pushToStarlane(cfg, rows, authHeader) {
  const r = await apiRequest(cfg.starlane.apiBase, '/api/import/tally', { method: 'POST', authHeader, json: { vouchers: rows } });
  if (r.status !== 200) throw new Error(`Import failed (${r.status}): ${r.body?.error || JSON.stringify(r.body)}`);
  return r.body;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------
async function collectRows(cfg) {
  const all = [];
  let totalSkipped = 0;
  for (const company of cfg.companies.length ? cfg.companies : ['']) {
    const label = company || '(current company)';
    let xml;
    if (MODE === 'test') {
      xml = readFileSync(join(HERE, 'sample-daybook.xml'), 'utf-8');
      console.log('🧪 TEST MODE — reading sample-daybook.xml (Tally not contacted)');
    } else {
      process.stdout.write(`📥 Reading Day Book from Tally for ${label} ... `);
      xml = await fetchTallyDayBook(cfg, company);
      console.log('done.');
    }
    const vouchers = parseVouchers(xml);
    const { rows, skipped } = toApiVouchers(vouchers, cfg.voucherTypes);
    totalSkipped += skipped.length;
    all.push(...rows);
    const byType = rows.reduce((m, r) => ((m[r.type] = (m[r.type] || 0) + 1), m), {});
    console.log(`   ${label}: ${vouchers.length} vouchers → keeping ${rows.length} (${Object.entries(byType).map(([t, c]) => `${c} ${t}`).join(', ') || 'none'}), ${skipped.length} skipped.`);
  }
  return { rows: all, totalSkipped };
}

async function runOnce(cfg) {
  const { rows } = await collectRows(cfg);
  if (rows.length === 0) { console.log('ℹ️  No vouchers found in this date range. Nothing to send.'); return; }

  if (MODE === 'test' || MODE === 'dry-run') {
    console.log(`\n📋 ${rows.length} vouchers that WOULD be sent to Starlane:\n`);
    console.log(JSON.stringify(rows, null, 2));
    console.log(`\n(${MODE} mode — nothing was sent.)`);
    return;
  }

  process.stdout.write('🔑 Authenticating with Starlane ... ');
  const authHeader = await getAuthHeader(cfg);
  console.log('ok.');
  process.stdout.write(`⬆️  Sending ${rows.length} vouchers to Starlane ... `);
  const res = await pushToStarlane(cfg, rows, authHeader);
  console.log('done.');
  console.log(`\n✅ ${res.message || JSON.stringify(res.imported)}`);
  try { writeFileSync(join(HERE, 'state.json'), JSON.stringify({ lastSync: new Date().toISOString(), result: res.imported }, null, 2)); } catch {}
}

async function enroll(cfg) {
  if (!ENROLLMENT_CODE) throw new Error('Usage: node tally-sync.mjs --enroll <code>');
  process.stdout.write(`🔗 Claiming enrollment code against ${cfg.starlane.apiBase} ... `);
  const { deviceId, deviceSecret } = await claimEnrollment(cfg.starlane.apiBase, ENROLLMENT_CODE);
  writeFileSync(CREDENTIALS_PATH, JSON.stringify({ deviceId, deviceSecret, pairedAt: new Date().toISOString() }, null, 2));
  console.log('done.');
  console.log(`✅ Paired. Device credential stored in ${CREDENTIALS_PATH} — this machine can now sync without your Starlane password.`);
}

async function main() {
  const cfg = loadConfig();
  console.log(`\n★ Starlane Tally Connector v2 — mode: ${MODE}${ENROLLMENT_CODE ? ' (enrolling)' : ''}\n`);
  try {
    if (ENROLLMENT_CODE) {
      await enroll(cfg);
      if (MODE === 'test' || MODE === 'dry-run') return;
    }
    if (MODE === 'watch') {
      const everyMs = Math.max(1, cfg.intervalMinutes) * 60000;
      const loop = async () => {
        try { await runOnce({ ...cfg, toDate: today() }); }
        catch (e) { console.error('⚠️  Sync error:', e.message); }
        console.log(`\n⏳ Next sync in ${cfg.intervalMinutes} min. (Leave this window open.)\n`);
      };
      await loop();
      setInterval(loop, everyMs);
    } else {
      await runOnce(cfg);
    }
  } catch (e) {
    console.error('\n❌', e.message, '\n');
    process.exit(1);
  }
}

main();
