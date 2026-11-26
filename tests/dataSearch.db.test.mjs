// L5 search (lib/data/search) against a real Postgres (DATABASE_URL, local
// only, migrations applied): name normalisation, typo-tolerant search, detail
// lookups (GSTIN, SKU), duplicate detection, freshness and tenant isolation.
import { createRequire } from 'module';
import { makeChecker, openPool, seedUser, deleteUsers, startServer } from './helpers/httpHarness.mjs';

const require = createRequire(import.meta.url);
require('../lib/db/testDatabaseGuard').assertTestDatabase(process.env.DATABASE_URL);
const { search, duplicates } = require('../lib/data/search');
const { check, done } = makeChecker();

const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };

async function main() {
  if (!process.env.DATABASE_URL) { console.log('SKIP search DB checks: DATABASE_URL not set'); return done(); }
  const pool = openPool();
  const users = [];
  let server = null;
  try {
    const a = await seedUser(pool, 'search-a');
    const b = await seedUser(pool, 'search-b');
    users.push(a.id, b.id);
    const norm = await pool.query("SELECT starlane_norm_name('M/s. Sharma & Sons Pvt. Ltd.') AS x, starlane_norm_name('sharma and sons') AS y");
    check('normalisation: "M/s. Sharma & Sons Pvt. Ltd." == "sharma and sons"', norm.rows[0].x === 'sharma and sons' && norm.rows[0].x === norm.rows[0].y, norm.rows[0]);

    await pool.query(`INSERT INTO customers (user_id, name, gstin) VALUES ($1, 'Sharma & Sons Pvt Ltd', '27AAPFU0939F1ZV'), ($1, 'Gupta Electricals', NULL), ($1, 'Kiran Hardware Stores', NULL)`, [a.id]);
    await pool.query(`INSERT INTO suppliers (user_id, name) VALUES ($1, 'Bharat Copper Wires LLP')`, [a.id]);
    await pool.query(`INSERT INTO products (user_id, name, sku) VALUES ($1, 'Copper Wire 1.5mm', 'CW-150'), ($1, 'Modular Switch 6A', 'MS-6A')`, [a.id]);
    await pool.query(`INSERT INTO invoices (user_id, customer_name, invoice_amount) VALUES ($1, 'M/s Sharma and Sons', 100), ($1, 'Gupta Electrical', 50), ($1, 'Walk-in Buyer', 10)`, [a.id]);
    await pool.query(`INSERT INTO customers (user_id, name) VALUES ($1, 'Sharma Sons Other Tenant')`, [b.id]);

    console.log('search');
    const typo = await search(a.id, 'sharma snos', { pool });
    check('a typo still finds the customer ("sharma snos"): the customer record first, then the same name from invoices',
      typo[0] && typo[0].name === 'Sharma & Sons Pvt Ltd' && typo[1] && typo[1].name === 'M/s Sharma and Sons' && typo[0].score === typo[1].score, typo);
    const partial = await search(a.id, 'copper', { pool });
    check('a word finds the supplier and the product', partial.some((r) => r.type === 'supplier') && partial.some((r) => r.type === 'product' && r.name === 'Copper Wire 1.5mm'), partial);
    const onlyProducts = await search(a.id, 'copper', { types: 'product', pool });
    check('types filter limits results', onlyProducts.length >= 1 && onlyProducts.every((r) => r.type === 'product'));
    const gst = await search(a.id, '27AAPFU0939F', { pool });
    check('a GSTIN prefix finds its customer with score 1', gst[0] && gst[0].name === 'Sharma & Sons Pvt Ltd' && gst[0].score === 1, gst);
    const sku = await search(a.id, 'cw-15', { pool });
    check('a SKU prefix finds its product', sku.some((r) => r.name === 'Copper Wire 1.5mm'), sku);
    const walkIn = await search(a.id, 'walk in buyer', { pool });
    check('names that only exist on invoices are searchable, keyed like the read models', walkIn[0] && walkIn[0].id === 'name:walk-in buyer', walkIn);
    check("another tenant's records never appear", !(await search(a.id, 'other tenant', { pool })).some((r) => r.name.includes('Other Tenant')));
    check('wildcards in the query are literal, not LIKE patterns', (await search(a.id, '%%', { pool })).every((r) => r.score < 1));
    check('a one-character query is refused', !!(await rejects(search(a.id, 'x', { pool }))));
    check('an unknown type is refused', !!(await rejects(search(a.id, 'abc', { types: 'users', pool }))));

    // Two different customers with the same name: inserted higher id first, so
    // without an id tie-break the order would follow the physical row order.
    await pool.query(`INSERT INTO customers (id, user_id, name, phone) VALUES
      ('00000000-0000-4000-8000-0000000000f2', $1, 'Patel Brothers', '911'),
      ('00000000-0000-4000-8000-0000000000f1', $1, 'Patel Brothers', '922')`, [a.id]);
    const twins = (await search(a.id, 'patel brothers', { pool })).map((r) => r.id);
    check('two customers with the same name are both listed, never merged, lower id first',
      twins.join() === '00000000-0000-4000-8000-0000000000f1,00000000-0000-4000-8000-0000000000f2', twins);

    console.log('\nduplicates');
    const dups = await duplicates(a.id, { type: 'customer', pool });
    const pair = (x, y) => dups.find((d) => [d.a.name, d.b.name].sort().join('|') === [x, y].sort().join('|'));
    check('"M/s Sharma and Sons" (invoice) pairs with "Sharma & Sons Pvt Ltd" (customer)', !!pair('M/s Sharma and Sons', 'Sharma & Sons Pvt Ltd'), dups);
    check('"Gupta Electrical" pairs with "Gupta Electricals"', !!pair('Gupta Electrical', 'Gupta Electricals'), dups);
    check('unrelated names are not paired', !dups.some((d) => [d.a.name, d.b.name].includes('Kiran Hardware Stores')));
    const twinPair = dups.find((d) => d.a.name === 'Patel Brothers' && d.b.name === 'Patel Brothers');
    check('the same-name pair is listed once with a fixed a/b order', twinPair && twinPair.a.id < twinPair.b.id && dups.filter((d) => d.a.name === 'Patel Brothers').length === 1, dups);

    console.log('\nfreshness');
    await pool.query("UPDATE customers SET name = 'Kiran Hardware Mart' WHERE user_id = $1 AND name = 'Kiran Hardware Stores'", [a.id]);
    const renamed = await search(a.id, 'kiran mart', { pool });
    check('a renamed customer is found by its new name on the next search', renamed[0] && renamed[0].name === 'Kiran Hardware Mart', renamed);
    await pool.query("DELETE FROM products WHERE user_id = $1 AND sku = 'MS-6A'", [a.id]);
    check('a deleted product disappears', !(await search(a.id, 'modular switch', { pool })).some((r) => r.name.startsWith('Modular')));

    console.log('\nHTTP');
    server = await startServer(46000 + Math.floor(Math.random() * 2000), { STARLANE_DATA_LAYER_ENABLED: 'true', READ_MODEL_SWEEP_MS: '600000' });
    const get = (path, token) => fetch(`${server.base}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    const rb = await (await get('/api/data/search?q=sharma%20sons', b.token)).json();
    check('GET /api/data/search answers for the caller only', rb.results.length === 1 && rb.results[0].name === 'Sharma Sons Other Tenant', rb);
    check('a too-short query is a 400', (await get('/api/data/search?q=a', b.token)).status === 400);
    const rd = await (await get('/api/data/search/duplicates?type=customer', a.token)).json();
    check('GET /api/data/search/duplicates returns pairs', rd.pairs.length >= 2, rd);
  } finally {
    if (server) server.stop();
    await pool.query('DELETE FROM search_entities WHERE user_id = ANY($1)', [users]).catch(() => {});
    await pool.query('DELETE FROM rm_refresh_state WHERE user_id = ANY($1)', [users]).catch(() => {});
    for (const t of ['invoices', 'products', 'suppliers', 'customers']) await pool.query(`DELETE FROM ${t} WHERE user_id = ANY($1)`, [users]).catch(() => {});
    await deleteUsers(pool, users);
    await pool.end();
  }
  done();
}

main().catch((err) => { console.error(err); process.exit(1); });
