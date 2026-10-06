'use strict';
// Source authority for receivables: when the same bill arrives from Tally and
// from a file (CSV/XLSX), it must stay ONE invoice, and Tally wins because it
// is the book of record (the same rule the Bridge states). Any disagreement
// between the two copies is kept and shown, never silently dropped.
//
// Tally stores a bill as "TLY-<TYPE>-<voucherNo>-<YYYYMMDD>" with the voucher
// number stripped of punctuation; a file keeps the number as typed ("S/201").
// Both reduce to the same key: party + bill number without punctuation.

const SUPERSEDED_NOTE = 'Replaced by the Tally copy of this bill';

function partyKey(name) {
  return String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function isTallyRef(no) {
  return /^TLY-/i.test(String(no || ''));
}

// "TLY-SALES-S201-20260901" -> "s201"; "TLY-OPENINGB-S201-20260901" -> "s201";
// "S/201" -> "s201".
function billNo(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  if (isTallyRef(s)) s = s.replace(/^TLY-[^-]*-/i, '').replace(/-\d{8}$/, '');
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function billKey(party, number) {
  const n = billNo(number);
  return n ? `${partyKey(party)}|${n}` : null;
}

// The bill's date: from the Tally ref's YYYYMMDD suffix, else the stored
// invoice date. Tally restarts voucher numbers every financial year, so the
// same number on a different date is a different bill.
function billDate(number, invoiceDate) {
  const m = String(number || '').match(/^TLY-.*-(\d{4})(\d{2})(\d{2})$/i);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = String(invoiceDate || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

// Index of known bills for "is this the same bill?" checks.
function billIndex(rows) {
  const byKey = new Map();
  for (const r of rows) {
    const k = billKey(r.customer_name, r.invoice_number);
    if (!k) continue;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push({ row: r, date: billDate(r.invoice_number, r.invoice_date) });
  }
  return {
    // Same party and number, and the same date when both dates are known.
    find(customerName, number, invoiceDate) {
      const k = billKey(customerName, number);
      if (!k || !byKey.has(k)) return null;
      const d = billDate(number, invoiceDate);
      const hit = byKey.get(k).find((x) => !d || !x.date || x.date === d);
      return hit ? hit.row : null;
    },
    add(row) {
      const k = billKey(row.customer_name, row.invoice_number);
      if (!k) return;
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push({ row, date: billDate(row.invoice_number, row.invoice_date) });
    },
    remove(row) {
      const k = billKey(row.customer_name, row.invoice_number);
      if (k && byKey.has(k)) byKey.set(k, byKey.get(k).filter((x) => x.row !== row));
    },
  };
}

function inr(n) {
  return `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;
}

// What the file copy said that Tally does not agree with, in words.
function disagreement(fileRow, tallyRow) {
  const diffs = [];
  if (Math.abs(Number(fileRow.invoice_amount) - Number(tallyRow.invoice_amount)) >= 1) {
    diffs.push(`the file said ${inr(fileRow.invoice_amount)}, Tally says ${inr(tallyRow.invoice_amount)}`);
  }
  if (String(fileRow.payment_status) === 'Paid' && String(tallyRow.payment_status) !== 'Paid') {
    diffs.push('the file marked it Paid, Tally shows it unpaid');
  }
  return diffs;
}

function supersededNote(fileRow, tallyRow) {
  const diffs = disagreement(fileRow, tallyRow);
  return `${SUPERSEDED_NOTE} (${tallyRow.invoice_number}); Tally is the book of record.${diffs.length ? ` Disagreement: ${diffs.join('; ')}.` : ''}`;
}

module.exports = { partyKey, isTallyRef, billNo, billKey, billDate, billIndex, disagreement, supersededNote, SUPERSEDED_NOTE };
