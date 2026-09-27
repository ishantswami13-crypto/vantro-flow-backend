// Client platform API (desktop + mobile): native sessions with rotation and
// reuse detection, bootstrap, Now, action evidence, one-time decisions with
// high-risk confirmation, canonical notifications, push devices, telemetry,
// tenant isolation.
import { createRequire } from 'node:module';
import { makeChecker, openPool, deleteUsers, startServer } from './helpers/httpHarness.mjs';

const require = createRequire(import.meta.url);
const bcrypt = require('bcryptjs');
const { randomUUID } = require('crypto');
const { check, done } = makeChecker();
const PORT = 3926;

async function seedAccount(pool, label) {
  const id = randomUUID();
  const email = `${label}-${id.slice(0, 8)}@test.starlane.invalid`;
  await pool.query(`INSERT INTO users (id, email, password_hash, business_name) VALUES ($1,$2,$3,$4)`,
    [id, email, await bcrypt.hash('correct-horse-9', 4), `${label} Traders`]);
  return { id, email };
}

async function main() {
  const pool = openPool();
  const users = [];
  let server;
  try {
    const a = await seedAccount(pool, 'client-a'); users.push(a.id);
    const b = await seedAccount(pool, 'client-b'); users.push(b.id);
    server = await startServer(PORT, { FEATURE_CORTEX_ENABLED: 'true', FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED: 'false' });
    const { base } = server;
    const post = (p, body, token) => fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body || {}) });
    const get = (p, token) => fetch(`${base}${p}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });

    console.log('— sessions');
    check('wrong password -> 401', (await post('/api/auth/native/login', { email: a.email, password: 'nope' })).status === 401);
    const login = await (await post('/api/auth/native/login', { email: a.email.toUpperCase(), password: 'correct-horse-9', client: 'desktop', platform: 'windows', deviceName: 'OFFICE-PC', appVersion: '0.1.0' })).json();
    check('native login returns access + refresh', !!login.accessToken && !!login.refreshToken && login.user.id === a.id);
    const at = login.accessToken;
    check('access token works on existing APIs', (await get('/api/connectors', at)).status === 200);
    const r1 = await (await post('/api/auth/native/refresh', { refreshToken: login.refreshToken })).json();
    check('refresh rotates the refresh token', r1.refreshToken && r1.refreshToken !== login.refreshToken && r1.sessionId === login.sessionId);
    const reuse = await post('/api/auth/native/refresh', { refreshToken: login.refreshToken });
    check('reusing a rotated refresh token is refused', reuse.status === 401);
    check('…and revokes the whole session (new refresh token dead too)', (await post('/api/auth/native/refresh', { refreshToken: r1.refreshToken })).status === 401);
    await new Promise((r) => setTimeout(r, 16000)); // session-cache TTL
    check('…and its access tokens stop working', (await get('/api/client/bootstrap', r1.accessToken)).status === 401);

    const s2 = await (await post('/api/auth/native/login', { email: a.email, password: 'correct-horse-9', client: 'mobile', platform: 'ios', deviceName: 'iPhone' })).json();
    const s3 = await (await post('/api/auth/native/login', { email: a.email, password: 'correct-horse-9', client: 'desktop', platform: 'windows' })).json();
    const list = await (await get('/api/auth/sessions', s3.accessToken)).json();
    check('sessions list shows active devices, marks current', list.sessions.length === 2 && list.sessions.some((x) => x.current && x.client === 'desktop'));
    const del = await fetch(`${base}/api/auth/sessions/${s2.sessionId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${s3.accessToken}` } });
    check('signing another device out is immediate', del.status === 200 && (await get('/api/client/bootstrap', s2.accessToken)).status === 401);
    const token = s3.accessToken;
    const loginB = await (await post('/api/auth/native/login', { email: b.email, password: 'correct-horse-9', client: 'mobile' })).json();
    check('another tenant cannot sign out my session', (await fetch(`${base}/api/auth/sessions/${s3.sessionId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${loginB.accessToken}` } })).status === 404);

    console.log('— bootstrap + now');
    const boot = await (await get('/api/client/bootstrap', token)).json();
    check('bootstrap: account + organization + versions', boot.user.id === a.id && boot.organization.name && boot.minClientVersion.desktop && boot.apiVersion === 1, boot);
    let now = await (await get('/api/client/now', token)).json();
    check('now on an empty company: nothing invented', now.needsYou.length === 0 && now.changed.length === 0 && now.state.openInvoiceCount === 0 && now.dataAsOf === null, now);

    await pool.query(`INSERT INTO invoices (user_id, customer_name, customer_phone, invoice_amount, payment_status, days_overdue, due_date)
      VALUES ($1,'Gupta & Sons','9800000000',128500.5,'Pending',45, CURRENT_DATE - 45), ($1,'Sharma Traders','9800000001',25000,'Pending',12, CURRENT_DATE - 12)`, [a.id]);
    const run = await post('/api/cortex/run-agents', { agents: ['collections'] }, token);
    check('agents run on the native session', run.status === 200);
    now = await (await get('/api/client/now', token)).json();
    check('now: needs-you lists the pending actions, high-risk approval first', now.needsYou.length >= 2 && now.needsYou[0].requiresApproval === true, now.needsYou.map((x) => [x.type, x.requiresApproval]));
    check('now: receivables computed from real invoices', now.state.openInvoiceCount === 2 && Math.abs(now.state.openReceivables - 153500.5) < 0.01);
    check('now: changed feed includes the new recommendations', now.changed.filter((c) => c.kind === 'recommendation').length >= 2);
    const nowB = await (await get('/api/client/now', loginB.accessToken)).json();
    check('now: other tenant sees none of it', nowB.needsYou.length === 0 && nowB.state.openInvoiceCount === 0);

    console.log('— evidence + decisions');
    const high = now.needsYou.find((x) => x.riskLevel === 'high');
    const low = now.needsYou.find((x) => x.riskLevel !== 'high');
    const detail = await (await get(`/api/client/actions/${high.id}`, token)).json();
    check('action detail carries structured evidence', detail.action.evidence.hasStructuredEvidence && detail.action.evidence.rule === 'collections_stage_by_days_overdue', detail.action.evidence);
    check('evidence facts are labelled (observed/calculated)', detail.action.evidence.facts.some((f) => f.kind === 'calculated' && f.label === 'days overdue'));
    check('other tenant cannot read it (404)', (await get(`/api/client/actions/${high.id}`, loginB.accessToken)).status === 404);
    const noConfirm = await post(`/api/client/actions/${high.id}/decision`, { decision: 'approve' }, token);
    check('high-risk approve without explicit confirmation -> 428', noConfirm.status === 428);
    const other = await post(`/api/client/actions/${low.id}/decision`, { decision: 'approve' }, loginB.accessToken);
    check('other tenant cannot decide (404)', other.status === 404);
    const [d1, d2] = await Promise.all([post(`/api/client/actions/${low.id}/decision`, { decision: 'approve' }, token), post(`/api/client/actions/${low.id}/decision`, { decision: 'approve' }, token)]);
    check('double approval: exactly one wins, the other 409', [d1.status, d2.status].sort().join() === '200,409', [d1.status, d2.status]);
    const { rows: st } = await pool.query('SELECT status FROM ai_actions WHERE id = $1', [low.id]);
    check('approved action executed to a terminal state', ['done', 'failed'].includes(st[0].status), st[0].status);
    const rej = await post(`/api/client/actions/${high.id}/decision`, { decision: 'reject' }, token);
    check('reject needs no confirmation', rej.status === 200);
    const { rows: audit } = await pool.query(`SELECT action FROM audit_logs WHERE entity_id IN ($1,$2)`, [low.id, high.id]);
    check('decisions audited', audit.length === 2, audit);

    console.log('— notifications');
    const inbox = await (await get('/api/client/inbox', token)).json();
    check('approval_required notification created for the high-risk action', inbox.notifications.some((n) => n.type === 'approval_required' && n.actionId === high.id && n.route === `/actions/${high.id}`));
    check('action result notification created', inbox.notifications.some((n) => ['action_completed', 'action_failed'].includes(n.type) && n.actionId === low.id));
    check('other tenant inbox empty', (await (await get('/api/client/inbox', loginB.accessToken)).json()).notifications.length === 0);
    const first = inbox.notifications[0];
    check('mark read', (await post(`/api/client/inbox/${first.id}/read`, {}, token)).status === 200);
    check('cannot mark another tenant\'s notification', (await post(`/api/client/inbox/${first.id}/read`, {}, loginB.accessToken)).status === 404);

    console.log('— push + telemetry');
    check('bad push token rejected', (await post('/api/client/push-devices', { token: 'hello' }, token)).status === 400);
    check('Expo push token registered', (await post('/api/client/push-devices', { token: 'ExponentPushToken[abcdefghijklmnop]', platform: 'ios' }, token)).status === 201);
    const tel = await (await post('/api/client/telemetry', { events: [{ name: 'client.app_started', props: { app_version: '0.1.0', platform: 'windows', invoice_total: 99999 } }, { name: 'steal.data', props: {} }] })).json();
    check('telemetry accepts allowlisted events only', tel.accepted === 1);
    await new Promise((r) => setTimeout(r, 500)); // events persist asynchronously, off the request path
    const { rows: te } = await pool.query(`SELECT props FROM product_events WHERE event = 'client.app_started' ORDER BY occurred_at DESC LIMIT 1`);
    check('telemetry drops non-allowlisted props', te[0] && !JSON.stringify(te[0].props).includes('99999'));

    console.log('— logout');
    check('logout', (await post('/api/auth/native/logout', {}, token)).status === 200);
    await new Promise((r) => setTimeout(r, 200));
    check('logged-out token refused', (await get('/api/client/bootstrap', token)).status === 401);
  } finally {
    if (server) server.stop();
    await pool.query('DELETE FROM product_events WHERE user_id = ANY($1)', [users]).catch(() => {});
    await pool.query('DELETE FROM audit_logs WHERE user_id = ANY($1)', [users]).catch(() => {});
    await deleteUsers(pool, users);
    await pool.end();
  }
}

main().then(done).catch((e) => { console.error('Test run crashed:', e); process.exitCode = 1; });
