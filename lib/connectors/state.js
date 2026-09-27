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

function worldHealth(status) {
  if (status === 'FRESH') return 'healthy';
  if (status === 'NEVER_SUCCEEDED') return 'not_connected';
  return 'stale';
}

async function getConnectorStates(pool, userId, { now = Date.now() } = {}) {
  if (!userId) throw new Error('getConnectorStates: userId required');
  const [connections, devices, imports, world] = await Promise.all([
    pool.query('SELECT source_type, status, connected_at, last_sync_at, last_sync_error FROM data_connections WHERE user_id = $1', [userId]),
    pool.query(`SELECT id, source_type, device_name, status, created_at, last_seen_at, revoked_at
                  FROM connector_devices WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`, [userId]),
    pool.query(`SELECT DISTINCT ON (source_system) source_system, status, filename, completed_at, started_at,
                       rows_accepted, rows_rejected, error_message
                  FROM file_import_batches WHERE user_id = $1
                 ORDER BY source_system, started_at DESC`, [userId]),
    checkSourceFreshness().catch(() => []),
  ]);

  return listManifests().map((manifest) => {
    const connection = manifest.sourceType
      ? connections.rows.find((c) => c.source_type === manifest.sourceType) || null
      : null;
    const devs = manifest.authType === 'local_bridge'
      ? devices.rows.filter((d) => d.source_type === manifest.sourceType)
      : [];
    const lastImport = manifest.authType === 'file_import'
      ? imports.rows.find((b) => b.source_system === 'file_import') || null
      : null;

    let health;
    let worldSource = null;
    if (manifest.authType === 'public_feed') {
      worldSource = world.find((w) => w.provider === manifest.worldSource.provider
        && (!manifest.worldSource.dataset || w.dataset === manifest.worldSource.dataset)) || null;
      health = worldSource ? worldHealth(worldSource.status) : 'not_connected';
    } else {
      health = deriveHealth({ manifest, connection, devices: devs, lastImport, now });
    }

    return {
      ...manifest,
      state: {
        health,
        status: connection?.status || null,
        connectedAt: connection?.connected_at || null,
        lastSyncAt: connection?.last_sync_at || lastImport?.completed_at || worldSource?.last_success || null,
        lastError: connection?.last_sync_error || lastImport?.error_message || worldSource?.last_failure_reason || null,
        devices: devs.map((d) => ({
          id: d.id, name: d.device_name, status: d.status,
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

module.exports = { getConnectorStates, deriveHealth, STALE_AFTER_MS };
