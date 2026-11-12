'use strict';
// /api/platform: the universal workspace API (organizations, applications,
// members, teams, policies, Agent Studio, executions, approvals, knowledge,
// connections, Command Center, audit).
//
// Every route runs authMiddleware (JWT), then orgContext (membership of the
// organization named by X-Starlane-Org, or the caller's own), then a role
// permission check. Resource-level rules live in lib/platform/*. Nothing here
// trusts an organization or user id from the request body.

const express = require('express');
const { orgContext, requirePermission, actorId, listMemberships } = require('../platform/context');
const org = require('../platform/organization');
const { buildNavigation } = require('../platform/navigation');
const { enabledApps, getApp } = require('../platform/apps');
const { permissionsFor, can } = require('../platform/roles');
const agents = require('../platform/agents');
const engine = require('../platform/engine');
const approvals = require('../platform/approvals');
const knowledge = require('../platform/knowledge');
const overview = require('../platform/overview');
const audit = require('../platform/audit');
const tools = require('../platform/tools');
const { listTemplates } = require('../platform/templates');
const { draftFromObjective } = require('../platform/drafter');

function send(res, err) {
  const status = err.status || 500;
  if (status >= 500) console.error('[platform]', err.message);
  const body = { success: false, code: err.code || 'INTERNAL', error: status >= 500 ? 'Something went wrong on our side. Try again.' : err.message };
  if (err.detail && status < 500) body.detail = err.detail;
  res.status(status).json(body);
}

const wrap = (fn) => async (req, res) => {
  try {
    const out = await fn(req, res);
    if (!res.headersSent) res.json({ success: true, ...(out || {}) });
  } catch (err) {
    send(res, err);
  }
};

