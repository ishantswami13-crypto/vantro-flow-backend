'use strict';
// lib/domain/outbound/controls.js
// Stop switches, checked by every worker before every send:
//   1. STARLANE_GLOBAL_STOP=true or OUTBOUND_GLOBAL_STOP=true (env, operator)
//   2. outbound_system_controls 'global_stop' (DB, operator; no deploy)
//   3. tenant engine not RUNNING (owner pressed STOP ALL OUTBOUND, or never started)
//   4. campaign not ACTIVE
//   5. provider account not HEALTHY/THROTTLED
// And the sending mode:
//   SHADOW  the sink adapter is used whatever the account; nothing leaves.
//   TEST    the real provider, but only to OUTBOUND_TEST_RECIPIENTS
//           (comma-separated addresses or @domains); anything else is refused.
//   LIVE    the real provider to real prospects.
// TEST and LIVE also require FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED=true
// (Hard Rule 7). Without it the engine refuses to start in those modes and a
// worker that finds the flag off refuses to send.

const { normalizeEmail } = require('./normalize');

function envTrue(name) { return String(process.env[name] || '').toLowerCase() === 'true'; }

async function globalStop(db) {
  if (envTrue('STARLANE_GLOBAL_STOP')) return { stopped: true, source: 'env:STARLANE_GLOBAL_STOP' };
  if (envTrue('OUTBOUND_GLOBAL_STOP')) return { stopped: true, source: 'env:OUTBOUND_GLOBAL_STOP' };
  const r = await db.query("SELECT enabled, reason, set_by, set_at FROM outbound_system_controls WHERE key = 'global_stop'");
  if (r.rows[0]?.enabled) return { stopped: true, source: 'db:global_stop', reason: r.rows[0].reason, setBy: r.rows[0].set_by, setAt: r.rows[0].set_at };
  return { stopped: false };
}

async function setGlobalStop(db, enabled, { reason = null, setBy }) {
  await db.query(
    `INSERT INTO outbound_system_controls (key, enabled, reason, set_by, set_at) VALUES ('global_stop',$1,$2,$3,NOW())
     ON CONFLICT (key) DO UPDATE SET enabled=EXCLUDED.enabled, reason=EXCLUDED.reason, set_by=EXCLUDED.set_by, set_at=NOW()`,
    [!!enabled, reason, setBy]
  );
  return globalStop(db);
}

function externalSendingEnabled() {
  return envTrue('FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED');
}

function testRecipients() {
  return String(process.env.OUTBOUND_TEST_RECIPIENTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function isTestRecipient(email) {
  const n = normalizeEmail(email);
  if (!n) return false;
  const list = testRecipients();
  return list.some((x) => (x.startsWith('@') ? n.endsWith(x) : normalizeEmail(x) === n));
}

/**
 * Whether a job in `mode` may be handed to the real provider for `email`.
 * Returns { ok, useSink, reason }.
 */
function modeGate(mode, email) {
  if (mode === 'SHADOW') return { ok: true, useSink: true };
  if (!externalSendingEnabled()) return { ok: false, reason: 'FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED is off' };
  if (mode === 'TEST' && !isTestRecipient(email)) return { ok: false, reason: 'TEST mode: recipient is not in OUTBOUND_TEST_RECIPIENTS' };
  if (mode === 'TEST' || mode === 'LIVE') return { ok: true, useSink: false };
  return { ok: false, reason: `unknown mode ${mode}` };
}

async function tenantState(db, userId) {
  const r = await db.query('SELECT * FROM outbound_tenant_state WHERE user_id = $1', [userId]);
  return r.rows[0] || { user_id: userId, engine_status: 'STOPPED', mode: 'SHADOW' };
}

module.exports = { globalStop, setGlobalStop, externalSendingEnabled, testRecipients, isTestRecipient, modeGate, tenantState };
