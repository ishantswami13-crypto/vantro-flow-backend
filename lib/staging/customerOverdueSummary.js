const ROUTE_PATH = '/api/staging/customer-overdue-summary';
const MAX_INVOICE_ROWS = 10000;
const KNOWN_PRODUCTION_MARKERS = [
  'alepdpyqesevldobjxbo',
  'vantro-flow-backend-production.up.railway.app',
  'vantro.in',
];

const STAGING_ENABLE_FLAGS = [
  'STARLANE_STAGING_READ_API_ENABLED',
  'ATLAS_STAGING_READ_API_ENABLED',
  'VANTRO_STAGING_READ_API_ENABLED',
  'STAGING_READ_API_ENABLED',
];

const STAGING_SIGNAL_KEYS = [
  'RAILWAY_SERVICE_NAME',
  'RAILWAY_PUBLIC_URL',
  'RAILWAY_ENVIRONMENT_NAME',
  'SUPABASE_URL',
  'DATABASE_URL',
  'CORTEX_TEST_BASE_URL',
  'STARLANE_ENV',
  'ATLAS_ENV',
  'VANTRO_ENV',
  'NODE_ENV',
];

function envValue(env, key) {
  return String((env || {})[key] || '').trim();
}

function hasKnownProductionMarker(env = {}) {
  const haystack = [
    envValue(env, 'SUPABASE_URL'),
    envValue(env, 'DATABASE_URL'),
    envValue(env, 'RAILWAY_PUBLIC_URL'),
    envValue(env, 'BACKEND_URL'),
    envValue(env, 'CORTEX_TEST_BASE_URL'),
  ].join(' ').toLowerCase();

  return KNOWN_PRODUCTION_MARKERS.some(marker => haystack.includes(marker));
}

function hasExplicitStagingEnable(env = {}) {
  return STAGING_ENABLE_FLAGS.some(key => envValue(env, key).toLowerCase() === 'true');
}

function hasStagingRuntimeSignal(env = {}) {
  return STAGING_SIGNAL_KEYS.some(key => /\bstaging\b|node-staging|starlane-staging|vantro-node-staging/i.test(envValue(env, key)));
}

function tokenHasStagingMarker(user = {}) {
  return user?._staging === true || user?.staging === true || user?.environment === 'staging';
}

function getStagingReadSafetyStatus(env = {}, user = {}) {
  if (hasKnownProductionMarker(env)) {
    return { allowed: false, reason: 'known_production_marker' };
  }

  if (hasExplicitStagingEnable(env) || hasStagingRuntimeSignal(env) || tokenHasStagingMarker(user)) {
    return { allowed: true, reason: 'staging_signal_present' };
  }

  return { allowed: false, reason: 'staging_signal_missing' };
}

function isMissingSchemaError(error) {
  const code = error?.code || '';
  const message = String(error?.message || '').toLowerCase();
  return (
    code === '42P01' ||
    code === '42703' ||
    code === 'PGRST204' ||
    message.includes('does not exist') ||
    message.includes('could not find') ||
    message.includes('schema cache')
  );
}

function toFiniteNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function sanitizeDisplayName(value) {
  const raw = String(value || '').replace(/\s+/g, ' ').trim();
  if (!raw) return 'Customer unavailable';

  const withoutEmail = raw.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig, '[redacted]');
  const withoutPhone = withoutEmail.replace(/\b\d{7,}\b/g, '[redacted]');
  const cleaned = withoutPhone.replace(/\s+/g, ' ').trim();

  if (!cleaned || cleaned === '[redacted]') return 'Customer unavailable';
  return cleaned.slice(0, 80);
}

function calculateOutstanding(invoice = {}) {
  const grossAmount = toFiniteNumber(
    invoice.total_amount ?? invoice.invoice_amount ?? invoice.amount ?? invoice.outstanding_amount
  );
  const paidAmount = toFiniteNumber(invoice.amount_paid ?? invoice.payment_amount ?? invoice.paid_amount);
  return Math.max(0, Math.round((grossAmount - paidAmount) * 100) / 100);
}

