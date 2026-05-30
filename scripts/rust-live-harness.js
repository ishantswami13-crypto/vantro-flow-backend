// FILE: scripts/rust-live-harness.js
// Vantro Harness X -- Rust live mode. Exercises the running /api/v2 service
// against a NON-PROD ephemeral database with two seeded tenants.
//
// Env (set by .github/workflows/rust-live-harness.yml):
//   RUST_BASE_URL   default http://localhost:3002
//   JWT_SECRET      same secret the Rust service was started with
//   OWNER_A_ID      ownerA user UUID (must match db/harness-seed.sql)
//   OWNER_B_ID      ownerB user UUID
//   OWNER_A_CUSTOMER ownerA customer UUID
//
// The service runs with NODE_ENV=production, so the x-user-id dev bypass is
// OFF -- every authenticated request uses a real HS256 JWT, exactly like prod.
//
// Exit code 0 = all hard assertions passed; non-zero = at least one failed.
// Latency is checked against the CTO charter budgets (acceptable = hard fail,
// target = warning only, since CI runners are slower/variable than prod).

'use strict';

const jwt = require('jsonwebtoken');

// 127.0.0.1 not localhost: the Axum service binds 0.0.0.0 (IPv4); Node fetch
// resolves localhost to ::1 (IPv6) first and would fail with "fetch failed".
const BASE = process.env.RUST_BASE_URL || 'http://127.0.0.1:3002';
const SECRET = process.env.JWT_SECRET || 'harness-test-secret';
const OWNER_A = process.env.OWNER_A_ID || '11111111-1111-1111-1111-111111111111';
const OWNER_B = process.env.OWNER_B_ID || '22222222-2222-2222-2222-222222222222';
const OWNER_A_CUSTOMER =
  process.env.OWNER_A_CUSTOMER || 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function tokenFor(userId) {
  // Mirrors the Node backend: HS256, claim { userId }.
  return jwt.sign({ userId }, SECRET, { algorithm: 'HS256' });
}

const TOKEN_A = tokenFor(OWNER_A);
const TOKEN_B = tokenFor(OWNER_B);

const results = [];
function record(name, ok, detail, ms, budget) {
  results.push({ name, ok, detail: detail || '', ms: ms == null ? '' : Math.round(ms), budget: budget || '' });
  const tag = ok ? 'PASS' : 'FAIL';
  const lat = ms == null ? '' : ` ${Math.round(ms)}ms`;
  console.log(`  [${tag}] ${name}${lat}${detail ? ' -- ' + detail : ''}`);
}

