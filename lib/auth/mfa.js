'use strict';
// Multi-factor sign-in with an authenticator app (TOTP) and recovery codes.
//
//   setup     a new secret is stored encrypted as "pending" and shown once
//             (with an otpauth:// URI for a QR code). Nothing changes for
//             sign-in yet.
//   confirm   the person types a code from the app; only then is MFA on.
//             Ten recovery codes are shown once; only their hashes are kept.
//   verify    at sign-in, after the password (or Google, Apple, phone), a
//             code from the app or one recovery code (each works once).
//             A code is refused if its time step was already used. Five
//             wrong codes lock the second step for 15 minutes.
//   disable / new recovery codes   need a current code.
//
// The secret is AES-256-GCM encrypted with OUTBOUND_CREDENTIALS_KEY (the same
// key and rotation as connector credentials). Without that key MFA cannot be
// turned on, and the API says so rather than storing a plaintext secret.

const crypto = require('crypto');
const creds = require('../domain/outbound/credentials');
const totp = require('./totp');
const { PlatformError, badRequest, conflict } = require('../platform/errors');

const MAX_FAILURES = 5;
const LOCK_MINUTES = 15;
const RECOVERY_CODES = 10;
const PENDING_TTL_MS = 15 * 60 * 1000;

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const normRecovery = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function newRecoveryCodes() {
  const codes = [];
  for (let i = 0; i < RECOVERY_CODES; i += 1) {
    const raw = crypto.randomBytes(8).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '').padEnd(10, '7').slice(0, 10);
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return codes;
}

function requireKey() {
  if (!creds.available()) throw new PlatformError(503, 'KEY_MISSING', 'Two-step sign-in cannot be turned on yet: this server has no encryption key (OUTBOUND_CREDENTIALS_KEY).');
}

async function row(db, userId) {
  const { rows } = await db.query('SELECT * FROM user_mfa WHERE user_id = $1', [userId]);
  return rows[0] || null;
}

async function status(db, userId) {
  const r = await row(db, userId);
  return {
    enabled: !!(r && r.enabled_at && r.secret_enc),
    enabledAt: r?.enabled_at || null,
    recoveryCodesLeft: r?.recovery_hashes?.length || 0,
    canEnable: creds.available(),
  };
}

async function isEnabled(db, userId) {
  try {
    const r = await row(db, userId);
    return !!(r && r.enabled_at && r.secret_enc);
  } catch (err) {
    if (err.code === '42P01') return false; // migration 076 not applied
    throw err;
  }
}

async function beginSetup(db, userId, accountLabel) {
  requireKey();
  const current = await row(db, userId);
  if (current?.enabled_at) throw conflict('Two-step sign-in is already on. Turn it off first to move it to another app.');
  const secret = totp.newSecret();
  await db.query(
    `INSERT INTO user_mfa (user_id, pending_secret_enc, pending_created_at) VALUES ($1, $2, NOW())
     ON CONFLICT (user_id) DO UPDATE SET pending_secret_enc = EXCLUDED.pending_secret_enc, pending_created_at = NOW(), updated_at = NOW()`,
    [userId, creds.encrypt({ secret })],
  );
  return { secret, otpauthUri: totp.otpauthUri(secret, { account: accountLabel || 'account' }) };
}

async function confirmSetup(db, userId, code, { nowMs = Date.now() } = {}) {
  requireKey();
  const r = await row(db, userId);
  if (!r?.pending_secret_enc || !r.pending_created_at || nowMs - new Date(r.pending_created_at).getTime() > PENDING_TTL_MS) {
    throw badRequest('Start the setup again: the code from the app was not confirmed within 15 minutes.');
  }
  const secret = creds.decrypt(r.pending_secret_enc)?.secret;
  if (!secret) throw new PlatformError(503, 'KEY_MISSING', 'The setup cannot be read on this server. Start again.');
  const step = totp.matchStep(secret, code, { nowMs });
  if (step == null) throw badRequest('That code does not match. Check the app shows Starlane and the time on your phone is right.');
  const codes = newRecoveryCodes();
  await db.query(
    `UPDATE user_mfa SET secret_enc = $2, pending_secret_enc = NULL, pending_created_at = NULL, enabled_at = NOW(),
            last_step = $3, recovery_hashes = $4, failed_count = 0, locked_until = NULL, updated_at = NOW()
      WHERE user_id = $1`,
    [userId, creds.encrypt({ secret }), step, codes.map((c) => sha256(normRecovery(c)))],
  );
  return { recoveryCodes: codes };
}