function priorityFor(totalOverdueAmount, oldestOverdueDays) {
  if (totalOverdueAmount >= 500000 || oldestOverdueDays >= 60) return 'urgent';
  if (totalOverdueAmount >= 200000 || oldestOverdueDays >= 30) return 'high';
  if (totalOverdueAmount >= 50000 || oldestOverdueDays >= 7) return 'medium';
  return 'low';
}

function confidenceFor(customer) {
  let confidence = 0.72;
  if (customer.displayName !== 'Customer unavailable') confidence += 0.1;
  if (!customer.missingFields.includes('amount_missing')) confidence += 0.06;
  if (!customer.missingFields.includes('oldest_overdue_days_missing')) confidence += 0.06;
  if (!customer.missingFields.includes('customer_record_missing')) confidence += 0.04;
  if (customer.invoiceCount > 1) confidence += 0.02;
  return Math.min(0.98, Number(confidence.toFixed(2)));
}

function buildCustomerOverdueSummary({ invoices = [], customerNames = new Map(), generatedAt = new Date() } = {}) {
  const buckets = new Map();
  const globalMissing = new Set();

  for (const invoice of invoices || []) {
    const status = String(invoice.payment_status || '').toLowerCase();
    const daysOverdue = Math.max(0, Math.floor(toFiniteNumber(invoice.days_overdue)));
    if (status === 'paid' || daysOverdue <= 0) continue;

    const totalDue = calculateOutstanding(invoice);
    if (totalDue <= 0) continue;

    const customerId = invoice.customer_id ? String(invoice.customer_id) : '';
    const joinedName = customerId ? customerNames.get(customerId) : null;
    const displayName = sanitizeDisplayName(joinedName || invoice.customer_name);
    const key = customerId || displayName.toLowerCase();

    if (!buckets.has(key)) {
      const missingFields = new Set();
      if (!customerId) missingFields.add('customer_link_missing');
      if (customerId && !joinedName) missingFields.add('customer_record_missing');
      if (displayName === 'Customer unavailable') missingFields.add('display_name_missing');

      buckets.set(key, {
        displayName,
        totalOverdueAmount: 0,
        oldestOverdueDays: 0,
        invoiceCount: 0,
        evidenceCount: 0,
        missingFields,
      });
    }

    const bucket = buckets.get(key);
    bucket.totalOverdueAmount = Math.round((bucket.totalOverdueAmount + totalDue) * 100) / 100;
    bucket.oldestOverdueDays = Math.max(bucket.oldestOverdueDays, daysOverdue);
    bucket.invoiceCount += 1;
    bucket.evidenceCount += 1;

    if (!Number.isFinite(Number(invoice.invoice_amount ?? invoice.total_amount ?? invoice.amount ?? invoice.outstanding_amount))) {
      bucket.missingFields.add('amount_missing');
    }
    if (!Number.isFinite(Number(invoice.days_overdue))) {
      bucket.missingFields.add('oldest_overdue_days_missing');
    }
  }

  const customers = Array.from(buckets.values())
    .map(customer => {
      const missingFields = Array.from(customer.missingFields).sort();
      missingFields.forEach(field => globalMissing.add(field));
      const shaped = {
        displayName: customer.displayName,
        totalOverdueAmount: customer.totalOverdueAmount,
        oldestOverdueDays: customer.oldestOverdueDays,
        invoiceCount: customer.invoiceCount,
        priority: priorityFor(customer.totalOverdueAmount, customer.oldestOverdueDays),
        evidenceCount: customer.evidenceCount,
        confidence: 0,
        missingFields,
      };
      shaped.confidence = confidenceFor(shaped);
      return shaped;
    })
    .sort((a, b) => (
      b.totalOverdueAmount - a.totalOverdueAmount ||
      b.oldestOverdueDays - a.oldestOverdueDays ||
      a.displayName.localeCompare(b.displayName)
    ));

  const totalOverdueAmount = customers.reduce((sum, customer) => sum + customer.totalOverdueAmount, 0);
  const overdueInvoiceCount = customers.reduce((sum, customer) => sum + customer.invoiceCount, 0);
  const confidence = customers.length
    ? Number((customers.reduce((sum, customer) => sum + customer.confidence, 0) / customers.length).toFixed(2))
    : 0;

  return {
    ok: true,
    success: true,
    route: ROUTE_PATH,
    source: 'staging_invoice_read',
    generatedAt: generatedAt instanceof Date ? generatedAt.toISOString() : new Date(generatedAt).toISOString(),
    summary: {
      totalOverdueAmount: Math.round(totalOverdueAmount * 100) / 100,
      customersWithOverdue: customers.length,
      overdueInvoiceCount,
      oldestOverdueDays: customers.reduce((max, customer) => Math.max(max, customer.oldestOverdueDays), 0),
      confidence,
      missingFields: Array.from(globalMissing).sort(),
      topOverdueCustomers: customers.slice(0, 5),
    },
    customers,
  };
}

