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
      not(col, op, val) { if (op === 'is' && val === null) state.notNull = [...(state.notNull || []), col]; return api; },
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
      update(patch) {
        const where = [];
        const chain = {
          eq(col, val) {
            where.push([col, val]);
            if (where.length < 2) return chain;
            for (const r of store[name]) if (where.every(([c, v]) => r[c] === v)) Object.assign(r, patch);
            return Promise.resolve({ error: null });
          },
        };
        return chain;
      },
      then(fn) {
        let rows = store[name];
        for (const [col, val] of state.filters) rows = rows.filter((r) => r[col] === val);
        for (const col of state.notNull || []) rows = rows.filter((r) => r[col] != null);
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

  console.log('\n— bill-wise Tally books (due dates, credit notes, Agst Ref receipts) —');
  const BILLWISE = [
    { type: 'Sales', date: '2026-08-01', party: 'Mehta Hardware', voucherNo: 'S/201', amount: 128500, items: [], dueDate: '2026-08-31', bills: [{ name: 'S/201', type: 'new', amount: 128500 }] },
    { type: 'Sales', date: '2026-08-05', party: 'Rao & Sons', voucherNo: 'S/202', amount: 45000, items: [], dueDate: '2026-09-20', bills: [{ name: 'S/202', type: 'new', amount: 45000 }] },
    { type: 'Sales', date: '2026-08-10', party: 'Singh Electricals', voucherNo: 'S/203', amount: 15000, items: [], dueDate: null, bills: [] },
    { type: 'Receipt', date: '2026-09-05', party: 'Mehta Hardware', voucherNo: 'R/31', amount: 50000, items: [], dueDate: null, bills: [{ name: 'S/201', type: 'against', amount: 50000 }] },
    { type: 'Receipt', date: '2026-09-12', party: 'Singh Electricals', voucherNo: 'R/32', amount: 15000, items: [], dueDate: null, bills: [{ name: 'S/203', type: 'against', amount: 15000 }] },
    { type: 'Credit Note', date: '2026-09-15', party: 'Rao & Sons', voucherNo: 'CN/4', amount: 5000, items: [{ name: 'Returned Hinge', qty: 5, rate: 1000 }], dueDate: null, bills: [{ name: 'S/202', type: 'against', amount: 5000 }] },
    { type: 'Receipt', date: '2026-09-20', party: 'Kapoor & Co', voucherNo: 'R/33', amount: 10000, items: [], dueDate: null, bills: [{ name: 'On Account', type: 'on_account', amount: 10000 }] },
    { type: 'Receipt', date: '2026-09-21', party: 'Mehta Hardware', voucherNo: 'R/34', amount: 900, items: [], dueDate: null, bills: [{ name: 'S/999', type: 'against', amount: 900 }] },
    { type: 'Debit Note', date: '2026-09-22', party: 'Metro Wholesale', voucherNo: 'DN/2', amount: 700, items: [], dueDate: null, bills: [] },
  ];
  const bw = { invoices: [], purchases: [], bank_transactions: [], products: [], stock_movements: [] };
  const sbw = makeMockSupabase(bw);
  const b1 = await importTallyVouchers(sbw, USER, BILLWISE);
  const inv = (no) => bw.invoices.find((i) => i.invoice_number.includes(`-${no}-`));
  check('bill-wise import succeeds', b1.success === true);
  check('only the 3 sales became receivables (credit/debit notes did not)', bw.invoices.length === 3 && bw.purchases.length === 0);
  check('credit note moved no stock', bw.stock_movements.length === 0 && bw.products.length === 0);
  check('sale keeps Tally due date from its credit period', inv('S201').due_date === '2026-08-31' && inv('S202').due_date === '2026-09-20');
  check('sale without a credit period is due on its date', inv('S203').due_date === '2026-08-10');
  check('receipt Agst Ref settles that bill in full', inv('S203').payment_status === 'Paid' && inv('S203').payment_amount === 15000 && inv('S203').payment_date === '2026-09-12');
  check('part receipt leaves bill open with amount paid', inv('S201').payment_status === 'Pending' && inv('S201').payment_amount === 50000);
  check('credit note Agst Ref reduces that bill', inv('S202').payment_status === 'Pending' && inv('S202').payment_amount === 5000);
  check('settled / part-paid counted', b1.imported.bills_settled === 1 && b1.imported.bills_part_paid === 2);
  check('on-account, unknown bill and debit note reported, not guessed',
    b1.unapplied.on_account === 1 && b1.unapplied.bill_not_found === 1 && b1.unapplied.debit_notes === 1);
  check('receipts still recorded as bank credits', bw.bank_transactions.filter((t) => t.type === 'credit').length === 4);

  const b2 = await importTallyVouchers(sbw, USER, BILLWISE);
  check('re-sync applies nothing twice', b2.imported.bills_settled === 0 && b2.imported.bills_part_paid === 0
    && inv('S201').payment_amount === 50000 && inv('S202').payment_amount === 5000);

  const b3 = await importTallyVouchers(sbw, USER, [
    { type: 'Receipt', date: '2026-09-25', party: 'mehta hardware', voucherNo: 'R/40', amount: 78500, items: [], bills: [{ name: 'S/201', type: 'against', amount: 78500 }] },
  ]);
  check('later receipt completes the part-paid bill', b3.imported.bills_settled === 1 && inv('S201').payment_status === 'Paid'
    && inv('S201').payment_amount === 128500 && inv('S201').payment_date === '2026-09-25');

  const b4 = await importTallyVouchers(sbw, USER, [
    { type: 'Receipt', date: '2026-08-02', party: 'Rao & Sons', voucherNo: 'R/1', amount: 100, items: [], bills: [{ name: 'S/202', type: 'against', amount: 100 }] },
  ]);
  check('receipt dated before the bill is not applied to it', b4.unapplied.bill_not_found === 1 && inv('S202').payment_amount === 5000);

  console.log('\n— opening bills (earlier years, still unpaid when the synced range starts) —');
  const ob = { invoices: [], purchases: [], bank_transactions: [], products: [], stock_movements: [] };
  const sob = makeMockSupabase(ob);
  const OPENING = [
    { type: 'Opening Bill', date: '2026-01-10', party: 'Mehta Hardware', voucherNo: 'S/1450', amount: 32000, items: [], dueDate: '2026-02-09', bills: [] },
    { type: 'Opening Bill', date: '2025-11-20', party: 'Gupta Traders', voucherNo: 'S/1320', amount: 7250.5, items: [], dueDate: null, bills: [] },
  ];
  const o1 = await importTallyVouchers(sob, USER, [
    ...OPENING,
    { type: 'Receipt', date: '2026-04-12', party: 'Mehta Hardware', voucherNo: 'R/2', amount: 12000, items: [], bills: [{ name: 'S/1450', type: 'against', amount: 12000 }] },
  ]);
  const oinv = (no) => ob.invoices.find((i) => i.invoice_number.includes(`-${no}-`));
  check('opening bills become open invoices at the amount still owed', o1.imported.opening === 2 && o1.imported.sales === 0
    && oinv('S1450').invoice_amount === 32000 && oinv('S1320').invoice_amount === 7250.5, o1.imported);
  check('opening bill keeps its bill date and Tally due date (or is due on its date)', oinv('S1450').invoice_date === '2026-01-10'
    && oinv('S1450').due_date === '2026-02-09' && oinv('S1320').due_date === '2025-11-20');
  check('a receipt this year settles an opening bill by name', o1.imported.bills_part_paid === 1 && oinv('S1450').payment_amount === 12000);
  const o2 = await importTallyVouchers(sob, USER, OPENING);
  check('re-sending opening bills creates nothing new', o2.imported.opening === 0 && o2.skipped_existing.opening === 2 && ob.invoices.length === 2);
  // Next April the same unpaid bill comes back as an opening bill under the new range,
  // and a day book that reaches back returns it as a sale: still one invoice each time.
  const o3 = await importTallyVouchers(sob, USER, [{ type: 'Sales', date: '2026-01-10', party: 'Mehta Hardware', voucherNo: 'S/1450', amount: 40000, items: [], bills: [] }]);
  check('the day-book sale of an opening bill is the same bill (not a second invoice)', o3.imported.sales === 0 && o3.skipped_existing.sales === 1 && ob.invoices.length === 2);
  const o4 = await importTallyVouchers(sob, USER, [
    { type: 'Sales', date: '2026-06-01', party: 'Rao & Sons', voucherNo: 'S/88', amount: 5000, items: [], bills: [] },
  ]);
  const o5 = await importTallyVouchers(sob, USER, [
    { type: 'Opening Bill', date: '2026-06-01', party: 'Rao & Sons', voucherNo: 'S/88', amount: 5000, items: [], bills: [] },
  ]);
  check('a sale later reported as an opening bill is the same bill', o4.imported.sales === 1 && o5.imported.opening === 0 && ob.invoices.length === 3);
  const o6 = await importTallyVouchers(sob, USER, [
    { type: 'Opening Bill', date: '2026-06-01', party: 'Singh Electricals', voucherNo: 'S/88', amount: 900, items: [], bills: [] },
  ]);
  check('the same bill number for another party is a different bill', o6.imported.opening === 1 && ob.invoices.length === 4);

  console.log('\n— phone numbers (Tally vouchers carry none) —');
  const ph = { invoices: [{ id: 'm1', user_id: USER, customer_name: 'Mehta Hardware', customer_phone: '9810000001', invoice_number: 'S/101', invoice_amount: 10 },
    { id: 'x1', user_id: 'someone-else', customer_name: 'Gupta Traders', customer_phone: '9999999999', invoice_number: 'G/1', invoice_amount: 10 }],
    purchases: [], bank_transactions: [], products: [], stock_movements: [] };
  await importTallyVouchers(makeMockSupabase(ph), USER, [
    { type: 'Opening Bill', date: '2026-01-10', party: 'mehta hardware', voucherNo: 'S/1450', amount: 32000, items: [], bills: [] },
    { type: 'Sales', date: '2026-05-10', party: 'Gupta Traders', voucherNo: 'S/9', amount: 1000, items: [], bills: [] },
  ]);
  const byNo = (no) => ph.invoices.find((i) => String(i.invoice_number).includes(`-${no}-`));
  check('a new Tally bill takes the number already on file for that customer', byNo('S1450').customer_phone === '9810000001');
  check('never another business\'s number, never a guessed one', byNo('S9').customer_phone === null);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}
main();
