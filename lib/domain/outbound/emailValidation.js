'use strict';
// lib/domain/outbound/emailValidation.js
// Address checks that run before a contact can become eligible.
//
// Syntax alone is not enough: the domain must publish MX records (or, per
// RFC 5321, an A/AAAA record as the implicit MX). Role and generic inboxes
// (info@, support@...) are refused for cold outreach, because nobody in
// particular owns them. This never guesses or "tests" an address by sending
// to it, and it never claims an address is deliverable: a pass means only
// "well-formed, and the domain accepts mail".

const dns = require('dns').promises;
const { normalizeEmail } = require('./normalize');

const GENERIC_LOCALS = new Set([
  'info', 'support', 'help', 'sales', 'contact', 'contactus', 'hello', 'admin', 'office', 'enquiry', 'enquiries', 'inquiry',
  'marketing', 'hr', 'careers', 'jobs', 'noreply', 'no-reply', 'donotreply', 'billing', 'accounts', 'service', 'team', 'mail',
  'webmaster', 'postmaster', 'abuse', 'privacy', 'legal', 'press', 'media', 'feedback', 'customerservice', 'customercare',
]);

const DISPOSABLE = new Set(['mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail.com', 'yopmail.com', 'trashmail.com']);

// Pragmatic RFC 5322 subset: dot-atom local part, LDH domain labels, a TLD
// of at least two letters. Quoted local parts and IP literals are refused;
// they do not occur in legitimate business contact data.
const LOCAL_RE = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/i;
const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;

function checkSyntax(raw) {
  const s = String(raw || '').trim();
  if (!s) return { ok: false, reason: 'EMPTY' };
  if (s.length > 254) return { ok: false, reason: 'TOO_LONG' };
  const at = s.lastIndexOf('@');
  if (at <= 0) return { ok: false, reason: 'NO_AT_SIGN' };
  const local = s.slice(0, at);
  const domain = s.slice(at + 1).toLowerCase();
  if (local.length > 64 || !LOCAL_RE.test(local)) return { ok: false, reason: 'BAD_LOCAL_PART' };
  const labels = domain.split('.');
  if (labels.length < 2 || !labels.every((l) => LABEL_RE.test(l))) return { ok: false, reason: 'BAD_DOMAIN' };
  if (!/^[a-z]{2,63}$/.test(labels[labels.length - 1])) return { ok: false, reason: 'BAD_TLD' };
  // Reserved names never receive mail. Fixture runs (tests, the readiness
  // exercise) use *.invalid on purpose so nothing could ever be delivered;
  // they opt in with OUTBOUND_FIXTURE_MODE, which production ignores.
  const fixtureMode = process.env.OUTBOUND_FIXTURE_MODE === 'true' && process.env.NODE_ENV !== 'production';
  if (/\.(invalid|test|example|localhost)$/.test(domain) || domain === 'example.com') {
    if (!(fixtureMode && domain.endsWith('.invalid'))) return { ok: false, reason: 'RESERVED_DOMAIN' };
  }
  return { ok: true, local: local.toLowerCase(), domain };
}

function isGenericLocal(local) {
  const base = String(local || '').toLowerCase().split('+')[0];
  return GENERIC_LOCALS.has(base);
}

async function withTimeout(p, ms) {
  let t;
  try {
    return await Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(Object.assign(new Error('DNS timeout'), { code: 'ETIMEOUT' })), ms); })]);
  } finally { clearTimeout(t); }
}

/**
 * Full check. `resolver` is injectable ({ resolveMx, resolve4 }) so tests do
 * not depend on the network. DNS failure that is not NXDOMAIN/NODATA is
 * reported as UNKNOWN, never as a pass.
 */
async function validateAddress(raw, { resolver = dns, timeoutMs = 4000, allowGeneric = false } = {}) {
  const syn = checkSyntax(raw);
  if (!syn.ok) return { ok: false, status: 'INVALID', reason: syn.reason };
  if (DISPOSABLE.has(syn.domain)) return { ok: false, status: 'INVALID', reason: 'DISPOSABLE_DOMAIN' };
  if (!allowGeneric && isGenericLocal(syn.local)) return { ok: false, status: 'GENERIC', reason: 'GENERIC_INBOX' };
  let mx = [];
  try {
    mx = await withTimeout(resolver.resolveMx(syn.domain), timeoutMs);
  } catch (err) {
    if (['ENOTFOUND', 'ENODATA'].includes(err.code)) {
      try {
        const a = await withTimeout(resolver.resolve4(syn.domain), timeoutMs);
        if (a && a.length) return { ok: true, status: 'DOMAIN_ACCEPTS_MAIL', reason: 'A_RECORD_IMPLICIT_MX', normalized: normalizeEmail(raw) };
      } catch { /* fall through */ }
      return { ok: false, status: 'INVALID', reason: 'DOMAIN_HAS_NO_MAIL_SERVER' };
    }
    return { ok: false, status: 'UNKNOWN', reason: `DNS_${err.code || 'ERROR'}` };
  }
  if (mx.length === 1 && (mx[0].exchange === '' || mx[0].exchange === '.')) return { ok: false, status: 'INVALID', reason: 'NULL_MX' };
  if (!mx.length) return { ok: false, status: 'INVALID', reason: 'DOMAIN_HAS_NO_MAIL_SERVER' };
  return { ok: true, status: 'DOMAIN_ACCEPTS_MAIL', reason: 'MX', normalized: normalizeEmail(raw) };
}

module.exports = { checkSyntax, validateAddress, isGenericLocal, GENERIC_LOCALS };
