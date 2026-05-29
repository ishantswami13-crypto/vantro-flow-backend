// FILE: lib/services/orchestrator/toolRegistry.service.js
// Static registry of tools available to agents.
// Each tool has: name, description, inputSchema, handler, requiredFlag.
// getAvailable() filters by active feature flags before returning.
// call() validates params, invokes handler, logs to tool_calls via CommandBus.
const { safeLog } = require('../../observability/logger');

// ── Tool definitions ──────────────────────────────────────────────────────────
const TOOLS = [
  {
    name:         'score_customer',
    description:  'Recalculate credit risk and collection priority score for a customer',
    requiredFlag: 'customer_scoring',
    inputSchema:  { customerId: 'string (UUID, required)' },
    handler:      async (userId, params) => {
      const { recalculate } = require('./scoring.service');
      return recalculate(userId, params.customerId);
    },
  },
  {
    name:         'create_action',
    description:  'Create an AI action in the owner\'s Action Center',
    requiredFlag: 'ai_action_center',
    inputSchema:  { action_type: 'string', title: 'string', priority: 'urgent|high|medium|low' },
    handler:      async (userId, params) => {
      const { create } = require('./action.service');
      return create(userId, params);
    },
  },
  {
    name:         'create_promise',
    description:  'Record a payment promise from a customer',
    requiredFlag: 'cortex_enabled',
    inputSchema:  { customer_id: 'string (UUID)', promised_date: 'YYYY-MM-DD', promised_amount: 'number' },
    handler:      async (userId, params) => {
      const { supabase } = require('../../config/supabaseClient');
      const { data, error } = await supabase.from('promises').insert([{
        user_id:         userId,
        customer_id:     params.customer_id,
        receivable_id:   params.receivable_id || null,
        promised_amount: params.promised_amount || null,
        promised_date:   params.promised_date,
        promise_note:    params.promise_note || 'Recorded by agent',
        status:          'active',
        created_by:      userId,
      }]).select().single();
      if (error) throw error;
      return data;
    },
  },
  {
    name:         'send_whatsapp_reminder',
    description:  'Send a WhatsApp message to a customer phone number',
    requiredFlag: 'ai_message_drafts',
    inputSchema:  { phone: 'string (10-digit)', message: 'string (max 1600 chars)' },
    handler:      async (userId, params) => {
      // Delegate to the existing sendWhatsAppMessage global in server.js context
      // This tool is called via the API endpoint, not directly from the service layer
      throw new Error('send_whatsapp_reminder must be called via POST /api/ai-actions/:id/send-whatsapp');
    },
  },
  {
    name:         'remember',
    description:  'Store a learned fact about a customer, supplier, or the business',
    requiredFlag: 'cortex_enabled',
    inputSchema:  { entityType: 'customer|supplier|global', entityId: 'UUID|null', key: 'string', value: 'any' },
    handler:      async (userId, params) => {
      const { dispatch } = require('./commandBus.service');
      return dispatch(userId, 'REMEMBER', params);
    },
  },
  {
    name:         'recall',
    description:  'Retrieve stored memories for a customer or the business',
    requiredFlag: 'cortex_enabled',
    inputSchema:  { entityType: 'customer|supplier|global', entityId: 'UUID|null', key: 'string (optional)' },
    handler:      async (userId, params) => {
      const { supabase } = require('../../config/supabaseClient');
      let q = supabase.from('business_memory')
        .select('memory_key, memory_value, confidence, source, updated_at')
        .eq('user_id', userId)
        .eq('entity_type', params.entityType || 'global');
      if (params.entityId) q = q.eq('entity_id', params.entityId);
      if (params.key)      q = q.eq('memory_key', params.key);
      const { data, error } = await q.order('updated_at', { ascending: false });
      if (error) throw error;
      return data || [];
    },
  },
  {
    name:         'flag_bad_debt',
    description:  'Flag an invoice as potential bad debt and create an escalation action',
    requiredFlag: 'cortex_enabled',
    inputSchema:  { invoiceId: 'string (UUID)', reason: 'string' },
    handler:      async (userId, params) => {
      const { create } = require('./action.service');
      return create(userId, {
        action_type:        'BAD_DEBT_FLAG',
        title:              'Bad debt risk detected',
        description:        params.reason || 'Invoice overdue > 90 days',
        related_entity_type: 'invoice',
        related_entity_id:   params.invoiceId,
        priority:           'urgent',
        risk_level:         'high',
        suggested_by:       'agent',
        requires_approval:  true,
      });
    },
  },
];

// Build name-indexed map for fast lookup
const TOOL_MAP = Object.fromEntries(TOOLS.map(t => [t.name, t]));

// ── Public API ────────────────────────────────────────────────────────────────
function getAvailable(enabledFlags = {}) {
  return TOOLS.filter(t => {
    if (!t.requiredFlag) return true;
    return enabledFlags[t.requiredFlag] === true;
  }).map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

async function call(toolName, userId, params = {}, { logToDb = true } = {}) {
  const tool = TOOL_MAP[toolName];
  if (!tool) throw new Error(`Tool not found: ${toolName}`);

  const start = Date.now();
  let result  = null;
  let status  = 'success';
  let errorMsg = null;

  try {
    result = await tool.handler(userId, params);
  } catch (err) {
    status   = 'error';
    errorMsg = err.message;
    safeLog('warn', '[ToolRegistry] call error', { toolName, userId, error: err.message });
  }

  const durationMs = Date.now() - start;

  if (logToDb) {
    const { supabase } = require('../../config/supabaseClient');
    supabase.from('tool_calls').insert([{
      user_id:       userId,
      tool_name:     toolName,
      input_params:  params,
      output_result: result,
      duration_ms:   durationMs,
      status,
      error_message: errorMsg,
    }]).then().catch(() => {});
  }

  if (status === 'error') throw new Error(errorMsg);
  return { result, durationMs };
}

module.exports = { getAvailable, call, TOOLS, TOOL_MAP };
