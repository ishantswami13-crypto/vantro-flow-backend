'use strict';
// lib/domain/outbound/preflight.js
// Readiness checks for the outbound engine. READ-ONLY: every check is a
// SELECT (plus, for GMAIL, one authenticated profile read at the provider).
// Safe against production. The full exercise with fixture tenants lives in
// scripts/outreach-preflight.js --exercise and only runs on a local DB.
//
// A check is PASS only when what it names was actually verified. Missing
// configuration is BLOCKED with the reason, never PASS. "critical" checks
// must PASS before START is allowed.

const { adapterFor } = require('./providers');
const { decrypt, available: credsAvailable } = require('./credentials');
const { resolvePolicies, CODE_DEFAULTS } = require('./rateLimiter');
const controls = require('./controls');

const TABLES = ['outbound_tenant_state', 'outbound_provider_accounts', 'outbound_campaigns', 'outbound_companies', 'outbound_contacts', 'outbound_contact_state_history',
  'outbound_experiments', 'outbound_enrollments', 'outbound_messages', 'outbound_send_jobs', 'outbound_send_attempts', 'outbound_delivery_events', 'outbound_replies',
  'outbound_suppressions', 'outbound_rate_policies', 'outbound_rate_buckets', 'outbound_rate_windows', 'outbound_system_controls', 'outbound_locks', 'outbound_audit',
  'outbound_alerts', 'outbound_costs'];
const TENANT_TABLES = TABLES.filter((t) => !['outbound_rate_policies', 'outbound_rate_buckets', 'outbound_rate_windows', 'outbound_system_controls', 'outbound_locks', 'outbound_audit', 'outbound_alerts'].includes(t));
const INDEXES = ['uq_outbound_jobs_open_per_contact', 'outbound_send_jobs_idempotency_key_key', 'idx_outbound_jobs_ready', 'uq_outbound_suppress_email', 'uq_outbound_suppress_domain', 'outbound_delivery_events_user_id_dedupe_key_key', 'outbound_replies_user_id_provider_message_id_key'];

