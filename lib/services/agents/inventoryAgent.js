// FILE: lib/services/agents/inventoryAgent.js
// Inventory Agent — detects items below reorder threshold and creates ai_actions.
// Triggered by SALE_CREATED events and a daily cron.
const { supabase } = require('../../config/supabaseClient');
const { safeLog }  = require('../../observability/logger');

/**
 * Run the Inventory Agent.
 * @param {string} userId
 * @param {object} context - optional: { itemId } to check a single item
 * @returns {Array} ActionSpecs
 */
async function run(userId, context = {}) {
  try {
    const { isEnabled } = require('../../../lib/featureFlags');
    if (!isEnabled('low_stock_alerts')) return [];

    let query = supabase
      .from('products')
      .select('id, name, current_stock, low_stock_alert')
      .eq('user_id', userId)
      .gt('low_stock_alert', 0); // only items with a defined reorder level

    if (context.itemId) query = query.eq('id', context.itemId);

    const { data: items, error } = await query;
    if (error) throw error;
    if (!items?.length) return [];

    // Filter to items at or below reorder level
    const lowItems = items.filter(i => Number(i.current_stock || 0) <= Number(i.low_stock_alert || 0));
    if (!lowItems.length) return [];

    // Check for existing pending alerts
    const { data: existing } = await supabase
      .from('ai_actions')
      .select('related_entity_id')
      .eq('user_id', userId)
      .eq('action_type', 'LOW_STOCK_ALERT')
      .eq('status', 'pending');
    const alreadyAlerted = new Set((existing || []).map(a => a.related_entity_id));

    const specs = [];
    for (const item of lowItems) {
      if (alreadyAlerted.has(item.id)) continue;

      const qty     = Number(item.current_stock || 0);
      const reorder = Number(item.low_stock_alert || 0);

      specs.push({
        action_type:         'LOW_STOCK_ALERT',
        title:               `Low stock: ${item.name}`,
        description:         `${qty} units left — reorder level is ${reorder}. Order soon to avoid stockout.`,
        priority:            qty === 0 ? 'urgent' : 'high',
        risk_level:          qty === 0 ? 'high' : 'medium',
        related_entity_type: 'product',
        related_entity_id:   item.id,
        suggested_by:        'inventory_agent',
        requires_approval:   false,
      });
    }

    safeLog('info', '[InventoryAgent] Run complete', { userId, alerts: specs.length, lowItems: lowItems.length });
    return specs;
  } catch (err) {
    safeLog('error', '[InventoryAgent] run failed', { error: err.message, userId });
    return [];
  }
}

module.exports = { run };
