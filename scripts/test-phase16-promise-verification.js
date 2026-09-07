// Phase D ("Verified Execution Loop V1 — Receivables") verification.
// Covers:
//   1) classifyPromiseFulfillment() pure-function scenarios (kept/broken/active/partial-safe).
//   2) verifyPromiseOutcomes() end-to-end against the real local DB (Neon via
//      DATABASE_URL, through the pg-backed supabase shim) — seeds synthetic
//      tenant/customer/invoice/promise rows and asserts the DB write.
//   3) classifyReceivablesVerification() channel='test' vs channel='whatsapp'
//      exclusion proof.
//   4) The new POST /api/customers/:customerId/promises endpoint, hit over
//      real HTTP against a locally-spawned server instance — auth/tenant
//      isolation/input validation.
// Cleans up every synthetic row it creates in a finally block.
//
// Run: node scripts/test-phase16-promise-verification.js
require('dotenv').config();
const { randomUUID } = require('crypto');
const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');
const { supabase } = require('../lib/config/supabaseClient');
const evaluationAgent = require('../lib/services/agents/evaluationAgent');

let pass = 0, fail = 0;
function check(label, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}`);
  cond ? pass++ : fail++;
}

// ─── Section 1: pure classifyPromiseFulfillment() — no DB ──────────────────
function testClassifyPromiseFulfillmentPure() {
  const now = new Date('2026-09-07T00:00:00Z').toISOString();

  // 1. Past-due, invoice paid in full (covers promised amount) -> kept
  const kept = evaluationAgent.classifyPromiseFulfillment(
    { promised_amount: 5000, promised_date: '2026-08-01' },
    { payment_status: 'Paid', payment_amount: 5000, invoice_amount: 5000 },
    now
  );
  check('pure: past-due + fully-covered payment -> kept', kept.status === 'kept');

  // 2. Past-due beyond grace window, unpaid -> broken
  const broken = evaluationAgent.classifyPromiseFulfillment(
    { promised_amount: 5000, promised_date: '2026-08-01' }, // 37 days before "now"
    { payment_status: 'Pending', payment_amount: null, invoice_amount: 5000 },
    now
  );
  check('pure: past-due beyond grace, unpaid -> broken', broken.status === 'broken');

  // 3. Future promised_date, not yet due -> stays active (never prematurely judged)
  const active = evaluationAgent.classifyPromiseFulfillment(
    { promised_amount: 5000, promised_date: '2026-12-01' },
    { payment_status: 'Pending', payment_amount: null, invoice_amount: 5000 },
    now
  );
  check('pure: future promised_date -> active (not judged early)', active.status === 'active');

  // 3b. Past-due but still WITHIN the grace window -> stays active
  const withinGrace = evaluationAgent.classifyPromiseFulfillment(
    { promised_amount: 5000, promised_date: '2026-09-05' }, // 2 days ago, grace=3
    { payment_status: 'Pending', payment_amount: null, invoice_amount: 5000 },
    now
  );
  check('pure: past-due but within grace window -> stays active', withinGrace.status === 'active');

  // 4. Partial payment on the linked invoice — must NOT be treated as 'kept'.
  // A tiny partial payment must never fulfill a much larger promise.
  const tinyPartial = evaluationAgent.classifyPromiseFulfillment(
    { promised_amount: 5000, promised_date: '2026-08-01' },
    { payment_status: 'Paid', payment_amount: 500, invoice_amount: 5000 }, // Paid status but only 500 of 5000
    now
  );
  check('pure: tiny partial payment (500 of promised 5000) -> NOT kept', tinyPartial.status !== 'kept');
  check('pure: tiny partial payment past grace -> broken (amount insufficient)', tinyPartial.status === 'broken');

  // 4b. Partial payment that exactly covers the promised amount (even if less
  // than the full invoice) -> kept. Never overstate, but also never withhold
  // credit when the actual number covers what was promised.
  const partialCovers = evaluationAgent.classifyPromiseFulfillment(
    { promised_amount: 3000, promised_date: '2026-08-01' },
    { payment_status: 'Pending', payment_amount: 3000, invoice_amount: 10000 },
    now
  );
  check('pure: payment exactly covers (smaller) promised amount -> kept', partialCovers.status === 'kept');
}

// ─── Section 2: classifyReceivablesVerification() — channel exclusion ──────
function testClassifyReceivablesVerification() {
  const testOnly = evaluationAgent.classifyReceivablesVerification({
    executionRecords: [{ channel: 'test', status: 'sent' }],
    invoice: { payment_status: 'Pending', payment_amount: null, invoice_amount: 5000 },
    promise: null,
  });
  check('verification: channel=test alone -> messageSent is false', testOnly.messageSent === false);
  check('verification: channel=test alone -> testModeOnly is true', testOnly.testModeOnly === true);
  check('verification: channel=test alone -> state is NOT message_sent (excluded)', testOnly.state !== 'message_sent');
  check('verification: channel=test alone -> state is no_verified_outcome_yet', testOnly.state === 'no_verified_outcome_yet');

  const realSend = evaluationAgent.classifyReceivablesVerification({
    executionRecords: [{ channel: 'whatsapp', status: 'sent' }],
    invoice: { payment_status: 'Pending', payment_amount: null, invoice_amount: 5000 },
    promise: null,
  });
  check('verification: channel=whatsapp status=sent -> messageSent is true', realSend.messageSent === true);
  check('verification: channel=whatsapp -> state is message_sent', realSend.state === 'message_sent');

  const mixed = evaluationAgent.classifyReceivablesVerification({
    executionRecords: [{ channel: 'test', status: 'sent' }, { channel: 'whatsapp', status: 'sent' }],
    invoice: { payment_status: 'Pending', payment_amount: null, invoice_amount: 5000 },
    promise: null,
  });
  check('verification: mixed test+whatsapp rows -> messageSent true (real one counts)', mixed.messageSent === true);
  check('verification: mixed test+whatsapp rows -> testModeOnly false (a real send exists)', mixed.testModeOnly === false);

  // Never conflate "message sent" with "payment recovered".
  const full = evaluationAgent.classifyReceivablesVerification({
    executionRecords: [{ channel: 'whatsapp', status: 'sent' }],
    invoice: { payment_status: 'Paid', payment_amount: 5000, invoice_amount: 5000 },
    promise: null,
  });
  check('verification: full payment -> state is full_payment (not message_sent)', full.state === 'full_payment');
  check('verification: full payment -> realizedAmount equals actual payment_amount', full.realizedAmount === 5000);

  const partial = evaluationAgent.classifyReceivablesVerification({
    executionRecords: [{ channel: 'whatsapp', status: 'sent' }],
    invoice: { payment_status: 'Pending', payment_amount: 1200, invoice_amount: 5000 },
    promise: null,
  });
  check('verification: partial payment -> state is partial_payment', partial.state === 'partial_payment');
  check('verification: partial payment -> realizedAmount is the ACTUAL partial (1200, not rounded up/full)', partial.realizedAmount === 1200);

  const brokenPromiseState = evaluationAgent.classifyReceivablesVerification({
    executionRecords: [{ channel: 'whatsapp', status: 'sent' }],
    invoice: { payment_status: 'Pending', payment_amount: null, invoice_amount: 5000 },
    promise: { status: 'broken' },
  });
  check('verification: broken promise, no payment -> state is promise_broken', brokenPromiseState.state === 'promise_broken');
}

// ─── Section 3: verifyPromiseOutcomes() against the real local DB ──────────
async function seedTenant(userId) {
  await supabase.from('users').insert([{ id: userId, email: `phase16-${userId}@test.local`, password_hash: 'x', business_name: 'Phase16 Tenant' }]);
}
async function seedCustomer(userId, customerId) {
  await supabase.from('customers').insert([{ id: customerId, user_id: userId, name: 'Phase16 Customer', phone: '9990000001' }]);
}
async function seedInvoice(userId, invoiceId, { amount, paymentAmount, paymentStatus }) {
  await supabase.from('invoices').insert([{
    id: invoiceId, user_id: userId, customer_name: 'Phase16 Customer',
    invoice_amount: amount, payment_status: paymentStatus || 'Pending',
    payment_amount: paymentAmount ?? null,
  }]);
}
async function seedPromise(userId, customerId, invoiceId, { amount, date }) {
  const { data } = await supabase.from('promises').insert([{
    user_id: userId, customer_id: customerId, receivable_id: invoiceId,
    promised_amount: amount, promised_date: date, status: 'active',
  }]).select('*').single();
  return data;
}
async function cleanupTenant(userId) {
  await supabase.from('promises').delete().eq('user_id', userId);
  await supabase.from('invoices').delete().eq('user_id', userId);
  await supabase.from('customers').delete().eq('user_id', userId);
  await supabase.from('users').delete().eq('id', userId);
}

async function testVerifyPromiseOutcomesRealDb() {
  const userId = randomUUID();
  const customerId = randomUUID();
  const invKept = randomUUID();
  const invBroken = randomUUID();
  const invPartial = randomUUID();
  const invFuture = randomUUID();

  try {
    await seedTenant(userId);
    await seedCustomer(userId, customerId);

    const pastDue = new Date(Date.now() - 10 * 86400000).toISOString().split('T')[0]; // 10d ago, past grace (3d)
    const futureDue = new Date(Date.now() + 10 * 86400000).toISOString().split('T')[0];

    await seedInvoice(userId, invKept,    { amount: 5000,  paymentAmount: 5000,  paymentStatus: 'Paid' });
    await seedInvoice(userId, invBroken,  { amount: 5000,  paymentAmount: null,  paymentStatus: 'Pending' });
    await seedInvoice(userId, invPartial, { amount: 5000,  paymentAmount: 1000,  paymentStatus: 'Pending' });
    await seedInvoice(userId, invFuture,  { amount: 5000,  paymentAmount: null,  paymentStatus: 'Pending' });

    const pKept    = await seedPromise(userId, customerId, invKept,    { amount: 5000, date: pastDue });
    const pBroken  = await seedPromise(userId, customerId, invBroken,  { amount: 5000, date: pastDue });
    const pPartial = await seedPromise(userId, customerId, invPartial, { amount: 5000, date: pastDue }); // promised 5000, only 1000 paid -> broken, NOT kept
    const pFuture  = await seedPromise(userId, customerId, invFuture,  { amount: 5000, date: futureDue });

    const result = await evaluationAgent.verifyPromiseOutcomes(userId);
    check('real-db: verifyPromiseOutcomes checked all 4 active promises', result.checked === 4);
    check('real-db: exactly 1 marked kept', result.kept === 1);
    check('real-db: exactly 2 marked broken (broken + insufficient-partial)', result.broken === 2);

    const { data: rows } = await supabase.from('promises').select('id, status').eq('user_id', userId);
    const byId = Object.fromEntries(rows.map(r => [r.id, r.status]));
    check('real-db: fully-paid promise -> kept', byId[pKept.id] === 'kept');
    check('real-db: unpaid past-grace promise -> broken', byId[pBroken.id] === 'broken');
    check('real-db: insufficient-partial-paid promise -> broken (never falsely kept by a small unrelated payment)', byId[pPartial.id] === 'broken');
    check('real-db: not-yet-due promise -> still active', byId[pFuture.id] === 'active');
  } finally {
    await cleanupTenant(userId);
    const { data: leftoverPromises } = await supabase.from('promises').select('id').eq('user_id', userId);
    const { data: leftoverInvoices } = await supabase.from('invoices').select('id').eq('user_id', userId);
    const { data: leftoverUsers }    = await supabase.from('users').select('id').eq('id', userId);
    check('real-db cleanup: zero residual promises', (leftoverPromises || []).length === 0);
    check('real-db cleanup: zero residual invoices', (leftoverInvoices || []).length === 0);
    check('real-db cleanup: zero residual users', (leftoverUsers || []).length === 0);
  }
}

// ─── Section 4: POST /api/customers/:customerId/promises over real HTTP ───
const TEST_PORT = 31790;
const BASE = `http://localhost:${TEST_PORT}`;

