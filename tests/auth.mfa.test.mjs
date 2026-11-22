// Two-step sign-in (TOTP + recovery codes) and an organization's MFA rule,
// through the real server.js: password sign-in returns a challenge instead of
// a session, the challenge token is not a session, codes cannot be replayed,
// recovery codes work once, wrong codes lock, and the organization rule
// blocks platform routes for sessions without a second factor.
// Needs DATABASE_URL with migrations 072 to 076.
import { createRequire } from 'node:module';
import { makeChecker, openPool, seedUser, deleteUsers, startServer } from './helpers/httpHarness.mjs';

const require = createRequire(import.meta.url);
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const totp = require('../lib/auth/totp');

const { check, done } = makeChecker();
const pool = openPool();
const ready = await pool.query(`SELECT to_regclass('public.user_mfa') AS t`);
if (!ready.rows[0].t) { console.log('SKIP migration 076 not applied'); process.exit(0); }

// ── TOTP itself (RFC 6238 appendix B vector, SHA-1, T = 59s -> 94287082) ──
const rfcSecret = totp.base32Encode(Buffer.from('12345678901234567890'));
check('RFC 6238 vector at T=59', totp.codeAt(rfcSecret, 59_000) === '287082');
check('RFC 6238 vector at T=1111111109', totp.codeAt(rfcSecret, 1111111109_000) === '081804');
check('base32 round trip', totp.base32Decode(rfcSecret).toString() === '12345678901234567890');
check('a code one step old still matches (clock drift)', totp.matchStep(rfcSecret, totp.codeAt(rfcSecret, 59_000), { nowMs: 89_000 }) === 1);
check('a code three steps old does not match', totp.matchStep(rfcSecret, totp.codeAt(rfcSecret, 59_000), { nowMs: 149_000 }) === null);
check('non-numeric input never matches', totp.matchStep(rfcSecret, 'abcdef') === null);

