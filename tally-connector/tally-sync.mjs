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
 *   node tally-sync.mjs --api <url> --enroll <code>
 *                                         # one-time: claim an enrollment code from the
 *                                         # "Connect Tally" button, store a device
 *                                         # credential in .vantro-device-credentials.json,
 *                                         # then run one sync
 *   node tally-sync.mjs --test      # offline: parse sample-daybook.xml, print payload (no Tally, no internet)
 *                                   # (--sample=<file> picks another day book, --opening=<file> adds
 *                                   #  a Bills Receivable export of bills unpaid before the range,
 *                                   #  --contacts=<file> a customer-ledger contacts export)
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
// --api <url>: the Starlane API to pair with. Remembered next to the device
// credential, so after pairing no config.json is needed at all.
const apiIndex = argv.indexOf('--api');
const API_OVERRIDE = apiIndex >= 0 ? argv[apiIndex + 1] : null;
if (API_OVERRIDE && !/^https?:\/\//.test(API_OVERRIDE)) {
  console.error('❌ --api must be a full URL, e.g. --api https://api.example.com');
  process.exit(1);
}

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

// API base precedence: --api flag > the one stored at pairing > config.json.
function withApiBase(cfg) {
  let stored = null;
  try { stored = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf-8')).apiBase || null; } catch { /* not paired */ }
  cfg.starlane.apiBase = API_OVERRIDE || stored || cfg.starlane.apiBase;
  return cfg;
}

function loadConfig() {
  const p = join(HERE, 'config.json');
  if (!existsSync(p)) {
    // No config.json is fine once paired (or while pairing): Tally defaults to
    // localhost:9000 and the API base comes from --api or the stored credential.
    if (MODE === 'test' || ENROLLMENT_CODE || existsSync(CREDENTIALS_PATH)) return withApiBase({ ...TEST_CONFIG, starlane: { ...TEST_CONFIG.starlane } });
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
    return withApiBase(cfg);
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

/** The day before a Tally date (YYYYMMDD): the "as of" date for bills still open when a sync range starts. */
function dayBefore(yyyymmdd) {
  const iso = tallyDateToISO(yyyymmdd);
  if (!iso) return yyyymmdd;
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

/** Tally's Bills Receivable report as of a date: every sales bill still unpaid then. */
function billsReceivableRequestXML(asOf, company) {
  const companyTag = company ? `<SVCURRENTCOMPANY>${escapeXml(company)}</SVCURRENTCOMPANY>` : '';
  return `<ENVELOPE>
 <HEADER>
  <VERSION>1</VERSION>
  <TALLYREQUEST>Export</TALLYREQUEST>
  <TYPE>Data</TYPE>
  <ID>Bills Receivable</ID>
 </HEADER>
 <BODY>
  <DESC>
   <STATICVARIABLES>
    <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
    <SVTODATE TYPE="Date">${asOf}</SVTODATE>
    ${companyTag}
   </STATICVARIABLES>
  </DESC>
 </BODY>
</ENVELOPE>`;
}

/**
 * Asks Tally for its customers' ledgers (everything under Sundry Debtors), with
 * only the name and phone fields — no addresses, tax numbers or balances.
 */
function debtorContactsRequestXML(company) {
  const companyTag = company ? `<SVCURRENTCOMPANY>${escapeXml(company)}</SVCURRENTCOMPANY>` : '';
  return `<ENVELOPE>
 <HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>StarlaneDebtorContacts</ID></HEADER>
 <BODY><DESC>
  <STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>${companyTag}</STATICVARIABLES>
  <TDL><TDLMESSAGE>
   <COLLECTION NAME="StarlaneDebtorContacts" ISMODIFY="No"><TYPE>Ledger</TYPE><CHILDOF>$$GroupSundryDebtors</CHILDOF><BELONGSTO>Yes</BELONGSTO><FETCH>NAME, LEDGERMOBILE, LEDGERPHONE</FETCH></COLLECTION>
  </TDLMESSAGE></TDL>
 </DESC></BODY>
</ENVELOPE>`;
}

function fetchTallyDayBook(cfg, company) {
  return tallyPost(cfg, dayBookRequestXML(cfg.fromDate, cfg.toDate, company));
}

function tallyPost(cfg, body) {
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
// Bill-wise details: "New Ref" raises a bill (with its credit period), "Agst Ref" settles one.
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad2 = (n) => String(n).padStart(2, '0');
/** Tally writes a credit period as "30 Days" or as the due date itself ("20-Sep-2026", "20260920"). */
function dueDateFrom(voucherDate, period) {
  if (!period) return null;
  const p = String(period).trim();
  const days = p.match(/^(\d+)\s*days?$/i);
  const start = tallyDateToISO(voucherDate);
  if (days) {
    if (!start) return null;
    const d = new Date(`${start}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + Number(days[1]));
    return d.toISOString().slice(0, 10);
  }
  return tallyAnyDateToISO(p);
}
/** A date as Tally writes it in reports: "20260920", "20-Sep-2026" or "20-Sep-26". */
function tallyAnyDateToISO(s) {
  const p = String(s || '').trim();
  if (/^\d{8}$/.test(p)) return tallyDateToISO(p);
  const m = p.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2}|\d{4})$/);
  const mon = m ? MONTHS[m[2].toLowerCase()] : undefined;
  if (m && mon) return `${m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])}-${pad2(mon)}-${pad2(Number(m[1]))}`;
  return null;
}
function billType(s) {
  const t = String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (t === 'new ref') return 'new';
  if (t === 'agst ref') return 'against';
  if (t === 'advance') return 'advance';
  if (t === 'on account') return 'on_account';
  return 'other';
}
const BILLS_RE = /<BILLALLOCATIONS\.LIST>[\s\S]*?<\/BILLALLOCATIONS\.LIST>/gi;

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
    let partyEntry = null;
    for (const e of entries) {
      // Read the entry's own tags with its bill allocations removed: Tally does not
      // guarantee the ledger AMOUNT comes before BILLALLOCATIONS.LIST.
      const own = e.replace(BILLS_RE, '');
      const ln = tag(own, 'LEDGERNAME');
      const amt = num(tag(own, 'AMOUNT'));
      if (party && ln && ln.toLowerCase() === party.toLowerCase()) partyEntry = e;
      if (!isNaN(amt)) {
        if (isNaN(maxAbs) || Math.abs(amt) > Math.abs(maxAbs)) maxAbs = amt;
        if (party && ln && ln.toLowerCase() === party.toLowerCase()) amount = amt;
      }
    }
    if (isNaN(amount)) amount = maxAbs;
    if (isNaN(amount)) amount = num(tag(b, 'AMOUNT'));

    const bills = [];
    for (const bl of (partyEntry || '').match(BILLS_RE) || []) {
      const name = tag(bl, 'NAME') || '';
      const amt = Math.abs(num(tag(bl, 'AMOUNT')));
      if (name && amt > 0) bills.push({ name, type: billType(tag(bl, 'BILLTYPE')), amount: amt, creditPeriod: tag(bl, 'BILLCREDITPERIOD') });
    }
    const raised = bills.find((x) => x.type === 'new' && x.creditPeriod);
    const dueDate = dueDateFrom(date, raised?.creditPeriod ?? null) ?? dueDateFrom(date, tag(b, 'BASICDUEDATEOFPYMT'));

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

    // Cancelled vouchers are kept (so Starlane can withdraw what it imported);
    // optional ones are memoranda, not in the books, and are never imported.
    const flag = (name) => /^yes$/i.test(tag(b, name) || '');
    out.push({
      type: decode(vchType), date, party, voucherNo: vchNo,
      amount: isNaN(amount) ? null : Math.abs(amount), items, dueDate, bills,
      cancelled: flag('ISCANCELLED'), optional: flag('ISOPTIONAL'),
    });
  }
  return out;
}

/** Keep only wanted voucher types with usable party + amount + date, as API payload rows. */
/**
 * Parses the Bills Receivable report. Tally writes each bill as a BILLFIXED
 * block (date, reference, party) followed by its pending amount (BILLCL) and
 * due date (BILLDUE). Debit amounts are negative in Tally XML, so a bill owed
 * to the business is negative; anything else (an advance or credit balance)
 * is counted in `credits`, never turned into a receivable.
 */
function parseOpeningBills(xml, asOf) {
  const bills = [];
  let credits = 0, unreadable = 0;
  const limit = tallyDateToISO(asOf);
  const parts = xml.split(/<BILLFIXED>/i).slice(1);
  for (const part of parts) {
    const end = part.search(/<\/BILLFIXED>/i);
    if (end < 0) { unreadable++; continue; }
    const fixed = part.slice(0, end);
    const rest = part.slice(end);
    const party = tag(fixed, 'BILLPARTY');
    const billName = tag(fixed, 'BILLREF');
    const billDate = tallyAnyDateToISO(tag(fixed, 'BILLDATE'));
    const amount = num(tag(rest, 'BILLCL'));
    if (!party || !billName || !billDate || isNaN(amount) || (limit && billDate > limit)) { unreadable++; continue; }
    if (amount >= 0) { credits++; continue; }
    bills.push({ party, billName, billDate, dueDate: tallyAnyDateToISO(tag(rest, 'BILLDUE')), pending: Math.round(-amount * 100) / 100 });
  }
  return { bills, credits, unreadable };
}
/** Opening bills as import rows: sent before the day book so later receipts find them. */
function openingBillVouchers(bills) {
  return bills.map((b) => ({ type: 'Opening Bill', date: b.billDate, party: b.party, voucherNo: b.billName, amount: b.pending, items: [], dueDate: b.dueDate, bills: [] }));
}

/** Customers' phone numbers from the debtor ledgers (mobile first). Starlane keeps only valid mobiles. */
function parseLedgerContacts(xml) {
  const out = [];
  for (const block of xml.match(/<LEDGER\b[^>]*>[\s\S]*?<\/LEDGER>/gi) || []) {
    const party = decode(block.match(/^<LEDGER\b[^>]*\bNAME="([^"]*)"/i)?.[1] || '') || tag(block, 'NAME');
    const phone = tag(block, 'LEDGERMOBILE') || tag(block, 'LEDGERPHONE');
    if (party && phone) out.push({ party, phone });
  }
  return out;
}

function toApiVouchers(vouchers, wantedTypes) {
  const wanted = wantedTypes.map((t) => t.toLowerCase());
  const rows = [];
  const skipped = [];
  for (const v of vouchers) {
    const typeMatch = wanted.some((w) => (v.type || '').toLowerCase().includes(w));
    const iso = tallyDateToISO(v.date);
    if (v.optional || !typeMatch || !v.party || !iso) { skipped.push(v); continue; }
    // A cancelled voucher keeps its type, number, date and party but usually loses
    // its amounts; it is sent so Starlane can withdraw what it imported before.
    if (v.cancelled) {
      rows.push({ type: v.type, date: iso, party: v.party, voucherNo: v.voucherNo, amount: v.amount || 0, items: [], dueDate: null, bills: [], cancelled: true });
      continue;
    }
    if (!v.amount || v.amount <= 0) { skipped.push(v); continue; }
    rows.push({ type: v.type, date: iso, party: v.party, voucherNo: v.voucherNo, amount: v.amount, items: v.items,
      dueDate: v.dueDate, bills: v.bills.map((x) => ({ name: x.name, type: x.type, amount: x.amount })) });
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

async function pushToStarlane(cfg, rows, authHeader, contacts = []) {
  const json = contacts.length ? { vouchers: rows, contacts } : { vouchers: rows };
  const r = await apiRequest(cfg.starlane.apiBase, '/api/import/tally', { method: 'POST', authHeader, json });
  if (r.status !== 200) throw new Error(`Import failed (${r.status}): ${r.body?.error || JSON.stringify(r.body)}`);
  return r.body;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------
async function collectRows(cfg) {
  const all = [];
  const contacts = [];
  let totalSkipped = 0;
  for (const company of cfg.companies.length ? cfg.companies : ['']) {
    const label = company || '(current company)';
    let xml;
    if (MODE === 'test') {
      const sample = [...args].find((a) => a.startsWith('--sample='))?.slice('--sample='.length) || 'sample-daybook.xml';
      xml = readFileSync(join(HERE, sample.replace(/[^\w.-]/g, '')), 'utf-8');
      console.log(`🧪 TEST MODE — reading ${sample} (Tally not contacted)`);
    } else {
      process.stdout.write(`📥 Reading Day Book from Tally for ${label} ... `);
      xml = await fetchTallyDayBook(cfg, company);
      console.log('done.');
    }
    // Bills still unpaid when the day book range starts (earlier years' sales).
    // Sent first so receipts in the range can settle them.
    const asOf = dayBefore(cfg.fromDate);
    let openingXml = null;
    if (MODE === 'test') {
      const opening = [...args].find((a) => a.startsWith('--opening='))?.slice('--opening='.length);
      if (opening) openingXml = readFileSync(join(HERE, opening.replace(/[^\w.-]/g, '')), 'utf-8');
    } else {
      process.stdout.write(`📥 Reading bills still unpaid on ${tallyDateToISO(asOf)} for ${label} ... `);
      try {
        openingXml = await tallyPost(cfg, billsReceivableRequestXML(asOf, company));
        const err = tag(openingXml, 'LINEERROR');
        if (err) { console.log(`Tally refused (${err}); continuing with the day book only.`); openingXml = null; } else console.log('done.');
      } catch (e) {
        console.log(`failed (${e.message}); continuing with the day book only.`);
      }
    }
    if (openingXml) {
      const { bills, credits, unreadable } = parseOpeningBills(openingXml, asOf);
      all.push(...openingBillVouchers(bills));
      console.log(`   ${label}: ${bills.length} bills unpaid on ${tallyDateToISO(asOf)}${credits ? `, ${credits} credit balance${credits === 1 ? '' : 's'} left out` : ''}${unreadable ? `, ${unreadable} lines not understood` : ''}.`);
    }

    // Customers' mobile numbers from their Tally ledgers (name and phone fields only),
    // so reminders can reach them. Starlane uses them only where it has no number.
    let contactsXml = null;
    if (MODE === 'test') {
      const file = [...args].find((a) => a.startsWith('--contacts='))?.slice('--contacts='.length);
      if (file) contactsXml = readFileSync(join(HERE, file.replace(/[^\w.-]/g, '')), 'utf-8');
    } else {
      try {
        contactsXml = await tallyPost(cfg, debtorContactsRequestXML(company));
        if (tag(contactsXml, 'LINEERROR')) contactsXml = null;
      } catch { /* optional: the sync goes on without them */ }
    }
    if (contactsXml) {
      const found = parseLedgerContacts(contactsXml);
      contacts.push(...found);
      console.log(`   ${label}: phone numbers on ${found.length} customer ledger${found.length === 1 ? '' : 's'}.`);
    }

    const vouchers = parseVouchers(xml);
    const { rows, skipped } = toApiVouchers(vouchers, cfg.voucherTypes);
    totalSkipped += skipped.length;
    all.push(...rows);
    const byType = rows.reduce((m, r) => ((m[r.type] = (m[r.type] || 0) + 1), m), {});
    console.log(`   ${label}: ${vouchers.length} vouchers → keeping ${rows.length} (${Object.entries(byType).map(([t, c]) => `${c} ${t}`).join(', ') || 'none'}), ${skipped.length} skipped.`);
  }
  return { rows: all, contacts, totalSkipped };
}

// Starlane takes at most 5000 vouchers per request; a year of a busy company's
// books is more than that, so it goes in chunks (the import is idempotent).
const CHUNK = 1000;

async function runOnce(cfg) {
  const { rows, contacts } = await collectRows(cfg);
  if (rows.length === 0) { console.log('ℹ️  No vouchers found in this date range. Nothing to send.'); return; }

  if (MODE === 'test' || MODE === 'dry-run') {
    console.log(`\n📋 ${rows.length} vouchers that WOULD be sent to Starlane:\n`);
    console.log(JSON.stringify(rows, null, 2));
    if (contacts.length) console.log(`\n📇 ${contacts.length} customer phone numbers that WOULD be sent: ${JSON.stringify(contacts)}`);
    console.log(`\n(${MODE} mode — nothing was sent.)`);
    return;
  }

  process.stdout.write('🔑 Authenticating with Starlane ... ');
  const authHeader = await getAuthHeader(cfg);
  console.log('ok.');
  const results = [];
  for (let i = 0; i < rows.length; i += CHUNK) {
    const part = rows.slice(i, i + CHUNK);
    process.stdout.write(`⬆️  Sending vouchers ${i + 1}–${i + part.length} of ${rows.length} to Starlane ... `);
    results.push(await pushToStarlane(cfg, part, authHeader, i === 0 ? contacts : []));
    console.log('done.');
  }
  for (const res of results) console.log(`✅ ${res.message || JSON.stringify(res.imported)}`);
  const imported = {};
  for (const res of results) for (const [k, v] of Object.entries(res.imported || {})) imported[k] = (imported[k] || 0) + (Number(v) || 0);
  try { writeFileSync(join(HERE, 'state.json'), JSON.stringify({ lastSync: new Date().toISOString(), result: imported }, null, 2)); } catch {}
}

async function enroll(cfg) {
  if (!ENROLLMENT_CODE) throw new Error('Usage: node tally-sync.mjs --api <url> --enroll <code>');
  process.stdout.write(`🔗 Claiming enrollment code against ${cfg.starlane.apiBase} ... `);
  const { deviceId, deviceSecret } = await claimEnrollment(cfg.starlane.apiBase, ENROLLMENT_CODE);
  // Owner-only file permissions: the secret is a long-lived, revocable credential.
  writeFileSync(CREDENTIALS_PATH, JSON.stringify({ deviceId, deviceSecret, apiBase: cfg.starlane.apiBase, pairedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
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
