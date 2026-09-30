'use strict';
// lib/routes/clientApi.js — the API the Starlane desktop and mobile apps are
// built on. Web keeps working unchanged; these are additive.
//
// Auth (native sessions, lib/auth/sessions.js):
//   POST   /api/auth/native/login     { email, password, client, platform, deviceName, appVersion }
//   POST   /api/auth/native/refresh   { refreshToken }         (rotates)
//   POST   /api/auth/native/logout    { refreshToken? }        (revokes this session)
//   GET    /api/auth/sessions                                   (signed-in devices)
//   DELETE /api/auth/sessions/:id                               (sign a device out)
// Client (Bearer access token):
//   GET    /api/client/bootstrap      account, organization, capabilities, versions
//   GET    /api/client/now?since=     what changed / what needs you / what Starlane is doing
//   GET    /api/client/actions?status= actions list (pending by default)
//   GET    /api/client/actions/:id    one action with its evidence
//   POST   /api/client/actions/:id/decision  { decision: approve|reject, confirmHighRisk }
//   GET    /api/client/inbox          canonical notifications
//   POST   /api/client/inbox/:id/read | /api/client/inbox/read-all
//   POST   /api/client/push-devices   { token, platform, deviceName }   (Expo)
//   DELETE /api/client/push-devices/:id
//   POST   /api/client/telemetry      { events: [{ name, props }] }  (allowlisted, no content)

const express = require('express');
const rateLimit = require('express-rate-limit');
const { guardRouter } = require('./guardAsync');
const bcrypt = require('bcryptjs');
const sessions = require('../auth/sessions');
const { track, EVENTS, cleanProps } = require('../observability/productEvents');
const { shape: shapeNotification } = require('../notifications/notify');
const { getConnectorStates } = require('../connectors/state');
const { deploymentEnv } = require('../config/deployEnv');
const { lifecycleOf, OPEN_SQL, OPEN_AMOUNT_SQL, LIVE_OVERDUE_SQL } = require('../features/core');
const { missionHoldsDecision } = require('./features');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLIENT_EVENTS = new Set([
  'client.app_started', 'client.app_crashed', 'client.startup_failed', 'client.screen_opened',
  'client.connector_setup_started', 'client.connector_setup_completed', 'client.connector_setup_failed',
  'client.local_sync_succeeded', 'client.local_sync_failed', 'client.opening_bills_failed', 'client.recommendation_opened', 'client.evidence_opened',
  'client.approval_completed', 'client.update_available', 'client.update_installed', 'client.update_failed',
  'client.notification_opened', 'client.ask_submitted', 'client.offline', 'client.session_expired',
]);
const CLIENT_PROPS = new Set(['screen', 'client', 'platform', 'app_version', 'os_version', 'error_code', 'duration_ms', 'connector', 'channel', 'reason', 'online']);

function actionSummary(a) {
  const lc = lifecycleOf(a);
  return {
    lifecycle: lc.state, lifecycleNote: lc.note, canDecide: lc.canDecide, missionId: a.mission_id || null,
    id: a.id, type: a.action_type, title: a.title, description: a.description, status: a.status,
    priority: a.priority, riskLevel: a.risk_level, requiresApproval: !!a.requires_approval,
    createdAt: a.created_at, updatedAt: a.updated_at,
  };
}

// Evidence, presented for a person: every fact labelled with what kind of
// fact it is. Only reads what the recommending code recorded (reason_json).
function evidenceOf(a) {
  const r = a.reason_json || {};
  const facts = [];
  const label = (key) => key.replace(/_/g, ' ');
  if (r.facts && typeof r.facts === 'object') {
    for (const [k, v] of Object.entries(r.facts)) {
      if (v === null || v === undefined) continue;
      facts.push({ label: label(k), value: v, kind: k === 'days_overdue' ? 'calculated' : 'observed', source: r.source?.table || null });
    }
  }
  return {
    rule: r.rule || null,
    source: r.source || null,
    computedAt: r.computed_at || a.created_at,
    facts,
    stage: r.stage || null,
    adjustments: r.adjustments || null,
    raw: Object.keys(r).length ? r : null,
    hasStructuredEvidence: facts.length > 0,
  };
}

