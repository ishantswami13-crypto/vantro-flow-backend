// Device runtime for local connectors (desktop connector host + CLI bridge):
// token exchange, environment binding, sync runs, health states, disconnect,
// immediate revocation, malformed/duplicate payloads.
import { makeChecker, openPool, seedUser, deleteUsers, startServer } from './helpers/httpHarness.mjs';

const { check, done } = makeChecker();
const PORT = 3924;
const VOUCHERS = [
  { type: 'Sales', date: '2026-07-15', party: 'Sharma Traders', voucherNo: 'S/1042', amount: 45000, items: [] },
  { type: 'Sales', date: '2026-07-18', party: 'Gupta & Sons', voucherNo: 'S/1043', amount: 128500.5, items: [] },
];

async function main() {
  const pool = openPool();
  const users = [];
  let server;
  try {
    const owner = await seedUser(pool, 'dev-owner'); users.push(owner.id);
    const other = await seedUser(pool, 'dev-other'); users.push(other.id);
    server = await startServer(PORT, { STARLANE_ENV: 'staging' });
    const { base } = server;
    const j = (h = {}) => ({ 'Content-Type': 'application/json', ...h });
    const asOwner = j({ Authorization: `Bearer ${owner.token}` });
    const health = async (u = owner) => (await (await fetch(`${base}/api/connectors`, { headers: j({ Authorization: `Bearer ${u.token}` }) })).json()).connectors.find((c) => c.id === 'tally').state;

    check('fresh tenant: not_connected', (await health()).health === 'not_connected');
    const pairing = (await (await fetch(`${base}/api/connectors/tally/pairing`, { method: 'POST', headers: asOwner })).json()).pairing;
    check('open pairing code: pairing', (await health()).health === 'pairing');

    const claim = await (await fetch(`${base}/api/connectors/tally/claim`, { method: 'POST', headers: j(),
      body: JSON.stringify({ enrollmentCode: pairing.code, deviceName: 'OFFICE-PC', clientVersion: '0.1.0', platform: 'windows' }) })).json();
    check('claim returns the server environment', claim.env === 'staging');
    const secretAuth = { Authorization: `VantroDevice ${claim.deviceId}.${claim.deviceSecret}` };
    let st = await health();
    check('paired, no sync yet: connected (not healthy)', st.health === 'connected', st.health);
    check('device version and platform recorded', st.devices[0].version === '0.1.0' && st.devices[0].platform === 'windows');

    const tokRes = await fetch(`${base}/api/connectors/device/token`, { method: 'POST', headers: j(secretAuth), body: JSON.stringify({ clientVersion: '0.1.1' }) });
    const tok = await tokRes.json();
    check('secret exchanges for a short-lived token', tokRes.status === 200 && tok.env === 'staging' && Date.parse(tok.expiresAt) - Date.now() <= 15 * 60 * 1000 + 5000);
    const tokenAuth = { Authorization: `StarlaneDevice ${tok.accessToken}` };
    check('a token cannot be exchanged for another token', (await fetch(`${base}/api/connectors/device/token`, { method: 'POST', headers: j(tokenAuth) })).status === 400);

    const run1 = (await (await fetch(`${base}/api/connectors/device/sync-runs`, { method: 'POST', headers: j(tokenAuth), body: JSON.stringify({ clientVersion: '0.1.1' }) })).json()).syncRun;
    check('sync run started: syncing', (await health()).health === 'syncing');
    const fail = await fetch(`${base}/api/connectors/device/sync-runs/${run1.id}`, { method: 'PATCH', headers: j(tokenAuth), body: JSON.stringify({ status: 'failed', error: 'Tally XML server not reachable on localhost:9000' }) });
    st = await health();
    check('bridge offline reported: error with the reason', fail.status === 200 && st.health === 'error' && /not reachable/.test(st.lastError || ''), st);
    check('another tenant cannot touch this run', (await fetch(`${base}/api/connectors/device/sync-runs/${run1.id}`, { method: 'PATCH', headers: asOwner, body: JSON.stringify({ status: 'failed' }) })).status === 401);

    const malformed = await fetch(`${base}/api/import/tally`, { method: 'POST', headers: j(tokenAuth), body: JSON.stringify({ vouchers: 'nope' }) });
    check('malformed sync payload rejected (400)', malformed.status === 400);

    const run2 = (await (await fetch(`${base}/api/connectors/device/sync-runs`, { method: 'POST', headers: j(tokenAuth), body: '{}' })).json()).syncRun;
    const imp = await fetch(`${base}/api/import/tally`, { method: 'POST', headers: j({ ...tokenAuth, 'X-Sync-Run-Id': run2.id }), body: JSON.stringify({ vouchers: [...VOUCHERS, { type: 'Sales', party: '', amount: 'x' }] }) });
    const impBody = await imp.json();
    check('import with a token succeeds on the same run id', imp.status === 200 && impBody.syncRunId === run2.id, impBody);
    st = await health();
    check('healthy after success; last attempt shows transfer counts', st.health === 'healthy' && st.lastAttempt.recordsReceived === 3 && st.lastAttempt.recordsRejected === 1, st.lastAttempt);
    const dup = await (await fetch(`${base}/api/import/tally`, { method: 'POST', headers: j(tokenAuth), body: JSON.stringify({ vouchers: VOUCHERS }) })).json();
    const { rows: inv } = await pool.query('SELECT COUNT(*)::int n FROM invoices WHERE user_id = $1', [owner.id]);
    check('duplicate sync imports nothing new', inv[0].n === 2 && dup.syncRunId && dup.syncRunId !== run2.id);
    check('other tenant still not_connected (isolation)', (await health(other)).health === 'not_connected');

    const { rows: ev } = await pool.query(`SELECT event FROM product_events WHERE user_id = $1 OR device_id = $2`, [owner.id, claim.deviceId]);
    const names = new Set(ev.map((r) => r.event));
    check('events recorded: pairing, paired, token, sync started/failed/succeeded, rejected',
      ['connector.pairing_created', 'connector.device_paired', 'connector.device_token_issued', 'connector.sync_started', 'connector.sync_failed', 'connector.sync_succeeded', 'connector.records_rejected'].every((n) => names.has(n)), [...names]);
    const { rows: leak } = await pool.query(`SELECT COUNT(*)::int n FROM product_events WHERE props::text ILIKE '%Sharma%' OR props::text ILIKE '%${claim.deviceSecret.slice(0, 12)}%'`);
    check('events carry no customer names or secrets', leak[0].n === 0);

    // Environment binding: a production server rejects this staging device.
    const prod = await startServer(PORT + 1, { STARLANE_ENV: 'production' });
    const cross = await fetch(`${prod.base}/api/connectors/device/token`, { method: 'POST', headers: j(secretAuth) });
    check('staging-paired device refused by a production server (403)', cross.status === 403);
    const crossTok = await fetch(`${prod.base}/api/connectors/device/sync-runs`, { method: 'POST', headers: j(tokenAuth) });
    check('staging token refused by a production server (401)', crossTok.status === 401);
    prod.stop();

    const disc = await fetch(`${base}/api/connectors/device/disconnect`, { method: 'POST', headers: j(tokenAuth) });
    check('device disconnects itself', disc.status === 200);
    check('unexpired token is refused immediately after revocation', (await fetch(`${base}/api/connectors/device/sync-runs`, { method: 'POST', headers: j(tokenAuth) })).status === 401);
    check('revoked secret cannot get a token', (await fetch(`${base}/api/connectors/device/token`, { method: 'POST', headers: j(secretAuth) })).status === 401);
    check('health: revoked', (await health()).health === 'revoked');
    check('forged token refused', (await fetch(`${base}/api/connectors/device/sync-runs`, { method: 'POST', headers: j({ Authorization: 'StarlaneDevice aaa.bbb.ccc' }) })).status === 401);
  } finally {
    if (server) server.stop();
    await pool.query('DELETE FROM product_events WHERE user_id = ANY($1)', [users]).catch(() => {});
    await deleteUsers(pool, users);
    await pool.end();
  }
}

main().then(done).catch((e) => { console.error('Test run crashed:', e); process.exitCode = 1; });
