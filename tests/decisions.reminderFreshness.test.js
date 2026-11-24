// FILE: tests/decisions.reminderFreshness.test.js
// Second workflow through the same approve/send gate as supplier-delay
// notices (lib/domain/decisions/noticeFreshness.js). A receivables decision
// run LIVE prepares a SEND_FIRM_REMINDER that quotes what the customer owes.
// If the customer pays, part-pays or disputes before the owner approves, the
// reminder is withdrawn with a reason and nothing is approved or sent. An
// unchanged reminder still approves; reminders not prepared by a decision
// are untouched; another tenant cannot reach the draft.
//
// Run: DATABASE_URL=... JWT_SECRET=... node --test tests/decisions.reminderFreshness.test.js
// Skips (never passes silently) when no database is configured.

const test = require('node:test');
const assert = require('node:assert/strict');
const { dbReady, createTenant, deleteTenant, seedGolden, startServer, client, tokenFor, todayIso } = require('./helpers/decisionHarness');
const { reminderStaleReason } = require('../lib/domain/decisions/noticeFreshness');

let env;
let server;
const tenants = [];

test.before(async () => {
  env = await dbReady();
  if (!env.ok) return;
  server = await startServer({ FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED: 'false', STARLANE_GLOBAL_STOP: '' });
});

test.after(async () => {
  if (server) await server.stop();
  if (env?.ok) {
    for (const t of tenants) await deleteTenant(env.pool, t.id).catch(() => {});
    await env.pool.end();
  }
});

test('pure: a reminder is stale when an invoice it quotes is paid, part-paid, disputed or gone', () => {
  const quoted = [{ id: 'a', number: 'SH-1', outstanding: 1000 }, { id: 'b', number: 'SH-2', outstanding: 250.5 }];
  const same = new Map([['a', { status: 'open', outstanding: 1000 }], ['b', { status: 'open', outstanding: 250.5 }]]);
  assert.equal(reminderStaleReason(quoted, same), null);
  assert.match(reminderStaleReason(quoted, new Map([...same, ['a', { status: 'paid', outstanding: 0 }]])), /SH-1 has been paid/);
  assert.match(reminderStaleReason(quoted, new Map([...same, ['b', { status: 'open', outstanding: 200.5 }]])), /amount owed on invoice SH-2 changed/);
  assert.match(reminderStaleReason(quoted, new Map([...same, ['a', { status: 'open', outstanding: 1000, disputeOpen: true }]])), /SH-1 is now disputed/);
  assert.match(reminderStaleReason(quoted, new Map([['a', same.get('a')]])), /SH-2 is no longer on record/);
  assert.match(reminderStaleReason(quoted, same, { escalationPaused: true }), /paused escalation/);
  assert.match(reminderStaleReason([], same), /names no invoice/);
  // Paise matter: 250.50 vs 250.49 is a different amount.
  assert.match(reminderStaleReason(quoted, new Map([...same, ['b', { status: 'open', outstanding: 250.49 }]])), /changed/);
});

// Golden tenant -> LIVE -> escalate_and_hold for Sharma Traders -> a pending
// SEND_FIRM_REMINDER prepared by that decision.
async function tenantWithReminder(label) {
  const user = await createTenant(env.pool, label);
  tenants.push(user);
  const fx = await seedGolden(env.pool, user.id, todayIso());
  const api = client(server.base, user);
  assert.equal((await api.post('/api/decisions/discover')).status, 200);
  const list = await api.get('/api/decisions');
  const sharma = list.body.decisions.find((d) => d.kind === 'RECEIVABLE_RISK' && /Sharma Traders/.test(d.title));
  assert.ok(sharma, 'a receivables decision for Sharma');
  assert.equal((await api.post('/api/decisions/controls', { pilotMode: 'LIVE' })).status, 200);
  assert.equal((await api.post(`/api/decisions/${sharma.id}/select`, { optionKey: 'escalate_and_hold' })).status, 200);
  assert.equal((await api.post(`/api/decisions/${sharma.id}/approve`)).status, 200);
  const ex = await api.post(`/api/decisions/${sharma.id}/execute`);
  assert.equal(ex.status, 200, JSON.stringify(ex.body));
  const drafts = await env.pool.query(
    `SELECT id, status, parameters FROM ai_actions WHERE user_id = $1 AND decision_id = $2 AND action_type = 'SEND_FIRM_REMINDER'`,
    [user.id, sharma.id]
  );
  assert.equal(drafts.rows.length, 1, 'one reminder prepared');
  assert.equal(drafts.rows[0].status, 'pending');
  const decision = (await api.get(`/api/decisions/${sharma.id}`)).body.decision;
  const quoted = decision.affectedEntities.filter((e) => e.type === 'invoice');
  assert.ok(quoted.length >= 1);
  return { user, fx, api, decisionId: sharma.id, actionId: drafts.rows[0].id, quoted };
}

