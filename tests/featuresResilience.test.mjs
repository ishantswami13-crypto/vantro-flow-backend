// A database failure inside any seven-feature route must answer 500 with a
// request reference and keep the server up. Express 4 does not catch a rejected
// async handler by itself: without the router's guard the request would hang
// and the unhandled rejection can stop the process. No database needed.
import { createRequire } from 'node:module';
import http from 'node:http';
const require = createRequire(import.meta.url);
const express = require('express');
const { featuresRouter } = require('../lib/routes/features');
const { clientApiRouter } = require('../lib/routes/clientApi');

let pass = 0, fail = 0;
const check = (name, ok, extra) => { if (ok) { pass++; console.log(`  ✅ ${name}`); } else { fail++; console.log(`  ❌ ${name}`, extra ?? ''); } };

const rejections = [];
process.on('unhandledRejection', (e) => rejections.push(e));
const logged = [];
const realError = console.error;
console.error = (...a) => logged.push(a.join(' '));

const pool = { query: async () => { throw Object.assign(new Error('connection terminated'), { code: 'ECONNRESET' }); } };
const app = express();
app.use(express.json());
app.use((req, res, next) => { req.requestId = 'req-test-1'; next(); });
const authMiddleware = (req, res, next) => { req.user = { userId: '00000000-0000-4000-8000-000000000001' }; next(); };
app.use('/api', featuresRouter({ pool, authMiddleware }));
app.use('/api', clientApiRouter({ pool, authMiddleware, executeApprovedAction: async () => ({ ok: false }) }));
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

const call = (method, path, body) => new Promise((resolve) => {
  const req = http.request(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json' }, timeout: 5000 }, (res) => {
    let data = ''; res.on('data', (c) => { data += c; });
    res.on('end', () => { let json = null; try { json = JSON.parse(data); } catch {} resolve({ status: res.statusCode, json }); });
  });
  req.on('timeout', () => { req.destroy(); resolve({ status: 'timeout' }); });
  req.on('error', (e) => resolve({ status: 'error', error: e.message }));
  if (body) req.write(JSON.stringify(body));
  req.end();
});

const id = '00000000-0000-4000-8000-0000000000aa';
const routes = [
  ['GET', '/api/client/bridge'], ['GET', '/api/client/scan/search?q=mehta'], ['GET', '/api/client/scan/customer/mehta'],
  ['GET', `/api/client/scan/invoice/${id}`], ['GET', '/api/client/watch'], ['GET', `/api/client/watch/${id}`],
  ['POST', `/api/client/watch/${id}/state`, { state: 'acknowledged' }], ['GET', '/api/client/missions'],
  ['POST', '/api/client/missions/preview', { horizonDays: 14 }], ['POST', '/api/client/missions', { horizonDays: 14 }],
  ['GET', `/api/client/missions/${id}`], ['POST', `/api/client/missions/${id}/activate`], ['POST', '/api/client/simulate', { horizonDays: 30 }],
  ['GET', '/api/client/memory'], ['POST', '/api/client/memory', { statement: 'Call the accountant' }],
  ['POST', `/api/client/memory/${id}/confirm`], ['GET', '/api/client/prepared'],
  // The apps' own routes (clientApi.js): actions, decisions, inbox.
  ['GET', '/api/client/actions'], ['GET', `/api/client/actions/${id}`],
  ['POST', `/api/client/actions/${id}/decision`, { decision: 'approve' }], ['GET', '/api/client/inbox'],
];

console.log('— every feature and app route survives a database failure');
for (const [method, path, body] of routes) {
  const r = await call(method, path, body);
  // Some routes degrade instead of failing (the Bridge answers "partial"); either is fine,
  // but none may hang or crash, and a 500 must carry the request reference.
  const ok = r.status !== 'timeout' && r.status !== 'error' && (r.status !== 500 || r.json?.requestId === 'req-test-1');
  check(`${method} ${path.split('?')[0]} -> ${r.status}${r.status === 500 ? ' with reference' : ''}`, ok, r);
}
check('no unhandled promise rejections', rejections.length === 0, rejections.map((e) => e.message));
const traced = logged.filter((l) => l.includes('"requestId":"req-test-1"'));
check('failures are logged with the request id and user', traced.length > 0 && traced.every((l) => l.includes('"userId":"00000000-0000-4000-8000-000000000001"')), logged.slice(0, 3));
check('logs carry no invoice amounts or customer names', !logged.some((l) => /invoice_amount|Mehta Hardware|₹/.test(l)));
check('the server still answers after all of that', (await call('GET', '/api/client/prepared')).status !== 'timeout');

server.close();
console.error = realError;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
