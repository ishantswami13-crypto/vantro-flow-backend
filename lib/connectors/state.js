// FILE: lib/connectors/state.js
// Live, per-tenant state for every connector manifest, derived only from rows
// something real wrote:
//   data_connections      — heartbeats / imports from the Tally bridge
//   connector_devices     — paired bridge devices (last_seen_at on every auth)
//   file_import_batches   — completed/failed spreadsheet imports
//   world_sources         — public feed ingestion outcomes (not per tenant)
// Nothing here is inferred or defaulted to "connected".

const { listManifests } = require('./registry');
const { checkSourceFreshness } = require('../world/freshnessCheck');
const sdk = require('./sdk');
const { SYNC_RUN_TIMEOUT_MS, normalizeRun, parseError, closeStaleRuns } = require('./syncRuns');

const STALE_AFTER_MS = 24 * 60 * 60 * 1000; // a bridge that syncs every 30 min is stale after a day of silence

/**
 * Pure: collapse the raw facts about one tenant connection into a health
 * label the UI can show without interpretation.
 *   not_connected | healthy | stale | error | disconnected | unavailable
 */
function deriveHealth({ manifest, connection, devices = [], lastImport = null, now = Date.now() }) {
  if (manifest.availability !== 'available') return 'unavailable';

  if (manifest.authType === 'file_import') {
    if (!lastImport) return 'not_connected';
    return lastImport.status === 'FAILED' ? 'error' : 'healthy';
  }

  if (!connection) return devices.some((d) => d.status === 'ACTIVE') ? 'stale' : 'not_connected';
  if (connection.status === 'ERROR') return 'error';
  if (connection.status === 'DISCONNECTED') return 'disconnected';
  if (connection.status !== 'CONNECTED') return 'not_connected';
  const last = connection.last_sync_at ? new Date(connection.last_sync_at).getTime() : 0;
  return now - last > STALE_AFTER_MS ? 'stale' : 'healthy';
}

// Local-bridge health (Tally). Driven by connector_sync_runs, pairing codes
// and devices — never by a bare "connected" flag:
//   not_connected  nothing paired, no open pairing code
//   pairing        an unexpired, unclaimed pairing code exists, no active device
//   revoked        devices existed but every one is revoked
//   connected      an active device, but no sync has succeeded yet
//   syncing        the latest attempt is running and started < 15 min ago
//   healthy        last success within DELAYED_AFTER_MS
//   delayed        last success older than that (bridge off, PC asleep, Tally closed)
//   error          the latest attempt failed, or is still 'running' past the
//                  timeout (it never reported back, so it did not succeed)
const DELAYED_AFTER_MS = 2 * 60 * 60 * 1000;       // bridge syncs every 30 min
const SYNC_STALE_RUNNING_MS = SYNC_RUN_TIMEOUT_MS;
function deriveBridgeHealth({ devices = [], openPairing = false, latestRun = null, lastSuccessAt = null, now = Date.now() }) {
  latestRun = normalizeRun(latestRun, now);
  const active = devices.filter((d) => d.status === 'ACTIVE');
  if (!active.length) {
    if (openPairing) return 'pairing';
    return devices.length ? 'revoked' : 'not_connected';
  }
  if (latestRun && latestRun.status === 'running' && now - new Date(latestRun.started_at).getTime() < SYNC_STALE_RUNNING_MS) return 'syncing';
  if (latestRun && latestRun.status === 'failed') return 'error';
  if (!lastSuccessAt) return 'connected';
  return now - new Date(lastSuccessAt).getTime() > DELAYED_AFTER_MS ? 'delayed' : 'healthy';
}

// The detailed labels above, in the one vocabulary every connector shares
// (lib/connectors/sdk.js HEALTH). null = nothing to connect (not built).
const CANONICAL = {
  healthy: 'CONNECTED', connected: 'CONNECTED', syncing: 'SYNCING', delayed: 'DEGRADED', stale: 'STALE',
  error: 'FAILED', not_connected: 'DISCONNECTED', pairing: 'DISCONNECTED', revoked: 'DISCONNECTED',
  disconnected: 'DISCONNECTED', unavailable: null,
};
function canonicalHealth(health) {
  return Object.prototype.hasOwnProperty.call(CANONICAL, health) ? CANONICAL[health] : 'FAILED';
}
// Every live connector today only reads (Tally, file import, public feeds).
function capabilitiesOf(manifest) {
  return manifest.availability === 'available' ? ['READ'] : [];
}

function worldHealth(status) {
  if (status === 'FRESH') return 'healthy';
  if (status === 'NEVER_SUCCEEDED') return 'not_connected';
  return 'stale';
}

