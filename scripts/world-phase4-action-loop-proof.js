// FILE: scripts/world-phase4-action-loop-proof.js
// "Close the Loop" mission — proves the full SENSE -> UNDERSTAND -> DECIDE ->
// ACT -> VERIFY -> REMEMBER loop against the sanctioned 2xA demo tenant
// (owner@2xa-demo-meridian.invalid), reusing the EXISTING action/approval/
// execution infrastructure audited before this mission started
// (ai_actions, execution_records, purchase_orders, outcomeVerification.js,
// supplyChainOrchestrator.js, supplyChainExecutionAdapter.js) — no second
// action system was built.
//
// Requires a running backend (this script drives it over real HTTP, the
// same way a real client would, so this is a genuine end-to-end proof, not
// a unit test of internal functions). Requires JWT_SECRET in the backend's
// own env — this mints a token for the SANCTIONED demo fixture account
// using docs/2xa-demo.md's own documented local-dev-login snippet, not a
// forged credential for an arbitrary/real user.
//
// Mutates the demo tenant's ai_actions/execution_records/purchase_orders/
// predictions/action_outcomes rows for the ONE real signal this proof
// walks. Run `node scripts/seed-2xa-demo.js && node scripts/trigger-2xa-event.js`
// (or POST /api/demo/2xa/reset) afterward to restore a clean baseline
// before a live demo.
require('dotenv').config();
const jwt = require('jsonwebtoken');
const { getPool } = require('../lib/db/pg');

const BASE_URL = process.env.PROOF_BASE_URL || 'http://localhost:3001';
const DEMO_EMAIL = 'owner@2xa-demo-meridian.invalid';

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`PASS - ${name}` + (detail ? ` :: ${JSON.stringify(detail)}` : '')); }
  else { failed++; console.log(`FAIL - ${name}` + (detail ? ` :: ${JSON.stringify(detail)}` : '')); }
}

async function api(token, method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON error page */ }
  return { status: res.status, json };
}

