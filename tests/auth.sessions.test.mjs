// Revocable web sessions through the real server.js:
//   - every web sign-in gets a session row; the list shows them, marks the
//     current one, and never shows a full IP address
//   - ending one session stops that token on its next request
//   - logout ends the token's session, so a copied token stops working
//   - "sign out everywhere" ends every session, including old tokens issued
//     before session rows existed, and hands back a fresh one
//   - changing the password signs out every other device
//   - another account cannot end your sessions
//   - an organization's session length limit signs people out of its workspace
// Needs DATABASE_URL with migrations 072 to 077.
import { createRequire } from 'node:module';
import { makeChecker, openPool, seedUser, deleteUsers, startServer } from './helpers/httpHarness.mjs';

const require = createRequire(import.meta.url);
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { check, done } = makeChecker();
const pool = openPool();
const ready = await pool.query(`SELECT to_regclass('public.web_sessions') AS t`);
if (!ready.rows[0].t) { console.log('SKIP migration 077 not applied'); await pool.end(); process.exit(0); }

const port = 4700 + Math.floor(Math.random() * 300);
const srv = await startServer(port, { AUTH_FAILURE_LIMIT_PER_15M: '200', GROQ_API_KEY: '', GEMINI_API_KEY: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' });
const users = [];
const call = async (token, method, path, body, headers = {}) => {
  const r = await fetch(`${srv.base}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = {}; try { j = await r.json(); } catch { /* empty */ }
  return { http: r.status, ...j };
};
const login = (email, password, ua) => call(null, 'POST', '/api/auth/login', { email, password }, ua ? { 'User-Agent': ua } : {});
const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

try {
  const a = await seedUser(pool, 'sess-a'); users.push(a.id);
  const b = await seedUser(pool, 'sess-b'); users.push(b.id);
  let password = 'correct horse battery 42';
  await pool.query('UPDATE users SET password_hash = $2 WHERE id = ANY($1)', [[a.id, b.id], await bcrypt.hash(password, 4)]);

  const laptop = await login(a.email, password, CHROME);
  const phone = await login(a.email, password, IPHONE);
  check('each sign-in carries its own session id', !!jwt.decode(laptop.token).wsid && jwt.decode(laptop.token).wsid !== jwt.decode(phone.token).wsid);
  const legacy = a.token; // a token minted the old way, with no session row

  let r = await call(laptop.token, 'GET', '/api/auth/account-sessions');
  const mine = r.sessions || [];
  check('the list shows both browsers and marks the current one', r.http === 200 && mine.length === 2 && mine.filter((s) => s.current).length === 1 && mine.find((s) => s.current).id === jwt.decode(laptop.token).wsid, mine);
  check('devices are described from the browser, not shown raw', mine.some((s) => s.device === 'Chrome on Windows') && mine.some((s) => s.device === 'Safari on iOS'), mine.map((s) => s.device));
  check('no full IP address is stored or shown', mine.every((s) => !s.network || /\/(24|48)$/.test(s.network)), mine.map((s) => s.network));

  // End one session.
  const phoneId = jwt.decode(phone.token).wsid;
  r = await call(b.token, 'DELETE', `/api/auth/account-sessions/${phoneId}`);
  check("another account cannot end this account's session", r.http === 404, r);
  r = await call(phone.token, 'GET', '/api/auth/me');
  check('the phone session works before it is ended', r.http === 200);
  r = await call(laptop.token, 'DELETE', `/api/auth/account-sessions/${phoneId}`);
  check('ending a session from another device works', r.http === 200 && r.endedCurrent === false, r);
  r = await call(phone.token, 'GET', '/api/auth/me');
  check('the ended session is refused on its next request', r.http === 401 && r.code === 'SESSION_INVALID', r);

  // Logout.
  const extra = await login(a.email, password, CHROME);
  r = await call(extra.token, 'POST', '/api/auth/logout', {});
  r = await call(extra.token, 'GET', '/api/auth/me');
  check('after logout, a copy of the token no longer works', r.http === 401, r);

  // Sign out everywhere.
  r = await call(legacy, 'GET', '/api/auth/me');
  check('an old token without a session row still works before sign-out-everywhere', r.http === 200);
  await new Promise((res) => setTimeout(res, 1100)); // the cut-off is compared in whole seconds
  r = await call(laptop.token, 'POST', '/api/auth/account-sessions/sign-out-everywhere', {});
  check('sign out everywhere hands back a fresh session', r.http === 200 && !!r.token && r.user?.id === a.id && jwt.decode(r.token).wsid !== jwt.decode(laptop.token).wsid, r);
  const fresh = r.token;
  r = await call(laptop.token, 'GET', '/api/auth/me');
  check('the old session on this device is ended', r.http === 401, r);
  r = await call(legacy, 'GET', '/api/auth/me');
  check('old tokens without a session row are ended too', r.http === 401, r);
  r = await call(fresh, 'GET', '/api/auth/me');
  check('the fresh session works', r.http === 200, r);
  r = await call(fresh, 'GET', '/api/auth/account-sessions');
  check('only the fresh session is listed', r.sessions.length === 1 && r.sessions[0].current, r.sessions);

  // Changing the password signs out other devices.
  const other = await login(a.email, password, IPHONE);
  r = await call(fresh, 'POST', '/api/auth/change-password', { current_password: password, new_password: 'a new password 43' });
  check('a password change returns a fresh session for this browser', r.http === 200 && !!r.token, r);
  password = 'a new password 43';
  const afterChange = r.token;
  r = await call(other.token, 'GET', '/api/auth/me');
  check('other devices are signed out after a password change', r.http === 401, r);
  r = await call(afterChange, 'GET', '/api/auth/me');
  check('this browser stays signed in with the fresh session', r.http === 200, r);

  // Account B is untouched by all of this.
  r = await call(b.token, 'GET', '/api/auth/me');
  check("another account's sessions are unaffected", r.http === 200, r);

  // Organization session length.
  r = await call(afterChange, 'GET', '/api/platform/workspace');
  const orgId = r.organization?.id || r.workspace?.organization?.id || r.org?.id;
  check('the workspace loads', r.http === 200 && !!orgId, Object.keys(r));
  r = await call(afterChange, 'PUT', '/api/platform/security/session-policy', { maxHours: 9999 }, { 'X-Organization-Id': orgId });
  check('an out-of-range session length is refused', r.http === 400, r);
  r = await call(afterChange, 'PUT', '/api/platform/security/session-policy', { maxHours: 8 }, { 'X-Organization-Id': orgId });
  check('the owner sets an 8-hour session length', r.http === 200 && r.maxHours === 8, r);
  const wsid = jwt.decode(afterChange).wsid;
  const oldToken = jwt.sign({ userId: a.id, email: a.email, wsid, iat: Math.floor(Date.now() / 1000) - 9 * 3600 }, process.env.JWT_SECRET, { expiresIn: '30d' });
  r = await call(oldToken, 'GET', '/api/platform/agents', undefined, { 'X-Organization-Id': orgId });
  check('a 9-hour-old session is signed out of the workspace', r.http === 401 && r.code === 'SESSION_EXPIRED', r);
  r = await call(afterChange, 'GET', '/api/platform/workspace', undefined, { 'X-Organization-Id': orgId });
  check('a new session still works and the workspace reports the limit', r.http === 200 && JSON.stringify(r).includes('"sessionMaxHours":8'), r.http);
  r = await call(afterChange, 'PUT', '/api/platform/security/session-policy', { maxHours: null }, { 'X-Organization-Id': orgId });
  check('the limit can be removed', r.http === 200 && r.maxHours === null, r);
  const ev = await pool.query(`SELECT 1 FROM platform_audit_events WHERE organization_id = $1 AND action = 'security.session_policy_changed'`, [orgId]);
  check('session length changes are audited', ev.rows.length >= 2);
} catch (err) {
  check('test ran without throwing', false, err.stack);
} finally {
  await srv.stop();
  await deleteUsers(pool, users);
  await pool.end();
  done();
}
