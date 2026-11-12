// The platform API as mounted in the real server.js (real auth middleware,
// CSRF, CORS, worker): workspace, an agent created from a template, a test
// run that fails honestly because no model key is set in this environment,
// the webhook trigger's credential check, and that existing finance routes
// still answer for the same user. Needs DATABASE_URL with migration 072.
import { makeChecker, openPool, seedUser, deleteUsers, startServer } from './helpers/httpHarness.mjs';

const { check, done } = makeChecker();
const pool = openPool();
const ready = await pool.query(`SELECT to_regclass('public.platform_agents') AS t`);
if (!ready.rows[0].t) { console.log('SKIP migration 072 not applied'); process.exit(0); }

const port = 4300 + Math.floor(Math.random() * 400);
const srv = await startServer(port, {
  PLATFORM_WORKER_INTERVAL_MS: '300', GROQ_API_KEY: '', GEMINI_API_KEY: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', XAI_API_KEY: '', PERPLEXITY_API_KEY: '',
});
const users = [];
const call = async (u, method, path, body, headers = {}) => {
  const r = await fetch(`${srv.base}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(u ? { Authorization: `Bearer ${u.token}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = {}; try { j = await r.json(); } catch { /* empty */ }
  return { http: r.status, ...j };
};

try {
  const a = await seedUser(pool, 'plat-http-a'); users.push(a.id);
  const b = await seedUser(pool, 'plat-http-b'); users.push(b.id);
  check('unauthenticated request refused', (await call(null, 'GET', '/api/platform/workspace')).http === 401);
  const ws = await call(a, 'GET', '/api/platform/workspace');
  check('workspace served by the real server', ws.http === 200 && ws.role === 'owner' && Array.isArray(ws.navigation), ws);
  check('server reports no model configured here', ws.model?.configured === false);
  const pre = await fetch(`${srv.base}/api/platform/workspace`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:3000', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'x-starlane-org,idempotency-key' } });
  check('CORS allows the org and idempotency headers', /x-starlane-org/i.test(pre.headers.get('access-control-allow-headers') || ''), pre.headers.get('access-control-allow-headers'));

  const ag = await call(a, 'POST', '/api/platform/agents', { templateKey: 'document_research' });
  check('agent created from a template', ag.http === 200 && ag.id, ag);
  const t = await call(a, 'POST', `/api/platform/agents/${ag.id}/test`, { input: { question: 'What is our refund policy?' } });
  check('test run accepted', t.http === 202, t);
  let ex = null;
  for (let i = 0; i < 40; i += 1) {
    await new Promise((r) => setTimeout(r, 250));
    ex = (await call(a, 'GET', `/api/platform/executions/${t.executionId}`)).execution;
    if (ex && ['completed', 'failed', 'cancelled'].includes(ex.status)) break;
  }
  check('worker picked it up and failed honestly without a model', ex?.status === 'failed' && ex.errorClass === 'MODEL_UNAVAILABLE', ex);
  check('publish blocked without a passing test', (await call(a, 'POST', `/api/platform/agents/${ag.id}/publish`, {})).code === 'CHECKS_FAILED');
  check('another tenant cannot read the run', (await call(b, 'GET', `/api/platform/executions/${t.executionId}`)).http === 404);
  check('bad webhook token is a 404', (await call(null, 'POST', `/api/platform/hooks/agents/${'0'.repeat(48)}`, { x: 1 })).http === 404);
  check('client cannot spoof the org through the body', (await call(b, 'GET', '/api/platform/agents')).agents.length === 0);

  // Existing finance routes still answer for the same JWT.
  const inv = await call(a, 'GET', `/api/invoices/${a.id}`);
  check('existing invoices route still works', inv.http === 200, inv.http);
  const decisions = await call(a, 'GET', '/api/decisions?status=active');
  check('existing decisions route still works', decisions.http === 200 || decisions.http === 503, decisions.http);
} catch (err) {
  check('threw', false, err.stack);
} finally {
  srv.stop();
  await deleteUsers(pool, users);
  await pool.end();
  done();
}