async function patchAction(user, id, status) {
  const r = await fetch(`${server.base}/api/ai-actions/${id}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${tokenFor(user)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

async function actionRow(userId, id) {
  return (await env.pool.query('SELECT status, block_reason FROM ai_actions WHERE id = $1 AND user_id = $2', [id, userId])).rows[0];
}

async function blockedEvents(userId, decisionId) {
  return (await env.pool.query(
    `SELECT payload FROM decision_events WHERE user_id = $1 AND decision_id = $2 AND event_type = 'NOTICE_BLOCKED_STALE'`,
    [userId, decisionId]
  )).rows.map((r) => r.payload);
}

test('unchanged ledger: the decision-prepared reminder still approves (Action Center path)', async (t) => {
  if (!env.ok) return t.skip(`no database: ${env.reason}`);
  const { user, api, decisionId, actionId } = await tenantWithReminder('reminder-fresh');
  const r = await api.post(`/api/client/actions/${actionId}/decision`, { decision: 'approve', confirmHighRisk: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.notEqual((await actionRow(user.id, actionId)).status, 'expired');
  assert.equal((await blockedEvents(user.id, decisionId)).length, 0);
});

test('invoice paid before approval: reminder withdrawn, 409, audited, nothing approved; other tenant gets 404', async (t) => {
  if (!env.ok) return t.skip(`no database: ${env.reason}`);
  const { user, decisionId, actionId, quoted } = await tenantWithReminder('reminder-paid');
  const intruder = await createTenant(env.pool, 'reminder-intruder'); tenants.push(intruder);

  // Another tenant cannot approve (or even see) this draft.
  assert.equal((await patchAction(intruder, actionId, 'approved')).status, 404);
  assert.equal((await actionRow(user.id, actionId)).status, 'pending');

  await env.pool.query(
    `UPDATE invoices SET payment_status = 'Paid', payment_date = CURRENT_DATE, payment_amount = invoice_amount, updated_at = NOW() WHERE id = $1 AND user_id = $2`,
    [quoted[0].id, user.id]
  );
  const r = await patchAction(user, actionId, 'approved');
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, 'NOTICE_STALE');
  assert.match(r.body.error, /has been paid/);
  const row = await actionRow(user.id, actionId);
  assert.equal(row.status, 'expired');
  assert.match(row.block_reason, /^Withdrawn before sending: invoice .* has been paid\.$/);
  const ev = await blockedEvents(user.id, decisionId);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].actionType, 'SEND_FIRM_REMINDER');
  assert.equal(ev[0].withdrawn, true);
  // A retry cannot revive it.
  assert.equal((await patchAction(user, actionId, 'approved')).status, 409);
  assert.equal((await actionRow(user.id, actionId)).status, 'expired');
});

test('part-payment before approval: the quoted amount is wrong, so the reminder is withdrawn', async (t) => {
  if (!env.ok) return t.skip(`no database: ${env.reason}`);
  const { user, api, actionId, quoted } = await tenantWithReminder('reminder-partial');
  // A part-payment recorded on the unpaid invoice (how the app and ledger import store it).
  await env.pool.query(
    `UPDATE invoices SET payment_amount = 1000, updated_at = NOW() WHERE id = $1 AND user_id = $2`,
    [quoted[0].id, user.id]
  );
  const r = await api.post(`/api/client/actions/${actionId}/decision`, { decision: 'approve', confirmHighRisk: true });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.match(r.body.error, /amount owed on invoice .* changed/);
  assert.equal((await actionRow(user.id, actionId)).status, 'expired');
});

test('dispute opened before approval: reminder withdrawn', async (t) => {
  if (!env.ok) return t.skip(`no database: ${env.reason}`);
  const { user, fx, actionId, quoted } = await tenantWithReminder('reminder-dispute');
  await env.pool.query(
    `INSERT INTO disputes (user_id, invoice_id, customer_name, disputed_amount, reason, status, created_at) VALUES ($1,$2,$3,1000,'Short supply','open',NOW())`,
    [user.id, quoted[0].id, fx.ids.sharma.name]
  );
  const r = await patchAction(user, actionId, 'approved');
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.match(r.body.error, /now disputed/);
  assert.equal((await actionRow(user.id, actionId)).status, 'expired');
});

test('a reminder not prepared by a decision is not touched by the gate', async (t) => {
  if (!env.ok) return t.skip(`no database: ${env.reason}`);
  const user = await createTenant(env.pool, 'reminder-legacy'); tenants.push(user);
  const ins = await env.pool.query(
    `INSERT INTO ai_actions (user_id, action_type, title, status, suggested_by, risk_level, requires_approval)
     VALUES ($1,'SEND_FIRM_REMINDER','Firm reminder: legacy','pending','agent','high',true) RETURNING id`,
    [user.id]
  );
  const r = await patchAction(user, ins.rows[0].id, 'approved');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await actionRow(user.id, ins.rows[0].id)).status, 'approved');
});