/**
 * Checks a second-factor code for sign-in or a sensitive change.
 * Returns { ok: true, method, recoveryCodesLeft } or throws a 400/429.
 */
async function verify(db, userId, code, { nowMs = Date.now() } = {}) {
  const r = await row(db, userId);
  if (!r?.enabled_at || !r.secret_enc) throw badRequest('Two-step sign-in is not on for this account.');
  if (r.locked_until && new Date(r.locked_until).getTime() > nowMs) {
    throw new PlatformError(429, 'MFA_LOCKED', 'Too many wrong codes. Wait 15 minutes, or use a recovery code after that.');
  }
  const secret = creds.decrypt(r.secret_enc)?.secret;
  if (!secret) throw new PlatformError(503, 'KEY_MISSING', 'Two-step sign-in cannot be checked on this server right now (encryption key missing or changed).');
  const input = String(code || '').trim();

  if (/^\d{3}\s?\d{3}$/.test(input)) {
    const step = totp.matchStep(secret, input, { nowMs });
    if (step != null) {
      // Single statement: only one request can move last_step past this step.
      const upd = await db.query(
        `UPDATE user_mfa SET last_step = $2, failed_count = 0, locked_until = NULL, updated_at = NOW()
          WHERE user_id = $1 AND last_step < $2 RETURNING user_id`, [userId, step]);
      if (upd.rows[0]) return { ok: true, method: 'totp', recoveryCodesLeft: r.recovery_hashes.length };
    }
  } else if (normRecovery(input).length === 10) {
    const h = sha256(normRecovery(input));
    const upd = await db.query(
      `UPDATE user_mfa SET recovery_hashes = array_remove(recovery_hashes, $2), failed_count = 0, locked_until = NULL, updated_at = NOW()
        WHERE user_id = $1 AND $2 = ANY(recovery_hashes) RETURNING array_length(recovery_hashes, 1) AS left`, [userId, h]);
    if (upd.rows[0]) return { ok: true, method: 'recovery', recoveryCodesLeft: upd.rows[0].left || 0 };
  }

  const fail = await db.query(
    `UPDATE user_mfa SET failed_count = failed_count + 1,
            locked_until = CASE WHEN failed_count + 1 >= $2 THEN NOW() + ($3 || ' minutes')::interval ELSE locked_until END,
            updated_at = NOW()
      WHERE user_id = $1 RETURNING failed_count`, [userId, MAX_FAILURES, String(LOCK_MINUTES)]);
  const n = fail.rows[0]?.failed_count || 0;
  if (n >= MAX_FAILURES) {
    await db.query('UPDATE user_mfa SET failed_count = 0 WHERE user_id = $1', [userId]);
    throw new PlatformError(429, 'MFA_LOCKED', 'Too many wrong codes. Wait 15 minutes, then try again.');
  }
  throw badRequest('That code is not right, or it was already used.');
}

async function disable(db, userId, code) {
  await verify(db, userId, code);
  await db.query('DELETE FROM user_mfa WHERE user_id = $1', [userId]);
  return { enabled: false };
}

async function regenerateRecoveryCodes(db, userId, code) {
  await verify(db, userId, code);
  const codes = newRecoveryCodes();
  await db.query('UPDATE user_mfa SET recovery_hashes = $2, updated_at = NOW() WHERE user_id = $1', [userId, codes.map((c) => sha256(normRecovery(c)))]);
  return { recoveryCodes: codes };
}

module.exports = { status, isEnabled, beginSetup, confirmSetup, verify, disable, regenerateRecoveryCodes, MAX_FAILURES };
