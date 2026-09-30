// FILE: lib/notifications/notify.js
// The canonical Starlane notification. One call creates one row that web,
// desktop and mobile all read (GET /api/inbox); delivery outside the app is a
// separate concern handled here (Expo push for iOS/Android). Desktop shows
// native notifications for new inbox items itself.
//
// Only high-value events notify (see TYPES). dedupe_key makes repeats a no-op
// (e.g. "connector offline" once per device per day). Titles and bodies must
// be useful on a lock screen but carry no secrets; keep amounts/names out of
// push bodies unless the owner opted in (not built — so we don't).

const { safeLog } = require('../observability/logger');

const TYPES = Object.freeze({
  APPROVAL_REQUIRED: 'approval_required',
  ACTION_COMPLETED: 'action_completed',
  ACTION_FAILED: 'action_failed',
  CONNECTOR_OFFLINE: 'connector_offline',
  CONNECTOR_ERROR: 'connector_error',
  BUSINESS_CHANGE: 'business_change',
  DISCOVERY: 'discovery',
});
const SEVERITIES = ['low', 'normal', 'high', 'critical'];
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

function shape(row) {
  return {
    id: row.id, type: row.type, severity: row.severity, title: row.title, body: row.body,
    entity: row.entity_type ? { type: row.entity_type, id: row.entity_id } : null,
    actionId: row.action_id, route: row.route, createdAt: row.created_at, readAt: row.read_at,
  };
}

async function deliverPush(pool, userId, n) {
  // Same policy as web push: off unless FEATURE_PUSH_NOTIFICATIONS_ENABLED,
  // and never while the global stop is on.
  if (require('../safety/externalSend').guardPush('expo')) return 'blocked';
  const { rows } = await pool.query(`SELECT id, token FROM push_devices WHERE user_id = $1 AND provider = 'expo' AND disabled_at IS NULL`, [userId]);
  if (!rows.length) return 'none';
  const messages = rows.map((d) => ({
    to: d.token, title: n.title, body: n.body || undefined, sound: n.severity === 'high' || n.severity === 'critical' ? 'default' : undefined,
    priority: n.severity === 'critical' || n.severity === 'high' ? 'high' : 'default',
    data: { notificationId: n.id, route: n.route, type: n.type },
  }));
  try {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (process.env.EXPO_ACCESS_TOKEN) headers.Authorization = `Bearer ${process.env.EXPO_ACCESS_TOKEN}`;
    const res = await fetch(EXPO_PUSH_URL, { method: 'POST', headers, body: JSON.stringify(messages), signal: AbortSignal.timeout(8000) });
    const body = await res.json().catch(() => ({}));
    const tickets = Array.isArray(body.data) ? body.data : [];
    // Tokens Expo says are dead are disabled so we stop sending to them.
    for (let i = 0; i < tickets.length; i++) {
      if (tickets[i]?.details?.error === 'DeviceNotRegistered') {
        await pool.query('UPDATE push_devices SET disabled_at = now() WHERE id = $1', [rows[i].id]).catch(() => {});
      }
    }
    return res.ok && tickets.some((t) => t.status === 'ok') ? 'sent' : 'failed';
  } catch (e) {
    safeLog('warn', '[notify] push delivery failed', { error: e.message, type: n.type });
    return 'failed';
  }
}

/**
 * @returns {Promise<object|null>} the notification, or null if deduplicated/failed
 */
async function notify(pool, userId, { type, severity = 'normal', title, body = null, entity = null, actionId = null, route, dedupeKey = null }) {
  try {
    if (!Object.values(TYPES).includes(type)) throw new Error(`unknown notification type ${type}`);
    const { rows } = await pool.query(
      `INSERT INTO notification_events (user_id, type, severity, title, body, entity_type, entity_id, action_id, route, dedupe_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
       RETURNING *`,
      [userId, type, SEVERITIES.includes(severity) ? severity : 'normal', String(title).slice(0, 140), body ? String(body).slice(0, 300) : null,
        entity?.type || null, entity?.id != null ? String(entity.id) : null, actionId, route, dedupeKey],
    );
    if (!rows.length) return null;
    const n = shape(rows[0]);
    const pushStatus = await deliverPush(pool, userId, n);
    await pool.query('UPDATE notification_events SET push_status = $2 WHERE id = $1', [n.id, pushStatus]).catch(() => {});
    return n;
  } catch (e) {
    safeLog('warn', '[notify] failed', { error: e.message, type });
    return null;
  }
}

module.exports = { notify, shape, TYPES };