async function fetchOverdueInvoices(supabase, userId) {
  const projections = [
    'customer_id, customer_name, invoice_amount, total_amount, amount_paid, payment_amount, payment_status, days_overdue, due_date, invoice_date, created_at',
    'customer_id, invoice_amount, total_amount, amount_paid, payment_status, days_overdue, due_date, created_at',
    'customer_name, invoice_amount, payment_amount, payment_status, days_overdue, due_date, invoice_date, created_at',
    'invoice_amount, payment_status, days_overdue, due_date, created_at',
  ];

  let lastError = null;
  for (const projection of projections) {
    const { data, error } = await supabase
      .from('invoices')
      .select(projection)
      .eq('user_id', userId)
      .gt('days_overdue', 0)
      .not('payment_status', 'eq', 'Paid')
      .order('days_overdue', { ascending: false })
      .limit(MAX_INVOICE_ROWS);

    if (!error) return data || [];
    lastError = error;
    if (!isMissingSchemaError(error)) break;
  }

  const err = new Error('invoice_read_failed');
  err.safeCode = 'invoice_read_failed';
  err.cause = lastError;
  throw err;
}

async function fetchCustomerNames(supabase, userId, invoices) {
  const ids = Array.from(new Set((invoices || []).map(row => row.customer_id).filter(Boolean).map(String)));
  if (!ids.length) return new Map();

  const { data, error } = await supabase
    .from('customers')
    .select('id, name')
    .eq('user_id', userId)
    .in('id', ids)
    .limit(ids.length);

  if (error) {
    if (isMissingSchemaError(error)) return new Map();
    const err = new Error('customer_read_failed');
    err.safeCode = 'customer_read_failed';
    err.cause = error;
    throw err;
  }

  return new Map((data || []).map(customer => [String(customer.id), customer.name]));
}

function createCustomerOverdueSummaryHandler({ supabase, env = process.env, now = () => new Date() } = {}) {
  return async function customerOverdueSummaryHandler(req, res) {
    const safety = getStagingReadSafetyStatus(env, req.user);
    if (!safety.allowed) {
      return res.status(403).json({
        success: false,
        error: 'Staging customer overdue summary unavailable',
        reason: 'staging_read_gate_closed',
      });
    }

    const userId = req.user?.userId || req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Missing tenant scope' });
    }

    if (!supabase) {
      return res.status(503).json({
        success: false,
        error: 'Staging customer overdue summary unavailable',
        reason: 'staging_data_client_unavailable',
      });
    }

    try {
      const invoices = await fetchOverdueInvoices(supabase, userId);
      const customerNames = await fetchCustomerNames(supabase, userId, invoices);
      return res.json(buildCustomerOverdueSummary({ invoices, customerNames, generatedAt: now() }));
    } catch (error) {
      console.error('[staging/customer-overdue-summary]', error?.safeCode || error?.message || 'read_failed');
      return res.status(500).json({
        success: false,
        error: 'Staging customer overdue summary unavailable',
        reason: 'read_failed',
      });
    }
  };
}

function methodNotAllowed(_req, res) {
  return res.status(405).json({
    success: false,
    error: 'Method not allowed',
    allowedMethods: ['GET'],
  });
}

module.exports = {
  ROUTE_PATH,
  buildCustomerOverdueSummary,
  createCustomerOverdueSummaryHandler,
  getStagingReadSafetyStatus,
  hasKnownProductionMarker,
  methodNotAllowed,
  sanitizeDisplayName,
};