function clientApiRouter({ pool, authMiddleware, executeApprovedAction }) {
  // Every route below answers 500 with a reference (and is logged) instead of hanging.
  const router = guardRouter(express.Router());
  const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many sign-in attempts. Try again in a few minutes.' } });
  const telemetryLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false });

  // ── Native auth ───────────────────────────────────────────────────────
  router.post('/auth/native/login', loginLimiter, async (req, res) => {
    const { email, password, client, platform, deviceName, appVersion } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    try {
      const { rows } = await pool.query('SELECT id, email, business_name, password_hash FROM users WHERE lower(email) = lower($1) LIMIT 1', [String(email).trim()]);
      const user = rows[0];
      const ok = user && await bcrypt.compare(String(password), user.password_hash || '');
      if (!ok) return res.status(401).json({ error: 'Invalid email or password' });
      const s = await sessions.createSession(pool, user, { client, platform, deviceName, appVersion });
      track('auth.native_login', { req, userId: user.id, props: { client, platform, app_version: appVersion } });
      res.json({ success: true, ...s, user: { id: user.id, email: user.email, businessName: user.business_name } });
    } catch (e) {
      console.error('[native login]', e.message);
      res.status(500).json({ error: 'Sign-in failed. Try again.' });
    }
  });

  router.post('/auth/native/refresh', loginLimiter, async (req, res) => {
    try {
      const s = await sessions.refreshSession(pool, req.body?.refreshToken, { appVersion: req.body?.appVersion });
      res.json({ success: true, ...s });
    } catch (e) {
      if (e instanceof sessions.SessionError) return res.status(401).json({ error: e.message, code: 'SESSION_INVALID' });
      console.error('[native refresh]', e.message);
      res.status(503).json({ error: 'Could not refresh the session' });
    }
  });

  router.post('/auth/native/logout', authMiddleware, async (req, res) => {
    if (req.user.sid) await sessions.revokeFamily(pool, req.user.userId, req.user.sid);
    await pool.query('UPDATE push_devices SET disabled_at = now() WHERE session_id = $1', [req.user.sid || null]).catch(() => {});
    res.json({ success: true });
  });

  router.get('/auth/sessions', authMiddleware, async (req, res) => {
    const list = await sessions.listSessions(pool, req.user.userId);
    res.json({ success: true, sessions: list.map((s) => ({ ...s, current: s.id === req.user.sid })) });
  });

  router.delete('/auth/sessions/:id', authMiddleware, async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Session not found' });
    const ok = await sessions.revokeFamily(pool, req.user.userId, req.params.id);
    if (!ok) return res.status(404).json({ error: 'Session not found' });
    await pool.query('UPDATE push_devices SET disabled_at = now() WHERE session_id = $1 AND user_id = $2', [req.params.id, req.user.userId]).catch(() => {});
    res.json({ success: true });
  });

  // ── Bootstrap ─────────────────────────────────────────────────────────
  router.get('/client/bootstrap', authMiddleware, async (req, res) => {
    try {
      const userId = req.user.userId;
      const u = (await pool.query('SELECT id, email, business_name, owner_name, created_at FROM users WHERE id = $1', [userId])).rows[0];
      const { getOrCreateOrganizationContext } = require('../domain/globalContext/organization');
      let org = null;
      try { org = await getOrCreateOrganizationContext(userId); } catch { org = null; }
      const { isEnabled } = require('../featureFlags');
      res.json({
        success: true,
        apiVersion: 1,
        env: deploymentEnv(),
        serverTime: new Date().toISOString(),
        minClientVersion: { desktop: process.env.MIN_DESKTOP_VERSION || '0.1.0', mobile: process.env.MIN_MOBILE_VERSION || '0.1.0' },
        user: u && { id: u.id, email: u.email, name: u.owner_name || null },
        organization: org
          ? { id: org.id, name: org.display_name || u?.business_name || null, country: org.home_country, currency: org.base_currency, industry: org.industry }
          : { id: null, name: u?.business_name || null },
        // Organizations are one-per-account today (organizations.owner_user_id is unique).
        organizationsAvailable: 1,
        capabilities: {
          askStarlane: Boolean(process.env.GROQ_API_KEY || process.env.GEMINI_API_KEY),
          externalMessaging: isEnabled('external_message_sending_enabled'),
          pushNotifications: true,
        },
      });
    } catch (e) {
      console.error('[client bootstrap]', e.message);
      res.status(500).json({ error: 'Could not load your account' });
    }
  });

  // ── Now ───────────────────────────────────────────────────────────────
  router.get('/client/now', authMiddleware, async (req, res) => {
    const userId = req.user.userId;
    const maxBack = Date.now() - 7 * 86400000;
    let since = Date.parse(req.query.since || '');
    if (!Number.isFinite(since) || since < maxBack) since = Date.now() - 86400000;
    const sinceIso = new Date(since).toISOString();
    try {
      const q = (sql, params) => pool.query(sql, params).then((r) => r.rows).catch((e) => { console.error('[client now]', e.message); return null; });
      const pending = await q(
        `SELECT * FROM ai_actions WHERE user_id = $1 AND status = 'pending'
          ORDER BY requires_approval DESC, CASE risk_level WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, created_at DESC LIMIT 20`, [userId]);
      const newRecs = await q(`SELECT id, title, action_type, created_at FROM ai_actions WHERE user_id = $1 AND created_at > $2 ORDER BY created_at DESC LIMIT 10`, [userId, sinceIso]);
      const triggered = await q(
        `SELECT w.id AS watch_id, w.name, w.severity, e.evaluated_at FROM watch_evaluations e JOIN watches w ON w.id = e.watch_id
          WHERE e.user_id = $1 AND e.triggered AND e.evaluated_at > $2 ORDER BY e.evaluated_at DESC LIMIT 10`, [userId, sinceIso]);
      const signals = await q(
        `SELECT bs.id, COALESCE(we.title, bs.status) AS title, bs.last_updated_at FROM business_signals bs LEFT JOIN world_events we ON we.id = bs.world_event_id
          WHERE bs.user_id = $1 AND bs.last_updated_at > $2 ORDER BY bs.last_updated_at DESC LIMIT 10`, [userId, sinceIso]);
      const syncs = await q(
        `SELECT COUNT(*)::int AS runs, COALESCE(SUM(records_imported),0)::int AS imported, MAX(finished_at) AS last_at
           FROM connector_sync_runs WHERE user_id = $1 AND status = 'succeeded' AND finished_at > $2`, [userId, sinceIso]);
      const outcomes = await q(
        `SELECT o.action_id, o.status, o.verified_at, a.title FROM action_outcomes o JOIN ai_actions a ON a.id = o.action_id
          WHERE o.user_id = $1 AND o.verified_at > $2 ORDER BY o.verified_at DESC LIMIT 10`, [userId, sinceIso]);
      const done = await q(
        `SELECT id, title, status, completed_at, updated_at FROM ai_actions WHERE user_id = $1 AND status IN ('done','failed') AND updated_at > $2
          ORDER BY updated_at DESC LIMIT 10`, [userId, sinceIso]);
      const receivables = await q(
        `SELECT COUNT(*)::int AS open_count, COALESCE(SUM(${OPEN_AMOUNT_SQL}),0)::numeric AS open_total,
                COALESCE(SUM(${OPEN_AMOUNT_SQL}) FILTER (WHERE ${LIVE_OVERDUE_SQL} > 0),0)::numeric AS overdue_total,
                COUNT(*) FILTER (WHERE ${LIVE_OVERDUE_SQL} > 30)::int AS over_30_count
           FROM invoices WHERE user_id = $1 AND ${OPEN_SQL}`, [userId]);
      const connectors = await getConnectorStates(pool, userId).catch(() => []);

      const changed = [
        ...(newRecs || []).map((a) => ({ kind: 'recommendation', title: a.title, at: a.created_at, route: `/actions/${a.id}` })),
        ...(triggered || []).map((t) => ({ kind: 'watch', title: `Watch triggered: ${t.name}`, severity: t.severity, at: t.evaluated_at, route: `/watch/${t.watch_id}` })),
        ...(signals || []).map((s) => ({ kind: 'signal', title: s.title, at: s.last_updated_at, route: `/discover/${s.id}` })),
        ...(outcomes || []).map((o) => ({ kind: 'outcome', title: `Result checked: ${o.title}`, status: o.status, at: o.verified_at, route: `/actions/${o.action_id}` })),
        ...(done || []).map((d) => ({ kind: d.status === 'done' ? 'action_done' : 'action_failed', title: d.title, at: d.updated_at, route: `/actions/${d.id}` })),
      ].sort((a, b) => new Date(b.at) - new Date(a.at));

      const bridge = connectors.find((c) => c.id === 'tally');
      const lastData = connectors.map((c) => c.state?.lastSuccessAt || null).filter(Boolean).sort().pop() || null;
      const r = receivables?.[0];
      res.json({
        success: true,
        generatedAt: new Date().toISOString(),
        since: sinceIso,
        dataAsOf: lastData,
        needsYou: (pending || []).map(actionSummary),
        changed,
        working: {
          connectors: connectors.filter((c) => c.availability === 'available' && c.authType !== 'public_feed')
            .map((c) => ({ id: c.id, name: c.name, health: c.state.health, lastSuccessAt: c.state.lastSuccessAt || null, lastAttempt: c.state.lastAttempt || null })),
          syncsSince: syncs?.[0] || null,
        },
        state: r ? {
          currency: 'INR',
          openReceivables: Number(r.open_total), overdueReceivables: Number(r.overdue_total),
          openInvoiceCount: r.open_count, over30Count: r.over_30_count,
          source: bridge && bridge.state.health !== 'not_connected' ? 'tally' : 'imported_or_manual',
        } : null,
        partial: [pending, newRecs, triggered, signals, syncs, outcomes, done, receivables].some((x) => x === null),
      });
    } catch (e) {
      console.error('[client now]', e.message);
      res.status(500).json({ error: 'Could not load Now' });
    }
  });

  // ── Actions ───────────────────────────────────────────────────────────
  router.get('/client/actions', authMiddleware, async (req, res) => {
    const allowed = ['pending', 'approved', 'done', 'failed', 'rejected', 'executing'];
    const status = allowed.includes(req.query.status) ? req.query.status : 'pending';
    const { rows } = await pool.query(
      `SELECT * FROM ai_actions WHERE user_id = $1 AND status = $2 ORDER BY created_at DESC LIMIT 100`, [req.user.userId, status]);
    res.json({ success: true, actions: rows.map(actionSummary) });
  });

  router.get('/client/actions/:id', authMiddleware, async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Action not found' });
    const { rows } = await pool.query('SELECT * FROM ai_actions WHERE id = $1 AND user_id = $2', [req.params.id, req.user.userId]);
    const a = rows[0];
    if (!a) return res.status(404).json({ error: 'Action not found' });
    const outcomes = (await pool.query(
      `SELECT verification_type, expected_metric, expected_value, observed_metric, observed_value, status, verified_at FROM action_outcomes WHERE action_id = $1 AND user_id = $2 ORDER BY created_at`,
      [a.id, req.user.userId]).catch(() => ({ rows: [] }))).rows;
    track(EVENTS.EVIDENCE_VIEWED, { req, actionId: a.id, props: { action_type: a.action_type } });
    res.json({
      success: true,
      action: {
        ...actionSummary(a),
        ...(() => { const lc = lifecycleOf(a, outcomes); return { lifecycle: lc.state, lifecycleNote: lc.note, canDecide: lc.canDecide }; })(),
        // What exactly will happen if approved (frozen at proposal).
        proposal: { message: a.recommended_message || null, parameters: a.parameters || null, expectedEffect: a.expected_effect || null },
        system: a.related_entity_type ? { type: a.related_entity_type, id: a.related_entity_id } : null,
        risks: [
          a.risk_level === 'high' ? 'High-risk action: confirm deliberately.' : null,
          a.recommended_message ? 'Sends a message to a customer when external messaging is enabled.' : null,
          a.block_reason ? `Policy note: ${a.block_reason}` : null,
        ].filter(Boolean),
        evidence: evidenceOf(a),
        outcomes,
        lastError: a.last_execution_error || null,
      },
    });
  });

  // One decision per action: atomic pending -> approved|rejected claim, then
  // (for approve) the shared executor. Repeats get 409 with the current state.
  router.post('/client/actions/:id/decision', authMiddleware, async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Action not found' });
    const { decision, confirmHighRisk } = req.body || {};
    if (!['approve', 'reject'].includes(decision)) return res.status(400).json({ error: 'decision must be approve or reject' });
    const userId = req.user.userId;
    const cur = (await pool.query('SELECT id, status, risk_level, requires_approval, mission_id FROM ai_actions WHERE id = $1 AND user_id = $2', [req.params.id, userId])).rows[0];
    if (!cur) return res.status(404).json({ error: 'Action not found' });
    if (decision === 'approve') {
      const held = await missionHoldsDecision(pool, userId, cur.mission_id);
      if (held) return res.status(409).json({ error: held, code: 'MISSION_NOT_ACTIVE' });
    }
    if (decision === 'approve' && cur.risk_level === 'high' && confirmHighRisk !== true) {
      return res.status(428).json({ error: 'This is a high-risk action. Confirm it explicitly.', code: 'CONFIRM_HIGH_RISK' });
    }
    const to = decision === 'approve' ? 'approved' : 'rejected';
    const { rows } = await pool.query(
      `UPDATE ai_actions SET status = $3, updated_at = now(), approved_by = CASE WHEN $3 = 'approved' THEN $2::uuid ELSE approved_by END,
              approved_at = CASE WHEN $3 = 'approved' THEN now() ELSE approved_at END
        WHERE id = $1 AND user_id = $2 AND status = 'pending' RETURNING *`,
      [req.params.id, userId, to]);
    if (!rows.length) {
      const now = (await pool.query('SELECT status FROM ai_actions WHERE id = $1 AND user_id = $2', [req.params.id, userId])).rows[0];
      return res.status(409).json({ error: `Already decided (${now?.status})`, status: now?.status });
    }
    const action = rows[0];
    await pool.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, old_value_json, new_value_json) VALUES ($1, $2, 'ai_action', $3, $4, $5)`,
      [userId, `ai_action_${to}`, action.id, JSON.stringify({ status: 'pending' }), JSON.stringify({ status: to, via: req.body?.via || 'client' })],
    ).catch((e) => console.error('[client decision audit]', e.message));
    track(EVENTS.APPROVAL_COMPLETED, { req, actionId: action.id, props: { decision: to, via: 'client', action_type: action.action_type } });
    if (to === 'rejected') return res.json({ success: true, status: 'rejected' });
    const result = await executeApprovedAction(action, { source: 'client' });
    res.json({ success: true, status: result.paused ? 'approved' : result.ok ? 'done' : 'failed', message: result.message });
  });

  // ── Inbox ─────────────────────────────────────────────────────────────
  router.get('/client/inbox', authMiddleware, async (req, res) => {
    const unreadOnly = req.query.unread === '1';
    const { rows } = await pool.query(
      `SELECT * FROM notification_events WHERE user_id = $1 ${unreadOnly ? 'AND read_at IS NULL' : ''} ORDER BY created_at DESC LIMIT 100`, [req.user.userId]);
    const unread = (await pool.query('SELECT COUNT(*)::int n FROM notification_events WHERE user_id = $1 AND read_at IS NULL', [req.user.userId])).rows[0].n;
    res.json({ success: true, unread, notifications: rows.map(shapeNotification) });
  });
  router.post('/client/inbox/read-all', authMiddleware, async (req, res) => {
    await pool.query('UPDATE notification_events SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [req.user.userId]);
    res.json({ success: true });
  });
  router.post('/client/inbox/:id/read', authMiddleware, async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const { rowCount } = await pool.query('UPDATE notification_events SET read_at = COALESCE(read_at, now()) WHERE id = $1 AND user_id = $2', [req.params.id, req.user.userId]);
    if (!rowCount) return res.status(404).json({ error: 'Not found' });
    track('client.notification_opened', { req, props: {} });
    res.json({ success: true });
  });

  // ── Push devices ──────────────────────────────────────────────────────
  router.post('/client/push-devices', authMiddleware, async (req, res) => {
    const { token, platform, deviceName } = req.body || {};
    if (typeof token !== 'string' || !/^(ExponentPushToken|ExpoPushToken)\[[^\]]{10,}\]$/.test(token)) {
      return res.status(400).json({ error: 'Expected an Expo push token' });
    }
    const { rows } = await pool.query(
      `INSERT INTO push_devices (user_id, provider, token, platform, device_name, session_id)
       VALUES ($1, 'expo', $2, $3, $4, $5)
       ON CONFLICT (provider, token) DO UPDATE SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform, device_name = EXCLUDED.device_name,
         session_id = EXCLUDED.session_id, last_seen_at = now(), disabled_at = NULL
       RETURNING id`,
      [req.user.userId, token, String(platform || '').slice(0, 20) || null, String(deviceName || '').slice(0, 120) || null, req.user.sid || null]);
    res.status(201).json({ success: true, id: rows[0].id });
  });
  router.delete('/client/push-devices/:id', authMiddleware, async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Not found' });
    await pool.query('UPDATE push_devices SET disabled_at = now() WHERE id = $1 AND user_id = $2', [req.params.id, req.user.userId]);
    res.json({ success: true });
  });

  // ── Telemetry (product behaviour only; never content) ─────────────────
  router.post('/client/telemetry', telemetryLimiter, (req, res, next) => {
    // Optional auth: app_started/startup_failed can happen before sign-in.
    if (req.headers.authorization) return authMiddleware(req, res, next);
    next();
  }, (req, res) => {
    const events = Array.isArray(req.body?.events) ? req.body.events.slice(0, 50) : [];
    let accepted = 0;
    for (const e of events) {
      if (!e || !CLIENT_EVENTS.has(e.name)) continue;
      const props = {};
      for (const [k, v] of Object.entries(e.props || {})) if (CLIENT_PROPS.has(k) && (typeof v !== 'object' || v === null)) props[k] = v;
      // Map allowlisted client props onto the event store's allowlist.
      track(e.name, { req, props: cleanProps({ ...props, platform: props.platform, client_version: props.app_version, reason: props.reason || props.screen || props.error_code, via: props.client, kind: props.connector, duration_ms: props.duration_ms }) });
      accepted++;
    }
    res.status(202).json({ success: true, accepted });
  });

  return router;
}

module.exports = { clientApiRouter, evidenceOf };
