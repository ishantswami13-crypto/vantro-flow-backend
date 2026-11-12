// Meaning-based Knowledge search (migration 074) through the real
// /api/platform router. The embedder is a deterministic stand-in injected
// through the test seam (lib/platform/embeddings.useEmbedder): it maps words
// to shared "concept" dimensions so that "refund" and "money back" are close.
// Production uses a real provider and only when the feature flag is on.
import { createRequire } from 'node:module';
import { makeChecker, openPool, seedUser, deleteUsers } from './helpers/httpHarness.mjs';

const require = createRequire(import.meta.url);
const express = require('express');
const jwt = require('jsonwebtoken');
const { platformRouter } = require('../lib/routes/platform');
const embeddings = require('../lib/platform/embeddings');

const { check, done } = makeChecker();
const pool = openPool();
const ready = await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'platform_knowledge_chunks' AND column_name = 'embedding'`);
if (!ready.rows[0]) { console.log('SKIP migration 074 not applied'); process.exit(0); }

const CONCEPTS = [
  ['refund', 'refunds', 'money', 'back', 'reimburse', 'return', 'returns'],
  ['warranty', 'guarantee', 'repair', 'defect', 'broken'],
  ['delivery', 'shipping', 'courier', 'dispatch', 'ship'],
  ['invoice', 'bill', 'payment', 'pay', 'paid'],
];
const fakeEmbed = (t) => {
  const v = new Array(CONCEPTS.length + 1).fill(0);
  for (const w of String(t).toLowerCase().match(/[a-z]+/g) || []) {
    const i = CONCEPTS.findIndex((c) => c.includes(w));
    v[i === -1 ? CONCEPTS.length : i] += i === -1 ? 0.05 : 1;
  }
  return v;
};
let calls = 0;
const fake = { model: 'test/concepts', embed: async (texts) => { calls += 1; return texts.map(fakeEmbed); } };

function testAuth(req, res, next) {
  try { req.user = jwt.verify((req.get('authorization') || '').replace(/^Bearer /, ''), process.env.JWT_SECRET); next(); } catch { res.status(401).json({ error: 'auth' }); }
}
const app = express();
app.use(express.json());
app.use('/api/platform', platformRouter({ pool, authMiddleware: testAuth }));
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api/platform`;
const api = async (u, method, path, body) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = {}; try { j = await r.json(); } catch { /* empty */ }
  return { http: r.status, ...j };
};
const created = [];
const flag = process.env.FEATURE_KNOWLEDGE_EMBEDDINGS_ENABLED;

try {
  const a = await seedUser(pool, 'vec-a'); created.push(a.id);
  const b = await seedUser(pool, 'vec-b'); created.push(b.id);
  const col = await api(a, 'POST', '/knowledge/collections', { name: 'Policies', scope: 'organization' });
  await api(a, 'POST', `/knowledge/collections/${col.id}/documents`, { title: 'Customer terms', content: 'Customers can get their money back within 30 days if goods are unused.' });
  await api(a, 'POST', `/knowledge/collections/${col.id}/documents`, { title: 'Shipping', content: 'Orders are dispatched by courier within two working days.' });
  const colB = await api(b, 'POST', '/knowledge/collections', { name: 'B secrets', scope: 'organization' });
  await api(b, 'POST', `/knowledge/collections/${colB.id}/documents`, { title: 'B reimbursement rules', content: 'We reimburse returns only for gold customers.' });

  delete process.env.FEATURE_KNOWLEDGE_EMBEDDINGS_ENABLED;
  embeddings.useEmbedder(null);
  const off = await api(a, 'GET', '/knowledge/search?q=refund%20policy');
  check('without embeddings: word search only, and it says why', off.mode === 'words' && /off on this server/.test(off.note) && off.results.length === 0, off);
  check('indexing does nothing when not configured', (await embeddings.indexPending(pool)) === 0);

  embeddings.useEmbedder(fake);
  const before = await api(a, 'GET', '/knowledge/search?q=refund%20policy');
  check('before indexing it says passages are still being indexed', before.mode === 'hybrid' && /still being indexed/.test(before.note), before);
  const n = await embeddings.indexPending(pool, { limit: 1000 });
  check('background indexing embeds passages', n >= 3, n);
  const stored = (await pool.query('SELECT embedding FROM platform_knowledge_chunks WHERE organization_id = (SELECT organization_id FROM platform_knowledge_collections WHERE id = $1) LIMIT 1', [col.id])).rows[0].embedding;
  check('stored vectors have length 1', Math.abs(Math.sqrt(stored.reduce((s, x) => s + x * x, 0)) - 1) < 1e-4);

  const hit = await api(a, 'GET', '/knowledge/search?q=refund%20policy');
  check('meaning finds "money back" for "refund", which word search misses', hit.mode === 'hybrid' && hit.note === null && hit.results[0]?.title === 'Customer terms' && hit.results[0].matchedBy.join() === 'meaning', hit);
  check('unrelated passages are not returned for meaning', !hit.results.some((r) => r.title === 'Shipping'));
  check('another organization\'s passages never appear', !JSON.stringify(hit).includes('B reimbursement'));
  const both = await api(a, 'GET', '/knowledge/search?q=courier');
  check('a passage found both ways is marked with both', both.results[0]?.title === 'Shipping' && both.results[0].matchedBy.includes('words') && both.results[0].matchedBy.includes('meaning'), both.results);

  embeddings.useEmbedder({ model: 'test/other-model', embed: async (t) => t.map(fakeEmbed) });
  const other = await api(a, 'GET', '/knowledge/search?q=refund%20policy');
  check('vectors from another model are never compared', !other.results.some((r) => r.matchedBy.includes('meaning')) && /still being indexed/.test(other.note), other);

  embeddings.useEmbedder({ model: 'test/concepts', embed: async () => { throw new Error('provider down'); } });
  const failed = await api(a, 'GET', '/knowledge/search?q=courier');
  check('a provider failure falls back to words and says so', failed.mode === 'words' && /failed just now/.test(failed.note) && failed.results[0]?.title === 'Shipping', failed);
  embeddings.useEmbedder({ model: 'test/concepts', embed: async () => [[0, 0, 0]] });
  check('an empty vector from the provider is refused, not stored', (await api(a, 'GET', '/knowledge/search?q=courier')).mode === 'words');

  const { current } = embeddings;
  embeddings.useEmbedder(null);
  check('the flag alone is not enough without a key', current({ FEATURE_KNOWLEDGE_EMBEDDINGS_ENABLED: 'true' }).embedder === null && /No embeddings provider key/.test(current({ FEATURE_KNOWLEDGE_EMBEDDINGS_ENABLED: 'true' }).reason));
  check('a key alone is not enough without the flag', current({ OPENAI_API_KEY: 'k' }).embedder === null);
  check('flag and key pick the provider and default model', current({ FEATURE_KNOWLEDGE_EMBEDDINGS_ENABLED: 'true', GEMINI_API_KEY: 'k' }).embedder.model === 'gemini/gemini-embedding-001');
} catch (err) {
  check('threw', false, err.stack);
} finally {
  embeddings.useEmbedder(null);
  if (flag === undefined) delete process.env.FEATURE_KNOWLEDGE_EMBEDDINGS_ENABLED; else process.env.FEATURE_KNOWLEDGE_EMBEDDINGS_ENABLED = flag;
  server.close();
  await deleteUsers(pool, created);
  await pool.end();
  done();
}
