// FILE: lib/domain/decisions/controls.js
// Execution control plane: pilot mode, autonomy ceiling, semantic
// definitions and kill switches.
//
// Policy is enforced here, in the backend, outside any model: nothing an
// agent or a message says can change these values. The only writers are the
// authenticated owner through /api/decisions/controls and the operator's
// STARLANE_GLOBAL_STOP environment variable.
//
// Stop precedence (first match blocks):
//   GLOBAL (env) > TENANT > AGENT > DECISION > ACTION_CLASS > CONNECTOR
//   > WORKFLOW > OBJECTIVE (autopilot); the last two need migration 061.

const { effectiveDefinitions, validateOverrides, DEFINITIONS_VERSION } = require('./definitions');

const SCOPES = ['TENANT', 'AGENT', 'DECISION', 'ACTION_CLASS', 'CONNECTOR', 'WORKFLOW', 'OBJECTIVE'];

async function getSettings(pool, userId) {
  const res = await pool.query('SELECT * FROM starlane_tenant_settings WHERE user_id = $1', [userId]);
  const row = res.rows[0];
  const overrides = row ? row.definitions || {} : {};
  return {
    pilotMode: row ? row.pilot_mode : 'SHADOW',
    pilotModeIsDefault: !row,
    autonomyCeiling: row ? row.autonomy_ceiling : 'L2',
    definitionsOverrides: overrides,
    definitionsVersion: row ? row.definitions_version : 0,
    definitions: effectiveDefinitions(overrides),
    definitionsLabel: `${DEFINITIONS_VERSION}+tenant.v${row ? row.definitions_version : 0}`,
    updatedAt: row ? row.updated_at : null,
  };
}

async function setPilotMode(pool, userId, mode, actorId) {
  if (!['SHADOW', 'LIVE'].includes(mode)) throw Object.assign(new Error('pilot mode must be SHADOW or LIVE'), { status: 400 });
  await pool.query(
    `INSERT INTO starlane_tenant_settings (user_id, pilot_mode, updated_by, updated_at) VALUES ($1,$2,$3,NOW())
     ON CONFLICT (user_id) DO UPDATE SET pilot_mode = EXCLUDED.pilot_mode, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [userId, mode, actorId]
  );
  return getSettings(pool, userId);
}

async function setDefinitions(pool, userId, input, actorId) {
  const { ok, errors, value } = validateOverrides(input);
  if (!ok) throw Object.assign(new Error(errors.join('; ')), { status: 400 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query('SELECT definitions, definitions_version FROM starlane_tenant_settings WHERE user_id = $1 FOR UPDATE', [userId]);
    const merged = { ...(cur.rows[0]?.definitions || {}), ...value };
    const version = (cur.rows[0]?.definitions_version || 0) + 1;
    await client.query(
      `INSERT INTO starlane_tenant_settings (user_id, definitions, definitions_version, updated_by, updated_at) VALUES ($1,$2,$3,$4,NOW())
       ON CONFLICT (user_id) DO UPDATE SET definitions = EXCLUDED.definitions, definitions_version = EXCLUDED.definitions_version, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [userId, JSON.stringify(merged), version, actorId]
    );
    await client.query('INSERT INTO starlane_definition_versions (user_id, version, definitions, created_by) VALUES ($1,$2,$3,$4)', [userId, version, JSON.stringify(merged), actorId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return getSettings(pool, userId);
}

async function listControls(pool, userId) {
  const res = await pool.query('SELECT scope, scope_key, stopped, reason, set_by, set_at, cleared_at FROM starlane_controls WHERE user_id = $1 ORDER BY set_at DESC', [userId]);
  return res.rows;
}

async function setControl(pool, userId, { scope, scopeKey, stopped, reason }, actorId) {
  if (!SCOPES.includes(scope)) throw Object.assign(new Error(`scope must be one of ${SCOPES.join(', ')}`), { status: 400 });
  const key = scope === 'TENANT' ? 'tenant' : String(scopeKey || '').trim();
  if (!key || key.length > 200) throw Object.assign(new Error('scopeKey is required'), { status: 400 });
  const res = await pool.query(
    `INSERT INTO starlane_controls (user_id, scope, scope_key, stopped, reason, set_by, set_at, cleared_at)
     VALUES ($1,$2,$3,$4,$5,$6,NOW(), CASE WHEN $4 THEN NULL ELSE NOW() END)
     ON CONFLICT (user_id, scope, scope_key) DO UPDATE SET stopped = EXCLUDED.stopped, reason = EXCLUDED.reason,
       set_by = EXCLUDED.set_by, set_at = NOW(), cleared_at = CASE WHEN EXCLUDED.stopped THEN NULL ELSE NOW() END
     RETURNING scope, scope_key, stopped, reason, set_at, cleared_at`,
    [userId, scope, key, !!stopped, reason ? String(reason).slice(0, 500) : null, actorId]
  );
  return res.rows[0];
}

/**
 * @returns {{allowed: boolean, blockedBy: Array<{scope, key, reason}>}}
 */
async function checkStops(pool, userId, { agentKey, decisionId, actionClass, connector, workflowId, objectiveId } = {}) {
  const blockedBy = [];
  if (String(process.env.STARLANE_GLOBAL_STOP || '').toLowerCase() === 'true') {
    blockedBy.push({ scope: 'GLOBAL', key: 'env', reason: 'Operator global stop is on (STARLANE_GLOBAL_STOP).' });
  }
  const res = await pool.query('SELECT scope, scope_key, reason FROM starlane_controls WHERE user_id = $1 AND stopped = TRUE', [userId]);
  const wanted = [
    ['TENANT', 'tenant'],
    agentKey ? ['AGENT', agentKey] : null,
    decisionId ? ['DECISION', String(decisionId)] : null,
    actionClass ? ['ACTION_CLASS', actionClass] : null,
    connector ? ['CONNECTOR', connector] : null,
    workflowId ? ['WORKFLOW', String(workflowId)] : null,
    objectiveId ? ['OBJECTIVE', String(objectiveId)] : null,
  ].filter(Boolean);
  for (const [scope, key] of wanted) {
    const hit = res.rows.find((r) => r.scope === scope && r.scope_key === key);
    if (hit) blockedBy.push({ scope, key, reason: hit.reason || `${scope.toLowerCase()} stop is on` });
  }
  return { allowed: blockedBy.length === 0, blockedBy };
}

module.exports = { getSettings, setPilotMode, setDefinitions, listControls, setControl, checkStops, SCOPES };
