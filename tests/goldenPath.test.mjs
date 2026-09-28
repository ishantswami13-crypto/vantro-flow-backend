// Golden path, end to end, against the real server and a real database:
//
//   CONNECT    pairing code (POST /api/connectors/tally/pairing)
//              -> device claim (POST /api/connectors/tally/claim, as the bridge does)
//   INGEST     vouchers parsed by the real Tally bridge (tally-sync.mjs --test
//              on sample-daybook.xml) -> POST /api/import/tally with the device credential
//   NORMALIZE  vouchers land as invoices / purchases / bank_transactions
//   STATE      GET /api/connectors shows Tally healthy, device seen; tenant-scoped
//   DETECT     POST /api/cortex/run-agents -> ai_actions with evidence (reason_json)
//   DECIDE     PATCH /api/ai-actions/:id approve (exactly once; 409 on repeat)
//   RECORD     audit_logs row for the decision
//
// Each stage prints its name so a failure says exactly where the chain broke.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, copyFileSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeChecker, openPool, seedUser, deleteUsers, startServer } from './helpers/httpHarness.mjs';

const require = createRequire(import.meta.url);
const { check, done } = makeChecker();
const PORT = 3922;

function bridgeVouchers(sample = 'sample-daybook.xml', opening = null) {
  // The real connector's parser, offline, on a bundled sample day book (and Bills Receivable export).
  const out = execFileSync(process.execPath, ['tally-connector/tally-sync.mjs', '--test', `--sample=${sample}`, ...(opening ? [`--opening=${opening}`] : [])], { encoding: 'utf8' });
  const start = out.indexOf('\n[');
  const end = out.lastIndexOf('\n]');
  return JSON.parse(out.slice(start + 1, end + 2));
}

