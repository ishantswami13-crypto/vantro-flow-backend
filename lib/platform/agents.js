'use strict';
// Agent Studio storage and lifecycle.
//
//   draft     editable definition (draft_definition), never executed live
//   ready     a published, immutable version exists; not yet running
//   active    the published version runs on its triggers and on demand
//   disabled  paused by a person; keeps its versions and history
//   archived  retired; cannot run, kept for history
//
// Publishing requires the validation checks to pass AND a completed test run
// of exactly this draft (matched by checksum). Activation re-runs the checks
// against the published version. Visibility: private (owner), team
// (members of the team), organization (every member). Admins can see and
// manage every agent in their organization for governance.

const crypto = require('crypto');
const audit = require('./audit');
const { normalizeDefinition, checksum } = require('./definition');
const { CATALOG, describe, availabilityContext } = require('./tools');
const { getTemplate } = require('./templates');
const { accessibleCollectionIds } = require('./knowledge');
const { getPolicy } = require('./organization');
const { atLeast } = require('./roles');
const { badRequest, forbidden, notFound, conflict, assertUuid } = require('./errors');

const MAX_AGENTS_PER_ORG = 500;
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

async function myTeams(db, orgId, userId) {
  const { rows } = await db.query('SELECT team_id FROM platform_team_members WHERE organization_id = $1 AND user_id = $2', [orgId, userId]);
  return rows.map((r) => r.team_id);
}

function canView(a, org, userId, teams) {
  if (a.owner_user_id === userId) return true;
  if (atLeast(org.role, 'admin')) return true;
  if (a.visibility === 'organization') return true;
  return a.visibility === 'team' && teams.includes(a.team_id);
}
const canEdit = (a, org, userId) => atLeast(org.role, 'member') && (a.owner_user_id === userId || atLeast(org.role, 'admin'));

function shape(a, org, userId, teams, extra = {}) {
  return {
    id: a.id,
    name: a.name,
    description: a.description,
    status: a.status,
    visibility: a.visibility,
    teamId: a.team_id,
    teamName: a.team_name || null,
    ownerUserId: a.owner_user_id,
    ownerEmail: a.owner_email || null,
    templateKey: a.template_key,
    publishedVersion: a.published_version,
    draftChecksum: a.draft_checksum,
    draftDiffersFromPublished: a.published_checksum ? a.published_checksum !== a.draft_checksum : a.published_version == null,
    triggers: a.draft_definition?.triggers || [],
    tools: (a.draft_definition?.tools || []).map((t) => t.key),
    nextScheduledAt: a.next_scheduled_at,
    createdAt: a.created_at,
    updatedAt: a.updated_at,
    canEdit: canEdit(a, org, userId),
    canRun: a.status === 'active' && atLeast(org.role, 'member') && canView(a, org, userId, teams),
    isMine: a.owner_user_id === userId,
    lastExecution: a.last_execution || null,
    ...extra,
  };
}

const AGENT_SELECT = `SELECT a.*, t.name AS team_name, u.email AS owner_email, v.checksum AS published_checksum,
    (SELECT json_build_object('id', e.id, 'status', e.status, 'mode', e.mode, 'createdAt', e.created_at, 'finishedAt', e.finished_at)
       FROM platform_agent_executions e WHERE e.agent_id = a.id ORDER BY e.created_at DESC LIMIT 1) AS last_execution
  FROM platform_agents a
  LEFT JOIN platform_teams t ON t.id = a.team_id
  LEFT JOIN users u ON u.id = a.owner_user_id
  LEFT JOIN platform_agent_versions v ON v.agent_id = a.id AND v.version = a.published_version`;

async function list(db, org, userId, { view = 'all', q = null } = {}) {
  const teams = await myTeams(db, org.id, userId);
  const { rows } = await db.query(`${AGENT_SELECT} WHERE a.organization_id = $1 ORDER BY a.updated_at DESC LIMIT ${MAX_AGENTS_PER_ORG}`, [org.id]);
  let items = rows.filter((a) => canView(a, org, userId, teams));
  const needle = typeof q === 'string' && q.trim() ? q.trim().toLowerCase() : null;
  if (needle) items = items.filter((a) => `${a.name} ${a.description || ''}`.toLowerCase().includes(needle));
  const filters = {
    all: (a) => a.status !== 'archived',
    mine: (a) => a.owner_user_id === userId && a.status !== 'archived',
    team: (a) => a.visibility === 'team' && a.status !== 'archived',
    organization: (a) => a.visibility === 'organization' && a.status !== 'archived',
    drafts: (a) => a.status === 'draft',
    active: (a) => a.status === 'active',
    inactive: (a) => a.status === 'disabled' || a.status === 'archived',
  };
  const counts = Object.fromEntries(Object.entries(filters).map(([k, f]) => [k, items.filter(f).length]));
  const f = filters[view];
  if (!f) throw badRequest('Unknown view');
  return { agents: items.filter(f).map((a) => shape(a, org, userId, teams)), counts };
}

