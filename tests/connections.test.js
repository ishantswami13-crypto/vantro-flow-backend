// FILE: tests/connections.test.js
// Connect any software, and workflows that act through it:
//   - pure: private addresses are refused, Sheet links parse, Email triage,
//     templates, validation of email / webhook triggers and the new actions;
//   - Gmail: new inbox messages become events once, start matching
//     workflows, and a drafted reply waits for approval; approval is
//     blocked while external sending is off and sends once when allowed;
//   - HTTP end to end on a real server: an incoming webhook starts a
//     workflow (triage → condition → task), a redelivery runs nothing, a
//     signed webhook refuses a bad signature, and tenants are isolated;
//   - "Call an API" sends the stored key to the connection's own address,
//     and is blocked while FEATURE_WORKFLOW_HTTP_ACTIONS_ENABLED is off.
//
// Run: DATABASE_URL=... JWT_SECRET=... node --test tests/connections.test.js
// Database tests skip (never pass silently) without a database.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');

process.env.OUTBOUND_CREDENTIALS_KEY = process.env.OUTBOUND_CREDENTIALS_KEY || crypto.randomBytes(32).toString('hex');

const { dbReady, createTenant, deleteTenant, startServer, tokenFor } = require('./helpers/decisionHarness');

function client(base, user) {
  const token = tokenFor(user);
  return async (method, url, body) => {
    const r = await fetch(`${base}${url}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { status: r.status, body: json };
  };
}
const cw = require('../lib/domain/workflows/customWorkflows');
const conns = require('../lib/connectors/connections');
const gmail = require('../lib/connectors/gmailInbox');
const { checkUrl, addressBlocked } = require('../lib/connectors/safeHttp');
const { parseSheetUrl, fetchSheetCsv } = require('../lib/connectors/sheetLink');
const { triageEmail } = require('../lib/domain/workflows/emailTriage');

// ── Pure ────────────────────────────────────────────────────────────────

test('outbound requests refuse private, loopback and metadata addresses', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
    assert.equal(addressBlocked(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(addressBlocked(ip), false, ip);
  for (const bad of ['http://example.com', 'https://localhost/x', 'https://127.0.0.1/', 'https://[::1]/', 'https://user:pw@example.com/', 'https://metadata.google.internal/', 'ftp://example.com']) {
    assert.throws(() => checkUrl(bad), /https|private|credentials|address/i, bad);
  }
  assert.equal(checkUrl('https://api.example.com/v1').hostname, 'api.example.com');
});

test('a Google Sheet link becomes its CSV export, and nothing else is fetched', async () => {
  const p = parseSheetUrl('https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit#gid=42');
  assert.equal(p.gid, '42');
  assert.match(p.csvUrl, /\/export\?format=csv&gid=42$/);
  assert.throws(() => parseSheetUrl('https://evil.example.com/spreadsheets/d/xxxxxxxxxxxxxxxxxxxxxxxx'), /Google Sheet/);
  const seen = [];
  const request = async (url) => {
    seen.push(url);
    if (seen.length === 1) return { status: 307, headers: { location: 'https://doc-0s-1c-sheets.googleusercontent.com/export/abc' }, body: '' };
    return { status: 200, headers: {}, body: 'Customer,Invoice No,Amount\nAcme,INV-1,100\n' };
  };
  const out = await fetchSheetCsv('https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit', { request });
  assert.match(out.filename, /^Google Sheet/);
  assert.match(out.buffer.toString(), /Acme/);
  const offsite = async () => ({ status: 302, headers: { location: 'https://evil.example.com/steal' }, body: '' });
  await assert.rejects(fetchSheetCsv('https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit', { request: offsite }), /unexpected/);
  const privateSheet = async () => ({ status: 200, headers: {}, body: '<!DOCTYPE html><html>Sign in' });
  await assert.rejects(fetchSheetCsv('https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit', { request: privateSheet }), /Anyone with the link/);
});

test('Email triage names what an email is and only states what the text says', () => {
  const promise = triageEmail({ subject: 'Re: Invoice INV-1042', body: 'Hi, we will pay the $4,500 by 15 Nov 2026.' });
  assert.equal(promise.category, 'payment_promise');
  assert.equal(promise.amount, 4500);
  assert.equal(promise.currency, 'USD');
  assert.equal(promise.invoiceNumber, 'INV-1042');
  assert.equal(promise.date, '2026-11-15');
  assert.ok(promise.evidence.length);
  assert.equal(triageEmail({ subject: 'Invoice #A-2231 attached', body: 'Amount due €980.50, due date 2026-12-01' }).category, 'invoice');
  assert.equal(triageEmail({ subject: 'Wrong amount', body: 'We dispute invoice 1051' }).category, 'dispute');
  assert.equal(triageEmail({ subject: 'Paid', body: 'We have transferred the payment today' }).category, 'payment_sent');
  const other = triageEmail({ subject: 'Lunch', body: 'See you at noon' });
  assert.equal(other.category, 'other');
  assert.equal(other.amount, null, 'no amount is invented');
});

test('templates fill from the trigger and earlier steps, and must refer to real values', () => {
  assert.equal(cw.renderTemplate('Re: {{trigger.subject}} — {{triage.amount}} {{triage.nope}}', { trigger: { subject: 'Hi' }, triage: { amount: 12 } }), 'Re: Hi — 12 ');
  const bad = cw.validateDefinition({ trigger: { type: 'email_received' }, steps: [
    { id: 'tell', type: 'action', action: 'notify_owner', params: { title: '{{triage.amount}}' } },
  ] });
  assert.equal(bad.ok, false);
  assert.match(bad.errors[0], /does not name the trigger or a step before/);
  for (const t of cw.TEMPLATES) assert.ok(cw.validateDefinition(t.definition).ok, t.key);
});

test('email and webhook triggers, text conditions and the new actions validate honestly', () => {
  const triageOnSchedule = cw.validateDefinition({ trigger: { type: 'manual' }, steps: [{ id: 't', type: 'agent', agent: 'starlane.email_triage' }] });
  assert.equal(triageOnSchedule.ok, false, 'Email triage needs an email or webhook to read');
  const noConn = cw.validateDefinition({ trigger: { type: 'webhook_received' }, steps: [{ id: 'x', type: 'action', action: 'create_task', params: { title: 'x' } }] });
  assert.equal(noConn.ok, false);
  const textOnNumber = cw.validateDefinition({ trigger: { type: 'email_received' }, steps: [
    { id: 'triage', type: 'agent', agent: 'starlane.email_triage' },
    { id: 'c', type: 'condition', signal: 'triage.amount', op: 'contains', value: 'x' },
  ] });
  assert.equal(textOnNumber.ok, false);
  const badEmail = cw.validateDefinition({ trigger: { type: 'email_received' }, steps: [
    { id: 'm', type: 'action', action: 'send_email', params: { to: 'not-an-address', subject: 's', body: 'b' } },
  ] });
  assert.equal(badEmail.ok, false);
  const ok = cw.validateDefinition({ trigger: { type: 'webhook_received', connectionId: crypto.randomUUID(), eventType: 'invoice.paid' }, steps: [
    { id: 'big', type: 'condition', signal: 'trigger.data.amount', op: 'gt', value: '1000' },
    { id: 'api', type: 'action', action: 'http_request', params: { connectionId: crypto.randomUUID(), method: 'post', path: '/deals/{{trigger.data.id}}', body: '{"note":"{{trigger.data.customer}}"}' } },
  ] });
  assert.ok(ok.ok, ok.errors.join('; '));
  assert.equal(ok.definition.steps[0].value, 1000);
  assert.equal(ok.definition.steps[1].params.method, 'POST');
  assert.equal(cw.emailMatches({ fromContains: 'acme' }, { from: 'Dana <dana@acme.com>', fromAddress: 'dana@acme.com', subject: 'x', to: 'me@co.com' }), true);
  assert.equal(cw.emailMatches({}, { from: 'me', fromAddress: 'me@co.com', to: 'me@co.com' }), false, 'our own mail never starts a workflow');
  assert.equal(cw.emailMatches({}, { fromAddress: 'bot@x.com', to: 'me@co.com', autoReply: true }), false, 'auto-replies are ignored');
});

// ── Database ────────────────────────────────────────────────────────────

let env;
let server;
const tenants = [];

test.before(async () => {
  env = await dbReady();
  if (env.ok) {
    const r = await env.pool.query(`SELECT to_regclass('public.starlane_connections') AS c, to_regclass('public.outbound_provider_accounts') AS o, to_regclass('public.notification_events') AS n`);
    if (!r.rows[0].c || !r.rows[0].o || !r.rows[0].n) env = { ok: false, reason: 'migrations 052/062/069 not applied' };
  }
  if (!env.ok) return;
  server = await startServer({
    OUTBOUND_CREDENTIALS_KEY: process.env.OUTBOUND_CREDENTIALS_KEY,
    FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED: 'false', FEATURE_WORKFLOW_HTTP_ACTIONS_ENABLED: 'false',
    FEATURE_CUSTOM_WORKFLOW_SCHEDULER_ENABLED: 'false', STARLANE_GLOBAL_STOP: '',
  });
});

test.after(async () => {
  conns.__setTestHttpOptions(null);
  if (server) await server.stop();
  if (env?.ok) {
    for (const t of tenants) {
      for (const tbl of ['notification_events', 'outbound_provider_accounts', 'starlane_controls', 'starlane_definition_versions', 'starlane_tenant_settings']) {
        await env.pool.query(`DELETE FROM ${tbl} WHERE user_id = $1`, [t.id]).catch(() => {});
      }
      await deleteTenant(env.pool, t.id).catch(() => {});
    }
    await env.pool.end();
  }
});

async function tenant(label) {
  const t = await createTenant(env.pool, label);
  tenants.push(t);
  return t;
}

const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); }
  return null;
};

test('Gmail messages become events once and start matching workflows; a reply waits for approval', async (t) => {
  if (!env.ok) return t.skip(`no database: ${env.reason}`);
  const a = await tenant('gmail');
  await env.pool.query(
    `INSERT INTO outbound_provider_accounts (user_id, provider, from_address, status, credentials_enc, created_by) VALUES ($1,'gmail','owner@co.example','HEALTHY','x',$1)`, [a.id]);
  const inbox = [
    { id: 'm1', threadId: 't1', from: 'Dana <dana@acme.example>', fromAddress: 'dana@acme.example', subject: 'Invoice INV-7', body: 'We will pay the $1,200 by 20 Nov 2026', receivedAt: new Date().toISOString(), headers: {} },
    { id: 'm2', threadId: 't2', from: 'News <news@list.example>', fromAddress: 'news@list.example', subject: 'Weekly news', body: 'Hello', receivedAt: new Date().toISOString(), headers: {} },
    { id: 'm3', threadId: 't3', from: 'Mailer <mailer-daemon@x>', fromAddress: 'mailer-daemon@x', subject: 'Undeliverable', body: '', isBounce: true, receivedAt: new Date().toISOString(), headers: {} },
  ];
  const adapter = { listInbound: async () => ({ messages: inbox }) };
  const tpl = cw.TEMPLATES.find((x) => x.key === 'promise_reply');
  const wf = await cw.createWorkflow(env.pool, a.id, { name: 'Promises', definition: tpl.definition });
  await cw.setStatus(env.pool, a.id, wf.id, 'ACTIVE');

  const first = await gmail.pollInbox(env.pool, a.id, { adapter });
  assert.equal(first.status, 'OK');
  assert.equal(first.events.length, 2, 'bounces are left to the outbound engine');
  const again = await gmail.pollInbox(env.pool, a.id, { adapter });
  assert.equal(again.events.length, 0, 'a message is stored once');

  const notes = [];
  const notifyFn = async (userId, n) => { notes.push(n); return { id: 'n' }; };
  let ran = 0;
  for (const ev of first.events) ran += (await cw.dispatchEvent(env.pool, a.id, ev, { notifyFn })).ran;
  assert.equal(ran, 2, 'each email runs the workflow once');
  const runs = await cw.listRuns(env.pool, a.id, wf.id);
  const promiseRun = runs.find((r) => r.steps.some((s) => s.status === 'WAITING_APPROVAL'));
  assert.ok(promiseRun, 'the promise produced a drafted reply');
  assert.equal(runs.filter((r) => r.status === 'ENDED_BY_CONDITION').length, 1, 'the newsletter stopped at the condition');
  for (const ev of first.events) assert.equal((await cw.dispatchEvent(env.pool, a.id, ev, { notifyFn })).ran, 0, 'redispatch runs nothing');

  const [approval] = await cw.listApprovals(env.pool, a.id, { status: 'PENDING' });
  assert.equal(approval.to, 'dana@acme.example');
  assert.equal(approval.subject, 'Re: Invoice INV-7');
  assert.equal(approval.isReply, true);
  const tasks = await cw.listTasks(env.pool, a.id);
  assert.match(tasks[0].title, /Check payment promised by Dana/);
  assert.match(tasks[0].detail, /1200 USD for INV-7, promised for 2026-11-20/);
  assert.ok(notes.some((n) => n.type === 'approval_required'), 'the owner is told an email waits');

  // Approve while external sending is off: nothing is sent, the draft says why.
  const sent = [];
  const sendFn = async (args) => { sent.push(args); return { providerMessageId: 'g1', threadId: 't1', from: 'owner@co.example' }; };
  const blocked = await cw.decideApproval(env.pool, a.id, approval.id, 'approve', { actorId: a.id, sendFn, guardFn: () => ({ reason: 'external_sending_disabled' }) });
  assert.equal(blocked.status, 'BLOCKED');
  assert.match(blocked.statusReason, /FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED/);
  assert.equal(sent.length, 0);
  // Allowed: sends once, in the same thread, keyed on the approval.
  const ok = await cw.decideApproval(env.pool, a.id, approval.id, 'approve', { actorId: a.id, sendFn, guardFn: () => null, edits: { body: 'Thanks Dana, noted.' } });
  assert.equal(ok.status, 'SENT');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].threadId, 't1');
  assert.equal(sent[0].body, 'Thanks Dana, noted.');
  assert.equal(sent[0].idempotencyKey, `cwf-approval:${approval.id}`);
  await assert.rejects(cw.decideApproval(env.pool, a.id, approval.id, 'approve', { sendFn, guardFn: () => null }), /already sent/);
  const b = await tenant('gmail-other');
  await assert.rejects(cw.decideApproval(env.pool, b.id, approval.id, 'reject', {}), /not found/, 'another tenant cannot touch it');
});

test('a draft to "Name <address>" goes to the address (sample emails and webhook data send names too)', async (t) => {
  if (!env.ok) return t.skip(`no database: ${env.reason}`);
  const a = await tenant('named-to');
  const wf = await cw.createWorkflow(env.pool, a.id, { name: 'Named', definition: {
    trigger: { type: 'email_received' },
    steps: [{ id: 'reply', type: 'action', action: 'send_email', params: { to: '{{trigger.from}}', subject: 'Re: {{trigger.subject}}', body: 'Thanks.' } }],
  } });
  const event = { payload: { from: 'Priya Shah <Priya@Acme.example>', fromAddress: '', subject: 'Hello', body: 'Hi' } };
  const r = await cw.executeWorkflow(env.pool, a.id, wf, { trigger: 'manual', slot: 'named:1', event, notifyFn: async () => ({ id: 'n' }) });
  assert.equal(r.status, 'COMPLETED', JSON.stringify(r.steps));
  const [approval] = await cw.listApprovals(env.pool, a.id, { status: 'PENDING' });
  assert.equal(approval.to, 'priya@acme.example');
});

test('an incoming webhook starts its workflows over HTTP, once per delivery, per tenant', async (t) => {
  if (!env.ok) return t.skip(`no database: ${env.reason}`);
  const a = await tenant('hook');
  const b = await tenant('hook-other');
  const ca = client(server.base, a);
  const cb = client(server.base, b);

  const created = await ca('POST', '/api/integrations', { kind: 'webhook_in', name: 'Zapier' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const url = created.body.webhookUrl;
  assert.match(url, /\/api\/hooks\/[A-Za-z0-9_-]{30,}$/);
  const hookId = created.body.connection.id;

  const wf = await ca('POST', '/api/custom-workflows', { name: 'Big invoices', definition: {
    trigger: { type: 'webhook_received', connectionId: hookId },
    steps: [
      { id: 'big', type: 'condition', signal: 'trigger.data.amount', op: 'gt', value: 1000 },
      { id: 'todo', type: 'action', action: 'create_task', params: { title: 'Call {{trigger.data.customer}} about {{trigger.data.amount}}', dueInDays: 1 } },
    ] } });
  assert.equal(wf.status, 201, JSON.stringify(wf.body));
  assert.equal((await ca('POST', `/api/custom-workflows/${wf.body.workflow.id}/activate`)).status, 200);

  const path = new URL(url).pathname;
  const post = (body, headers = {}) => fetch(`${server.base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const r1 = await post({ event: 'invoice.created', customer: 'Acme', amount: 2500 }, { 'X-Starlane-Event-Id': 'evt-1' });
  assert.equal(r1.status, 202);
  const task = await until(async () => (await ca('GET', '/api/custom-workflows/tasks')).body.tasks?.[0]);
  assert.ok(task, 'the workflow created a task');
  assert.equal(task.title, 'Call Acme about 2500');
  const dup = await post({ event: 'invoice.created', customer: 'Acme', amount: 2500 }, { 'X-Starlane-Event-Id': 'evt-1' });
  assert.equal((await dup.json()).duplicate, true, 'a redelivery is recognised');
  const small = await post({ customer: 'Tiny', amount: 10 });
  assert.equal(small.status, 202);
  await until(async () => ((await ca('GET', `/api/custom-workflows/${wf.body.workflow.id}/runs`)).body.runs || []).length === 2);
  assert.equal((await ca('GET', '/api/custom-workflows/tasks')).body.tasks.length, 1, 'the small one stopped at the condition');

  assert.equal((await fetch(`${server.base}/api/hooks/${'x'.repeat(32)}`, { method: 'POST', body: '{}' })).status, 404);
  assert.equal((await cb('GET', '/api/custom-workflows/tasks')).body.tasks.length, 0, 'the other tenant sees no tasks');
  assert.equal((await cb('GET', '/api/integrations')).body.connections.length, 0, 'or connections');
  assert.equal((await cb('DELETE', `/api/integrations/${hookId}`)).status, 404);
  const listing = await ca('GET', '/api/integrations');
  assert.equal(listing.status, 200, JSON.stringify(listing.body));
  const listed = listing.body.connections[0];
  assert.equal(listed.hasSecret, false);
  assert.equal(JSON.stringify(listed).includes(new URL(url).pathname.split('/').pop()), false, 'the URL secret is never listed');

  // A signed webhook refuses an unsigned or wrongly signed body.
  const signed = await ca('POST', '/api/integrations', { kind: 'webhook_in', name: 'Stripe', signed: true });
  const sp = new URL(signed.body.webhookUrl).pathname;
  const body = JSON.stringify({ type: 'charge.succeeded' });
  const bad = await fetch(`${server.base}${sp}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Starlane-Signature': 'sha256=00' }, body });
  assert.equal(bad.status, 401);
  const sig = crypto.createHmac('sha256', signed.body.signingSecret).update(body).digest('hex');
  const good = await fetch(`${server.base}${sp}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Starlane-Signature': `sha256=${sig}` }, body });
  assert.equal(good.status, 202);

  // Turned off: the address stops working. Rotated: the old address stops.
  await ca('POST', `/api/integrations/${hookId}/disable`);
  assert.equal((await post({ amount: 5000 })).status, 410);
  await ca('POST', `/api/integrations/${hookId}/enable`);
  const rotated = await ca('POST', `/api/integrations/${hookId}/rotate`);
  assert.equal((await post({ amount: 5000 })).status, 404);
  assert.notEqual(rotated.body.webhookUrl, url);

  // The Data sources catalog reports what really exists for this tenant.
  const state = (await ca('GET', '/api/connectors')).body.connectors;
  assert.equal(state.find((c) => c.id === 'webhook_in').state.health, 'healthy');
  assert.equal(state.find((c) => c.id === 'gmail').state.health, 'not_connected');
  assert.equal(state.find((c) => c.id === 'quickbooks').availability, 'not_available');
});

test('"Call an API" sends the stored key to the connection, and is blocked while switched off', async (t) => {
  if (!env.ok) return t.skip(`no database: ${env.reason}`);
  const a = await tenant('api');
  const got = [];
  const api = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => { got.push({ url: req.url, method: req.method, auth: req.headers.authorization, idem: req.headers['idempotency-key'], body: data }); res.writeHead(201, { 'Content-Type': 'application/json' }); res.end('{"id":"deal_9"}'); });
  });
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${api.address().port}`;
  try {
    assert.throws(() => checkUrl(base), /https/, 'production refuses it');
    conns.__setTestHttpOptions({ allowHttp: true, allowPrivate: true });
    const { connection } = await conns.createConnection(env.pool, a.id, { kind: 'http_api', name: 'CRM', baseUrl: base, authType: 'bearer', secret: 'sk_test_123' });
    assert.equal(connection.hasSecret, true);
    const stored = (await env.pool.query('SELECT secret_enc FROM starlane_connections WHERE id = $1', [connection.id])).rows[0].secret_enc;
    assert.equal(stored.includes('sk_test_123'), false, 'the key is encrypted at rest');

    const wf = await cw.createWorkflow(env.pool, a.id, { name: 'Push', definition: {
      trigger: { type: 'webhook_received', connectionId: crypto.randomUUID() },
      steps: [{ id: 'push', type: 'action', action: 'http_request', params: { connectionId: connection.id, method: 'POST', path: '/deals/{{trigger.data.id}}', body: '{"note":"{{trigger.data.note}}","amount":{{trigger.data.amount}}}' } }],
    } });
    const event = { id: crypto.randomUUID(), user_id: a.id, payload: { id: 'D1', note: 'Say "hi"', amount: 42 } };
    const off = await cw.executeWorkflow(env.pool, a.id, wf, { trigger: 'webhook_received', slot: 'api:1', event, flagFn: () => false });
    assert.equal(off.status, 'BLOCKED');
    assert.match(off.summary, /FEATURE_WORKFLOW_HTTP_ACTIONS_ENABLED/);
    assert.equal(got.length, 0, 'nothing was called');

    const on = await cw.executeWorkflow(env.pool, a.id, wf, { trigger: 'webhook_received', slot: 'api:2', event, flagFn: () => true });
    assert.equal(on.status, 'COMPLETED', JSON.stringify(on.steps));
    assert.equal(got.length, 1);
    assert.equal(got[0].url, '/deals/D1');
    assert.equal(got[0].auth, 'Bearer sk_test_123');
    assert.match(got[0].idem, /^cwf:/);
    assert.deepEqual(JSON.parse(got[0].body), { note: 'Say "hi"', amount: 42 }, 'values are escaped into valid JSON');
    await assert.rejects(conns.callConnection(env.pool, a.id, connection.id, { path: '//evil.example.com/x' }), /path/);
  } finally {
    conns.__setTestHttpOptions(null);
    api.close();
  }
});
