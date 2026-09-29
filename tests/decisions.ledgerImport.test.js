// FILE: tests/decisions.ledgerImport.test.js
// Bring-your-own-data path for the decision loop, plus the pilot red-team
// cases: messy files, no false alarms on healthy data, no guessing when a
// critical field is missing, idempotent re-import, feedback, isolation.
//
// Run: DATABASE_URL=... JWT_SECRET=... node --test tests/decisions.ledgerImport.test.js
// The HTTP cases skip (never pass silently) when no database is configured.

const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const L = require('../lib/domain/decisions/ledgerImport');
const { deriveReceivablesState } = require('../lib/domain/decisions/snapshot');
const { dbReady, createTenant, deleteTenant, startServer, client, tokenFor, todayIso } = require('./helpers/decisionHarness');
const { slippingCustomerCsv, healthyCsv, noDueDatesCsv, confirmedOptions } = require('./fixtures/pilotLedgers');

const AS_OF = Date.parse('2026-09-29T00:00:00Z');

function preview(csv, name = 'ledger.csv', mappingInput = null) {
  return L.previewLedger(Buffer.from(csv), name, { asOf: AS_OF, mappingInput });
}

// ── Pure: reading real-world files ──────────────────────────────────────

test('status words: "Unpaid" and "Partially paid" are never read as paid', () => {
  const csv = 'Customer,Invoice No,Invoice Date,Due Date,Amount,Status\nA (Fixture),1,01/08/2026,31/08/2026,1000,Unpaid\nB (Fixture),2,01/08/2026,31/08/2026,1000,Partially paid\nC (Fixture),3,01/08/2026,31/08/2026,1000,Paid\n';
  const p = preview(csv);
  const byNo = Object.fromEntries(L.normalizeRows(p.file.columns, L.readLedgerFile(Buffer.from(csv), 'x.csv').rows, L.validateMapping(p.file.columns, p.suggestedInput), { asOf: AS_OF }).records.map((r) => [r.invoice_number, r]));
  assert.equal(byNo['1'].payment_status, 'Pending');
  assert.equal(byNo['2'].payment_status, 'Pending');
  assert.equal(byNo['3'].payment_status, 'Paid');
  assert.equal(p.profile.warnings.partialAmountUnknown.count, 1);
});

test('rows that cannot be read are rejected with a reason and row number, never guessed', () => {
  const csv = [
    'Report as on 29-09-2026',
    'Party Name,Bill No,Bill Date,Due Date,Bill Amount,Status',
    'Good (Fixture),G1,03/04/2026,03/05/2026,"1,20,000.50",Unpaid',
    'Credit (Fixture),C1,03/04/2026,03/05/2026,5000 Cr,Unpaid',
    'Grand Total,,,,"1,25,000",',
    'Bad Date (Fixture),B1,31/02/2026,,5000,Unpaid',
    'No Date (Fixture),N1,,,5000,Unpaid',
    'Future (Fixture),F1,01/01/2030,,5000,Unpaid',
    'Negative (Fixture),X1,03/04/2026,,-500,Unpaid',
    'Weird (Fixture),W1,03/04/2026,,500,maybe',
    'Void (Fixture),V1,03/04/2026,,500,Cancelled',
    'Good (Fixture),G1,03/04/2026,03/05/2026,"1,20,000.50",Unpaid',
    'Good (Fixture),G1,04/04/2026,03/05/2026,"99,000",Unpaid',
  ].join('\n');
  const p = preview(csv);
  assert.equal(p.file.columns[0], 'Party Name', 'title block above the header is skipped');
  const recs = L.normalizeRows(p.file.columns, L.readLedgerFile(Buffer.from(csv), 'x.csv').rows, L.validateMapping(p.file.columns, p.suggestedInput), { asOf: AS_OF });
  assert.equal(recs.records.length, 1);
  assert.equal(recs.records[0].invoice_amount, 120000.5);
  assert.equal(recs.records[0].invoice_date, '2026-04-03');
  const reasons = recs.rejected.map((r) => r.reason).join(' | ');
  for (const needle of ['Cr', 'totals row', 'could not be read', 'no invoice date', 'in the future', 'negative amount', 'not understood', 'Cancelled', 'different amount or date']) {
    assert.ok(reasons.includes(needle), `expected a rejection mentioning "${needle}" in: ${reasons}`);
  }
  assert.equal(recs.warnings.duplicateRow.count, 1, 'an identical repeated row is skipped, not imported twice');
  assert.ok(recs.rejected.every((r) => Number.isInteger(r.row) && r.row >= 2));
});