async function loadRow(db, org, id) {
  assertUuid(id, 'agentId');
  const { rows } = await db.query(`${AGENT_SELECT} WHERE a.organization_id = $1 AND a.id = $2`, [org.id, id]);
  if (!rows[0]) throw notFound('That agent');
  return rows[0];
}

/** The agent row if the caller may see it (404 otherwise, never a hint it exists). */
async function loadVisible(db, org, userId, id) {
  const a = await loadRow(db, org, id);
  const teams = await myTeams(db, org.id, userId);
  if (!canView(a, org, userId, teams)) throw notFound('That agent');
  return { a, teams };
}

async function loadEditable(db, org, userId, id) {
  const { a, teams } = await loadVisible(db, org, userId, id);
  if (!canEdit(a, org, userId)) throw forbidden('Only the agent\'s owner or an admin can change it.');
  return { a, teams };
}

async function get(db, org, userId, id) {
  const { a, teams } = await loadVisible(db, org, userId, id);
  const versions = await db.query(
    `SELECT v.version, v.checksum, v.notes, v.published_at, u.email AS published_by
       FROM platform_agent_versions v LEFT JOIN users u ON u.id = v.published_by
      WHERE v.organization_id = $1 AND v.agent_id = $2 ORDER BY v.version DESC LIMIT 50`,
    [org.id, id],
  );
  const lastTest = await db.query(
    `SELECT id, status, definition_checksum, finished_at FROM platform_agent_executions
      WHERE organization_id = $1 AND agent_id = $2 AND mode = 'test' ORDER BY created_at DESC LIMIT 1`,
    [org.id, id],
  );
  const lt = lastTest.rows[0] || null;
  return shape(a, org, userId, teams, {
    definition: a.draft_definition,
    versions: versions.rows.map((v) => ({ version: v.version, checksum: v.checksum, notes: v.notes, publishedAt: v.published_at, publishedBy: v.published_by })),
    lastTest: lt ? { id: lt.id, status: lt.status, matchesDraft: lt.definition_checksum === a.draft_checksum, finishedAt: lt.finished_at } : null,
    hasWebhook: !!a.webhook_token_hash,
  });
}

async function getVersion(db, org, userId, id, version) {
  await loadVisible(db, org, userId, id);
  const n = Number(version);
  if (!Number.isInteger(n) || n < 1) throw badRequest('version must be a positive whole number');
  const { rows } = await db.query('SELECT version, definition, checksum, notes, published_at FROM platform_agent_versions WHERE organization_id = $1 AND agent_id = $2 AND version = $3', [org.id, id, n]);
  if (!rows[0]) throw notFound('That version');
  return { version: rows[0].version, definition: rows[0].definition, checksum: rows[0].checksum, notes: rows[0].notes, publishedAt: rows[0].published_at };
}

async function resolveSharing(db, org, userId, { visibility = 'private', teamId = null }) {
  if (!['private', 'team', 'organization'].includes(visibility)) throw badRequest('visibility must be private, team or organization');
  if (visibility === 'team') {
    assertUuid(teamId, 'teamId');
    const t = await db.query('SELECT 1 FROM platform_teams WHERE organization_id = $1 AND id = $2', [org.id, teamId]);
    if (!t.rows[0]) throw notFound('That team');
    if (!atLeast(org.role, 'admin') && !(await myTeams(db, org.id, userId)).includes(teamId)) throw forbidden('You can only share with a team you belong to.');
    return { visibility, teamId };
  }
  if (visibility === 'organization' && !atLeast(org.role, 'admin')) {
    const policy = await getPolicy(db, org.id);
    if (!policy.membersMayShareWithOrganization) throw forbidden('Only admins can share agents with the whole organization here.');
  }
  return { visibility, teamId: null };
}

