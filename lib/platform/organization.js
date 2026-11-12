'use strict';
// Organization settings, applications, members, teams and agent policy.
// Every function takes the resolved org (req.org) and the acting user id; the
// route layer has already checked the coarse permission, and this module
// enforces the rules that depend on the target (an admin cannot demote the
// owner, a team member must belong to the organization, ...).

const audit = require('./audit');
const { getApp, enabledApps, catalogFor } = require('./apps');
const { ROLES, RANK } = require('./roles');
const { badRequest, forbidden, notFound, conflict, assertUuid } = require('./errors');

const text = (v, max, what) => {
  if (v == null) return null;
  if (typeof v !== 'string') throw badRequest(`${what} must be text`);
  const t = v.trim();
  if (t.length > max) throw badRequest(`${what} must be at most ${max} characters`);
  return t || null;
};

// ── Organization profile ────────────────────────────────────────────────

async function updateProfile(db, org, actor, input = {}) {
  const sets = [];
  const params = [org.id];
  const put = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };
  if ('name' in input) {
    const name = text(input.name, 120, 'Name');
    if (!name) throw badRequest('Name cannot be empty');
    put('display_name', name);
  }
  if ('industry' in input) put('industry', text(input.industry, 80, 'Industry'));
  if ('operatingContext' in input) put('operating_context', text(input.operatingContext, 2000, 'Operating context'));
  if ('preferences' in input) {
    const p = input.preferences;
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw badRequest('preferences must be an object');
    const clean = {};
    if (p.defaultLanding != null) {
      if (!['/bridge', '/agents', '/command', '/knowledge'].includes(p.defaultLanding)) throw badRequest('defaultLanding is not a workspace page');
      clean.defaultLanding = p.defaultLanding;
    }
    if (p.density != null) {
      if (!['comfortable', 'compact'].includes(p.density)) throw badRequest('density must be comfortable or compact');
      clean.density = p.density;
    }
    put('preferences', JSON.stringify(clean));
  }
  if (!sets.length) throw badRequest('Nothing to update');
  await db.query(`UPDATE organizations SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1`, params);
  await audit.recordSoft(db, { organizationId: org.id, actorUserId: actor, action: 'org.updated', resourceType: 'organization', resourceId: org.id, detail: { fields: Object.keys(input) } });
}

