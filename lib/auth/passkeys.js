'use strict';
// Passkeys (WebAuthn / FIDO2): sign in with a phone, laptop or security key
// instead of a password, or use one as the second step after a password.
//
// Verification is done by @simplewebauthn/server. Rules applied here:
//   - user verification is required (fingerprint, face or device PIN), so a
//     passkey is both something you have and something you are or know;
//     a passkey sign-in therefore counts as two-step (session mfa: true)
//   - every challenge is random, stored by SHA-256 hash, single-use and
//     valid for 5 minutes; a second-step challenge is bound to the account
//   - the origin and relying party ID must match the Starlane web app
//     (PUBLIC_APP_URL, or WEBAUTHN_ORIGINS / WEBAUTHN_RP_ID)
//   - a signature counter that goes backwards (a cloned key) is refused
//   - no attestation is requested; passkeys are not tied to a vendor
// Before migration 077 is applied, passkeys report as unavailable.

const crypto = require('crypto');
const { PlatformError, badRequest, notFound } = require('../platform/errors');

// Loaded on first use so the server still starts on a Node version the
// library does not support (it needs Node 20+); passkeys then answer 503.
let waLib = null;
function waModule() {
  if (waLib) return waLib;
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) throw new PlatformError(503, 'PASSKEYS_UNAVAILABLE', `Passkeys need Node.js 20 or newer on the server (this one runs ${process.versions.node}).`);
  waLib = require('@simplewebauthn/server');
  return waLib;
}

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_PASSKEYS = 10;
const MISSING = new Set(['42P01', '42703']);
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function unavailable() { return new PlatformError(503, 'MIGRATION_PENDING', 'Passkeys need database migration 077, which is not applied on this server yet.'); }
async function q(db, sql, params) {
  try { return await db.query(sql, params); } catch (err) { if (MISSING.has(err.code)) throw unavailable(); throw err; }
}

