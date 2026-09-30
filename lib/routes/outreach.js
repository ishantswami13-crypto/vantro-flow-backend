'use strict';
// lib/routes/outreach.js — the outbound engine over HTTP (/api/outreach).
//
//   Status    GET /status, GET /health, GET /preflight, GET /attention
//   Control   POST /start {mode}, POST /stop-all, POST /admin/global-stop (operator)
//   Accounts  GET|POST /providers, POST /providers/:id/pause|resume,
//             GET /providers/gmail/connect-url, GET /providers/gmail/callback
//   Targets   POST /targets/import, GET /contacts, POST /contacts/verify,
//             POST /contacts/:id/approve-unverified, POST /contacts/:id/suppress
//   Campaigns GET|POST /campaigns, GET|PATCH /campaigns/:id, POST /campaigns/:id/(start|pause|resume|stop),
//             POST /campaigns/:id/enroll, POST /campaigns/:id/drafts, POST /campaigns/:id/experiments
//   Review    GET /messages, POST /messages/:id/review
//   Queue     GET /jobs, POST /jobs/:id/cancel, POST /jobs/:id/resolve (dead letter / ambiguous)
//   Safety    GET|POST /suppressions, GET|PUT /rate-policies
//   Events    POST /events, POST /replies, GET /replies, POST /replies/:id/handled
//   Learning  GET /metrics, GET /segments, GET /learnings, GET /audit
//
// Every handler takes the tenant from the verified JWT, never from the
// request, and every query filters by it. Provider credentials are never
// returned.

const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { safeLog } = require('../observability/logger');
const campaigns = require('../domain/outbound/campaigns');
const engine = require('../domain/outbound/engine');
const { runPreflight } = require('../domain/outbound/preflight');
const metrics = require('../domain/outbound/metrics');
const events = require('../domain/outbound/events');
const store = require('../domain/outbound/store');
const controls = require('../domain/outbound/controls');
const rateLimiter = require('../domain/outbound/rateLimiter');
const { adapterFor } = require('../domain/outbound/providers');
const creds = require('../domain/outbound/credentials');
const { checkSyntax } = require('../domain/outbound/emailValidation');

function uid(req) { return req.user?.userId || req.user?.id || null; }

function sendError(res, req, err) {
  if (err && err.status && err.status >= 400 && err.status < 500) return res.status(err.status).json({ error: err.message });
  if (err && [501, 503].includes(err.status)) return res.status(err.status).json({ error: err.message });
  safeLog('error', '[outreach] request failed', { path: req.path, requestId: req.requestId, error: err && creds.redact(err.message) });
  return res.status(500).json({ error: 'Something went wrong on our side. Nothing was sent unless the audit log shows it.', requestId: req.requestId || null });
}
const wrap = (fn) => async (req, res) => { try { await fn(req, res); } catch (err) { sendError(res, req, err); } };
const bad = (m) => Object.assign(new Error(m), { status: 400 });
const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || ''));

function accountView(a) {
  return { id: a.id, provider: a.provider, fromAddress: a.from_address, displayName: a.display_name, status: a.status, statusReason: a.status_reason, dailyMax: a.daily_max,
    warmupStartedOn: a.warmup_started_on, warmupSchedule: a.warmup_schedule, throttleFactor: Number(a.throttle_factor), hasCredentials: !!a.credentials_enc,
    lastSuccessAt: a.last_success_at, lastPollAt: a.last_poll_at, createdAt: a.created_at };
}

const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.readonly'];