test('date order: proven from the data when possible, otherwise the human must confirm', () => {
  assert.equal(L.detectDateOrder(['13/04/2026', '01/05/2026']).verdict, 'PROVEN');
  assert.equal(L.detectDateOrder(['13/04/2026']).order, 'DMY');
  assert.equal(L.detectDateOrder(['04/13/2026']).order, 'MDY');
  assert.equal(L.detectDateOrder(['03/04/2026', '05/06/2026']).verdict, 'ASSUMED');
  assert.equal(L.detectDateOrder(['2026-04-03', '1-Apr-2026']).verdict, 'NOT_NEEDED');
  assert.equal(L.detectDateOrder(['13/04/2026', '04/13/2026']).verdict, 'CONFLICT');
  assert.equal(L.parseDateWithOrder('1-Apr-26'), Date.UTC(2026, 3, 1));
  assert.equal(L.parseDateWithOrder('Apr 3, 2026'), Date.UTC(2026, 3, 3));
  assert.equal(L.parseDateWithOrder('03/04/2026', 'MDY'), Date.UTC(2026, 2, 4));

  const csv = 'Customer,Invoice Date,Amount,Status\nA (Fixture),03/04/2026,1000,Unpaid\n';
  const p = preview(csv);
  assert.ok(p.proposal.needsConfirmation.some((n) => n.key === 'dateOrder:Invoice Date'));
  const v = L.validateMapping(p.file.columns, { mapping: { customer: 'Customer', invoice_date: 'Invoice Date', amount: 'Amount', status: 'Status' } });
  assert.equal(v.ok, false, 'commit without an explicit date order is refused');
  assert.ok(v.errors.some((e) => e.includes('day/month')));
});

test('no status, paid or balance column: Starlane asks before treating everything as unpaid', () => {
  const csv = 'Customer,Invoice Date,Due Date,Amount\nA (Fixture),2026-08-01,2026-08-31,1000\n';
  const p = preview(csv);
  assert.ok(p.proposal.needsConfirmation.some((n) => n.key === 'assumption:all_open'));
  const without = L.validateMapping(p.file.columns, { ...p.suggestedInput, allOpen: false });
  assert.equal(without.ok, false);
  const withIt = L.validateMapping(p.file.columns, { ...p.suggestedInput, allOpen: true });
  assert.equal(withIt.ok, true);
});

test('money: Indian grouping, symbols, brackets; part-payments reduce what is owed', () => {
  assert.equal(L.parseMoney('1,20,000.50').value, 120000.5);
  assert.equal(L.parseMoney('₹ 45,000').value, 45000);
  assert.equal(L.parseMoney('Rs. 1,000').value, 1000);
  assert.equal(L.parseMoney('(5,000)').value, -5000);
  assert.equal(L.parseMoney('8000 Dr').side, 'dr');
  assert.ok(L.parseMoney('abc').error);

  const csv = 'Customer,Invoice No,Invoice Date,Due Date,Invoice Amount,Amount Received\nA (Fixture),1,2026-06-01,2026-07-01,"1,00,000","40,000"\n';
  const p = preview(csv);
  const rec = L.normalizeRows(p.file.columns, L.readLedgerFile(Buffer.from(csv), 'x.csv').rows, L.validateMapping(p.file.columns, p.suggestedInput), { asOf: AS_OF }).records[0];
  assert.equal(rec.payment_status, 'Pending');
  assert.equal(rec.payment_amount, 40000);
  const state = deriveReceivablesState({ invoices: [{ id: 'i1', ...rec }], customers: [] }, AS_OF, { mode: 'live' });
  assert.equal(state.invoices[0].outstanding, 60000, 'the engine must see ₹60,000 owed, not ₹1,00,000');
});

