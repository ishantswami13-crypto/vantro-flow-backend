'use strict';
// Revocable web sessions.
//
// A web sign-in used to be a 30-day JWT that nothing could end early. Now
// each one gets a row in web_sessions and its id travels in the token as
// `wsid`, so a person can see where they are signed in and end any of those
// sessions; the next request with that token is refused (within CACHE_MS).
//
// users.sessions_valid_after covers what a row cannot: tokens issued before
// this table existed. "Sign out everywhere", a password change and a password
// reset set it, so every older token stops working too.
//
// Before migration 077 is applied, create() returns null (the token simply
// has no wsid) and check() lets every token through, as before.


const TTL_DAYS = 30;
const CACHE_MS = 15 * 1000;
const STALE_OK_MS = 10 * 60 * 1000;
const TOUCH_MS = 5 * 60 * 1000;
const MISSING = new Set(['42P01', '42703']);

const cache = new Map(); // key -> { ok, at }

function ipPrefix(ip) {
  const s = String(ip || '').replace(/^::ffff:/, '');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(s)) return `${s.split('.').slice(0, 3).join('.')}.0/24`;
  if (s.includes(':')) return `${s.split(':').slice(0, 3).join(':')}::/48`;
  return null;
}

function describeAgent(ua) {
  const s = String(ua || '');
  if (!s) return null;
  const browser = /Edg\//.test(s) ? 'Edge' : /OPR\//.test(s) ? 'Opera' : /Chrome\//.test(s) ? 'Chrome' : /Firefox\//.test(s) ? 'Firefox' : /Safari\//.test(s) ? 'Safari' : null;
  const os = /iPhone|iPad/.test(s) ? 'iOS' : /Android/.test(s) ? 'Android' : /Windows/.test(s) ? 'Windows' : /Mac OS X/.test(s) ? 'macOS' : /Linux/.test(s) ? 'Linux' : null;
  return [browser, os].filter(Boolean).join(' on ') || s.slice(0, 60);
}

/** Records a new web session. Returns its id, or null before migration 077. */
async function create(pool, user, { method = 'password', mfa = false, sso = null, userAgent = null, ip = null } = {}) {
  if (!pool) return null;
  try {
    const { rows } = await pool.query(
      `INSERT INTO web_sessions (user_id, method, mfa, sso_org, user_agent, ip_prefix, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6, NOW() + make_interval(days => $7)) RETURNING id`,
      [user.id, String(method).slice(0, 20), !!mfa, sso || null, userAgent ? String(userAgent).slice(0, 300) : null, ipPrefix(ip), TTL_DAYS]);
    return rows[0].id;
  } catch (err) {
    if (MISSING.has(err.code)) return null;
    throw err;
  }
}

/**
 * Whether a decoded web token may still be used. Native-app tokens (sid) are
 * checked by lib/auth/sessions.js instead.
 */
async function check(pool, claims) {
  if (!pool || !claims) return true;
  const userId = claims.userId || claims.id;
  const key = claims.wsid ? `s:${claims.wsid}` : `u:${userId}`;
  const hit = cache.get(key);
  let state = hit && Date.now() - hit.at < CACHE_MS ? hit : null;
  if (!state) {
    try {
      if (claims.wsid) {
        const { rows } = await pool.query(
          'SELECT revoked_at, expires_at, last_seen_at FROM web_sessions WHERE id = $1 AND user_id = $2', [claims.wsid, userId]);
        const row = rows[0];
        const ok = !!row && !row.revoked_at && new Date(row.expires_at) > new Date();
        state = { ok, at: Date.now() };
        if (ok && Date.now() - new Date(row.last_seen_at).getTime() > TOUCH_MS) {
          pool.query('UPDATE web_sessions SET last_seen_at = NOW() WHERE id = $1', [claims.wsid]).catch(() => {});
        }
      } else {
        const { rows } = await pool.query('SELECT sessions_valid_after FROM users WHERE id = $1', [userId]);
        state = { ok: true, at: Date.now(), validAfter: rows[0]?.sessions_valid_after || null };
      }
    } catch (err) {
      if (MISSING.has(err.code) || err.code === '22P02') return true; // before 077, or a non-uuid test id
      if (hit && Date.now() - hit.at < STALE_OK_MS) state = hit; // brief database outage
      else throw err;
    }
    cache.set(key, state);
  }
  if (!state.ok) return false;
  // A token with a session row is ended through its row; the cut-off is for
  // older tokens without one (and avoids comparing two clocks for new ones).
  if (!claims.wsid && state.validAfter && typeof claims.iat === 'number' && claims.iat * 1000 < new Date(state.validAfter).getTime() - 1000) return false;
  return true;
}

