// Offline test for tallyImport.service.js — mocked Supabase, no network.
// Run: node lib/services/tallyImport.test.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { importTallyVouchers, normalizeVouchers, tallyRef } = require('./tallyImport.service.js');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  ✅', name); }
  else { fail++; console.log('  ❌', name); }
}

function makeMockSupabase(store) {
  function table(name) {
    const state = { filters: [], likes: [] };
    const api = {
      select() { return api; },
      eq(col, val) { state.filters.push([col, val]); return api; },
      like(col, pat) { state.likes.push([col, pat]); return api; },
      order() { return api; },
      single() {
        return Promise.resolve({ data: store[name][store[name].length - 1] || null, error: null });
      },
      insert(rows) {
        store[name].push(...rows.map((r, i) => ({ id: `${name}-${store[name].length + i + 1}`, ...r })));
        const inserted = store[name].slice(-rows.length);
        return {
          select: () => ({
            single: () => Promise.resolve({ data: inserted[0], error: null }),
          }),
          then: (fn) => Promise.resolve({ data: inserted, error: null }).then(fn),
        };
      },
      update() { return { eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }; },
      then(fn) {
        let rows = store[name];
        for (const [col, val] of state.filters) rows = rows.filter((r) => r[col] === val);
        for (const [col, pat] of state.likes) {
          const re = new RegExp('^' + pat.replace(/[.*+?^${}()|\\]/g, '\\$&').replace(/%/g, '.*').replace(/\[/g, '\\[') );
          rows = rows.filter((r) => re.test(String(r[col] ?? '')));
        }
        return Promise.resolve({ data: rows, error: null }).then(fn);
      },
    };
    return api;
  }
  return { from: table };
}

const SAMPLE = [
  { type: 'Sales', date: '2026-07-15', party: 'Sharma Traders', voucherNo: 'S/1042', amount: 45000, items: [{ name: 'Singer Sewing Machine 8280', qty: 3, rate: 12000 }, { name: 'Bobbin Case (steel)', qty: 30, rate: 300 }] },
  { type: 'Sales', date: '2026-07-18', party: 'Gupta & Sons', voucherNo: 'S/1043', amount: 128500.5, items: [] },
  { type: 'Receipt', date: '2026-07-19', party: 'Sharma Traders', voucherNo: 'R/318', amount: 20000, items: [] },
  { type: 'Purchase', date: '2026-07-16', party: 'Metro Wholesale', voucherNo: 'P/560', amount: 67000, items: [{ name: 'Singer Sewing Machine 8280', qty: 5, rate: 10500 }, { name: 'Machine Oil 100ml', qty: 100, rate: 145 }] },
  { type: 'Payment', date: '2026-07-20', party: 'Metro Wholesale', voucherNo: 'PY/91', amount: 30000, items: [] },
];

const USER = 'test-user-1';

async function main() {
  console.log('\n— normalizeVouchers —');
  const { vouchers, rejected } = normalizeVouchers(SAMPLE);
  check('all 5 sample vouchers accepted', vouchers.length === 5 && rejected.length === 0);
  check('kinds classified correctly', JSON.stringify(vouchers.map((v) => v.kind)) === JSON.stringify(['sales', 'sales', 'receipt', 'purchase', 'payment']));
  check('refs are stable', tallyRef(SAMPLE[0]) === tallyRef({ ...SAMPLE[0] }));

  const bad = normalizeVouchers([
    { type: 'Journal', date: '2026-07-01', party: 'X', amount: 10 },
    { type: 'Sales', date: 'nonsense', party: 'X', amount: 10 },
    { type: 'Sales', date: '2026-07-01', party: 'X', amount: -5 },
    { type: 'Sales', date: '2026-07-01', party: '', amount: 10 },
  ]);
  check('bad vouchers all rejected with reasons', bad.vouchers.length === 0 && bad.rejected.length === 4
    && bad.rejected.map((r) => r.reason).join(',') === 'unsupported_type,bad_date,bad_amount,missing_party');

  console.log('\n— first import —');
  const store = { invoices: [], purchases: [], bank_transactions: [], products: [], stock_movements: [] };
  const supabase = makeMockSupabase(store);
  const r1 = await importTallyVouchers(supabase, USER, SAMPLE);
  check('import succeeds', r1.success === true);
  check('2 sales -> invoices', r1.imported.sales === 2 && store.invoices.length === 2);
  check('1 purchase -> purchases', r1.imported.purchase === 1 && store.purchases.length === 1);
  check('receipt+payment -> bank_transactions', r1.imported.receipt === 1 && r1.imported.payment === 1 && store.bank_transactions.length === 2);
  check('receipt is credit, payment is debit', store.bank_transactions[0].type === 'credit' && store.bank_transactions[1].type === 'debit');
  check('3 distinct products created', store.products.length === 3);
  check('4 stock movements recorded', store.stock_movements.length === 4);
  check('sale movement is out, purchase movement is in',
    store.stock_movements.filter((m) => m.movement_type === 'out').length === 2
    && store.stock_movements.filter((m) => m.movement_type === 'in').length === 2);
  check('invoice ref stored in invoice_number', store.invoices[0].invoice_number.startsWith('TLY-SALES-S1042-'));
  check('purchase ref stored in bill_number', store.purchases[0].bill_number.startsWith('TLY-PURCHASE-P560-'));
  check('nothing auto-marked paid', store.invoices.every((i) => i.payment_status === 'Pending') && store.purchases.every((p) => p.status === 'unpaid'));

  console.log('\n— re-import (idempotency) —');
  const r2 = await importTallyVouchers(supabase, USER, SAMPLE);
  check('second import succeeds', r2.success === true);
  check('zero new rows imported', Object.values(r2.imported).every((n) => n === 0));
  check('all 5 reported as already imported', Object.values(r2.skipped_existing).reduce((a, b) => a + b, 0) === 5);
  check('table row counts unchanged', store.invoices.length === 2 && store.purchases.length === 1 && store.bank_transactions.length === 2 && store.stock_movements.length === 4);

  console.log('\n— input guards —');
  const r3 = await importTallyVouchers(supabase, USER, []);
  check('empty payload rejected 400', r3.status === 400);
  const r4 = await importTallyVouchers(supabase, USER, new Array(5001).fill(SAMPLE[0]));
  check('oversize payload rejected 400', r4.status === 400);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}
main();
