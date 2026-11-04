// The connector contract (lib/connectors/sdk.js), proved with a sample ERP
// adapter that lives entirely in tests/fixtures: capability enforcement,
// normalization with provenance, retries with backoff and Retry-After, auth
// expiry, schema drift, approval + idempotency on actions, and the kill
// switch. No database; pure.
import { createRequire } from 'node:module';
import { makeChecker } from './helpers/httpHarness.mjs';

const require = createRequire(import.meta.url);
const sdk = require('../lib/connectors/sdk');
const { sampleErp } = require('./fixtures/connectors/sampleErp');
const { check, done } = makeChecker();

function world() {
  return {
    apiKey: 'k-1', dedupes: false, failures: [], pos: [],
    schema: { customer: ['party_id', 'party_name', 'gstin'], invoice: ['doc_no', 'party_id', 'total', 'ccy', 'doc_date', 'due_date'] },
    customers: [{ party_id: 'P1', party_name: 'Mehta Hardware', gstin: '07AAAAA0000A1Z5' }, { party_id: 'P2', party_name: '' }],
    invoices: [
      { doc_no: 'S/1', party_id: 'P1', total: '40000', ccy: 'INR', doc_date: '2026-08-01', due_date: '2026-08-31' },
      { doc_no: 'S/2', party_id: 'P1', total: '1200', ccy: 'USD', doc_date: '2026-08-02' },
      { doc_no: 'S/3', party_id: 'P1', total: 'abc', ccy: 'INR', doc_date: '2026-08-03' },
      { doc_no: 'S/4', party_id: 'P1', total: '10', ccy: 'rupees', doc_date: '2026-08-03' },
    ],
  };
}

function runtimeFor(erp, extra = {}) {
  const waits = [];
  let t = Date.parse('2026-09-30T00:00:00Z');
  const rt = sdk.createRuntime(sampleErp(erp), {
    credentials: { apiKey: 'k-1' },
    sleep: async (ms) => { waits.push(ms); t += ms; },
    now: () => t,
    random: () => 0.5,
    ...extra,
  });
  return { rt, waits, advance: (ms) => { t += ms; } };
}

