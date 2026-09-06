// FILE: lib/services/orchestrator/revenueIntelligence.service.js
// STARLANE Phase 10 — Customer & Revenue Intelligence V1.
// Deterministic, explainable revenue-side customer intelligence, layered onto the
// existing payment-risk stack (customer_scores / customer_score_history /
// creditRiskAgent.classifyScoreTrajectory). No black box: every number ships with
// a plain-language evidence string. No new tables, no schema changes, no LLM.
//
// Canonical revenue source: `sales` ONLY (see STARLANE_PHASE_10_..._PLAN.md §6).
// `invoices` is the AR/collections source and must NEVER be summed with `sales`
// for a revenue figure — every `sales` row is mirrored into `invoices` with
// source_type='sales' (server.js syncReceivableFromSale()), so summing both
// double-counts. `invoices` is read here only for overdue/outstanding exposure.
//
// Dual-linking (Risk #1 in the plan, §24): a customer's sales rows may be linked
// either by `customer_id` (post migration-010) or only by `customer_name`/`phone`
// (legacy, pre-migration). Every aggregation below unions both paths for a given
// resolved customer identity, exactly like scoring.service.js / the
// /api/customers/intelligence handler already do for invoices.

const { supabase } = require('../../config/supabaseClient');
const { safeLog } = require('../../observability/logger');

const REVENUE_WINDOW_DAYS = 90;          // trailing window for value/concentration (plan §6)
const CONCENTRATION_RISK_THRESHOLD = 0.25; // >25% of tenant revenue (plan §8)
const MOMENTUM_MIN_ORDER_COUNT = 3;       // plan §7/§13.2 — avoid noise on thin history
const DORMANCY_MIN_ORDERS_FOR_AVG_GAP = 3;
const DORMANCY_FLAT_THRESHOLD_DAYS = 60;
const DORMANCY_MULTIPLIER = 2;
const HIGH_RISK_SCORE_THRESHOLD = 70;
const WATCH_RISK_SCORE_THRESHOLD = 40;

function daysAgoIso(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString();
}

