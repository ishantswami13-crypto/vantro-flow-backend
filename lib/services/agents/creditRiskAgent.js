// FILE: lib/services/agents/creditRiskAgent.js
// Credit Risk Agent — detects tier changes in customer_scores and creates alerts.
// Also writes credit tier history to business_memory for trend tracking.
// Run daily or on SCORE_CHANGE events.
const { supabase } = require('../../config/supabaseClient');
const { safeLog }  = require('../../observability/logger');

const TIER_LABEL = { HIGH_RISK: 'HIGH RISK 🔴', MEDIUM: 'Medium ⚠️', LOW: 'Low 🟢' };

function deriveTier(creditRiskScore) {
  const s = parseFloat(creditRiskScore || 0);
  if (s >= 70) return 'HIGH_RISK';
  if (s >= 40) return 'MEDIUM';
  return 'LOW';
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

      if (worsened && !alreadyAlerted.has(row.customer_id)) {
        const reason = row.score_reason_json?.scoreReason || `Score ${Math.round(row.credit_risk_score)}/100`;
        specs.push({
          action_type:         'CREDIT_RISK_ALERT',
          title:               `Credit risk worsened: ${name}`,
          description:         `${prevTier} → ${currentTier}. ${reason}`,
          priority:            currentTier === 'HIGH_RISK' ? 'high' : 'medium',
          risk_level:          currentTier === 'HIGH_RISK' ? 'high' : 'medium',
          related_entity_type: 'customer',
          related_entity_id:   row.customer_id,
          suggested_by:        'credit_risk_agent',
          requires_approval:   false,
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

module.exports = { run };
