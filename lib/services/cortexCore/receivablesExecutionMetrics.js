// FILE: lib/services/cortexCore/receivablesExecutionMetrics.js
//
// Pure aggregation logic for GET /api/cortex/health's `receivables_execution`
// field (Phase E of the "Verified Execution Loop V1 — Receivables" initiative).
// Follows the exact convention established by actionTypeBreakdown.js:
// zero DB calls, zero LLM calls, pure grouping/rate-math over already-fetched
// arrays so it is unit-testable without the real HTTP server or a DB.
//
// Input shapes match exactly what the route's Supabase queries return:
//   supabase.from('execution_records').select('channel, status').eq('user_id', userId)
//     -> array of { channel, status } rows (channel in 'whatsapp'|'test';
//        status in 'queued'|'sent'|'delivered'|'failed'|'read' — see
//        migrations/014_receivables_execution.sql)
//   supabase.from('promises').select('status').eq('user_id', userId)
//     -> array of { status } rows (status in 'active'|'kept'|'broken'|'rescheduled'
//        — see migrations/001_cortex_foundation.sql)
//
// This directly addresses the Phase C carry-forward concern: ai_actions.status
// = 'done' does NOT reliably mean a real message was sent — execution_records
// .channel ('whatsapp' = real, 'test' = simulated) is the source of truth, and
// this breakdown surfaces that distinction to operators at a glance.

'use strict';

function buildReceivablesExecutionMetrics({ executionRecords, promises } = {}) {
  const records = executionRecords || [];
  const promiseRows = promises || [];

  const byChannel = {};
  const byStatus = {};
  records.forEach(r => {
    const channel = r.channel || 'unknown';
    const status = r.status || 'unknown';
    byChannel[channel] = (byChannel[channel] || 0) + 1;
    byStatus[status] = (byStatus[status] || 0) + 1;
  });

  const promisesByStatus = { active: 0, kept: 0, broken: 0, rescheduled: 0 };
  promiseRows.forEach(p => {
    const status = p.status;
    if (status && Object.prototype.hasOwnProperty.call(promisesByStatus, status)) {
      promisesByStatus[status]++;
    } else {
      promisesByStatus.unknown = (promisesByStatus.unknown || 0) + 1;
    }
  });

  const keptPlusBroken = promisesByStatus.kept + promisesByStatus.broken;
  const promiseKeptRate = keptPlusBroken > 0
    ? Math.round((promisesByStatus.kept / keptPlusBroken) * 100)
    : null;

  return {
    execution_records: {
      total: records.length,
      by_channel: byChannel,
      by_status: byStatus,
    },
    promises: {
      total: promiseRows.length,
      by_status: promisesByStatus,
      promise_kept_rate: promiseKeptRate, // null if not enough data (kept+broken === 0)
    },
  };
}

module.exports = { buildReceivablesExecutionMetrics };