async function call(path, { method = 'GET', token, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers['authorization'] = `Bearer ${token}`;
  const t0 = Date.now();
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const ms = Date.now() - t0;
  let json = null;
  try { json = await res.json(); } catch (_) { /* non-json error body */ }
  return { status: res.status, json, ms };
}

// Budgets (ms): [target, acceptable]. Acceptable is the hard ceiling.
const BUDGET = {
  health: [50, 500],
  dashboard_uncached: [500, 1500],
  dashboard_cached: [50, 200],
  collections: [700, 1500],
  scoring: [100, 800],
  cpi: [100, 800],
  simulation: [150, 800],
  policy: [50, 500],
  cost: [50, 500],
};

function checkLatency(name, ms, key) {
  const [target, acceptable] = BUDGET[key];
  if (ms > acceptable) {
    record(`${name} latency`, false, `${Math.round(ms)}ms > acceptable ${acceptable}ms`, ms, `<=${acceptable}`);
    return false;
  }
  if (ms > target) {
    console.log(`  [WARN] ${name} latency ${Math.round(ms)}ms > target ${target}ms (within acceptable ${acceptable}ms)`);
  }
  return true;
}

async function main() {
  console.log(`Vantro Harness X -- Rust live mode against ${BASE}`);
  console.log(`ownerA=${OWNER_A} ownerB=${OWNER_B}`);

  // 1. Health
  {
    const r = await call('/health');
    record('GET /health -> 200', r.status === 200 && r.json && r.json.ok === true,
      `status=${r.status}`, r.ms, BUDGET.health[1]);
    checkLatency('health', r.ms, 'health');
  }

  // 2. dashboard bootstrap (ownerA) -> 200 (uncached, then cached)
  let aDash = null;
  {
    const r = await call('/api/v2/dashboard/bootstrap', { token: TOKEN_A });
    aDash = r.json;
    const ok = r.status === 200 && r.json && r.json.success === true && r.json.kpis;
    record('GET dashboard/bootstrap ownerA -> 200', ok, `status=${r.status} source=${r.json && r.json.source}`, r.ms);
    checkLatency('dashboard uncached', r.ms, 'dashboard_uncached');

    const r2 = await call('/api/v2/dashboard/bootstrap', { token: TOKEN_A });
    const cached = r2.status === 200 && r2.json && (r2.json.source === 'cache' || r2.ms <= BUDGET.dashboard_cached[1]);
    record('GET dashboard/bootstrap ownerA cached', cached, `source=${r2.json && r2.json.source}`, r2.ms);
    checkLatency('dashboard cached', r2.ms, 'dashboard_cached');
  }

  // 3. collections bootstrap (ownerA) -> 200
  {
    const r = await call('/api/v2/collections/bootstrap', { token: TOKEN_A });
    const ok = r.status === 200 && r.json && r.json.success === true && r.json.summary;
    record('GET collections/bootstrap ownerA -> 200', ok, `status=${r.status}`, r.ms);
    checkLatency('collections', r.ms, 'collections');
  }

  // 4. No auth -> 401
  {
    const r = await call('/api/v2/dashboard/bootstrap');
    record('GET dashboard/bootstrap no-auth -> 401', r.status === 401, `status=${r.status}`, r.ms);
  }
  {
    const r = await call('/api/v2/dashboard/bootstrap', { token: 'not.a.valid.jwt' });
    record('GET dashboard/bootstrap bad-token -> 401', r.status === 401, `status=${r.status}`, r.ms);
  }

  // 5. Cross-user isolation: ownerB sees DIFFERENT data; ownerB cannot read ownerA customer
  {
    const r = await call('/api/v2/dashboard/bootstrap', { token: TOKEN_B });
    const okStatus = r.status === 200 && r.json && r.json.success === true;
    // ownerB has 1 small pending invoice, no purchases/products/actions -> different KPIs than ownerA.
    let isolated = okStatus;
    if (okStatus && aDash && aDash.kpis && r.json.kpis) {
      isolated = JSON.stringify(r.json.kpis) !== JSON.stringify(aDash.kpis);
    }
    record('Cross-user: ownerB dashboard != ownerA', isolated,
      `B.kpis=${JSON.stringify(r.json && r.json.kpis)}`, r.ms);
  }
  {
    // ownerB requests a score for ownerA's customer -> must NOT return ownerA data.
    const r = await call('/api/v2/cortex/score-customer', {
      method: 'POST', token: TOKEN_B, body: { customer_id: OWNER_A_CUSTOMER },
    });
    // customer_metrics is scoped by user_id -> ownerB gets no row -> non-200 error, no leak.
    const noLeak = r.status !== 200;
    record('Cross-user: ownerB cannot score ownerA customer', noLeak, `status=${r.status}`, r.ms);
  }

  // 6. score-customer (ownerA, own customer) -> valid score + explanation
  {
    const r = await call('/api/v2/cortex/score-customer', {
      method: 'POST', token: TOKEN_A, body: { customer_id: OWNER_A_CUSTOMER },
    });
    const d = r.json && r.json.data;
    const ok = r.status === 200 && r.json && r.json.success === true && d &&
      typeof d.credit_risk_score === 'number' && Array.isArray(d.reasons);
    record('POST score-customer ownerA -> valid score', ok,
      `status=${r.status} score=${d && d.credit_risk_score}`, r.ms);
    checkLatency('scoring', r.ms, 'scoring');
  }

  // 7. calculate-cpi (ownerA) -> valid CPI + explanation
  {
    const r = await call('/api/v2/cortex/calculate-cpi', {
      method: 'POST', token: TOKEN_A,
      body: { customer_id: OWNER_A_CUSTOMER, business_cash_pressure: 0.8 },
    });
    const d = r.json && r.json.data;
    const ok = r.status === 200 && r.json && r.json.success === true && d &&
      typeof d.cpi_score === 'number' && Array.isArray(d.reasons) && d.reasons.length > 0;
    record('POST calculate-cpi ownerA -> valid CPI', ok,
      `status=${r.status} cpi=${d && d.cpi_score} priority=${d && d.priority}`, r.ms);
    checkLatency('cpi', r.ms, 'cpi');
  }

  // 8. simulate-credit-sale (high-risk) -> approval required
  {
    const r = await call('/api/v2/cortex/simulate-credit-sale', {
      method: 'POST', token: TOKEN_A,
      body: {
        customer_id: OWNER_A_CUSTOMER, new_sale_amount: 50000, current_outstanding: 72000,
        overdue_amount: 40000, broken_promises: 3, average_delay_days: 18, credit_limit: 100000,
      },
    });
    const sim = r.json && r.json.simulation;
    const ok = r.status === 200 && sim && sim.approval_required === true;
    record('POST simulate-credit-sale high-risk -> approval required', ok,
      `status=${r.status} risk=${sim && sim.risk_level} approval=${sim && sim.approval_required}`, r.ms);
    checkLatency('simulation', r.ms, 'simulation');
  }

  // 9. evaluate-policy blocks an unsafe action
  {
    const r = await call('/api/v2/cortex/evaluate-policy', {
      method: 'POST', token: TOKEN_A,
      body: { action_type: 'MARK_PAID', amount: 1000 },
    });
    const dec = r.json && r.json.decision;
    const ok = r.status === 200 && dec && dec.blocked === true;
    record('POST evaluate-policy MARK_PAID -> blocked', ok,
      `status=${r.status} blocked=${dec && dec.blocked}`, r.ms);
    checkLatency('policy', r.ms, 'policy');
  }
  {
    // Legal-threat message must also be blocked (FIR fix is word-boundary aware).
    const r = await call('/api/v2/cortex/evaluate-policy', {
      method: 'POST', token: TOKEN_A,
      body: { action_type: 'SEND_FIRM_REMINDER', recommended_message: 'We will file FIR against you.' },
    });
    const dec = r.json && r.json.decision;
    record('POST evaluate-policy legal-threat -> blocked', r.status === 200 && dec && dec.blocked === true,
      `blocked=${dec && dec.blocked}`, r.ms);
  }
  {
    // Benign "firm reminder" must NOT be blocked (regression guard, live).
    const r = await call('/api/v2/cortex/evaluate-policy', {
      method: 'POST', token: TOKEN_A,
      body: { action_type: 'SEND_FIRM_REMINDER', recommended_message: 'Please send a firm reminder today.' },
    });
    const dec = r.json && r.json.decision;
    record('POST evaluate-policy benign firm reminder -> NOT blocked', r.status === 200 && dec && dec.blocked === false,
      `blocked=${dec && dec.blocked}`, r.ms);
  }

  // 10. cost-route: simple scoring -> rules / no LLM
  {
    const r = await call('/api/v2/cortex/cost-route', {
      method: 'POST', token: TOKEN_A,
      body: { task_type: 'score_customer', input_tokens_estimate: 100, output_tokens_estimate: 50, accuracy_required: 'medium' },
    });
    const res = r.json && r.json.result;
    const ok = r.status === 200 && res && res.route_decision === 'rules_only' && res.estimated_cost_usd === 0;
    record('POST cost-route scoring -> rules_only/no-LLM', ok,
      `status=${r.status} route=${res && res.route_decision} cost=${res && res.estimated_cost_usd}`, r.ms);
    checkLatency('cost', r.ms, 'cost');
  }

  // -- Summary ----------------------------------------------------------------
  const failed = results.filter((r) => !r.ok);
  console.log('');
  console.log(`Harness X Rust live: ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log('FAILURES:');
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
    process.exit(1);
  }
  console.log('ALL RUST LIVE CHECKS PASSED');
  process.exit(0);
}

main().catch((err) => {
  console.error('Harness crashed:', err && err.stack ? err.stack : err);
  process.exit(2);
});
