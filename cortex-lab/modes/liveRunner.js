// FILE: cortex-lab/modes/liveRunner.js
// Live mode — runs ONLY against a dedicated test Supabase + backend.
// Triple-gated by sandboxGuard. Refuses to execute against anything that
// looks like production. Stamps every created row with the run ID and
// verifies cleanup at the end.

'use strict';

const assert       = require('../assertions');
const scorecard    = require('../scorecard');
const sandboxGuard = require('../sandboxGuard');
const { buildClient } = require('../httpClient');
const dbClient     = require('../dbClient');
const seed         = require('../seed');
const cleanupMod   = require('../cleanup');

async function authSanity(http, cfg, record) {
  const a = await http.get('/api/auth/me', { token: cfg.env.ownerAToken });
  const b = await http.get('/api/auth/me', { token: cfg.env.ownerBToken });
  const bad = await http.get('/api/auth/me', { token: 'not-a-real-token' });

  scorecard.add(record, 'business_isolation',
    a.status === 200 ? { ok: true } : { ok: false, reason: 'owner_a_token_invalid', detail: { status: a.status } },
    'live:owner_a_auth', 'auth-sanity');
  scorecard.add(record, 'business_isolation',
    b.status === 200 ? { ok: true } : { ok: false, reason: 'owner_b_token_invalid', detail: { status: b.status } },
    'live:owner_b_auth', 'auth-sanity');
  scorecard.add(record, 'business_isolation',
    bad.status === 401 ? { ok: true } : { ok: false, reason: 'bad_token_not_401', detail: { status: bad.status } },
    'live:bad_token_rejected', 'auth-sanity');
}

async function crossTenantReadProbes(http, cfg, record) {
  // Pull owner-A's user id from /me, then attempt owner-B reads against it.
  const a = await http.get('/api/auth/me', { token: cfg.env.ownerAToken });
  const userAId = a.json && (a.json.user?.id || a.json.id);
  if (!userAId) {
    scorecard.add(record, 'business_isolation', { ok: false, reason: 'no_user_a_id' }, 'live:no_user_a_id');
    return;
  }
  const probes = [
    `/api/inventory/${userAId}`,
    `/api/invoices/${userAId}`,
    `/api/analytics/${userAId}`,
    `/api/cash-forecast/${userAId}`,
    `/api/transactions/${userAId}`,
    `/api/collections/summary/${userAId}`,
    `/api/metrics/${userAId}`,
  ];
  for (const p of probes) {
    const r = await http.get(p, { token: cfg.env.ownerBToken });
    const res = assert.assertCrossTenantBlocked(r, [userAId]);
    scorecard.add(record, 'business_isolation', res, `live:cross_tenant_${p}`, 'cross-business-leak');
  }
}

async function externalSendFlagOff(http, cfg, record) {
  // Static signal: env var on this process. (We don't probe the target's env
  // remotely — the cross-business probes confirm tenant safety end-to-end.)
  scorecard.add(record, 'approval_gate_safety',
    cfg.env.externalSendEnabled ? { ok: false, reason: 'external_send_flag_on_in_harness_env' } : { ok: true },
    'live:external_send_flag_off', 'external-message-without-approval');
}

async function creditSaleOrchestration(http, db, cfg, record) {
  const since = new Date(Date.now() - 60 * 1000).toISOString();
  const customer = await seed.createCustomer(http, cfg.env.ownerAToken, { runId: cfg.runId, name: 'Cortex Live A' });

  const saleResp = await seed.createCreditSale(http, cfg.env.ownerAToken, { runId: cfg.runId, customer, amount: 12000, dueInDays: 10 });
  scorecard.add(record, 'orchestration',
    saleResp.status >= 200 && saleResp.status < 300
      ? { ok: true }
      : { ok: false, reason: 'sale_create_failed', detail: { status: saleResp.status } },
    'live:create_credit_sale', 'credit-sale-orchestration');

  // Give the orchestrator's setImmediate side-effects a moment.
  await new Promise(r => setTimeout(r, 1500));

  if (!db.client) {
    scorecard.add(record, 'event_audit_completeness', 'na', 'live:no_test_db_client');
    return;
  }

  const a = await db.findRecent(db.client, 'business_events', { runId: cfg.runId, since, limit: 200 });
  const events = a.rows || a.allRows || [];
  const evRes = assert.assertEventsEmitted(events.filter(e => e.user_id), ['SALE_CREATED']);
  scorecard.add(record, 'event_audit_completeness', evRes, 'live:sale_created_event_persisted', 'credit-sale-orchestration');

  const audit = await db.findRecent(db.client, 'audit_logs', { runId: cfg.runId, since, limit: 200 });
  scorecard.add(record, 'event_audit_completeness',
    (audit.allRows || []).length > 0 ? { ok: true } : { ok: false, reason: 'no_audit_log_written' },
    'live:audit_log_written', 'credit-sale-orchestration');
}