function fmtInr(n) {
  return `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;
}

// ── Pure aggregation over already-fetched sales rows for ONE customer ───────
// `rows` = sales rows (amount, sale_date) already scoped to a single tenant and
// a single customer identity (union of customer_id-linked + name-linked rows,
// de-duplicated by id upstream). Returns { revenue, orderCount, aov }.
function aggregateSales(rows) {
  const orderCount = rows.length;
  const revenue = rows.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0);
  const aov = orderCount > 0 ? revenue / orderCount : 0;
  return { revenue, orderCount, aov };
}

// ── 13.1 Customer Value Summary ──────────────────────────────────────────────
// windowRows = this customer's sales rows within the trailing window.
function computeCustomerValue(windowRows, windowDays = REVENUE_WINDOW_DAYS) {
  const { revenue, orderCount, aov } = aggregateSales(windowRows);
  return {
    windowDays,
    revenue: Math.round(revenue),
    orderCount,
    aov: Math.round(aov),
    evidence: orderCount > 0
      ? `${fmtInr(revenue)} revenue across ${orderCount} order${orderCount === 1 ? '' : 's'} in the last ${windowDays} days (avg order ${fmtInr(aov)}).`
      : `No sales recorded in the last ${windowDays} days.`,
  };
}

// ── 13.2 Momentum Indicator ──────────────────────────────────────────────────
// currentWindowRows = trailing windowDays; priorWindowRows = the windowDays
// immediately before that (adjacent, non-overlapping).
function computeMomentum(currentWindowRows, priorWindowRows, windowDays = REVENUE_WINDOW_DAYS) {
  const cur = aggregateSales(currentWindowRows);
  const prior = aggregateSales(priorWindowRows);

  if (prior.orderCount < MOMENTUM_MIN_ORDER_COUNT) {
    return {
      status: 'INSUFFICIENT_HISTORY',
      current: cur,
      prior,
      changePct: null,
      evidence: `Not enough order history in the prior ${windowDays}-day period (${prior.orderCount} order${prior.orderCount === 1 ? '' : 's'}) to judge momentum.`,
    };
  }

  const changePct = prior.revenue > 0
    ? Math.round(((cur.revenue - prior.revenue) / prior.revenue) * 1000) / 10
    : (cur.revenue > 0 ? 100 : 0);

  const status = changePct > 0 ? 'GROWING' : changePct < 0 ? 'DECLINING' : 'FLAT';

  return {
    status,
    current: cur,
    prior,
    changePct,
    evidence: `${cur.orderCount} order${cur.orderCount === 1 ? '' : 's'} / ${fmtInr(cur.revenue)} in last ${windowDays} days vs ${prior.orderCount} order${prior.orderCount === 1 ? '' : 's'} / ${fmtInr(prior.revenue)} in prior ${windowDays} days (${changePct > 0 ? '+' : ''}${changePct}%).`,
  };
}

// ── 13.3 Revenue Concentration Flag ──────────────────────────────────────────
// customerRevenue = this customer's trailing-window revenue (already computed).
// tenantRevenue = SUM of ALL customers' trailing-window revenue for this owner.
function computeConcentration(customerRevenue, tenantRevenue, windowDays = REVENUE_WINDOW_DAYS) {
  const revenue = Math.round(Number(customerRevenue) || 0);
  const total = Number(tenantRevenue) || 0;
  const share = total > 0 ? revenue / total : 0;
  const sharePct = Math.round(share * 1000) / 10;
  const isConcentrationRisk = total > 0 && share > CONCENTRATION_RISK_THRESHOLD;

  return {
    share: Math.round(share * 1000) / 1000,
    sharePct,
    isConcentrationRisk,
    evidence: total > 0
      ? `${fmtInr(revenue)} of your ${fmtInr(total)} trailing-${windowDays}-day revenue (${sharePct}%) comes from this customer.`
      : `No tenant-wide revenue recorded in the last ${windowDays} days.`,
  };
}

// ── 13.4 Dormancy Flag ────────────────────────────────────────────────────────
// allRows = ALL of this customer's sales rows (not window-limited), each with
// a `sale_date`/`created_at`-derived timestamp, sorted ascending by date.
function computeDormancy(allRowsSortedAsc, now = new Date()) {
  if (!allRowsSortedAsc || allRowsSortedAsc.length === 0) {
    return { isDormant: false, daysSinceLastSale: null, avgGapDays: null, evidence: 'No sales history for this customer.' };
  }

  const dates = allRowsSortedAsc
    .map(r => new Date(r.sale_date || r.created_at))
    .filter(d => !isNaN(d.getTime()))
    .sort((a, b) => a - b);

  if (dates.length === 0) {
    return { isDormant: false, daysSinceLastSale: null, avgGapDays: null, evidence: 'No usable sale dates for this customer.' };
  }

  const lastDate = dates[dates.length - 1];
  const daysSinceLastSale = Math.floor((now.getTime() - lastDate.getTime()) / 86400000);

  let avgGapDays = null;
  if (dates.length >= DORMANCY_MIN_ORDERS_FOR_AVG_GAP) {
    const gaps = [];
    for (let i = 1; i < dates.length; i++) {
      gaps.push((dates[i] - dates[i - 1]) / 86400000);
    }
    avgGapDays = gaps.reduce((s, g) => s + g, 0) / gaps.length;
  }

  const threshold = avgGapDays !== null
    ? Math.max(DORMANCY_MULTIPLIER * avgGapDays, DORMANCY_FLAT_THRESHOLD_DAYS)
    : DORMANCY_FLAT_THRESHOLD_DAYS;

  const isDormant = daysSinceLastSale > threshold;

  const evidence = avgGapDays !== null
    ? `Last order ${daysSinceLastSale} days ago; this customer normally orders every ~${Math.round(avgGapDays)} days.`
    : `Last order ${daysSinceLastSale} days ago (flat ${DORMANCY_FLAT_THRESHOLD_DAYS}-day threshold used — fewer than ${DORMANCY_MIN_ORDERS_FOR_AVG_GAP} orders on record).`;

  return {
    isDormant,
    daysSinceLastSale,
    avgGapDays: avgGapDays !== null ? Math.round(avgGapDays * 10) / 10 : null,
    thresholdDays: Math.round(threshold),
    evidence,
  };
}

// ── 13.5 Customer Health Label ───────────────────────────────────────────────
// Deterministic decision table, first match wins. Reuses existing risk signals
// (creditRiskScore 0-100, trajectory from creditRiskAgent.classifyScoreTrajectory,
// sustainedDeterioration bool from creditRiskAgent.countRecentTierChanges) —
// computes NO new risk score of its own.
function computeHealthLabel({ dormancy, momentum, concentration, creditRiskScore, trajectory, sustainedDeterioration }) {
  const score = Number(creditRiskScore) || 0;
  const evidence = [];

  if (dormancy?.isDormant) {
    evidence.push(dormancy.evidence);
    return { label: 'DORMANT', evidence };
  }

  const deteriorating = trajectory === 'DETERIORATING' && !!sustainedDeterioration;
  if (score >= HIGH_RISK_SCORE_THRESHOLD || deteriorating) {
    if (score >= HIGH_RISK_SCORE_THRESHOLD) evidence.push(`Credit risk score ${Math.round(score)}/100 (HIGH_RISK tier).`);
    if (deteriorating) evidence.push('Credit risk trajectory is DETERIORATING with a sustained pattern (2+ tier changes in 60 days).');
    return { label: 'AT_RISK', evidence };
  }

  const negativeMomentum = momentum?.status === 'DECLINING';
  const concentratedAndRisky = concentration?.isConcentrationRisk && score >= WATCH_RISK_SCORE_THRESHOLD;
  if (negativeMomentum || concentratedAndRisky) {
    if (negativeMomentum) evidence.push(momentum.evidence);
    if (concentratedAndRisky) {
      evidence.push(concentration.evidence);
      evidence.push(`Credit risk score ${Math.round(score)}/100 — concentrated revenue exposure combined with rising payment risk.`);
    }
    return { label: 'WATCH', evidence };
  }

  const positiveMomentum = momentum?.status === 'GROWING';
  if (positiveMomentum && score < WATCH_RISK_SCORE_THRESHOLD) {
    evidence.push(momentum.evidence);
    evidence.push(`Credit risk score ${Math.round(score)}/100 (LOW tier).`);
    return { label: 'GROWING', evidence };
  }

  evidence.push('No dormancy, elevated risk, negative momentum, or concentration risk detected.');
  if (momentum?.status === 'INSUFFICIENT_HISTORY') evidence.push(momentum.evidence);
  return { label: 'HEALTHY', evidence };
}

// ── DB-backed orchestration (tenant-scoped, dual-linking union) ─────────────
// Fetches this owner's sales rows for ONE resolved customer, unioning
// customer_id-linked rows and name-matched legacy rows, de-duplicated by id.
async function fetchCustomerSalesRows(userId, customerId, customerName) {
  const queries = [];
  if (customerId) {
    queries.push(supabase.from('sales').select('id, amount, sale_date, created_at, customer_id, customer_name')
      .eq('user_id', userId).eq('customer_id', customerId));
  }
  if (customerName) {
    queries.push(supabase.from('sales').select('id, amount, sale_date, created_at, customer_id, customer_name')
      .eq('user_id', userId).ilike('customer_name', customerName.trim()));
  }
  if (queries.length === 0) return [];

  const results = await Promise.all(queries);
  const byId = new Map();
  for (const r of results) {
    for (const row of (r.data || [])) {
      byId.set(row.id, row);
    }
  }
  return Array.from(byId.values());
}

function splitByWindow(rows, windowDays, now = new Date()) {
  const cutoffCurrent = new Date(now.getTime() - windowDays * 86400000);
  const cutoffPrior = new Date(now.getTime() - 2 * windowDays * 86400000);
  const current = [];
  const prior = [];
  for (const r of rows) {
    const d = new Date(r.sale_date || r.created_at);
    if (isNaN(d.getTime())) continue;
    if (d >= cutoffCurrent && d <= now) current.push(r);
    else if (d >= cutoffPrior && d < cutoffCurrent) prior.push(r);
  }
  return { current, prior };
}

// Tenant-wide trailing-window revenue (denominator for concentration), computed
// once per request — NOT per customer. Scoped strictly by user_id.
async function computeTenantWindowRevenue(userId, windowDays = REVENUE_WINDOW_DAYS) {
  const { data, error } = await supabase
    .from('sales')
    .select('amount')
    .eq('user_id', userId)
    .gte('sale_date', daysAgoIso(windowDays).slice(0, 10));
  if (error) {
    safeLog('warn', '[RevenueIntelligence] tenant revenue fetch failed', { error: error.message, userId });
    return 0;
  }
  return (data || []).reduce((s, r) => s + (parseFloat(r.amount) || 0), 0);
}

// Full per-customer portfolio computation. Read-only, recommendation-only —
// creates zero ai_actions rows, triggers zero autonomous behavior.
async function computeCustomerPortfolioEntry(userId, { customerId, customerName }, opts = {}) {
  const windowDays = opts.windowDays || REVENUE_WINDOW_DAYS;
  const now = opts.now || new Date();

  const [allRows, scoreRow, historyRows] = await Promise.all([
    fetchCustomerSalesRows(userId, customerId, customerName),
    customerId
      ? supabase.from('customer_scores').select('credit_risk_score').eq('user_id', userId).eq('customer_id', customerId).maybeSingle()
      : Promise.resolve({ data: null }),
    customerId
      ? supabase.from('customer_score_history').select('credit_risk_score, recorded_at').eq('user_id', userId).eq('customer_id', customerId).order('recorded_at', { ascending: false }).limit(10)
      : Promise.resolve({ data: [] }),
  ]);

  const sortedAsc = [...allRows].sort((a, b) => new Date(a.sale_date || a.created_at) - new Date(b.sale_date || b.created_at));
  const { current, prior } = splitByWindow(allRows, windowDays, now);

  const value = computeCustomerValue(current, windowDays);
  const momentum = computeMomentum(current, prior, windowDays);
  const dormancy = computeDormancy(sortedAsc, now);

  const creditRiskScore = parseFloat(scoreRow?.data?.credit_risk_score || 0);
  const { classifyScoreTrajectory, countRecentTierChanges, TIER_CHANGE_WINDOW_DAYS, TIER_CHANGE_SUSTAINED_THRESHOLD } = require('../agents/creditRiskAgent');
  const trajectory = classifyScoreTrajectory(historyRows?.data || []);

  // Sustained-deterioration reuse (§11 item 3): backed by real CREDIT_RISK_TIER_CHANGED
  // event data via the same countRecentTierChanges()/TIER_CHANGE_WINDOW_DAYS/
  // TIER_CHANGE_SUSTAINED_THRESHOLD constants creditRiskAgent.js already uses
  // (Phase 5, committed 16d50d9) — no new arithmetic invented here. Only fetched when
  // trajectory is already DETERIORATING (the only case computeHealthLabel's
  // `deteriorating` branch cares about the qualifier), so a HEALTHY/IMPROVING/STABLE
  // customer never pays for an extra per-customer event query. A customer with zero
  // score-history / zero events safely resolves to non-sustained (never throws).
  let sustainedDeterioration = false;
  if (customerId && trajectory === 'DETERIORATING') {
    try {
      const eventService = require('./event.service');
      const tierChangeEvents = await eventService.getRecent(userId, {
        eventType:  'CREDIT_RISK_TIER_CHANGED',
        entityType: 'customer',
        entityId:   customerId,
        limit:      50,
      });
      sustainedDeterioration = countRecentTierChanges(tierChangeEvents, TIER_CHANGE_WINDOW_DAYS) >= TIER_CHANGE_SUSTAINED_THRESHOLD;
    } catch (err) {
      safeLog('warn', '[RevenueIntelligence] sustainedDeterioration lookup failed — defaulting to non-sustained', { error: err.message, userId, customerId });
      sustainedDeterioration = false;
    }
  }

  return {
    customerId,
    customerName,
    value,
    momentum,
    dormancy,
    creditRiskScore: Math.round(creditRiskScore),
    trajectory,
    // concentration is filled in by the caller once tenant revenue is known
    _rawRevenue: value.revenue,
    _sustainedDeterioration: sustainedDeterioration,
  };
}

// Portfolio-level: all customers for a tenant, ranked by a deterministic
// "attention score" combining economic importance (revenue share) and risk
// (credit risk score / trajectory). Inspectable formula, not a black box.
function computeAttentionScore({ concentrationSharePct, creditRiskScore, trajectory, dormancyIsDormant }) {
  // 0-100 scale. Weights: revenue importance 40%, credit risk 40%, trajectory 10%, dormancy 10%.
  const importanceComponent = Math.min(40, (concentrationSharePct || 0) * 1.6); // 25% share -> 40 (cap)
  const riskComponent = Math.min(40, (creditRiskScore || 0) * 0.4);
  const trajectoryComponent = trajectory === 'DETERIORATING' ? 10 : trajectory === 'IMPROVING' ? -5 : 0;
  const dormancyComponent = dormancyIsDormant ? 10 : 0;
  const raw = importanceComponent + riskComponent + trajectoryComponent + dormancyComponent;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

async function computePortfolio(userId, opts = {}) {
  const windowDays = opts.windowDays || REVENUE_WINDOW_DAYS;
  const now = opts.now || new Date();

  const { data: customers, error: custErr } = await supabase
    .from('customers').select('id, name').eq('user_id', userId).eq('is_active', true);
  if (custErr) {
    safeLog('warn', '[RevenueIntelligence] customers fetch failed', { error: custErr.message, userId });
    return { customers: [], tenantRevenue: 0, top1SharePct: 0, top3SharePct: 0, top5SharePct: 0, concentrationRiskCount: 0 };
  }

  const list = customers || [];
  if (list.length === 0) {
    return { customers: [], tenantRevenue: 0, top1SharePct: 0, top3SharePct: 0, top5SharePct: 0, concentrationRiskCount: 0 };
  }

  const tenantRevenue = await computeTenantWindowRevenue(userId, windowDays);

  const entries = await Promise.all(
    list.map(c => computeCustomerPortfolioEntry(userId, { customerId: c.id, customerName: c.name }, { windowDays, now }))
  );

  const enriched = entries.map(e => {
    const concentration = computeConcentration(e._rawRevenue, tenantRevenue, windowDays);
    const health = computeHealthLabel({
      dormancy: e.dormancy,
      momentum: e.momentum,
      concentration,
      creditRiskScore: e.creditRiskScore,
      trajectory: e.trajectory,
      sustainedDeterioration: e._sustainedDeterioration,
    });
    const attentionScore = computeAttentionScore({
      concentrationSharePct: concentration.sharePct,
      creditRiskScore: e.creditRiskScore,
      trajectory: e.trajectory,
      dormancyIsDormant: e.dormancy.isDormant,
    });

    const evidence = [
      e.value.evidence,
      concentration.evidence,
      e.creditRiskScore > 0 ? `Credit risk score ${e.creditRiskScore}/100${e.trajectory !== 'UNKNOWN' ? ` (${e.trajectory.toLowerCase()})` : ''}.` : null,
      e.dormancy.isDormant ? e.dormancy.evidence : null,
    ].filter(Boolean);

    return {
      customerId: e.customerId,
      customerName: e.customerName,
      revenue: e.value.revenue,
      orderCount: e.value.orderCount,
      aov: e.value.aov,
      concentration,
      momentum: e.momentum,
      dormancy: e.dormancy,
      creditRiskScore: e.creditRiskScore,
      trajectory: e.trajectory,
      healthLabel: health.label,
      healthEvidence: health.evidence,
      attentionScore,
      evidence,
    };
  });

  enriched.sort((a, b) => b.attentionScore - a.attentionScore);

  const byRevenueDesc = [...enriched].sort((a, b) => b.revenue - a.revenue);
  const sumTopN = n => byRevenueDesc.slice(0, n).reduce((s, c) => s + c.revenue, 0);
  const pct = n => tenantRevenue > 0 ? Math.round((sumTopN(n) / tenantRevenue) * 1000) / 10 : 0;

  return {
    customers: enriched,
    tenantRevenue: Math.round(tenantRevenue),
    windowDays,
    top1SharePct: pct(1),
    top3SharePct: pct(3),
    top5SharePct: pct(5),
    concentrationRiskCount: enriched.filter(c => c.concentration.isConcentrationRisk).length,
  };
}

// Single-customer convenience wrapper used by the two API wiring points
// (GET /api/customers/intelligence, GET /api/customer-scores) — composes
// computeCustomerPortfolioEntry() with the tenant-wide denominator so callers
// that only need one customer's `revenue` block don't have to build the full
// tenant portfolio themselves. Callers pass in creditRiskScore/trajectory/
// sustainedDeterioration they already computed for their own response (they
// already read customer_scores/customer_score_history/tier-change events for
// other sections), avoiding a duplicate fetch per customer. Returns null on
// any failure — callers treat that as "no revenue block", never a hard error.
async function getRevenueIntelligenceForCustomer(userId, customerId, customerName, opts = {}) {
  if (!userId || (!customerId && !customerName)) return null;
  try {
    const windowDays = opts.windowDays || REVENUE_WINDOW_DAYS;
    const now = opts.now || new Date();
    const [entry, tenantRevenue] = await Promise.all([
      computeCustomerPortfolioEntry(userId, { customerId, customerName }, { windowDays, now }),
      computeTenantWindowRevenue(userId, windowDays),
    ]);

    const creditRiskScore = opts.creditRiskScore ?? entry.creditRiskScore;
    const trajectory = opts.trajectory ?? entry.trajectory;
    const sustainedDeterioration = opts.sustainedDeterioration ?? entry._sustainedDeterioration;

    const concentration = computeConcentration(entry._rawRevenue, tenantRevenue, windowDays);
    const health = computeHealthLabel({
      dormancy: entry.dormancy,
      momentum: entry.momentum,
      concentration,
      creditRiskScore,
      trajectory,
      sustainedDeterioration,
    });

    return {
      value: entry.value,
      momentum: entry.momentum,
      concentration,
      dormancy: entry.dormancy,
      health,
    };
  } catch (err) {
    safeLog('error', '[RevenueIntelligence] getRevenueIntelligenceForCustomer failed', { error: err.message, userId, customerId });
    return null;
  }
}

// ── REVENUE_HEALTH_WATCH rule (recommendation-only, ai_actions pipeline) ────
// Runs the portfolio computation for one tenant and turns customers whose
// healthLabel is AT_RISK or DORMANT *and* who are already a concentration risk
// (concentration.isConcentrationRisk, the SAME >25%-of-trailing-revenue
// threshold this file already defines and uses — no new threshold invented)
// into a candidate ActionSpec. Mirrors the exact conventions of
// creditRiskAgent.js's run(): a plain async (userId) => ActionSpec[] "agent"
// function, gated by its own feature flag check, pending-row dedup via a Set
// keyed by related_entity_id before building specs, and returning specs for
// the orchestrator to route through policyGuard.validate() + actionService.create()
// (see orchestrator.service.js runAllAgents) — this function never inserts into
// ai_actions itself and never bypasses policyGuard.
//
// Gated by FEATURE_CUSTOMER_REVENUE_INTELLIGENCE (Phase 10 flag): returns []
// immediately, with zero DB reads beyond the flag check, when the flag is off —
// matching the "must not run at all" requirement.
const ACTION_TYPE_REVENUE_HEALTH_WATCH = 'REVENUE_HEALTH_WATCH';

async function runRevenueHealthWatchRule(userId) {
  try {
    const { isEnabled } = require('../../featureFlags');
    if (!isEnabled('customer_revenue_intelligence')) return [];

    const portfolio = await computePortfolio(userId);
    const candidates = (portfolio.customers || []).filter(c =>
      (c.healthLabel === 'AT_RISK' || c.healthLabel === 'DORMANT') &&
      c.concentration?.isConcentrationRisk === true &&
      c.customerId
    );
    if (candidates.length === 0) return [];

    // Dedup: skip customers that already have a pending REVENUE_HEALTH_WATCH row,
    // exactly like creditRiskAgent.js's `alreadyAlerted` pattern for CREDIT_RISK_ALERT.
    const { data: existingActions } = await supabase
      .from('ai_actions')
      .select('related_entity_id')
      .eq('user_id', userId)
      .eq('action_type', ACTION_TYPE_REVENUE_HEALTH_WATCH)
      .eq('status', 'pending');
    const alreadyFlagged = new Set((existingActions || []).map(a => String(a.related_entity_id)));

    // Learning-loop read: bulk-fetch revenue_health_watch_outcome memory for
    // every candidate customer_id in this run, once per tenant (not per-customer/
    // N+1) — mirrors collectionsAgent.js's applyMemoryTonePreference bulk-fetch
    // pattern. evaluationAgent.js already writes this key when a
    // REVENUE_HEALTH_WATCH is evaluated; nothing consulted it until now.
    // Missing/malformed/empty degrades silently to "no prior outcome".
    const revenueWatchCustomerIds = [...new Set(candidates.map(c => c.customerId).filter(Boolean))];
    let revenueWatchOutcomeByCustomer = {};
    if (revenueWatchCustomerIds.length) {
      try {
        const { data: outcomeRows } = await supabase
          .from('business_memory')
          .select('entity_id, memory_value')
          .eq('user_id', userId)
          .eq('entity_type', 'customer')
          .eq('memory_key', 'revenue_health_watch_outcome')
          .in('entity_id', revenueWatchCustomerIds);

        revenueWatchOutcomeByCustomer = (outcomeRows || []).reduce((acc, r) => {
          acc[r.entity_id] = r;
          return acc;
        }, {});
      } catch (memErr) {
        safeLog('warn', '[RevenueIntelligence] revenue_health_watch_outcome memory lookup failed, falling back to unmodified priority', { error: memErr.message, userId });
        revenueWatchOutcomeByCustomer = {};
      }
    }

    const { downgradePriority, downgradeRiskLevel } = require('../agents/creditRiskAgent');

    const specs = [];
    for (const c of candidates) {
      if (alreadyFlagged.has(String(c.customerId))) continue;

      let priority   = c.healthLabel === 'AT_RISK' ? 'high' : 'medium';
      let riskLevel  = c.healthLabel === 'AT_RISK' ? 'high' : 'medium';
      let description = c.evidence.join(' ');

      // Learning-loop read: if this customer's last REVENUE_HEALTH_WATCH was
      // recorded as ineffective, demote priority/risk_level one notch and
      // annotate — the watch is still created and still goes through
      // policyGuard exactly as before; memory only adjusts prioritization,
      // never suppresses.
      let outcomeRow;
      try {
        outcomeRow = revenueWatchOutcomeByCustomer[c.customerId];
      } catch (_e) {
        outcomeRow = undefined;
      }
      const previouslyIneffective = !!(outcomeRow && outcomeRow.memory_value && outcomeRow.memory_value.v === false);
      if (previouslyIneffective) {
        priority  = downgradePriority(priority);
        riskLevel = downgradeRiskLevel(riskLevel);
        description += ' (Previous REVENUE_HEALTH_WATCH for this customer was ineffective — demoted.)';
      }

      specs.push({
        action_type:          ACTION_TYPE_REVENUE_HEALTH_WATCH,
        title:                `Revenue health watch: ${c.customerName || 'Unknown customer'} (${c.healthLabel})`,
        description,
        priority,
        customer_id:          c.customerId,
        related_entity_type:  'customer',
        related_entity_id:    c.customerId,
        reason_json: {
          healthLabel:            c.healthLabel,
          healthEvidence:         c.healthEvidence,
          attentionScore:         c.attentionScore,
          concentrationSharePct:  c.concentration.sharePct,
          evidence:               c.evidence,
          rule:                   'revenue_health_watch_at_risk_or_dormant_concentrated',
        },
        suggested_by:      'rule',
        requires_approval: true,
        risk_level:        riskLevel,
        previously_ineffective: previouslyIneffective,
      });
    }

    return specs;
  } catch (err) {
    safeLog('error', '[RevenueIntelligence] runRevenueHealthWatchRule failed', { error: err.message, userId });
    return [];
  }
}

module.exports = {
  REVENUE_WINDOW_DAYS,
  CONCENTRATION_RISK_THRESHOLD,
  MOMENTUM_MIN_ORDER_COUNT,
  ACTION_TYPE_REVENUE_HEALTH_WATCH,
  aggregateSales,
  computeCustomerValue,
  computeMomentum,
  computeConcentration,
  computeDormancy,
  computeHealthLabel,
  computeAttentionScore,
  fetchCustomerSalesRows,
  splitByWindow,
  computeTenantWindowRevenue,
  computeCustomerPortfolioEntry,
  computePortfolio,
  getRevenueIntelligenceForCustomer,
  runRevenueHealthWatchRule,
};
