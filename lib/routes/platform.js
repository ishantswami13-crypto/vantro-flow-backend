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
const invitations = require('../platform/invitations');
const overview = require('../platform/overview');
const audit = require('../platform/audit');
const tools = require('../platform/tools');
const { listTemplates } = require('../platform/templates');
const { draftFromObjective } = require('../platform/drafter');
const multer = require('multer');
const { extractText, MAX_UPLOAD_BYTES } = require('../platform/extract');
const { badRequest } = require('../platform/errors');
const connectorStore = require('../platform/connectors/store');
const { listCatalog } = require('../platform/connectors/catalog');
const auditChain = require('../platform/security/auditChain');
const privacy = require('../platform/security/privacy');
const retention = require('../platform/security/retention');
const { posture } = require('../platform/security/posture');
const { publicFrameworks } = require('../platform/security/frameworks');
const factory = require('../platform/factory');
const mfaPolicy = require('../platform/security/mfaPolicy');
const ssoAdmin = require('../auth/sso');

function publicApiBase(req) {
  return (process.env.PUBLIC_API_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
}
const oauthRedirectUri = (req) => `${publicApiBase(req)}/api/platform/hooks/oauth/callback`;
const appUrl = () => (process.env.PUBLIC_APP_URL || process.env.FRONTEND_URL || 'https://vantro-flow.vercel.app').replace(/\/+$/, '');
const isoOrNull = (v) => {
  if (v == null || v === '') return null;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) throw badRequest('Dates must be ISO timestamps');
  return d.toISOString();
};

// Knowledge file uploads are held in memory only long enough to read their text.
const knowledgeUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 4 } }).single('file');
function receiveFile(req, res) {
  return new Promise((resolve, reject) => knowledgeUpload(req, res, (err) => {
    if (!err) return resolve();
    if (err.code === 'LIMIT_FILE_SIZE') return reject(badRequest('Files up to 15 MB can be added to Knowledge.'));
    return reject(badRequest('The upload could not be read. Send one file in the "file" field.'));
  }));
}

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