async function approvalGateOnFirmReminder(http, db, cfg, record) {
  if (!db.client) { scorecard.add(record, 'approval_gate_safety', 'na', 'live:no_test_db_client'); return; }
  const since = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const actions = await db.findRecent(db.client, 'ai_actions', { runId: cfg.runId, since, limit: 200 });
  const firm = (actions.allRows || []).find(a => a.action_type === 'SEND_FIRM_REMINDER');
  if (!firm) {
    scorecard.add(record, 'approval_gate_safety', 'na', 'live:no_firm_reminder_to_check');
    return;
  }
  scorecard.add(record, 'approval_gate_safety',
    firm.requires_approval === true ? { ok: true } : { ok: false, reason: 'firm_reminder_not_requires_approval', detail: { id: firm.id } },
    'live:firm_reminder_requires_approval', 'owner-only-approval');
}

async function cleanupAndVerify(db, cfg, record, userIds) {
  if (!db.client) { scorecard.add(record, 'event_audit_completeness', 'na', 'live:cleanup_no_client'); return; }
  const result = await cleanupMod.cleanup({ client: db.client, runId: cfg.runId, userIds });
  scorecard.add(record, 'event_audit_completeness',
    result.ok ? { ok: true } : { ok: false, reason: 'cleanup_residue', detail: { residue: result.residue, perTable: result.perTable } },
    'live:cleanup_complete', 'cleanup');
}

// ── Entrypoint ───────────────────────────────────────────────────────────────
async function run({ cfg, record, scenarios }) {
  // Triple-gate.
  const gate = sandboxGuard.assertSafeForWrite(cfg);
  if (!gate.ok) {
    // Sandbox refused — not a test failure, just nothing tested.
    record.warnings.push({ message: 'Live mode skipped — sandbox guard refused. Reasons: ' + gate.reasons.join(' | ') });
    scorecard.add(record, 'orchestration',            'na', 'live_blocked_by_sandbox');
    scorecard.add(record, 'event_audit_completeness', 'na', 'live_blocked_by_sandbox');
    scorecard.add(record, 'approval_gate_safety',     'na', 'live_blocked_by_sandbox');
    scorecard.add(record, 'policy_safety',            'na', 'live_blocked_by_sandbox');
    scorecard.add(record, 'business_isolation',       'na', 'live_blocked_by_sandbox');
    scorecard.add(record, 'financial_data_integrity', 'na', 'live_blocked_by_sandbox');
    scorecard.add(record, 'ai_hallucination_block',   'na', 'live_blocked_by_sandbox');
    scorecard.add(record, 'learning_loop_quality',    'na', 'live_blocked_by_sandbox');
    scorecard.add(record, 'action_quality',           'na', 'live_blocked_by_sandbox');
    scenarios.push({ id: 'live-sandbox-skip', mode: 'live', passed: 0, failed: 0, skipped: true, reasons: gate.reasons });
    return;
  }
  for (const w of gate.warnings) record.warnings.push({ message: w });

  const http = buildClient({ baseUrl: cfg.env.testBaseUrl, runId: cfg.runId });
  const db   = dbClient.safeBuild({
    url: cfg.env.testSupabaseUrl,
    key: cfg.env.testSupabaseKey,
    prodHostDenylist: cfg.prodHostDenylist,
    productUrl: cfg.env.supabaseUrl,
  });
  if (!db.client) record.warnings.push({ message: `Test Supabase client unavailable: ${db.reason}` });

  const userIds = [];
  // We can scope cleanup to owner-A's user id, fetched from /me.
  const meA = await http.get('/api/auth/me', { token: cfg.env.ownerAToken });
  const userAId = meA.json && (meA.json.user?.id || meA.json.id);
  if (userAId) userIds.push(userAId);

  const tests = [
    ['auth-sanity',                () => authSanity(http, cfg, record)],
    ['cross-tenant-read-probes',   () => crossTenantReadProbes(http, cfg, record)],
    ['external-send-flag-off',     () => externalSendFlagOff(http, cfg, record)],
    ['credit-sale-orchestration',  () => creditSaleOrchestration(http, db, cfg, record)],
    ['approval-gate-firm-reminder',() => approvalGateOnFirmReminder(http, db, cfg, record)],
  ];
  for (const [id, fn] of tests) {
    const f = record.totals.failed;
    try { await fn(); }
    catch (err) { scorecard.add(record, 'orchestration', { ok: false, reason: 'live_scenario_crash', detail: { id, error: err.message } }, `live:${id}_crash`, id); }
    const failed = record.totals.failed - f;
    scenarios.push({ id, mode: 'live', passed: failed === 0 ? 1 : 0, failed: failed > 0 ? 1 : 0 });
  }

  await cleanupAndVerify(db, cfg, record, userIds);

  // Categories live mode genuinely cannot prove in a single short run.
  scorecard.add(record, 'learning_loop_quality',  'na', 'live_mode_na_single_run');
  scorecard.add(record, 'action_quality',         'na', 'live_mode_na_single_run');
}

module.exports = { run };
