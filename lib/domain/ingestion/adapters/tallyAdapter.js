// FILE: lib/domain/ingestion/adapters/tallyAdapter.js
// Tally as ONE source adapter under the generic adapter interface
// (see adapters/README.md). Wraps the existing, already-built pieces —
// this file adds no new Tally-talking logic, it only reshapes what already
// exists (scripts/tally/diagnose.js's probe pattern, tally-sync.mjs's XML
// request/parse logic ported to tallyVoucherParser.js) to conform to
// discover()/extract()/normalize().
//
// Scope of normalize(): PURCHASE vouchers with stock items only, mapped to
// the exact row shape lib/domain/ingestion/csvImport.js already consumes
// (sku, supplierName, supplierTaxId, quantity, unitPrice, currency,
// orderedAt, sourceRecordId). This is deliberate, not an oversight — Sales/
// Receipt/Payment vouchers target invoices/bank_transactions, which the
// current generic commit path does not write to. Those voucher kinds are
// handled by the separate lib/services/tallyImport.service.js (see that
// file's header and adapters/README.md "What is honestly NOT unified yet").
//
// Read-only guarantee preserved: every Tally request below has
// TALLYREQUEST=Export (never Import/Create/Alter/Delete). No credentials
// are involved in talking to Tally itself (it has none) and nothing is
// logged beyond host/port/company name.

const http = require('node:http');
const { parseVouchers } = require('./tallyVoucherParser');

function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function listOfCompaniesXML() {
  return `<ENVELOPE>
 <HEADER><TALLYREQUEST>Export</TALLYREQUEST></HEADER>
 <BODY><EXPORTDATA><REQUESTDESC><REPORTNAME>List of Companies</REPORTNAME></REQUESTDESC></EXPORTDATA></BODY>
</ENVELOPE>`;
}

function dayBookXML(fromDate, toDate, company) {
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
    ${company ? `<SVCURRENTCOMPANY>${escapeXml(company)}</SVCURRENTCOMPANY>` : ''}
   </STATICVARIABLES>
  </DESC>
 </BODY>
</ENVELOPE>`;
}

function postXml(host, port, xmlBody, timeoutMs = 5000) {
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

/**
 * discover({host, port}) -> { available, tallyDetected, failureMode, companies, connectionMethod }
 * Read-only probe, same pattern as scripts/tally/diagnose.js. Never
 * fabricates a positive result — if nothing answers, available: false.
 */
async function discover({ host = 'localhost', port = 9000, timeoutMs = 5000 } = {}) {
  const r = await postXml(host, port, listOfCompaniesXML(), timeoutMs);
  if (!r.ok) {
    return {
      available: false,
      tallyDetected: false,
      failureMode: r.failure === 'timeout' ? 'timeout' : 'connection-refused',
      companies: [],
      connectionMethod: `HTTP XML export interface, http://${host}:${port}`,
    };
  }
  const raw = r.body || '';
  const looksLikeTallyXml = /<ENVELOPE|<COMPANY|TallyMessage/i.test(raw);
  const companies = looksLikeTallyXml
    ? Array.from(raw.matchAll(/<COMPANY[^>]*NAME="([^"]*)"/gi)).map((m) => m[1])
    : [];
  return {
    available: looksLikeTallyXml,
    tallyDetected: true,
    failureMode: looksLikeTallyXml ? null : 'unexpected-response',
    companies,
    connectionMethod: `HTTP XML export interface, http://${host}:${port}`,
  };
}

/**
 * extract({host, port, company}, {from, to}) -> raw voucher objects
 * (Tally's own shape, as produced by tallyVoucherParser.parseVouchers).
 * `from`/`to` are yyyymmdd strings (Tally's native date format).
 */
async function extract({ host = 'localhost', port = 9000, company = '', timeoutMs = 20000 } = {}, { from, to }) {
  const r = await postXml(host, port, dayBookXML(from, to, company), timeoutMs);
  if (!r.ok) {
    throw new Error(`Tally extract failed: ${r.failure === 'timeout' ? 'timed out' : (r.message || 'connection error')}`);
  }
  return parseVouchers(r.body || '');
}

/**
 * normalize(rawVouchers) -> rows in csvImport.js's row shape, PURCHASE
 * vouchers with stock items only (see file header for why).
 */
function normalize(rawVouchers) {
  const rows = [];
  for (const v of rawVouchers || []) {
    const kind = String(v.type || '').toLowerCase();
    if (!kind.includes('purchase')) continue;
    if (!Array.isArray(v.items) || v.items.length === 0) continue;
    const supplierName = String(v.party || '').trim();
    if (!supplierName) continue;
    for (const item of v.items) {
      rows.push({
        sku: item.name,
        supplierName,
        supplierTaxId: null,
        quantity: item.qty,
        unitPrice: item.rate,
        currency: 'INR',
        orderedAt: v.date && /^\d{8}$/.test(v.date)
          ? `${v.date.slice(0, 4)}-${v.date.slice(4, 6)}-${v.date.slice(6, 8)}`
          : null,
        expectedAt: null,
        sourceRecordId: `TLY-${String(v.type).replace(/\s+/g, '')}-${v.voucherNo || 'NA'}-${v.date || ''}-${item.name}`,
      });
    }
  }
  return rows;
}

module.exports = { discover, extract, normalize };
