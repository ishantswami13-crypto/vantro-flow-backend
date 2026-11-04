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

    // Failures close the run with their error code; a run that never reports
    // back is closed as timed out on read; the last-sync time and health
    // follow the latest run, not an older success.
    await pool.query(`UPDATE connector_sync_runs SET started_at = now() - interval '61 minutes', finished_at = now() - interval '60 minutes' WHERE user_id = $1 AND status = 'succeeded'`, [owner.id]);
    const run3 = (await (await fetch(`${base}/api/connectors/device/sync-runs`, { method: 'POST', headers: j(tokenAuth), body: '{}' })).json()).syncRun;
    await fetch(`${base}/api/connectors/device/sync-runs/${run3.id}`, { method: 'PATCH', headers: j(tokenAuth), body: JSON.stringify({ status: 'failed', code: 'tally_unreachable', error: 'TallyPrime is not answering on this computer.' }) });
    const r3 = (await pool.query('SELECT status, finished_at, error FROM connector_sync_runs WHERE id = $1', [run3.id])).rows[0];
    check('failed attempt closed with its error code', r3.status === 'failed' && !!r3.finished_at && r3.error === 'tally_unreachable: TallyPrime is not answering on this computer.', r3);
    st = await health();
    check('after a failure: error, not healthy; message without the code', st.health === 'error' && st.lastAttempt.errorCode === 'tally_unreachable' && st.lastError === 'TallyPrime is not answering on this computer.', st);
    check('last sync time is the last succeeded run (an hour ago)', Date.now() - Date.parse(st.lastSyncAt) > 59 * 60 * 1000, st.lastSyncAt);
    // Earlier attempts in this test move back so the stuck run is the latest.
    await pool.query(`UPDATE connector_sync_runs SET started_at = now() - interval '30 minutes' WHERE user_id = $1 AND started_at > now() - interval '25 minutes'`, [owner.id]);
    const stuck = (await pool.query(`INSERT INTO connector_sync_runs (user_id, connector_id, device_id, started_at) VALUES ($1, 'tally', $2, now() - interval '20 minutes') RETURNING id`, [owner.id, claim.deviceId])).rows[0].id;
    st = await health();
    const rs = (await pool.query('SELECT status, error FROM connector_sync_runs WHERE id = $1', [stuck])).rows[0];
    check('a run left running past the timeout is closed as failed on read', rs.status === 'failed' && /^sync_timed_out: /.test(rs.error || ''), rs);
    check('...and Sources reads it as an error, not healthy', st.health === 'error' && st.lastAttempt.errorCode === 'sync_timed_out', st.lastAttempt);
    const fresh = (await pool.query(`INSERT INTO connector_sync_runs (user_id, connector_id, device_id, started_at) VALUES ($1, 'tally', $2, now() - interval '20 minutes') RETURNING id`, [owner.id, claim.deviceId])).rows[0].id;
    const run4 = (await (await fetch(`${base}/api/connectors/device/sync-runs`, { method: 'POST', headers: j(tokenAuth), body: '{}' })).json()).syncRun;
    check('starting a sync closes stale running attempts first', (await pool.query('SELECT status FROM connector_sync_runs WHERE id = $1', [fresh])).rows[0].status === 'failed');
    await fetch(`${base}/api/import/tally`, { method: 'POST', headers: j({ ...tokenAuth, 'X-Sync-Run-Id': run4.id }), body: JSON.stringify({ vouchers: VOUCHERS }) });
    st = await health();
    check('after a new successful sync: healthy, last sync just now, no error', st.health === 'healthy' && Date.now() - Date.parse(st.lastSyncAt) < 60 * 1000 && st.lastError === null, st);

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
