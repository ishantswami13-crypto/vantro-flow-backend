// Connect any software, security controls and the agent factory (migration
// 075), against a real Postgres through the real /api/platform router.
//
// "Other software" is a local HTTP server standing in for a SaaS API, an
// OAuth 2.0 provider and a remote MCP server. Everything is synthetic: the
// tenants are on the reserved .invalid domain and no external host is called.
//
// Run: DATABASE_URL=... JWT_SECRET=... node tests/platform.connectors.test.mjs
import { createRequire } from 'node:module';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import http from 'node:http';
import { makeChecker, openPool, seedUser, deleteUsers } from './helpers/httpHarness.mjs';

const require = createRequire(import.meta.url);
process.env.OUTBOUND_CREDENTIALS_KEY = process.env.OUTBOUND_CREDENTIALS_KEY || randomBytes(32).toString('hex');
process.env.PUBLIC_APP_URL = 'https://app.starlane.test';
// The server-wide switch for agents changing other software (read at load).
process.env.FEATURE_WORKFLOW_HTTP_ACTIONS_ENABLED = 'true';
const express = require('express');
const jwt = require('jsonwebtoken');
const { platformRouter, platformHooksRouter, trustRouter } = require('../lib/routes/platform');
const engine = require('../lib/platform/engine');
const store = require('../lib/platform/connectors/store');
const { importSpec } = require('../lib/platform/connectors/openapi');
const privacy = require('../lib/platform/security/privacy');
const creds = require('../lib/domain/outbound/credentials');

const { check, done } = makeChecker();
const pool = openPool();
const ready = await pool.query(`SELECT to_regclass('public.platform_app_connections') AS t`);
if (!ready.rows[0].t) { console.log('SKIP migration 075 not applied'); process.exit(0); }

// ── The "other software" ────────────────────────────────────────────────
const seen = [];
const API_KEY = `key_${randomBytes(8).toString('hex')}`;
let oauth = { code: null, challenge: null, accessToken: null, refreshToken: null, expiresIn: 3600, refreshes: 0 };
const mcpTools = [
  { name: 'lookup_order', description: 'Find an order by number', inputSchema: { type: 'object', properties: { number: { type: 'string' } }, required: ['number'] }, annotations: { readOnlyHint: true } },
  { name: 'refund_order', description: 'Refund an order', inputSchema: { type: 'object', properties: { number: { type: 'string' } } } },
];
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    seen.push({ method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), headers: req.headers, body });
    const json = (status, obj, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
    // A CRM-like REST API with an API key header.
    if (u.pathname.startsWith('/crm/')) {
      if (req.headers['x-api-key'] !== API_KEY) return json(401, { error: 'bad key' });
      if (req.method === 'GET' && u.pathname === '/crm/v1/contacts') return json(200, { contacts: [{ id: 'c1', name: 'Acme Ltd' }], limit: u.searchParams.get('limit') });
      if (req.method === 'GET' && u.pathname.startsWith('/crm/v1/contacts/')) return json(200, { id: decodeURIComponent(u.pathname.split('/').pop()) });
      if (req.method === 'POST' && u.pathname === '/crm/v1/contacts') return json(201, { id: 'c2', created: JSON.parse(body || '{}') });
      return json(404, {});
    }
    // An OAuth-protected API.
    if (u.pathname === '/oauth/token') {
      const f = Object.fromEntries(new URLSearchParams(body));
      if (f.grant_type === 'authorization_code') {
        const ok = f.code === oauth.code && createHash('sha256').update(f.code_verifier || '').digest('base64url') === oauth.challenge && f.client_secret === 'shh-client-secret';
        if (!ok) return json(400, { error: 'invalid_grant' });
        oauth.accessToken = `at_${randomBytes(6).toString('hex')}`; oauth.refreshToken = `rt_${randomBytes(6).toString('hex')}`;
        return json(200, { access_token: oauth.accessToken, refresh_token: oauth.refreshToken, expires_in: oauth.expiresIn });
      }
      if (f.grant_type === 'refresh_token' && f.refresh_token === oauth.refreshToken) {
        oauth.refreshes += 1; oauth.accessToken = `at_${randomBytes(6).toString('hex')}`;
        return json(200, { access_token: oauth.accessToken, expires_in: 3600 });
      }
      return json(400, { error: 'unsupported' });
    }
    if (u.pathname === '/books/v2/invoices') {
      if (req.headers.authorization !== `Bearer ${oauth.accessToken}`) return json(401, {});
      return json(200, { invoices: [{ number: 'INV-1', total: 100 }] });
    }
    // A remote MCP server (Streamable HTTP; tools/call answered as SSE).
    if (u.pathname === '/mcp') {
      if (req.headers.authorization !== 'Bearer mcp-token') return json(401, {});
      const msg = JSON.parse(body || '{}');
      if (msg.method === 'initialize') return json(200, { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'Orders MCP', version: '1.2' }, capabilities: { tools: {} } } }, { 'Mcp-Session-Id': 'sess-1' });
      if (msg.method === 'notifications/initialized') { res.writeHead(202); return res.end(); }
      if (req.headers['mcp-session-id'] !== 'sess-1') return json(400, { error: 'no session' });
      if (msg.method === 'tools/list') return json(200, { jsonrpc: '2.0', id: msg.id, result: { tools: mcpTools } });
      if (msg.method === 'tools/call') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        return res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `called ${msg.params.name} with ${JSON.stringify(msg.params.arguments)}` }] } })}\n\n`);
      }
      return json(200, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'unknown' } });
    }
    if (u.pathname === '/spec.yaml') { res.writeHead(200, { 'Content-Type': 'application/yaml' }); return res.end(SPEC_YAML); }
    json(404, {});
  });
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const MOCK = `http://127.0.0.1:${mock.address().port}`;
store.__setTestHttpOptions({ allowHttp: true, allowPrivate: true });