function mintToken(userId, email) {
  return jwt.sign({ userId, email }, process.env.JWT_SECRET, { expiresIn: '1h' });
}
async function api(token, method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
function spawnServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['launch-local.cjs'], {
      cwd: __dirname + '/..',
      env: { ...process.env, PORT: String(TEST_PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; reject(new Error('server did not become ready in time')); } }, 20000);
    child.stdout.on('data', (d) => {
      if (!settled && /listening|running|started|port/i.test(String(d))) {
        settled = true; clearTimeout(timer);
        setTimeout(() => resolve(child), 400); // small settle margin
      }
    });
    child.on('error', reject);
    child.on('exit', (code) => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error('server exited early, code ' + code)); } });
  });
}

async function testPromiseEndpointHttp() {
  let child = null;
  const userA = randomUUID();
  const userB = randomUUID();
  const custA = randomUUID();
  const invA  = randomUUID();

  try {
    child = await spawnServer();

    await seedTenant(userA);
    await seedTenant(userB);
    await seedCustomer(userA, custA);
    await seedInvoice(userA, invA, { amount: 8000, paymentAmount: null, paymentStatus: 'Pending' });

    const tokenA = mintToken(userA, `phase16-${userA}@test.local`);
    const tokenB = mintToken(userB, `phase16-${userB}@test.local`);

    // No auth token at all.
    const rNoAuth = await api(null, 'POST', `/api/customers/${custA}/promises`, {
      receivable_id: invA, promised_amount: 1000, promised_date: '2026-12-01',
    });
    check('http: no token -> 401', rNoAuth.status === 401);

    // Owner creates a valid promise for their own customer/invoice.
    const rOk = await api(tokenA, 'POST', `/api/customers/${custA}/promises`, {
      receivable_id: invA, promised_amount: 2500, promised_date: '2026-12-01', notes: 'Phone call', source: 'phone',
    });
    check('http: owner creates valid promise -> 201', rOk.status === 201);
    check('http: created promise has status active', rOk.json?.promise?.status === 'active');
    check('http: created promise scoped to correct user_id', rOk.json?.promise?.user_id === userA);
    check('http: created promise carries promised_amount', Number(rOk.json?.promise?.promised_amount) === 2500);

    // Tenant B attempts to create a promise against tenant A's customer -> 404 (not found for B).
    const rCrossCustomer = await api(tokenB, 'POST', `/api/customers/${custA}/promises`, {
      promised_amount: 1000, promised_date: '2026-12-01',
    });
    check('http: cross-tenant customer access -> 404 (tenant isolation)', rCrossCustomer.status === 404);

    // Tenant A attempts to attach a promise to tenant B's (nonexistent-for-A) invoice.
    const rCrossInvoice = await api(tokenA, 'POST', `/api/customers/${custA}/promises`, {
      receivable_id: randomUUID(), promised_amount: 1000, promised_date: '2026-12-01',
    });
    check('http: unknown/foreign receivable_id -> 404', rCrossInvoice.status === 404);

    // Invalid input: negative amount.
    const rNegative = await api(tokenA, 'POST', `/api/customers/${custA}/promises`, {
      promised_amount: -500, promised_date: '2026-12-01',
    });
    check('http: negative promised_amount -> 400', rNegative.status === 400);

    // Invalid input: malformed date.
    const rBadDate = await api(tokenA, 'POST', `/api/customers/${custA}/promises`, {
      promised_amount: 500, promised_date: 'not-a-date',
    });
    check('http: malformed promised_date -> 400', rBadDate.status === 400);

    // Invalid input: missing amount.
    const rMissing = await api(tokenA, 'POST', `/api/customers/${custA}/promises`, {
      promised_date: '2026-12-01',
    });
    check('http: missing promised_amount -> 400', rMissing.status === 400);

  } finally {
    if (child) { try { child.kill(); } catch {} }
    await supabase.from('promises').delete().eq('user_id', userA);
    await cleanupTenant(userA);
    await cleanupTenant(userB);
  }
}

async function main() {
  testClassifyPromiseFulfillmentPure();
  testClassifyReceivablesVerification();
  await testVerifyPromiseOutcomesRealDb();
  await testPromiseEndpointHttp();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
