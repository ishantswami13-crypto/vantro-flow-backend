// Offline proof for the Phase 8 Learning-loop repair in evaluationAgent.js.
// No real DB — supabaseClient.supabase is swapped for an in-process mock that
// mimics the exact chain shapes evaluationAgent.js calls (from/select/eq/in/
// gt/lt/is/order/limit/maybeSingle/update/upsert), keyed by `${table}:${op}`
// so each call site in the file gets its own queued canned response, in the
// order the code actually issues them. This proves the new symmetric
// `v:false` write branch fires on exactly the right condition and nothing else,
// without needing a live Neon/Supabase connection.
// Run: node lib/services/agents/evaluationAgent.test.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✅' : '❌'} ${label}: ${JSON.stringify(got)}${ok ? '' : ' (expected ' + JSON.stringify(want) + ')'}`);
  ok ? pass++ : fail++;
}

class QB {
  constructor(table, mock) { this.table = table; this.mock = mock; this.op = null; }
  _op(name) { if (!this.op) this.op = name; return this; }
  select() { return this._op('select'); }
  update() { return this._op('update'); }
  insert() { return this._op('insert'); }
  delete() { return this._op('delete'); }
  upsert(rows, opts) {
    this._op('upsert');
    this.mock.upsertCalls.push({ table: this.table, rows, opts });
    return Promise.resolve({ data: rows, error: null });
  }
  eq() { return this; }
  in() { return this; }
  gt() { return this; }
  lt() { return this; }
  is() { return this; }
  order() { return this; }
  limit() { return this; }
  ilike() { return this; }
  neq() { return this; }
  maybeSingle() { return Promise.resolve(this.mock.shift(this.table, this.op)); }
  single() { return Promise.resolve(this.mock.shift(this.table, this.op)); }
  then(resolve, reject) { return Promise.resolve(this.mock.shift(this.table, this.op)).then(resolve, reject); }
}

class SupabaseMock {
  constructor(queues) { this.queues = queues || {}; this.upsertCalls = []; }
  from(table) { return new QB(table, this); }
  shift(table, op) {
    const key = `${table}:${op}`;
    const arr = this.queues[key];
    if (!arr || !arr.length) return { data: null, error: null };
    return arr.shift();
  }
}

// Loads a fresh evaluationAgent.js with the given mock injected in place of
// the real supabase client. Both modules are evicted from require.cache each
// time so the destructured `const { supabase } = require(...)` inside
// evaluationAgent.js picks up this test's mock, not a stale one.
function loadWithMock(mock) {
  const clientPath = require.resolve('../../config/supabaseClient');
  const evalPath   = require.resolve('./evaluationAgent.js');
  delete require.cache[clientPath];
  delete require.cache[evalPath];
  const clientModule = require(clientPath);
  clientModule.supabase = mock;
  return require(evalPath);
}

const USER_A = 'user-aaaa';
const USER_B = 'user-bbbb';
const CUSTOMER_A = 'cust-aaaa';
const CUSTOMER_B = 'cust-bbbb';
const INVOICE_1  = 'inv-0001';
const ACTION_1   = 'act-0001';

function baseAction(overrides) {
  return {
    id: ACTION_1,
    action_type: 'SEND_POLITE_REMINDER',
    user_id: USER_A,
    related_entity_id: INVOICE_1,
    completed_at: new Date(Date.now() - 3 * 86400000).toISOString(),
    approved_at: null,
    created_at: new Date(Date.now() - 4 * 86400000).toISOString(),
    ...overrides,
  };
}

