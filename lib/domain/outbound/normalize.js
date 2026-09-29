'use strict';
// lib/domain/outbound/normalize.js
// Normalisation used for deduplication: one person, one address, one company.
//
// Email: lower-cased and trimmed. For the consumer Gmail domains only, dots
// in the local part and "+tag" suffixes are aliases of the same inbox, so they
// are folded. Corporate domains are left exactly as written: many mail
// servers treat dots and "+" as significant, and guessing would merge
// different people.

const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

const COMPANY_SUFFIXES = [
  'private limited', 'pvt ltd', 'pvt. ltd.', 'pvt. ltd', 'pvt', 'limited', 'ltd', 'llp', 'llc', 'inc', 'incorporated',
  'corp', 'corporation', 'co', 'company', 'gmbh', 'ag', 'sa', 'sas', 'bv', 'nv', 'plc', 'pte', 'pty', 'kk', 'oy', 'ab', 'as', 'spa', 'srl',
];

function normalizeEmail(raw) {
  const s = String(raw || '').trim().toLowerCase();
  const at = s.lastIndexOf('@');
  if (at <= 0 || at === s.length - 1) return null;
  let local = s.slice(0, at);
  let domain = s.slice(at + 1).replace(/\.+$/, '');
  if (GMAIL_DOMAINS.has(domain)) {
    local = local.split('+')[0].replace(/\./g, '');
    domain = 'gmail.com';
  }
  return `${local}@${domain}`;
}

function emailDomain(raw) {
  const n = normalizeEmail(raw);
  return n ? n.slice(n.lastIndexOf('@') + 1) : null;
}

function normalizeDomain(raw) {
  if (!raw) return null;
  let s = String(raw).trim().toLowerCase();
  s = s.replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').split('/')[0].split('?')[0].split('#')[0];
  s = s.replace(/\.+$/, '');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s)) return null;
  return s;
}

function normalizeCompany(raw) {
  let s = String(raw || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
  s = s.replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const suf of COMPANY_SUFFIXES) {
      const clean = suf.replace(/[^a-z ]/g, '').trim();
      if (s.endsWith(` ${clean}`)) { s = s.slice(0, -clean.length - 1).trim(); changed = true; }
    }
  }
  return s;
}

// "Dr. Anita  K. Sharma" -> "anita k sharma". Titles are dropped so the
// same person imported twice with and without a title is one person.
function normalizePerson(raw) {
  let s = String(raw || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
  s = s.replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/^(mr|mrs|ms|dr|prof|shri|smt|sri)\s+/, '');
  return s;
}

module.exports = { normalizeEmail, emailDomain, normalizeDomain, normalizeCompany, normalizePerson, GMAIL_DOMAINS };