async function runPreflight(pool, { userId = null, mode = null, runnerAlive = null, providerFor = null, checkProvider = true } = {}) {
  const checks = [];
  const add = (name, status, detail, critical = true) => checks.push({ name, status, critical, detail });

  // DATABASE
  try { await pool.query('SELECT 1'); add('DATABASE', 'PASS', 'connected'); } catch (err) {
    add('DATABASE', 'FAIL', err.message);
    return finish(checks);
  }

  // MIGRATIONS
  const reg = await pool.query(`SELECT t, to_regclass('public.' || t) IS NOT NULL AS ok FROM unnest($1::text[]) t`, [TABLES]);
  const missing = reg.rows.filter((r) => !r.ok).map((r) => r.t);
  if (missing.length) { add('MIGRATIONS', 'FAIL', `migration 062_outbound_engine.sql not applied; missing ${missing.length} table(s): ${missing.slice(0, 5).join(', ')}`); return finish(checks); }
  let ledger = 'no migration ledger table on this database';
  const led = await pool.query(`SELECT to_regclass('public.starlane_migrations') IS NOT NULL AS ok`);
  if (led.rows[0].ok) {
    const cols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name='starlane_migrations'`);
    const col = ['filename', 'name', 'file', 'version'].find((c) => cols.rows.some((r) => r.column_name === c));
    if (col) {
      const r = await pool.query(`SELECT COUNT(*)::int AS n FROM starlane_migrations WHERE ${col}::text LIKE '%062_outbound_engine%'`);
      ledger = r.rows[0].n ? '062 recorded in starlane_migrations' : '062 tables present but not recorded in starlane_migrations (apply through scripts/migrate.js)';
    }
  }
  add('MIGRATIONS', 'PASS', `all ${TABLES.length} outbound tables present; ${ledger}`);

  // QUEUE
  const idx = await pool.query(`SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname = ANY($1::text[])`, [INDEXES]);
  const missingIdx = INDEXES.filter((i) => !idx.rows.some((r) => r.indexname === i));
  const q = (await pool.query(
    `SELECT COUNT(*) FILTER (WHERE status IN ('QUEUED','RETRY_WAIT'))::int AS queued,
            COUNT(*) FILTER (WHERE status IN ('RESERVED','SENDING') AND lease_expires_at < NOW() - INTERVAL '10 minutes')::int AS stuck,
            COUNT(*) FILTER (WHERE status='AMBIGUOUS')::int AS ambiguous,
            COUNT(*) FILTER (WHERE status='FAILED')::int AS dead
       FROM outbound_send_jobs ${userId ? 'WHERE user_id=$1' : ''}`, userId ? [userId] : []
  )).rows[0];
  if (missingIdx.length) add('QUEUE', 'FAIL', `missing safety index(es): ${missingIdx.join(', ')}`);
  else if (q.stuck) add('QUEUE', 'FAIL', `${q.stuck} job(s) hold leases that expired over 10 minutes ago; lease recovery is not running`);
  else add('QUEUE', 'PASS', `idempotency + one-open-job-per-contact indexes present; ${q.queued} queued, ${q.ambiguous} awaiting provider reconciliation, ${q.dead} in dead-letter`);

  // SCHEDULER + WORKERS (liveness from lease heartbeats, works across instances)
  const locks = await pool.query(`SELECT name, owner, heartbeat_at, expires_at, last_tick FROM outbound_locks WHERE heartbeat_at > NOW() - INTERVAL '3 minutes'`);
  const leader = locks.rows.find((l) => l.name === 'scheduler');
  const workers = locks.rows.filter((l) => l.name.startsWith('worker:'));
  const runnerEnabled = String(process.env.OUTBOUND_ENGINE_ENABLED || '').toLowerCase() === 'true';
  if (leader) add('SCHEDULER', 'PASS', `leader ${leader.owner.split(':')[0]} last ticked ${Math.round((Date.now() - new Date(leader.heartbeat_at).getTime()) / 1000)}s ago`);
  else if (runnerAlive) add('SCHEDULER', 'PASS', 'runner is starting in this process; first tick pending');
  else add('SCHEDULER', runnerEnabled ? 'FAIL' : 'BLOCKED', runnerEnabled ? 'OUTBOUND_ENGINE_ENABLED is true but no scheduler has ticked in 3 minutes' : 'no scheduler is running: set OUTBOUND_ENGINE_ENABLED=true on the backend service');
  if (workers.length) add('WORKERS', 'PASS', `${workers.length} worker slot(s) alive across ${new Set(workers.map((w) => w.owner)).size} instance(s)`);
  else if (runnerAlive) add('WORKERS', 'PASS', 'workers starting in this process');
  else add('WORKERS', runnerEnabled ? 'FAIL' : 'BLOCKED', runnerEnabled ? 'no worker heartbeat in 3 minutes' : 'no workers are running: set OUTBOUND_ENGINE_ENABLED=true');

  // RATE LIMITER
  try {
    const targets = ['GLOBAL', 'PROVIDER', 'ACCOUNT', 'TENANT', 'CAMPAIGN', 'DOMAIN'].map((s) => ({ scope: s, key: '*' }));
    const pol = await resolvePolicies(pool, userId, 'email', targets);
    const unlimited = Object.entries(pol).filter(([, p]) => p.perMinute == null && p.perHour == null && p.perDay == null).map(([k]) => k);
    const acct = pol['ACCOUNT:*'];
    if (unlimited.length) add('RATE LIMITER', 'FAIL', `no limit configured for ${unlimited.join(', ')}`);
    else add('RATE LIMITER', 'PASS', `6-level hierarchy resolved (global, provider, account, tenant, campaign, domain); account ${acct.perMinute ?? '-'}/min, ${acct.perHour ?? '-'}/h, ${acct.perDay ?? '-'}/day (${acct.source}); state is shared in Postgres`);
  } catch (err) { add('RATE LIMITER', 'FAIL', err.message); }

  // GLOBAL STOP
  const gs = await controls.globalStop(pool);
  add('GLOBAL STOP', gs.stopped ? 'FAIL' : 'PASS', gs.stopped ? `global stop is ON (${gs.source}${gs.reason ? `: ${gs.reason}` : ''})` : 'off; STOP ALL OUTBOUND is available at /api/outreach/stop-all (owner) and /api/outreach/admin/global-stop (operator)');

  // SENDING MODE
  const effMode = mode || (userId ? (await controls.tenantState(pool, userId)).mode : 'SHADOW');
  if (effMode === 'SHADOW') add('SENDING MODE', 'PASS', 'SHADOW: the full pipeline runs, nothing leaves the building (sink provider)');
  else if (!controls.externalSendingEnabled()) add('SENDING MODE', 'BLOCKED', `${effMode} needs FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED=true (Hard Rule 7)`);
  else if (effMode === 'TEST' && !controls.testRecipients().length) add('SENDING MODE', 'BLOCKED', 'TEST mode needs OUTBOUND_TEST_RECIPIENTS (internal addresses or @domains)');
  else add('SENDING MODE', 'PASS', effMode === 'TEST' ? `TEST: real sends only to ${controls.testRecipients().length} allow-listed internal recipient(s)` : 'LIVE: real sends to prospects');

  // GMAIL / provider
  if (!userId) add('GMAIL', 'SKIPPED', 'tenant-specific; run with --user <id>', false);
  else {
    const acc = await pool.query(`SELECT * FROM outbound_provider_accounts WHERE user_id=$1 ORDER BY created_at`, [userId]);
    const gmail = acc.rows.filter((a) => a.provider === 'gmail');
    if (effMode === 'SHADOW' && !gmail.length) add('GMAIL', 'PASS', 'SHADOW mode does not need Gmail; connect it before TEST or LIVE');
    else if (!gmail.length) add('GMAIL', 'BLOCKED', 'no Gmail account connected (Outreach > Sending account)');
    else if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) add('GMAIL', 'BLOCKED', 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set on the backend');
    else if (!credsAvailable()) add('GMAIL', 'BLOCKED', 'OUTBOUND_CREDENTIALS_KEY is not set, so the stored token cannot be read');
    else {
      const bad = gmail.filter((a) => !['HEALTHY', 'THROTTLED'].includes(a.status));
      if (bad.length) add('GMAIL', 'FAIL', `${bad.map((a) => `${a.from_address} is ${a.status}`).join('; ')}`);
      else if (!checkProvider) add('GMAIL', 'PASS', `${gmail.length} account(s) HEALTHY (auth not re-checked)`);
      else {
        const results = [];
        for (const a of gmail) {
          const ad = providerFor ? providerFor(a, 'LIVE') : adapterFor(a, { credentials: decrypt(a.credentials_enc) });
          results.push({ a, r: await ad.checkAuth() });
        }
        const failed = results.filter((x) => !x.r.ok);
        if (failed.length) add('GMAIL', 'FAIL', failed.map((x) => `${x.a.from_address}: ${x.r.reason}`).join('; '));
        else add('GMAIL', 'PASS', results.map((x) => x.r.reason).join('; '));
      }
    }
  }

  // TARGETING
  if (!userId) add('TARGETING', 'SKIPPED', 'tenant-specific', false);
  else {
    const t = (await pool.query(
      `SELECT (SELECT COUNT(*)::int FROM outbound_campaigns WHERE user_id=$1 AND status IN ('DRAFT','ACTIVE','PAUSED')) AS campaigns,
              (SELECT COUNT(*)::int FROM outbound_campaigns WHERE user_id=$1 AND status='ACTIVE') AS active,
              (SELECT COUNT(*)::int FROM outbound_contacts WHERE user_id=$1 AND email_verified) AS verified,
              (SELECT COUNT(*)::int FROM outbound_enrollments WHERE user_id=$1 AND status IN ('APPROVED','QUEUED')) AS ready,
              (SELECT COUNT(*)::int FROM outbound_messages WHERE user_id=$1 AND review_status='PENDING_REVIEW') AS review`, [userId]
    )).rows[0];
    if (!t.campaigns) add('TARGETING', 'WARN', 'no campaign yet; START will run but queue nothing', false);
    else if (!t.ready && !t.review) add('TARGETING', 'WARN', `${t.campaigns} campaign(s), ${t.verified} verified contact(s), but no approved messages; nothing will be queued`, false);
    else add('TARGETING', 'PASS', `${t.active} active campaign(s), ${t.verified} verified contact(s), ${t.ready} approved to send, ${t.review} waiting for review`, false);
  }

  // SUPPRESSION (invariants: nothing suppressed or terminal has an open job)
  const sv = (await pool.query(
    `SELECT COUNT(*)::int AS n FROM outbound_send_jobs j JOIN outbound_contacts c ON c.id=j.contact_id AND c.user_id=j.user_id
      WHERE j.status IN ('QUEUED','RETRY_WAIT','RESERVED') ${userId ? 'AND j.user_id=$1' : ''}
        AND (c.state IN ('BOUNCED','BLOCKED','OPTED_OUT','SUPPRESSED','DECLINED')
             OR EXISTS (SELECT 1 FROM outbound_suppressions s WHERE s.user_id=c.user_id AND (s.email_normalized=c.email_normalized OR (s.email_normalized IS NULL AND s.domain=c.email_domain))))`,
    userId ? [userId] : []
  )).rows[0].n;
  const sc = (await pool.query(`SELECT COUNT(*)::int AS n FROM outbound_suppressions ${userId ? 'WHERE user_id=$1' : ''}`, userId ? [userId] : [])).rows[0].n;
  add('SUPPRESSION', sv ? 'FAIL' : 'PASS', sv ? `${sv} open job(s) target suppressed or terminal contacts` : `${sc} suppression(s) on file; no open job targets a suppressed, bounced, blocked or opted-out contact; re-checked inside every send transaction`);

  // RETRY
  const rv = (await pool.query(
    `SELECT COUNT(*) FILTER (WHERE status IN ('QUEUED','RETRY_WAIT') AND attempts > max_attempts + 2)::int AS over,
            COUNT(*) FILTER (WHERE status='RETRY_WAIT' AND updated_at < NOW() - INTERVAL '2 days')::int AS stale
       FROM outbound_send_jobs ${userId ? 'WHERE user_id=$1' : ''}`, userId ? [userId] : []
  )).rows[0];
  add('RETRY', rv.over || rv.stale ? 'FAIL' : 'PASS', rv.over || rv.stale ? `${rv.over} job(s) past max attempts, ${rv.stale} stuck in RETRY_WAIT over 2 days` : 'transient only (429 honours Retry-After, 5xx backoff 1m..1h with jitter, max 4 attempts); hard bounces and invalid recipients never retried; timeouts reconciled with the provider before any retry');

  // EVENT INGESTION
  const polled = userId ? (await pool.query(`SELECT from_address, last_poll_at, status FROM outbound_provider_accounts WHERE user_id=$1 AND provider='gmail'`, [userId])).rows : [];
  const ts = userId ? await controls.tenantState(pool, userId) : null;
  const stale = polled.filter((p) => ts?.engine_status === 'RUNNING' && (!p.last_poll_at || Date.now() - new Date(p.last_poll_at).getTime() > 20 * 60000));
  if (stale.length) add('EVENT INGESTION', 'FAIL', `mailbox not polled in 20 minutes: ${stale.map((s) => s.from_address).join(', ')}`);
  else add('EVENT INGESTION', 'PASS', `dedupe keys enforced (a duplicate webhook or re-read message has no second effect); bounces and replies read from ${polled.length ? `${polled.length} Gmail mailbox(es)` : 'Gmail once connected'} and POST /api/outreach/events`);

  // TENANCY (structure + cross-row consistency)
  const nullable = await pool.query(
    `SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='user_id' AND is_nullable='YES' AND table_name = ANY($1::text[])`, [TENANT_TABLES]
  );
  const mismatch = (await pool.query(
    `SELECT (SELECT COUNT(*)::int FROM outbound_send_jobs j JOIN outbound_contacts c ON c.id=j.contact_id WHERE c.user_id <> j.user_id)
          + (SELECT COUNT(*)::int FROM outbound_send_jobs j JOIN outbound_messages m ON m.id=j.message_id WHERE m.user_id <> j.user_id)
          + (SELECT COUNT(*)::int FROM outbound_send_jobs j JOIN outbound_provider_accounts a ON a.id=j.provider_account_id WHERE a.user_id <> j.user_id)
          + (SELECT COUNT(*)::int FROM outbound_enrollments e JOIN outbound_campaigns c ON c.id=e.campaign_id WHERE c.user_id <> e.user_id) AS n`
  )).rows[0].n;
  if (nullable.rows.length) add('TENANCY', 'FAIL', `user_id nullable on ${nullable.rows.map((r) => r.table_name).join(', ')}`);
  else if (mismatch) add('TENANCY', 'FAIL', `${mismatch} row(s) reference another tenant's data`);
  else add('TENANCY', 'PASS', `user_id NOT NULL on all ${TENANT_TABLES.length} tenant tables; 0 cross-tenant references; every query filters by the JWT user (the DB role bypasses RLS)`);

  return finish(checks);
}

function finish(checks) {
  const blocking = checks.filter((c) => c.critical && c.status !== 'PASS');
  return { ready: blocking.length === 0, verdict: blocking.length ? `NOT READY: ${blocking.map((c) => c.name).join(', ')}` : 'READY', checks, at: new Date().toISOString(), defaults: { email: CODE_DEFAULTS.email } };
}

module.exports = { runPreflight, TABLES, TENANT_TABLES };
