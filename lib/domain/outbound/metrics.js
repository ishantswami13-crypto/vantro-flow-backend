'use strict';
// lib/domain/outbound/metrics.js
// Operational numbers only: funnel counts, delivery health, segment
// performance with sample sizes, learnings as suggestions, and the
// "Outreach ready" status panel. Opens and clicks are not tracked (Gmail
// does not report them and tracking pixels hurt deliverability), so they are
// never shown.

const { regionOf, resolveTimeZone, inWindow, nextWindowStart, REGIONS } = require('./localTime');
const { emailLimits, budgetView } = require('./rateLimiter');
const controls = require('./controls');

const MIN_SEGMENT_SAMPLE = 20;

async function campaignMetrics(db, userId, campaignId = null) {
  const p = campaignId ? [userId, campaignId] : [userId];
  const cf = campaignId ? 'AND campaign_id = $2' : '';
  const r = await db.query(
    `SELECT
       (SELECT COUNT(*)::int FROM outbound_enrollments WHERE user_id=$1 ${cf} AND status IN ('ENROLLED','DRAFTED','APPROVED')) AS eligible_pipeline,
       (SELECT COUNT(*)::int FROM outbound_messages WHERE user_id=$1 ${cf} AND review_status='PENDING_REVIEW') AS awaiting_review,
       (SELECT COUNT(*)::int FROM outbound_send_jobs WHERE user_id=$1 ${cf} AND status IN ('QUEUED','RESERVED','SENDING','RETRY_WAIT')) AS queued,
       (SELECT COUNT(*)::int FROM outbound_send_jobs WHERE user_id=$1 ${cf} AND status='SENT') AS sent,
       (SELECT COUNT(*)::int FROM outbound_send_jobs WHERE user_id=$1 ${cf} AND status='SENT' AND mode='SHADOW') AS sent_shadow,
       (SELECT COUNT(*)::int FROM outbound_send_jobs WHERE user_id=$1 ${cf} AND status='FAILED') AS dead_letter,
       (SELECT COUNT(*)::int FROM outbound_send_jobs WHERE user_id=$1 ${cf} AND status='AMBIGUOUS') AS ambiguous,
       (SELECT COUNT(DISTINCT contact_id)::int FROM outbound_replies WHERE user_id=$1 ${cf} AND classification <> 'AUTO_REPLY') AS replied,
       (SELECT COUNT(DISTINCT contact_id)::int FROM outbound_replies WHERE user_id=$1 ${cf} AND classification IN ('INTERESTED','MEETING')) AS interested,
       (SELECT COUNT(DISTINCT contact_id)::int FROM outbound_replies WHERE user_id=$1 ${cf} AND classification='MEETING') AS meetings,
       (SELECT COUNT(*)::int FROM outbound_delivery_events WHERE user_id=$1 ${cf} AND event_type='BOUNCED') AS bounced,
       (SELECT COUNT(*)::int FROM outbound_delivery_events WHERE user_id=$1 ${cf} AND event_type='BOUNCED' AND bounce_class='HARD') AS hard_bounced,
       (SELECT COUNT(*)::int FROM outbound_delivery_events WHERE user_id=$1 ${cf} AND (event_type='BLOCKED' OR bounce_class='BLOCK')) AS blocked,
       (SELECT COUNT(*)::int FROM outbound_delivery_events WHERE user_id=$1 ${cf} AND event_type='COMPLAINT') AS complaints,
       (SELECT COUNT(*)::int FROM outbound_delivery_events WHERE user_id=$1 ${cf} AND event_type='PROVIDER_ERROR' AND occurred_at >= NOW() - INTERVAL '24 hours') AS provider_errors_24h,
       (SELECT COUNT(*)::int FROM outbound_send_jobs WHERE user_id=$1 ${cf} AND status='SENT' AND sent_at >= NOW() - INTERVAL '1 hour') AS sent_last_hour,
       (SELECT COUNT(*)::int FROM outbound_enrollments WHERE user_id=$1 ${cf} AND status='EXCLUDED') AS excluded,
       (SELECT COALESCE(SUM(amount_usd),0)::float FROM outbound_costs WHERE user_id=$1 ${cf}) AS cost_usd`,
    p
  );
  const m = r.rows[0];
  const pct = (a, b) => (b ? Math.round((1000 * a) / b) / 10 : null);
  const suppressed = (await db.query('SELECT COUNT(*)::int AS n FROM outbound_suppressions WHERE user_id=$1', [userId])).rows[0].n;
  return {
    ...m,
    suppressed,
    health: {
      bouncePct: pct(m.bounced, m.sent), hardBouncePct: pct(m.hard_bounced, m.sent), blockPct: pct(m.blocked, m.sent),
      replyPct: pct(m.replied, m.sent), providerErrors24h: m.provider_errors_24h, sendVelocityPerHour: m.sent_last_hour,
      note: m.sent < MIN_SEGMENT_SAMPLE ? `Only ${m.sent} send(s) so far; rates are not meaningful below ${MIN_SEGMENT_SAMPLE}.` : null,
    },
  };
}

