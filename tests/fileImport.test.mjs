// Spreadsheet import from other bookkeeping software: preview writes nothing,
// exports are recognised and mapped automatically, the same file is never
// imported twice, unmappable files are refused with reasons, and each
// company only ever sees its own imported invoices.
import { makeChecker, openPool, seedUser, deleteUsers, startServer } from './helpers/httpHarness.mjs';

const { check, done } = makeChecker();
const PORT = 3931;

const ZOHO = `Invoice Date,Invoice#,Customer Name,Status,Due Date,Total,Balance
10/08/2026,INV-0001,Mehta Hardware,Overdue,09/09/2026,"1,28,500.00","1,28,500.00"
15/09/2026,INV-0002,Kapoor & Co,Paid,15/10/2026,64000,0
,,Total,,,,"1,92,500.00"`;
const TALLY = `Gupta Traders Pvt Ltd
Bills Receivable

Date,Ref. No.,Party's Name,Pending Amount,Due on
12-Aug-2026,S/101,Sharma Traders,"25,000.00 Dr",11-Sep-2026`;

async function main() {
  const pool = openPool();
  const users = [];
  let server;
  try {
    const a = await seedUser(pool, 'import-a'); users.push(a.id);
    const b = await seedUser(pool, 'import-b'); users.push(b.id);
    server = await startServer(PORT);
    const up = (path, token, name, text) => {
      const fd = new FormData();
      fd.append('file', new Blob([text], { type: 'text/csv' }), name);
      return fetch(`${server.base}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
    };
    const count = async (id) => (await pool.query('SELECT COUNT(*)::int AS n FROM invoices WHERE user_id = $1', [id])).rows[0].n;

    console.log('— preview');
    const pv = await (await up('/api/import/preview', a.token, 'zoho.csv', ZOHO)).json();
    check('preview recognises a Zoho Books export', pv.source === 'Zoho Books', pv);
    check('preview maps customer and balance without help', pv.columns.customer_name === 'Customer Name' && pv.columns.balance === 'Balance');
    check('preview says why the totals row is skipped', pv.rows === 2 && pv.skippedReasons.some((s) => s.reason === 'a totals row'), pv);
    check('preview writes nothing', (await count(a.id)) === 0);

    console.log('— import');
    const im = await (await up('/api/import/excel', a.token, 'zoho.csv', ZOHO)).json();
    check('import adds the two invoices', im.imported === 2 && (await count(a.id)) === 2, im);
    const { rows } = await pool.query(`SELECT customer_name, invoice_amount::float AS amt, payment_status, due_date::text, invoice_number FROM invoices WHERE user_id = $1 ORDER BY invoice_number`, [a.id]);
    check('amount owed, status, due date and number stored', rows[0].amt === 128500 && rows[0].payment_status === 'Pending' && rows[0].due_date === '2026-09-09' && rows[0].invoice_number === 'INV-0001' && rows[1].payment_status === 'Paid', rows);
    const again = await (await up('/api/import/excel', a.token, 'zoho-copy.csv', ZOHO)).json();
    check('the same file is never imported twice', again.duplicate === true && (await count(a.id)) === 2, again);
    const { rows: batches } = await pool.query(`SELECT status, mapping_profile, rows_accepted FROM file_import_batches WHERE user_id = $1`, [a.id]);
    check('the import is recorded as a completed batch (feeds Sources health)', batches.length === 1 && batches[0].status === 'COMPLETED' && batches[0].mapping_profile === 'zoho_books' && batches[0].rows_accepted === 2, batches);

    const t = await (await up('/api/import/excel', a.token, 'tally.csv', TALLY)).json();
    check('a Tally report with title rows imports', t.imported === 1 && t.source === 'TallyPrime', t);

    console.log('— refusals and isolation');
    const bad = await up('/api/import/excel', a.token, 'items.csv', 'Item,Qty,Rate\nBolts,10,5');
    const badBody = await bad.json();
    check('a file without customer and amount is refused, with its headers shown', bad.status === 400 && Array.isArray(badBody.headers), badBody);
    const sameForB = await (await up('/api/import/excel', b.token, 'zoho.csv', ZOHO)).json();
    check('another company can import the same file for itself', sameForB.imported === 2 && (await count(b.id)) === 2);
    check('…without touching the first company', (await count(a.id)) === 3);
    const noAuth = await fetch(`${server.base}/api/import/preview`, { method: 'POST' });
    check('import requires sign-in', noAuth.status === 401);
  } finally {
    if (server) server.stop();
    await pool.query('DELETE FROM file_import_batches WHERE user_id = ANY($1)', [users]).catch(() => {});
    await deleteUsers(pool, users);
    await pool.end();
  }
}

main().then(done).catch((e) => { console.error('Test run crashed:', e); process.exitCode = 1; });
