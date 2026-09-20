// FILE: lib/services/agents/inventoryAgent.js
// Inventory Agent — detects items below reorder threshold and creates ai_actions.
// Triggered by SALE_CREATED events and a daily cron.
//
// "Closing the loop" (Cortex X, agent auto-execute pass): when an item has a
// supplier on file (inventory.supplier_name/supplier_phone) and
// FEATURE_AGENT_AUTOEXECUTE_ENABLED is on, this agent also drafts a
// purchase_orders row (status: 'draft') and an INVENTORY_PO_READY action.
// The agent NEVER sends the PO itself — it only drafts it. Sending only
// happens after the owner taps the one-tap approval link (see
// server.js's executeInventoryPO / GET /api/actions/:id/approve), same
// safety shape as payablesAgent's "never execute payment" constraint.
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

    // Check for existing pending alerts / PO-ready actions to avoid duplicates
    const { data: existing } = await supabase
      .from('ai_actions')
      .select('related_entity_id, action_type')
      .eq('user_id', userId)
      .eq('status', 'pending')
      .in('action_type', ['LOW_STOCK_ALERT', 'INVENTORY_PO_READY']);
    const alreadyAlerted = new Set((existing || []).filter(a => a.action_type === 'LOW_STOCK_ALERT').map(a => a.related_entity_id));
    const alreadyHasPO   = new Set((existing || []).filter(a => a.action_type === 'INVENTORY_PO_READY').map(a => a.related_entity_id));

    const autoExecuteOn = isEnabled('agent_autoexecute_enabled');
    const specs = [];
    const productIds = lowItems.map(item => item.id);
    let supplierLinks = [];
    try {
      const supplierResult = await supabase
        .from('product_suppliers')
        .select('product_id, suppliers(name, phone)')
        .eq('user_id', userId)
        .in('product_id', productIds);
      if (!supplierResult.error) supplierLinks = supplierResult.data || [];
      else safeLog('warn', '[InventoryAgent] Supplier links unavailable; PO drafting withheld', { userId, error: supplierResult.error.message });
    } catch (supplierError) {
      safeLog('warn', '[InventoryAgent] Supplier links unavailable; PO drafting withheld', { userId, error: supplierError.message });
    }
    const supplierByProduct = new Map((supplierLinks || []).map(link => [
      link.product_id,
      { name: link.suppliers?.name || null, phone: link.suppliers?.phone || null },
    ]));

    for (const item of lowItems) {
      const qty     = Number(item.current_stock || 0);
      const reorder = Number(item.low_stock_alert || 0);
      const supplier = supplierByProduct.get(item.id);
      if (!alreadyAlerted.has(item.id)) specs.push({
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
      if (autoExecuteOn && supplier?.name && supplier?.phone && !alreadyHasPO.has(String(item.id))) {
        const orderQty = Math.max(reorder * 2 - qty, reorder);

        const { data: po, error: poErr } = await supabase.from('purchase_orders').insert([{
          user_id:        userId,
          supplier_name:  supplier.name,
          supplier_phone: supplier.phone,
          items:          [{ name: item.name, qty: orderQty, unit: 'units' }],
          estimated_amount: null, // no per-item cost data available in `inventory` today
          status:         'draft',
        }]).select().single();

        if (poErr) {
          safeLog('warn', '[InventoryAgent] Failed to draft purchase order', { error: poErr.message, itemId: item.id });
          continue;
        }

        specs.push({
          action_type:         'INVENTORY_PO_READY',
          title:               `Reorder ready: ${item.name} from ${supplier.name}`,
          description:         `${orderQty} units of ${item.name} — tap to send this order to ${supplier.name} on WhatsApp.`,
          priority:            qty === 0 ? 'urgent' : 'high',
          risk_level:          'medium',
          related_entity_type: 'inventory',
          related_entity_id:   item.id,
          suggested_by:        'system',
          requires_approval:   true, // also enforced by policyGuard.ALWAYS_REQUIRES_APPROVAL
          reason_json:         { purchase_order_id: po.id, supplier_name: supplier.name, order_qty: orderQty },
        });
      }
    }

    safeLog('info', '[InventoryAgent] Run complete', { userId, specs: specs.length, lowItems: lowItems.length });
    return specs;
  } catch (err) {
    safeLog('error', '[InventoryAgent] run failed', { error: err.message, userId });
    return [];
  }
}

module.exports = { run };