/**
 * Reply and qualified-reply rates per segment, only for segments with at
 * least MIN_SEGMENT_SAMPLE sends. Smaller segments are listed as
 * "insufficient sample" rather than given a rate.
 */
async function segmentPerformance(db, userId, campaignId = null) {
  const p = campaignId ? [userId, campaignId] : [userId];
  const cf = campaignId ? 'AND j.campaign_id = $2' : '';
  const r = await db.query(
    `SELECT COALESCE(co.industry,'unknown') AS industry, COALESCE(c.country,'unknown') AS country, COALESCE(co.size_band,'unknown') AS size_band,
            CASE WHEN c.role_title ~* '(operations|supply|coo|plant|logistics|procurement)' THEN 'operations'
                 WHEN c.role_title ~* '(cfo|finance|controller|treasur)' THEN 'finance'
                 WHEN c.role_title ~* '(cio|cto|it |technology|digital)' THEN 'technology'
                 WHEN c.role_title ~* '(ceo|founder|owner|managing director|president)' THEN 'executive'
                 ELSE 'other' END AS role_group,
            COALESCE(m.variant_key, m.template_version) AS message_version, m.subject_pattern,
            (SELECT COUNT(*) FROM outbound_replies r WHERE r.user_id=j.user_id AND r.contact_id=j.contact_id AND r.classification <> 'AUTO_REPLY') > 0 AS replied,
            (SELECT COUNT(*) FROM outbound_replies r WHERE r.user_id=j.user_id AND r.contact_id=j.contact_id AND r.classification IN ('INTERESTED','MEETING')) > 0 AS qualified
       FROM outbound_send_jobs j
       JOIN outbound_contacts c ON c.id=j.contact_id AND c.user_id=j.user_id
       LEFT JOIN outbound_companies co ON co.id=c.company_id AND co.user_id=c.user_id
       JOIN outbound_messages m ON m.id=j.message_id AND m.step=0
      WHERE j.user_id=$1 ${cf} AND j.status='SENT' AND j.mode <> 'SHADOW'`,
    p
  );
  const dims = ['industry', 'role_group', 'country', 'size_band', 'message_version', 'subject_pattern'];
  const out = {};
  for (const d of dims) {
    const groups = {};
    for (const row of r.rows) {
      const k = row[d] || 'unknown';
      groups[k] = groups[k] || { sent: 0, replied: 0, qualified: 0 };
      groups[k].sent += 1; if (row.replied) groups[k].replied += 1; if (row.qualified) groups[k].qualified += 1;
    }
    out[d] = Object.entries(groups).map(([k, g]) => (g.sent >= MIN_SEGMENT_SAMPLE
      ? { segment: k, sent: g.sent, replyRate: g.replied / g.sent, qualifiedRate: g.qualified / g.sent }
      : { segment: k, sent: g.sent, insufficientSample: true }));
  }
  return { minSample: MIN_SEGMENT_SAMPLE, totalLiveSends: r.rows.length, segments: out };
}

// Two-proportion z-test, used only to decide whether a difference is worth
// suggesting. Suggestions never change a campaign by themselves.
function zTest(a, b) {
  const p = (a.q + b.q) / (a.n + b.n);
  const se = Math.sqrt(p * (1 - p) * (1 / a.n + 1 / b.n));
  return se ? (a.q / a.n - b.q / b.n) / se : 0;
}

