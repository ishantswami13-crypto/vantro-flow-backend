// Passkeys (WebAuthn) through the real server.js, with a software
// authenticator (P-256 key, "none" attestation) that builds the same bytes a
// browser and a phone or security key would:
//   - adding a passkey, then signing in with it and no password (the session
//     counts as two-step), and using it as the second step after a password
//   - the checks that must refuse: a reused or made-up challenge, another
//     origin, another relying party, no user verification, a bad signature,
//     a counter that goes backwards (a cloned key), another account's passkey
//     as a second step, a removed passkey
//   - a password-only session cannot add or remove a second factor once the
//     account has one
// Needs DATABASE_URL with migrations 072 to 077.
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import { makeChecker, openPool, seedUser, deleteUsers, startServer } from './helpers/httpHarness.mjs';

const require = createRequire(import.meta.url);
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { isoCBOR } = require('@simplewebauthn/server/helpers');

const { check, done } = makeChecker();
const pool = openPool();
const ready = await pool.query(`SELECT to_regclass('public.user_passkeys') AS t`);
if (!ready.rows[0].t) { console.log('SKIP migration 077 not applied'); await pool.end(); process.exit(0); }

const ORIGIN = 'http://localhost:3999';
const RP_ID = 'localhost';
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const sha = (b) => crypto.createHash('sha256').update(b).digest();

/** A software authenticator holding one discoverable credential. */
function authenticator(userId) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const credId = crypto.randomBytes(32);
  let counter = 0;
  const cose = isoCBOR.encode(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
  const flags = (uv) => 0x01 | (uv ? 0x04 : 0);
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  return {
    id: b64u(credId),
    register(options, { origin = ORIGIN, rpId = RP_ID } = {}) {
      const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin, crossOrigin: false }));
      const len = Buffer.alloc(2); len.writeUInt16BE(credId.length);
      const authData = Buffer.concat([sha(Buffer.from(rpId)), Buffer.from([flags(true) | 0x40]), u32(counter), Buffer.alloc(16), len, credId, Buffer.from(cose)]);
      const att = isoCBOR.encode(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
      return { id: b64u(credId), rawId: b64u(credId), type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: b64u(clientData), attestationObject: b64u(att), transports: ['internal'] } };
    },
    sign(options, { origin = ORIGIN, rpId = RP_ID, uv = true, counterOverride = null, corrupt = false } = {}) {
      counter = counterOverride ?? counter + 1;
      const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin, crossOrigin: false }));
      const authData = Buffer.concat([sha(Buffer.from(rpId)), Buffer.from([flags(uv)]), u32(counter)]);
      let signature = crypto.sign('sha256', Buffer.concat([authData, sha(clientData)]), privateKey);
      if (corrupt) signature = Buffer.from(signature.map((x, i) => (i === 10 ? x ^ 0xff : x)));
      return { id: b64u(credId), rawId: b64u(credId), type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: b64u(clientData), authenticatorData: b64u(authData), signature: b64u(signature), userHandle: b64u(Buffer.from(userId)) } };
    },
  };
}