async function main() {
  // ── Contract validation
  let err = null;
  try { sdk.defineConnector({ ...sampleErp(world()), capabilities: ['READ'] }); } catch (e) { err = e; }
  check('a connector cannot implement execute() without declaring EXECUTE', /implements execute\(\) without declaring EXECUTE/.test(err?.message), err?.message);
  err = null;
  try { sdk.defineConnector({ id: 'x', provider: 'p', version: '1', mode: 'carrier_pigeon', authType: 'none', capabilities: [], test: async () => true }); } catch (e) { err = e; }
  check('unknown modes are refused', /mode must be one of/.test(err?.message));
  check('the contract lists the eight health states', sdk.HEALTH.join() === 'CONNECTED,SYNCING,DEGRADED,STALE,AUTH_EXPIRED,RATE_LIMITED,FAILED,DISCONNECTED');

  // ── Connect, read, normalize
  {
    const erp = world();
    const { rt } = runtimeFor(erp);
    check('before connect: DISCONNECTED, confidence 0', rt.status().health === 'DISCONNECTED' && rt.status().confidenceFactor === 0);
    await rt.connect();
    check('connect runs test() and reports CONNECTED', rt.status().health === 'CONNECTED');
    const inv = await rt.read('invoice');
    const s1 = inv.records.find((r) => r.sourceId === 'S/1');
    check('vendor fields become normalized invoice fields', s1 && s1.customerRef === 'P1' && s1.amount === 40000 && s1.currency === 'INR' && s1.issuedOn === '2026-08-01');
    check('every record carries provenance (connector, version, fetched at)', s1.provenance.connectorId === 'sample_erp' && s1.provenance.connectorVersion === '1.0.0' && !!s1.provenance.fetchedAt);
    check('a USD invoice keeps its own currency (never summed into INR)', inv.records.find((r) => r.sourceId === 'S/2')?.currency === 'USD');
    check('a non-numeric amount is rejected with a reason, not guessed', inv.rejected.some((r) => r.sourceId === 'S/3' && /not a number/.test(r.reason)));
    check('a non-ISO currency is rejected with a reason', inv.rejected.some((r) => r.sourceId === 'S/4' && /ISO/.test(r.reason)));
    const cust = await rt.read('customer');
    check('a customer without a name is rejected (missing name)', cust.records.length === 1 && cust.rejected[0].reason === 'missing name');
    check('observability counts reads and rejections', rt.status().recordsRead === 3 && rt.status().recordsRejected === 3 && rt.status().lastSyncAt);
  }

  // ── Rate limit: honours Retry-After, then succeeds
  {
    const erp = world();
    erp.failures.push({ status: 429, retryAfter: '30' });
    const { rt, waits } = runtimeFor(erp);
    await rt.connect();
    const out = await rt.read('customer');
    check('a 429 is retried after Retry-After (30 s), then the read succeeds', waits[0] === 30000 && out.records.length === 1 && rt.status().health === 'CONNECTED', waits);
  }

  // ── Persistent 5xx: exponential backoff, bounded attempts, FAILED
  {
    const erp = world();
    for (let i = 0; i < 10; i++) erp.failures.push({ status: 503 });
    const { rt, waits } = runtimeFor(erp);
    await rt.connect();
    let e = null;
    try { await rt.read('invoice'); } catch (x) { e = x; }
    check('503s back off exponentially (500, 1000, 2000 ms with jitter midpoint 0.75x)', waits.join() === '375,750,1500', waits);
    check('retries stop after maxAttempts (4 calls) and health is FAILED', e?.kind === 'TRANSIENT' && rt.status().health === 'FAILED' && erp.failures.length === 6);
  }

  // ── Auth expiry: never retried, surfaces AUTH_EXPIRED, reads refuse
  {
    const erp = world();
    erp.failures.push({ status: 401 });
    const { rt, waits } = runtimeFor(erp);
    await rt.connect();
    let e = null;
    try { await rt.read('invoice'); } catch (x) { e = x; }
    check('a 401 is not retried and the source shows AUTH_EXPIRED', e?.kind === 'AUTH_EXPIRED' && waits.length === 0 && rt.status().health === 'AUTH_EXPIRED');
    e = null;
    try { await rt.read('invoice'); } catch (x) { e = x; }
    check('further reads say to reconnect instead of calling the vendor', /Reconnect/.test(e?.message) && erp.failures.length === 0);
    check('an expired source contributes zero confidence downstream', rt.status().confidenceFactor === 0);
  }

  // ── Schema drift: additive is reported; removing a mapped field degrades
  {
    const erp = world();
    const { rt } = runtimeFor(erp);
    await rt.connect();
    await rt.discoverSchema();
    erp.schema.invoice.push('branch_code');
    await rt.discoverSchema();
    check('an added source field is reported, health stays CONNECTED', rt.status().drift?.added?.invoice?.[0] === 'branch_code' && rt.status().health === 'CONNECTED');
    erp.schema.invoice = erp.schema.invoice.filter((f) => f !== 'ccy');
    erp.invoices = erp.invoices.map(({ ccy, ...r }) => r);
    await rt.discoverSchema();
    check('removing a mapped field (ccy) is breaking drift: DEGRADED', rt.status().drift?.removed?.invoice?.[0] === 'ccy' && rt.status().health === 'DEGRADED');
    const inv = await rt.read('invoice');
    check('the sync still runs and rejects rows it cannot trust (no crash)', inv.records.length === 0 && inv.rejected.every((r) => /currency/.test(r.reason)) && rt.status().health === 'DEGRADED');
    check('a degraded source halves downstream confidence', rt.status().confidenceFactor === 0.5);
  }

  // ── Staleness
  {
    const erp = world();
    const { rt, advance } = runtimeFor(erp);
    await rt.connect();
    await rt.read('customer');
    advance(2 * 60 * 60 * 1000);
    check('no sync inside the freshness window (1 h) shows STALE', rt.status().health === 'STALE');
  }

  // ── Actions: approval, idempotency, kill switch, unknown outcome
  {
    const erp = world();
    let stopped = false;
    const { rt } = runtimeFor(erp, { isStopped: () => stopped });
    await rt.connect();
    const approval = { approvedBy: 'user-1', approvedAt: '2026-09-30T10:00:00Z', policy: 'po_under_limit' };
    check('an action without an approval is refused', (await rt.execute('CREATE_PO', { supplier: 'S1', amount: 5000 }, { idempotencyKey: 'a1' })).status === 'REFUSED');
    check('an action without an idempotency key is refused', (await rt.execute('CREATE_PO', { supplier: 'S1', amount: 5000 }, { approval })).status === 'REFUSED');
    let e = null;
    try { await rt.execute('SEND_EMAIL', {}, { idempotencyKey: 'x', approval }); } catch (x) { e = x; }
    check('an action the connector does not implement is refused', /does not implement SEND_EMAIL/.test(e?.message));
    e = null;
    try { await rt.execute('UPDATE_CUSTOMER', {}, { idempotencyKey: 'x', approval }); } catch (x) { e = x; }
    check('an action needing an undeclared capability (WRITE) is refused', /does not support WRITE/.test(e?.message));
    const first = await rt.execute('CREATE_PO', { supplier: 'S1', amount: 5000 }, { idempotencyKey: 'a1', approval });
    const again = await rt.execute('CREATE_PO', { supplier: 'S1', amount: 5000 }, { idempotencyKey: 'a1', approval });
    check('the same idempotency key creates exactly one PO', first.status === 'DONE' && again.duplicate === true && erp.pos.length === 1);
    stopped = true;
    check('with the kill switch on, nothing executes', (await rt.execute('CREATE_PO', { supplier: 'S2', amount: 1 }, { idempotencyKey: 'a2', approval })).status === 'REFUSED' && erp.pos.length === 1);
    stopped = false;
    erp.failures.push({ status: 502 });
    const unknown = await rt.execute('CREATE_PO', { supplier: 'S3', amount: 7 }, { idempotencyKey: 'a3', approval });
    const retried = await rt.execute('CREATE_PO', { supplier: 'S3', amount: 7 }, { idempotencyKey: 'a3', approval });
    check('a 502 on a vendor that does not dedupe is UNKNOWN_OUTCOME, not retried blindly', unknown.status === 'UNKNOWN_OUTCOME' && retried.duplicate === true && erp.pos.length === 1);
    erp.failures.push({ status: 429, retryAfter: '5' });
    const limited = await rt.execute('CREATE_PO', { supplier: 'S4', amount: 9 }, { idempotencyKey: 'a4', approval });
    const later = await rt.execute('CREATE_PO', { supplier: 'S4', amount: 9 }, { idempotencyKey: 'a4', approval });
    check('a 429 before the vendor acted fails safely and can be retried later', limited.status === 'FAILED' && later.status === 'DONE' && erp.pos.length === 2);
  }
  {
    const erp = { ...world(), dedupes: true };
    erp.failures.push({ status: 503 });
    const { rt } = runtimeFor(erp);
    await rt.connect();
    const out = await rt.execute('CREATE_PO', { supplier: 'S5', amount: 3 }, { idempotencyKey: 'b1', approval: { approvedBy: 'u' } });
    check('a vendor that dedupes on the key is retried after a 503 and makes one PO', out.status === 'DONE' && erp.pos.length === 1);
  }

  // ── Truthful capability labels
  const c = sampleErp(world());
  check('labels: not connected / execution requires approval / read only / unavailable',
    sdk.capabilityLabel(c, { connected: false }) === 'SUPPORTED_NOT_CONNECTED'
    && sdk.capabilityLabel(c, { connected: true }) === 'EXECUTION_REQUIRES_APPROVAL'
    && sdk.capabilityLabel({ capabilities: ['READ'] }, { connected: true }) === 'READ_ONLY'
    && sdk.capabilityLabel(null, { connected: false }) === 'UNAVAILABLE');

  check('Retry-After accepts seconds and HTTP dates', sdk.parseRetryAfter('2') === 2000 && sdk.parseRetryAfter(new Date(Date.now() + 60000).toUTCString()) > 50000);

  // ── Extensibility: the adapter needs nothing from Starlane but the SDK.
  const fs = require('node:fs');
  const src = fs.readFileSync(new URL('./fixtures/connectors/sampleErp.js', import.meta.url), 'utf8');
  const requires = [...src.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]);
  check('the sample adapter imports only lib/connectors/sdk (zero core changes)', requires.length === 1 && requires[0].endsWith('lib/connectors/sdk'), requires);
  done();
}
main().catch((e) => { console.error(e); process.exit(1); });
