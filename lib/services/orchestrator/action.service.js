// FILE: lib/services/orchestrator/action.service.js
// CRUD for ai_actions — the owner's AI-generated action queue.
// Every create goes through policyGuard before reaching here.
const { supabase } = require('../../config/supabaseClient');
const { safeLog } = require('../../observability/logger');

async function create(userId, action) {
  try {
    const row = {
      user_id:              userId,
      action_type:          action.action_type,
      title:                action.title,
      description:          action.description          || null,
      priority:             action.priority             || 'medium',
      related_entity_type:  action.related_entity_type  || null,
      related_entity_id:    action.related_entity_id    ? String(action.related_entity_id) : null,
      customer_id:          action.customer_id          || null,
      supplier_id:          action.supplier_id          || null,
      status:               action.status               || 'pending',
      suggested_by:         action.suggested_by         || 'rule',
      reason_json:          action.reason_json          || null,
      recommended_message:  action.recommended_message  || null,
      risk_level:           action.risk_level           || 'low',
      requires_approval:    action.requires_approval    || false,
      block_reason:         action.block_reason         || null,
    };

    const { data, error } = await supabase.from('ai_actions').insert([row]).select().single();
    if (error) {
      safeLog('error', '[ActionService] create failed', { error: error.message, actionType: action.action_type, userId });
      return null;
    }
    return data;
  } catch (err) {
    safeLog('error', '[ActionService] Unexpected error in create', { error: err.message });
    return null;
  }
}

// Approve / reject / mark done — validates ownership before update.
async function updateStatus(userId, actionId, status, updatedBy = null) {
  const allowed = ['approved', 'rejected', 'done', 'expired'];
  if (!allowed.includes(status)) {
    safeLog('warn', '[ActionService] Invalid status transition', { status, actionId });
    return null;
  }

  const updates = { status, updated_at: new Date().toISOString() };
  if (status === 'approved') {
    updates.approved_by = updatedBy || userId;
    updates.approved_at = new Date().toISOString();
  }
  if (status === 'done') {
    updates.completed_at = new Date().toISOString();
  }

  const { data, error } = await supabase
    .from('ai_actions')
    .update(updates)
    .eq('id', actionId)
    .eq('user_id', userId)
    .select()
    .single();

  if (error) safeLog('warn', '[ActionService] updateStatus failed', { error: error.message, actionId });
  return data || null;
}

// List pending/approved actions for the owner's Action Center.
async function list(userId, { status = 'pending', priority, limit = 50 } = {}) {
  let q = supabase
    .from('ai_actions')
    .select('*, customers(name, phone)')
    .eq('user_id', userId)
    .in('status', Array.isArray(status) ? status : [status])
    .order('created_at', { ascending: false })
    .limit(limit);
  if (priority) q = q.eq('priority', priority);
  const { data, error } = await q;
  if (error) { safeLog('warn', '[ActionService] list failed', { error: error.message }); return []; }
  return data || [];
}

// Expire stale pending actions older than maxAgeDays (called by daily cron).
async function expireStale(userId, maxAgeDays = 7) {
  const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
  const { error } = await supabase
    .from('ai_actions')
    .update({ status: 'expired', updated_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('status', 'pending')
    .lt('created_at', cutoff);
  if (error) safeLog('warn', '[ActionService] expireStale failed', { error: error.message, userId });
}

module.exports = { create, updateStatus, list, expireStale };
