// FILE: lib/services/agents/creditRiskAgent.js
// Credit Risk Agent — detects tier changes in customer_scores and creates alerts.
// Also writes credit tier history to business_memory for trend tracking.
// Run daily or on SCORE_CHANGE events.
const { supabase } = require('../../config/supabaseClient');
const { safeLog }  = require('../../observability/logger');
const eventService = require('../orchestrator/event.service');

const TIER_LABEL = { HIGH_RISK: 'HIGH RISK 🔴', MEDIUM: 'Medium ⚠️', LOW: 'Low 🟢' };

// Phase 5: sustained-pattern lookback window for CREDIT_RISK_TIER_CHANGED frequency.
// 60 days is used (not 30) because a single missed-payment cycle can already produce
// one tier change on its own (Phase 3's evaluationAgent re-checks on a 7-day cadence,
// scoring.service.js recalculates on invoice/promise events) — a 60-day window is
// wide enough to catch a genuinely *repeated* pattern (>=2 changes) without being so
// wide that one-off, long-settled tier moves from months ago still count as "recent".
const TIER_CHANGE_WINDOW_DAYS = 60;
// Phase 5: >=2 tier changes inside the window is treated as a sustained/repeated
// deterioration pattern (as opposed to a single one-off worsening), matching the
// plan's explicit "2+ tier changes in 60 days" example (STARLANE_PHASE_5_PLAN.md §5/§16).
const TIER_CHANGE_SUSTAINED_THRESHOLD = 2;

function deriveTier(creditRiskScore) {
  const s = parseFloat(creditRiskScore || 0);
  if (s >= 70) return 'HIGH_RISK';
  if (s >= 40) return 'MEDIUM';
  return 'LOW';
}

// Phase 5: pure, deterministic score-trajectory classifier.
// `historyRows` must be the customer's most recent customer_score_history rows,
// ordered by recorded_at DESC (i.e. historyRows[0] is the latest, historyRows[1] the
// previous). credit_risk_score is HIGHER = RISKIER (scoring.service.js:70-78,
// deriveTier() above), so a higher latest score than previous means the customer's
// risk is getting WORSE, i.e. DETERIORATING — not "improving".
// Returns 'UNKNOWN' whenever there are fewer than 2 usable rows (insufficient
// history) or the values are malformed/non-numeric — this MUST be treated by every
// caller as "no change to existing behavior", never as deterioration or improvement.
function classifyScoreTrajectory(historyRows) {
  if (!Array.isArray(historyRows) || historyRows.length < 2) return 'UNKNOWN';

  const latestScore   = Number(historyRows[0]?.credit_risk_score);
  const previousScore = Number(historyRows[1]?.credit_risk_score);
  if (!Number.isFinite(latestScore) || !Number.isFinite(previousScore)) return 'UNKNOWN';

  if (latestScore === previousScore) return 'STABLE';
  return latestScore > previousScore ? 'DETERIORATING' : 'IMPROVING';
}

// Phase 5: pure, deterministic tier-change-frequency counter.
// `events` must be a bounded list of CREDIT_RISK_TIER_CHANGED events already scoped
// to one customer (via eventService.getRecent()'s entityType/entityId/eventType
// filters) — this function does no scoping of its own, it only counts how many of
// the given events fall within `windowDays` of "now". Malformed/missing timestamps
// are excluded from the count rather than throwing.
function countRecentTierChanges(events, windowDays = TIER_CHANGE_WINDOW_DAYS) {
  if (!Array.isArray(events) || !events.length) return 0;
  const cutoffMs = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  return events.reduce((count, e) => {
    const t = e && e.created_at ? new Date(e.created_at).getTime() : NaN;
    return Number.isFinite(t) && t >= cutoffMs ? count + 1 : count;
  }, 0);
}

// Phase 5: bounded, upgrade-only step within the existing priority enum
// (medium -> high -> urgent). Never invents a new value, never exceeds the max,
// never downgrades (unrecognized/already-max input is returned unchanged).
function upgradePriority(priority) {
  if (priority === 'medium') return 'high';
  if (priority === 'high')   return 'urgent';
  return priority;
}

// Phase 5: bounded, upgrade-only step within the existing risk_level enum
// (medium -> high). Never invents a new value, never exceeds the max, never
// downgrades (unrecognized/already-max input is returned unchanged).
function upgradeRiskLevel(riskLevel) {
  if (riskLevel === 'medium') return 'high';
  return riskLevel;
}

// Learning-loop read: bounded, downgrade-only step, symmetric to upgradePriority
// above. Never invents a new value, never goes below the existing minimum used
// by this agent ('medium'), never downgrades twice in one call.
function downgradePriority(priority) {
  if (priority === 'urgent') return 'high';
  if (priority === 'high')   return 'medium';
  return priority;
}

// Learning-loop read: bounded, downgrade-only step, symmetric to upgradeRiskLevel
// above. Never invents a new value, never goes below the existing minimum used
// by this agent ('medium').
function downgradeRiskLevel(riskLevel) {
  if (riskLevel === 'high') return 'medium';
  return riskLevel;
}