async function learnings(db, userId, campaignId = null) {
  const perf = await segmentPerformance(db, userId, campaignId);
  const suggestions = [];
  for (const [dim, rows] of Object.entries(perf.segments)) {
    const ok = rows.filter((x) => !x.insufficientSample);
    for (let i = 0; i < ok.length; i += 1) {
      for (let j = 0; j < ok.length; j += 1) {
        if (i === j) continue;
        const a = { n: ok[i].sent, q: Math.round(ok[i].qualifiedRate * ok[i].sent) };
        const b = { n: ok[j].sent, q: Math.round(ok[j].qualifiedRate * ok[j].sent) };
        const z = zTest(a, b);
        if (z > 1.96 && a.q >= 3) {
          suggestions.push({
            dimension: dim, better: ok[i].segment, worse: ok[j].segment,
            text: `${dim.replace('_', ' ')} "${ok[i].segment}" got qualified replies at ${(100 * a.q / a.n).toFixed(1)}% (${a.q}/${a.n}) vs "${ok[j].segment}" at ${(100 * b.q / b.n).toFixed(1)}% (${b.q}/${b.n}).`,
            evidence: { a, b, z: Math.round(z * 100) / 100 }, action: 'suggestion only; nothing was changed',
          });
        }
      }
    }
  }
  const objections = await db.query(
    `SELECT classification, COUNT(*)::int AS n FROM outbound_replies WHERE user_id=$1 ${campaignId ? 'AND campaign_id=$2' : ''} GROUP BY classification ORDER BY n DESC`,
    campaignId ? [userId, campaignId] : [userId]
  );
  return { suggestions, replyMix: objections.rows, minSample: perf.minSample, totalLiveSends: perf.totalLiveSends, note: suggestions.length ? null : `No difference is supported by the data yet (needs ${perf.minSample}+ live sends per segment and a significant gap).` };
}

async function nextActiveMarket(db, userId, now = new Date()) {
  const r = await db.query(
    `SELECT DISTINCT c.timezone, c.country, cp.send_window FROM outbound_send_jobs j JOIN outbound_contacts c ON c.id=j.contact_id AND c.user_id=j.user_id
       JOIN outbound_campaigns cp ON cp.id=j.campaign_id AND cp.user_id=j.user_id
      WHERE j.user_id=$1 AND j.status IN ('QUEUED','RETRY_WAIT') LIMIT 200`,
    [userId]
  );
  let open = null; let next = null;
  for (const row of r.rows) {
    const { tz } = resolveTimeZone(row);
    if (!tz) continue;
    const reg = regionOf(tz);
    if (inWindow(now, tz, row.send_window)) { open = open || reg.label; continue; }
    const n = nextWindowStart(now, tz, row.send_window);
    if (n && (!next || n < next.at)) next = { market: reg.label, at: n.toISOString() };
  }
  return { activeNow: open, next, rotation: REGIONS.map((x) => x.label) };
}

