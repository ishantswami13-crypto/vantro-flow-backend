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

module.exports = { detectContradictions, detectPaidInvoicesWithoutEvidence, detectRejectedExposuresWithLiveEvents };
