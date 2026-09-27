'use strict';
// lib/routes/tallyConnector.js — local-bridge connector routes (TallyPrime).
//
// Moved out of server.js (behaviour of the existing routes preserved; see
// tests/goldenPath.test.mjs and tests/securityHardening.test.mjs), plus the
// device-token, sync-run and disconnect routes the desktop connector host and
// the CLI bridge use.
//
// Owner (user session):
//   POST /api/connectors/tally/enrollment          legacy pairing code
//   GET  /api/connectors/tally/devices             list devices
//   POST /api/connectors/tally/devices/:id/revoke  revoke a device
//   GET  /api/connections                          data_connections rows
// Device, unauthenticated with a one-time code:
//   POST /api/connectors/tally/claim               code -> long-lived device secret
// Device, long-lived secret ("VantroDevice <id>.<secret>"):
//   POST /api/connectors/device/token              -> 15-min device token
// Device, short-lived token ("StarlaneDevice <jwt>") — or, for bridges older
// than token support, the long-lived secret:
//   POST  /api/connectors/device/sync-runs         start a sync attempt
//   PATCH /api/connectors/device/sync-runs/:id     mark it failed (e.g. Tally unreachable)
//   POST  /api/connectors/device/disconnect        the device revokes itself
//   POST  /api/connections/heartbeat               (also user session; see authorizeHeartbeat)
//   POST  /api/import/tally                        vouchers -> invoices/purchases/…

