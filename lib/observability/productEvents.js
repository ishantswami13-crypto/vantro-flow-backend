// FILE: lib/observability/productEvents.js
// Structured product events for learning from the first real companies.
//
// track(name, fields) writes ONE structured log line (safeLog, which redacts
// secret-looking keys) and, best effort, one product_events row. It never
// throws and never blocks the request path on the DB write.
//
// Fields are identifiers and small counts only. Do not pass free text a
// customer typed, message bodies, emails, phone numbers, tokens or amounts
// tied to a named person. `props` is filtered through PROP_ALLOWLIST so a
// careless call cannot widen what is stored.

const { safeLog } = require('./logger');

// Canonical event names — one place to see what is measured.
const EVENTS = Object.freeze({
  APPLICATION_SUBMITTED: 'access.application_submitted',
  ACCESS_DECIDED: 'access.decided',                 // props.status: approved|waitlisted|rejected|reviewing|expired
  ACCESS_LINK_OPENED: 'access.link_opened',         // props.kind: status|download
  ACCESS_LINK_REQUESTED: 'access.link_requested',
  DOWNLOAD_REQUESTED: 'access.download_requested',  // props.artifact
  EMAIL_SENT: 'email.sent',                         // props.template, props.delivered
  PAIRING_CREATED: 'connector.pairing_created',
  DEVICE_PAIRED: 'connector.device_paired',
  DEVICE_REVOKED: 'connector.device_revoked',       // props.by: owner|device
  DEVICE_TOKEN_ISSUED: 'connector.device_token_issued',
  SYNC_STARTED: 'connector.sync_started',
  SYNC_SUCCEEDED: 'connector.sync_succeeded',
  SYNC_FAILED: 'connector.sync_failed',
  RECORDS_REJECTED: 'connector.records_rejected',   // normalization failures
  RECOMMENDATION_GENERATED: 'recommendation.generated',
  EVIDENCE_VIEWED: 'recommendation.evidence_viewed',
  APPROVAL_REQUESTED: 'approval.requested',
  APPROVAL_COMPLETED: 'approval.completed',         // props.decision, props.via
  ACTION_EXECUTED: 'action.executed',
  ACTION_FAILED: 'action.failed',
  VERIFICATION_COMPLETED: 'verification.completed',
});

const PROP_ALLOWLIST = new Set([
  'status', 'kind', 'artifact', 'template', 'delivered', 'by', 'decision', 'via', 'action_type',
  'records_received', 'records_imported', 'records_rejected', 'reason', 'client_version', 'platform',
  'tier', 'duplicate', 'agent', 'outcome', 'source_type', 'error_code', 'count', 'duration_ms', 'env',
]);

let poolGetter = null;
function getPoolSafe() {
  try {
    if (!poolGetter) poolGetter = require('../db/pg').getPool;
    return poolGetter();
  } catch { return null; }
}

function cleanProps(props = {}) {
  const out = {};
  for (const [k, v] of Object.entries(props || {})) {
    if (!PROP_ALLOWLIST.has(k)) continue;
    if (v === undefined) continue;
    out[k] = typeof v === 'string' ? v.slice(0, 200) : v;
  }
  return out;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOrNull = (v) => (v && UUID_RE.test(String(v)) ? String(v) : null);

/**
 * @param {string} event  one of EVENTS
 * @param {{req?: object, requestId?: string, userId?: string, applicationId?: string,
 *          connectorId?: string, deviceId?: string, syncRunId?: string, actionId?: string,
 *          props?: object}} fields
 */
function track(event, fields = {}) {
  try {
    const row = {
      event,
      request_id: fields.requestId || fields.req?.requestId || null,
      user_id: uuidOrNull(fields.userId || fields.req?.user?.userId),
      application_id: uuidOrNull(fields.applicationId),
      connector_id: fields.connectorId ? String(fields.connectorId).slice(0, 64) : null,
      device_id: uuidOrNull(fields.deviceId),
      sync_run_id: uuidOrNull(fields.syncRunId),
      action_id: uuidOrNull(fields.actionId),
      props: cleanProps(fields.props),
    };
    safeLog('info', `[event] ${event}`, { product_event: event, ...row, props: row.props });
    const pool = getPoolSafe();
    if (!pool) return;
    pool.query(
      `INSERT INTO product_events (event, request_id, user_id, application_id, connector_id, device_id, sync_run_id, action_id, props)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [row.event, row.request_id, row.user_id, row.application_id, row.connector_id, row.device_id, row.sync_run_id, row.action_id, JSON.stringify(row.props)],
    ).catch((e) => safeLog('warn', '[event] persist failed', { product_event: event, error: e.message }));
  } catch (e) {
    try { safeLog('warn', '[event] track failed', { product_event: event, error: e.message }); } catch { /* never throw */ }
  }
}

module.exports = { track, EVENTS, cleanProps };
