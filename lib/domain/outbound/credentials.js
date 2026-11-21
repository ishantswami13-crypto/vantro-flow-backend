'use strict';
// lib/domain/outbound/credentials.js
// Provider credentials at rest: AES-256-GCM with a key from
// OUTBOUND_CREDENTIALS_KEY (32 bytes, hex or base64). Without the key,
// credentials cannot be stored at all; nothing falls back to plaintext.
// Decrypted values are never logged, returned by an API, or put in errors.

const crypto = require('crypto');

// Key rotation: set the new key as OUTBOUND_CREDENTIALS_KEY and the old one as
// OUTBOUND_CREDENTIALS_KEY_PREVIOUS. Values written under the old key still
// decrypt; `node scripts/rotate-credentials-key.js` re-encrypts them under the
// new key, after which the previous key can be removed.
function key(name = 'OUTBOUND_CREDENTIALS_KEY') {
  const raw = process.env[name] || '';
  if (!raw) return null;
  let buf = null;
  if (/^[0-9a-f]{64}$/i.test(raw)) buf = Buffer.from(raw, 'hex');
  else { try { buf = Buffer.from(raw, 'base64'); } catch { buf = null; } }
  return buf && buf.length === 32 ? buf : null;
}

function available() { return !!key(); }

function encrypt(obj) {
  const k = key();
  if (!k) throw Object.assign(new Error('OUTBOUND_CREDENTIALS_KEY is not set (32 bytes, hex or base64); provider credentials cannot be stored'), { status: 503 });
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', k, iv);
  const enc = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}

function decryptWith(k, s) {
  const [v, iv, tag, data] = String(s).split(':');
  if (v !== 'v1') return null;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8'));
  } catch {
    return null;
  }
}

function decrypt(s) {
  if (!s) return null;
  const k = key();
  const current = k ? decryptWith(k, s) : null;
  if (current !== null) return current;
  const prev = key('OUTBOUND_CREDENTIALS_KEY_PREVIOUS');
  return prev ? decryptWith(prev, s) : null;
}

/**
 * For rotation: 'current' when the value decrypts with the current key,
 * 'previous' when only the previous key opens it, 'unreadable' otherwise.
 */
function keyStatus(s) {
  if (!s) return 'unreadable';
  const k = key();
  if (k && decryptWith(k, s) !== null) return 'current';
  const prev = key('OUTBOUND_CREDENTIALS_KEY_PREVIOUS');
  if (prev && decryptWith(prev, s) !== null) return 'previous';
  return 'unreadable';
}

// Scrubs anything token-shaped from a string before it is logged or stored.
function redact(s) {
  return String(s || '')
    .replace(/(ya29\.[A-Za-z0-9._-]+)/g, '[redacted-token]')
    .replace(/(1\/\/[A-Za-z0-9._-]{20,})/g, '[redacted-token]')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1[redacted]')
    .replace(/("?(access_token|refresh_token|client_secret)"?\s*[:=]\s*"?)[^"&\s,}]+/gi, '$1[redacted]');
}

module.exports = { available, encrypt, decrypt, keyStatus, redact };