/**
 * Pure function: read a { v: boolean } outcome memory row (or undefined/malformed)
 * for one customer's `credit_risk_alert_outcome` and decide whether their last
 * CREDIT_RISK_ALERT was ineffective. Never throws; treats anything except an
 * explicit `v === false` as "no evidence of ineffectiveness" (safe default).
 */
function wasLastCreditRiskAlertIneffective(memoryRow) {
  try {
    return !!(memoryRow && memoryRow.memory_value && memoryRow.memory_value.v === false);
  } catch (_e) {
    return false;
  }
}

/**
 * Run the Credit Risk Agent.
 * Detects customers whose risk tier has worsened and creates ai_actions.
 * Also writes tier history to business_memory.
 */
async function run(userId, context = {}) {
  try {
    const { isEnabled } = require('../../../lib/featureFlags');
    if (!isEnabled('customer_scoring')) return [];

    // Fetch all scored customers
    const { data: scores, error } = await supabase
      .from('customer_scores')
      .select('customer_id, credit_risk_score, score_reason_json, customers(name)')
      .eq('user_id', userId)
      .order('credit_risk_score', { ascending: false });

    if (error) throw error;
    if (!scores?.length) return [];

    // Read existing tier memories to detect changes
    const { data: memories } = await supabase
      .from('business_memory')
      .select('entity_id, memory_value')
      .eq('user_id', userId)
      .eq('entity_type', 'customer')
      .eq('memory_key', 'credit_tier_last');

    const prevTierMap = {};
    (memories || []).forEach(m => {
      prevTierMap[m.entity_id] = m.memory_value?.tier;
    });

    // Check existing alerts to avoid duplicates
    const { data: existingAlerts } = await supabase
      .from('ai_actions')
      .select('related_entity_id')
      .eq('user_id', userId)
      .eq('action_type', 'CREDIT_RISK_ALERT')
      .eq('status', 'pending');
    const alreadyAlerted = new Set((existingAlerts || []).map(a => a.related_entity_id));

    // Learning-loop read: bulk-fetch credit_risk_alert_outcome memory for every
    // scored customer_id in this run, once per tenant (not per-customer/N+1) —
    // mirrors collectionsAgent.js's applyMemoryTonePreference bulk-fetch pattern.
    // evaluationAgent.js already writes this key when a CREDIT_RISK_ALERT is
    // evaluated; nothing consulted it until now. Missing/malformed/empty degrades
    // silently to "no prior outcome" (today's unmodified behavior).
    const creditRiskCustomerIds = [...new Set((scores || []).map(s => s.customer_id).filter(Boolean))];
    let creditRiskOutcomeByCustomer = {};
    if (creditRiskCustomerIds.length) {
      try {
        const { data: outcomeRows } = await supabase
          .from('business_memory')
          .select('entity_id, memory_value')
          .eq('user_id', userId)
          .eq('entity_type', 'customer')
          .eq('memory_key', 'credit_risk_alert_outcome')
          .in('entity_id', creditRiskCustomerIds);

        creditRiskOutcomeByCustomer = (outcomeRows || []).reduce((acc, r) => {
          acc[r.entity_id] = r;
          return acc;
        }, {});
      } catch (memErr) {
        safeLog('warn', '[CreditRiskAgent] credit_risk_alert_outcome memory lookup failed, falling back to unmodified priority', { error: memErr.message, userId });
        creditRiskOutcomeByCustomer = {};
      }
    }

    const specs   = [];
    const memRows = [];

    for (const row of scores) {
      const currentTier = deriveTier(row.credit_risk_score);
      const prevTier    = prevTierMap[row.customer_id] || 'LOW';
      const name        = row.customers?.name || 'Unknown';

      // Detect worsening: LOW→MEDIUM, MEDIUM→HIGH_RISK, or directly LOW→HIGH_RISK
      const worsened = (prevTier === 'LOW' && currentTier !== 'LOW')
                    || (prevTier === 'MEDIUM' && currentTier === 'HIGH_RISK');

      // Update tier memory regardless
      memRows.push({
        user_id:      userId,
        entity_type:  'customer',
        entity_id:    row.customer_id,
        memory_key:   'credit_tier_last',
        memory_value: { tier: currentTier, score: row.credit_risk_score, updatedAt: new Date().toISOString() },
        source:       'credit_risk_agent',
        updated_at:   new Date().toISOString(),
      });

      if (worsened) {
        // Phase 3C: emit CREDIT_RISK_TIER_CHANGED at the exact point tier-worsening is
        // already detected — reuses this same comparison, no new before/after tracking.
        // Gated by `worsened` alone (not `alreadyAlerted`, which only dedupes the
        // separate CREDIT_RISK_ALERT ai_action) so the event reflects every real tier
        // change; `worsened` itself is already false on a re-run with no underlying
        // score change (prevTier === currentTier), so this cannot double-fire per change.
        eventService.emit(userId, {
          eventType:  'CREDIT_RISK_TIER_CHANGED',
          entityType: 'customer',
          entityId:   row.customer_id,
          actorType:  'system',
          payload: {
            customer_id:       row.customer_id,
            old_tier:          prevTier,
            new_tier:          currentTier,
            credit_risk_score: row.credit_risk_score,
          },
        }).catch(err => safeLog('warn', '[CreditRiskAgent] CREDIT_RISK_TIER_CHANGED emit failed', { error: err.message, customerId: row.customer_id }));
      }

      if (worsened && !alreadyAlerted.has(row.customer_id)) {
        const reason = row.score_reason_json?.scoreReason || `Score ${Math.round(row.credit_risk_score)}/100`;

        // Phase 5: customer-scoped temporal lookups, only fetched for the subset of
        // customers that already reach this alert-creation branch (worsened === true
        // and not already alerted) — no batching added, matching the plan's explicit
        // performance guidance that a per-customer lookup here is acceptable since the
        // existing loop already processes customers one at a time and this only runs
        // for an already-filtered subset, not every scored customer.
        let trajectory = 'UNKNOWN';
        let tierChangeCount = 0;
        try {
          const { data: historyRows } = await supabase
            .from('customer_score_history')
            .select('credit_risk_score, recorded_at')
            .eq('user_id', userId)
            .eq('customer_id', row.customer_id)
            .order('recorded_at', { ascending: false })
            .limit(2);
          trajectory = classifyScoreTrajectory(historyRows || []);

          const tierChangeEvents = await eventService.getRecent(userId, {
            eventType:  'CREDIT_RISK_TIER_CHANGED',
            entityType: 'customer',
            entityId:   row.customer_id,
            limit:      50,
          });
          tierChangeCount = countRecentTierChanges(tierChangeEvents, TIER_CHANGE_WINDOW_DAYS);
        } catch (temporalErr) {
          // Never let the new temporal lookups break the pre-existing alert path —
          // degrade to today's exact unmodified behavior (UNKNOWN / 0) on any failure.
          safeLog('warn', '[CreditRiskAgent] temporal trajectory lookup failed', { error: temporalErr.message, customerId: row.customer_id });
          trajectory = 'UNKNOWN';
          tierChangeCount = 0;
        }

        const sustainedPattern = tierChangeCount >= TIER_CHANGE_SUSTAINED_THRESHOLD;
        const shouldUpgrade    = trajectory === 'DETERIORATING' || sustainedPattern;

        let priority   = currentTier === 'HIGH_RISK' ? 'high' : 'medium';
        let riskLevel  = currentTier === 'HIGH_RISK' ? 'high' : 'medium';
        let description = `${prevTier} → ${currentTier}. ${reason}`;

        if (shouldUpgrade) {
          priority  = upgradePriority(priority);
          riskLevel = upgradeRiskLevel(riskLevel);

          const evidenceParts = [];
          if (trajectory === 'DETERIORATING') evidenceParts.push('score deteriorated across recent snapshots');
          if (sustainedPattern) evidenceParts.push(`risk tier changed repeatedly (${tierChangeCount}x) in the last ${TIER_CHANGE_WINDOW_DAYS} days`);
          description += ` ${evidenceParts.join('; ')}.`;
        }

        // Learning-loop read: if the last CREDIT_RISK_ALERT for this customer was
        // recorded as ineffective, demote priority/risk_level one notch and annotate
        // — the alert itself is still created and still goes through policyGuard
        // exactly as before; memory only adjusts prioritization, never suppresses.
        const previouslyIneffective = wasLastCreditRiskAlertIneffective(creditRiskOutcomeByCustomer[row.customer_id]);
        if (previouslyIneffective) {
          priority  = downgradePriority(priority);
          riskLevel = downgradeRiskLevel(riskLevel);
          description += ' (Previous CREDIT_RISK_ALERT for this customer was ineffective — demoted.)';
        }

        specs.push({
          action_type:         'CREDIT_RISK_ALERT',
          title:               `Credit risk worsened: ${name}`,
          description,
          priority,
          risk_level:          riskLevel,
          related_entity_type: 'customer',
          related_entity_id:   row.customer_id,
          suggested_by:        'credit_risk_agent',
          requires_approval:   false,
          previously_ineffective: previouslyIneffective,
        });
      }
    }

    // Persist tier memories (upsert)
    if (memRows.length && isEnabled('memory_enabled')) {
      await supabase.from('business_memory')
        .upsert(memRows, { onConflict: 'user_id,entity_type,entity_id,memory_key' });
    }

    safeLog('info', '[CreditRiskAgent] Run complete', { userId, alerts: specs.length, scored: scores.length });
    return specs;
  } catch (err) {
    safeLog('error', '[CreditRiskAgent] run failed', { error: err.message, userId });
    return [];
  }
}

module.exports = {
  run,
  deriveTier,
  classifyScoreTrajectory,
  countRecentTierChanges,
  upgradePriority,
  upgradeRiskLevel,
  downgradePriority,
  downgradeRiskLevel,
  wasLastCreditRiskAlertIneffective,
  TIER_CHANGE_WINDOW_DAYS,
  TIER_CHANGE_SUSTAINED_THRESHOLD,
};
