// Integration test (real Neon dev DB) for the data_connections model
// (migrations/031_data_connections.sql, lib/domain/ingestion/connections.js).
//
// Verifies: create via heartbeat upsert, status update read-back,
// cross-tenant isolation, and clean fixture teardown (zero residual rows).
require('dotenv').config();
const { randomUUID } = require('crypto');
const { supabase } = require('../lib/config/supabaseClient');
const { getConnections, upsertConnectionStatus } = require('../lib/domain/ingestion/connections');

let pass = 0, fail = 0;
function check(label, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'} - ${label}`);
  cond ? pass++ : fail++;
}

async function main() {
  const userA = randomUUID();
  const userB = randomUUID();

  try {
    await supabase.from('users').insert([{ id: userA, email: `conn-test-a-${userA}@test.local`, password_hash: 'x', business_name: 'ConnTestA' }]);
    await supabase.from('users').insert([{ id: userB, email: `conn-test-b-${userB}@test.local`, password_hash: 'x', business_name: 'ConnTestB' }]);

    // 1. Create a connection record for tenant A via heartbeat (PENDING_PERMISSION -> CONNECTED)
    const created = await upsertConnectionStatus(userA, 'TALLY', 'PENDING_PERMISSION', {});
    check('tenant A: initial upsert creates a row', !!created && created.status === 'PENDING_PERMISSION');
    check('tenant A: initial upsert has no connected_at yet', !created.connected_at);

    // 2. Update status via heartbeat function -> CONNECTED, with last_sync_at
    const syncTime = new Date();
    const updated = await upsertConnectionStatus(userA, 'TALLY', 'CONNECTED', { lastSyncAt: syncTime, lastSyncError: null });
    check('tenant A: status transitions to CONNECTED', updated.status === 'CONNECTED');
    check('tenant A: connected_at is now set', !!updated.connected_at);
    check('tenant A: last_sync_at recorded', !!updated.last_sync_at);
    check('tenant A: same row reused (no duplicate)', updated.id === created.id);

    // 3. Simulate a failed poll -> ERROR with last_sync_error
    const errored = await upsertConnectionStatus(userA, 'TALLY', 'ERROR', { lastSyncAt: new Date(), lastSyncError: 'connector offline' });
    check('tenant A: status transitions to ERROR', errored.status === 'ERROR');
    check('tenant A: last_sync_error recorded', errored.last_sync_error === 'connector offline');
    check('tenant A: connected_at preserved across status changes', errored.connected_at != null);

    // 4. Read back via getConnections
    const connsA = await getConnections(userA);
    check('tenant A: getConnections reads back exactly 1 row', connsA.length === 1);
    check('tenant A: read-back row matches latest status', connsA[0].status === 'ERROR');

    // 5. Cross-tenant isolation: tenant B has no connections, and creating one
    //    for tenant B never appears under tenant A.
    const connsBBefore = await getConnections(userB);
    check('tenant B: starts with zero connections', connsBBefore.length === 0);

    await upsertConnectionStatus(userB, 'FILE_IMPORT', 'CONNECTED', { lastSyncAt: new Date() });
    const connsAAfter = await getConnections(userA);
    const connsBAfter = await getConnections(userB);
    check('tenant A: unaffected by tenant B write (still 1 row)', connsAAfter.length === 1);
    check('tenant B: sees its own new row', connsBAfter.length === 1 && connsBAfter[0].source_type === 'FILE_IMPORT');
    check('cross-tenant isolation: tenant A never sees tenant B rows', !connsAAfter.some(c => c.user_id === userB));
    check('cross-tenant isolation: tenant B never sees tenant A rows', !connsBAfter.some(c => c.user_id === userA));

    // 6. Validation guards
    let threw = false;
    try { await upsertConnectionStatus(userA, 'NOT_A_SOURCE', 'CONNECTED', {}); } catch (e) { threw = true; }
    check('rejects invalid sourceType', threw);

    threw = false;
    try { await upsertConnectionStatus(userA, 'TALLY', 'NOT_A_STATUS', {}); } catch (e) { threw = true; }
    check('rejects invalid status', threw);

  } finally {
    // Cleanup fixtures and verify zero residual rows.
    await supabase.from('data_connections').delete().eq('user_id', userA);
    await supabase.from('data_connections').delete().eq('user_id', userB);
    await supabase.from('users').delete().eq('id', userA);
    await supabase.from('users').delete().eq('id', userB);

    const residualA = await getConnections(userA);
    const residualB = await getConnections(userB);
    check('cleanup: zero residual connection rows for tenant A', residualA.length === 0);
    check('cleanup: zero residual connection rows for tenant B', residualB.length === 0);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
