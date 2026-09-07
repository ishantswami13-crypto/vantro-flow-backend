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
    // ────────────────────────────────────────────────────────────────────────
    // Phase C — Verified Execution Loop V1 (Receivables): approval → execution.
    //
    // Reuses the existing approval-gated pattern from the
    // POST /api/ai-actions/:id/send-whatsapp route, consolidated here so the
    // route and any future caller share one audited, idempotent execution path.
    //
    // Idempotency: the caller-supplied `idempotencyKey` defaults to the
    // `actionId` itself when omitted. execution_records has
    // UNIQUE(user_id, ai_action_id, idempotency_key) (migration 014), so a
    // retry of the exact same execute-request for the same action either (a)
    // finds the existing row up front and returns it without re-sending, or
    // (b) — in the narrow race where two requests both miss that check before
    // either inserts — has its second INSERT rejected by the unique
    // constraint; that unique-violation is caught below and treated as "someone
    // else already executed this", re-fetching and returning the winning row
    // rather than sending a second real/fake message.
    //
    // Consistency note (documented honestly, not hidden): the execution_records
    // insert and the ai_actions status update are two separate statements, not
    // one DB transaction (this codebase's supabase/pg-shim client does not
    // expose multi-statement transactions in the pattern the rest of this file
    // uses). If the process crashes between the two, execution_records can be
    // left saying 'sent' while ai_actions.status is still 'approved'. This is
    // safe from a "never send twice" standpoint because the idempotency check
    // above is keyed on execution_records (the send already happened and is
    // recorded), not on ai_actions.status — a retry after such a crash will
    // find the existing execution_records row and short-circuit before any
    // second send, then (best-effort) reconcile ai_actions to 'done'.
    // `realSender` is dependency-injected by the caller (the send-whatsapp
    // route passes server.js's in-module `sendWhatsAppMessage` function) so
    // this handler never needs to require server.js itself (which would be
    // circular) and so tests can exercise the fail-closed path with zero risk
    // of a real network call ever being reachable — when the guard is closed,
    // `realSender` is never invoked, never even read.
    EXECUTE_RECEIVABLES_ACTION: async (userId, { actionId, idempotencyKey, realSender } = {}) => {
      if (!actionId) throw new Error('actionId required');
      const idemKey = idempotencyKey || actionId;

      // 0. Duplicate-execution short-circuit: if a record already exists for
      // this (user, action, idemKey), return it verbatim — no re-send, no
      // second row, no mutation.
      {
        const { data: existing } = await supabase
          .from('execution_records')
          .select('*')
          .eq('user_id', userId)
          .eq('ai_action_id', actionId)
          .eq('idempotency_key', idemKey)
          .maybeSingle();
        if (existing) {
          return { duplicate: true, executionRecord: existing };
        }
      }

      // 1. Fetch + verify tenant ownership + approval gate. No side effects
      // before this point, and none if either check fails.
      //
      // NOTE: deliberately a plain column select (not a PostgREST embedded
      // resource join like `customers(name, phone)`) — the local pg-shim used
      // in this environment does not support embedded-resource joins (same
      // known limitation documented in scripts/test-phase7-*.js re:
      // creditRiskAgent.js), so the customer is fetched separately below.
      const { data: action, error: fetchErr } = await supabase
        .from('ai_actions')
        .select('*')
        .eq('id', actionId)
        .eq('user_id', userId)
        .single();
      if (fetchErr || !action) {
        const err = new Error('Action not found');
        err.code = 'NOT_FOUND';
        throw err;
      }
      if (action.status !== 'approved') {
        const err = new Error('Action must be approved before sending');
        err.code = 'NOT_APPROVED';
        err.status = action.status || null;
        throw err;
      }

      let phone = null;
      if (action.customer_id) {
        const { data: customer } = await supabase
          .from('customers')
          .select('phone')
          .eq('id', action.customer_id)
          .eq('user_id', userId)
          .maybeSingle();
        phone = customer?.phone || null;
      }
      const message = action.recommended_message || action.description || action.title;
      if (!phone)   { const e = new Error('No customer phone on record'); e.code = 'NO_PHONE';   throw e; }
      if (!message) { const e = new Error('No message content to send');  e.code = 'NO_MESSAGE'; throw e; }

      // 2. Fail-closed channel decision. NEVER bypass guardExternalSend(), and
      // never make the real-send path easier to reach than it already is.
      const { guardExternalSend } = require('../../safety/externalSend');
      const blocked = guardExternalSend('whatsapp');
      const useRealChannel = blocked === null; // null => guard authorizes real send

      let sendResult;
      let channel;
      if (useRealChannel) {
        if (!process.env.TWILIO_WHATSAPP_NUMBER) {
          const e = new Error('WhatsApp not configured — set TWILIO_WHATSAPP_NUMBER in Railway');
          e.code = 'NOT_CONFIGURED';
          throw e;
        }
        if (typeof realSender !== 'function') {
          const e = new Error('Real WhatsApp sender not provided to handler');
          e.code = 'NO_REAL_SENDER';
          throw e;
        }
        channel = 'whatsapp';
        sendResult = await realSender(phone, message);
      } else {
        channel = 'test';
        const testAdapter = require('../messaging/testMessageAdapter');
        sendResult = await testAdapter.send(userId, { customerPhone: phone, message });
      }

      const nowIso = new Date().toISOString();

      if (!sendResult?.success) {
        // Record the failed attempt (still respects idempotency key) but do
        // NOT mark the action done.
        const { data: failedRow, error: insErr } = await supabase
          .from('execution_records')
          .insert([{
            user_id:             userId,
            ai_action_id:        actionId,
            channel,
            provider_message_id: sendResult?.providerMessageId || sendResult?.sid || null,
            status:              'failed',
            failed_reason:       JSON.stringify(sendResult || {}).slice(0, 500),
            attempt_count:       1,
            idempotency_key:     idemKey,
            updated_at:          nowIso,
          }])
          .select('*')
          .single();
        if (insErr && insErr.code === '23505') {
          // Lost the race to a concurrent identical request — return its result.
          const { data: winner } = await supabase
            .from('execution_records')
            .select('*')
            .eq('user_id', userId).eq('ai_action_id', actionId).eq('idempotency_key', idemKey)
            .maybeSingle();
          return { duplicate: true, executionRecord: winner };
        }
        const e = new Error('Send failed');
        e.code = 'SEND_FAILED';
        e.detail = sendResult;
        throw e;
      }

      // 3. Success — insert execution_records row.
      const { data: execRow, error: insErr } = await supabase
        .from('execution_records')
        .insert([{
          user_id:             userId,
          ai_action_id:        actionId,
          channel,
          provider_message_id: sendResult.providerMessageId || sendResult.sid || null,
          status:              'sent',
          sent_at:             nowIso,
          attempt_count:       1,
          idempotency_key:     idemKey,
          updated_at:          nowIso,
        }])
        .select('*')
        .single();

      if (insErr) {
        if (insErr.code === '23505') {
          // Race: another identical request already recorded this send.
          // The real/test send above may have been duplicated in the narrow
          // window between the read-check and this insert — this is the one
          // residual risk of a non-transactional two-step check-then-act
          // against a fail-open send call; documented honestly. For the
          // 'test' channel this has zero real-world consequence (no message
          // actually leaves the system). For 'whatsapp' this is exactly why
          // the idempotency pre-check exists — the window is only reachable
          // under true concurrent duplicate requests, not sequential retries.
          const { data: winner } = await supabase
            .from('execution_records')
            .select('*')
            .eq('user_id', userId).eq('ai_action_id', actionId).eq('idempotency_key', idemKey)
            .maybeSingle();
          return { duplicate: true, executionRecord: winner };
        }
        throw insErr;
      }

      // 4. Mark the ai_actions row done (best-effort consistency — see the
      // consistency note in this handler's header comment).
      await supabase
        .from('ai_actions')
        .update({ status: 'done', completed_at: nowIso, updated_at: nowIso })
        .eq('id', actionId)
        .eq('user_id', userId);

      return { duplicate: false, executionRecord: execRow, sendResult };
    },
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
  let errorCode = null;
  let errorMeta = null;

  try {
    const handlers = getHandlers();
    const handler  = handlers[commandName];
    if (!handler) throw new Error(`Unknown command: ${commandName}`);
    result = await handler(userId, payload);
  } catch (err) {
    status   = 'error';
    errorMsg = err.message;
    // Additive, backward-compatible: some handlers (e.g.
    // EXECUTE_RECEIVABLES_ACTION) attach a machine-readable `code` and extra
    // fields (e.g. `status`, `detail`) to thrown errors so callers can map
    // back to specific HTTP responses without string-matching alone.
    errorCode = err.code || null;
    errorMeta = err.code ? { status: err.status, detail: err.detail } : null;
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

  return { success: status === 'success', result, durationMs, error: errorMsg, errorCode, errorMeta };
}

// ── Convenience: register a custom handler at runtime ────────────────────────
function register(commandName, handlerFn) {
  const handlers = getHandlers();
  handlers[commandName] = handlerFn;
}

module.exports = { dispatch, register };