async function create(db, org, userId, { definition = null, templateKey = null, visibility = 'private', teamId = null } = {}) {
  if (!atLeast(org.role, 'member')) throw forbidden('Viewers cannot create agents.');
  let raw = definition;
  if (templateKey) {
    const t = getTemplate(templateKey);
    if (!t) throw notFound('That template');
    raw = { ...t.definition, ...(definition || {}) };
  }
  if (!raw) throw badRequest('Provide a definition or a template');
  const def = normalizeDefinition(raw, { toolCatalog: CATALOG });
  const sharing = await resolveSharing(db, org, userId, { visibility, teamId });
  const count = await db.query('SELECT COUNT(*)::int AS n FROM platform_agents WHERE organization_id = $1', [org.id]);
  if (count.rows[0].n >= MAX_AGENTS_PER_ORG) throw conflict(`An organization can have up to ${MAX_AGENTS_PER_ORG} agents. Archive some first.`, 'LIMIT');
  const { rows } = await db.query(
    `INSERT INTO platform_agents (organization_id, owner_user_id, team_id, visibility, name, description, template_key, draft_definition, draft_checksum)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [org.id, userId, sharing.teamId, sharing.visibility, def.name, def.description || null, templateKey, JSON.stringify(def), checksum(def)],
  );
  await audit.recordSoft(db, { organizationId: org.id, actorUserId: userId, action: 'agent.created', resourceType: 'agent', resourceId: rows[0].id, detail: { name: def.name, templateKey, visibility: sharing.visibility } });
  return { id: rows[0].id };
}

async function update(db, org, userId, id, { definition, visibility, teamId } = {}) {
  const { a } = await loadEditable(db, org, userId, id);
  if (a.status === 'archived') throw conflict('Restore this agent before editing it.', 'ARCHIVED');
  const sets = [];
  const params = [org.id, id];
  const put = (col, v) => { params.push(v); sets.push(`${col} = $${params.length}`); };
  if (definition !== undefined) {
    const def = normalizeDefinition(definition, { toolCatalog: CATALOG });
    put('draft_definition', JSON.stringify(def));
    put('draft_checksum', checksum(def));
    put('name', def.name);
    put('description', def.description || null);
  }
  if (visibility !== undefined) {
    const s = await resolveSharing(db, org, userId, { visibility, teamId });
    put('visibility', s.visibility);
    put('team_id', s.teamId);
  }
  if (!sets.length) throw badRequest('Nothing to update');
  await db.query(`UPDATE platform_agents SET ${sets.join(', ')}, updated_at = NOW() WHERE organization_id = $1 AND id = $2`, params);
  await audit.recordSoft(db, { organizationId: org.id, actorUserId: userId, action: 'agent.updated', resourceType: 'agent', resourceId: id, detail: { definition: definition !== undefined, visibility } });
}

async function duplicate(db, org, userId, id) {
  const { a } = await loadVisible(db, org, userId, id);
  const def = { ...a.draft_definition, name: `${a.draft_definition.name} (copy)`.slice(0, 80) };
  return create(db, org, userId, { definition: def, visibility: 'private' });
}

// ── Validation checks ───────────────────────────────────────────────────

/**
 * Everything that must be true before a definition can be published or
 * activated, with the reason when it is not.
 */
async function checks(db, org, ownerUserId, def, { router = null, availability = null } = {}) {
  const out = [];
  const ctx = availability || await availabilityContext(db, org);
  const policy = await getPolicy(db, org.id);
  const described = new Map(describe(ctx, policy).map((t) => [t.key, t]));
  if (!def.tools.length) out.push({ key: 'tools', ok: true, blocking: false, message: 'No tools granted: the agent can only reason over its input.' });
  for (const t of def.tools) {
    const d = described.get(t.key);
    out.push({ key: `tool:${t.key}`, ok: d.status === 'available', blocking: d.status !== 'available', message: d.status === 'available' ? `${d.name} is available.` : `${d.name}: ${d.reason}` });
  }
  if (def.knowledge.collection_ids.length) {
    const ok = await accessibleCollectionIds(db, org.id, ownerUserId);
    const missing = def.knowledge.collection_ids.filter((c) => !ok.includes(c));
    out.push({ key: 'knowledge', ok: !missing.length, blocking: !!missing.length, message: missing.length ? `${missing.length} knowledge collection(s) are not readable by the agent's owner or no longer exist.` : `${def.knowledge.collection_ids.length} knowledge collection(s) granted.` });
  } else if (def.tools.some((t) => t.key.startsWith('knowledge.'))) {
    out.push({ key: 'knowledge', ok: true, blocking: false, message: 'No collections chosen: knowledge tools search every collection the person running the agent can read.' });
  }
  const health = router?.health ? router.health() : { configured: [], models: [] };
  const modelOk = def.model === 'auto' ? health.configured.length > 0 : !!health.models?.find((m) => m.id === def.model && m.available);
  out.push({ key: 'model', ok: modelOk, blocking: !modelOk, message: modelOk ? (def.model === 'auto' ? `Runs on ${health.configured[0] || 'the configured model'}.` : `Runs on ${def.model}.`) : def.model === 'auto' ? 'No AI model is configured on this server, so agents cannot run (set a provider key such as ANTHROPIC_API_KEY).' : `The model ${def.model} is not set up on this server.` });
  const protectedTools = def.tools.filter((t) => t.requires_approval || (def.approval.always_for_writes && CATALOG.get(t.key).risk !== 'read'));
  if (protectedTools.length) {
    const approvers = await db.query(
      `SELECT COUNT(*)::int AS n FROM organization_members WHERE organization_id = $1 AND array_position(ARRAY['viewer','member','admin','owner'], role) >= array_position(ARRAY['viewer','member','admin','owner'], $2)`,
      [org.id, def.approval.approver_role],
    );
    out.push({ key: 'approvals', ok: approvers.rows[0].n > 0, blocking: approvers.rows[0].n === 0, message: `${protectedTools.length} tool(s) wait for approval by a ${def.approval.approver_role} or above (${approvers.rows[0].n} can approve).` });
  }
  return out;
}

