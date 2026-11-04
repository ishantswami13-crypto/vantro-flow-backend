// Real-DB, real-HTTP regression tests for three security fixes:
//   1. One-tap approval links: GET must never change state (link-preview
//      crawlers fetch URLs); POST claims atomically, executes at most once.
//   2. /api/demo/2xa/reset is not reachable by an ordinary signed-in user.
//   3. Connection heartbeats cannot fabricate a cloud connector's state.
//
// Run: DATABASE_URL=... node tests/securityHardening.test.mjs
import { createRequire } from 'node:module';
import { makeChecker, openPool, seedUser, deleteUsers, startServer } from './helpers/httpHarness.mjs';

const require = createRequire(import.meta.url);
const { check, done } = makeChecker();
const PORT = 3921;

async function main() {
  const pool = openPool();
  const users = [];
  let server;
  try {
    const owner = await seedUser(pool, 'sec-owner'); users.push(owner.id);
    const other = await seedUser(pool, 'sec-other'); users.push(other.id);

    // Action type with no external side effect (falls through to "Approved."),
    // so the test exercises the lifecycle without sending anything anywhere.
    const insert = (title) => pool.query(
      `INSERT INTO ai_actions (user_id, action_type, title, status, requires_approval)
       VALUES ($1, 'TEST_NOOP_ACTION', $2, 'pending', true) RETURNING id`, [owner.id, title]);
    const approveId = (await insert('Approve me')).rows[0].id;
    const rejectId = (await insert('Reject me')).rows[0].id;
    const statusOf = async (id) => (await pool.query('SELECT status FROM ai_actions WHERE id = $1', [id])).rows[0].status;

    const { signActionToken } = require('../lib/services/actionApproval.service');
    const approveToken = signActionToken(approveId, 'approve');
    const rejectToken = signActionToken(rejectId, 'reject');

    server = await startServer(PORT);
    const { base } = server;

    // ── 1. approval links ──────────────────────────────────────────────
    const getRes = await fetch(`${base}/api/actions/${approveId}/approve?token=${encodeURIComponent(approveToken)}`);
    const getHtml = await getRes.text();
    check('GET approve link: 200 confirmation page', getRes.status === 200 && getHtml.includes('<form method="post"'), getRes.status);
    check('GET approve link: action still pending (no state change on GET)', await statusOf(approveId) === 'pending');

    // Same-origin browser form POST (Origin = the API host itself) must pass CORS.
    const post = () => fetch(`${base}/api/actions/${approveId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: base },
      body: new URLSearchParams({ token: approveToken }).toString(),
    });
    const [p1, p2, p3] = await Promise.all([post(), post(), post()]);
    const bodies = await Promise.all([p1.text(), p2.text(), p3.text()]);
    const executed = bodies.filter((b) => b.includes('Approved.')).length;
    check('POST approve x3 concurrently: all 200', [p1, p2, p3].every((r) => r.status === 200), [p1.status, p2.status, p3.status]);
    check('POST approve x3 concurrently: executed exactly once', executed === 1, executed);
    check('POST approve: terminal status done', await statusOf(approveId) === 'done');

    const forged = await fetch(`${base}/api/actions/${rejectId}/approve`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: rejectToken }).toString(),
    });
    check('reject token cannot approve: 403', forged.status === 403);
    check('reject token cannot approve: still pending', await statusOf(rejectId) === 'pending');

    const getReject = await fetch(`${base}/api/actions/${rejectId}/reject?token=${encodeURIComponent(rejectToken)}`);
    check('GET reject link: no state change', getReject.status === 200 && await statusOf(rejectId) === 'pending');
    const postReject = await fetch(`${base}/api/actions/${rejectId}/reject`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: rejectToken }).toString(),
    });
    check('POST reject: 200 and status rejected', postReject.status === 200 && await statusOf(rejectId) === 'rejected');

    // ── 2. demo reset ──────────────────────────────────────────────────
    const demo = await fetch(`${base}/api/demo/2xa/reset`, { method: 'POST', headers: { Authorization: `Bearer ${other.token}` } });
    check('demo reset: ordinary user is refused', demo.status === 403 || demo.status === 404, demo.status);

    // ── 3. heartbeats ──────────────────────────────────────────────────
    const hb = (sourceType, status) => fetch(`${base}/api/connections/heartbeat`, {
      method: 'POST', headers: { Authorization: `Bearer ${owner.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceType, status }),
    });
    const fake = await hb('QUICKBOOKS', 'CONNECTED');
    check('heartbeat: user cannot mark QUICKBOOKS CONNECTED (403)', fake.status === 403, fake.status);
    const { rows: qb } = await pool.query(`SELECT 1 FROM data_connections WHERE user_id = $1 AND source_type = 'QUICKBOOKS'`, [owner.id]);
    check('heartbeat: no QUICKBOOKS row written', qb.length === 0);
    const tally = await hb('TALLY', 'CONNECTED');
    check('heartbeat: Tally connector token fallback still works (200)', tally.status === 200, tally.status);
    const disc = await hb('QUICKBOOKS', 'DISCONNECTED');
    check('heartbeat: any source may be marked DISCONNECTED (200)', disc.status === 200, disc.status);

    const { authorizeHeartbeat } = require('../lib/domain/ingestion/connections');
    check('authorizeHeartbeat: device limited to its own source',
      authorizeHeartbeat({ device: { sourceType: 'TALLY' }, sourceType: 'XERO', status: 'CONNECTED' }).ok === false);
  } finally {
    if (server) server.stop();
    await deleteUsers(pool, users);
    await pool.end();
  }
}

main().then(done).catch((e) => { console.error('Test run crashed:', e); process.exitCode = 1; });