const port = 4700 + Math.floor(Math.random() * 300);
const key = require('crypto').randomBytes(32).toString('base64');
const srv = await startServer(port, { AUTH_FAILURE_LIMIT_PER_15M: '200', OUTBOUND_CREDENTIALS_KEY: key, GROQ_API_KEY: '', GEMINI_API_KEY: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' });
const users = [];
const call = async (token, method, path, body) => {
  const r = await fetch(`${srv.base}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = {}; try { j = await r.json(); } catch { /* empty */ }
  return { http: r.status, ...j };
};
// The next TOTP step's code, so a test never reuses a step already spent.
let clockSkew = 0;
const freshCode = (secret) => { clockSkew += 30_000; return totp.codeAt(secret, Date.now() + Math.min(clockSkew, 30_000)); };

try {
  const a = await seedUser(pool, 'mfa-a'); users.push(a.id);
  const b = await seedUser(pool, 'mfa-b'); users.push(b.id);
  const password = 'correct horse battery 42';
  await pool.query('UPDATE users SET password_hash = $2 WHERE id = $1', [a.id, await bcrypt.hash(password, 4)]);

  // Before MFA: password sign-in gives a session.
  let r = await call(null, 'POST', '/api/auth/login', { email: a.email, password });
  check('password sign-in without MFA gives a session', r.http === 200 && !!r.token && !r.mfaRequired, r);

  // Setup.
  r = await call(a.token, 'GET', '/api/auth/mfa');
  check('status says off and can be enabled', r.http === 200 && r.enabled === false && r.canEnable === true, r);
  r = await call(a.token, 'POST', '/api/auth/mfa/setup', {});
  check('setup returns a secret and an otpauth URI', r.http === 200 && /^[A-Z2-7]{32}$/.test(r.secret) && r.otpauthUri.startsWith('otpauth://totp/'), r);
  const secret = r.secret;
  const stored = (await pool.query('SELECT pending_secret_enc, secret_enc FROM user_mfa WHERE user_id = $1', [a.id])).rows[0];
  check('the secret is stored encrypted, never in plain text', stored.pending_secret_enc && !stored.pending_secret_enc.includes(secret) && !stored.secret_enc);
  r = await call(a.token, 'POST', '/api/auth/mfa/confirm', { code: '000000' === totp.codeAt(secret) ? '111111' : '000000' });
  check('a wrong code does not turn it on', r.http === 400, r);
  r = await call(a.token, 'POST', '/api/auth/mfa/confirm', { code: totp.codeAt(secret) });
  check('confirming with a real code turns it on and returns 10 recovery codes', r.http === 200 && r.recoveryCodes?.length === 10 && !!r.token, r);
  const recovery = r.recoveryCodes;
  check('the confirm session carries the mfa mark', jwt.decode(r.token).mfa === true);
  const hashes = (await pool.query('SELECT recovery_hashes FROM user_mfa WHERE user_id = $1', [a.id])).rows[0].recovery_hashes;
  check('recovery codes are stored only as hashes', hashes.length === 10 && !hashes.some((h) => recovery.some((c) => h.includes(c.replace('-', '')))));

  // Sign-in now needs the second step.
  r = await call(null, 'POST', '/api/auth/login', { email: a.email, password });
  check('password sign-in now returns a challenge, not a session', r.http === 200 && r.mfaRequired === true && !!r.mfaToken && !r.token && !r.user, r);
  let mfaToken = r.mfaToken;
  r = await call(mfaToken, 'GET', '/api/auth/me');
  check('the challenge token is not a session', r.http === 401, r);
  const forged = jwt.sign({ sub: a.id, purpose: 'mfa' }, process.env.JWT_SECRET, { expiresIn: '5m' });
  r = await call(null, 'POST', '/api/auth/mfa/verify', { mfaToken: forged, code: totp.codeAt(secret) });
  check('a challenge signed with the session key is refused', r.http === 401, r);
  r = await call(null, 'POST', '/api/auth/mfa/verify', { mfaToken, code: '12345' });
  check('a malformed code is refused', r.http === 400, r);

  // The step used at confirm cannot be used again; take the next step's code.
  const next = freshCode(secret);
  r = await call(null, 'POST', '/api/auth/mfa/verify', { mfaToken, code: next });
  check('the right code gives a session marked mfa', r.http === 200 && !!r.token && jwt.decode(r.token).mfa === true && r.method === 'totp', r);
  const mfaSession = r.token;
  r = await call(null, 'POST', '/api/auth/mfa/verify', { mfaToken, code: next });
  check('the same code cannot be used twice', r.http === 400, r);

  r = await call(null, 'POST', '/api/auth/login', { email: a.email, password });
  mfaToken = r.mfaToken;
  r = await call(null, 'POST', '/api/auth/mfa/verify', { mfaToken, code: recovery[0].toUpperCase() });
  check('a recovery code works (any case)', r.http === 200 && r.method === 'recovery' && r.recoveryCodesLeft === 9, r);
  r = await call(null, 'POST', '/api/auth/mfa/verify', { mfaToken, code: recovery[0] });
  check('a recovery code works only once', r.http === 400, r);

  // Lockout after five wrong codes.
  r = await call(null, 'POST', '/api/auth/login', { email: a.email, password });
  mfaToken = r.mfaToken;
  let last;
  for (let i = 0; i < 5; i += 1) last = await call(null, 'POST', '/api/auth/mfa/verify', { mfaToken, code: String(100000 + i) === totp.codeAt(secret) ? '999999' : String(100000 + i) });
  check('the fifth wrong code locks the second step', last.http === 429 && last.code === 'MFA_LOCKED', last);
  r = await call(null, 'POST', '/api/auth/mfa/verify', { mfaToken, code: recovery[1] });
  check('while locked even a right code is refused', r.http === 429, r);
  await pool.query('UPDATE user_mfa SET locked_until = NULL WHERE user_id = $1', [a.id]);

  // Organization rule.
  r = await call(a.token, 'GET', '/api/platform/workspace');
  const orgId = r.organization?.id;
  check('workspace reports the sign-in security state', r.http === 200 && r.security?.mfaRequiredFor === 'none' && r.security.mfaEnabled === true, r);
  r = await call(a.token, 'PUT', '/api/platform/security/mfa-policy', { requiredFor: 'everyone' });
  check('an owner whose session has no second factor cannot turn the rule on', r.http === 403 && r.code === 'MFA_REQUIRED', r);
  r = await call(mfaSession, 'PUT', '/api/platform/security/mfa-policy', { requiredFor: 'everyone' });
  check('with an MFA session the owner can require it for everyone', r.http === 200 && r.requiredFor === 'everyone', r);

  await pool.query(`INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'member')`, [orgId, b.id]);
  const hdr = (t) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${t}`, 'X-Starlane-Org': orgId });
  let res = await fetch(`${srv.base}/api/platform/agents`, { headers: hdr(b.token) });
  let j = await res.json();
  check('a member without MFA is blocked from platform routes', res.status === 403 && j.code === 'MFA_REQUIRED', j);
  res = await fetch(`${srv.base}/api/platform/workspace`, { headers: hdr(b.token) });
  j = await res.json();
  check('but can still load the workspace, which says why', res.status === 200 && j.security.mfaSatisfied === false && j.security.mfaRequiredFor === 'everyone', j.security);
  res = await fetch(`${srv.base}/api/platform/agents`, { headers: hdr(a.token) });
  check('the owner\'s old password-only session is blocked too', res.status === 403);
  res = await fetch(`${srv.base}/api/platform/agents`, { headers: hdr(mfaSession) });
  check('the owner\'s MFA session works', res.status === 200);
  r = await call(mfaSession, 'PUT', '/api/platform/security/mfa-policy', { requiredFor: 'none' });
  check('the rule can be switched off again', r.http === 200 && r.requiredFor === 'none', r);
  const ev = await pool.query(`SELECT COUNT(*)::int AS n FROM platform_audit_events WHERE organization_id = $1 AND action = 'security.mfa_policy_changed'`, [orgId]);
  check('rule changes are audited', ev.rows[0].n === 2, ev.rows[0]);

  // Turning it off needs a current code. (Forget the spent steps so the test can use the current one.)
  await pool.query('UPDATE user_mfa SET last_step = 0 WHERE user_id = $1', [a.id]);
  r = await call(mfaSession, 'POST', '/api/auth/mfa/disable', { code: '000000' === totp.codeAt(secret) ? '111111' : '000000' });
  check('turning MFA off needs a valid code', r.http === 400, r);
  r = await call(mfaSession, 'POST', '/api/auth/mfa/disable', { code: totp.codeAt(secret) });
  check('with a valid code MFA turns off', r.http === 200 && r.enabled === false, r);
  r = await call(null, 'POST', '/api/auth/login', { email: a.email, password });
  check('and password sign-in gives a session again', r.http === 200 && !!r.token && !r.mfaRequired, r);
} catch (err) {
  check('test ran without throwing', false, err.message);
  console.error(srv.logs().slice(-3000));
} finally {
  srv.stop();
  await deleteUsers(pool, users);
  await pool.end();
  done();
}