async function main() {
  const pool = openPool();
  const users = [];
  let server;
  try {
    const owner = await seedUser(pool, 'golden'); users.push(owner.id);
    const other = await seedUser(pool, 'golden-other'); users.push(other.id);
    server = await startServer(PORT, { FEATURE_CORTEX_ENABLED: 'true', FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED: 'false' });
    const { base } = server;
    const auth = (u) => ({ Authorization: `Bearer ${u.token}`, 'Content-Type': 'application/json' });

    console.log('— CONNECT');
    const catalog = await (await fetch(`${base}/api/connectors/catalog`)).json();
    check('catalog is public and lists Tally as available', catalog.connectors?.some((c) => c.id === 'tally' && c.availability === 'available'));
    check('catalog never lists an OAuth connector as available',
      catalog.connectors?.filter((c) => c.authType === 'oauth').every((c) => c.availability === 'not_available'));

    const pairRes = await fetch(`${base}/api/connectors/tally/pairing`, { method: 'POST', headers: auth(owner) });
    const pair = (await pairRes.json()).pairing;
    check('pairing code issued (201)', pairRes.status === 201 && /^\S{8,}$/.test(pair?.code || ''), pairRes.status);
    const refused = await fetch(`${base}/api/connectors/quickbooks/pairing`, { method: 'POST', headers: auth(owner) });
    check('pairing refused for a connector that is not a local bridge (400)', refused.status === 400);

    const bridgeRes = await fetch(`${base}/api/connectors/tally/bridge`, { headers: auth(owner) });
    const bridgeSrc = await bridgeRes.text();
    check('signed-in owner can download the bridge (checksum header matches)',
      bridgeRes.status === 200 && createHash('sha256').update(bridgeSrc).digest('hex') === bridgeRes.headers.get('x-content-sha256'));
    check('bridge download requires sign-in (401)', (await fetch(`${base}/api/connectors/tally/bridge`)).status === 401);
    check('pairing command is the exact bridge invocation', pair.command === `node tally-sync.mjs --api ${base} --enroll ${pair.code}`, pair.command);

    // Run the command exactly as shown to the owner, from a fresh folder
    // holding only the downloaded bridge file (no config.json).
    const bridgeDir = mkdtempSync(join(tmpdir(), 'starlane-bridge-'));
    copyFileSync('tally-connector/tally-sync.mjs', join(bridgeDir, 'tally-sync.mjs'));
    const args = pair.command.split(' ').slice(2);
    let enrollOut = '';
    try { enrollOut = execFileSync(process.execPath, ['tally-sync.mjs', ...args, '--dry-run'], { cwd: bridgeDir, encoding: 'utf8', env: { ...process.env, COMPUTERNAME: 'Golden path test PC' } }); }
    catch (e) { enrollOut = String(e.stdout || '') + String(e.stderr || ''); }
    let cred = null;
    try { cred = JSON.parse(readFileSync(join(bridgeDir, '.vantro-device-credentials.json'), 'utf8')); } catch { /* not written */ }
    check('bridge paired with the shown command (credential stored)', !!cred?.deviceSecret, enrollOut.slice(-400));
    check('credential file is owner-only (0600)', cred && (statSync(join(bridgeDir, '.vantro-device-credentials.json')).mode & 0o777) === 0o600);
    check('bridge remembered the API base (no config.json needed later)', cred?.apiBase === base);
    rmSync(bridgeDir, { recursive: true, force: true });
    const reclaim = await fetch(`${base}/api/connectors/tally/claim`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enrollmentCode: pair.code }),
    });
    check('a pairing code works only once (400 on reuse)', reclaim.status === 400);
    const device = `VantroDevice ${cred.deviceId}.${cred.deviceSecret}`;

    console.log('— INGEST');
    const vouchers = bridgeVouchers();
    check('bridge parsed the sample day book', vouchers.length === 5, vouchers.length);
    const imp = await fetch(`${base}/api/import/tally`, {
      method: 'POST', headers: { Authorization: device, 'Content-Type': 'application/json' }, body: JSON.stringify({ vouchers }),
    });
    const impBody = await imp.json();
    check('import accepted with the device credential (200)', imp.status === 200, impBody);
    const again = await (await fetch(`${base}/api/import/tally`, {
      method: 'POST', headers: { Authorization: device, 'Content-Type': 'application/json' }, body: JSON.stringify({ vouchers }),
    })).json();
    const { rows: invRows } = await pool.query('SELECT customer_name, invoice_amount FROM invoices WHERE user_id = $1', [owner.id]);

    console.log('— NORMALIZE');
    check('sales vouchers became invoices', invRows.length === 2, invRows);
    check('re-importing the same vouchers creates nothing new (idempotent)',
      (await pool.query('SELECT COUNT(*)::int c FROM invoices WHERE user_id = $1', [owner.id])).rows[0].c === 2, again);
    check('amounts preserved exactly', invRows.map((r) => Number(r.invoice_amount)).sort((a, b) => a - b).join() === '45000,128500.5');

    console.log('— STATE');
    const mine = (await (await fetch(`${base}/api/connectors`, { headers: auth(owner) })).json()).connectors || [];
    const tally = mine.find((c) => c.id === 'tally');
    check('Tally reports healthy after a real sync', tally?.state?.health === 'healthy', tally?.state);
    check('paired device listed with last-seen time', tally?.state?.devices?.[0]?.lastSeenAt != null);
    const theirs = (await (await fetch(`${base}/api/connectors`, { headers: auth(other) })).json()).connectors || [];
    check('another tenant sees Tally not connected and no devices (isolation)',
      theirs.find((c) => c.id === 'tally')?.state?.health === 'not_connected' && theirs.find((c) => c.id === 'tally')?.state?.devices.length === 0);
    check('unconnected OAuth sources report unavailable, never connected', mine.filter((c) => c.authType === 'oauth').every((c) => c.state.health === 'unavailable'));

    console.log('— DETECT');
    // Make the imported receivables overdue so the collections agent has
    // something real to act on (the sample vouchers carry no due date).
    await pool.query(`UPDATE invoices SET due_date = CURRENT_DATE - 20, days_overdue = 20, customer_phone = '9800000000'
                       WHERE user_id = $1`, [owner.id]);
    const run = await fetch(`${base}/api/cortex/run-agents`, { method: 'POST', headers: auth(owner), body: JSON.stringify({ agents: ['collections'] }) });
    const runBody = await run.json();
    check('agents ran (200)', run.status === 200, runBody);
    const { rows: actions } = await pool.query(
      `SELECT id, action_type, status, reason_json, recommended_message FROM ai_actions WHERE user_id = $1 ORDER BY created_at`, [owner.id]);
    check('collections agent proposed actions for the overdue receivables', actions.length >= 1, runBody);
    check('every proposal carries its evidence (reason_json)', actions.length > 0 && actions.every((a) => a.reason_json && Object.keys(a.reason_json).length > 0), actions.map((a) => [a.action_type, a.reason_json]));
    const { rows: leaked } = await pool.query('SELECT COUNT(*)::int c FROM ai_actions WHERE user_id = $1', [other.id]);
    check('no actions created for the other tenant', leaked[0].c === 0);

    console.log('— DECIDE');
    const target = actions.find((a) => a.status === 'pending');
    if (target) {
      const cross = await fetch(`${base}/api/ai-actions/${target.id}`, { method: 'PATCH', headers: auth(other), body: JSON.stringify({ status: 'approved' }) });
      check('another tenant cannot decide this action (404)', cross.status === 404);
      const dec = await fetch(`${base}/api/ai-actions/${target.id}`, { method: 'PATCH', headers: auth(owner), body: JSON.stringify({ status: 'approved' }) });
      check('owner approves (200)', dec.status === 200);
      const dec2 = await fetch(`${base}/api/ai-actions/${target.id}`, { method: 'PATCH', headers: auth(owner), body: JSON.stringify({ status: 'approved' }) });
      check('approving twice is a 409, never a second decision', dec2.status === 409);

      console.log('— RECORD');
      const { rows: audit } = await pool.query('SELECT action FROM audit_logs WHERE entity_id = $1', [String(target.id)]);
      check('decision written to the audit log exactly once', audit.length === 1, audit);
    } else {
      check('a pending action exists to decide', false, actions.map((a) => a.status));
    }

    console.log('— BILL-WISE BOOKS (due dates, receipts and a credit note against named bills)');
    const billwise = bridgeVouchers('sample-daybook-billwise.xml');
    check('bridge parsed the bill-wise day book', billwise.length === 7, billwise.length);
    const bw = await (await fetch(`${base}/api/import/tally`, {
      method: 'POST', headers: { Authorization: device, 'Content-Type': 'application/json' }, body: JSON.stringify({ vouchers: billwise }),
    })).json();
    const bill = async (no) => (await pool.query(
      `SELECT invoice_amount, payment_amount, payment_status, payment_date, due_date::text AS due FROM invoices WHERE user_id = $1 AND invoice_number LIKE $2`,
      [owner.id, `TLY-SALES-${no}-%`])).rows;
    const [s201] = await bill('S201'); const [s202] = await bill('S202'); const [s203] = await bill('S203');
    check('due dates from Tally credit periods', s201?.due?.startsWith('2026-08-31') && s202?.due?.startsWith('2026-09-20') && s203?.due?.startsWith('2026-08-10'), [s201, s202, s203]);
    check('Agst Ref receipt settled S/203 (Paid on the receipt date)', s203?.payment_status === 'Paid' && Number(s203.payment_amount) === 15000 && String(s203.payment_date).startsWith('2026-09-12'), s203);
    check('part receipt and credit note leave the rest owed', s201?.payment_status === 'Pending' && Number(s201.payment_amount) === 50000
      && s202?.payment_status === 'Pending' && Number(s202.payment_amount) === 5000, [s201, s202]);
    check('credit note is not a receivable', (await pool.query(`SELECT COUNT(*)::int c FROM invoices WHERE user_id = $1 AND invoice_number LIKE 'TLY-CREDITNO%'`, [owner.id])).rows[0].c === 0);
    check('on-account receipt reported, not guessed', bw.unapplied?.on_account === 1 && bw.imported?.bills_settled === 1 && bw.imported?.bills_part_paid === 2, bw);
    await fetch(`${base}/api/import/tally`, { method: 'POST', headers: { Authorization: device, 'Content-Type': 'application/json' }, body: JSON.stringify({ vouchers: billwise }) });
    check('re-sync applies no receipt twice', Number((await bill('S201'))[0]?.payment_amount) === 50000);
    const scanned = await (await fetch(`${base}/api/client/scan/search?q=Mehta`, { headers: auth(owner) })).json();
    const mehta = scanned.customers?.find((c) => c.name === 'Mehta Hardware');
    check('Scan shows Mehta owing what is left (₹78,500)', mehta?.openTotal === 78500, scanned.customers);

    console.log('— OPENING BILLS (earlier years, still unpaid when the day book starts)');
    const withOpening = bridgeVouchers('sample-daybook-billwise.xml', 'sample-bills-receivable.xml');
    check('bridge sends 3 opening bills ahead of the day book (credit balance left out)',
      withOpening.slice(0, 3).every((v) => v.type === 'Opening Bill') && withOpening.filter((v) => v.type === 'Opening Bill').length === 3, withOpening.slice(0, 4));
    const ob = await (await fetch(`${base}/api/import/tally`, {
      method: 'POST', headers: { Authorization: device, 'Content-Type': 'application/json' }, body: JSON.stringify({ vouchers: withOpening }),
    })).json();
    check('opening bills imported once, the day book already there', ob.imported?.opening === 3 && ob.imported?.sales === 0, ob);
    const [o1450] = (await pool.query(`SELECT invoice_amount, due_date::text AS due FROM invoices WHERE user_id = $1 AND invoice_number LIKE 'TLY-OPENINGB-S1450-%'`, [owner.id])).rows;
    check('opening bill at the amount still owed, with its due date', Number(o1450?.invoice_amount) === 32000 && o1450?.due?.startsWith('2026-02-09'), o1450);
    const scanned2 = await (await fetch(`${base}/api/client/scan/search?q=Mehta`, { headers: auth(owner) })).json();
    check('Scan now shows Mehta owing last year\'s bill too (₹1,10,500)', scanned2.customers?.find((c) => c.name === 'Mehta Hardware')?.openTotal === 110500, scanned2.customers);
    const byBill = await (await fetch(`${base}/api/client/scan/search?q=${encodeURIComponent('S/201')}`, { headers: auth(owner) })).json();
    check('Scan finds "S/201" typed as Tally shows it, and shows the bill number (not the import reference)',
      byBill.invoices?.length === 1 && byBill.invoices[0].invoiceNumber === 'S201', byBill.invoices);
    const cust = await (await fetch(`${base}/api/client/scan/customer/${encodeURIComponent('mehta hardware')}`, { headers: auth(owner) })).json();
    check('customer Scan lists bills by number', cust.scan?.invoices?.some((i) => i.invoiceNumber === 'S1450') && !cust.scan.invoices.some((i) => /^TLY-/.test(i.invoiceNumber)), cust.scan?.invoices);
    console.log('— PHONE NUMBERS from Tally customer ledgers');
    const contactsOut = execFileSync(process.execPath, ['tally-connector/tally-sync.mjs', '--test', '--contacts=sample-ledger-contacts.xml'], { encoding: 'utf8' });
    const contactsLine = contactsOut.split('\n').find((l) => l.includes('customer phone numbers that WOULD be sent')) || '';
    const contacts = JSON.parse(contactsLine.slice(contactsLine.indexOf('[')) || '[]');
    const phonesBefore = (await pool.query(`SELECT customer_name, customer_phone FROM invoices WHERE user_id = $1 AND customer_name IN ('Sharma Traders','Mehta Hardware')`, [owner.id])).rows;
    const withContacts = await (await fetch(`${base}/api/import/tally`, {
      method: 'POST', headers: { Authorization: device, 'Content-Type': 'application/json' }, body: JSON.stringify({ vouchers: [], contacts }),
    })).json();
    const phones = (await pool.query(`SELECT customer_name, customer_phone FROM invoices WHERE user_id = $1`, [owner.id])).rows;
    const phonesOf = (name) => [...new Set(phones.filter((r) => r.customer_name === name).map((r) => r.customer_phone))];
    check('an empty day book with contacts is a successful sync', withContacts.success === true && withContacts.contacts?.received === 4, withContacts);
    check('Mehta\'s bills get the mobile from the Tally ledger (normalised)', phonesOf('Mehta Hardware').join() === '9810000001', phonesBefore.concat(phonesOf('Mehta Hardware')));
    check('a number already on file is kept (Sharma)', phonesOf('Sharma Traders').join() === '9800000000', phonesOf('Sharma Traders'));
    check('a customer with no Tally number stays without one (Rao & Sons)', phonesOf('Rao & Sons').join() === '', phonesOf('Rao & Sons'));
    check('a landline is not used as a mobile', withContacts.contacts?.not_a_mobile === 1, withContacts.contacts);
    const badContacts = await fetch(`${base}/api/import/tally`, { method: 'POST', headers: { Authorization: device, 'Content-Type': 'application/json' }, body: JSON.stringify({ vouchers: [], contacts: 'x' }) });
    check('contacts must be a list (400)', badContacts.status === 400);
    check('no receivable for the on-account credit balance', (await pool.query(`SELECT COUNT(*)::int c FROM invoices WHERE user_id = $1 AND customer_name = 'Kapoor & Co'`, [owner.id])).rows[0].c === 0);

    console.log('— CORRECTIONS made in Tally (edited, cancelled and optional vouchers)');
    const corrected = bridgeVouchers('sample-daybook-corrections.xml');
    check('bridge sends cancelled vouchers, never the optional one', corrected.filter((v) => v.cancelled).length === 3 && !corrected.some((v) => v.voucherNo === 'S/204'), corrected.map((v) => v.voucherNo));
    const cr = await (await fetch(`${base}/api/import/tally`, {
      method: 'POST', headers: { Authorization: device, 'Content-Type': 'application/json' }, body: JSON.stringify({ vouchers: corrected }),
    })).json();
    const [c201] = await bill('S201'); const [c202] = await bill('S202'); const [c203] = await bill('S203');
    check('edited sale and receipt follow Tally (₹1,30,000 bill, ₹60,000 paid)', Number(c201?.invoice_amount) === 130000 && Number(c201?.payment_amount) === 60000 && c201?.payment_status === 'Pending', c201);
    check('cancelled sale is Cancelled and its cancelled credit note taken back', c202?.payment_status === 'Cancelled' && Number(c202?.payment_amount) === 0, c202);
    check('cancelled receipt re-opens the bill it had settled', c203?.payment_status === 'Pending' && Number(c203?.payment_amount) === 0, c203);
    check('corrections reported', cr.corrections?.cancelled === 2 && cr.corrections?.settlements_changed === 3, cr.corrections);
    const mehta3 = (await (await fetch(`${base}/api/client/scan/search?q=Mehta`, { headers: auth(owner) })).json()).customers?.find((c) => c.name === 'Mehta Hardware');
    check('Scan: Mehta owes ₹70,000 + last year\'s ₹32,000', mehta3?.openTotal === 102000, mehta3);
    const rao = (await (await fetch(`${base}/api/client/scan/search?q=Rao`, { headers: auth(owner) })).json()).customers?.find((c) => c.name === 'Rao & Sons');
    check('Scan: the cancelled bill is not owed (Rao owes only last year\'s ₹18,500)', rao?.openTotal === 18500 && rao?.openCount === 1, rao);
    const c202id = (await pool.query(`SELECT id FROM invoices WHERE user_id = $1 AND invoice_number LIKE 'TLY-SALES-S202-%'`, [owner.id])).rows[0].id;
    const c202scan = await (await fetch(`${base}/api/client/scan/invoice/${c202id}`, { headers: auth(owner) })).json();
    check('Scan of the cancelled bill says so', /^Cancelled in your books/.test(c202scan.scan?.headline || ''), c202scan.scan?.headline);
    const missions = require('../lib/features/missions.js');
    const prog = missions.progressOf({
      mission: { status: 'active', target: { amount: 40000 }, baseline: { at: '2026-09-01', outstanding: 40000, invoices: [{ id: c202id, customer: 'Rao & Sons', invoiceNumber: 'TLY-SALES-S202-20260805', amount: 40000 }] } },
      current: [], withdrawn: [String(c202id)], dataAsOf: new Date().toISOString(),
    });
    check('a mission never counts a cancelled bill as collected', prog.collected === 0 && prog.byInvoice[0].status === 'cancelled_in_books'
      && prog.blockers.some((b) => b.code === 'cancelled_in_books'), prog);
  } finally {
    if (server) server.stop();
    await pool.query('DELETE FROM connector_devices WHERE user_id = ANY($1)', [users]).catch(() => {});
    await deleteUsers(pool, users);
    await pool.end();
  }
}

main().then(done).catch((e) => { console.error('Test run crashed:', e); process.exitCode = 1; });
