'use strict';
// lib/domain/outbound/credentials.js
// Provider credentials at rest: AES-256-GCM with a key from
// OUTBOUND_CREDENTIALS_KEY (32 bytes, hex or base64). Without the key,
// credentials cannot be stored at all; nothing falls back to plaintext.
// Decrypted values are never logged, returned by an API, or put in errors.

const crypto = require('crypto');

function key() {
  const raw = process.env.OUTBOUND_CREDENTIALS_KEY || '';
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

function decrypt(s) {
  const k = key();
  if (!k || !s) return null;
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

// Scrubs anything token-shaped from a string before it is logged or stored.
function redact(s) {
  return String(s || '')
    .replace(/(ya29\.[A-Za-z0-9._-]+)/g, '[redacted-token]')
    .replace(/(1\/\/[A-Za-z0-9._-]{20,})/g, '[redacted-token]')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1[redacted]')
    .replace(/("?(access_token|refresh_token|client_secret)"?\s*[:=]\s*"?)[^"&\s,}]+/gi, '$1[redacted]');
}

module.exports = { available, encrypt, decrypt, redact };