const express = require('express');
const rateLimit = require('express-rate-limit');
const { createEnrollment, claimEnrollment, authenticateDevice, listDevices, revokeDevice } = require('../domain/ingestion/deviceEnrollment');
const { issueDeviceToken, verifyDeviceToken } = require('../domain/ingestion/deviceTokens');
const { getConnections, upsertConnectionStatus, authorizeHeartbeat, VALID_SOURCE_TYPES, VALID_STATUSES } = require('../domain/ingestion/connections');
const { deploymentEnv } = require('../config/deployEnv');
const { track, EVENTS } = require('../observability/productEvents');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECRET_RE = /^VantroDevice\s+([0-9a-f-]{36})\.([A-Za-z0-9_-]{32,})$/i;
const TOKEN_RE = /^StarlaneDevice\s+([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;
const clip = (v, n) => (v == null ? null : String(v).slice(0, n));

function tallyConnectorRouter({ pool, supabase, authMiddleware }) {
  const router = express.Router();
  const claimLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });
  const tokenLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });

  // Device auth: short-lived token preferred; long-lived secret still accepted
  // (bridges that predate tokens). Sets req.user = { userId } and req.connectorDevice.
  function deviceAuth({ allowSecret = true } = {}) {
    return (req, res, next) => {
      const header = String(req.headers.authorization || '');
      const tok = header.match(TOKEN_RE);
      const sec = header.match(SECRET_RE);
      const verify = tok ? verifyDeviceToken(tok[1]) : (sec && allowSecret) ? authenticateDevice(sec[1], sec[2]) : null;
      if (!verify) return res.status(401).json({ error: 'Device credential required' });
      verify.then((device) => {
        if (!device) return res.status(401).json({ error: 'Invalid, expired or revoked device credential' });
        req.user = { userId: device.userId };
        req.connectorDevice = device;
        next();
      }).catch((error) => {
        console.error('[connector device auth]', error.message);
        res.status(503).json({ error: 'Unable to authenticate connector device' });
      });
    };
  }
  // Device credential if presented, otherwise a user session.
  function deviceOrUser(req, res, next) {
    const header = String(req.headers.authorization || '');
    if (TOKEN_RE.test(header) || SECRET_RE.test(header)) return deviceAuth()(req, res, next);
    return authMiddleware(req, res, next);
  }

  // ── Owner routes ──────────────────────────────────────────────────────
  router.post('/connectors/tally/enrollment', authMiddleware, async (req, res) => {
    try {
      const enrollment = await createEnrollment(req.user.userId);
      track(EVENTS.PAIRING_CREATED, { req, connectorId: 'tally', props: { via: 'legacy_enrollment' } });
      res.status(201).json({ success: true, enrollmentCode: enrollment.enrollmentCode, expiresAt: enrollment.expiresAt });
    } catch (error) {
      console.error('[connector enrollment]', error.message);
      res.status(503).json({ error: 'Unable to create connector enrollment' });
    }
  });

  router.get('/connectors/tally/devices', authMiddleware, async (req, res) => {
    try {
      res.json({ success: true, devices: await listDevices(req.user.userId) });
    } catch (error) {
      console.error('[connector devices list]', error.message);
      res.status(503).json({ error: 'Unable to list connector devices' });
    }
  });

  router.post('/connectors/tally/devices/:deviceId/revoke', authMiddleware, async (req, res) => {
    try {
      const revoked = await revokeDevice(req.user.userId, req.params.deviceId);
      if (!revoked) return res.status(404).json({ error: 'Device not found or already revoked' });
      track(EVENTS.DEVICE_REVOKED, { req, connectorId: 'tally', deviceId: req.params.deviceId, props: { by: 'owner' } });
      res.json({ success: true });
    } catch (error) {
      console.error('[connector device revoke]', error.message);
      res.status(503).json({ error: 'Unable to revoke connector device' });
    }
  });

  router.get('/connections', authMiddleware, async (req, res) => {
    try {
      res.json({ success: true, connections: await getConnections(req.user.userId) });
    } catch (error) {
      console.error('[connections list]', error.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Pairing claim (one-time code) ─────────────────────────────────────
  router.post('/connectors/tally/claim', claimLimiter, async (req, res) => {
    try {
      const { enrollmentCode, deviceName, clientVersion, platform } = req.body || {};
      const device = await claimEnrollment(enrollmentCode, deviceName);
      await pool.query(
        `UPDATE connector_devices SET client_version = $2, platform = $3, bound_env = $4 WHERE id = $1`,
        [device.deviceId, clip(clientVersion, 40), clip(platform, 40), deploymentEnv()],
      ).catch((e) => console.error('[connector claim metadata]', e.message));
      const { rows } = await pool.query('SELECT user_id FROM connector_devices WHERE id = $1', [device.deviceId]).catch(() => ({ rows: [] }));
      track(EVENTS.DEVICE_PAIRED, { req, userId: rows[0]?.user_id, connectorId: 'tally', deviceId: device.deviceId, props: { client_version: clip(clientVersion, 40), platform: clip(platform, 40) } });
      res.status(201).json({
        success: true, deviceId: device.deviceId, deviceSecret: device.deviceSecret,
        apiBase: `${req.protocol}://${req.get('host')}`, env: deploymentEnv(),
      });
    } catch (error) {
      const message = String(error.message || '');
      const safe = /Enrollment|device name/i.test(message) ? message : 'Unable to claim connector enrollment';
      res.status(400).json({ error: safe });
    }
  });

  // ── Device token exchange ─────────────────────────────────────────────
  router.post('/connectors/device/token', tokenLimiter, deviceAuth({ allowSecret: true }), async (req, res) => {
    const header = String(req.headers.authorization || '');
    if (!SECRET_RE.test(header)) return res.status(400).json({ error: 'Exchange requires the device secret, not a token' });
    const d = req.connectorDevice;
    try {
      const { rows } = await pool.query('SELECT bound_env FROM connector_devices WHERE id = $1', [d.deviceId]);
      const bound = rows[0]?.bound_env;
      if (bound && bound !== deploymentEnv()) {
        return res.status(403).json({ error: `This device was paired with the ${bound} environment, not ${deploymentEnv()}` });
      }
      const { clientVersion, platform } = req.body || {};
      await pool.query(
        `UPDATE connector_devices SET last_token_at = now(), last_seen_at = now(), bound_env = COALESCE(bound_env, $2),
                client_version = COALESCE($3, client_version), platform = COALESCE($4, platform) WHERE id = $1`,
        [d.deviceId, deploymentEnv(), clip(clientVersion, 40), clip(platform, 40)],
      );
      track(EVENTS.DEVICE_TOKEN_ISSUED, { req, connectorId: 'tally', deviceId: d.deviceId, props: { client_version: clip(clientVersion, 40) } });
      res.json({ success: true, ...issueDeviceToken(d) });
    } catch (error) {
      console.error('[device token]', error.message);
      res.status(503).json({ error: 'Unable to issue a device token' });
    }
  });

  // ── Sync runs ─────────────────────────────────────────────────────────
  router.post('/connectors/device/sync-runs', deviceAuth(), async (req, res) => {
    const d = req.connectorDevice;
    try {
      const { rows } = await pool.query(
        `INSERT INTO connector_sync_runs (user_id, connector_id, device_id, client_version) VALUES ($1, 'tally', $2, $3) RETURNING id, started_at`,
        [d.userId, d.deviceId, clip(req.body?.clientVersion, 40)],
      );
      track(EVENTS.SYNC_STARTED, { req, connectorId: 'tally', deviceId: d.deviceId, syncRunId: rows[0].id });
      res.status(201).json({ success: true, syncRun: rows[0] });
    } catch (error) {
      console.error('[sync run start]', error.message);
      res.status(503).json({ error: 'Unable to start a sync run' });
    }
  });

  router.patch('/connectors/device/sync-runs/:id', deviceAuth(), async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Sync run not found' });
    const d = req.connectorDevice;
    const { status, error: errText } = req.body || {};
    if (status !== 'failed') return res.status(400).json({ error: 'Only status "failed" can be reported; success is recorded by the import itself' });
    try {
      const { rows } = await pool.query(
        `UPDATE connector_sync_runs SET status = 'failed', finished_at = now(), error = $3
          WHERE id = $1 AND device_id = $2 AND status = 'running' RETURNING id`,
        [req.params.id, d.deviceId, clip(errText, 500) || 'Sync failed on the device'],
      );
      if (!rows.length) return res.status(404).json({ error: 'Sync run not found or already finished' });
      await upsertConnectionStatus(d.userId, 'TALLY', 'ERROR', { lastSyncError: clip(errText, 500) }).catch(() => {});
      track(EVENTS.SYNC_FAILED, { req, connectorId: 'tally', deviceId: d.deviceId, syncRunId: req.params.id, props: { reason: 'device_reported' } });
      res.json({ success: true });
    } catch (error) {
      console.error('[sync run fail]', error.message);
      res.status(503).json({ error: 'Unable to update the sync run' });
    }
  });

  router.post('/connectors/device/disconnect', deviceAuth(), async (req, res) => {
    const d = req.connectorDevice;
    try {
      await revokeDevice(d.userId, d.deviceId);
      track(EVENTS.DEVICE_REVOKED, { req, connectorId: 'tally', deviceId: d.deviceId, props: { by: 'device' } });
      res.json({ success: true });
    } catch (error) {
      console.error('[device disconnect]', error.message);
      res.status(503).json({ error: 'Unable to disconnect' });
    }
  });

  // ── Heartbeat + import ────────────────────────────────────────────────
  router.post('/connections/heartbeat', deviceOrUser, async (req, res) => {
    try {
      const userId = req.user.userId;
      const { sourceType, status, lastSyncAt, lastSyncError } = req.body || {};
      if (!sourceType || !VALID_SOURCE_TYPES.includes(sourceType)) {
        return res.status(400).json({ error: `sourceType must be one of ${VALID_SOURCE_TYPES.join(', ')}` });
      }
      if (!status || !VALID_STATUSES.includes(status)) {
        return res.status(400).json({ error: `status must be one of ${VALID_STATUSES.join(', ')}` });
      }
      const authz = authorizeHeartbeat({ device: req.connectorDevice || null, sourceType, status });
      if (!authz.ok) return res.status(authz.status).json({ error: authz.error });
      const connection = await upsertConnectionStatus(userId, sourceType, status, {
        lastSyncAt: lastSyncAt || new Date(), lastSyncError: lastSyncError ?? null,
      });
      res.json({ success: true, connection });
    } catch (error) {
      console.error('[connections heartbeat]', error.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Accepts already-parsed Tally vouchers ({ vouchers: [{type,date,party,voucherNo,amount,items}] })
  // from the bridge / desktop connector host. Idempotent (tallyImport.service).
  // Records the attempt as a sync run (X-Sync-Run-Id if the client started one).
  router.post('/import/tally', deviceOrUser, async (req, res) => {
    const userId = req.user.userId;
    const device = req.connectorDevice || null;
    if (device && device.sourceType !== 'TALLY') {
      return res.status(403).json({ error: `This device is paired for ${device.sourceType}, not TALLY` });
    }
    const { vouchers } = req.body || {};
    if (!Array.isArray(vouchers)) return res.status(400).json({ error: 'vouchers must be an array' });
    if (vouchers.length > 5000) return res.status(400).json({ error: 'too many vouchers in one request (max 5000)' });

    let runId = req.get('x-sync-run-id');
    const started = Date.now();
    try {
      if (runId && UUID_RE.test(runId)) {
        const { rows } = await pool.query(
          `UPDATE connector_sync_runs SET records_received = $3 WHERE id = $1 AND user_id = $2 AND status = 'running' RETURNING id`,
          [runId, userId, vouchers.length],
        );
        if (!rows.length) runId = null;
      } else runId = null;
      if (!runId) {
        const { rows } = await pool.query(
          `INSERT INTO connector_sync_runs (user_id, connector_id, device_id, records_received) VALUES ($1, 'tally', $2, $3) RETURNING id`,
          [userId, device?.deviceId || null, vouchers.length],
        );
        runId = rows[0].id;
        track(EVENTS.SYNC_STARTED, { req, connectorId: 'tally', deviceId: device?.deviceId, syncRunId: runId, props: { via: 'import' } });
      }
    } catch (e) {
      console.error('[import/tally] sync run bookkeeping failed', e.message);
      runId = null;
    }

    const finish = async (status, fields) => {
      if (!runId) return;
      await pool.query(
        `UPDATE connector_sync_runs SET status = $2, finished_at = now(), records_imported = $3, records_rejected = $4, error = $5 WHERE id = $1`,
        [runId, status, fields.imported || 0, fields.rejected || 0, clip(fields.error, 500)],
      ).catch((e) => console.error('[import/tally] sync run finish failed', e.message));
    };

    try {
      const { importTallyVouchers } = require('../services/tallyImport.service');
      const result = await importTallyVouchers(supabase, userId, vouchers);
      if (result.error) {
        await finish('failed', { error: result.error });
        track(EVENTS.SYNC_FAILED, { req, connectorId: 'tally', deviceId: device?.deviceId, syncRunId: runId, props: { reason: 'import_error' } });
        return res.status(result.status || 400).json({ error: result.error, syncRunId: runId });
      }
      const imported = Object.values(result.imported || {}).reduce((a, b) => a + (Number(b) || 0), 0);
      const rejected = result.rejected?.length || 0;
      const erroredAll = rejected > 0 && imported === 0 && Object.values(result.imported || {}).every((n) => n === 0) && vouchers.length === rejected;
      await finish(erroredAll ? 'failed' : 'succeeded', { imported, rejected, error: erroredAll ? `${rejected} voucher(s) rejected` : null });
      await upsertConnectionStatus(userId, 'TALLY', erroredAll ? 'ERROR' : 'CONNECTED', {
        lastSyncAt: new Date(), lastSyncError: rejected ? `${rejected} voucher(s) rejected` : null,
      }).catch((err) => console.error('[import/tally] connection status update failed', err.message));
      if (rejected) track(EVENTS.RECORDS_REJECTED, { req, connectorId: 'tally', deviceId: device?.deviceId, syncRunId: runId, props: { records_rejected: rejected } });
      track(erroredAll ? EVENTS.SYNC_FAILED : EVENTS.SYNC_SUCCEEDED, {
        req, connectorId: 'tally', deviceId: device?.deviceId, syncRunId: runId,
        props: { records_received: vouchers.length, records_imported: imported, records_rejected: rejected, duration_ms: Date.now() - started },
      });
      res.json({ ...result, syncRunId: runId });
    } catch (error) {
      await finish('failed', { error: 'Internal error' });
      track(EVENTS.SYNC_FAILED, { req, connectorId: 'tally', deviceId: device?.deviceId, syncRunId: runId, props: { reason: 'exception' } });
      console.error('[import/tally]', error.message);
      res.status(500).json({ error: 'Internal server error', syncRunId: runId });
    }
  });

  return router;
}

module.exports = { tallyConnectorRouter };
