'use strict';
// Time-based one-time passwords (RFC 6238, HMAC-SHA1, 6 digits, 30 seconds),
// the codes every authenticator app (Google Authenticator, Microsoft
// Authenticator, 1Password, Authy …) shows. Node's crypto only.

const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const DIGITS = 6;

function base32Encode(buf) {
  let bits = 0; let value = 0; let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str || '').toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0; let value = 0; const out = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('invalid base32');
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

/** A new 160-bit secret, base32 (what authenticator apps expect). */
function newSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function hotp(secretBase32, counter) {
  const key = base32Decode(secretBase32);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', key).update(msg).digest();
  const off = h[h.length - 1] & 0x0f;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
}

const stepAt = (nowMs) => Math.floor(nowMs / 1000 / STEP_SECONDS);

function codeAt(secretBase32, nowMs = Date.now()) {
  return hotp(secretBase32, stepAt(nowMs));
}

/**
 * The time step a code matches, allowing one step of clock drift either way,
 * or null. The caller refuses any step at or before the last one used, so a
 * code cannot be replayed.
 */
function matchStep(secretBase32, code, { nowMs = Date.now(), window = 1 } = {}) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const now = stepAt(nowMs);
  for (let d = -window; d <= window; d += 1) {
    const expected = hotp(secretBase32, now + d);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(c))) return now + d;
  }
  return null;
}

/** otpauth:// URI for a QR code. */
function otpauthUri(secretBase32, { issuer = 'Starlane', account }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

module.exports = { newSecret, codeAt, matchStep, otpauthUri, base32Encode, base32Decode, hotp, STEP_SECONDS };
