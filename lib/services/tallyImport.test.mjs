// Offline test for tallyImport.service.js — mocked Supabase, no network.
// Run: node lib/services/tallyImport.test.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { importTallyVouchers, normalizeVouchers, tallyRef, reconcileTallyRange } = require('./tallyImport.service.js');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ✅', name); }
  else { fail++; console.log('  ❌', name, detail !== undefined ? JSON.stringify(detail) : ''); }
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
          eq(col, val) { where.push((r) => r[col] === val); return chain; },
          is(col, val) { where.push((r) => (r[col] ?? null) === val); return chain; },
          select() { return chain; },
          then(fn) {
            const hit = store[name].filter((r) => where.every((w) => w(r)));
            for (const r of hit) Object.assign(r, patch);
            return Promise.resolve({ data: hit.map((r) => ({ id: r.id })), error: null }).then(fn);
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
  check('an empty day book is a real answer: success, nothing imported', r3.success === true && Object.values(r3.imported).every((x) => x === 0), r3);
  check('a payload that is not a list is rejected 400', (await importTallyVouchers(supabase, USER, 'nope')).status === 400);
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

  console.log('\n— corrections made in Tally since the last sync —');
  const CORRECTED = [
    { ...BILLWISE[0], amount: 130000, bills: [{ name: 'S/201', type: 'new', amount: 130000 }] },
    { type: 'Sales', date: '2026-08-05', party: 'Rao & Sons', voucherNo: 'S/202', amount: 0, items: [], bills: [], cancelled: true },
    BILLWISE[2],
    { ...BILLWISE[3], amount: 60000, bills: [{ name: 'S/201', type: 'against', amount: 60000 }] },
    { type: 'Receipt', date: '2026-09-12', party: 'Singh Electricals', voucherNo: 'R/32', amount: 0, items: [], bills: [], cancelled: true },
    { type: 'Credit Note', date: '2026-09-15', party: 'Rao & Sons', voucherNo: 'CN/4', amount: 0, items: [], bills: [], cancelled: true },
    BILLWISE[6],
  ];
  const cw = { invoices: [], purchases: [], bank_transactions: [], products: [], stock_movements: [] };
  const scw = makeMockSupabase(cw);
  await importTallyVouchers(scw, USER, BILLWISE.slice(0, 7));
  const cinv = (no) => cw.invoices.find((i) => i.invoice_number.includes(`-${no}-`));
  check('before: S/203 paid, S/201 part-paid 50000, S/202 credited 5000', cinv('S203').payment_status === 'Paid' && cinv('S201').payment_amount === 50000 && cinv('S202').payment_amount === 5000);
  const c1 = await importTallyVouchers(scw, USER, CORRECTED);
  check('an edited sale takes Tally\'s new amount', cinv('S201').invoice_amount === 130000, cinv('S201'));
  check('an edited receipt moves the bill by the difference (50000 -> 60000)', cinv('S201').payment_amount === 60000 && cinv('S201').payment_status === 'Pending', cinv('S201'));
  check('a cancelled sale is Cancelled, never chased', cinv('S202').payment_status === 'Cancelled');
  check('its cancelled credit note is taken back', cinv('S202').payment_amount === 0 && !/CN4/.test(cinv('S202').payment_notes || ''), cinv('S202'));
  check('a cancelled receipt re-opens the bill it had settled', cinv('S203').payment_status === 'Pending' && cinv('S203').payment_amount === 0 && cinv('S203').payment_date === null, cinv('S203'));
  check('its bank line is marked cancelled', cw.bank_transactions.find((t) => t.description.includes('R32')).status === 'cancelled');
  check('corrections are counted', c1.corrections.amounts_updated === 2 && c1.corrections.cancelled === 2 && c1.corrections.settlements_changed === 3, c1.corrections);
  check('no new invoices from cancelled vouchers', cw.invoices.length === 3);
  const c2 = await importTallyVouchers(scw, USER, CORRECTED);
  check('syncing the corrected books again changes nothing', Object.values(c2.corrections).every((x) => x === 0)
    && cinv('S201').payment_amount === 60000 && cinv('S203').payment_amount === 0, c2.corrections);
  const c3 = await importTallyVouchers(scw, USER, [
    { type: 'Receipt', date: '2026-09-30', party: 'Mehta Hardware', voucherNo: 'R/40', amount: 70000, items: [], bills: [{ name: 'S/201', type: 'against', amount: 70000 }] },
  ]);
  check('a later receipt still completes the corrected bill', cinv('S201').payment_status === 'Paid' && cinv('S201').payment_amount === 130000 && c3.imported.bills_settled === 1);
  await importTallyVouchers(scw, USER, [{ ...BILLWISE[0], amount: 140000, bills: [] }]);
  check('raising the bill in Tally after it was paid re-opens it for the difference', cinv('S201').payment_status === 'Pending' && cinv('S201').invoice_amount === 140000, cinv('S201'));
  const c4 = await importTallyVouchers(scw, USER, [{ type: 'Sales', date: '2026-09-01', party: 'Nobody', voucherNo: 'S/999', amount: 0, items: [], bills: [], cancelled: true }]);
  check('a cancelled voucher never imported creates nothing', c4.success && cw.invoices.length === 3);

  console.log('\n— a cancelled sale gives its stock back —');
  const st = { invoices: [], purchases: [], bank_transactions: [], products: [], stock_movements: [] };
  const sst = makeMockSupabase(st);
  const SALE = { type: 'Sales', date: '2026-08-01', party: 'Mehta Hardware', voucherNo: 'S/501', amount: 3000, items: [{ name: 'Hinge', qty: 10, rate: 300 }], bills: [] };
  const BUY = { type: 'Purchase', date: '2026-07-01', party: 'Metro', voucherNo: 'P/9', amount: 6000, items: [{ name: 'Hinge', qty: 30, rate: 200 }], bills: [] };
  await importTallyVouchers(sst, USER, [BUY, SALE]);
  const hinge = () => st.products.find((p) => p.name === 'Hinge').current_stock;
  check('before: 30 bought, 10 sold -> 20 in stock', hinge() === 20, hinge());
  const s1 = await importTallyVouchers(sst, USER, [BUY, { ...SALE, amount: 0, items: [], cancelled: true }]);
  check('cancelling the sale puts its 10 back', hinge() === 30 && s1.corrections.stock_reversed === 1, [hinge(), s1.corrections]);
  check('the reversal is recorded as its own movement', st.stock_movements.some((m) => m.reference.endsWith(':cancelled') && m.movement_type === 'in' && m.quantity === 10));
  const s2 = await importTallyVouchers(sst, USER, [BUY, { ...SALE, amount: 0, items: [], cancelled: true }]);
  check('re-syncing never reverses it twice', hinge() === 30 && s2.corrections.stock_reversed === 0, [hinge(), s2.corrections]);
  await importTallyVouchers(sst, USER, [{ ...BUY, amount: 0, items: [], cancelled: true }]);
  check('a cancelled purchase takes its stock out again', hinge() === 0, hinge());

  console.log('\n— vouchers deleted in Tally (not cancelled) —');
  const dl = { invoices: [], purchases: [], bank_transactions: [], products: [], stock_movements: [] };
  const sdl = makeMockSupabase(dl);
  await importTallyVouchers(sdl, USER, BILLWISE.slice(0, 7));
  const dinv = (no) => dl.invoices.find((i) => i.invoice_number.includes(`-${no}-`));
  const ident = (v) => ({ type: v.type, voucherNo: v.voucherNo, date: v.date });
  const everything = BILLWISE.slice(0, 7).map(ident);
  const range = { from: '2026-08-01', to: '2026-09-30' };
  const d0 = await reconcileTallyRange(sdl, USER, { ...range, present: everything });
  check('nothing missing -> nothing deleted', d0.success && !d0.held && Object.values(d0.deleted).every((x) => x === 0), d0);
  const d1 = await reconcileTallyRange(sdl, USER, { ...range, present: everything.filter((v) => !['S/203', 'R/31'].includes(v.voucherNo)) });
  check('a deleted sale\'s bill becomes Cancelled', dinv('S203').payment_status === 'Cancelled' && /Deleted in Tally/.test(dinv('S203').payment_notes), dinv('S203'));
  check('a deleted receipt\'s settlement is taken back', dinv('S201').payment_amount === 0 && dinv('S201').payment_status === 'Pending', dinv('S201'));
  check('its unmatched bank line is cancelled', dl.bank_transactions.find((t) => t.description.includes('R31')).status === 'cancelled');
  check('deletions reported', d1.deleted.bills === 1 && d1.deleted.settlements === 1 && d1.deleted.bank_lines === 1, d1.deleted);
  const d2 = await reconcileTallyRange(sdl, USER, { ...range, present: everything.filter((v) => !['S/203', 'R/31'].includes(v.voucherNo)) });
  check('reconciling again changes nothing', Object.values(d2.deleted).every((x) => x === 0), d2.deleted);
  const before = JSON.stringify(dl.invoices);
  const d3 = await reconcileTallyRange(sdl, USER, { ...range, present: [ident(BILLWISE[0])] });
  check('a partial export (most vouchers missing) is held, nothing changes', d3.held === true && JSON.stringify(dl.invoices) === before, d3);
  const d4 = await reconcileTallyRange(sdl, USER, { ...range, present: [] });
  check('an empty export never deletes anything', !d4.held && Object.values(d4.deleted).every((x) => x === 0) && JSON.stringify(dl.invoices) === before);
  // September's vouchers only: August's sales are outside the range, so their absence means nothing.
  const d5 = await reconcileTallyRange(sdl, USER, { from: '2026-09-01', to: '2026-09-30', present: [BILLWISE[4], BILLWISE[5], BILLWISE[6]].map(ident) });
  check('only vouchers dated inside the range are considered', dinv('S202').payment_status === 'Pending' && dinv('S201').payment_status === 'Pending'
    && !d5.held && Object.values(d5.deleted).every((x) => x === 0), d5);
  check('bad range rejected', (await reconcileTallyRange(sdl, USER, { from: 'x', to: '2026-09-30', present: [] })).status === 400);

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

  console.log('\n— phone numbers from Tally party ledgers —');
  const tc = { invoices: [
      { id: 'a', user_id: USER, customer_name: 'Mehta Hardware', customer_phone: '9810000001', invoice_number: 'S/101', invoice_amount: 10 },
      { id: 'b', user_id: USER, customer_name: 'Gupta Traders', customer_phone: null, invoice_number: 'TLY-SALES-S9-20260510', invoice_amount: 10 },
      { id: 'c', user_id: 'someone-else', customer_name: 'Gupta Traders', customer_phone: null, invoice_number: 'G/1', invoice_amount: 10 }],
    purchases: [], bank_transactions: [], products: [], stock_movements: [] };
  const t1 = await importTallyVouchers(makeMockSupabase(tc), USER,
    [{ type: 'Sales', date: '2026-06-01', party: 'Rao & Sons', voucherNo: 'S/300', amount: 500, items: [], bills: [] }],
    { contacts: [
      { party: 'Mehta Hardware', phone: '+91 99999 00000' },
      { party: 'Gupta Traders', phone: '+91 98111-22233' },
      { party: 'Rao & Sons', phone: '098765 43210' },
      { party: 'Kapoor & Co', phone: '011-2345678' },
    ] });
  const at = (id) => tc.invoices.find((i) => i.id === id);
  check('the owner\'s number on file is never replaced', at('a').customer_phone === '9810000001');
  check('a bill with no number gets the Tally ledger mobile', at('b').customer_phone === '9811122233');
  check('another business\'s bills are never touched', at('c').customer_phone === null);
  check('a new bill gets its customer\'s Tally mobile (leading 0 dropped)', tc.invoices.find((i) => i.customer_name === 'Rao & Sons').customer_phone === '9876543210');
  check('a landline is not used as a mobile, and is counted', t1.contacts.not_a_mobile === 1 && t1.contacts.customers_updated === 1 && t1.contacts.received === 4, t1.contacts);

  console.log('\n— same bill from a file and from Tally (source authority) —');
  const xs = { invoices: [
    { id: 'f1', user_id: USER, customer_name: 'Sharma Traders', invoice_number: 'S/1042', invoice_amount: 40000, payment_status: 'Paid' },
    { id: 'f2', user_id: USER, customer_name: 'Gupta & Sons', invoice_number: 'S/1043', invoice_amount: 128500.5, payment_status: 'Pending' },
    { id: 'f3', user_id: USER, customer_name: 'Other Party', invoice_number: 'S/1042', invoice_amount: 999, payment_status: 'Pending' },
    { id: 'f4', user_id: 'someone-else', customer_name: 'Sharma Traders', invoice_number: 'S/1042', invoice_amount: 40000, payment_status: 'Pending' },
    { id: 'f5', user_id: USER, customer_name: 'Sharma Traders', invoice_number: 'S/1042', invoice_amount: 7000, payment_status: 'Pending', invoice_date: '2025-07-15' },
  ], purchases: [], bank_transactions: [], products: [], stock_movements: [] };
  const x1 = await importTallyVouchers(makeMockSupabase(xs), USER, SAMPLE.filter((v) => v.type === 'Sales'));
  const xr = (id) => xs.invoices.find((i) => i.id === id);
  check('file copies of the two Tally bills are withdrawn (Tally is the book of record)', xr('f1').payment_status === 'Cancelled' && xr('f2').payment_status === 'Cancelled' && x1.cross_source.superseded === 2, x1.cross_source);
  check('each bill is counted once: open total equals Tally only', xs.invoices.filter((i) => i.user_id === USER && i.customer_name !== 'Other Party' && i.payment_status !== 'Cancelled' && i.id !== 'f5').length === 2);
  check('the disagreement is kept and said (amount and paid vs unpaid)', x1.cross_source.disagreements.length === 1 && /Paid/.test(x1.cross_source.disagreements[0].differences.join(' ')) && /40,000/.test(xr('f1').payment_notes), JSON.stringify(x1.cross_source) + ' ' + xr('f1').payment_notes);
  check('a same-numbered bill of another party is not touched', xr('f3').payment_status === 'Pending');
  check('another business\'s rows are never touched', xr('f4').payment_status === 'Pending');
  check('the same number from another year (Tally restarts numbering) is a different bill', xr('f5').payment_status === 'Pending');
  const x2 = await importTallyVouchers(makeMockSupabase(xs), USER, SAMPLE.filter((v) => v.type === 'Sales'));
  check('re-sync supersedes nothing new', x2.cross_source.superseded === 0 && x2.imported.sales === 0);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}
main();