async function checksFor(db, org, userId, id, opts) {
  const { a } = await loadVisible(db, org, userId, id);
  return checks(db, org, a.owner_user_id, a.draft_definition, opts);
}

// ── Lifecycle ───────────────────────────────────────────────────────────

async function publish(db, org, userId, id, { notes = null, router = null } = {}) {
  const { a } = await loadEditable(db, org, userId, id);
  if (a.status === 'archived') throw conflict('Restore this agent before publishing it.', 'ARCHIVED');
  if (a.published_checksum === a.draft_checksum) throw conflict('This configuration is already the published version.', 'NO_CHANGES');
  const results = await checks(db, org, a.owner_user_id, a.draft_definition, { router });
  const blocking = results.filter((c) => c.blocking);
  if (blocking.length) throw conflict('Fix these before publishing.', 'CHECKS_FAILED', { checks: results });
  const test = await db.query(
    `SELECT 1 FROM platform_agent_executions WHERE organization_id = $1 AND agent_id = $2 AND mode = 'test'
        AND status = 'completed' AND definition_checksum = $3 LIMIT 1`,
    [org.id, id, a.draft_checksum],
  );
  if (!test.rows[0]) throw conflict('Run a test of this exact configuration and let it complete before publishing.', 'TEST_REQUIRED', { checks: results });
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const lock = await client.query('SELECT published_version, status FROM platform_agents WHERE organization_id = $1 AND id = $2 FOR UPDATE', [org.id, id]);
    const version = (lock.rows[0].published_version || 0) + 1;
    await client.query(
      `INSERT INTO platform_agent_versions (organization_id, agent_id, version, definition, checksum, notes, published_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [org.id, id, version, JSON.stringify(a.draft_definition), a.draft_checksum, notes ? String(notes).slice(0, 500) : null, userId],
    );
    const nextStatus = lock.rows[0].status === 'draft' ? 'ready' : lock.rows[0].status;
    await client.query(
      `UPDATE platform_agents SET published_version = $3, status = $4,
              next_scheduled_at = CASE WHEN $4 = 'active' THEN $5::timestamptz ELSE next_scheduled_at END, updated_at = NOW()
        WHERE organization_id = $1 AND id = $2`,
      [org.id, id, version, nextStatus, nextScheduleFor(a.draft_definition, org.timezone)],
    );
    await audit.record(client, { organizationId: org.id, actorUserId: userId, action: 'agent.published', resourceType: 'agent', resourceId: id, detail: { version, checksum: a.draft_checksum } });
    await client.query('COMMIT');
    return { version };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function publishedDefinition(db, orgId, agentId, version) {
  const { rows } = await db.query('SELECT definition, checksum FROM platform_agent_versions WHERE organization_id = $1 AND agent_id = $2 AND version = $3', [orgId, agentId, version]);
  return rows[0] || null;
}

async function activate(db, org, userId, id, { router = null } = {}) {
  const { a } = await loadEditable(db, org, userId, id);
  if (!a.published_version) throw conflict('Publish a version before activating the agent.', 'NOT_PUBLISHED');
  if (a.status === 'active') return { status: 'active', webhookToken: null };
  const pub = await publishedDefinition(db, org.id, id, a.published_version);
  const results = await checks(db, org, a.owner_user_id, pub.definition, { router });
  if (results.some((c) => c.blocking)) throw conflict('The published version cannot run yet.', 'CHECKS_FAILED', { checks: results });
  let token = null;
  let tokenHash = a.webhook_token_hash;
  if (pub.definition.triggers.some((t) => t.type === 'webhook') && !tokenHash) {
    token = crypto.randomBytes(24).toString('hex');
    tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  }
  await db.query(
    `UPDATE platform_agents SET status = 'active', webhook_token_hash = $3, next_scheduled_at = $4, updated_at = NOW() WHERE organization_id = $1 AND id = $2`,
    [org.id, id, tokenHash, nextScheduleFor(pub.definition, org.timezone)],
  );
  await audit.recordSoft(db, { organizationId: org.id, actorUserId: userId, action: 'agent.activated', resourceType: 'agent', resourceId: id, detail: { version: a.published_version } });
  return { status: 'active', webhookToken: token };
}

async function rotateWebhook(db, org, userId, id) {
  const { a } = await loadEditable(db, org, userId, id);
  if (!(a.draft_definition.triggers || []).some((t) => t.type === 'webhook')) throw conflict('This agent has no webhook trigger.', 'NO_WEBHOOK');
  const token = crypto.randomBytes(24).toString('hex');
  await db.query('UPDATE platform_agents SET webhook_token_hash = $3, updated_at = NOW() WHERE organization_id = $1 AND id = $2', [org.id, id, crypto.createHash('sha256').update(token).digest('hex')]);
  await audit.recordSoft(db, { organizationId: org.id, actorUserId: userId, action: 'agent.webhook_rotated', resourceType: 'agent', resourceId: id });
  return { webhookToken: token };
}

async function setStatus(db, org, userId, id, status) {
  const { a } = await loadEditable(db, org, userId, id);
  const allowed = {
    disabled: ['active', 'ready'],
    archived: ['draft', 'ready', 'active', 'disabled'],
    restored: ['archived'],
  };
  if (!allowed[status]?.includes(a.status)) throw conflict(`An agent that is ${a.status} cannot be ${status}.`, 'BAD_TRANSITION');
  const next = status === 'restored' ? (a.published_version ? 'ready' : 'draft') : status;
  await db.query(`UPDATE platform_agents SET status = $3, next_scheduled_at = NULL, updated_at = NOW() WHERE organization_id = $1 AND id = $2`, [org.id, id, next]);
  await audit.recordSoft(db, { organizationId: org.id, actorUserId: userId, action: `agent.${status}`, resourceType: 'agent', resourceId: id });
  return { status: next };
}

// ── Schedules ───────────────────────────────────────────────────────────

function localParts(date, timeZone) {
  try {
    const f = new Intl.DateTimeFormat('en-US', { timeZone: timeZone || 'UTC', hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit' });
    const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
    return { hour: Number(p.hour) % 24, minute: Number(p.minute), weekday: String(p.weekday).toLowerCase().slice(0, 3) };
  } catch {
    return { hour: date.getUTCHours(), minute: date.getUTCMinutes(), weekday: WEEKDAYS[date.getUTCDay()] };
  }
}

/** The next time a definition's schedule fires after `now`, or null. */
function nextScheduleFor(def, timeZone, now = Date.now()) {
  const s = (def.triggers || []).find((t) => t.type === 'schedule');
  if (!s) return null;
  const step = 15 * 60 * 1000;
  let t = Math.floor(now / step) * step + step;
  for (let i = 0; i < 8 * 24 * 4; i += 1, t += step) {
    const p = localParts(new Date(t), timeZone);
    if (p.minute !== 0) continue;
    if (s.every === 'hour') return new Date(t).toISOString();
    if (p.hour !== s.at_hour) continue;
    if (s.every === 'day') return new Date(t).toISOString();
    if (s.every === 'week' && p.weekday === s.weekday) return new Date(t).toISOString();
  }
  return null;
}

module.exports = {
  list, get, getVersion, create, update, duplicate, checks, checksFor, publish, activate, setStatus, rotateWebhook,
  loadVisible, loadEditable, canView, canEdit, publishedDefinition, nextScheduleFor, myTeams,
};