test('xlsx with real date cells and a semicolon csv both import without date ambiguity', () => {
  const ws = XLSX.utils.aoa_to_sheet([
    ['Party Name', 'Bill No', 'Bill Date', 'Due Date', 'Bill Amount', 'Status'],
    ['A (Fixture)', 'A1', new Date(Date.UTC(2026, 3, 3)), new Date(Date.UTC(2026, 4, 3)), 120000, 'Unpaid'],
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Outstanding');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const p = L.previewLedger(buf, 'ledger.xlsx', { asOf: AS_OF });
  assert.equal(p.ok, true);
  assert.equal(p.sampleRecords[0].invoice_date, '2026-04-03');
  assert.equal(p.proposal.dateOrders['Bill Date'].verdict, 'NOT_NEEDED');

  const semi = 'Party Name;Bill No;Bill Date;Bill Amount;Status\n"Rao, Sons (Fixture)";R1;2026-04-03;"1,000";Unpaid\n';
  const s = preview(semi);
  assert.equal(s.sampleRecords[0].customer_name, 'Rao, Sons (Fixture)');
  assert.equal(s.sampleRecords[0].invoice_amount, 1000);
});

test('names that differ only by suffix are flagged for a human, not merged', () => {
  const groups = L.similarNames(['Kapoor & Sons', 'Kapoor and Sons Pvt Ltd', 'KAPOOR & SONS', 'Mehta Stores']);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].length, 3);
});

// ── HTTP + database: the pilot path end to end ───────────────────────────

let env;
let server;
const tenants = [];

test.before(async () => {
  env = await dbReady();
  if (!env.ok) return;
  server = await startServer({ FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED: 'false', STARLANE_GLOBAL_STOP: '' });
});

test.after(async () => {
  if (server) await server.stop();
  if (env?.ok) {
    for (const t of tenants) {
      await env.pool.query('DELETE FROM file_import_batches WHERE user_id = $1', [t.id]).catch(() => {});
      await deleteTenant(env.pool, t.id).catch(() => {});
    }
    await env.pool.end();
  }
});

async function upload(user, path, csv, options, name = 'ledger.csv') {
  const form = new FormData();
  form.append('file', new Blob([csv], { type: 'text/csv' }), name);
  if (options) form.append('options', JSON.stringify(options));
  const r = await fetch(`${server.base}/api/decisions/import/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${tokenFor(user)}` }, body: form });
  return { status: r.status, body: await r.json() };
}

async function tenant(label) {
  const t = await createTenant(env.pool, label);
  tenants.push(t);
  return t;
}

test('pilot path: upload -> confirm -> first finding -> evidence; re-upload is a no-op; a newer export updates', async (t) => {
  if (!env.ok) return t.skip(`no database: ${env.reason}`);
  const a = await tenant('import-a');
  const csv = slippingCustomerCsv(todayIso());

  const pre = await upload(a, 'preview', csv);
  assert.equal(pre.status, 200, JSON.stringify(pre.body));
  assert.deepEqual(pre.body.proposal.missingRequired, []);
  assert.equal((await env.pool.query('SELECT COUNT(*)::int n FROM invoices WHERE user_id = $1', [a.id])).rows[0].n, 0, 'preview writes nothing');

  const com = await upload(a, 'commit', csv, confirmedOptions());
  assert.equal(com.status, 200, JSON.stringify(com.body));
  const fl = com.body.firstLook;
  assert.equal(fl.needYou, 1, JSON.stringify(fl));
  assert.match(fl.top[0].title, /Sharma Traders \(Fixture\)/);
  assert.ok(fl.lines[0].startsWith(`I read ${com.body.profile.counts.invoices} invoices from 3 customers`));
  assert.equal(com.body.profile.counts.invoices, com.body.import.counts.inserted);

  // Every rupee in the decision traces to this tenant's own invoices.
  const c = client(server.base, a);
  const ev = await c.get(`/api/decisions/${fl.top[0].id}/evidence`);
  assert.equal(ev.status, 200);
  const ids = JSON.stringify(ev.body).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) || [];
  const own = await env.pool.query('SELECT id::text FROM invoices WHERE user_id = $1', [a.id]);
  const ownIds = new Set(own.rows.map((r) => r.id));
  const invoiceRefs = ids.filter((id) => ownIds.has(id));
  assert.ok(invoiceRefs.length >= 3, 'evidence cites the overdue invoices');

  const again = await upload(a, 'commit', csv, confirmedOptions());
  assert.equal(again.body.import.alreadyImported, true);
  const count1 = (await env.pool.query('SELECT COUNT(*)::int n FROM invoices WHERE user_id = $1', [a.id])).rows[0].n;

  // Next week's export: SH-301 has been paid. Same invoices, one update.
  const paidOn = new Date(Date.now() - 86400000).toISOString().slice(0, 10).split('-').reverse().join('/');
  const newer = csv.replace(/(Sharma Traders \(Fixture\),SH-301,[^,]+,[^,]+,"[^"]+"),Unpaid,/, `$1,Paid,${paidOn}`);
  assert.notEqual(newer, csv);
  const upd = await upload(a, 'commit', newer, confirmedOptions());
  assert.equal(upd.status, 200, JSON.stringify(upd.body));
  assert.equal(upd.body.import.counts.updated, 1);
  assert.equal(upd.body.import.counts.inserted, 0);
  const count2 = (await env.pool.query('SELECT COUNT(*)::int n FROM invoices WHERE user_id = $1', [a.id])).rows[0].n;
  assert.equal(count2, count1, 're-import never duplicates invoices');
});