async function testPositiveUnchanged() {
  const mock = new SupabaseMock({
    'ai_actions:select': [{ data: [baseAction()], error: null }],
    'ai_actions:update': [{ data: null, error: null }],
    // evaluateAction()'s invoice fetch, then the memory branch's invoice fetch:
    'invoices:select': [
      { data: { payment_status: 'Paid', payment_date: new Date().toISOString() }, error: null },
      { data: { customer_name: 'Ramesh Traders' }, error: null },
    ],
    'customers:select': [{ data: { id: CUSTOMER_A }, error: null }],
  });
  const agent = loadWithMock(mock);
  const result = await agent.run(USER_A);

  check('positive: evaluated 1 action', result.evaluated, 1);
  check('positive: 1 memory row queued', mock.upsertCalls.length, 1);
  const row = mock.upsertCalls[0]?.rows?.[0];
  check('positive: memory_key is responds_to_polite_reminder', row?.memory_key, 'responds_to_polite_reminder');
  check('positive: memory_value.v is still true (regression, unchanged shape)', row?.memory_value?.v, true);
  check('positive: memory_value carries action_id', row?.memory_value?.action_id, ACTION_1);
  check('positive: row is scoped to the acting user_id', row?.user_id, USER_A);
  check('positive: row entity_id resolved to the matched customer', row?.entity_id, CUSTOMER_A);
}

async function testNegativeWritesFalse() {
  const mock = new SupabaseMock({
    'ai_actions:select': [{ data: [baseAction()], error: null }],
    'ai_actions:update': [{ data: null, error: null }],
    'invoices:select': [
      // Still unpaid past the window -> evaluateAction() falls through to 'ineffective'.
      { data: { payment_status: 'Pending', payment_date: null }, error: null },
      { data: { customer_name: 'Ramesh Traders' }, error: null },
    ],
    'customers:select': [{ data: { id: CUSTOMER_A }, error: null }],
  });
  const agent = loadWithMock(mock);
  const result = await agent.run(USER_A);

  check('negative: evaluated 1 action', result.evaluated, 1);
  check('negative: 1 memory row queued (this is the previously-dead branch)', mock.upsertCalls.length, 1);
  const row = mock.upsertCalls[0]?.rows?.[0];
  check('negative: memory_key matches the exact key collectionsAgent.js reads', row?.memory_key, 'responds_to_polite_reminder');
  check('negative: memory_value.v is false', row?.memory_value?.v, false);
  check('negative: memory_value shape matches positive case (action_id, learnedAt present)',
    typeof row?.memory_value?.action_id === 'string' && typeof row?.memory_value?.learnedAt === 'string', true);
}

async function testFirmToneNegative() {
  const mock = new SupabaseMock({
    'ai_actions:select': [{ data: [baseAction({ action_type: 'SEND_FIRM_REMINDER' })], error: null }],
    'ai_actions:update': [{ data: null, error: null }],
    'invoices:select': [
      { data: { payment_status: 'Pending', payment_date: null }, error: null },
      { data: { customer_name: 'Ramesh Traders' }, error: null },
    ],
    'customers:select': [{ data: { id: CUSTOMER_A }, error: null }],
  });
  const agent = loadWithMock(mock);
  await agent.run(USER_A);
  const row = mock.upsertCalls[0]?.rows?.[0];
  check('firm tone: ineffective firm reminder writes responds_to_firm_reminder v:false', row?.memory_key, 'responds_to_firm_reminder');
  check('firm tone: v is false', row?.memory_value?.v, false);
}

async function testNonReminderActionTypesNeverWriteMemory() {
  for (const [actionType, invoiceState] of [
    ['ESCALATE_COLLECTION', { payment_status: 'Pending', payment_date: null }],
    ['FLAG_BAD_DEBT',       { payment_status: 'Pending', payment_date: null }],
  ]) {
    const mock = new SupabaseMock({
      'ai_actions:select': [{ data: [baseAction({ action_type: actionType, id: 'act-x' })], error: null }],
      'ai_actions:update': [{ data: null, error: null }],
      'invoices:select':   [{ data: invoiceState, error: null }],
      'promises:select':   [{ data: null, error: null }],
    });
    const agent = loadWithMock(mock);
    await agent.run(USER_A);
    check(`non-reminder (${actionType}): no memory row queued for either polarity`, mock.upsertCalls.length, 0);
  }
}

