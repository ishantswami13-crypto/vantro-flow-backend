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

function bridgeVouchers() {
  // The real connector's parser, offline, on its bundled sample day book.
  const out = execFileSync(process.execPath, ['tally-connector/tally-sync.mjs', '--test'], { encoding: 'utf8' });
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
  } finally {
    if (server) server.stop();
    await pool.query('DELETE FROM connector_devices WHERE user_id = ANY($1)', [users]).catch(() => {});
    await deleteUsers(pool, users);
    await pool.end();
  }
}

main().then(done).catch((e) => { console.error('Test run crashed:', e); process.exitCode = 1; });