function platformRouter({ pool, authMiddleware, router: modelRouter = null, flags = tools.flagOn, onExecutionQueued = null }) {
  const r = express.Router();
  r.use(authMiddleware, orgContext(pool));
  const me = actorId;
  const describeTools = async (o) => {
    const ctx = await tools.availabilityContext(pool, o, { flags });
    const policy = await org.getPolicy(pool, o.id);
    return tools.describe(ctx, policy);
  };
  const queued = (exec) => { if (onExecutionQueued) Promise.resolve().then(() => onExecutionQueued(exec)).catch(() => {}); };

  // ── Workspace ──────────────────────────────────────────────────────────
  r.get('/workspace', wrap(async (req) => {
    const apps = await enabledApps(pool, req.org.id);
    const memberships = await listMemberships(pool, me(req));
    return {
      organization: req.org,
      role: req.org.role,
      permissions: permissionsFor(req.org.role),
      apps: [...apps],
      navigation: buildNavigation({ role: req.org.role, enabledApps: apps }),
      organizations: memberships.map((m) => ({ id: m.id, name: m.name, role: m.role })),
      needsSetup: !req.org.onboarded && can(req.org.role, 'org.manage'),
      model: modelRouter?.health ? { configured: modelRouter.health().configured.length > 0 } : { configured: false },
    };
  }));

  /** Server-side check a page makes before it renders an application. */
  r.get('/apps/:key/access', wrap(async (req) => {
    const app = getApp(req.params.key);
    if (!app) return { enabled: false, reason: 'unknown' };
    const apps = await enabledApps(pool, req.org.id);
    return { enabled: apps.has(app.key), app: { key: app.key, name: app.name }, canEnable: can(req.org.role, 'apps.manage') };
  }));

  // ── Organization ───────────────────────────────────────────────────────
  r.patch('/organization', requirePermission('org.manage'), wrap(async (req) => { await org.updateProfile(pool, req.org, me(req), req.body || {}); }));
  r.post('/organization/setup', requirePermission('org.manage'), wrap(async (req) => { await org.completeSetup(pool, req.org, me(req), req.body || {}); }));
  // ?industry= previews the suggestions for an industry typed during setup (nothing is saved).
  r.get('/apps', wrap(async (req) => ({ apps: await org.listApps(pool, req.org, { industry: typeof req.query.industry === 'string' ? req.query.industry.slice(0, 80) : null }) })));
  r.put('/apps/:key', requirePermission('apps.manage'), wrap(async (req) => { await org.setApp(pool, req.org, me(req), req.params.key, req.body?.enabled === true); }));

  r.get('/members', wrap(async (req) => ({ members: await org.listMembers(pool, req.org) })));
  r.post('/members', requirePermission('members.manage'), wrap(async (req) => org.addMember(pool, req.org, me(req), { email: req.body?.email, memberRole: req.body?.memberRole })));
  r.patch('/members/:userId', requirePermission('members.manage'), wrap(async (req) => { await org.changeRole(pool, req.org, me(req), req.params.userId, req.body?.memberRole); }));
  r.delete('/members/:userId', requirePermission('members.manage'), wrap(async (req) => { await org.removeMember(pool, req.org, me(req), req.params.userId); }));

  r.get('/teams', wrap(async (req) => ({ teams: await org.listTeams(pool, req.org, me(req)) })));
  r.post('/teams', requirePermission('teams.manage'), wrap(async (req) => org.createTeam(pool, req.org, me(req), req.body || {})));
  r.delete('/teams/:id', requirePermission('teams.manage'), wrap(async (req) => { await org.deleteTeam(pool, req.org, me(req), req.params.id); }));
  r.post('/teams/:id/members', requirePermission('teams.manage'), wrap(async (req) => { await org.addTeamMember(pool, req.org, me(req), req.params.id, req.body?.memberUserId); }));
  r.delete('/teams/:id/members/:userId', requirePermission('teams.manage'), wrap(async (req) => { await org.removeTeamMember(pool, req.org, me(req), req.params.id, req.params.userId); }));

  r.get('/policies', wrap(async (req) => ({ policy: await org.getPolicy(pool, req.org.id) })));
  r.put('/policies', requirePermission('policies.manage'), wrap(async (req) => ({ policy: await org.updatePolicy(pool, req.org, me(req), req.body || {}, { toolKeys: tools.TOOLS.map((t) => t.key) }) })));
  r.get('/usage', requirePermission('usage.view'), wrap(async (req) => overview.usage(pool, req.org)));
  r.get('/audit', requirePermission('audit.view'), wrap(async (req) => audit.list(pool, req.org.id, { cursor: req.query.cursor, limit: req.query.limit, resourceType: req.query.resourceType || null })));
  // Activity: what members may see (agent runs and approvals, not admin changes).
  r.get('/activity', wrap(async (req) => audit.list(pool, req.org.id, {
    cursor: req.query.cursor, limit: req.query.limit,
    actions: ['agent.created', 'agent.published', 'agent.activated', 'agent.disabled', 'agent.archived', 'execution.requested', 'execution.completed', 'execution.failed', 'execution.cancelled', 'approval.requested', 'approval.approved', 'approval.rejected', 'knowledge.collection_created', 'knowledge.document_added'],
  })));

  // ── Agent Studio ───────────────────────────────────────────────────────
  r.get('/tools', wrap(async (req) => ({ tools: await describeTools(req.org) })));
  r.get('/templates', wrap(async (req) => {
    const described = new Map((await describeTools(req.org)).map((t) => [t.key, t]));
    return { templates: listTemplates((k) => described.get(k)) };
  }));
  r.post('/agents/draft', requirePermission('agents.create'), wrap(async (req) => {
    const described = new Map((await describeTools(req.org)).map((t) => [t.key, t]));
    return draftFromObjective(req.body?.objective, { router: modelRouter, userId: req.org.ownerUserId, describeTool: (k) => described.get(k) });
  }));
  r.get('/agents', wrap(async (req) => agents.list(pool, req.org, me(req), { view: req.query.view || 'all', q: req.query.q || null })));
  r.post('/agents', requirePermission('agents.create'), wrap(async (req) => agents.create(pool, req.org, me(req), {
    definition: req.body?.definition || null, templateKey: req.body?.templateKey || null, visibility: req.body?.visibility || 'private', teamId: req.body?.teamId || null,
  })));
  r.get('/agents/:id', wrap(async (req) => ({ agent: await agents.get(pool, req.org, me(req), req.params.id) })));
  r.patch('/agents/:id', requirePermission('agents.create'), wrap(async (req) => { await agents.update(pool, req.org, me(req), req.params.id, { definition: req.body?.definition, visibility: req.body?.visibility, teamId: req.body?.teamId }); }));
  r.get('/agents/:id/checks', wrap(async (req) => ({ checks: await agents.checksFor(pool, req.org, me(req), req.params.id, { router: modelRouter }) })));
  r.get('/agents/:id/versions/:version', wrap(async (req) => ({ version: await agents.getVersion(pool, req.org, me(req), req.params.id, req.params.version) })));
  r.post('/agents/:id/duplicate', requirePermission('agents.create'), wrap(async (req) => agents.duplicate(pool, req.org, me(req), req.params.id)));
  r.post('/agents/:id/publish', requirePermission('agents.create'), wrap(async (req) => agents.publish(pool, req.org, me(req), req.params.id, { notes: req.body?.notes, router: modelRouter })));
  r.post('/agents/:id/activate', requirePermission('agents.create'), wrap(async (req) => agents.activate(pool, req.org, me(req), req.params.id, { router: modelRouter })));
  r.post('/agents/:id/deactivate', requirePermission('agents.create'), wrap(async (req) => agents.setStatus(pool, req.org, me(req), req.params.id, 'disabled')));
  r.post('/agents/:id/archive', requirePermission('agents.create'), wrap(async (req) => agents.setStatus(pool, req.org, me(req), req.params.id, 'archived')));
  r.post('/agents/:id/restore', requirePermission('agents.create'), wrap(async (req) => agents.setStatus(pool, req.org, me(req), req.params.id, 'restored')));
  r.post('/agents/:id/webhook', requirePermission('agents.create'), wrap(async (req) => agents.rotateWebhook(pool, req.org, me(req), req.params.id)));

  const runRoute = (mode) => wrap(async (req, res) => {
    const { execution, deduplicated } = await engine.enqueue(pool, req.org, me(req), req.params.id, {
      mode, input: req.body?.input || {}, idempotencyKey: req.get('idempotency-key') || req.body?.idempotencyKey || null,
    });
    if (!deduplicated) queued(execution);
    res.status(deduplicated ? 200 : 202);
    return { executionId: execution.id, status: execution.status, deduplicated };
  });
  r.post('/agents/:id/test', requirePermission('agents.create'), runRoute('test'));
  r.post('/agents/:id/run', requirePermission('agents.run'), runRoute('live'));

  // ── Executions ─────────────────────────────────────────────────────────
  r.get('/executions', wrap(async (req) => engine.listExecutions(pool, req.org, me(req), {
    agentId: req.query.agentId || null, status: req.query.status || null, mode: req.query.mode || null, cursor: req.query.cursor || null, limit: req.query.limit,
  })));
  r.get('/executions/:id', wrap(async (req) => ({ execution: await engine.getExecution(pool, req.org, me(req), req.params.id) })));
  r.post('/executions/:id/cancel', requirePermission('agents.run'), wrap(async (req) => engine.cancel(pool, req.org, me(req), req.params.id)));
  r.post('/executions/:id/rerun', requirePermission('agents.run'), wrap(async (req, res) => {
    const { execution } = await engine.rerun(pool, req.org, me(req), req.params.id);
    queued(execution);
    res.status(202);
    return { executionId: execution.id, status: execution.status };
  }));

  // ── Approvals ──────────────────────────────────────────────────────────
  r.get('/approvals/summary', wrap(async (req) => approvals.summary(pool, req.org, me(req))));
  r.get('/approvals', wrap(async (req) => approvals.list(pool, req.org, me(req), { status: req.query.status || 'pending', cursor: req.query.cursor || null, limit: req.query.limit })));
  r.get('/approvals/:id', wrap(async (req) => ({ approval: await approvals.get(pool, req.org, me(req), req.params.id) })));
  r.post('/approvals/:id/decision', wrap(async (req) => {
    const out = await approvals.decide(pool, req.org, me(req), req.params.id, { decision: req.body?.decision, note: req.body?.note });
    if (out.executionResumed) queued({ id: null });
    return out;
  }));

  // ── Knowledge ──────────────────────────────────────────────────────────
  r.get('/knowledge/collections', wrap(async (req) => ({ collections: await knowledge.listCollections(pool, req.org, me(req)) })));
  r.post('/knowledge/collections', requirePermission('knowledge.write'), wrap(async (req) => knowledge.createCollection(pool, req.org, me(req), req.body || {})));
  r.delete('/knowledge/collections/:id', requirePermission('knowledge.write'), wrap(async (req) => { await knowledge.deleteCollection(pool, req.org, me(req), req.params.id); }));
  r.get('/knowledge/collections/:id/documents', wrap(async (req) => ({ documents: await knowledge.listDocuments(pool, req.org, me(req), req.params.id) })));
  r.post('/knowledge/collections/:id/documents', requirePermission('knowledge.write'), wrap(async (req, res) => {
    res.status(201);
    return knowledge.addDocument(pool, req.org, me(req), req.params.id, req.body || {});
  }));
  r.delete('/knowledge/collections/:id/documents/:docId', requirePermission('knowledge.write'), wrap(async (req) => { await knowledge.deleteDocument(pool, req.org, me(req), req.params.id, req.params.docId); }));
  r.get('/knowledge/search', wrap(async (req) => knowledge.search(pool, req.org.id, me(req), req.query.q, { limit: req.query.limit })));
  r.get('/knowledge/documents/:docId', wrap(async (req) => ({ document: await knowledge.readDocument(pool, req.org.id, me(req), req.params.docId, { maxChars: 200000 }) })));

  // ── Connections and Command Center ─────────────────────────────────────
  r.get('/connections', wrap(async (req) => overview.connections(pool, req.org, { flags })));
  r.get('/command-center', wrap(async (req) => overview.commandCenter(pool, req.org, me(req), { router: modelRouter })));

  return r;
}

/** Public webhook trigger for agents. The token is the credential. */
function platformHooksRouter({ pool, onExecutionQueued = null }) {
  const r = express.Router();
  r.post('/agents/:token', async (req, res) => {
    try {
      const out = await engine.receiveWebhook(pool, req.params.token, req.body, req.get('idempotency-key') || null);
      if (!out.deduplicated && onExecutionQueued) Promise.resolve().then(() => onExecutionQueued({ id: out.executionId })).catch(() => {});
      res.status(out.deduplicated ? 200 : 202).json({ success: true, ...out });
    } catch (err) {
      send(res, err);
    }
  });
  return r;
}

module.exports = { platformRouter, platformHooksRouter };