async function testUnknownOutcomeNeverWritesMemory() {
  const mock = new SupabaseMock({
    'ai_actions:select': [{ data: [baseAction({ related_entity_id: null })], error: null }],
    'ai_actions:update': [{ data: null, error: null }],
  });
  const agent = loadWithMock(mock);
  const result = await agent.run(USER_A);
  check('unknown outcome (no invoice linked): still evaluated', result.evaluated, 1);
  check('unknown outcome: no memory row queued', mock.upsertCalls.length, 0);
}

async function testCustomerLookupMissMeansNoWrite() {
  const mock = new SupabaseMock({
    'ai_actions:select': [{ data: [baseAction()], error: null }],
    'ai_actions:update': [{ data: null, error: null }],
    'invoices:select': [
      { data: { payment_status: 'Pending', payment_date: null }, error: null },
      { data: { customer_name: 'Nobody Matches' }, error: null },
    ],
    'customers:select': [{ data: null, error: null }], // no customer found by name
  });
  const agent = loadWithMock(mock);
  await agent.run(USER_A);
  check('customer lookup miss: degrades to no memory write (existing fallback, unchanged)', mock.upsertCalls.length, 0);
}

async function testTenantIsolation() {
  // Tenant A gets an ineffective outcome; run separately for tenant B with its
  // own mock/customer — confirms the write is naturally scoped per-run/per-user
  // (the same .eq('user_id', userId) customer lookup already in place,
  // unmodified by this change) and one tenant's negative signal cannot land on
  // another tenant's business_memory row.
  const mockA = new SupabaseMock({
    'ai_actions:select': [{ data: [baseAction({ user_id: USER_A })], error: null }],
    'ai_actions:update': [{ data: null, error: null }],
    'invoices:select': [
      { data: { payment_status: 'Pending', payment_date: null }, error: null },
      { data: { customer_name: 'Shared Name Co' }, error: null },
    ],
    'customers:select': [{ data: { id: CUSTOMER_A }, error: null }],
  });
  const agentA = loadWithMock(mockA);
  await agentA.run(USER_A);

  const mockB = new SupabaseMock({
    'ai_actions:select': [{ data: [baseAction({ user_id: USER_B, id: 'act-b' })], error: null }],
    'ai_actions:update': [{ data: null, error: null }],
    'invoices:select': [
      { data: { payment_status: 'Paid', payment_date: new Date().toISOString() }, error: null },
      { data: { customer_name: 'Shared Name Co' }, error: null },
    ],
    'customers:select': [{ data: { id: CUSTOMER_B }, error: null }],
  });
  const agentB = loadWithMock(mockB);
  await agentB.run(USER_B);

  const rowA = mockA.upsertCalls[0]?.rows?.[0];
  const rowB = mockB.upsertCalls[0]?.rows?.[0];
  check('tenant isolation: tenant A row scoped to user A / customer A / v:false',
    rowA?.user_id === USER_A && rowA?.entity_id === CUSTOMER_A && rowA?.memory_value?.v === false, true);
  check('tenant isolation: tenant B row scoped to user B / customer B / v:true (independent outcome)',
    rowB?.user_id === USER_B && rowB?.entity_id === CUSTOMER_B && rowB?.memory_value?.v === true, true);
  check('tenant isolation: tenant A negative outcome never touched tenant B\'s row',
    mockB.upsertCalls.some(c => c.rows.some(r => r.entity_id === CUSTOMER_A)), false);
}

// ─── REVENUE_HEALTH_WATCH + outcome-to-memory gap fix (this phase) ─────────
// revenueIntelligence.service.js's computeCustomerPortfolioEntry/computePortfolio
// hit real tables (sales, customer_scores, customer_score_history, customers,
// event.service). Rather than re-mock that whole surface, these tests stub
// getRevenueIntelligenceForCustomer() directly on the required module — it's
// the exact wrapper evaluationAgent.js calls, so this proves evaluationAgent's
// own branching (still-flagged vs improved vs unresolvable) without duplicating
// revenueIntelligence's own test coverage (see revenueIntelligence.test.mjs).
function stubRevenueIntel(healthLabel) {
  const path = require.resolve('../orchestrator/revenueIntelligence.service');
  delete require.cache[path];
  const mod = require(path);
  mod.getRevenueIntelligenceForCustomer = async () =>
    healthLabel === null ? null : { health: { label: healthLabel, evidence: [] } };
  return () => { delete require.cache[path]; };
}

