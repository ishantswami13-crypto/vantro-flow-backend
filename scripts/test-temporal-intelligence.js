// STARLANE — Temporal Intelligence, Evidence Drift & Organizational Memory.
// Real-DB test suite covering the applicable subset of the mission's 30
// listed test cases. Creates its own fixtures against the real dev
// DATABASE_URL, cleans them up in a finally block, and verifies zero
// residual rows. Any test that legitimately cannot be exercised against
// real data (insufficient real history) uses a clearly-labeled CONSTRUCTED
// series instead — never a hardcoded/unfalsifiable assertion.
//
// Run: node scripts/test-temporal-intelligence.js

require('dotenv').config();
const { randomUUID } = require('crypto');
const { getPool } = require('../lib/db/pg');
const { detectEvidenceDrift } = require('../lib/domain/intelligence/evidenceDrift');
const { classifyTrajectoryV2 } = require('../lib/domain/intelligence/trajectoryV2');
const { computeVelocity } = require('../lib/domain/intelligence/velocity');
const { detectApproachingThreshold } = require('../lib/domain/intelligence/approachingThreshold');
const { recordCheckpoint, getCheckpointAsOf, listCheckpoints, compareWindow } = require('../lib/domain/intelligence/checkpointHistory');
const { reportIssueCheckpoint, getIssueHistory, buildIssueKey } = require('../lib/domain/intelligence/issueLifecycle');
const { detectTemporalContradictions } = require('../lib/domain/intelligence/contradictionDetection');
const { reconstructCustomerScoreAsOf } = require('../lib/domain/intelligence/historicalReconstruction');
const { whatChangedSinceLastLook, whatChangedOverWindow } = require('../lib/domain/intelligence/whatChangedSinceLastLook');