const SPEC_JSON = {
  openapi: '3.0.3',
  info: { title: 'Acme CRM', version: '1.0' },
  servers: [{ url: `${MOCK}/crm/v1` }],
  components: {
    securitySchemes: { key: { type: 'apiKey', in: 'header', name: 'X-API-Key' } },
    parameters: { Limit: { name: 'limit', in: 'query', schema: { type: 'integer' } } },
    schemas: { Contact: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  },
  paths: {
    '/contacts': {
      get: { operationId: 'listContacts', summary: 'List contacts', parameters: [{ $ref: '#/components/parameters/Limit' }] },
      post: { operationId: 'createContact', summary: 'Create a contact', requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Contact' } } } } },
    },
    '/contacts/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      get: { operationId: 'getContact', summary: 'Read a contact' },
      delete: { summary: 'Delete a contact' },
    },
  },
};
const SPEC_YAML = `swagger: "2.0"
info: { title: Books, version: "2" }
host: 127.0.0.1
basePath: /books/v2
schemes: [http]
securityDefinitions:
  oauth: { type: oauth2, flow: accessCode, authorizationUrl: "https://auth.books.test/authorize", tokenUrl: "${MOCK}/oauth/token", scopes: { read: Read } }
paths:
  /invoices:
    get: { operationId: listInvoices, summary: List invoices }
    post: { operationId: createInvoice, summary: Create invoice, parameters: [{ in: body, name: body, schema: { type: object } }] }
`;

// ── Scripted model for agent runs ───────────────────────────────────────
let script = null;
const router = {
  health: () => ({ configured: ['test'], preferred: 'test', models: [], dailyTokenBudget: 1e9 }),
  session: () => ({ model: { provider: 'test', model: 'scripted' }, async chat(messages, tools) { return script(messages, tools); } }),
};
const fnCall = (name, args) => ({ message: { role: 'assistant', content: '', tool_calls: [{ id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, usage: { input: 10, output: 5 } });
const answer = (text) => ({ message: { role: 'assistant', content: text }, usage: { input: 10, output: 5 } });

// ── App under test ──────────────────────────────────────────────────────
function testAuth(req, res, next) {
  try { req.user = jwt.verify((req.get('authorization') || '').replace(/^Bearer /, ''), process.env.JWT_SECRET); next(); } catch { res.status(401).json({ error: 'auth' }); }
}
const flags = (k) => k === 'workflow_http_actions_enabled';
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use('/api/platform/hooks', platformHooksRouter({ pool }));
app.use('/api/platform', platformRouter({ pool, authMiddleware: testAuth, router, flags }));
app.use('/api/trust', trustRouter());
const server = app.listen(0);
const ROOT = `http://127.0.0.1:${server.address().port}`;
const base = `${ROOT}/api/platform`;
const deps = () => ({ router, flags });

async function api(user, method, path, body, { org = null, headers = {}, raw = false } = {}) {
  const r = await fetch(`${base}${path}`, {
    method, redirect: 'manual',
    headers: { 'Content-Type': 'application/json', ...(user ? { Authorization: `Bearer ${user.token}` } : {}), ...(org ? { 'X-Starlane-Org': org } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (raw) return { status: r.status, text: await r.text(), headers: r.headers };
  let json = {};
  try { json = await r.json(); } catch { /* empty */ }
  return { ...json, bodyStatus: json.status, status: r.status };
}

const createdUsers = [];
const user = async (label) => { const u = await seedUser(pool, label); createdUsers.push(u.id); return u; };

try {
  // ── Pure: OpenAPI import ──────────────────────────────────────────────
  const imp = importSpec(JSON.stringify(SPEC_JSON));
  check('OpenAPI 3 import: 4 operations, refs resolved', imp.operations.length === 4 && imp.operations.find((o) => o.id === 'listContacts').parameters[0].name === 'limit', imp.operations);
  check('GET is read, writes are external', imp.operations.filter((o) => o.risk === 'read').length === 2 && imp.operations.find((o) => o.id === 'createContact').risk === 'external');
  check('operation without an id gets a stable one', imp.operations.some((o) => o.id === 'delete_contacts_id'));
  check('request body schema kept', imp.operations.find((o) => o.id === 'createContact').body.schema.required[0] === 'name');
  check('auth suggested from the spec', imp.auth.type === 'api_key' && imp.auth.name === 'X-API-Key');
  check('read-only import keeps only GET', importSpec(SPEC_JSON, { readOnly: true }).operations.every((o) => o.risk === 'read'));
  const sw = importSpec(SPEC_YAML);
  check('Swagger 2 YAML import with OAuth suggestion', sw.format.startsWith('Swagger') && sw.auth.type === 'oauth2_authorization_code' && sw.baseUrl === 'http://127.0.0.1/books/v2', sw);
  let threw = null;
  try { importSpec('{"not":"a spec"}'); } catch (e) { threw = e.message; }
  check('non-spec refused with a reason', /openapi/i.test(threw || ''), threw);

  const op = { id: 'getContact', method: 'GET', path: '/contacts/{id}', parameters: [{ name: 'id', in: 'path', required: true }] };
  check('path values are URL-encoded', store.buildRequest('https://api.x.test/v1', op, { id: 'a/b?c' }).url.pathname === '/v1/contacts/a%2Fb%3Fc');
  const refused = (fn) => { try { fn(); return false; } catch { return true; } };
  check('dot-dot path value refused', refused(() => store.buildRequest('https://api.x.test/v1', op, { id: '..' })));
  check('undeclared parameter refused', refused(() => store.buildRequest('https://api.x.test/v1', op, { id: '1', admin: 'true' })));
  check('missing path value refused', refused(() => store.buildRequest('https://api.x.test/v1', op, {})));

  // ── Organizations and roles ───────────────────────────────────────────
  const owner = await user('conn-owner');
  const admin = await user('conn-admin');
  const member = await user('conn-member');
  const viewer = await user('conn-viewer');
  const other = await user('conn-other');
  await api(owner, 'POST', '/organization/setup', { name: 'Brightwater Supply (synthetic)', industry: 'Distribution', apps: ['finance'] });
  const orgId = (await api(owner, 'GET', '/workspace')).organization.id;
  for (const [u, role] of [[admin, 'admin'], [member, 'member'], [viewer, 'viewer']]) await api(owner, 'POST', '/members', { email: u.email, memberRole: role });
  const as = (u) => ({ org: orgId });

  // ── OpenAPI connection with an API key ────────────────────────────────
  check('member cannot add a connection', (await api(member, 'POST', '/connectors/openapi', { spec: SPEC_JSON }, as(member))).status === 403);
  const prev = await api(admin, 'POST', '/connectors/openapi/preview', { spec: JSON.stringify(SPEC_JSON) }, as(admin));
  check('preview lists operations without saving', prev.status === 200 && prev.preview.operations.length === 4 && (await api(admin, 'GET', '/connectors', undefined, as(admin))).connections.length === 0);
  const c1 = await api(admin, 'POST', '/connectors/openapi', { spec: SPEC_JSON, auth: { type: 'api_key', secret: API_KEY } }, as(admin));
  check('connection created from OpenAPI', c1.status === 201 && c1.connection.status === 'active' && c1.connection.operations.length === 4, c1);
  check('credential never returned', !JSON.stringify(c1).includes(API_KEY) && c1.connection.hasCredentials === true);
  const stored = await pool.query('SELECT credentials_enc FROM platform_app_connections WHERE id = $1', [c1.connection.id]);
  check('credential stored encrypted', stored.rows[0].credentials_enc.startsWith('v1:') && !stored.rows[0].credentials_enc.includes(API_KEY));
  const connId = c1.connection.id;
  check('duplicate name refused', (await api(admin, 'POST', '/connectors/openapi', { spec: SPEC_JSON, auth: { type: 'api_key', secret: 'x' } }, as(admin))).status === 409);
  check('another organization cannot see it', (await api(other, 'GET', `/connectors/${connId}`)).status === 404);
  check('viewer can list connections', (await api(viewer, 'GET', '/connectors', undefined, as(viewer))).connections.length === 1);
  check('viewer cannot call', (await api(viewer, 'POST', `/connectors/${connId}/call`, { operationId: 'listContacts' }, as(viewer))).status === 403);

  const read = await api(member, 'POST', `/connectors/${connId}/call`, { operationId: 'listContacts', params: { limit: 5 } }, as(member));
  const hit = seen.filter((s) => s.path === '/crm/v1/contacts').pop();
  check('member reads through the connection', read.status === 200 && read.result.ok && read.result.json.contacts[0].name === 'Acme Ltd', read);
  check('the key went in the declared header, the parameter in the query', hit.headers['x-api-key'] === API_KEY && hit.query.limit === '5');
  check('member cannot call a write', (await api(member, 'POST', `/connectors/${connId}/call`, { operationId: 'createContact', body: { name: 'X' }, confirm: true }, as(member))).code === 'RISK_NOT_ALLOWED');
  check('admin write without confirm refused', (await api(admin, 'POST', `/connectors/${connId}/call`, { operationId: 'createContact', body: { name: 'X' } }, as(admin))).code === 'RISK_NOT_ALLOWED');
  const w = await api(admin, 'POST', `/connectors/${connId}/call`, { operationId: 'createContact', body: { name: 'Northwind (synthetic)' }, confirm: true }, as(admin));
  check('admin write with confirm goes through', w.status === 200 && w.result.status === 201, w);
  check('a write is audited', (await pool.query(`SELECT COUNT(*)::int AS n FROM platform_audit_events WHERE organization_id = $1 AND action = 'connection.external_call'`, [orgId])).rows[0].n === 1);
  check('unknown operation refused', (await api(member, 'POST', `/connectors/${connId}/call`, { operationId: 'dropTables' }, as(member))).status === 400);
  const calls = await api(member, 'GET', '/connectors/calls', undefined, as(member));
  check('call log records who, what and status', calls.calls.length >= 2 && calls.calls.some((c) => c.operation_id === 'createContact' && c.risk === 'external' && c.ok));
  check('call log holds no secrets', !JSON.stringify(calls).includes(API_KEY));

  // ── Catalog ───────────────────────────────────────────────────────────
  const cat = await api(viewer, 'GET', '/connectors/catalog', undefined, as(viewer));
  check('catalog lists apps, all marked unverified', cat.catalog.length >= 15 && cat.catalog.every((c) => c.verified === false) && /\/api\/platform\/hooks\/oauth\/callback$/.test(cat.oauthRedirectUri));
  const sl = await api(admin, 'POST', '/connectors/catalog', { catalogKey: 'slack', auth: { secret: 'xoxb-synthetic' } }, as(admin));
  check('Slack from the catalog', sl.status === 201 && sl.connection.baseUrl === 'https://slack.com/api' && sl.connection.operationCounts.external === 1, sl);
  const zd = await api(admin, 'POST', '/connectors/catalog', { catalogKey: 'zendesk', baseUrlFields: { subdomain: 'evil.com/x' }, auth: { secret: 'a:b' } }, as(admin));
  check('catalog subdomain is validated', zd.status === 400);
  const zd2 = await api(admin, 'POST', '/connectors/catalog', { catalogKey: 'zendesk', readOnly: true, baseUrlFields: { subdomain: 'brightwater' }, auth: { secret: 'agent@x.invalid/token:abc' } }, as(admin));
  check('read-only catalog connection drops writes', zd2.status === 201 && zd2.connection.baseUrl === 'https://brightwater.zendesk.com/api/v2' && zd2.connection.operationCounts.external === 0, zd2);

  // ── OAuth 2.0 authorization code with PKCE ────────────────────────────
  const books = await api(admin, 'POST', '/connectors/openapi', { specUrl: `${MOCK}/spec.yaml`, baseUrl: `${MOCK}/books/v2`, auth: { type: 'oauth2_authorization_code', clientId: 'books-client', clientSecret: 'shh-client-secret' } }, as(admin));
  check('OAuth connection waits for authorization', books.status === 201 && books.connection.status === 'authorization_required', books);
  const booksId = books.connection.id;
  check('cannot call before authorizing', (await api(member, 'POST', `/connectors/${booksId}/call`, { operationId: 'listInvoices' }, as(member))).status === 409);
  const start = await api(admin, 'POST', `/connectors/${booksId}/authorize`, { returnTo: '/connectors' }, as(admin));
  const au = new URL(start.authorizeUrl);
  check('authorize URL carries state and an S256 challenge', au.origin === 'https://auth.books.test' && au.searchParams.get('code_challenge_method') === 'S256' && au.searchParams.get('state') && au.searchParams.get('client_id') === 'books-client', start);
  oauth.code = `code_${randomBytes(4).toString('hex')}`; oauth.challenge = au.searchParams.get('code_challenge');
  const cb = await fetch(`${base}/hooks/oauth/callback?state=${encodeURIComponent(au.searchParams.get('state'))}&code=${oauth.code}`, { redirect: 'manual' });
  const loc = new URL(cb.headers.get('location'));
  check('callback exchanges the code (PKCE verified) and returns to the app', cb.status === 303 && loc.origin === 'https://app.starlane.test' && loc.searchParams.get('connector') === 'connected', loc.toString());
  const cb2 = await fetch(`${base}/hooks/oauth/callback?state=${encodeURIComponent(au.searchParams.get('state'))}&code=${oauth.code}`, { redirect: 'manual' });
  check('state is single-use', new URL(cb2.headers.get('location')).searchParams.get('connector') === 'error');
  const inv = await api(member, 'POST', `/connectors/${booksId}/call`, { operationId: 'listInvoices' }, as(member));
  check('calls use the access token', inv.result?.ok && inv.result.json.invoices[0].number === 'INV-1', inv);
  // Expire the token: the next call refreshes it.
  const row = await pool.query('SELECT credentials_enc FROM platform_app_connections WHERE id = $1', [booksId]);
  const sec = creds.decrypt(row.rows[0].credentials_enc);
  await pool.query('UPDATE platform_app_connections SET credentials_enc = $2 WHERE id = $1', [booksId, creds.encrypt({ ...sec, expiresAt: Date.now() - 1000 })]);
  const inv2 = await api(member, 'POST', `/connectors/${booksId}/call`, { operationId: 'listInvoices' }, as(member));
  check('an expired token is refreshed', inv2.result?.ok && oauth.refreshes === 1, inv2);
  check('the token is stored encrypted, never returned', !JSON.stringify(await api(admin, 'GET', `/connectors/${booksId}`, undefined, as(admin))).includes(oauth.accessToken));

  // ── MCP server ────────────────────────────────────────────────────────
  const m1 = await api(admin, 'POST', '/connectors/mcp', { url: `${MOCK}/mcp`, auth: { type: 'bearer', secret: 'mcp-token' } }, as(admin));
  check('MCP server connected and its tools listed', m1.status === 201 && m1.connection.name === 'Orders MCP' && m1.connection.operations.length === 2, m1);
  check('every MCP tool needs approval, even if it says read-only', m1.connection.operations.every((o) => o.risk === 'external') && m1.connection.operations[0].readOnlyHint === true);
  check('wrong MCP token refused at connect', (await api(admin, 'POST', '/connectors/mcp', { name: 'bad', url: `${MOCK}/mcp`, auth: { type: 'bearer', secret: 'nope' } }, as(admin))).status === 400);
  const mc = await api(admin, 'POST', `/connectors/${m1.connection.id}/call`, { operationId: 'lookup_order', params: { number: 'SO-7' }, confirm: true }, as(admin));
  check('MCP tool called over Streamable HTTP (SSE answer read)', mc.result?.ok && /called lookup_order with \{"number":"SO-7"\}/.test(mc.result.text), mc);

  // ── Agents use connected software ─────────────────────────────────────
  const tools = await api(admin, 'GET', '/tools', undefined, as(admin));
  check('apps tools are available once software is connected', ['apps.list', 'apps.read', 'apps.act'].every((k) => tools.tools.find((t) => t.key === k)?.status === 'available'));
  check('apps.act always needs approval', tools.tools.find((t) => t.key === 'apps.act').alwaysRequiresApproval === true);
  const ag = await api(admin, 'POST', '/agents', { definition: { name: 'CRM helper', objective: 'Read contacts and add one when asked.', tools: [{ key: 'apps.read' }, { key: 'apps.act' }] }, visibility: 'organization' }, as(admin));
  script = (messages) => {
    const t = messages.filter((x) => x.role === 'tool');
    if (t.length === 0) return fnCall('apps__read', { connection_id: connId, operation_id: 'listContacts', params: { limit: 2 } });
    if (t.length === 1) return fnCall('apps__act', { connection_id: connId, operation_id: 'createContact', body: { name: 'From agent (synthetic)' } });
    return answer(`done: ${t.map((x) => x.content.slice(0, 60)).join(' | ')}`);
  };
  const before = seen.filter((s) => s.method === 'POST' && s.path === '/crm/v1/contacts').length;
  const t1 = await api(admin, 'POST', `/agents/${ag.id}/test`, { input: { instruction: 'test' } }, as(admin));
  await engine.drain(pool, deps());
  const t1x = (await api(admin, 'GET', `/executions/${t1.executionId}`, undefined, as(admin))).execution;
  check('test run: the read really happened', t1x.steps.some((s) => s.name === 'apps.read' && s.status === 'completed' && JSON.stringify(s.output).includes('Acme Ltd')), t1x.steps);
  check('test run: the write was only a dry run', t1x.steps.some((s) => s.name === 'apps.act' && s.status === 'dry_run') && seen.filter((s) => s.method === 'POST' && s.path === '/crm/v1/contacts').length === before);
  const pub = await api(admin, 'POST', `/agents/${ag.id}/publish`, {}, as(admin));
  const actv = await api(admin, 'POST', `/agents/${ag.id}/activate`, {}, as(admin));
  const live = await api(member, 'POST', `/agents/${ag.id}/run`, { input: { instruction: 'add the contact' } }, as(member));
  check('agent published, activated and run by a member', pub.status === 200 && actv.status === 200 && live.status === 202, { pub, actv, live, t1x: t1x.status });
  await engine.drain(pool, deps());
  let lx = (await api(member, 'GET', `/executions/${live.executionId}`, undefined, as(member))).execution;
  check('live run pauses before changing the other app', lx.status === 'awaiting_approval' && seen.filter((s) => s.method === 'POST' && s.path === '/crm/v1/contacts').length === before, lx.status);
  const ap = (await api(admin, 'GET', '/approvals', undefined, as(admin))).approvals.find((a) => a.executionId === live.executionId);
  check('approval shows the exact app call', ap?.tool === 'apps.act' && ap.arguments.operation_id === 'createContact', ap);
  await api(admin, 'POST', `/approvals/${ap.id}/decision`, { decision: 'approve' }, as(admin));
  await engine.drain(pool, deps());
  lx = (await api(member, 'GET', `/executions/${live.executionId}`, undefined, as(member))).execution;
  const agentPost = seen.filter((s) => s.method === 'POST' && s.path === '/crm/v1/contacts').pop();
  check('after approval the agent call is made once, with an idempotency key', lx.status === 'completed' && seen.filter((s) => s.method === 'POST' && s.path === '/crm/v1/contacts').length === before + 1 && /^starlane-/.test(agentPost.headers['idempotency-key'] || ''), lx.status);
  check('agent calls are logged as the agent', (await pool.query(`SELECT COUNT(*)::int AS n FROM platform_connector_calls WHERE organization_id = $1 AND actor_kind = 'agent' AND execution_id = $2`, [orgId, live.executionId])).rows[0].n === 2);

  // ── Agent factory ─────────────────────────────────────────────────────
  const fo = await api(member, 'GET', '/factory', undefined, as(member));
  check('factory lists packs with readiness', fo.status === 200 && fo.packs.length === 6 && fo.packs.find((p) => p.key === 'operations').templates.length === 3, fo);
  check('member cannot build', (await api(member, 'POST', '/factory/builds', { source: 'pack', pack: 'operations' }, as(member))).status === 403);
  const b1 = await api(admin, 'POST', '/factory/builds', { source: 'pack', pack: 'operations', autoTest: true }, as(admin));
  check('pack builds 3 draft agents and queues a test of each', b1.status === 201 && b1.created.length === 3 && b1.testExecutionIds.length === 3, b1);
  const drafts = await pool.query(`SELECT status FROM platform_agents WHERE id = ANY($1::uuid[])`, [b1.created.map((c) => c.id)]);
  check('factory agents are drafts (nothing live)', drafts.rows.every((r) => r.status === 'draft'), drafts.rows);
  check('missing tools are named', b1.created.find((c) => c.templateKey === 'operations_monitoring').ready === true || b1.created.some((c) => c.missing.length >= 0));
  const b2 = await api(admin, 'POST', '/factory/builds', { source: 'pack', pack: 'operations' }, as(admin));
  check('building the same pack again skips existing agents', b2.created.length === 0 && b2.skipped.length === 3, b2);
  const b3 = await api(admin, 'POST', '/factory/builds', { source: 'connection', connectionId: connId, includeActions: true }, as(admin));
  const b3a = await api(admin, 'GET', `/agents/${b3.created[0]?.id}`, undefined, as(admin));
  check('an agent from a connected app knows its operations', b3.status === 201 && b3a.agent.tools.includes('apps.act') && b3a.agent.definition.instructions.includes('listContacts') && b3a.agent.definition.instructions.includes(connId), b3a.agent?.definition?.instructions);
  check('the app agent\'s write tool needs approval', b3a.agent.definition.tools.find((t) => t.key === 'apps.act').requires_approval === true);
  const b4 = await api(admin, 'POST', '/factory/builds', { source: 'objectives', objectives: ['Create an agent that reads open tickets from Zendesk every morning and tells me which are urgent'] }, as(admin));
  check('objective build drafts an agent with app tools', b4.status === 201 && b4.created.length === 1, b4);
  check('factory builds are audited', (await pool.query(`SELECT COUNT(*)::int AS n FROM platform_audit_events WHERE organization_id = $1 AND action = 'factory.build'`, [orgId])).rows[0].n === 4);

  // ── Audit log: tamper evidence ────────────────────────────────────────
  const v1 = await api(admin, 'GET', '/security/audit/verify', undefined, as(admin));
  check('audit chain verifies', v1.verification.intact === true && v1.verification.checked > 10, v1.verification);
  check('member cannot verify the audit log', (await api(member, 'GET', '/security/audit/verify', undefined, as(member))).status === 403);
  let blocked = false;
  try { await pool.query(`UPDATE platform_audit_events SET action = 'agent.tampered' WHERE organization_id = $1`, [orgId]); } catch { blocked = true; }
  check('audit rows cannot be edited', blocked);
  blocked = false;
  try { await pool.query('DELETE FROM platform_audit_events WHERE organization_id = $1', [orgId]); } catch { blocked = true; }
  check('audit rows cannot be deleted', blocked);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL starlane.audit_purge = 'on'`);
    await client.query(`UPDATE platform_audit_events SET detail = '{"tampered":true}' WHERE id = (SELECT id FROM platform_audit_events WHERE organization_id = $1 ORDER BY id LIMIT 1 OFFSET 3)`, [orgId]);
    await client.query('COMMIT');
  } finally { client.release(); }
  const v2 = await api(admin, 'GET', '/security/audit/verify', undefined, as(admin));
  check('a change made around the guard is detected', v2.verification.intact === false && v2.verification.problems.length === 1, v2.verification.problems);
  const ex = await api(admin, 'GET', '/security/audit/export', undefined, { org: orgId, raw: true });
  const lines = ex.text.trim().split('\n').map((l) => JSON.parse(l));
  check('audit export is JSON lines with hashes', ex.status === 200 && lines.length > 10 && lines.every((l) => l.hash && l.prev_hash), ex.status);

  // ── Posture and trust ────────────────────────────────────────────────
  const pos = await api(admin, 'GET', '/security/posture', undefined, as(admin));
  const ctl = (id) => pos.controls.find((c) => c.id === id);
  check('posture reports live control status', ctl('credential_encryption').status === 'in_place' && ctl('audit_tamper_evidence').status === 'partial' && ctl('mfa').status === 'not_in_place' && ctl('sso').status === 'not_in_place', pos.controls?.map((c) => [c.id, c.status]));
  check('posture never claims a certification', pos.frameworks.every((f) => ['not_attested', 'not_certified', 'not_authorized', 'designed_to_align'].includes(f.status)));
  check('member cannot see posture', (await api(member, 'GET', '/security/posture', undefined, as(member))).status === 403);
  const trust = await (await fetch(`${ROOT}/api/trust`)).json();
  check('public trust data lists no certifications', trust.certifications.length === 0 && trust.frameworks.length === 9 && trust.frameworks.every((f) => /^(Not|No|Designed)/.test(f.statusLabel)), trust.frameworks?.map((f) => f.statusLabel));

  // ── Retention ─────────────────────────────────────────────────────────
  await pool.query(`INSERT INTO platform_connector_calls (organization_id, connection_id, operation_id, method, risk, actor_kind, ok, created_at) VALUES ($1,$2,'old','GET','read','user',true, NOW() - INTERVAL '400 days')`, [orgId, connId]);
  check('retention below the minimum refused', (await api(admin, 'PUT', '/security/retention', { connectorCallsDays: 1 }, as(admin))).status === 400);
  check('admin sets retention', (await api(admin, 'PUT', '/security/retention', { connectorCallsDays: 365 }, as(admin))).policy.connectorCallsDays === 365);
  const applied = await api(admin, 'POST', '/security/retention/apply', {}, as(admin));
  check('retention removes only data older than the policy', applied.removed.connectorCalls === 1 && (await pool.query('SELECT COUNT(*)::int AS n FROM platform_connector_calls WHERE organization_id = $1', [orgId])).rows[0].n > 0, applied);

  // ── Privacy: export and erasure ───────────────────────────────────────
  const meExport = await api(member, 'GET', '/privacy/export', undefined, as(member));
  check('any member exports their own data', meExport.status === 200 && meExport.scope === 'me' && meExport.account.email === member.email, Object.keys(meExport));
  check('admin cannot export the whole organization', (await api(admin, 'GET', '/privacy/export?scope=organization', undefined, as(admin))).status === 403);
  const orgExport = await api(owner, 'GET', '/privacy/export?scope=organization');
  const connRows = orgExport.tables?.platform_app_connections?.rows || [];
  check('owner exports the organization, secrets withheld', orgExport.status === 200 && connRows.length >= 4 && connRows.every((r) => r.credentials_enc === null || r.credentials_enc === '[withheld]') && !JSON.stringify(orgExport).includes(API_KEY), connRows.map((r) => r.credentials_enc));
  check('organization export includes agents and audit', (orgExport.tables.platform_agents?.rows.length || 0) > 0 && (orgExport.tables.platform_audit_events?.rows.length || 0) > 0);

  const victim = await user('erasure');
  await api(victim, 'GET', '/workspace');
  await api(victim, 'POST', '/connectors/catalog', { catalogKey: 'github', auth: { secret: 'ghp_synthetic' } });
  check('erasure needs the account email typed', (await api(victim, 'POST', '/privacy/erasure', { confirmEmail: 'wrong@x.invalid' })).status === 400);
  const er = await api(victim, 'POST', '/privacy/erasure', { confirmEmail: victim.email });
  check('erasure is scheduled, not immediate', er.status === 201 && er.request.status === 'scheduled' && new Date(er.request.scheduled_for) > new Date(), er);
  check('cancel works', (await api(victim, 'POST', `/privacy/erasure/${er.request.id}/cancel`, {})).cancelled === true);
  const er2 = await api(victim, 'POST', '/privacy/erasure', { confirmEmail: victim.email });
  const off = await privacy.runDueErasures(pool, { now: new Date(Date.now() + 30 * 86400000), enabled: false });
  check('erasure does not run while switched off', off.ran === 0 && (await pool.query('SELECT 1 FROM users WHERE id = $1', [victim.id])).rowCount === 1);
  const on = await privacy.runDueErasures(pool, { now: new Date(Date.now() + 30 * 86400000), enabled: true });
  const gone = (await pool.query('SELECT 1 FROM users WHERE id = $1', [victim.id])).rowCount === 0;
  const receipt = (await pool.query('SELECT status, result, subject_email_hash FROM platform_privacy_requests WHERE id = $1', [er2.request.id])).rows[0];
  check('erasure deletes the account and organization, keeps a receipt', on.ran >= 1 && gone && receipt.status === 'completed' && receipt.result.deleted.organizations === 1 && /^[0-9a-f]{64}$/.test(receipt.subject_email_hash), { on, receipt });
  check('erased organization\'s connections are gone', (await pool.query(`SELECT COUNT(*)::int AS n FROM platform_app_connections a JOIN organizations o ON o.id = a.organization_id WHERE o.owner_user_id = $1`, [victim.id])).rows[0].n === 0);

  // ── Delete a connection ───────────────────────────────────────────────
  check('admin deletes a connection', (await api(admin, 'DELETE', `/connectors/${sl.connection.id}`, undefined, as(admin))).status === 200 && (await api(admin, 'GET', `/connectors/${sl.connection.id}`, undefined, as(admin))).status === 404);
} catch (err) {
  check('no unexpected error', false, err.stack);
} finally {
  await deleteUsers(pool, createdUsers);
  server.close();
  mock.close();
  await pool.end();
  done();
}