function forget(prefix) {
  for (const k of cache.keys()) if (k.startsWith(prefix)) cache.delete(k);
}

/** Web and app sessions that are still open, newest first. */
async function list(pool, userId, { currentWsid = null, currentSid = null } = {}) {
  const out = [];
  try {
    const { rows } = await pool.query(
      `SELECT id, method, mfa, sso_org, user_agent, ip_prefix, created_at, last_seen_at, expires_at FROM web_sessions
        WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > NOW() ORDER BY last_seen_at DESC LIMIT 50`, [userId]);
    for (const r of rows) {
      out.push({ id: r.id, kind: 'web', current: r.id === currentWsid, device: describeAgent(r.user_agent) || 'Browser', signedInWith: r.sso_org ? 'sso' : r.method, twoStep: r.mfa || !!r.sso_org, network: r.ip_prefix, createdAt: r.created_at, lastSeenAt: r.last_seen_at, expiresAt: r.expires_at });
    }
  } catch (err) { if (!MISSING.has(err.code)) throw err; }
  try {
    const native = await require('./sessions').listSessions(pool, userId);
    for (const r of native) {
      out.push({ id: r.id, kind: 'app', current: r.id === currentSid, device: [r.device_name, r.platform].filter(Boolean).join(' · ') || `${r.client} app`, signedInWith: r.client, twoStep: false, network: null, createdAt: r.created_at, lastSeenAt: r.last_used_at, expiresAt: r.expires_at });
    }
  } catch (err) { if (!MISSING.has(err.code)) throw err; }
  return out.sort((a, b) => new Date(b.lastSeenAt) - new Date(a.lastSeenAt));
}

/** Ends one session (web or app) that belongs to this user. */
async function revoke(pool, userId, id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) return false;
  let ended = false;
  try {
    const { rowCount } = await pool.query('UPDATE web_sessions SET revoked_at = NOW() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL', [id, userId]);
    ended = rowCount > 0;
  } catch (err) { if (!MISSING.has(err.code)) throw err; }
  if (!ended) {
    ended = await require('./sessions').revokeFamily(pool, userId, id).catch(() => false);
    if (ended) await pool.query('UPDATE push_devices SET disabled_at = now() WHERE session_id = $1 AND user_id = $2', [id, userId]).catch(() => {});
  }
  forget(`s:${id}`);
  return ended;
}

/**
 * Ends every session of this user, web and app, including tokens issued
 * before web_sessions existed. The caller issues a fresh session if the
 * person should stay signed in where they are.
 */
async function revokeAll(pool, userId) {
  try { await pool.query('UPDATE web_sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL', [userId]); } catch (err) { if (!MISSING.has(err.code)) throw err; }
  try { await pool.query('UPDATE auth_sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL', [userId]); } catch (err) { if (!MISSING.has(err.code)) throw err; }
  try { await pool.query('UPDATE users SET sessions_valid_after = NOW() WHERE id = $1', [userId]); } catch (err) { if (!MISSING.has(err.code)) throw err; }
  forget('s:'); forget(`u:${userId}`);
}

module.exports = { create, check, list, revoke, revokeAll, ipPrefix, describeAgent, TTL_DAYS, __clearCache: () => cache.clear() };
