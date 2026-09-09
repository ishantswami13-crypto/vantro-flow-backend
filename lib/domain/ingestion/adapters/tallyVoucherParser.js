// FILE: lib/domain/ingestion/adapters/tallyVoucherParser.js
// Pure XML-string -> JS-object parsing for Tally Day Book exports.
//
// This is a deliberate CommonJS port of the parsing functions
// (tag/num/qtyNum/decode/parseVouchers) from the standalone end-user script
// `tally-connector/tally-sync.mjs` (feature/tally-full-ingestion branch).
// It is NOT a require() of that script — tally-sync.mjs is intentionally a
// zero-dependency ES module meant to run standalone on a shop PC that may
// not have this repo's node_modules, so it cannot import from here, and
// this backend package cannot import an .mjs script from outside its tree
// either. The algorithm is copied verbatim (same regexes, same field
// names) so behaviour stays identical; this file exists so the backend
// (tests, the Tally adapter) can parse Tally XML offline without shelling
// out to the connector script.
//
// Pure functions only — no network, no file I/O, no DB.

function decode(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decode(m[1].trim()) : null;
}

function num(v) {
  if (v === null || v === undefined) return NaN;
  return parseFloat(String(v).replace(/[₹,\s]/g, ''));
}

function qtyNum(v) {
  if (v === null || v === undefined) return NaN;
  // Tally quantities often look like "10 Nos" or "-5 Kg" — take the leading number.
  const m = String(v).trim().match(/-?[\d.]+/);
  return m ? parseFloat(m[0]) : NaN;
}

function tallyDateToISO(yyyymmdd) {
  const s = String(yyyymmdd || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return null;
}

/**
 * Parse a Tally Day Book XML export into an array of voucher objects:
 *   { type, date (yyyymmdd), party, voucherNo, amount, items: [{name, qty, rate}] }
 * Never throws on malformed input — a voucher block that doesn't parse is
 * simply skipped, matching tally-sync.mjs's behaviour.
 */
function parseVouchers(xml) {
  const vouchers = [];
  const blocks = xml.match(/<VOUCHER\b[\s\S]*?<\/VOUCHER>/gi) || [];
  for (const b of blocks) {
    try {
      const vchType = tag(b, 'VOUCHERTYPENAME') || (b.match(/<VOUCHER[^>]*VCHTYPE="([^"]*)"/i)?.[1] ?? '');
      const date = tag(b, 'DATE');
      const party = tag(b, 'PARTYLEDGERNAME') || tag(b, 'PARTYNAME') || '';
      const vchNo = tag(b, 'VOUCHERNUMBER') || tag(b, 'MASTERID') || '';
      const amountRaw = tag(b, 'AMOUNT');
      const amount = num(amountRaw);

      const items = [];
      const entryBlocks = b.match(/<ALLINVENTORYENTRIES\.LIST>[\s\S]*?<\/ALLINVENTORYENTRIES\.LIST>/gi) || [];
      for (const e of entryBlocks) {
        const name = tag(e, 'STOCKITEMNAME');
        const qty = qtyNum(tag(e, 'ACTUALQTY') || tag(e, 'BILLEDQTY'));
        const rate = num(tag(e, 'RATE'));
        if (name && !isNaN(qty) && qty > 0) items.push({ name, qty, rate: isNaN(rate) ? 0 : Math.abs(rate) });
      }

      vouchers.push({
        type: vchType, date, party, voucherNo: vchNo,
        amount: isNaN(amount) ? null : Math.abs(amount), items,
      });
    } catch (_e) {
      // skip unparseable voucher block, matches tally-sync.mjs
    }
  }
  return vouchers;
}

module.exports = { parseVouchers, tallyDateToISO, tag, num, qtyNum, decode };
