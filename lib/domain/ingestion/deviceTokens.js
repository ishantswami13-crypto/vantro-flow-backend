// FILE: lib/domain/ingestion/deviceTokens.js
// Short-lived access tokens for paired connector devices (the Tally bridge and
// the Starlane desktop app's connector host).
//
// The long-lived device secret ("VantroDevice <id>.<secret>") is now used for
// exactly one thing: POST /api/connectors/device/token, which returns a
// 15-minute token ("StarlaneDevice <jwt>") for every other call. A leaked
// request log therefore exposes a credential that dies within minutes.
//
// Each token is bound to:
//   - the device id and its tenant (user id) and source type;
//   - the deployment environment (production / staging / development), so a
//     staging credential can never be replayed against production;
// and every verification re-reads the device row, so revocation is immediate
// (not "after the token expires").

const jwt = require('jsonwebtoken');
const { supabase } = require('../../config/supabaseClient');
const { deploymentEnv } = require('../../config/deployEnv');

const TOKEN_TTL_SECONDS = 15 * 60;
const AUDIENCE = 'starlane-device';

function secret() {
  const s = process.env.DEVICE_TOKEN_SECRET || process.env.JWT_SECRET;
  if (!s) throw new Error('No DEVICE_TOKEN_SECRET or JWT_SECRET configured');
  return s;
}

function issueDeviceToken(device) {
  const env = deploymentEnv();
  const token = jwt.sign(
    { typ: 'device', did: device.deviceId, uid: device.userId, src: device.sourceType, env },
    secret(),
    { expiresIn: TOKEN_TTL_SECONDS, audience: AUDIENCE },
  );
  return { accessToken: token, expiresAt: new Date(Date.now() + TOKEN_TTL_SECONDS * 1000).toISOString(), env };
}

/** @returns {Promise<{userId, deviceId, sourceType} | null>} */
async function verifyDeviceToken(token) {
  let claims;
  try {
    claims = jwt.verify(token, secret(), { audience: AUDIENCE });
  } catch { return null; }
  if (claims.typ !== 'device' || claims.env !== deploymentEnv()) return null;
  const { data, error } = await supabase
    .from('connector_devices').select('id, user_id, source_type, status')
    .eq('id', claims.did).limit(1);
  if (error) throw error;
  const d = (data || [])[0];
  if (!d || d.status !== 'ACTIVE' || d.user_id !== claims.uid) return null;
  return { userId: d.user_id, deviceId: d.id, sourceType: d.source_type };
}

module.exports = { issueDeviceToken, verifyDeviceToken, TOKEN_TTL_SECONDS };
