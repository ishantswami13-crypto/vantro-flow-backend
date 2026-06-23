const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  buildCustomerOverdueSummary,
  getStagingReadSafetyStatus,
  methodNotAllowed,
  sanitizeDisplayName,
} = require('../lib/staging/customerOverdueSummary');

function assertNoUnsafeRenderedValues(payload) {
  const rendered = JSON.stringify(payload);
  assert(!rendered.includes('cust-a-private-token'), 'raw customer identifier must not render');
  assert(!rendered.includes('9988776655'), 'phone number must not render');
  assert(!rendered.includes('customer_scores'), 'customer score placeholders must not render');
  assert(!rendered.includes('phone'), 'phone field must not render');
}

function testSafeAggregationShape() {
  const customerNames = new Map([
    ['cust-a-private-token', 'North Star Retail'],
  ]);
  const invoices = [
    {
      customer_id: 'cust-a-private-token',
      customer_name: 'Unsafe fallback 9988776655',
      invoice_amount: 250000,
      payment_amount: 50000,
      payment_status: 'Pending',
      days_overdue: 42,
      customer_scores: { collection_priority_score: 100 },
    },
    {
      customer_id: 'cust-a-private-token',
      total_amount: 150000,
      amount_paid: 0,
      payment_status: 'Pending',
      days_overdue: 64,
    },
    {
      customer_name: 'Metro Steel House',
      invoice_amount: 80000,
      payment_status: 'Pending',
      days_overdue: 9,
    },
    {
      customer_name: 'Paid Customer',
      invoice_amount: 999999,
      payment_status: 'Paid',
      days_overdue: 100,
    },
    {
      customer_name: 'Not Overdue',
      invoice_amount: 123456,
      payment_status: 'Pending',
      days_overdue: 0,
    },
  ];

  const payload = buildCustomerOverdueSummary({
    invoices,
    customerNames,
    generatedAt: new Date('2026-06-23T17:30:00.000Z'),
  });

  assert.strictEqual(payload.success, true);
  assert.strictEqual(payload.summary.totalOverdueAmount, 430000);
  assert.strictEqual(payload.summary.customersWithOverdue, 2);
  assert.strictEqual(payload.summary.overdueInvoiceCount, 3);
  assert.strictEqual(payload.summary.oldestOverdueDays, 64);
  assert.strictEqual(payload.summary.topOverdueCustomers.length, 2);

  const top = payload.summary.topOverdueCustomers[0];
  assert.strictEqual(top.displayName, 'North Star Retail');
  assert.strictEqual(top.totalOverdueAmount, 350000);
  assert.strictEqual(top.oldestOverdueDays, 64);
  assert.strictEqual(top.invoiceCount, 2);
  assert.strictEqual(top.evidenceCount, 2);
  assert.strictEqual(top.priority, 'urgent');
  assert(top.confidence > 0.8, 'top customer should carry evidence confidence');

  const second = payload.summary.topOverdueCustomers[1];
  assert.strictEqual(second.displayName, 'Metro Steel House');
  assert(second.missingFields.includes('customer_link_missing'));

  assertNoUnsafeRenderedValues(payload);
}

function testSafetyGate() {
  assert.strictEqual(
    getStagingReadSafetyStatus({
      STARLANE_STAGING_READ_API_ENABLED: 'true',
      SUPABASE_URL: 'https://alepdpyqesevldobjxbo.supabase.co',
    }, { _staging: true }).allowed,
    false,
    'known production marker must fail closed'
  );

  assert.strictEqual(
    getStagingReadSafetyStatus({ RAILWAY_SERVICE_NAME: 'vantro-node-staging' }, {}).allowed,
    true,
    'staging service identity should allow the route'
  );

  assert.strictEqual(
    getStagingReadSafetyStatus({}, {}).allowed,
    false,
    'missing staging signal should fail closed'
  );

  assert.strictEqual(
    getStagingReadSafetyStatus({}, { _staging: true }).allowed,
    true,
    'staging-marked JWT should allow local staging harness reads'
  );
}

function testMethodBlocked() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };

  methodNotAllowed({}, res);
  assert.strictEqual(res.statusCode, 405);
  assert.deepStrictEqual(res.body.allowedMethods, ['GET']);
}

function testSanitizer() {
  assert.strictEqual(sanitizeDisplayName('Buyer 9988776655'), 'Buyer [redacted]');
  assert.strictEqual(sanitizeDisplayName('buyer@example.com'), 'Customer unavailable');
  assert.strictEqual(sanitizeDisplayName(''), 'Customer unavailable');
}

function testServerRouteRegistration() {
  const serverPath = path.join(__dirname, '..', 'server.js');
  const server = fs.readFileSync(serverPath, 'utf8');
  assert(server.includes("app.route('/api/staging/customer-overdue-summary')"), 'route must be registered');
  assert(server.includes('.get(authMiddleware, createCustomerOverdueSummaryHandler({ supabase }))'), 'GET must use auth middleware');
  assert(server.includes('.all(stagingCustomerOverdueMethodNotAllowed)'), 'non-GET must return 405');
}

testSafeAggregationShape();
testSafetyGate();
testMethodBlocked();
testSanitizer();
testServerRouteRegistration();

console.log('[PASS] staging customer overdue summary safety tests');