async function getConnectorStates(pool, userId, { now = Date.now() } = {}) {
  if (!userId) throw new Error('getConnectorStates: userId required');
  const [connections, devices, imports, world] = await Promise.all([
    pool.query('SELECT source_type, status, connected_at, last_sync_at, last_sync_error FROM data_connections WHERE user_id = $1', [userId]),
    pool.query(`SELECT id, source_type, device_name, status, created_at, last_seen_at, revoked_at, client_version, platform
                  FROM connector_devices WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`, [userId]),
    pool.query(`SELECT DISTINCT ON (source_system) source_system, status, filename, completed_at, started_at,
                       rows_accepted, rows_rejected, error_message
                  FROM file_import_batches WHERE user_id = $1
                 ORDER BY source_system, started_at DESC`, [userId]),
    checkSourceFreshness().catch(() => []),
  ]);
  // Runs left 'running' past the timeout are closed as failed on read, for
  // this tenant only; if that write fails they still read as failed below.
  await closeStaleRuns(pool, userId).catch(() => 0);
  // Sequential on the pool is fine; these are small indexed reads.
  const runs = (await pool.query(
    `SELECT DISTINCT ON (connector_id) connector_id, id, status, started_at, finished_at, records_received, records_imported, records_rejected, error, client_version
       FROM connector_sync_runs WHERE user_id = $1 ORDER BY connector_id, started_at DESC`, [userId]).catch(() => ({ rows: [] }))).rows;
  const successes = (await pool.query(
    `SELECT connector_id, MAX(COALESCE(finished_at, started_at)) AS last_success_at FROM connector_sync_runs
      WHERE user_id = $1 AND status = 'succeeded' GROUP BY connector_id`, [userId]).catch(() => ({ rows: [] }))).rows;
  const openPairings = (await pool.query(
    `SELECT source_type FROM connector_enrollments WHERE user_id = $1 AND claimed_at IS NULL AND expires_at > now()`, [userId]).catch(() => ({ rows: [] }))).rows;

  return listManifests().map((manifest) => {
    const connection = manifest.sourceType
      ? connections.rows.find((c) => c.source_type === manifest.sourceType) || null
      : null;
    const devs = manifest.authType === 'local_bridge'
      ? devices.rows.filter((d) => d.source_type === manifest.sourceType)
      : [];
    const lastImport = manifest.authType === 'file_import'
      // Both upload paths count: /api/import/* ('file_import') and the
      // decisions ledger import ('ledger_import'). Bridge already did.
      ? imports.rows.filter((b) => ['file_import', 'ledger_import'].includes(b.source_system))
        .sort((x, y) => new Date(y.started_at) - new Date(x.started_at))[0] || null
      : null;

    let health;
    let worldSource = null;
    let latestRun = null;
    let lastSuccessAt = null;
    if (manifest.authType === 'public_feed') {
      worldSource = world.find((w) => w.provider === manifest.worldSource.provider
        && (!manifest.worldSource.dataset || w.dataset === manifest.worldSource.dataset)) || null;
      health = worldSource ? worldHealth(worldSource.status) : 'not_connected';
    } else if (manifest.authType === 'local_bridge' && manifest.availability === 'available') {
      latestRun = normalizeRun(runs.find((r) => r.connector_id === manifest.id) || null, now);
      lastSuccessAt = successes.find((r) => r.connector_id === manifest.id)?.last_success_at || null;
      health = deriveBridgeHealth({
        devices: devs, openPairing: openPairings.some((p) => p.source_type === manifest.sourceType),
        latestRun, lastSuccessAt, now,
      });
    } else {
      health = deriveHealth({ manifest, connection, devices: devs, lastImport, now });
    }

    const canonical = canonicalHealth(health);
    const capabilities = capabilitiesOf(manifest);
    return {
      ...manifest,
      capabilities,
      state: {
        health,
        canonicalHealth: canonical,
        capabilityLabel: sdk.capabilityLabel(canonical === null ? null : { capabilities }, { connected: ['CONNECTED', 'SYNCING', 'DEGRADED', 'STALE'].includes(canonical) }),
        status: connection?.status || null,
        connectedAt: connection?.connected_at || null,
        // A bridge with sync runs reports the latest succeeded run only; a
        // heartbeat time (data_connections) is used just before any run exists.
        lastSyncAt: latestRun ? lastSuccessAt : (lastSuccessAt || connection?.last_sync_at || lastImport?.completed_at || worldSource?.last_success || null),
        lastSuccessAt,
        lastAttempt: latestRun && {
          id: latestRun.id, status: latestRun.status, startedAt: latestRun.started_at, finishedAt: latestRun.finished_at,
          recordsReceived: latestRun.records_received, recordsImported: latestRun.records_imported,
          recordsRejected: latestRun.records_rejected, error: parseError(latestRun.error).message || latestRun.error,
          errorCode: parseError(latestRun.error).code, clientVersion: latestRun.client_version,
        },
        // Bridge connectors: the latest attempt alone decides; an old
        // heartbeat error must not outlive a later successful sync.
        lastError: manifest.authType === 'local_bridge' && manifest.availability === 'available'
          ? (latestRun && latestRun.status === 'failed' ? (parseError(latestRun.error).message || 'The last sync failed.') : null)
          : (connection?.last_sync_error || lastImport?.error_message || worldSource?.last_failure_reason || null),
        devices: devs.map((d) => ({
          id: d.id, name: d.device_name, status: d.status, version: d.client_version || null, platform: d.platform || null,
          pairedAt: d.created_at, lastSeenAt: d.last_seen_at, revokedAt: d.revoked_at,
        })),
        lastImport: lastImport && {
          filename: lastImport.filename, status: lastImport.status, completedAt: lastImport.completed_at,
          rowsAccepted: lastImport.rows_accepted, rowsRejected: lastImport.rows_rejected,
        },
      },
    };
  });
}

module.exports = { getConnectorStates, deriveHealth, deriveBridgeHealth, canonicalHealth, capabilitiesOf, STALE_AFTER_MS, DELAYED_AFTER_MS };