const CUSTOMER_RHW = 'cust-rhw1';
const ACTION_RHW   = 'act-rhw1';

function rhwAction(overrides) {
  return {
    id: ACTION_RHW,
    action_type: 'REVENUE_HEALTH_WATCH',
    user_id: USER_A,
    related_entity_id: CUSTOMER_RHW,
    completed_at: new Date(Date.now() - 15 * 86400000).toISOString(),
    approved_at: null,
    created_at: new Date(Date.now() - 16 * 86400000).toISOString(),
    ...overrides,
  };
}

async function testRevenueHealthWatchEffective() {
  const restore = stubRevenueIntel('HEALTHY');
  try {
    const mock = new SupabaseMock({
      'ai_actions:select': [{ data: [rhwAction()], error: null }],
      'ai_actions:update': [{ data: null, error: null }],
      'customers:select':  [{ data: { id: CUSTOMER_RHW, name: 'Acme Co' }, error: null }],
    });
    const agent = loadWithMock(mock);
    const result = await agent.run(USER_A);
    check('RHW effective: evaluated 1 action', result.evaluated, 1);
    check('RHW effective: 1 memory row queued', mock.upsertCalls.length, 1);
    const row = mock.upsertCalls[0]?.rows?.[0];
    check('RHW effective: memory_key is revenue_health_watch_outcome', row?.memory_key, 'revenue_health_watch_outcome');
    check('RHW effective: memory_value.v is true', row?.memory_value?.v, true);
    check('RHW effective: entity_type is customer', row?.entity_type, 'customer');
    check('RHW effective: entity_id is the flagged customer', row?.entity_id, CUSTOMER_RHW);
  } finally { restore(); }
}

async function testRevenueHealthWatchIneffective() {
  const restore = stubRevenueIntel('AT_RISK');
  try {
    const mock = new SupabaseMock({
      'ai_actions:select': [{ data: [rhwAction({ id: 'act-rhw2' })], error: null }],
      'ai_actions:update': [{ data: null, error: null }],
      'customers:select':  [{ data: { id: CUSTOMER_RHW, name: 'Acme Co' }, error: null }],
    });
    const agent = loadWithMock(mock);
    const result = await agent.run(USER_A);
    check('RHW ineffective: evaluated 1 action', result.evaluated, 1);
    check('RHW ineffective: 1 memory row queued', mock.upsertCalls.length, 1);
    const row = mock.upsertCalls[0]?.rows?.[0];
    check('RHW ineffective: memory_value.v is false', row?.memory_value?.v, false);
  } finally { restore(); }
}

async function testRevenueHealthWatchUnresolvableCustomer() {
  const restore = stubRevenueIntel('HEALTHY'); // should never be reached
  try {
    const mock = new SupabaseMock({
      'ai_actions:select': [{ data: [rhwAction({ id: 'act-rhw3' })], error: null }],
      'ai_actions:update': [{ data: null, error: null }],
      'customers:select':  [{ data: null, error: null }], // customer deleted / not found
    });
    const agent = loadWithMock(mock);
    const result = await agent.run(USER_A);
    check('RHW unresolvable: evaluated without crashing', result.evaluated, 1);
    check('RHW unresolvable: no memory row queued', mock.upsertCalls.length, 0);
  } finally { restore(); }
}