/** First-run setup: identity, context and the apps to start with. */
async function completeSetup(db, org, actor, { name, industry, operatingContext, apps = [] } = {}) {
  if (!Array.isArray(apps)) throw badRequest('apps must be a list');
  for (const k of apps) {
    const a = getApp(k);
    if (!a) throw badRequest(`There is no application called ${k}`);
    if (a.status !== 'available') throw badRequest(`${a.name} is not available yet`);
  }
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await updateProfile(client, org, actor, { name, industry, operatingContext });
    for (const k of new Set(apps)) {
      await client.query(
        `INSERT INTO organization_apps (organization_id, app_key, enabled, enabled_by) VALUES ($1, $2, TRUE, $3)
         ON CONFLICT (organization_id, app_key) DO UPDATE SET enabled = TRUE, enabled_by = $3, updated_at = NOW()`,
        [org.id, k, actor],
      );
    }
    await client.query('UPDATE organizations SET onboarded_at = COALESCE(onboarded_at, NOW()) WHERE id = $1', [org.id]);
    await audit.record(client, { organizationId: org.id, actorUserId: actor, action: 'org.setup_completed', resourceType: 'organization', resourceId: org.id, detail: { industry: industry || null, apps } });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ── Applications ────────────────────────────────────────────────────────

async function listApps(db, org, { industry = null } = {}) {
  return catalogFor(await enabledApps(db, org.id), industry || org.industry);
}

async function setApp(db, org, actor, key, enabled) {
  const app = getApp(key);
  if (!app) throw notFound('That application');
  if (enabled && app.status !== 'available') throw badRequest(`${app.name} is planned and cannot be enabled yet`);
  await db.query(
    `INSERT INTO organization_apps (organization_id, app_key, enabled, enabled_by) VALUES ($1, $2, $3, $4)
     ON CONFLICT (organization_id, app_key) DO UPDATE SET enabled = $3, enabled_by = $4, updated_at = NOW()`,
    [org.id, key, !!enabled, actor],
  );
  await audit.recordSoft(db, { organizationId: org.id, actorUserId: actor, action: enabled ? 'app.enabled' : 'app.disabled', resourceType: 'app', resourceId: key });
}

// ── Members ─────────────────────────────────────────────────────────────

async function listMembers(db, org) {
  const { rows } = await db.query(
    `SELECT m.user_id, m.role, m.created_at, u.email, NULLIF(btrim(COALESCE(u.business_name, '')), '') AS name
       FROM organization_members m JOIN users u ON u.id = m.user_id
      WHERE m.organization_id = $1 ORDER BY array_position(ARRAY['owner','admin','member','viewer'], m.role), m.created_at`,
    [org.id],
  );
  return rows.map((r) => ({ userId: r.user_id, role: r.role, email: r.email, name: r.name, joinedAt: r.created_at }));
}

function assertAssignableRole(role) {
  if (!['admin', 'member', 'viewer'].includes(role)) throw badRequest('Role must be admin, member or viewer. Ownership is transferred separately.');
}

async function addMember(db, org, actor, { email, memberRole }) {
  const e = text(email, 254, 'Email');
  if (!e || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw badRequest('Enter a valid email address');
  assertAssignableRole(memberRole);
  if (memberRole === 'admin' && org.role !== 'owner') throw forbidden('Only the owner can add another admin.');
  const u = await db.query('SELECT id FROM users WHERE lower(email) = lower($1)', [e]);
  if (!u.rows[0]) {
    throw conflict('Nobody has a Starlane account with that email yet. Ask them to sign up, then add them here.', 'USER_NOT_FOUND');
  }
  const ins = await db.query(
    `INSERT INTO organization_members (organization_id, user_id, role, invited_by) VALUES ($1, $2, $3, $4)
     ON CONFLICT (organization_id, user_id) DO NOTHING RETURNING user_id`,
    [org.id, u.rows[0].id, memberRole, actor],
  );
  if (!ins.rows[0]) throw conflict('That person is already a member of this organization.', 'ALREADY_MEMBER');
  await audit.recordSoft(db, { organizationId: org.id, actorUserId: actor, action: 'member.added', resourceType: 'member', resourceId: u.rows[0].id, detail: { role: memberRole } });
  return { userId: u.rows[0].id };
}

async function targetMember(db, org, userId) {
  assertUuid(userId, 'userId');
  const { rows } = await db.query('SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2', [org.id, userId]);
  if (!rows[0]) throw notFound('That member');
  return rows[0];
}

async function changeRole(db, org, actor, userId, memberRole) {
  assertAssignableRole(memberRole);
  const t = await targetMember(db, org, userId);
  if (t.role === 'owner') throw forbidden('The owner\'s role cannot be changed here.');
  if (org.role !== 'owner' && (t.role === 'admin' || memberRole === 'admin')) throw forbidden('Only the owner can change an admin\'s role or make someone an admin.');
  await db.query('UPDATE organization_members SET role = $3, updated_at = NOW() WHERE organization_id = $1 AND user_id = $2', [org.id, userId, memberRole]);
  await audit.recordSoft(db, { organizationId: org.id, actorUserId: actor, action: 'member.role_changed', resourceType: 'member', resourceId: userId, detail: { from: t.role, to: memberRole } });
}

async function removeMember(db, org, actor, userId) {
  const t = await targetMember(db, org, userId);
  if (t.role === 'owner') throw forbidden('The owner cannot be removed.');
  if (t.role === 'admin' && org.role !== 'owner') throw forbidden('Only the owner can remove an admin.');
  await db.query('DELETE FROM organization_members WHERE organization_id = $1 AND user_id = $2', [org.id, userId]);
  await audit.recordSoft(db, { organizationId: org.id, actorUserId: actor, action: 'member.removed', resourceType: 'member', resourceId: userId, detail: { role: t.role } });
}

// ── Teams ───────────────────────────────────────────────────────────────

async function listTeams(db, org, userId) {
  const { rows } = await db.query(
    `SELECT t.id, t.name, t.description, t.created_at,
            COUNT(tm.user_id)::int AS member_count,
            BOOL_OR(tm.user_id = $2) AS is_member,
            COALESCE(json_agg(json_build_object('userId', tm.user_id, 'email', u.email)) FILTER (WHERE tm.user_id IS NOT NULL), '[]') AS members
       FROM platform_teams t
       LEFT JOIN platform_team_members tm ON tm.team_id = t.id
       LEFT JOIN users u ON u.id = tm.user_id
      WHERE t.organization_id = $1
      GROUP BY t.id ORDER BY lower(t.name)`,
    [org.id, userId],
  );
  return rows.map((r) => ({ id: r.id, name: r.name, description: r.description, memberCount: r.member_count, isMember: !!r.is_member, members: r.members, createdAt: r.created_at }));
}

async function createTeam(db, org, actor, { name, description }) {
  const n = text(name, 80, 'Team name');
  if (!n) throw badRequest('Team name cannot be empty');
  try {
    const { rows } = await db.query(
      'INSERT INTO platform_teams (organization_id, name, description, created_by) VALUES ($1, $2, $3, $4) RETURNING id',
      [org.id, n, text(description, 500, 'Description'), actor],
    );
    await audit.recordSoft(db, { organizationId: org.id, actorUserId: actor, action: 'team.created', resourceType: 'team', resourceId: rows[0].id, detail: { name: n } });
    return { id: rows[0].id };
  } catch (err) {
    if (err.code === '23505') throw conflict('A team with that name already exists.');
    throw err;
  }
}

async function teamOf(db, org, teamId) {
  assertUuid(teamId, 'teamId');
  const { rows } = await db.query('SELECT id, name FROM platform_teams WHERE organization_id = $1 AND id = $2', [org.id, teamId]);
  if (!rows[0]) throw notFound('That team');
  return rows[0];
}

async function addTeamMember(db, org, actor, teamId, userId) {
  await teamOf(db, org, teamId);
  await targetMember(db, org, userId);
  await db.query(
    `INSERT INTO platform_team_members (organization_id, team_id, user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [org.id, teamId, userId],
  );
  await audit.recordSoft(db, { organizationId: org.id, actorUserId: actor, action: 'team.member_added', resourceType: 'team', resourceId: teamId, detail: { userId } });
}

async function removeTeamMember(db, org, actor, teamId, userId) {
  await teamOf(db, org, teamId);
  assertUuid(userId, 'userId');
  await db.query('DELETE FROM platform_team_members WHERE organization_id = $1 AND team_id = $2 AND user_id = $3', [org.id, teamId, userId]);
  await audit.recordSoft(db, { organizationId: org.id, actorUserId: actor, action: 'team.member_removed', resourceType: 'team', resourceId: teamId, detail: { userId } });
}

async function deleteTeam(db, org, actor, teamId) {
  await teamOf(db, org, teamId);
  const used = await db.query(
    `SELECT (SELECT COUNT(*) FROM platform_agents WHERE organization_id = $1 AND team_id = $2)::int AS agents,
            (SELECT COUNT(*) FROM platform_knowledge_collections WHERE organization_id = $1 AND team_id = $2)::int AS collections`,
    [org.id, teamId],
  );
  const { agents, collections } = used.rows[0];
  if (agents || collections) throw conflict(`This team still shares ${agents} agent(s) and ${collections} collection(s). Move them first.`, 'TEAM_IN_USE');
  await db.query('DELETE FROM platform_teams WHERE organization_id = $1 AND id = $2', [org.id, teamId]);
  await audit.recordSoft(db, { organizationId: org.id, actorUserId: actor, action: 'team.deleted', resourceType: 'team', resourceId: teamId });
}

async function teamIdsOf(db, orgId, userId) {
  const { rows } = await db.query('SELECT team_id FROM platform_team_members WHERE organization_id = $1 AND user_id = $2', [orgId, userId]);
  return rows.map((r) => r.team_id);
}

// ── Agent policy and limits ─────────────────────────────────────────────

function ceilings(env = process.env) {
  return {
    maxConcurrentExecutions: Math.max(1, Number(env.PLATFORM_MAX_CONCURRENCY_CEILING) || 10),
    dailyExecutionLimit: Math.max(1, Number(env.PLATFORM_DAILY_EXECUTION_CEILING) || 1000),
  };
}

const DEFAULT_POLICY = Object.freeze({
  disabledTools: [],
  defaultApproverRole: 'admin',
  maxConcurrentExecutions: 3,
  dailyExecutionLimit: 200,
  membersMayShareWithOrganization: true,
});

async function getPolicy(db, orgId, env = process.env) {
  const { rows } = await db.query('SELECT policy, updated_at FROM platform_org_policies WHERE organization_id = $1', [orgId]);
  const c = ceilings(env);
  const p = { ...DEFAULT_POLICY, ...(rows[0]?.policy || {}) };
  p.maxConcurrentExecutions = Math.min(p.maxConcurrentExecutions, c.maxConcurrentExecutions);
  p.dailyExecutionLimit = Math.min(p.dailyExecutionLimit, c.dailyExecutionLimit);
  return { ...p, ceilings: c, updatedAt: rows[0]?.updated_at || null };
}

async function updatePolicy(db, org, actor, input = {}, { toolKeys = [] } = {}) {
  const current = await getPolicy(db, org.id);
  const next = {
    disabledTools: current.disabledTools,
    defaultApproverRole: current.defaultApproverRole,
    maxConcurrentExecutions: current.maxConcurrentExecutions,
    dailyExecutionLimit: current.dailyExecutionLimit,
    membersMayShareWithOrganization: current.membersMayShareWithOrganization,
  };
  if ('disabledTools' in input) {
    if (!Array.isArray(input.disabledTools) || input.disabledTools.some((t) => !toolKeys.includes(t))) throw badRequest('disabledTools must list known tools');
    next.disabledTools = [...new Set(input.disabledTools)];
  }
  if ('defaultApproverRole' in input) {
    if (!['owner', 'admin', 'member'].includes(input.defaultApproverRole)) throw badRequest('defaultApproverRole must be owner, admin or member');
    next.defaultApproverRole = input.defaultApproverRole;
  }
  const c = current.ceilings;
  for (const [k, max] of [['maxConcurrentExecutions', c.maxConcurrentExecutions], ['dailyExecutionLimit', c.dailyExecutionLimit]]) {
    if (k in input) {
      const n = Number(input[k]);
      if (!Number.isInteger(n) || n < 1 || n > max) throw badRequest(`${k} must be a whole number from 1 to ${max}`);
      next[k] = n;
    }
  }
  if ('membersMayShareWithOrganization' in input) next.membersMayShareWithOrganization = !!input.membersMayShareWithOrganization;
  await db.query(
    `INSERT INTO platform_org_policies (organization_id, policy, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (organization_id) DO UPDATE SET policy = $2, updated_by = $3, updated_at = NOW()`,
    [org.id, JSON.stringify(next), actor],
  );
  await audit.recordSoft(db, { organizationId: org.id, actorUserId: actor, action: 'policy.updated', resourceType: 'policy', resourceId: org.id, detail: next });
  return getPolicy(db, org.id);
}

module.exports = {
  updateProfile, completeSetup, listApps, setApp,
  listMembers, addMember, changeRole, removeMember,
  listTeams, createTeam, addTeamMember, removeTeamMember, deleteTeam, teamIdsOf,
  getPolicy, updatePolicy, DEFAULT_POLICY, ROLES, RANK,
};