test('red team: healthy data produces no decision and says so', async (t) => {
  if (!env.ok) return t.skip(`no database: ${env.reason}`);
  const h = await tenant('import-healthy');
  const com = await upload(h, 'commit', healthyCsv(todayIso()), confirmedOptions());
  assert.equal(com.status, 200, JSON.stringify(com.body));
  assert.equal(com.body.firstLook.needYou, 0, JSON.stringify(com.body.firstLook));
  assert.ok(com.body.firstLook.lines.some((l) => /No material decision currently requires attention/.test(l)), JSON.stringify(com.body.firstLook.lines));
  const open = await env.pool.query(`SELECT COUNT(*)::int n FROM decisions WHERE user_id = $1 AND status IN ('OPEN','NEEDS_INFORMATION')`, [h.id]);
  assert.equal(open.rows[0].n, 0);
});

test('red team: without due dates Starlane refuses to call anything overdue and names what is missing', async (t) => {
  if (!env.ok) return t.skip(`no database: ${env.reason}`);
  const m = await tenant('import-nodue');
  const com = await upload(m, 'commit', noDueDatesCsv(todayIso()), confirmedOptions({ dueDate: false }));
  assert.equal(com.status, 200, JSON.stringify(com.body));
  assert.equal(com.body.firstLook.needYou, 0);
  assert.equal(com.body.profile.counts.overdue, 0);
  const blocking = com.body.profile.limitations.find((l) => l.key === 'noDueDates');
  assert.ok(blocking && blocking.severity === 'blocking', JSON.stringify(com.body.profile.limitations));
  assert.equal(com.body.firstLook.insufficientInformation, true);
  assert.ok(com.body.firstLook.lines.some((l) => l.startsWith("I don't have enough information") && l.includes('due date')), JSON.stringify(com.body.firstLook.lines));
  assert.ok(!com.body.firstLook.lines.some((l) => l.includes('No material decision')), 'never claims all-clear without the data to support it');
});

test('feedback is recorded append-only; another tenant can neither see the data nor act on the decision', async (t) => {
  if (!env.ok) return t.skip(`no database: ${env.reason}`);
  const a = await tenant('fb-a');
  const b = await tenant('fb-b');
  const com = await upload(a, 'commit', slippingCustomerCsv(todayIso()), confirmedOptions());
  const id = com.body.firstLook.top[0].id;
  const ca = client(server.base, a);
  const cb = client(server.base, b);

  assert.equal((await ca.post(`/api/decisions/${id}/feedback`, { kind: 'NONSENSE' })).status, 400);
  assert.equal((await ca.post(`/api/decisions/${id}/feedback`, { kind: 'ALREADY_KNEW', note: 'Spoke to them yesterday' })).status, 201);
  assert.equal((await ca.post(`/api/decisions/${id}/feedback`, { kind: 'OPTION_IMPOSSIBLE', optionKey: 'not-an-option' })).status, 400);
  const fb = await ca.get(`/api/decisions/${id}/feedback`);
  assert.equal(fb.body.feedback[0].kind, 'ALREADY_KNEW');
  await assert.rejects(env.pool.query(`UPDATE decision_events SET payload = '{}' WHERE decision_id = $1 AND event_type = 'HUMAN_FEEDBACK'`, [id]), /append-only/);

  assert.equal((await cb.post(`/api/decisions/${id}/feedback`, { kind: 'WRONG' })).status, 404);
  assert.equal((await cb.get(`/api/decisions/${id}/feedback`)).status, 404);
  const pb = await cb.get('/api/decisions/data-profile');
  assert.equal(pb.status, 200);
  assert.equal(pb.body.counts.invoices, 0, 'tenant B sees none of tenant A\'s invoices');
  const pa = await ca.get('/api/decisions/data-profile');
  assert.ok(pa.body.counts.invoices > 0);
  assert.equal(pa.body.sources.ledger_import, pa.body.counts.invoices);
});