async function main() {
  const pool = getPool();
  const userRes = await pool.query('SELECT id FROM users WHERE email = $1', [DEMO_EMAIL]);
  if (userRes.rows.length === 0) {
    console.log(`SKIP - demo tenant ${DEMO_EMAIL} not found. Run: node scripts/seed-2xa-demo.js && node scripts/trigger-2xa-event.js`);
    process.exit(0);
  }
  const userId = userRes.rows[0].id;
  const token = jwt.sign({ userId, email: DEMO_EMAIL }, process.env.JWT_SECRET, { expiresIn: '30m' });

  const otherUserRes = await pool.query('SELECT id FROM users WHERE email != $1 LIMIT 1', [DEMO_EMAIL]);
  const otherToken = otherUserRes.rows.length
    ? jwt.sign({ userId: otherUserRes.rows[0].id, email: 'other-tenant-proof' }, process.env.JWT_SECRET, { expiresIn: '30m' })
    : null;

  const sigRes = await pool.query(
    `SELECT id FROM business_signals WHERE user_id = $1 AND related_entity_type = 'supplier' ORDER BY first_detected_at DESC LIMIT 1`,
    [userId]
  );
  check('Setup: a real supplier-scoped business_signal exists for the demo tenant', sigRes.rows.length === 1);
  const signalId = sigRes.rows[0]?.id;
  if (!signalId) { console.log('Cannot continue without a real signal.'); process.exit(1); }

  // ── DECIDE: proposal generation, using real inputs, no arbitrary quantity ──
  const impactRes = await api(token, 'GET', `/api/intelligence/signals/${signalId}/impact`);
  check('Impact: sufficientDataForQuantification true from real schema data', impactRes.json?.impact?.sufficientDataForQuantification === true);

  const create1 = await api(token, 'POST', `/api/intelligence/signals/${signalId}/actions`);
  check('Proposal: creates at least one real ai_actions row', Array.isArray(create1.json?.actions) && create1.json.actions.length > 0);
  const action = create1.json.actions[0];
  check('Proposal: requires_approval is true (high-impact action never auto-executes)', action?.requires_approval === true);
  check('Proposal: status starts pending', action?.status === 'pending');
  check('Proposal: parameters carries a real, non-arbitrary quantity > 0', action?.parameters?.products?.[0]?.quantity > 0, { quantity: action?.parameters?.products?.[0]?.quantity });
  check('Proposal: expected_effect recorded before any execution', !!action?.expected_effect?.metric);

  // ── Idempotency: repeated signal recalculation must not create duplicates ──
  const create2 = await api(token, 'POST', `/api/intelligence/signals/${signalId}/actions`);
  check('Idempotency: second identical proposal call reuses the SAME action id, not a duplicate', create2.json?.actions?.[0]?.id === action.id);
  // Scoped to ACTIVE statuses deliberately: the dedup contract (migration
  // 045's partial unique index) only blocks a duplicate PENDING/APPROVED/
  // EXECUTING action — once a prior recommendation reaches a terminal state
  // (done/rejected/expired), a later real recalculation is correctly
  // allowed to propose a fresh one. A raw, unscoped count would wrongly
  // fail this check on a re-run of this very script against a
  // non-freshly-reset demo tenant, without indicating any real defect.
  const dbCount = await pool.query(
    `SELECT count(*)::int AS n FROM ai_actions WHERE related_entity_id = $1 AND action_type = 'supply_chain_intervention' AND status IN ('pending','approved','executing')`,
    [signalId]
  );
  check('Idempotency: at most one ACTIVE ai_actions row exists in the DB for this signal despite two proposal calls', dbCount.rows[0].n <= 1, { count: dbCount.rows[0].n });

  // ── Authorization: cross-tenant approval must be rejected ──────────────
  if (otherToken) {
    const crossTenant = await api(otherToken, 'POST', `/api/intelligence/actions/${action.id}/approve-and-execute`);
    check('Authorization: a different tenant cannot approve/execute this action (404, not leaked)', crossTenant.status === 404);
  }

  // ── ACT: approve + execute, with a genuine double-click race ───────────
  const [race1, race2] = await Promise.all([
    api(token, 'POST', `/api/intelligence/actions/${action.id}/approve-and-execute`),
    api(token, 'POST', `/api/intelligence/actions/${action.id}/approve-and-execute`),
  ]);
  const successes = [race1, race2].filter((r) => r.status === 200);
  const rejections = [race1, race2].filter((r) => r.status === 409);
  check('Double-click: exactly one of two concurrent approve-and-execute calls succeeds', successes.length === 1, { statuses: [race1.status, race2.status] });
  check('Double-click: the other is rejected with 409, not silently duplicated', rejections.length === 1);

  const poCountRes = await pool.query(`SELECT count(*)::int AS n FROM purchase_orders WHERE related_ai_action_id = $1`, [action.id]);
  check('Duplicate prevention: exactly one real purchase_orders row exists, not two', poCountRes.rows[0].n === 1, { count: poCountRes.rows[0].n });
  const execCountRes = await pool.query(`SELECT count(*)::int AS n FROM execution_records WHERE ai_action_id = $1`, [action.id]);
  check('Execution receipt: exactly one execution_records row exists', execCountRes.rows[0].n === 1, { count: execCountRes.rows[0].n });

  const successResult = successes[0].json.execution;
  check('Execution receipt: adapter reports liveExternalWriteOccurred=false for the sandboxed demo adapter (never claims a real ERP write)', successResult.liveExternalWriteOccurred === false);

  // ── Parameter integrity: executed payload matches the approved payload ──
  const poRes = await pool.query(`SELECT items FROM purchase_orders WHERE related_ai_action_id = $1`, [action.id]);
  const executedQty = poRes.rows[0]?.items?.products?.[0]?.quantity;
  check('Parameter integrity: executed quantity matches the exact approved payload quantity', String(executedQty) === String(action.parameters.products[0].quantity), { approved: action.parameters.products[0].quantity, executed: executedQty });

  const finalActionRes = await pool.query(`SELECT status FROM ai_actions WHERE id = $1`, [action.id]);
  check('Lifecycle: action reaches a real terminal state (done)', finalActionRes.rows[0].status === 'done');

  // ── VERIFY: expected vs observed, structured (not a single text string) ──
  const forecastRes = await api(token, 'POST', `/api/intelligence/signals/${signalId}/forecast`);
  check('Verification setup: forecast writes real prediction rows to verify against', Array.isArray(forecastRes.json?.predictions) && forecastRes.json.predictions.length > 0);

  await pool.query(
    `UPDATE predictions SET as_of = NOW() - INTERVAL '40 days' WHERE user_id = $1 AND target = 'stockout_within_horizon' AND evidence->>'signalId' = $2 AND superseded_by_id IS NULL`,
    [userId, signalId]
  );
  const verifyRes = await api(token, 'POST', `/api/intelligence/signals/${signalId}/verify-outcome`);
  check('Verification: signal outcome verification runs and resolves (test forced horizons to elapse — see comment)', verifyRes.json?.status === 'VERIFIED' || verifyRes.json?.status === 'NO_ACTION_TO_VERIFY');

  const outcomeRes = await pool.query(`SELECT * FROM action_outcomes WHERE action_id = $1`, [action.id]);
  check('Structured outcome: at least one action_outcomes row exists (not a flat text string)', outcomeRes.rows.length > 0);
  if (outcomeRes.rows.length > 0) {
    const o = outcomeRes.rows[0];
    check('Structured outcome: has separate expected_metric/expected_value fields', o.expected_metric != null && o.expected_value != null);
    check('Structured outcome: has separate observed_metric/observed_value fields', o.observed_metric != null && o.observed_value != null);
    check('Structured outcome: status is a real enum value, not a boolean', ['MET', 'NOT_MET', 'INCONCLUSIVE', 'PENDING'].includes(o.status));
  }

  // ── Adapter failure classification (unit-level, deterministic) ─────────
  const { executeSupplyChainAction } = require('../lib/domain/automation/supplyChainExecutionAdapter');
  let adapterThrew = false;
  try {
    await executeSupplyChainAction(userId, { id: 'ffffffff-ffff-ffff-ffff-ffffffffffff', reason_json: {}, supplier_id: 'not-a-uuid', parameters: null });
  } catch { adapterThrew = true; }
  check('Adapter failure: a malformed execution genuinely throws (never silently reports success)', adapterThrew);

  console.log(`\n=== PHASE 4 ACTION LOOP PROOF RESULT: ${failed === 0 ? 'PASS' : 'FAIL'} (${passed}/${passed + failed}) ===`);
  console.log('This proof mutated the demo tenant. Run scripts/seed-2xa-demo.js + scripts/trigger-2xa-event.js (or POST /api/demo/2xa/reset) to restore a clean baseline before a live demo.');
  await pool.end();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error('FATAL', err); process.exit(1); });
