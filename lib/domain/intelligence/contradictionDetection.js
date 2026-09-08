// FILE: lib/domain/intelligence/contradictionDetection.js
// STARLANE Day 2 Multidimensional Reality Intelligence — Part 12:
// Contradiction Detection.
//
// detectContradictions(userId) looks for REAL data inconsistencies. A real,
// organic example was confirmed against the live dev DATABASE_URL on
// 2026-09-08: invoices with payment_status='Paid' that have NO CONFIRMED
// payment_allocations row backing them (in one case payment_amount is even
// NULL) — e.g. invoice becd360b-f7d8-486f-99c7-454ead7984d6 for tenant
// ece4ca68-da30-47f8-9c97-cd99724b1c35. This is the primary, real, organic
// contradiction this module is built around — not a constructed fixture.
//
// A second, structural contradiction type is also checked: a business_exposure
// row in REJECTED/SUPERSEDED state that still has real world_events linked to
// its world_entity (i.e. an event exists that WOULD have matched, had the
// exposure not been rejected) — this reuses
// interactionRules.js's ruleRejectedExposureWouldHaveMatched rather than
// duplicating that check.

const { getPool } = require('../../db/pg');
const { ruleRejectedExposureWouldHaveMatched } = require('./interactionRules');

async function detectPaidInvoicesWithoutEvidence(userId) {
  const pool = getPool();
  const res = await pool.query(
    `SELECT i.id, i.customer_name, i.payment_status, i.payment_amount, i.invoice_amount
     FROM invoices i
     WHERE i.user_id = $1 AND i.payment_status = 'Paid'
       AND NOT EXISTS (
         SELECT 1 FROM payment_allocations pa
         WHERE pa.invoice_id = i.id AND pa.allocation_status = 'CONFIRMED'
       )`,
    [userId]
  );
  return res.rows.map(r => ({
    type: 'PAID_INVOICE_WITHOUT_CONFIRMED_EVIDENCE',
    severity: 'MODERATE',
    claim: `invoice ${r.id} (customer "${r.customer_name}") is marked payment_status='Paid'`,
    contradiction: 'no CONFIRMED payment_allocations row exists to evidence this payment',
    evidence: [
      { table: 'invoices', id: r.id, payment_status: r.payment_status, payment_amount: r.payment_amount, invoice_amount: r.invoice_amount },
      { table: 'payment_allocations', note: 'zero CONFIRMED rows found for this invoice_id' },
    ],
    recommended_action: 'Manually verify this payment before treating it as fully reconciled revenue.',
  }));
}

async function detectRejectedExposuresWithLiveEvents(userId) {
  const pool = getPool();
  const expRes = await pool.query(
    `SELECT * FROM business_exposure WHERE user_id = $1 AND verification_status IN ('REJECTED','SUPERSEDED')`,
    [userId]
  );
  const contradictions = [];
  for (const exposure of expRes.rows) {
    const ruleResult = ruleRejectedExposureWouldHaveMatched(exposure);
    if (!ruleResult.triggered) continue;
    const evRes = await pool.query(
      `SELECT we.id, we.event_type, we.observed_at FROM world_events we
       JOIN world_event_entities wee ON wee.event_id = we.id
       WHERE wee.entity_id = $1`,
      [exposure.world_entity_id]
    );
    if (evRes.rows.length > 0) {
      contradictions.push({
        type: 'REJECTED_EXPOSURE_WITH_LIVE_MATCHING_EVENT',
        severity: 'WEAK',
        claim: `business_exposure ${exposure.id} is ${exposure.verification_status}, so it correctly produces no live signal`,
        contradiction: `${evRes.rows.length} real world_event(s) exist that are linked to the same world_entity and would otherwise have matched this exposure`,
        evidence: [
          { table: 'business_exposure', id: exposure.id, verification_status: exposure.verification_status },
          ...evRes.rows.map(e => ({ table: 'world_events', id: e.id, event_type: e.event_type, observed_at: e.observed_at })),
        ],
        recommended_action: 'No action required if the rejection was deliberate — this entry exists so the rejection is visible and re-reviewable, not silently forgotten.',
      });
    }
  }
  return contradictions;
}