async function statusPanel(db, userId) {
  const ts = await controls.tenantState(db, userId);
  const gs = await controls.globalStop(db);
  const accounts = (await db.query(`SELECT id, provider, from_address, status, status_reason, daily_max, warmup_started_on, warmup_schedule, throttle_factor, last_success_at, last_poll_at, consecutive_errors, updated_at FROM outbound_provider_accounts WHERE user_id=$1 ORDER BY created_at`, [userId])).rows;
  const m = await campaignMetrics(db, userId);
  const attention = (await db.query(`SELECT COUNT(*)::int AS n FROM outbound_replies WHERE user_id=$1 AND needs_attention AND handled_at IS NULL`, [userId])).rows[0].n;
  const alerts = (await db.query(`SELECT kind, severity, message, created_at FROM outbound_alerts WHERE (user_id=$1 OR user_id IS NULL) AND resolved_at IS NULL ORDER BY created_at DESC LIMIT 10`, [userId])).rows;
  const lastSent = (await db.query(`SELECT MAX(sent_at) AS at FROM outbound_send_jobs WHERE user_id=$1 AND status='SENT'`, [userId])).rows[0].at;
  const campaigns = (await db.query(`SELECT id, name, status, status_reason, daily_budget, goal, goal_target FROM outbound_campaigns WHERE user_id=$1 AND status <> 'STOPPED' ORDER BY created_at DESC`, [userId])).rows;
  let budget = null;
  const active = campaigns.find((c) => c.status === 'ACTIVE');
  if (active) {
    const full = (await db.query('SELECT * FROM outbound_campaigns WHERE id=$1 AND user_id=$2', [active.id, userId])).rows[0];
    const acct = full.provider_account_id ? (await db.query('SELECT * FROM outbound_provider_accounts WHERE id=$1 AND user_id=$2', [full.provider_account_id, userId])).rows[0] : null;
    if (acct) {
      const specs = await emailLimits(db, { userId, account: acct, campaign: full, domain: '*' });
      budget = await budgetView(db, specs.filter((s) => s.scope !== 'DOMAIN'));
    }
  }
  const acctBudget = budget?.find((b) => b.scope === 'ACCOUNT');
  const ready = !gs.stopped && accounts.some((a) => ['HEALTHY', 'THROTTLED'].includes(a.status));
  return {
    headline: gs.stopped ? 'OUTREACH STOPPED (global stop)' : ts.engine_status === 'RUNNING' ? `OUTREACH RUNNING (${ts.mode})` : ready ? 'OUTREACH READY' : 'OUTREACH NOT READY',
    engine: { status: ts.engine_status, mode: ts.mode, startedAt: ts.started_at || null, reason: ts.status_reason || null },
    globalStop: gs,
    providers: accounts.map((a) => ({ id: a.id, provider: a.provider, fromAddress: a.from_address, status: a.status, reason: a.status_reason, dailyMax: a.daily_max, throttleFactor: Number(a.throttle_factor), lastSuccessAt: a.last_success_at, lastPollAt: a.last_poll_at })),
    eligibleTargets: m.eligible_pipeline,
    awaitingReview: m.awaiting_review,
    queued: m.queued,
    sent: m.sent,
    market: await nextActiveMarket(db, userId),
    sendRatePerHour: m.sent_last_hour,
    dailyRemaining: acctBudget ? acctBudget.remainingToday : null,
    dailyUsed: acctBudget ? acctBudget.usedToday : null,
    repliesNeedingAttention: attention,
    lastSuccessfulSend: lastSent,
    alerts,
    campaigns,
    budget,
    metrics: m,
  };
}

// Items for Prepared / Today / Watch, derived only (no new surface).
async function attentionItems(db, userId) {
  const replies = (await db.query(
    `SELECT r.id, r.classification, r.snippet, r.received_at, c.full_name, co.name AS company FROM outbound_replies r
       LEFT JOIN outbound_contacts c ON c.id=r.contact_id AND c.user_id=r.user_id LEFT JOIN outbound_companies co ON co.id=c.company_id AND co.user_id=c.user_id
      WHERE r.user_id=$1 AND r.needs_attention AND r.handled_at IS NULL ORDER BY (r.classification IN ('MEETING','INTERESTED')) DESC, r.received_at DESC LIMIT 20`,
    [userId]
  )).rows;
  const review = (await db.query(`SELECT COUNT(*)::int AS n FROM outbound_messages WHERE user_id=$1 AND review_status='PENDING_REVIEW'`, [userId])).rows[0].n;
  const paused = (await db.query(`SELECT id, name, status_reason FROM outbound_campaigns WHERE user_id=$1 AND status='PAUSED_AUTOMATICALLY'`, [userId])).rows;
  const alerts = (await db.query(`SELECT kind, severity, message FROM outbound_alerts WHERE user_id=$1 AND resolved_at IS NULL AND severity='CRITICAL' ORDER BY created_at DESC LIMIT 5`, [userId])).rows;
  return { replies, messagesAwaitingReview: review, blockedCampaigns: paused, criticalAlerts: alerts };
}

module.exports = { MIN_SEGMENT_SAMPLE, campaignMetrics, segmentPerformance, learnings, statusPanel, attentionItems, nextActiveMarket, zTest };