function outreachRouter({ pool, authMiddleware, requireAdmin, runner = null }) {
  const router = express.Router();
  const runnerAlive = () => !!(runner && runner.running);

  // ---- Gmail OAuth callback (no bearer token: Google redirects the browser;
  // the tenant comes from a signed, short-lived state parameter).
  router.get('/providers/gmail/callback', wrap(async (req, res) => {
    const front = process.env.FRONTEND_URL || '';
    let state;
    try { state = jwt.verify(String(req.query.state || ''), process.env.JWT_SECRET, { algorithms: ['HS256'], audience: 'outbound-gmail-connect' }); } catch { return res.status(400).send('This connect link has expired. Start again from Outreach.'); }
    if (!req.query.code) return res.redirect(`${front}/outreach?gmail=cancelled`);
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: String(req.query.code), client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, redirect_uri: process.env.GOOGLE_OAUTH_REDIRECT_URI, grant_type: 'authorization_code' }).toString(),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.refresh_token) return res.redirect(`${front}/outreach?gmail=failed`);
    const prof = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: { Authorization: `Bearer ${j.access_token}` } }).then((x) => x.json()).catch(() => ({}));
    if (!prof.emailAddress) return res.redirect(`${front}/outreach?gmail=failed`);
    await pool.query(
      `INSERT INTO outbound_provider_accounts (user_id, provider, from_address, display_name, status, credentials_enc, daily_max, warmup_started_on, created_by)
       VALUES ($1,'gmail',$2,$3,'HEALTHY',$4,$5,CURRENT_DATE,$1)
       ON CONFLICT (user_id, provider, from_address) DO UPDATE SET credentials_enc=EXCLUDED.credentials_enc, status='HEALTHY', status_reason='reconnected', consecutive_errors=0, updated_at=NOW()`,
      [state.sub, prof.emailAddress.toLowerCase(), state.displayName || null, creds.encrypt({ refreshToken: j.refresh_token }), Number(state.dailyMax) || 40]
    );
    await store.audit(pool, { userId: state.sub, actor: `user:${state.sub}`, action: 'GMAIL_CONNECTED', detail: { fromAddress: prof.emailAddress } });
    return res.redirect(`${front}/outreach?gmail=connected`);
  }));

  router.use(authMiddleware);

  // ------------------------------------------------------------ status
  router.get('/status', wrap(async (req, res) => res.json(await metrics.statusPanel(pool, uid(req)))));
  router.get('/attention', wrap(async (req, res) => res.json(await metrics.attentionItems(pool, uid(req)))));
  router.get('/preflight', wrap(async (req, res) => {
    const mode = ['SHADOW', 'TEST', 'LIVE'].includes(req.query.mode) ? req.query.mode : null;
    res.json(await runPreflight(pool, { userId: uid(req), mode, runnerAlive: runnerAlive() }));
  }));
  router.get('/health', wrap(async (req, res) => {
    const pre = await runPreflight(pool, { userId: uid(req), runnerAlive: runnerAlive(), checkProvider: false });
    const pick = (n) => pre.checks.find((c) => c.name === n) || { status: 'NOT_RUN' };
    const last = (await pool.query(`SELECT MAX(sent_at) AS at FROM outbound_send_jobs WHERE user_id=$1 AND status='SENT'`, [uid(req)])).rows[0].at;
    res.status(['DATABASE', 'MIGRATIONS', 'QUEUE'].every((n) => pick(n).status === 'PASS') ? 200 : 503).json({
      database: pick('DATABASE'), migrations: pick('MIGRATIONS'), queue: pick('QUEUE'), providers: pick('GMAIL'), scheduler: pick('SCHEDULER'), workers: pick('WORKERS'),
      rateLimiter: pick('RATE LIMITER'), globalStop: pick('GLOBAL STOP'), lastSuccessfulSend: last, runnerInThisProcess: runnerAlive(),
    });
  }));

  // ------------------------------------------------------------ control
  router.post('/start', wrap(async (req, res) => {
    const mode = String(req.body?.mode || 'SHADOW').toUpperCase();
    if (mode === 'LIVE' && req.body?.confirm !== 'SEND TO REAL PROSPECTS') throw bad('LIVE mode sends real email to prospects. Send confirm: "SEND TO REAL PROSPECTS" to start it.');
    const r = await engine.startOutreach(pool, uid(req), uid(req), { mode, runnerAlive: runnerAlive() });
    res.status(r.started ? 200 : 409).json(r);
  }));
  router.post('/stop-all', wrap(async (req, res) => res.json(await engine.stopOutreach(pool, uid(req), uid(req), String(req.body?.reason || 'STOP ALL OUTBOUND pressed').slice(0, 200)))));
  if (requireAdmin) {
    router.post('/admin/global-stop', requireAdmin, wrap(async (req, res) => {
      const r = await controls.setGlobalStop(pool, req.body?.enabled !== false, { reason: String(req.body?.reason || '').slice(0, 200) || null, setBy: `admin:${req.user?.email}` });
      await store.audit(pool, { userId: null, actor: `admin:${uid(req)}`, action: r.stopped ? 'GLOBAL_STOP_ON' : 'GLOBAL_STOP_OFF', detail: { reason: req.body?.reason || null } });
      // WhatsApp, voice and push read the same switch; apply it now, not in 15 s.
      await require('../safety/externalSend').refreshGlobalStop(pool);
      res.json(r);
    }));
  }

  // ------------------------------------------------------------ provider accounts
  router.get('/providers', wrap(async (req, res) => {
    const r = await pool.query('SELECT * FROM outbound_provider_accounts WHERE user_id=$1 ORDER BY created_at', [uid(req)]);
    res.json({ accounts: r.rows.map(accountView), gmailOAuthConfigured: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_OAUTH_REDIRECT_URI), credentialsKeyConfigured: creds.available(), outlook: 'not supported yet' });
  }));
  router.get('/providers/gmail/connect-url', wrap(async (req, res) => {
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !process.env.GOOGLE_OAUTH_REDIRECT_URI) throw Object.assign(new Error('Gmail is not configured on the backend: set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_OAUTH_REDIRECT_URI'), { status: 503 });
    if (!creds.available()) throw Object.assign(new Error('OUTBOUND_CREDENTIALS_KEY is not set, so a Gmail token cannot be stored safely'), { status: 503 });
    const state = jwt.sign({ sub: uid(req), dailyMax: Number(req.query.dailyMax) || 40, displayName: req.query.displayName ? String(req.query.displayName).slice(0, 80) : null, n: crypto.randomBytes(8).toString('hex') },
      process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '10m', audience: 'outbound-gmail-connect' });
    const url = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: process.env.GOOGLE_OAUTH_REDIRECT_URI, response_type: 'code', access_type: 'offline', prompt: 'consent', scope: GMAIL_SCOPES.join(' '), state })}`;
    res.json({ url, scopes: GMAIL_SCOPES });
  }));
  router.post('/providers', wrap(async (req, res) => {
    const b = req.body || {};
    const provider = String(b.provider || '');
    if (provider === 'outlook') throw Object.assign(new Error('Outlook is not supported yet'), { status: 501 });
    if (!['gmail', 'sink'].includes(provider)) throw bad('provider must be gmail or sink');
    const from = String(b.fromAddress || '').trim().toLowerCase();
    if (!checkSyntax(from).ok && provider === 'gmail') throw bad('fromAddress must be a valid address');
    const dailyMax = Math.max(1, Math.min(500, Number(b.dailyMax) || 40));
    let enc = null;
    let status = 'HEALTHY';
    let reason = provider === 'sink' ? 'sink: delivers nowhere (shadow and tests)' : null;
    if (provider === 'gmail') {
      if (!b.refreshToken) throw bad('connect Gmail through GET /providers/gmail/connect-url, or pass refreshToken');
      enc = creds.encrypt({ refreshToken: String(b.refreshToken) });
      const auth = await adapterFor({ id: `probe-${crypto.randomUUID()}`, provider: 'gmail', from_address: from }, { credentials: { refreshToken: String(b.refreshToken) } }).checkAuth();
      if (!auth.ok) { status = 'AUTH_REQUIRED'; reason = auth.reason; }
    }
    const r = await pool.query(
      `INSERT INTO outbound_provider_accounts (user_id, provider, from_address, display_name, status, status_reason, credentials_enc, daily_max, warmup_started_on, warmup_schedule, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $9 THEN CURRENT_DATE ELSE NULL END, COALESCE($10::jsonb, '[5,8,12,16,20,25,30,35,40]'::jsonb), $1)
       ON CONFLICT (user_id, provider, from_address) DO UPDATE SET display_name=EXCLUDED.display_name, credentials_enc=COALESCE(EXCLUDED.credentials_enc, outbound_provider_accounts.credentials_enc),
         status=EXCLUDED.status, status_reason=EXCLUDED.status_reason, daily_max=EXCLUDED.daily_max, updated_at=NOW()
       RETURNING *`,
      [uid(req), provider, from || `sink@${uid(req)}.outbound.invalid`, b.displayName || null, status, reason, enc, dailyMax, b.warmup !== false, Array.isArray(b.warmupSchedule) ? JSON.stringify(b.warmupSchedule.map(Number)) : null]
    );
    await store.audit(pool, { userId: uid(req), actor: `user:${uid(req)}`, action: 'PROVIDER_ACCOUNT_SAVED', detail: { provider, fromAddress: r.rows[0].from_address, status } });
    res.status(201).json(accountView(r.rows[0]));
  }));
  router.post('/providers/:id/:action(pause|resume)', wrap(async (req, res) => {
    if (!isUuid(req.params.id)) throw bad('bad id');
    const to = req.params.action === 'pause' ? 'PAUSED' : 'HEALTHY';
    const r = await pool.query(`UPDATE outbound_provider_accounts SET status=$3, status_reason=$4, consecutive_errors=0, updated_at=NOW() WHERE id=$1 AND user_id=$2 ${to === 'HEALTHY' ? "AND status <> 'AUTH_REQUIRED'" : ''} RETURNING *`,
      [req.params.id, uid(req), to, `${req.params.action}d by owner`]);
    if (!r.rowCount) throw Object.assign(new Error('account not found, or it needs to be reconnected first'), { status: 404 });
    await store.audit(pool, { userId: uid(req), actor: `user:${uid(req)}`, action: `PROVIDER_${to}`, detail: { accountId: req.params.id } });
    res.json(accountView(r.rows[0]));
  }));

  // ------------------------------------------------------------ targets
  router.post('/targets/import', wrap(async (req, res) => res.json(await campaigns.importTargets(pool, uid(req), req.body?.rows, { source: String(req.body?.source || 'import').slice(0, 100), profile: req.body?.profile || {} }))));
  router.get('/contacts', wrap(async (req, res) => {
    const state = req.query.state ? String(req.query.state).toUpperCase() : null;
    const r = await pool.query(
      `SELECT c.id, c.full_name, c.role_title, c.email, c.country, c.timezone, c.state, c.email_verified, c.verification_method, c.verified_at, c.role_verified_at, c.confidence,
              co.name AS company, co.industry, co.fit_score
         FROM outbound_contacts c LEFT JOIN outbound_companies co ON co.id=c.company_id AND co.user_id=c.user_id
        WHERE c.user_id=$1 AND ($2::text IS NULL OR c.state=$2) ORDER BY co.fit_score DESC NULLS LAST, c.created_at DESC LIMIT 500`,
      [uid(req), state]
    );
    res.json({ contacts: r.rows });
  }));
  router.post('/contacts/verify', wrap(async (req, res) => {
    const ids = (req.body?.contactIds || []).filter(isUuid);
    res.json({ results: await campaigns.verifyContacts(pool, uid(req), ids) });
  }));
  router.post('/contacts/:id/approve-unverified', wrap(async (req, res) => {
    if (!isUuid(req.params.id)) throw bad('bad id');
    res.json(await campaigns.approveUnverified(pool, uid(req), req.params.id, uid(req)));
  }));
  router.post('/contacts/:id/suppress', wrap(async (req, res) => {
    if (!isUuid(req.params.id)) throw bad('bad id');
    const c = (await pool.query('SELECT email FROM outbound_contacts WHERE id=$1 AND user_id=$2', [req.params.id, uid(req)])).rows[0];
    if (!c) throw Object.assign(new Error('contact not found'), { status: 404 });
    res.json(await store.tx(pool, (db) => store.suppress(db, uid(req), { email: c.email, reason: String(req.body?.reason || 'EXPLICIT_DO_NOT_CONTACT'), source: 'owner', note: req.body?.note || null, actorId: uid(req) })));
  }));

  // ------------------------------------------------------------ campaigns
  router.get('/campaigns', wrap(async (req, res) => {
    const r = await pool.query('SELECT * FROM outbound_campaigns WHERE user_id=$1 ORDER BY created_at DESC', [uid(req)]);
    res.json({ campaigns: r.rows });
  }));
  router.post('/campaigns', wrap(async (req, res) => res.status(201).json(await campaigns.createCampaign(pool, uid(req), req.body || {}, uid(req)))));
  router.get('/campaigns/:id', wrap(async (req, res) => {
    if (!isUuid(req.params.id)) throw bad('bad id');
    const c = await campaigns.getCampaign(pool, uid(req), req.params.id);
    res.json({ campaign: c, metrics: await metrics.campaignMetrics(pool, uid(req), c.id) });
  }));
  router.patch('/campaigns/:id', wrap(async (req, res) => {
    if (!isUuid(req.params.id)) throw bad('bad id');
    res.json(await campaigns.updateCampaign(pool, uid(req), req.params.id, req.body || {}, uid(req)));
  }));
  router.post('/campaigns/:id/:action(start|pause|resume|stop)', wrap(async (req, res) => {
    if (!isUuid(req.params.id)) throw bad('bad id');
    res.json(await campaigns.setCampaignStatus(pool, uid(req), req.params.id, req.params.action.toUpperCase(), uid(req)));
  }));
  router.post('/campaigns/:id/enroll', wrap(async (req, res) => {
    if (!isUuid(req.params.id)) throw bad('bad id');
    res.json(await campaigns.enroll(pool, uid(req), req.params.id, (req.body?.contactIds || []).filter(isUuid)));
  }));
  router.post('/campaigns/:id/drafts', wrap(async (req, res) => {
    if (!isUuid(req.params.id)) throw bad('bad id');
    res.json(await campaigns.generateDrafts(pool, uid(req), req.params.id, { limit: Number(req.body?.limit) || 50 }));
  }));
  router.post('/campaigns/:id/experiments', wrap(async (req, res) => {
    if (!isUuid(req.params.id)) throw bad('bad id');
    res.status(201).json(await campaigns.createExperiment(pool, uid(req), req.params.id, req.body || {}));
  }));

  // ------------------------------------------------------------ review
  router.get('/messages', wrap(async (req, res) => {
    const status = req.query.status ? String(req.query.status).toUpperCase() : 'PENDING_REVIEW';
    const r = await pool.query(
      `SELECT m.id, m.campaign_id, m.step, m.version, m.subject, m.body, m.evidence, m.validation, m.review_status, m.variant_key, m.template_version, m.generated_at,
              c.full_name, c.role_title, c.email, co.name AS company
         FROM outbound_messages m JOIN outbound_contacts c ON c.id=m.contact_id AND c.user_id=m.user_id LEFT JOIN outbound_companies co ON co.id=c.company_id AND co.user_id=c.user_id
        WHERE m.user_id=$1 AND m.review_status=$2 ORDER BY m.generated_at LIMIT 200`,
      [uid(req), status]
    );
    res.json({ messages: r.rows });
  }));
  router.post('/messages/:id/review', wrap(async (req, res) => {
    if (!isUuid(req.params.id)) throw bad('bad id');
    res.json(await campaigns.reviewMessage(pool, uid(req), req.params.id, { decision: String(req.body?.decision || '').toUpperCase(), subject: req.body?.subject, body: req.body?.body }, uid(req)));
  }));

  // ------------------------------------------------------------ queue
  router.get('/jobs', wrap(async (req, res) => {
    const status = req.query.status ? String(req.query.status).toUpperCase() : null;
    const r = await pool.query(
      `SELECT j.id, j.campaign_id, j.status, j.mode, j.priority, j.run_after, j.attempts, j.max_attempts, j.last_error, j.failure_class, j.sent_at, j.scheduled_by, j.correlation_id,
              j.cancelled_reason, j.dead_lettered_at, c.full_name, c.email, co.name AS company
         FROM outbound_send_jobs j JOIN outbound_contacts c ON c.id=j.contact_id AND c.user_id=j.user_id LEFT JOIN outbound_companies co ON co.id=c.company_id AND co.user_id=c.user_id
        WHERE j.user_id=$1 AND ($2::text IS NULL OR j.status=$2) ORDER BY j.updated_at DESC LIMIT 300`,
      [uid(req), status]
    );
    res.json({ jobs: r.rows });
  }));
  router.post('/jobs/:id/cancel', wrap(async (req, res) => {
    if (!isUuid(req.params.id)) throw bad('bad id');
    const r = await pool.query(`UPDATE outbound_send_jobs SET status='CANCELLED', cancelled_reason='cancelled by owner', lease_owner=NULL, lease_expires_at=NULL, updated_at=NOW()
      WHERE id=$1 AND user_id=$2 AND status IN ('QUEUED','RETRY_WAIT','RESERVED') RETURNING id`, [req.params.id, uid(req)]);
    if (!r.rowCount) throw Object.assign(new Error('job not found, or it is already sending or finished'), { status: 409 });
    await store.audit(pool, { userId: uid(req), actor: `user:${uid(req)}`, action: 'JOB_CANCELLED', jobId: req.params.id, detail: { reason: 'owner' } });
    res.json({ id: req.params.id, status: 'CANCELLED' });
  }));
  // Dead-letter and ambiguous jobs: a person decides. RETRY requeues a
  // FAILED job (after the cause is fixed) or an AMBIGUOUS one the owner
  // checked is not in the Sent folder; MARK_SENT records an AMBIGUOUS one
  // the owner found in the Sent folder.
  router.post('/jobs/:id/resolve', wrap(async (req, res) => {
    if (!isUuid(req.params.id)) throw bad('bad id');
    const action = String(req.body?.action || '').toUpperCase();
    const job = (await pool.query('SELECT * FROM outbound_send_jobs WHERE id=$1 AND user_id=$2', [req.params.id, uid(req)])).rows[0];
    if (!job) throw Object.assign(new Error('job not found'), { status: 404 });
    if (action === 'RETRY' && ['FAILED', 'AMBIGUOUS'].includes(job.status)) {
      if (job.status === 'AMBIGUOUS' && req.body?.confirmNotInSentFolder !== true) throw bad('confirm you checked the Sent folder and the message is not there (confirmNotInSentFolder: true)');
      const r = await pool.query(`UPDATE outbound_send_jobs SET status='QUEUED', attempts=0, run_after=NOW(), dead_lettered_at=NULL, lease_owner=NULL, lease_expires_at=NULL, last_error='requeued by owner', updated_at=NOW()
        WHERE id=$1 AND user_id=$2 AND status IN ('FAILED','AMBIGUOUS') RETURNING id`, [job.id, uid(req)]);
      await store.audit(pool, { userId: uid(req), actor: `user:${uid(req)}`, action: 'JOB_REQUEUED_BY_OWNER', jobId: job.id, detail: { from: job.status } });
      return res.json({ id: job.id, status: r.rowCount ? 'QUEUED' : job.status });
    }
    if (action === 'MARK_SENT' && job.status === 'AMBIGUOUS') {
      await pool.query(`UPDATE outbound_send_jobs SET status='SENT', sent_at=NOW(), lease_owner=NULL, last_error='confirmed sent by owner', updated_at=NOW() WHERE id=$1 AND user_id=$2 AND status='AMBIGUOUS'`, [job.id, uid(req)]);
      await store.audit(pool, { userId: uid(req), actor: `user:${uid(req)}`, action: 'JOB_MARKED_SENT_BY_OWNER', jobId: job.id });
      return res.json({ id: job.id, status: 'SENT' });
    }
    throw Object.assign(new Error(`cannot ${action || 'resolve'} a ${job.status} job`), { status: 409 });
  }));

  // ------------------------------------------------------------ safety
  router.get('/suppressions', wrap(async (req, res) => {
    const r = await pool.query('SELECT id, email_normalized AS email, domain, reason, hard, source, note, created_at FROM outbound_suppressions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1000', [uid(req)]);
    res.json({ suppressions: r.rows, reasons: store.SUPPRESSION_REASONS });
  }));
  router.post('/suppressions', wrap(async (req, res) => {
    const b = req.body || {};
    res.status(201).json(await store.tx(pool, (db) => store.suppress(db, uid(req), { email: b.email || null, domain: b.domain || null, reason: String(b.reason || 'EXPLICIT_DO_NOT_CONTACT'), source: 'owner', note: b.note || null, actorId: uid(req) })));
  }));
  router.get('/rate-policies', wrap(async (req, res) => {
    const r = await pool.query('SELECT id, user_id IS NULL AS global, service, scope, scope_key, per_minute, per_hour, per_day, burst, concurrency, enabled, updated_at FROM outbound_rate_policies WHERE user_id=$1 OR user_id IS NULL ORDER BY service, scope', [uid(req)]);
    res.json({ policies: r.rows, defaults: rateLimiter.CODE_DEFAULTS, unknownServiceDefault: rateLimiter.UNKNOWN_DEFAULT });
  }));
  router.put('/rate-policies', wrap(async (req, res) => {
    const row = await rateLimiter.setTenantPolicy(pool, uid(req), req.body || {}, uid(req));
    await store.audit(pool, { userId: uid(req), actor: `user:${uid(req)}`, action: 'RATE_POLICY_SET', detail: { scope: row.scope, key: row.scope_key, perMinute: row.per_minute, perHour: row.per_hour, perDay: row.per_day } });
    res.json(row);
  }));

  // ------------------------------------------------------------ events
  router.post('/events', wrap(async (req, res) => res.json(await events.ingestEvent(pool, uid(req), { ...(req.body || {}), source: `api:${String(req.body?.source || 'manual').slice(0, 40)}` }))));
  router.post('/replies', wrap(async (req, res) => res.json(await events.ingestReply(pool, uid(req), { ...(req.body || {}), source: 'api' }))));
  router.get('/replies', wrap(async (req, res) => {
    const r = await pool.query(
      `SELECT r.id, r.classification, r.subject, r.snippet, r.needs_attention, r.handled_at, r.received_at, r.campaign_id, c.full_name, c.email, co.name AS company
         FROM outbound_replies r LEFT JOIN outbound_contacts c ON c.id=r.contact_id AND c.user_id=r.user_id LEFT JOIN outbound_companies co ON co.id=c.company_id AND co.user_id=c.user_id
        WHERE r.user_id=$1 ORDER BY r.needs_attention DESC, r.received_at DESC LIMIT 200`, [uid(req)]);
    res.json({ replies: r.rows });
  }));
  router.post('/replies/:id/handled', wrap(async (req, res) => {
    if (!isUuid(req.params.id)) throw bad('bad id');
    const r = await pool.query('UPDATE outbound_replies SET needs_attention=FALSE, handled_at=NOW(), handled_by=$2 WHERE id=$1 AND user_id=$2 RETURNING id', [req.params.id, uid(req)]);
    if (!r.rowCount) throw Object.assign(new Error('reply not found'), { status: 404 });
    res.json({ id: req.params.id, handled: true });
  }));

  // ------------------------------------------------------------ learning
  router.get('/metrics', wrap(async (req, res) => res.json(await metrics.campaignMetrics(pool, uid(req), isUuid(req.query.campaignId) ? req.query.campaignId : null))));
  router.get('/segments', wrap(async (req, res) => res.json(await metrics.segmentPerformance(pool, uid(req), isUuid(req.query.campaignId) ? req.query.campaignId : null))));
  router.get('/learnings', wrap(async (req, res) => res.json(await metrics.learnings(pool, uid(req), isUuid(req.query.campaignId) ? req.query.campaignId : null))));
  router.get('/audit', wrap(async (req, res) => {
    const r = await pool.query('SELECT id, actor, action, campaign_id, contact_id, job_id, message_id, detail, correlation_id, at FROM outbound_audit WHERE user_id=$1 ORDER BY at DESC LIMIT 300', [uid(req)]);
    res.json({ audit: r.rows });
  }));

  return router;
}

module.exports = { outreachRouter };
