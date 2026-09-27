// FILE: lib/notifications/connectorMonitor.js
// Raises "connector offline" when a bridge that HAS synced goes quiet past the
// delayed threshold (PC off, bridge closed, Tally closed). One notification
// per device per day (dedupe key). Run by cron in server.js.
const { notify, TYPES } = require('./notify');
const { DELAYED_AFTER_MS } = require('../connectors/state');

async function checkQuietBridges(pool, now = Date.now()) {
  const threshold = new Date(now - DELAYED_AFTER_MS).toISOString();
  const { rows } = await pool.query(
    `SELECT d.id AS device_id, d.user_id, d.device_name, MAX(r.finished_at) AS last_success
       FROM connector_devices d JOIN connector_sync_runs r ON r.device_id = d.id AND r.status = 'succeeded'
      WHERE d.status = 'ACTIVE'
      GROUP BY d.id, d.user_id, d.device_name
     HAVING MAX(r.finished_at) < $1`, [threshold]);
  const day = new Date(now).toISOString().slice(0, 10);
  let sent = 0;
  for (const r of rows) {
    const n = await notify(pool, r.user_id, {
      type: TYPES.CONNECTOR_OFFLINE, severity: 'high',
      title: 'Tally has stopped syncing',
      body: `${String(r.device_name || 'Your computer').slice(0, 60)} last synced ${new Date(r.last_success).toUTCString().slice(0, 22)} UTC.`,
      entity: { type: 'connector_device', id: r.device_id }, route: '/sources/tally',
      dedupeKey: `connector-offline:${r.device_id}:${day}`,
    });
    if (n) sent++;
  }
  return { checked: rows.length, sent };
}

module.exports = { checkQuietBridges };
