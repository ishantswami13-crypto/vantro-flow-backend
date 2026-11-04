// fetchAllRows reads past Supabase's per-response row cap (1,000 by default):
// it pages with a stable order until a short page, and surfaces errors.
import { createRequire } from 'module';
import { makeChecker } from './helpers/httpHarness.mjs';

const require = createRequire(import.meta.url);
const { fetchAllRows } = require('../lib/db/fetchAllRows');
const { check, done } = makeChecker();

// A stand-in for a PostgREST table that never returns more than CAP rows.
function fakeTable(n, cap = 1000) {
  const rows = Array.from({ length: n }, (_, i) => ({ id: i + 1 }));
  const calls = [];
  const build = () => {
    const q = { orders: [], order(col, o) { q.orders.push([col, o]); return q; }, range(from, to) { q.from = from; q.to = to; return q; },
      then(resolve) { calls.push({ from: q.from, to: q.to, orders: q.orders }); resolve({ data: rows.slice(q.from, Math.min(q.to + 1, q.from + cap)), error: null }); } };
    return q;
  };
  return { build, calls };
}

async function main() {
  const big = fakeTable(2500);
  const all = await fetchAllRows(big.build);
  check('2,500 rows behind a 1,000-row cap are all returned', all.length === 2500, all.length);
  check('no row is returned twice', new Set(all.map((r) => r.id)).size === 2500);
  check('pages are ordered by id for a stable walk', big.calls.every((c) => c.orders.some(([col]) => col === 'id')));
  check('stops after the short page (3 requests)', big.calls.length === 3, big.calls.length);

  const exact = fakeTable(1000);
  check('exactly one full page still ends (empty second page)', (await fetchAllRows(exact.build)).length === 1000 && exact.calls.length === 2);

  const empty = fakeTable(0);
  check('an empty table returns []', (await fetchAllRows(empty.build)).length === 0);

  const failing = () => ({ order() { return this; }, range() { return this; }, then(resolve) { resolve({ data: null, error: new Error('relation does not exist') }); } });
  let threw = false;
  try { await fetchAllRows(failing); } catch { threw = true; }
  check('a query error is thrown, not returned as an empty list', threw);
  done();
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
