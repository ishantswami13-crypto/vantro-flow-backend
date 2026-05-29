// FILE: lib/services/orchestrator/commandBus.service.js
// Routes named commands to their registered handlers.
// Every dispatch is logged to tool_calls for audit + observability.
// Never throws — returns { success, result, durationMs } always.
const { supabase } = require('../../config/supabaseClient');
const { safeLog }  = require('../../observability/logger');

// ── Handler registry ──────────────────────────────────────────────────────────
// Populated lazily to avoid circular requires at module load time.
let _handlers = null;

function getHandlers() {
  if (_handlers) return _handlers;
  const { recalculate }   = require('./scoring.service');
  const { create: createAction } = require('./action.service');
  const { createFromSale, createFromPurchase, confirmInflow } = require('./cashflow.service');

  _handlers = {
    SCORE_CUSTOMER: async (userId, { customerId }) => {
      if (!customerId) throw new Error('customerId required');
      await recalculate(userId, customerId);
      return { scored: true, customerId };
    },

    CREATE_ACTION: async (userId, payload) => {
      const action = await createAction(userId, payload);
      return { actionId: action?.id };
    },

    CASHFLOW_FROM_SALE: async (userId, { sale, totalAmount, paidAmount }) => {
      await createFromSale(userId, sale, totalAmount, paidAmount);
      return { recorded: true };
    },

    CASHFLOW_FROM_PURCHASE: async (userId, { purchase, totalAmount, paidAmount }) => {
      await createFromPurchase(userId, purchase, totalAmount, paidAmount);
      return { recorded: true };
    },

    CONFIRM_INFLOW: async (userId, { invoiceId, amount, actualDate }) => {
      await confirmInflow(userId, invoiceId, amount, actualDate);
      return { confirmed: true };
    },

    REMEMBER: async (userId, { entityType, entityId, key, value, source }) => {
      const { error } = await supabase
        .from('business_memory')
        .upsert([{
          user_id:      userId,
          entity_type:  entityType || 'global',
          entity_id:    entityId   || null,
          memory_key:   key,
          memory_value: typeof value === 'object' ? value : { v: value },
          source:       source || 'rule_engine',
          updated_at:   new Date().toISOString(),
        }], { onConflict: 'user_id,entity_type,entity_id,memory_key' });
      if (error) throw error;
      return { remembered: true, key };
    },
  };

  return _handlers;
}

// ── Main dispatch ─────────────────────────────────────────────────────────────
async function dispatch(userId, commandName, payload = {}) {
  const start = Date.now();
  let result  = null;
  let status  = 'success';
  let errorMsg = null;

  try {
    const handlers = getHandlers();
    const handler  = handlers[commandName];
    if (!handler) throw new Error(`Unknown command: ${commandName}`);
    result = await handler(userId, payload);
  } catch (err) {
    status   = 'error';
    errorMsg = err.message;
    safeLog('warn', '[CommandBus] dispatch error', { commandName, userId, error: err.message });
  }

  const durationMs = Date.now() - start;

  // Fire-and-forget audit log — never block the response
  supabase.from('tool_calls').insert([{
    user_id:       userId,
    tool_name:     commandName,
    input_params:  payload,
    output_result: result,
    duration_ms:   durationMs,
    status,
    error_message: errorMsg,
  }]).then().catch(() => {});

  return { success: status === 'success', result, durationMs, error: errorMsg };
}

// ── Convenience: register a custom handler at runtime ────────────────────────
function register(commandName, handlerFn) {
  const handlers = getHandlers();
  handlers[commandName] = handlerFn;
}

module.exports = { dispatch, register };
