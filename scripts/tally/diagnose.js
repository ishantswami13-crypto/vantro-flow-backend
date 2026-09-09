#!/usr/bin/env node
/**
 * Tally connection diagnostic.
 *
 * Read-only. Sends only Tally's documented "Export" XML requests (List of
 * Companies, then a Day Book export for a tiny date probe) — never a Create/
 * Alter/Delete request. Never touches Tally's data files directly.
 *
 * Run this ON THE MACHINE WHERE TALLY IS INSTALLED (ERP 9 or TallyPrime),
 * with Tally open and "Act as Server" / ODBC/XML server enabled in
 * Tally's own configuration (F12 > Advanced Configuration, or Gateway of
 * Tally > F11 in older ERP 9 builds). Default port is 9000.
 *
 * Usage: node scripts/tally/diagnose.js [--host localhost] [--port 9000]
 *
 * This script deliberately never fabricates a number. If something can't
 * be determined it prints "unknown" / "could not verify" rather than a
 * guess.
 */

const http = require('node:http');

const args = process.argv.slice(2);
function argVal(flag, fallback) {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}
const HOST = argVal('--host', 'localhost');
const PORT = Number(argVal('--port', '9000'));
const TIMEOUT_MS = Number(argVal('--timeout', '5000'));

function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Tally's documented "Export" envelope. This is a read-only report request —
// TALLYREQUEST is "Export", never "Import" — so Tally never writes anything
// back as a result of this script.
//
// CONFIRMED WORKING against a real TallyPrime Education instance
// (2026-09-09): the EXPORTDATA/REPORTNAME form below returns
// "Unknown Request, cannot be processed" on this build. The Collection-type
// request (TYPE=Collection, ID="List of Companies") is what this Tally
// version actually accepts and returns real <COMPANY NAME="..."> data for.
function listOfCompaniesXML() {
  return `<ENVELOPE>
 <HEADER>
  <VERSION>1</VERSION>
  <TALLYREQUEST>Export</TALLYREQUEST>
  <TYPE>Collection</TYPE>
  <ID>List of Companies</ID>
 </HEADER>
 <BODY>
  <DESC>
   <STATICVARIABLES>
    <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
   </STATICVARIABLES>
  </DESC>
 </BODY>
</ENVELOPE>`;
}