/** Relying party settings from the web app's address. */
function relyingParty(appBase) {
  const origins = (process.env.WEBAUTHN_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const appOrigin = (() => { try { return new URL(appBase).origin; } catch { return null; } })();
  const all = [...new Set([...(origins.length ? origins : []), ...(appOrigin ? [appOrigin] : [])])];
  const rpID = process.env.WEBAUTHN_RP_ID || (appOrigin ? new URL(appOrigin).hostname : 'localhost');
  return { rpID, rpName: 'Starlane', origins: all };
}

async function saveChallenge(db, challenge, purpose, userId = null) {
  await q(db, 'DELETE FROM webauthn_challenges WHERE expires_at < NOW()');
  await q(db, 'INSERT INTO webauthn_challenges (challenge_hash, user_id, purpose, expires_at) VALUES ($1,$2,$3,$4)',
    [sha256(challenge), userId, purpose, new Date(Date.now() + CHALLENGE_TTL_MS)]);
}

/** Reads the challenge the browser signed and consumes it (single use). */
async function takeChallenge(db, response, purpose, userId = null) {
  let challenge;
  try { challenge = JSON.parse(Buffer.from(String(response?.response?.clientDataJSON || ''), 'base64url').toString('utf8')).challenge; } catch { /* below */ }
  if (typeof challenge !== 'string' || challenge.length < 16 || challenge.length > 200) throw badRequest('The passkey response is malformed.');
  const { rows } = await q(db, 'DELETE FROM webauthn_challenges WHERE challenge_hash = $1 AND purpose = $2 RETURNING user_id, expires_at', [sha256(challenge), purpose]);
  const row = rows[0];
  if (!row || new Date(row.expires_at) < new Date()) throw badRequest('This passkey request expired or was already used. Try again.');
  if (userId && row.user_id !== userId) throw badRequest('This passkey request belongs to another sign-in.');
  return challenge;
}

async function list(db, userId) {
  try {
    const { rows } = await db.query('SELECT id, name, device_type, backed_up, transports, created_at, last_used_at FROM user_passkeys WHERE user_id = $1 ORDER BY created_at', [userId]);
    return rows.map((r) => ({ id: r.id, name: r.name, syncs: r.device_type === 'multiDevice' || r.backed_up, transports: r.transports, createdAt: r.created_at, lastUsedAt: r.last_used_at }));
  } catch (err) { if (MISSING.has(err.code)) return null; throw err; }
}

async function count(db, userId) {
  try { return (await db.query('SELECT COUNT(*)::int AS n FROM user_passkeys WHERE user_id = $1', [userId])).rows[0].n; } catch (err) { if (MISSING.has(err.code)) return 0; throw err; }
}

async function registrationOptions(db, rp, user) {
  const { rows } = await q(db, 'SELECT credential_id, transports FROM user_passkeys WHERE user_id = $1', [user.id]);
  if (rows.length >= MAX_PASSKEYS) throw badRequest(`An account can have up to ${MAX_PASSKEYS} passkeys. Remove one first.`);
  const options = await waModule().generateRegistrationOptions({
    rpName: rp.rpName, rpID: rp.rpID,
    userName: user.email || user.phone || user.id, userDisplayName: user.business_name || user.email || 'Starlane account',
    userID: new TextEncoder().encode(user.id),
    attestationType: 'none',
    excludeCredentials: rows.map((r) => ({ id: r.credential_id, transports: r.transports })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  });
  await saveChallenge(db, options.challenge, 'register', user.id);
  return options;
}

async function finishRegistration(db, rp, user, response, name) {
  const expectedChallenge = await takeChallenge(db, response, 'register', user.id);
  let v;
  try {
    v = await waModule().verifyRegistrationResponse({ response, expectedChallenge, expectedOrigin: rp.origins, expectedRPID: rp.rpID, requireUserVerification: true });
  } catch (err) { throw badRequest(`The passkey could not be registered: ${String(err.message).slice(0, 160)}`); }
  if (!v.verified) throw badRequest('The passkey could not be verified.');
  const { credential, credentialDeviceType, credentialBackedUp } = v.registrationInfo;
  const label = String(name || '').trim().slice(0, 60) || (credentialDeviceType === 'multiDevice' ? 'Synced passkey' : 'Security key');
  try {
    const { rows } = await db.query(
      `INSERT INTO user_passkeys (user_id, credential_id, public_key, counter, transports, device_type, backed_up, name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [user.id, credential.id, Buffer.from(credential.publicKey), credential.counter || 0, credential.transports || [], credentialDeviceType, !!credentialBackedUp, label]);
    return { id: rows[0].id, name: label };
  } catch (err) {
    if (err.code === '23505') throw badRequest('This passkey is already registered.');
    if (MISSING.has(err.code)) throw unavailable();
    throw err;
  }
}

/** purpose 'signin' (any account, discoverable credential) or 'second_step' (this account's passkeys). */
async function authenticationOptions(db, rp, { purpose = 'signin', userId = null } = {}) {
  let allowCredentials;
  if (purpose === 'second_step') {
    const { rows } = await q(db, 'SELECT credential_id, transports FROM user_passkeys WHERE user_id = $1', [userId]);
    if (!rows.length) throw notFound('A passkey on this account');
    allowCredentials = rows.map((r) => ({ id: r.credential_id, transports: r.transports }));
  }
  const options = await waModule().generateAuthenticationOptions({ rpID: rp.rpID, userVerification: 'required', allowCredentials });
  await saveChallenge(db, options.challenge, purpose, purpose === 'second_step' ? userId : null);
  return options;
}

/** Verifies an assertion. Returns the account id it belongs to. */
async function finishAuthentication(db, rp, response, { purpose = 'signin', userId = null } = {}) {
  const expectedChallenge = await takeChallenge(db, response, purpose, purpose === 'second_step' ? userId : null);
  const credId = String(response?.id || '');
  if (!/^[A-Za-z0-9_-]{16,1400}$/.test(credId)) throw badRequest('The passkey response is malformed.');
  const { rows } = await q(db, 'SELECT * FROM user_passkeys WHERE credential_id = $1', [credId]);
  const pk = rows[0];
  if (!pk) throw badRequest('This passkey is not registered with Starlane. It may have been removed.');
  if (purpose === 'second_step' && pk.user_id !== userId) throw badRequest('This passkey belongs to another account.');
  let v;
  try {
    v = await waModule().verifyAuthenticationResponse({
      response, expectedChallenge, expectedOrigin: rp.origins, expectedRPID: rp.rpID, requireUserVerification: true,
      credential: { id: pk.credential_id, publicKey: new Uint8Array(pk.public_key), counter: Number(pk.counter), transports: pk.transports },
    });
  } catch (err) { throw badRequest(`The passkey was refused: ${String(err.message).slice(0, 160)}`); }
  if (!v.verified) throw badRequest('The passkey was refused.');
  const next = v.authenticationInfo.newCounter;
  await db.query('UPDATE user_passkeys SET counter = GREATEST(counter, $2), last_used_at = NOW() WHERE id = $1', [pk.id, next]);
  return pk.user_id;
}

async function remove(db, userId, id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw notFound('That passkey');
  const { rowCount } = await q(db, 'DELETE FROM user_passkeys WHERE id = $1 AND user_id = $2', [id, userId]);
  if (!rowCount) throw notFound('That passkey');
}

async function rename(db, userId, id, name) {
  const label = String(name || '').trim().slice(0, 60);
  if (!label) throw badRequest('Enter a name.');
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw notFound('That passkey');
  const { rowCount } = await q(db, 'UPDATE user_passkeys SET name = $3 WHERE id = $1 AND user_id = $2', [id, userId, label]);
  if (!rowCount) throw notFound('That passkey');
}

module.exports = { relyingParty, list, count, registrationOptions, finishRegistration, authenticationOptions, finishAuthentication, remove, rename };