const port = 4700 + Math.floor(Math.random() * 300);
const srv = await startServer(port, { PUBLIC_APP_URL: ORIGIN, AUTH_FAILURE_LIMIT_PER_15M: '200', OUTBOUND_CREDENTIALS_KEY: crypto.randomBytes(32).toString('base64'), GROQ_API_KEY: '', GEMINI_API_KEY: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' });
const users = [];
const call = async (token, method, path, body) => {
  const r = await fetch(`${srv.base}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = {}; try { j = await r.json(); } catch { /* empty */ }
  return { http: r.status, ...j };
};

try {
  const a = await seedUser(pool, 'pk-a'); users.push(a.id);
  const b = await seedUser(pool, 'pk-b'); users.push(b.id);
  const password = 'correct horse battery 42';
  await pool.query('UPDATE users SET password_hash = $2 WHERE id = ANY($1)', [[a.id, b.id], await bcrypt.hash(password, 4)]);
  const key = authenticator(a.id);
  const keyB = authenticator(b.id);

  // Sign in with a password (no second factor yet) to get a real session.
  let r = await call(null, 'POST', '/api/auth/login', { email: a.email, password });
  const pwToken = r.token;
  check('password sign-in gives a session while the account has no second factor', r.http === 200 && !!pwToken, r);

  r = await call(pwToken, 'GET', '/api/auth/passkeys');
  check('passkeys are available and the list starts empty', r.http === 200 && r.available === true && r.passkeys.length === 0 && r.rpID === RP_ID, r);

  // Registration.
  r = await call(pwToken, 'POST', '/api/auth/passkeys/options', {});
  check('registration options ask for a discoverable credential with user verification', r.http === 200 && r.options.rp.id === RP_ID && r.options.authenticatorSelection.residentKey === 'required' && r.options.authenticatorSelection.userVerification === 'required' && r.options.attestation === 'none', r.options);
  let opts = r.options;
  r = await call(pwToken, 'POST', '/api/auth/passkeys', { response: key.register(opts, { origin: 'https://evil.example' }), name: 'Laptop' });
  check('a registration from another origin is refused', r.http === 400, r);
  r = await call(pwToken, 'POST', '/api/auth/passkeys', { response: key.register(opts), name: 'Laptop' });
  check('the challenge was used up by the refused attempt (single use)', r.http === 400, r);
  r = await call(pwToken, 'POST', '/api/auth/passkeys/options', {});
  opts = r.options;
  r = await call(pwToken, 'POST', '/api/auth/passkeys', { response: key.register(opts), name: 'Laptop' });
  check('a passkey is added', r.http === 201 && r.passkey.name === 'Laptop' && !!r.token && r.user?.id === a.id, r);
  check('the session issued after adding it counts as two-step', jwt.decode(r.token).mfa === true);
  const pkToken = r.token;
  const row = (await pool.query('SELECT public_key, counter FROM user_passkeys WHERE user_id = $1', [a.id])).rows[0];
  check('only the public key is stored', row && Buffer.isBuffer(row.public_key) && row.public_key.length < 200);

  r = await call(pwToken, 'POST', '/api/auth/passkeys/options', {});
  check('a password-only session cannot add another second factor once one exists', r.http === 403 && r.code === 'REAUTH_REQUIRED', r);
  r = await call(pwToken, 'POST', '/api/auth/mfa/setup', {});
  check('nor start an authenticator app setup', r.http === 403 && r.code === 'REAUTH_REQUIRED', r);

  // Password sign-in now needs a second step, and offers the passkey.
  r = await call(null, 'POST', '/api/auth/login', { email: a.email, password });
  check('password sign-in now asks for a second step and offers a passkey', r.http === 200 && r.mfaRequired === true && r.methods.includes('passkey') && !r.token, r);
  const mfaToken = r.mfaToken;
  r = await call(null, 'POST', '/api/auth/mfa/passkey/options', { mfaToken });
  check('second-step options list only this account\'s passkeys', r.http === 200 && r.options.allowCredentials.length === 1 && r.options.allowCredentials[0].id === key.id && r.options.userVerification === 'required', r.options);
  opts = r.options;
  r = await call(null, 'POST', '/api/auth/mfa/passkey/verify', { mfaToken, response: key.sign(opts, { uv: false }) });
  check('an assertion without user verification is refused', r.http === 400, r);
  r = await call(null, 'POST', '/api/auth/mfa/passkey/options', { mfaToken });
  r = await call(null, 'POST', '/api/auth/mfa/passkey/verify', { mfaToken, response: key.sign(r.options) });
  check('the passkey completes the second step', r.http === 200 && !!r.token && jwt.decode(r.token).mfa === true, r);

  // Another account's passkey cannot be someone else's second step.
  r = await call(null, 'POST', '/api/auth/login', { email: b.email, password });
  const bToken = r.token;
  r = await call(bToken, 'POST', '/api/auth/passkeys/options', {});
  r = await call(bToken, 'POST', '/api/auth/passkeys', { response: keyB.register(r.options), name: 'B key' });
  check('a second account adds its own passkey', r.http === 201, r);
  r = await call(null, 'POST', '/api/auth/login', { email: a.email, password });
  const t2 = r.mfaToken;
  r = await call(null, 'POST', '/api/auth/mfa/passkey/options', { mfaToken: t2 });
  r = await call(null, 'POST', '/api/auth/mfa/passkey/verify', { mfaToken: t2, response: keyB.sign(r.options) });
  check("another account's passkey is refused as this account's second step", r.http === 400, r);

  // Passwordless sign-in.
  r = await call(null, 'POST', '/api/auth/passkey/options', {});
  check('passwordless options name no account', r.http === 200 && (!r.options.allowCredentials || r.options.allowCredentials.length === 0), r.options);
  opts = r.options;
  r = await call(null, 'POST', '/api/auth/passkey/verify', { response: key.sign(opts, { rpId: 'evil.example' }) });
  check('an assertion for another relying party is refused', r.http === 400, r);
  r = await call(null, 'POST', '/api/auth/passkey/verify', { response: key.sign(opts) });
  check('a used challenge cannot be signed again', r.http === 400, r);
  r = await call(null, 'POST', '/api/auth/passkey/options', {});
  r = await call(null, 'POST', '/api/auth/passkey/verify', { response: key.sign(r.options, { corrupt: true }) });
  check('a bad signature is refused', r.http === 400, r);
  r = await call(null, 'POST', '/api/auth/passkey/verify', { response: key.sign({ challenge: b64u(crypto.randomBytes(32)) }) });
  check('a challenge Starlane never issued is refused', r.http === 400, r);
  r = await call(null, 'POST', '/api/auth/passkey/options', {});
  r = await call(null, 'POST', '/api/auth/passkey/verify', { response: key.sign(r.options) });
  check('a passkey signs in without a password, and the session counts as two-step', r.http === 200 && r.user.id === a.id && jwt.decode(r.token).mfa === true, r);
  const signedIn = r.token;
  r = await call(signedIn, 'GET', '/api/auth/me');
  check('that session works on a protected route', r.http === 200, r.http);
  r = await call(null, 'POST', '/api/auth/passkey/options', {});
  r = await call(null, 'POST', '/api/auth/passkey/verify', { response: key.sign(r.options, { counterOverride: 1 }) });
  check('a counter that goes backwards (a cloned key) is refused', r.http === 400, r);

  // Managing passkeys.
  r = await call(pkToken, 'GET', '/api/auth/passkeys');
  const pk = r.passkeys[0];
  check('the list shows the passkey with its last use', r.passkeys.length === 1 && !!pk.lastUsedAt, r.passkeys);
  r = await call(pkToken, 'PATCH', `/api/auth/passkeys/${pk.id}`, { name: 'Work laptop' });
  check('a passkey can be renamed', r.http === 200);
  r = await call(bToken, 'DELETE', `/api/auth/passkeys/${pk.id}`);
  check("another account cannot remove this account's passkey", r.http === 403 || r.http === 404, r);
  r = await call(pwToken, 'DELETE', `/api/auth/passkeys/${pk.id}`);
  check('a password-only session cannot remove it', r.http === 403 && r.code === 'REAUTH_REQUIRED', r);
  r = await call(pkToken, 'DELETE', `/api/auth/passkeys/${pk.id}`);
  check('a two-step session can remove it', r.http === 200, r);
  r = await call(null, 'POST', '/api/auth/passkey/options', {});
  r = await call(null, 'POST', '/api/auth/passkey/verify', { response: key.sign(r.options) });
  check('a removed passkey no longer signs in', r.http === 400, r);
  r = await call(null, 'POST', '/api/auth/login', { email: a.email, password });
  check('with no second factor left, a password signs in directly again', r.http === 200 && !!r.token && !r.mfaRequired, r);
} catch (err) {
  check('test ran without throwing', false, err.stack);
} finally {
  await srv.stop();
  await deleteUsers(pool, users);
  await pool.end();
  done();
}