async function testCreditRiskAlertNowWritesMemory() {
  // Regression proof: before this phase, CREDIT_RISK_ALERT's computed outcome
  // was written to ai_actions.outcome (see the update() call) but the function
  // returned before ever pushing to memoryRows — the only push site was inside
  // the SEND_POLITE_REMINDER/SEND_FIRM_REMINDER branch above. This test proves
  // the new unconditional block now queues a row for CREDIT_RISK_ALERT too.
  const mock = new SupabaseMock({
    'ai_actions:select': [{ data: [{
      id: 'act-cra1', action_type: 'CREDIT_RISK_ALERT', user_id: USER_A,
      related_entity_id: CUSTOMER_A, completed_at: new Date(Date.now() - 15 * 86400000).toISOString(),
      approved_at: null, created_at: new Date(Date.now() - 16 * 86400000).toISOString(),
    }], error: null }],
    'ai_actions:update':       [{ data: null, error: null }],
    'customer_scores:select': [{ data: { credit_risk_score: '85' }, error: null }], // still HIGH_RISK
  });
  const agent = loadWithMock(mock);
  const result = await agent.run(USER_A);
  check('CREDIT_RISK_ALERT: evaluated 1 action', result.evaluated, 1);
  check('CREDIT_RISK_ALERT: memory row now written (regression fix)', mock.upsertCalls.length, 1);
  const row = mock.upsertCalls[0]?.rows?.[0];
  check('CREDIT_RISK_ALERT: memory_key is credit_risk_alert_outcome', row?.memory_key, 'credit_risk_alert_outcome');
  check('CREDIT_RISK_ALERT: memory_value.v is false (still high risk)', row?.memory_value?.v, false);
  check('CREDIT_RISK_ALERT: entity_id is the customer', row?.entity_id, CUSTOMER_A);
}

async function testCashflowGapAlertNowWritesMemory() {
  // Same regression proof for CASHFLOW_GAP_ALERT. This branch calls
  // getWeekForecast() (cashflow.service.js) directly rather than going through
  // supabase — we stub it the same way stubRevenueIntel() stubs the revenue
  // intelligence wrapper, on the required module the agent file itself requires.
  const cfPath = require.resolve('../orchestrator/cashflow.service');
  delete require.cache[cfPath];
  const cfMod = require(cfPath);
  const origForecast = cfMod.getWeekForecast;
  cfMod.getWeekForecast = async () => ({ expected_inflow: 100, expected_outflow: 500 }); // gap still open
  try {
    const mock = new SupabaseMock({
      'ai_actions:select': [{ data: [{
        id: 'act-cfg1', action_type: 'CASHFLOW_GAP_ALERT', user_id: USER_A,
        related_entity_id: null, completed_at: new Date(Date.now() - 8 * 86400000).toISOString(),
        approved_at: null, created_at: new Date(Date.now() - 9 * 86400000).toISOString(),
      }], error: null }],
      'ai_actions:update': [{ data: null, error: null }],
    });
    const agent = loadWithMock(mock);
    const result = await agent.run(USER_A);
    check('CASHFLOW_GAP_ALERT: evaluated 1 action', result.evaluated, 1);
    check('CASHFLOW_GAP_ALERT: memory row now written (regression fix)', mock.upsertCalls.length, 1);
    const row = mock.upsertCalls[0]?.rows?.[0];
    check('CASHFLOW_GAP_ALERT: memory_key is cashflow_alert_outcome', row?.memory_key, 'cashflow_alert_outcome');
    check('CASHFLOW_GAP_ALERT: entity_type is global (tenant-level, no customer)', row?.entity_type, 'global');
    check('CASHFLOW_GAP_ALERT: memory_value.v is false (gap still open)', row?.memory_value?.v, false);
  } finally {
    cfMod.getWeekForecast = origForecast;
    delete require.cache[cfPath];
  }
}

async function main() {
  await testPositiveUnchanged();
  await testNegativeWritesFalse();
  await testFirmToneNegative();
  await testNonReminderActionTypesNeverWriteMemory();
  await testUnknownOutcomeNeverWritesMemory();
  await testCustomerLookupMissMeansNoWrite();
  await testTenantIsolation();
  await testRevenueHealthWatchEffective();
  await testRevenueHealthWatchIneffective();
  await testRevenueHealthWatchUnresolvableCustomer();
  await testCreditRiskAlertNowWritesMemory();
  await testCashflowGapAlertNowWritesMemory();

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