let pass = 0, fail = 0;
function check(label, cond, extra) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra ? ' -- ' + extra : ''}`);
  cond ? pass++ : fail++;
}
function na(label, reason) {
  console.log(`N/A  ${label} -- ${reason}`);
}

const pool = getPool();
const createdUsers = [];
const createdCustomers = [];
const createdScoreHistory = [];
const createdCheckpointHistoryUsers = [];
const createdIssueUsers = [];
const createdInvoices = [];
const createdPaymentAllocations = [];

async function makeUser(label) {
  const id = randomUUID();
  await pool.query(`INSERT INTO users (id, email, business_name) VALUES ($1,$2,$3)`, [id, `ti-test-${id}@example.invalid`, label]);
  createdUsers.push(id);
  return id;
}

async function main() {
  try {
    // =================================================================
    // Test 1/2: Evidence drift under a stable categorical label
    // =================================================================
    const stableDrift = detectEvidenceDrift(
      { credit_risk_score: 40, concentration_pct: 20 },
      { credit_risk_score: 48, concentration_pct: 21 },
      { entityLabel: 'Customer X', categoricalBefore: 'AT_RISK', categoricalAfter: 'AT_RISK' }
    );
    check('Test 1: categorical state unchanged but evidence materially worsens -> drift surfaced',
      stableDrift.driftUnderStableLabel === true && stableDrift.driftItems.some(i => i.field === 'credit_risk_score'),
      JSON.stringify(stableDrift.driftItems));
    check('Test 2: small evidence drift (concentration_pct +1pt < 5pt threshold) -> suppressed as noise',
      stableDrift.suppressedItems.some(i => i.field === 'concentration_pct' && i.material === false),
      JSON.stringify(stableDrift.suppressedItems));

    // =================================================================
    // Test 3/4/5: Trajectory v2 point-count discipline
    // =================================================================
    const twoPoints = [{ value: 40, recorded_at: '2026-01-01' }, { value: 50, recorded_at: '2026-02-01' }];
    const twoTraj = classifyTrajectoryV2(twoPoints, { higherIsBetter: false });
    check('Test 3: two real points -> direction only, pointCount=2, no acceleration word', twoTraj.pointCount === 2 && !/ACCELERAT/.test(twoTraj.label), JSON.stringify(twoTraj));

    const threePoints = [...twoPoints, { value: 60, recorded_at: '2026-03-01' }];
    const threeTraj = classifyTrajectoryV2(threePoints, { higherIsBetter: false });
    check('Test 4: three real points -> basic trend, still no acceleration claim', threeTraj.pointCount === 3 && threeTraj.label === 'WORSENING', JSON.stringify(threeTraj));

    // CONSTRUCTED 4-point accelerating-deterioration series (real customer_score_history
    // is confirmed capped at 2-3 rows/customer on the live dev DB as of 2026-09-08,
    // so this mechanism is proven against a clearly-labeled constructed series,
    // exactly as Day 3's forecasting-core review permitted for its tournament).
    const constructedAccel = [
      { value: 30, recorded_at: '2026-01-01' },
      { value: 34, recorded_at: '2026-02-01' },
      { value: 44, recorded_at: '2026-03-01' },
      { value: 64, recorded_at: '2026-04-01' },
    ];
    const accelTraj = classifyTrajectoryV2(constructedAccel, { higherIsBetter: false });
    check('Test 5: acceleration only claimed with 4+ points AND genuinely increasing magnitude (CONSTRUCTED series)',
      accelTraj.label === 'ACCELERATING_DETERIORATION', JSON.stringify(accelTraj));

    // Insufficient-history matrix (Test 14)
    const zeroTraj = classifyTrajectoryV2([]);
    const oneTraj = classifyTrajectoryV2([{ value: 10, recorded_at: '2026-01-01' }]);
    check('Test 14: insufficient history is explicit for 0 and 1 points', zeroTraj.label === 'INSUFFICIENT_HISTORY' && oneTraj.label === 'INSUFFICIENT_HISTORY', JSON.stringify({ zeroTraj, oneTraj }));

    // =================================================================
    // Test: volatile / reversing labels (mechanism proof, constructed)
    // =================================================================
    const volatileSeries = [
      { value: 50, recorded_at: '2026-01-01' }, { value: 60, recorded_at: '2026-02-01' },
      { value: 45, recorded_at: '2026-03-01' }, { value: 58, recorded_at: '2026-04-01' },
      { value: 40, recorded_at: '2026-05-01' },
    ];
    const volTraj = classifyTrajectoryV2(volatileSeries, { higherIsBetter: false });
    check('Volatility mechanism: multiple sign reversals -> VOLATILE (CONSTRUCTED series)', volTraj.label === 'VOLATILE', JSON.stringify(volTraj));

    // =================================================================
    // Test 6: Approaching threshold before breach (velocity-based)
    // =================================================================
    const cashSeries = [
      { value: 100000, recorded_at: '2026-01-01T00:00:00Z' },
      { value: 80000, recorded_at: '2026-01-11T00:00:00Z' },
    ];
    const approach = detectApproachingThreshold(cashSeries, 20000, { breachDirection: 'below' });
    check('Test 6: approaching threshold surfaced before breach with a real velocity-based ETA', approach.status === 'APPROACHING_THRESHOLD' && approach.estimatedDaysToBreach > 0, JSON.stringify(approach));
    const alreadyBreached = detectApproachingThreshold([{ value: 100, recorded_at: '2026-01-01' }, { value: 5, recorded_at: '2026-01-05' }], 10, { breachDirection: 'below' });
    check('Approaching-threshold: value already past threshold -> ALREADY_BREACHED, not a fabricated future ETA', alreadyBreached.status === 'ALREADY_BREACHED', JSON.stringify(alreadyBreached));

    // =================================================================
    // Test 7/8: healthy stable tenant -> no fake deterioration; positive improvement surfaced honestly
    // =================================================================
    const noDrift = detectEvidenceDrift({ credit_risk_score: 40 }, { credit_risk_score: 41 }, { entityLabel: 'Healthy Customer', categoricalBefore: 'STABLE', categoricalAfter: 'STABLE' });
    check('Test 7: healthy/stable evidence (tiny 2.5% move) -> no fake deterioration surfaced', noDrift.driftDetected === false, JSON.stringify(noDrift));
    const improvement = classifyTrajectoryV2([{ value: 60, recorded_at: '2026-01-01' }, { value: 40, recorded_at: '2026-02-01' }], { higherIsBetter: false }); // credit risk score dropping = improving
    check('Test 8: positive improvement surfaced honestly (score dropping, higherIsBetter=false)', improvement.label === 'IMPROVING', JSON.stringify(improvement));

    // =================================================================
    // Test 9/10: Issue identity persists across checkpoints; resolved issue can recur
    // =================================================================
    const issueUser = await makeUser('TI issue-lifecycle tenant');
    createdIssueUsers.push(issueUser);
    const issueKey = buildIssueKey('PAYMENT_RISK', 'CUSTOMER', randomUUID());

    const detected = await reportIssueCheckpoint(issueUser, issueKey, { isPresent: true, detail: { note: 'first seen' } });
    check('Test 9a: first report of a new issue -> DETECTED', detected.status === 'DETECTED', JSON.stringify(detected));
    const worsened = await reportIssueCheckpoint(issueUser, issueKey, { isPresent: true, direction: 'WORSE', detail: { note: 'worse' } });
    check('Test 9b: same issue_key, still present, worse -> WORSENING (same identity, not re-created)', worsened.status === 'WORSENING' && worsened.id === detected.id, JSON.stringify(worsened));
    const resolved = await reportIssueCheckpoint(issueUser, issueKey, { isPresent: false });
    check('Test 9c: issue no longer present -> RESOLVED (same identity)', resolved.status === 'RESOLVED' && resolved.id === detected.id, JSON.stringify(resolved));

    const recurred = await reportIssueCheckpoint(issueUser, issueKey, { isPresent: true, detail: { note: 'back again' } });
    check('Test 10: resolved issue recurs -> RECURRED with recurrence_count incremented', recurred.status === 'RECURRED' && recurred.recurrence_count === 1, JSON.stringify(recurred));
    const history = await getIssueHistory(issueUser, issueKey);
    check('Issue history: stable id preserved across full DETECTED->WORSENING->RESOLVED->RECURRED lifecycle', history.id === detected.id, JSON.stringify(history));

    // =================================================================
    // Test 17: Temporal contradiction detected (real DB query, constructed rows)
    // =================================================================
    const contraUser = await makeUser('TI temporal-contradiction tenant');
    const contraCustomer = randomUUID();
    await pool.query(`INSERT INTO customers (id, user_id, name, created_at) VALUES ($1,$2,'TI Contra Customer', now())`, [contraCustomer, contraUser]);
    createdCustomers.push(contraCustomer);
    const contraInvoice = randomUUID();
    await pool.query(
      `INSERT INTO invoices (id, user_id, customer_id, customer_name, invoice_amount, payment_status, invoice_date)
       VALUES ($1,$2,$3,'TI Contra Customer',1000,'Pending', now())`,
      [contraInvoice, contraUser, contraCustomer]
    );
    createdInvoices.push(contraInvoice);
    // payment_allocations.created_at defaults to now() on insert, which is AFTER
    // the invoice's invoice_date (now()) only by a few ms — force a real
    // contradiction by backdating created_at explicitly.
    const allocRes = await pool.query(
      `INSERT INTO payment_allocations (user_id, invoice_id, payer_customer_id, amount, payment_date, allocation_status, payer_type, payer_reference, created_at)
       VALUES ($1,$2,$3,1000, now() - interval '10 days', 'CONFIRMED', 'SAME_AS_CUSTOMER', 'TI-TEST-REF', now() - interval '10 days') RETURNING id`,
      [contraUser, contraInvoice, contraCustomer]
    );
    createdPaymentAllocations.push(allocRes.rows[0].id);
    const contraResult = await detectTemporalContradictions(contraUser);
    check('Test 17: payment recorded before invoice creation is detected as a temporal contradiction',
      contraResult.contradictions.some(c => c.type === 'PAYMENT_ALLOCATED_BEFORE_INVOICE_CREATED'), JSON.stringify(contraResult));

    // =================================================================
    // Test 18: No-lookahead adversarial test — historical reconstruction
    // must not leak a future row into a past-point-in-time query.
    // =================================================================
    const leakUser = await makeUser('TI no-lookahead tenant');
    const leakCustomer = randomUUID();
    await pool.query(`INSERT INTO customers (id, user_id, name, created_at) VALUES ($1,$2,'TI Leak Customer', now())`, [leakCustomer, leakUser]);
    createdCustomers.push(leakCustomer);

    const pastRow = await pool.query(
      `INSERT INTO customer_score_history (user_id, customer_id, credit_risk_score, promise_reliability_score, recorded_at)
       VALUES ($1,$2,30,80, '2026-01-01T00:00:00Z') RETURNING id`,
      [leakUser, leakCustomer]
    );
    createdScoreHistory.push(pastRow.rows[0].id);
    // A row dated AFTER the reconstruction point, deliberately trying to leak in.
    const futureLeakRow = await pool.query(
      `INSERT INTO customer_score_history (user_id, customer_id, credit_risk_score, promise_reliability_score, recorded_at)
       VALUES ($1,$2,95,10, '2026-06-01T00:00:00Z') RETURNING id`,
      [leakUser, leakCustomer]
    );
    createdScoreHistory.push(futureLeakRow.rows[0].id);

    const reconstruction = await reconstructCustomerScoreAsOf(leakUser, leakCustomer, '2026-03-01T00:00:00Z');
    check('Test 18 (adversarial): reconstruction as of 2026-03-01 uses ONLY the pre-existing row (score=30), never the future leak row (score=95)',
      reconstruction.believedScore === 30 && reconstruction.sourceRowId === pastRow.rows[0].id, JSON.stringify(reconstruction));
    check('Test 18 (adversarial): future row is provably excluded, not merely "not the max"', reconstruction.believedScore !== 95);

    // =================================================================
    // Test 23: Checkpoint history preserved (multiple rows, not overwritten)
    // =================================================================
    const historyUser = await makeUser('TI checkpoint-history tenant');
    createdCheckpointHistoryUsers.push(historyUser);
    await recordCheckpoint(historyUser, { snapVal: 1 }, '2026-01-01T00:00:00Z');
    await recordCheckpoint(historyUser, { snapVal: 2 }, '2026-02-01T00:00:00Z');
    await recordCheckpoint(historyUser, { snapVal: 3 }, '2026-03-01T00:00:00Z');
    const allCheckpoints = await listCheckpoints(historyUser);
    check('Test 23: checkpoint history preserves ALL rows (append-only), not overwritten to 1', allCheckpoints.length === 3, `got ${allCheckpoints.length}`);

    const asOfFeb15 = await getCheckpointAsOf(historyUser, '2026-02-15T00:00:00Z');
    check('Checkpoint history: getCheckpointAsOf never returns a row after the requested instant', asOfFeb15.snapshot.snapVal === 2, JSON.stringify(asOfFeb15));

    // =================================================================
    // Test 24: Cross-tenant temporal isolation
    // =================================================================
    const tenantA = await makeUser('TI isolation tenant A');
    const tenantB = await makeUser('TI isolation tenant B');
    createdCheckpointHistoryUsers.push(tenantA, tenantB);
    await recordCheckpoint(tenantA, { owner: 'A' }, '2026-01-01T00:00:00Z');
    await recordCheckpoint(tenantB, { owner: 'B' }, '2026-01-01T00:00:00Z');
    const aCheckpoints = await listCheckpoints(tenantA);
    const bCheckpoints = await listCheckpoints(tenantB);
    check('Test 24: cross-tenant temporal isolation — tenant A never sees tenant B\'s checkpoint rows',
      aCheckpoints.every(c => c.snapshot.owner === 'A') && bCheckpoints.every(c => c.snapshot.owner === 'B') && aCheckpoints.length === 1 && bCheckpoints.length === 1,
      JSON.stringify({ aCheckpoints, bCheckpoints }));

    // =================================================================
    // Test 26/27: quietly-getting-worse / quietly-getting-better mechanism
    // (real customer_score_history is capped at 2-3 points/customer on the
    // live dev DB — proven here with a real DB round-trip using a
    // CONSTRUCTED 3+-point series, since 3 is the minimum this module
    // requires before using the word "quiet").
    // =================================================================
    const quietUser = await makeUser('TI quiet-trend tenant');
    const quietCustomer = randomUUID();
    await pool.query(`INSERT INTO customers (id, user_id, name, created_at) VALUES ($1,$2,'TI Quiet Customer', now())`, [quietCustomer, quietUser]);
    createdCustomers.push(quietCustomer);
    for (const [score, daysAgo] of [[30, 90], [36, 60], [42, 30]]) {
      const r = await pool.query(
        `INSERT INTO customer_score_history (user_id, customer_id, credit_risk_score, promise_reliability_score, recorded_at)
         VALUES ($1,$2,$3,80, now() - ($4 || ' days')::interval) RETURNING id`,
        [quietUser, quietCustomer, score, daysAgo]
      );
      createdScoreHistory.push(r.rows[0].id);
    }
    const { findQuietTrendRevelations } = require('../lib/domain/intelligence/revelationEngine');
    const quietRevelations = await findQuietTrendRevelations(quietUser);
    check('Test 26: quietly-getting-worse surfaces from 3 real worsening points before any hard threshold breach',
      quietRevelations.some(r => r.type === 'QUIETLY_GETTING_WORSE' && r.connectsTo.customerId === quietCustomer), JSON.stringify(quietRevelations));

    // Test 27: quietly-getting-better — reverse direction series
    const quietCustomerB = randomUUID();
    await pool.query(`INSERT INTO customers (id, user_id, name, created_at) VALUES ($1,$2,'TI Quiet Customer B', now())`, [quietCustomerB, quietUser]);
    createdCustomers.push(quietCustomerB);
    for (const [score, daysAgo] of [[60, 90], [50, 60], [40, 30]]) {
      const r = await pool.query(
        `INSERT INTO customer_score_history (user_id, customer_id, credit_risk_score, promise_reliability_score, recorded_at)
         VALUES ($1,$2,$3,80, now() - ($4 || ' days')::interval) RETURNING id`,
        [quietUser, quietCustomerB, score, daysAgo]
      );
      createdScoreHistory.push(r.rows[0].id);
    }
    const quietRevelations2 = await findQuietTrendRevelations(quietUser);
    check('Test 27: quietly-getting-better surfaces for the improving customer', quietRevelations2.some(r => r.type === 'QUIETLY_GETTING_BETTER' && r.connectsTo.customerId === quietCustomerB), JSON.stringify(quietRevelations2));

    // =================================================================
    // Velocity unit sanity (supports Test 6's mechanism)
    // =================================================================
    const vel = computeVelocity(cashSeries, { unitLabel: 'currency/day' });
    check('Velocity: explicit unit and correct sign for a declining series', vel.status === 'OK' && vel.rate < 0 && vel.unit === 'currency/day', JSON.stringify(vel));

    // =================================================================
    // What-Changed v2 (Part 21-22): window comparison, honest INSUFFICIENT_HISTORY
    // =================================================================
    const wcUser = await makeUser('TI what-changed-v2 tenant');
    createdCheckpointHistoryUsers.push(wcUser);
    createdUsers.includes(wcUser); // (kept in createdUsers already via makeUser)
    // Also needs cleanup from the ORIGINAL tenant_review_checkpoints table
    // since whatChangedOverWindow calls buildCurrentSnapshot -> no, it doesn't
    // touch the original table; only whatChangedSinceLastLook does. Call both
    // to exercise real integration.
    await whatChangedSinceLastLook(wcUser); // seeds original 027 table + history table (FIRST_REVIEW)
    const window7 = await whatChangedOverWindow(wcUser, 7);
    check('What-Changed v2: brand-new tenant has no 7-day-ago checkpoint -> honest INSUFFICIENT_HISTORY, not a fabricated comparison',
      window7.status === 'INSUFFICIENT_HISTORY', JSON.stringify(window7));
    createdCheckpointHistoryUsers.push(wcUser);

    // Test 21: short vs long baseline differ correctly — CONSTRUCTED via direct history rows
    const wcUser2 = await makeUser('TI what-changed-window tenant');
    createdCheckpointHistoryUsers.push(wcUser2);
    // Checkpoints placed at/before their respective window cutoffs, per
    // compareWindow's "closest to, but never after, now-days" discipline
    // (no-lookahead — see checkpointHistory.js). An 8-day-old checkpoint IS
    // at-or-before the 7-day cutoff; a 40-day-old one is at-or-before the
    // 30-day cutoff but the 8-day-old one is NOT (it's too recent for that
    // cutoff, so the 30-day window correctly reaches further back).
    await recordCheckpoint(wcUser2, { pulseOverall: 'STABLE', pulseComponents: {}, revelationIds: [] }, new Date(Date.now() - 40 * 86400000).toISOString());
    await recordCheckpoint(wcUser2, { pulseOverall: 'STABLE', pulseComponents: {}, revelationIds: [] }, new Date(Date.now() - 8 * 86400000).toISOString());
    await recordCheckpoint(wcUser2, { pulseOverall: 'WORSENING', pulseComponents: {}, revelationIds: [] }, new Date().toISOString()); // "now" checkpoint, so past-window comparisons have a real distinct current
    const cmp7 = await compareWindow(wcUser2, 7);
    const cmp30 = await compareWindow(wcUser2, 30);
    check('Test 21: 7-day window finds the closest at-or-before-cutoff checkpoint (~8 days old)', cmp7.status === 'OK' && Math.abs(cmp7.actualGapDays - 8) < 2, JSON.stringify(cmp7));
    check('Test 21: 30-day window correctly reaches back further to the 40-day-old checkpoint (differs from the 7-day result)', cmp30.status === 'OK' && Math.abs(cmp30.actualGapDays - 40) < 2, JSON.stringify(cmp30));

  } catch (midErr) {
    console.error('MID-TEST ERROR (fixtures will still be cleaned up):', midErr);
    fail++;
  } finally {
    for (const id of createdPaymentAllocations) await pool.query('DELETE FROM payment_allocations WHERE id=$1', [id]).catch(() => {});
    for (const id of createdInvoices) await pool.query('DELETE FROM invoices WHERE id=$1', [id]).catch(() => {});
    for (const id of createdScoreHistory) await pool.query('DELETE FROM customer_score_history WHERE id=$1', [id]).catch(() => {});
    for (const id of createdCustomers) await pool.query('DELETE FROM customers WHERE id=$1', [id]).catch(() => {});
    for (const id of createdIssueUsers) await pool.query('DELETE FROM tenant_issue_lifecycle WHERE user_id=$1', [id]).catch(() => {});
    const allCheckpointHistoryUsers = [...new Set(createdCheckpointHistoryUsers)];
    for (const id of allCheckpointHistoryUsers) await pool.query('DELETE FROM tenant_review_checkpoint_history WHERE user_id=$1', [id]).catch(() => {});
    for (const id of createdUsers) await pool.query('DELETE FROM tenant_review_checkpoints WHERE user_id=$1', [id]).catch(() => {});
    for (const id of createdUsers) await pool.query('DELETE FROM users WHERE id=$1', [id]).catch(() => {});

    const remaining = {};
    remaining.paymentAllocations = createdPaymentAllocations.length ? (await pool.query('SELECT count(*)::int n FROM payment_allocations WHERE id = ANY($1::uuid[])', [createdPaymentAllocations])).rows[0].n : 0;
    remaining.invoices = createdInvoices.length ? (await pool.query('SELECT count(*)::int n FROM invoices WHERE id = ANY($1::uuid[])', [createdInvoices])).rows[0].n : 0;
    remaining.scoreHistory = createdScoreHistory.length ? (await pool.query('SELECT count(*)::int n FROM customer_score_history WHERE id = ANY($1::uuid[])', [createdScoreHistory])).rows[0].n : 0;
    remaining.customers = createdCustomers.length ? (await pool.query('SELECT count(*)::int n FROM customers WHERE id = ANY($1::uuid[])', [createdCustomers])).rows[0].n : 0;
    remaining.issueLifecycle = createdIssueUsers.length ? (await pool.query('SELECT count(*)::int n FROM tenant_issue_lifecycle WHERE user_id = ANY($1::uuid[])', [createdIssueUsers])).rows[0].n : 0;
    remaining.checkpointHistory = allCheckpointHistoryUsers.length ? (await pool.query('SELECT count(*)::int n FROM tenant_review_checkpoint_history WHERE user_id = ANY($1::uuid[])', [allCheckpointHistoryUsers])).rows[0].n : 0;
    remaining.checkpoints = createdUsers.length ? (await pool.query('SELECT count(*)::int n FROM tenant_review_checkpoints WHERE user_id = ANY($1::uuid[])', [createdUsers])).rows[0].n : 0;
    remaining.users = createdUsers.length ? (await pool.query('SELECT count(*)::int n FROM users WHERE id = ANY($1::uuid[])', [createdUsers])).rows[0].n : 0;
    const allZero = Object.values(remaining).every(n => n === 0);
    check('Fixture cleanup: zero residual rows across all tables touched', allZero, JSON.stringify(remaining));

    na('Test 12 (seasonality)', 'explicitly out of scope per mission — 16 sales rows cannot honestly support seasonality detection');
    na('Test 13 (structural change-point detection)', 'explicitly out of scope per mission — same insufficient-history reason');
    na('Test 28-style (model-performance-drift tracking)', 'no resolved-prediction history exists yet — deferred');
    na('Test 33-style (peer/cross-tenant baselines)', 'explicitly out of scope per mission — no privacy architecture built for it');

    console.log(`\n${pass} passed, ${fail} failed`);
    await pool.end();
    process.exit(fail > 0 ? 1 : 0);
  }
}

main();
