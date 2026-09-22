// FILE: lib/domain/ingestion/deviceEnrollment.js
// STARLANE — Connector device enrollment/authentication domain module.
//
// Backs the 4 routes in server.js under "Local connector enrollment and
// device authentication" (POST /api/connectors/tally/enrollment, POST
// /api/connectors/tally/claim, GET /api/connectors/tally/devices, POST
// /api/connectors/tally/devices/:deviceId/revoke) plus the VantroDevice
// credential branch of connectorOrUserAuth.
//
// Schema: connector_enrollments / connector_devices — see
// migrations/047_connector_devices.sql. That schema was found to already
// exist live in production (created in an earlier, uncommitted session);
// this module is written against that real, already-existing column set
// (code_hash / token_hash / device_name / status), not a new invented one.
//
// Hashing note: code_hash and token_hash are SHA-256 hex digests, not
// bcrypt — deterministic hashing is required because claimEnrollment/
// authenticateDevice must look a row up BY the hash of a caller-supplied
// plaintext value (bcrypt's per-call random salt makes that lookup
// impossible without iterating every row). This differs from
// users.password_hash (bcrypt) elsewhere in server.js, which is checked
// only after the row is already found by email — a different access
// pattern. The plaintext enrollment code / device secret is generated
// once with crypto.randomBytes, returned once in the response body, and
// never persisted or logged again.
//
// Bearer credential shape: "VantroDevice <deviceId>.<secret>" — deviceId
// is the connector_devices.id UUID, secret is the random plaintext token
// whose SHA-256 hash is the only thing ever persisted (token_hash).

const crypto = require('crypto');
const { supabase } = require('../../config/supabaseClient');

const ENROLLMENT_TTL_MS = 10 * 60 * 1000; // 10 minutes — short-lived pairing code

function randomToken(bytes) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

/**
 * Create a short-lived enrollment code for an authenticated user.
 * @param {string} userId
 * @param {string} [sourceType]
 * @returns {Promise<{enrollmentCode: string, expiresAt: string}>}
 */
async function createEnrollment(userId, sourceType = 'TALLY') {
  if (!userId) throw new Error('createEnrollment: userId required');
  const enrollmentCode = randomToken(24); // ~32 url-safe chars, shown to the user once
  const expiresAt = new Date(Date.now() + ENROLLMENT_TTL_MS).toISOString();

  const { error } = await supabase
    .from('connector_enrollments')
    .insert([{ user_id: userId, source_type: sourceType, code_hash: sha256(enrollmentCode), expires_at: expiresAt }]);
  if (error) throw error;

  return { enrollmentCode, expiresAt };
}

/**
 * Claim an enrollment code (called by the local connector tool, no user
 * auth — the code itself is the proof of authorization). Claim-once:
 * a code that has already been claimed, or that has expired, is rejected.
 * @param {string} enrollmentCode
 * @param {string} [deviceName]
 * @returns {Promise<{deviceId: string, deviceSecret: string}>}
 */
async function claimEnrollment(enrollmentCode, deviceName) {
  const code = String(enrollmentCode || '').trim();
  if (!code) throw new Error('Enrollment code is required');
  if (deviceName != null && String(deviceName).length > 200) {
    throw new Error('Device name is too long');
  }

  const { data: rows, error: findError } = await supabase
    .from('connector_enrollments')
    .select('*')
    .eq('code_hash', sha256(code))
    .limit(1);
  if (findError) throw findError;
  const enrollment = (rows || [])[0];
  if (!enrollment) throw new Error('Enrollment code not found');
  if (enrollment.claimed_at) throw new Error('Enrollment code has already been used');
  if (new Date(enrollment.expires_at).getTime() < Date.now()) throw new Error('Enrollment code has expired');

  const deviceSecret = randomToken(24);
  const tokenHash = sha256(deviceSecret);

  const { data: deviceRows, error: deviceError } = await supabase
    .from('connector_devices')
    .insert([{
      user_id: enrollment.user_id,
      source_type: enrollment.source_type,
      device_name: (deviceName && String(deviceName).trim()) || `${enrollment.source_type} connector`,
      token_hash: tokenHash,
    }])
    .select('id')
    .single();
  if (deviceError) throw deviceError;
  const device = deviceRows;

  // Claim-once enforced by a conditional UPDATE on the enrollment row
  // itself (WHERE claimed_at IS NULL) rather than a separate read-then-write
  // — two concurrent claims racing on the same code can both pass the read
  // above, but only one UPDATE ... WHERE claimed_at IS NULL will match a row.
  const { data: claimedRows, error: claimError } = await supabase
    .from('connector_enrollments')
    .update({ claimed_device_id: device.id, claimed_at: new Date().toISOString() })
    .eq('id', enrollment.id)
    .is('claimed_at', null)
    .select('id');
  if (claimError) throw claimError;
  if (!claimedRows || claimedRows.length === 0) {
    // Lost the claim race after inserting the device row — roll the device
    // back so a lost race never leaves an orphaned, usable credential.
    await supabase.from('connector_devices').delete().eq('id', device.id);
    throw new Error('Enrollment code has already been used');
  }

  return { deviceId: device.id, deviceSecret };
}

/**
 * Authenticate a device credential ("VantroDevice <id>.<secret>" already
 * parsed by the caller). Returns device info on success, or null on any
 * failure (unknown device, revoked, bad secret).
 * @param {string} deviceId
 * @param {string} secret
 * @returns {Promise<{userId: string, deviceId: string, sourceType: string} | null>}
 */
async function authenticateDevice(deviceId, secret) {
  if (!deviceId || !secret) return null;

  const { data: rows, error } = await supabase
    .from('connector_devices')
    .select('id, user_id, source_type, token_hash, status')
    .eq('id', deviceId)
    .limit(1);
  if (error) throw error;
  const device = (rows || [])[0];
  if (!device) return null;
  if (device.status !== 'ACTIVE') return null;

  const valid = crypto.timingSafeEqual
    ? safeCompare(sha256(secret), device.token_hash)
    : sha256(secret) === device.token_hash;
  if (!valid) return null;

  // Best-effort liveness update; never block/fail auth on this write.
  supabase
    .from('connector_devices')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('id', device.id)
    .then(() => {}, () => {});

  return { userId: device.user_id, deviceId: device.id, sourceType: device.source_type };
}

function safeCompare(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * List connector devices for a tenant (never returns secret material).
 * @param {string} userId
 * @returns {Promise<Array>}
 */
async function listDevices(userId) {
  if (!userId) throw new Error('listDevices: userId required');
  const { data, error } = await supabase
    .from('connector_devices')
    .select('id, source_type, device_name, status, created_at, last_seen_at, revoked_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

/**
 * Revoke a device (soft — sets status='REVOKED' + revoked_at). Scoped to
 * the owning tenant.
 * @param {string} userId
 * @param {string} deviceId
 * @returns {Promise<boolean>} true if a device was revoked, false if not found/already revoked
 */
async function revokeDevice(userId, deviceId) {
  if (!userId) throw new Error('revokeDevice: userId required');
  if (!deviceId) throw new Error('revokeDevice: deviceId required');

  const { data, error } = await supabase
    .from('connector_devices')
    .update({ status: 'REVOKED', revoked_at: new Date().toISOString() })
    .eq('id', deviceId)
    .eq('user_id', userId)
    .eq('status', 'ACTIVE')
    .select('id');
  if (error) throw error;
  return !!(data && data.length > 0);
}

module.exports = {
  createEnrollment,
  claimEnrollment,
  authenticateDevice,
  listDevices,
  revokeDevice,
};