function dayBookProbeXML(fromDate, toDate) {
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
   </STATICVARIABLES>
  </DESC>
 </BODY>
</ENVELOPE>`;
}

function postXml(host, port, xmlBody, timeoutMs) {
  return new Promise((resolve) => {
    const body = Buffer.from(xmlBody, 'utf-8');
    const req = http.request(
      { host, port, method: 'POST', headers: { 'Content-Type': 'text/xml', 'Content-Length': body.length }, timeout: timeoutMs },
      (res) => {
        let data = '';
        res.setEncoding('utf-8');
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ ok: true, status: res.statusCode, body: data }));
      }
    );
    req.on('error', (e) => resolve({ ok: false, failure: 'connection', code: e.code, message: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, failure: 'timeout', message: `No response within ${timeoutMs}ms` }); });
    req.write(body);
    req.end();
  });
}

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1].trim() : null;
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

async function main() {
  console.log('=== Tally Connection Diagnostic ===');
  console.log(`Target: http://${HOST}:${PORT}  (Tally's standard XML/HTTP report interface)`);
  console.log('Method: POST of Tally-documented Export/Data envelopes (List of Companies, Day Book). Read-only — no Import/Create/Alter/Delete requests are ever sent.\n');

  const result = {
    tallyDetected: false,
    failureMode: null, // 'connection-refused' | 'timeout' | 'unexpected-response' | null
    version: 'unknown',
    companies: [],
    dataAvailable: 'unknown',
    connectionMethod: `HTTP XML export interface, http://${HOST}:${PORT}`,
    voucherCountsByType: {},
    readyToImport: false,
  };

  // Probe 1: List of Companies
  const r1 = await postXml(HOST, PORT, listOfCompaniesXML(), TIMEOUT_MS);
  if (!r1.ok) {
    result.failureMode = r1.failure === 'timeout' ? 'timeout' : 'connection-refused';
    console.log(`Tally detected: NO`);
    console.log(`Failure mode: ${result.failureMode === 'timeout' ? 'Tally did not respond in time (process may be running but not serving XML, or a firewall is blocking it)' : 'Connection refused (nothing is listening on this host:port — Tally is not running here, or its XML/HTTP server is not enabled)'}`);
    console.log(`Raw error: ${r1.code || ''} ${r1.message || ''}`);
    printFinalReport(result);
    return;
  }

  result.tallyDetected = true;
  console.log(`Tally detected: YES (HTTP ${r1.status})`);

  const raw1 = r1.body || '';
  const looksLikeTallyXml = /<ENVELOPE|<COMPANY|TallyMessage/i.test(raw1);
  if (!looksLikeTallyXml) {
    result.failureMode = 'unexpected-response';
    console.log('Something answered on this port, but the response does not look like a Tally XML export. This may not be Tally, or the XML/HTTP server is disabled while something else occupies the port.');
    console.log('First 300 chars of response:', raw1.slice(0, 300));
  } else {
    // Try to pull company name(s) out of whatever came back.
    // Real responses look like: <COMPANY NAME="STARLANEHQ.P(LTD)" ...>
    // or a nested <NAME TYPE="String">...</NAME> — match both forms.
    const namesFromAttr = [...raw1.matchAll(/<COMPANY\s+NAME="([^"]+)"/gi)].map((m) => m[1].trim());
    const namesFromTag = [...raw1.matchAll(/<NAME(?:\s+[^>]*)?>([^<]+)<\/NAME>/gi)].map((m) => m[1].trim());
    result.companies = [...new Set([...namesFromAttr, ...namesFromTag])].filter(Boolean);
    console.log(`Companies found in response: ${result.companies.length ? result.companies.join(', ') : 'none parsed (response did not contain a recognizable <NAME> list — could not verify)'}`);
  }

  // Version info: Tally's plain XML export does not reliably include a
  // product/version tag in this report. Do not guess — report "unknown"
  // unless we actually see one.
  const verTag = tag(raw1, 'VERSION') || tag(raw1, 'TALLYPRODUCT') || tag(raw1, 'PRODUCTNAME');
  result.version = verTag || 'unknown (Tally\'s Export XML for List of Companies does not carry a version tag; would need a different report or the ODBC provider string to get this reliably)';

  // Probe 2: tiny Day Book probe (today only) to check voucher-report access,
  // without pulling a real historical range.
  const d = today();
  const r2 = await postXml(HOST, PORT, dayBookProbeXML(d, d), TIMEOUT_MS);
  if (!r2.ok) {
    console.log(`\nDay Book probe: FAILED (${r2.failure}) — company/voucher data access could not be verified even though the base connection responded.`);
    result.dataAvailable = 'could not verify (Day Book probe failed)';
  } else {
    const voucherBlocks = (r2.body.match(/<VOUCHER\b/gi) || []).length;
    result.dataAvailable = voucherBlocks > 0 ? `yes — ${voucherBlocks} voucher(s) found for today (${d})` : `Day Book report responded but returned 0 vouchers for today (${d}) — this only tells you about today, not historical data`;
    console.log(`\nDay Book probe (today, ${d}): responded, ${voucherBlocks} voucher block(s) in today's Day Book.`);
    result.voucherCountsByType = 'not computed for a single-day probe — run the connector\'s --dry-run for a real date range to get per-type counts';
  }

  result.readyToImport = result.tallyDetected && looksLikeTallyXml;
  printFinalReport(result);
}

function printFinalReport(r) {
  console.log('\n--- Summary ---');
  console.log(`Tally detected:      ${r.tallyDetected ? 'YES' : 'NO'}`);
  console.log(`Failure mode:        ${r.failureMode || 'n/a'}`);
  console.log(`Version:             ${r.version}`);
  console.log(`Company(ies):        ${r.companies.length ? r.companies.join(', ') : 'none'}`);
  console.log(`Data available:      ${r.dataAvailable}`);
  console.log(`Connection method:   ${r.connectionMethod}`);
  console.log(`Ready to import:     ${r.readyToImport ? 'YES' : 'NO'}`);
  if (!r.tallyDetected) {
    console.log('\nNext step: run this script ON THE COMPUTER WHERE TALLY IS ACTUALLY INSTALLED AND OPEN,');
    console.log('with Tally\'s XML/HTTP server enabled (Gateway of Tally > F1/F11/F12 depending on');
    console.log('version — look for "Enable ODBC"/"Act as Server on Port 9000" style settings).');
  }
}

main();
