// FILE: lib/auth/sessions.js
// Refresh-token sessions for native clients (desktop, mobile).
//
//   access token  15-minute JWT { userId, email, sid } — sid = session family
//   refresh token 32 random bytes, stored as SHA-256, rotates on every use
//
// Reuse detection: presenting a refresh token that was already rotated (or a
// revoked one) revokes the whole family — the legitimate client and the thief
// are both signed out, which is the safe outcome.
//
// isActive(sid) is what authMiddleware consults for tokens that carry a sid,
// so logout / "sign out this device" take effect on the next request. A small
// in-process cache (15 s) keeps that off the hot path.

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_DAYS = Number(process.env.NATIVE_REFRESH_TTL_DAYS || 30);
const CLIENTS = ['desktop', 'mobile', 'web', 'cli'];
const sha = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const clip = (v, n) => (v == null ? null : String(v).slice(0, n));

const cache = new Map(); // sid -> { active, at }
const CACHE_MS = 15 * 1000;

function jwtSecret() {
  const s = process.env.JWT_SECRET_CURRENT || process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET not configured');
  return s;
}

function accessTokenFor(user, familyId) {
  return jwt.sign({ userId: user.id, email: user.email, sid: familyId }, jwtSecret(), { expiresIn: ACCESS_TTL_SECONDS });
}

async function createSession(pool, user, meta = {}) {
  const client = CLIENTS.includes(meta.client) ? meta.client : 'cli';
  const refresh = crypto.randomBytes(32).toString('base64url');
  const familyId = crypto.randomUUID();
  const { rows } = await pool.query(
    `INSERT INTO auth_sessions (family_id, user_id, refresh_hash, client, platform, device_name, app_version, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now() + ($8 || ' days')::interval) RETURNING id, expires_at`,
    [familyId, user.id, sha(refresh), client, clip(meta.platform, 40), clip(meta.deviceName, 120), clip(meta.appVersion, 40), String(REFRESH_TTL_DAYS)],
  );
  return {
    sessionId: familyId,
    accessToken: accessTokenFor(user, familyId),
    accessExpiresAt: new Date(Date.now() + ACCESS_TTL_SECONDS * 1000).toISOString(),
    refreshToken: refresh,
    refreshExpiresAt: rows[0].expires_at,
  };
}

class SessionError extends Error { constructor(msg) { super(msg); this.status = 401; } }

async function refreshSession(pool, refreshToken, meta = {}) {
  if (!refreshToken || typeof refreshToken !== 'string') throw new SessionError('Refresh token required');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT s.*, u.email FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.refresh_hash = $1 FOR UPDATE OF s`,
      [sha(refreshToken)],
    );
    const s = rows[0];
    if (!s) { await client.query('ROLLBACK'); throw new SessionError('Session not found'); }
    if (s.revoked_at || s.replaced_by) {
      // Reuse of a rotated/revoked token: revoke the family.
      await client.query(`UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, now()) WHERE family_id = $1`, [s.family_id]);
      await client.query('COMMIT');
      cache.delete(s.family_id);
      throw new SessionError('Session revoked');
    }
    if (new Date(s.expires_at) <= new Date()) { await client.query('ROLLBACK'); throw new SessionError('Session expired'); }
    const next = crypto.randomBytes(32).toString('base64url');
    const ins = await client.query(
      `INSERT INTO auth_sessions (family_id, user_id, refresh_hash, client, platform, device_name, app_version, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, expires_at`,
      [s.family_id, s.user_id, sha(next), s.client, s.platform, s.device_name, clip(meta.appVersion, 40) || s.app_version, s.expires_at],
    );
    await client.query(`UPDATE auth_sessions SET replaced_by = $2, revoked_at = now(), last_used_at = now() WHERE id = $1`, [s.id, ins.rows[0].id]);
    await client.query('COMMIT');
    return {
      sessionId: s.family_id,
      accessToken: accessTokenFor({ id: s.user_id, email: s.email }, s.family_id),
      accessExpiresAt: new Date(Date.now() + ACCESS_TTL_SECONDS * 1000).toISOString(),
      refreshToken: next,
      refreshExpiresAt: ins.rows[0].expires_at,
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
}

async function revokeFamily(pool, userId, familyId) {
  const { rowCount } = await pool.query(
    `UPDATE auth_sessions SET revoked_at = now() WHERE family_id = $1 AND user_id = $2 AND revoked_at IS NULL`, [familyId, userId]);
  cache.delete(familyId);
  return rowCount > 0;
}

async function listSessions(pool, userId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (family_id) family_id AS id, client, platform, device_name, app_version,
            MIN(created_at) OVER (PARTITION BY family_id) AS created_at, last_used_at, expires_at
       FROM auth_sessions WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
      ORDER BY family_id, created_at DESC`, [userId]);
  return rows;
}

// A database blip must not sign the app out: if the lookup fails, a session
// confirmed active within the last STALE_OK_MS is still accepted (revocation
// then takes effect up to that much later, only during the outage).
const STALE_OK_MS = 10 * 60 * 1000;

async function isActive(pool, familyId) {
  const hit = cache.get(familyId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.active;
  let rows;
  try {
    ({ rows } = await pool.query(
      `SELECT 1 FROM auth_sessions WHERE family_id = $1 AND revoked_at IS NULL AND replaced_by IS NULL AND expires_at > now() LIMIT 1`, [familyId]));
  } catch (err) {
    if (hit && hit.active && Date.now() - hit.at < STALE_OK_MS) return true;
    throw err;
  }
  const active = rows.length > 0;
  cache.set(familyId, { active, at: Date.now() });
  return active;
}

module.exports = { createSession, refreshSession, revokeFamily, listSessions, isActive, SessionError, ACCESS_TTL_SECONDS };