function platformRouter({ pool, authMiddleware, router: modelRouter = null, flags = tools.flagOn, onExecutionQueued = null, sendEmail = null }) {
  const r = express.Router();
  r.use(authMiddleware, orgContext(pool));
  // The organization's two-step sign-in rule (lib/platform/security/mfaPolicy.js).
  r.use(mfaPolicy.gate(pool));
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
      security: {
        mfaRequiredFor: req.mfaPolicy || 'none',
        sessionMaxHours: req.sessionMaxHours || null,
        mfaSatisfied: req.mfaSatisfied !== false,
        mfaEnabled: await require('./accountSecurity').hasSecondFactor(pool, me(req)),
        signedInWith: req.user.sso ? 'sso' : req.user.mfa === true ? 'mfa' : 'password',
      },
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
  r.get('/invitations', requirePermission('members.manage'), wrap(async (req) => ({ invitations: await invitations.list(pool, req.org) })));
  r.post('/invitations', requirePermission('members.manage'), wrap(async (req, res) => {
    res.status(201);
    return invitations.create(pool, req.org, me(req), { email: req.body?.email, memberRole: req.body?.memberRole, sendEmail: req.body?.sendEmail === true }, { send: sendEmail });
  }));
  r.delete('/invitations/:id', requirePermission('members.manage'), wrap(async (req) => { await invitations.revoke(pool, req.org, me(req), req.params.id); }));
  // The invited person: any signed-in account may look; only the invited, verified email can accept.
  r.get('/invitations/by-token/:token', wrap(async (req) => ({ invitation: await invitations.preview(pool, me(req), req.params.token) })));
  r.post('/invitations/by-token/:token/accept', wrap(async (req) => invitations.accept(pool, me(req), req.params.token)));
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
    actions: ['factory.build', 'connection.created', 'connection.authorized', 'connection.deleted', 'agent.created', 'agent.published', 'agent.activated', 'agent.disabled', 'agent.archived', 'execution.requested', 'execution.completed', 'execution.failed', 'execution.cancelled', 'approval.requested', 'approval.approved', 'approval.rejected', 'knowledge.collection_created', 'knowledge.document_added'],
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
  // PDF, Word (.docx) or text file: the server reads the text, the file itself is not kept.
  r.post('/knowledge/collections/:id/documents/upload', requirePermission('knowledge.write'), wrap(async (req, res) => {
    await receiveFile(req, res);
    if (!req.file) throw badRequest('Choose a file to upload.');
    const { text, mimeType, pages } = await extractText(req.file.buffer);
    const name = String(req.file.originalname || 'Document').slice(0, 200);
    const title = String(req.body?.title || '').trim() || name.replace(/\.[A-Za-z0-9]{1,5}$/, '') || 'Document';
    const out = await knowledge.addDocument(pool, req.org, me(req), req.params.id, { title, content: text, sourceName: name, mimeType, sourceKind: 'upload' });
    res.status(201);
    return { ...out, extracted: { kind: mimeType, characters: text.length, ...(pages ? { pages } : {}) } };
  }));
  r.delete('/knowledge/collections/:id/documents/:docId', requirePermission('knowledge.write'), wrap(async (req) => { await knowledge.deleteDocument(pool, req.org, me(req), req.params.id, req.params.docId); }));
  r.get('/knowledge/search', wrap(async (req) => knowledge.search(pool, req.org.id, me(req), req.query.q, { limit: req.query.limit })));
  r.get('/knowledge/documents/:docId', wrap(async (req) => ({ document: await knowledge.readDocument(pool, req.org.id, me(req), req.params.docId, { maxChars: 200000 }) })));

  // ── Connectors: any software, by OpenAPI, catalog or MCP ───────────────
  r.get('/connectors/catalog', requirePermission('connectors.view'), wrap(async (req) => ({ catalog: listCatalog(), oauthRedirectUri: oauthRedirectUri(req) })));
  r.get('/connectors', requirePermission('connectors.view'), wrap(async (req) => ({ connections: await connectorStore.list(pool, req.org) })));
  r.get('/connectors/calls', requirePermission('connectors.use'), wrap(async (req) => ({ calls: await connectorStore.listCalls(pool, req.org, { connectionId: req.query.connectionId || null, limit: req.query.limit }) })));
  r.post('/connectors/openapi/preview', requirePermission('connectors.manage'), wrap(async (req) => {
    const p = await connectorStore.previewSpec({ spec: req.body?.spec, specUrl: req.body?.specUrl, readOnly: req.body?.readOnly === true });
    return { preview: { ...p, operations: p.operations.map((o) => ({ id: o.id, method: o.method, path: o.path, summary: o.summary, risk: o.risk })) } };
  }));
  r.post('/connectors/openapi', requirePermission('connectors.manage'), wrap(async (req, res) => {
    res.status(201);
    return { connection: await connectorStore.createFromSpec(pool, req.org, me(req), req.body || {}) };
  }));
  r.post('/connectors/catalog', requirePermission('connectors.manage'), wrap(async (req, res) => {
    res.status(201);
    return { connection: await connectorStore.createFromCatalog(pool, req.org, me(req), req.body || {}) };
  }));
  r.post('/connectors/mcp', requirePermission('connectors.manage'), wrap(async (req, res) => {
    res.status(201);
    return { connection: await connectorStore.createMcp(pool, req.org, me(req), req.body || {}) };
  }));
  r.get('/connectors/:id', requirePermission('connectors.view'), wrap(async (req) => ({ connection: await connectorStore.get(pool, req.org, req.params.id) })));
  r.post('/connectors/:id/:action(enable|disable)', requirePermission('connectors.manage'), wrap(async (req) => connectorStore.setStatus(pool, req.org, me(req), req.params.id, req.params.action === 'enable')));
  r.put('/connectors/:id/credentials', requirePermission('connectors.manage'), wrap(async (req) => connectorStore.setCredentials(pool, req.org, me(req), req.params.id, req.body || {})));
  r.post('/connectors/:id/refresh-tools', requirePermission('connectors.manage'), wrap(async (req) => ({ connection: await connectorStore.refreshMcpTools(pool, req.org, me(req), req.params.id) })));
  r.post('/connectors/:id/authorize', requirePermission('connectors.manage'), wrap(async (req) => connectorStore.startOAuth(pool, req.org, me(req), req.params.id, { redirectUri: oauthRedirectUri(req), returnTo: req.body?.returnTo || null })));
  // A person tries an operation. Members may call read operations; an
  // operation that changes something in the other app needs an admin and an
  // explicit confirm: true.
  r.post('/connectors/:id/call', requirePermission('connectors.use'), wrap(async (req) => {
    const allowExternal = can(req.org.role, 'connectors.manage') && req.body?.confirm === true;
    const out = await connectorStore.callOperation(pool, req.org, {
      connectionId: req.params.id, operationId: req.body?.operationId, params: req.body?.params || {}, body: req.body?.body ?? null,
      actorKind: 'user', actorUserId: me(req), allowRisk: allowExternal ? 'external' : 'read',
      idempotencyKey: req.get('idempotency-key') || null,
    });
    return { result: { ...out, json: tools.truncateResult(out.json ?? null).value } };
  }));
  r.delete('/connectors/:id', requirePermission('connectors.manage'), wrap(async (req) => { await connectorStore.remove(pool, req.org, me(req), req.params.id); }));

  // ── Security, audit evidence, retention ────────────────────────────────
  r.get('/security/posture', requirePermission('security.view'), wrap(async (req) => posture(pool, req.org)));
  r.get('/security/audit/verify', requirePermission('audit.view'), wrap(async (req) => ({ verification: await auditChain.verify(pool, req.org.id) })));
  r.get('/security/audit/export', requirePermission('audit.view'), async (req, res) => {
    try {
      const body = await auditChain.exportEvents(pool, req.org.id, { from: isoOrNull(req.query.from), to: isoOrNull(req.query.to) });
      await audit.recordSoft(pool, { organizationId: req.org.id, actorUserId: me(req), action: 'audit.exported', resourceType: 'audit', detail: { from: req.query.from || null, to: req.query.to || null } });
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="starlane-audit-${new Date().toISOString().slice(0, 10)}.jsonl"`);
      res.send(body);
    } catch (err) { send(res, err); }
  });
  r.get('/security/retention', requirePermission('security.view'), wrap(async (req) => ({ policy: await retention.getPolicy(pool, req.org.id), classes: retention.CLASSES })));
  r.put('/security/retention', requirePermission('policies.manage'), wrap(async (req) => ({ policy: await retention.setPolicy(pool, req.org, me(req), req.body || {}) })));
  r.post('/security/retention/apply', requirePermission('policies.manage'), wrap(async (req) => retention.applyForOrganization(pool, req.org, { actorUserId: me(req) })));

  // ── Sign-in security: MFA rule and single sign-on ──────────────────────
  r.get('/security/mfa-policy', wrap(async (req) => ({ requiredFor: await mfaPolicy.getPolicy(pool, req.org.id, { fresh: true }), values: mfaPolicy.VALUES })));
  r.put('/security/mfa-policy', requirePermission('policies.manage'), wrap(async (req) => mfaPolicy.setPolicy(pool, req.org, me(req), req.user, req.body?.requiredFor)));
  r.get('/security/session-policy', wrap(async (req) => ({ maxHours: await mfaPolicy.getSessionMaxHours(pool, req.org.id, { fresh: true }) })));
  r.put('/security/session-policy', requirePermission('policies.manage'), wrap(async (req) => mfaPolicy.setSessionMaxHours(pool, req.org, me(req), req.body?.maxHours)));
  const ssoRedirect = (req) => `${publicApiBase(req)}/api/auth/sso/callback`;
  r.get('/sso', requirePermission('sso.manage'), wrap(async (req) => ssoAdmin.view(pool, req.org, { redirectUri: ssoRedirect(req) })));
  r.put('/sso', requirePermission('sso.manage'), wrap(async (req) => { await ssoAdmin.save(pool, req.org, me(req), req.body || {}); return ssoAdmin.view(pool, req.org, { redirectUri: ssoRedirect(req) }); }));
  r.delete('/sso', requirePermission('sso.manage'), wrap(async (req) => { await ssoAdmin.remove(pool, req.org, me(req)); }));
  r.put('/sso/enforce', requirePermission('sso.manage'), wrap(async (req) => { await ssoAdmin.setEnforce(pool, req.org, me(req), req.body?.enforce === true); return ssoAdmin.view(pool, req.org, { redirectUri: ssoRedirect(req) }); }));
  r.post('/sso/test', requirePermission('sso.manage'), wrap(async (req) => ssoAdmin.start(pool, { organizationId: req.org.id, mode: 'test', startedBy: me(req), redirectUri: ssoRedirect(req) })));
  r.post('/sso/domains', requirePermission('sso.manage'), wrap(async (req, res) => { await ssoAdmin.addDomain(pool, req.org, me(req), req.body?.domain); res.status(201); return ssoAdmin.view(pool, req.org, { redirectUri: ssoRedirect(req) }); }));
  r.post('/sso/domains/:domain/verify', requirePermission('sso.manage'), wrap(async (req) => { await ssoAdmin.verifyDomain(pool, req.org, me(req), req.params.domain); return ssoAdmin.view(pool, req.org, { redirectUri: ssoRedirect(req) }); }));
  r.delete('/sso/domains/:domain', requirePermission('sso.manage'), wrap(async (req) => { await ssoAdmin.removeDomain(pool, req.org, me(req), req.params.domain); }));

  // ── Privacy: export and erasure (GDPR / CCPA / DPDP) ───────────────────
  r.get('/privacy/export', async (req, res) => {
    try {
      const scope = req.query.scope === 'organization' ? 'organization' : 'me';
      if (scope === 'organization' && !can(req.org.role, 'privacy.export_org')) return res.status(403).json({ success: false, code: 'FORBIDDEN', error: 'Only the organization\'s owner can export all of its data.' });
      const data = await privacy.exportData(pool, req.org, me(req), { scope });
      res.setHeader('Content-Disposition', `attachment; filename="starlane-data-${scope}-${new Date().toISOString().slice(0, 10)}.json"`);
      res.json(data);
    } catch (err) { send(res, err); }
  });
  r.get('/privacy/requests', wrap(async (req) => ({ requests: await privacy.listRequests(pool, req.org, me(req), { all: can(req.org.role, 'security.view') }), erasure: { enabled: privacy.erasureEnabled(), graceDays: privacy.graceDays() } })));
  r.post('/privacy/erasure', wrap(async (req, res) => {
    res.status(201);
    return privacy.requestErasure(pool, me(req), { confirmEmail: req.body?.confirmEmail });
  }));
  r.post('/privacy/erasure/:id/cancel', wrap(async (req) => privacy.cancelErasure(pool, me(req), req.params.id)));

  // ── Agent factory ──────────────────────────────────────────────────────
  r.get('/factory', requirePermission('agents.view'), wrap(async (req) => {
    const described = new Map((await describeTools(req.org)).map((t) => [t.key, t]));
    return factory.overview(pool, req.org, { describeTool: (k) => described.get(k) });
  }));
  r.post('/factory/builds', requirePermission('factory.build'), wrap(async (req, res) => {
    const described = new Map((await describeTools(req.org)).map((t) => [t.key, t]));
    const out = await factory.build(pool, req.org, me(req), req.body || {}, { describeTool: (k) => described.get(k), router: modelRouter });
    for (const id of out.testExecutionIds) queued({ id });
    res.status(201);
    return out;
  }));

  // ── Connections and Command Center ─────────────────────────────────────
  r.get('/connections', wrap(async (req) => overview.connections(pool, req.org, { flags })));
  r.get('/command-center', wrap(async (req) => overview.commandCenter(pool, req.org, me(req), { router: modelRouter })));

  return r;
}

/** Public webhook trigger for agents. The token is the credential. */
function platformHooksRouter({ pool, onExecutionQueued = null }) {
  const r = express.Router();
  // OAuth 2.0 redirect back from a connected app. No session cookie or
  // bearer token arrives here; the single-use state issued to a signed-in
  // admin identifies the connection (connectors/store.completeOAuth).
  r.get('/oauth/callback', async (req, res) => {
    let out;
    try {
      out = await connectorStore.completeOAuth(pool, { state: req.query.state, code: req.query.code, error: req.query.error });
    } catch (err) {
      console.error('[platform oauth callback]', err.message);
      out = { ok: false, returnTo: '/connectors', message: 'Starlane could not finish connecting the app.' };
    }
    const u = new URL(`${appUrl()}${out.returnTo || '/connectors'}`);
    u.searchParams.set('connector', out.ok ? 'connected' : 'error');
    u.searchParams.set('message', String(out.message || '').slice(0, 200));
    res.redirect(303, u.toString());
  });
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

/** Public: the frameworks and their honest status, for the trust page. */
function trustRouter() {
  const r = express.Router();
  r.get('/', (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=300');
    const pub = require('../platform/security/publicControls');
    res.json({
      success: true, frameworks: publicFrameworks(), certifications: [],
      statement: 'Starlane holds no security certification or audit report today. Each framework below lists the technical controls built toward it and what is still needed.',
      designedAround: pub.STATEMENT, controls: pub.CONTROLS, notYet: pub.NOT_YET,
    });
  });
  return r;
}

module.exports = { platformRouter, platformHooksRouter, trustRouter };