// STARLANE Temporal Intelligence — Part 41: Temporal contradiction detection.
// Reuses this file's existing pattern/style (query real rows, return a
// structured {type,severity,claim,contradiction,evidence,recommended_action}
// item) rather than duplicating it. Detects impossible chronology:
//   - a payment_allocations row whose allocated_at predates the invoice's
//     own invoice_date (payment recorded before the invoice existed)
//   - a customer_score_history row whose recorded_at predates the customer's
//     own created_at (a score recorded before the customer record existed)
async function detectPaymentBeforeInvoice(userId) {
  const pool = getPool();
  const res = await pool.query(
    `SELECT pa.id AS allocation_id, pa.invoice_id, pa.created_at AS allocated_at, i.invoice_date, i.customer_name
     FROM payment_allocations pa
     JOIN invoices i ON i.id = pa.invoice_id
     WHERE pa.user_id = $1 AND i.invoice_date IS NOT NULL AND pa.created_at IS NOT NULL
       AND pa.created_at < i.invoice_date::timestamptz`,
    [userId]
  );
  return res.rows.map(r => ({
    type: 'PAYMENT_ALLOCATED_BEFORE_INVOICE_CREATED',
    severity: 'STRONG',
    claim: `payment_allocations row ${r.allocation_id} was recorded at ${r.allocated_at}`,
    contradiction: `this predates invoice ${r.invoice_id}'s own invoice_date (${r.invoice_date}) — a payment cannot be allocated before the invoice existed`,
    evidence: [
      { table: 'payment_allocations', id: r.allocation_id, created_at: r.allocated_at },
      { table: 'invoices', id: r.invoice_id, invoice_date: r.invoice_date, customer_name: r.customer_name },
    ],
    recommended_action: 'Check for a data-entry or backfill timestamp error on one of these two rows.',
  }));
}

async function detectScoreHistoryBeforeCustomerCreated(userId) {
  const pool = getPool();
  const res = await pool.query(
    `SELECT csh.id AS history_id, csh.recorded_at, c.id AS customer_id, c.created_at AS customer_created_at, c.name AS customer_name
     FROM customer_score_history csh
     JOIN customers c ON c.id = csh.customer_id
     WHERE csh.user_id = $1 AND c.created_at IS NOT NULL AND csh.recorded_at < c.created_at`,
    [userId]
  );
  return res.rows.map(r => ({
    type: 'SCORE_HISTORY_BEFORE_CUSTOMER_CREATED',
    severity: 'STRONG',
    claim: `customer_score_history row ${r.history_id} was recorded at ${r.recorded_at}`,
    contradiction: `this predates customer ${r.customer_id}'s own created_at (${r.customer_created_at}) — a score cannot exist before the customer record does`,
    evidence: [
      { table: 'customer_score_history', id: r.history_id, recorded_at: r.recorded_at },
      { table: 'customers', id: r.customer_id, created_at: r.customer_created_at, customer_name: r.customer_name },
    ],
    recommended_action: 'Check for a backfill/import timestamp error.',
  }));
}

async function detectTemporalContradictions(userId) {
  if (!userId) throw new Error('detectTemporalContradictions: userId is required');
  const [paymentBeforeInvoice, scoreBeforeCustomer] = await Promise.all([
    detectPaymentBeforeInvoice(userId).catch(e => { return []; }),
    detectScoreHistoryBeforeCustomerCreated(userId).catch(e => { return []; }),
  ]);
  const contradictions = [...paymentBeforeInvoice, ...scoreBeforeCustomer];
  return {
    userId,
    contradictionCount: contradictions.length,
    contradictions,
    generatedAt: new Date().toISOString(),
  };
}

async function detectContradictions(userId) {
  if (!userId) throw new Error('detectContradictions: userId is required');
  const [paidWithoutEvidence, rejectedWithEvents] = await Promise.all([
    detectPaidInvoicesWithoutEvidence(userId),
    detectRejectedExposuresWithLiveEvents(userId),
  ]);
  const contradictions = [...paidWithoutEvidence, ...rejectedWithEvents];
  return {
    userId,
    contradictionCount: contradictions.length,
    contradictions,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = {
  detectContradictions,
  detectPaidInvoicesWithoutEvidence,
  detectRejectedExposuresWithLiveEvents,
  detectTemporalContradictions,
  detectPaymentBeforeInvoice,
  detectScoreHistoryBeforeCustomerCreated,
};
