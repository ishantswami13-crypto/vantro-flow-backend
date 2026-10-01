// Verifies "Sign in with Google" and "Sign in with Apple" ID tokens (RS256 JWTs)
// against each provider's published keys, with Node's crypto only. Returns the
// verified email; a token that is unsigned, expired, for another app, from
// another issuer, or without a verified email is rejected.
'use strict';
const crypto = require('crypto');

const PROVIDERS = {
  google: {
    jwks: 'https://www.googleapis.com/oauth2/v3/certs',
    issuers: ['https://accounts.google.com', 'accounts.google.com'],
    audience: () => process.env.GOOGLE_CLIENT_ID,
  },
  apple: {
    jwks: 'https://appleid.apple.com/auth/keys',
    issuers: ['https://appleid.apple.com'],
    audience: () => process.env.APPLE_CLIENT_ID,
  },
};

class IdTokenError extends Error {}

const keyCache = new Map(); // provider -> { at, keys: Map(kid -> KeyObject) }
const KEY_TTL_MS = 60 * 60 * 1000;

async function loadKeys(provider, fetchImpl, force) {
  const hit = keyCache.get(provider);
  if (hit && !force && Date.now() - hit.at < KEY_TTL_MS) return hit.keys;
  const res = await fetchImpl(PROVIDERS[provider].jwks);
  if (!res.ok) throw new IdTokenError(`could not load ${provider} keys (${res.status})`);
  const { keys = [] } = await res.json();
  const map = new Map();
  for (const jwk of keys) {
    if (jwk.kty !== 'RSA' || !jwk.kid) continue;
    try { map.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' })); } catch { /* skip malformed key */ }
  }
  keyCache.set(provider, { at: Date.now(), keys: map });
  return map;
}

const b64json = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
const truthy = (v) => v === true || v === 'true';

async function verifyIdToken(provider, token, { fetchImpl = fetch, now = Date.now() } = {}) {
  const cfg = PROVIDERS[provider];
  if (!cfg) throw new IdTokenError('unknown provider');
  const audience = cfg.audience();
  if (!audience) throw new IdTokenError(`${provider} sign-in is not configured`);
  const parts = typeof token === 'string' ? token.split('.') : [];
  if (parts.length !== 3) throw new IdTokenError('malformed token');
  let header, payload;
  try { header = b64json(parts[0]); payload = b64json(parts[1]); } catch { throw new IdTokenError('malformed token'); }
  if (header.alg !== 'RS256' || !header.kid) throw new IdTokenError('unsupported token algorithm');

  let keys = await loadKeys(provider, fetchImpl, false);
  if (!keys.has(header.kid)) keys = await loadKeys(provider, fetchImpl, true); // keys rotate
  const key = keys.get(header.kid);
  if (!key) throw new IdTokenError('unknown signing key');
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'));
  if (!ok) throw new IdTokenError('bad signature');

  const nowSec = Math.floor(now / 1000);
  if (!cfg.issuers.includes(payload.iss)) throw new IdTokenError('wrong issuer');
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(audience)) throw new IdTokenError('token is for another app');
  if (typeof payload.exp !== 'number' || payload.exp < nowSec - 60) throw new IdTokenError('token expired');
  if (typeof payload.iat === 'number' && payload.iat > nowSec + 300) throw new IdTokenError('token issued in the future');
  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
  if (!email || !truthy(payload.email_verified)) throw new IdTokenError('no verified email on this account');
  return { email, name: typeof payload.name === 'string' ? payload.name : null, sub: String(payload.sub || '') };
}

const isConfigured = (provider) => !!PROVIDERS[provider]?.audience();

module.exports = { verifyIdToken, isConfigured, IdTokenError, _keyCache: keyCache };
