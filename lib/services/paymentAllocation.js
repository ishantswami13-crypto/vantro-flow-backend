// FILE: lib/services/paymentAllocation.js
//
// Day 1 sprint (2026-09-07): service layer for migrations/020_payment_allocations.sql.
//
// Purpose: record that an invoice/sale belonging to customer A was actually
// paid by a distinct entity B (a related company, director, distributor, or
// unrelated third party), WITHOUT ever merging A and B into one customer
// record and WITHOUT ever guessing an entity relationship.
//
// This module is strictly additive evidence. It never replaces or bypasses
// the existing invoices.payment_status / invoices.payment_amount (or the
// sales.status / sales.paid_amount) aggregate fields — those remain the
// single source of truth for "is this invoice paid," read by
// evaluationAgent.js / collectionsAgent.js exactly as before. This module's
// markInvoicePaidFromAllocation() reuses the existing update path rather
// than duplicating that logic.
const { supabase } = require('../config/supabaseClient');
const { safeLog } = require('../observability/logger');

const VALID_PAYER_TYPES = ['SAME_AS_CUSTOMER', 'RELATED_ENTITY', 'THIRD_PARTY', 'UNKNOWN'];
const VALID_STATUSES = ['UNALLOCATED', 'AMBIGUOUS', 'CONFIRMED', 'REVERSED'];

function normalize(str) {
  return String(str || '').trim().toLowerCase();
}

/**
 * Record a payment allocation: a payment from `payerReference` (B) being
 * applied against an invoice/sale belonging to a customer (A).
 *
 * Deterministic-only matching: this function never guesses. Callers must
 * pass an explicit payerType. If the match between payer and invoice is
 * ambiguous (e.g. caller isn't sure this is really the right invoice, or
 * multiple invoices are equally plausible), pass allocationStatus:
 * 'AMBIGUOUS' explicitly — this function will NOT auto-upgrade it to
 * CONFIRMED. Only an explicit confirm (confirmedByUserId set, and
 * allocationStatus === 'CONFIRMED' passed deliberately, or a later call to
 * confirmAllocation()) marks it confirmed.
 *
 * @param {object} params
 * @param {string} params.userId - tenant scope, required
 * @param {string} [params.invoiceId] - exactly one of invoiceId/saleId required
 * @param {number} [params.saleId]
 * @param {string} params.payerReference - free text name/identifier for B
 * @param {string} params.payerType - one of VALID_PAYER_TYPES, required, never inferred by this function
 * @param {number} params.amount
 * @param {string} [params.paymentDate]
 * @param {string} [params.paymentMethod]
 * @param {string} [params.evidenceNotes] - why this payment was matched to this invoice
 * @param {string} [params.allocationStatus] - defaults to 'UNALLOCATED'; pass 'AMBIGUOUS' or 'CONFIRMED' explicitly
 * @param {string} [params.payerCustomerId] - optional FK, only when B is genuinely a known customer row
 * @param {string} [params.payerSupplierId] - optional FK, only when B is genuinely a known supplier row
 * @param {string} [params.confirmedByUserId] - required if allocationStatus === 'CONFIRMED'
 */
async function recordPaymentAllocation(params) {
  const {
    userId,
    invoiceId = null,
    saleId = null,
    payerReference,
    payerType,
    amount,
    paymentDate = null,
    paymentMethod = null,
    evidenceNotes = null,
    allocationStatus = 'UNALLOCATED',
    payerCustomerId = null,
    payerSupplierId = null,
    confirmedByUserId = null,
  } = params;

  if (!userId) throw new Error('recordPaymentAllocation: userId is required');
  if (!invoiceId && !saleId) throw new Error('recordPaymentAllocation: exactly one of invoiceId/saleId is required');
  if (invoiceId && saleId) throw new Error('recordPaymentAllocation: invoiceId and saleId are mutually exclusive');
  if (!payerReference) throw new Error('recordPaymentAllocation: payerReference is required');
  if (!VALID_PAYER_TYPES.includes(payerType)) {
    throw new Error(`recordPaymentAllocation: payerType must be one of ${VALID_PAYER_TYPES.join(', ')} — never auto-guessed`);
  }
  if (!VALID_STATUSES.includes(allocationStatus)) {
    throw new Error(`recordPaymentAllocation: allocationStatus must be one of ${VALID_STATUSES.join(', ')}`);
  }
  if (!(Number(amount) > 0)) throw new Error('recordPaymentAllocation: amount must be > 0');

  // Never silently auto-confirm: CONFIRMED requires an explicit confirming user.
  if (allocationStatus === 'CONFIRMED' && !confirmedByUserId) {
    throw new Error('recordPaymentAllocation: allocationStatus=CONFIRMED requires confirmedByUserId — never auto-confirmed');
  }

  const row = {
    user_id: userId,
    invoice_id: invoiceId,
    sale_id: saleId,
    payer_reference: payerReference,
    payer_customer_id: payerCustomerId,
    payer_supplier_id: payerSupplierId,
    payer_type: payerType,
    amount,
    payment_date: paymentDate,
    payment_method: paymentMethod,
    evidence_notes: evidenceNotes,
    allocation_status: allocationStatus,
    confirmed_by_user_id: allocationStatus === 'CONFIRMED' ? confirmedByUserId : null,
    confirmed_at: allocationStatus === 'CONFIRMED' ? new Date().toISOString() : null,
  };

  const { data, error } = await supabase
    .from('payment_allocations')
    .insert([row])
    .select()
    .single();

  if (error) {
    safeLog('error', '[paymentAllocation] recordPaymentAllocation failed', { error: error.message, userId });
    throw error;
  }

  safeLog('info', '[paymentAllocation] recorded', {
    id: data.id, userId, invoiceId, saleId, payerReference, payerType, allocationStatus,
  });

  return data;
}

/**
 * Explicit human confirmation of a previously UNALLOCATED/AMBIGUOUS row.
 * This is the only path (besides passing allocationStatus:'CONFIRMED' up
 * front with a confirmedByUserId) by which a row becomes CONFIRMED.
 */
async function confirmAllocation({ allocationId, userId, confirmedByUserId, evidenceNotes }) {
  if (!allocationId) throw new Error('confirmAllocation: allocationId is required');
  if (!userId) throw new Error('confirmAllocation: userId is required');
  if (!confirmedByUserId) throw new Error('confirmAllocation: confirmedByUserId is required — confirmation must be explicit');

  const { data: existing, error: fetchErr } = await supabase
    .from('payment_allocations')
    .select('*')
    .eq('id', allocationId)
    .eq('user_id', userId)
    .maybeSingle();

  if (fetchErr) throw fetchErr;
  if (!existing) throw new Error('confirmAllocation: allocation not found for this tenant');
  if (existing.allocation_status === 'REVERSED') {
    throw new Error('confirmAllocation: cannot confirm a reversed allocation');
  }

  const update = {
    allocation_status: 'CONFIRMED',
    confirmed_by_user_id: confirmedByUserId,
    confirmed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  if (evidenceNotes) update.evidence_notes = evidenceNotes;

  const { data, error } = await supabase
    .from('payment_allocations')
    .update(update)
    .eq('id', allocationId)
    .eq('user_id', userId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Non-destructive reversal — history is preserved (row stays, status flips
 * to REVERSED), never deleted.
 */
async function reverseAllocation({ allocationId, userId, reversedByUserId }) {
  if (!allocationId) throw new Error('reverseAllocation: allocationId is required');
  if (!userId) throw new Error('reverseAllocation: userId is required');
  if (!reversedByUserId) throw new Error('reverseAllocation: reversedByUserId is required');

  const { data, error } = await supabase
    .from('payment_allocations')
    .update({
      allocation_status: 'REVERSED',
      reversed_by_user_id: reversedByUserId,
      reversed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', allocationId)
    .eq('user_id', userId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Provenance query: "why was this payment allocated to this invoice?"
 * Returns the full evidence trail for a given allocation, tenant-scoped.
 */
async function getAllocationEvidence({ allocationId, userId }) {
  if (!allocationId) throw new Error('getAllocationEvidence: allocationId is required');
  if (!userId) throw new Error('getAllocationEvidence: userId is required');

  const { data, error } = await supabase
    .from('payment_allocations')
    .select('*')
    .eq('id', allocationId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  return {
    allocationId: data.id,
    invoiceId: data.invoice_id,
    saleId: data.sale_id,
    payerReference: data.payer_reference,
    payerType: data.payer_type,
    amount: Number(data.amount),
    allocationStatus: data.allocation_status,
    evidenceNotes: data.evidence_notes,
    confirmedByUserId: data.confirmed_by_user_id,
    confirmedAt: data.confirmed_at,
    reversedByUserId: data.reversed_by_user_id,
    reversedAt: data.reversed_at,
    createdAt: data.created_at,
  };
}

/**
 * Observed-pattern query: "who has historically paid for customer A?"
 * Aggregates CONFIRMED allocations only. Explicitly framed as an observed
 * pattern, never as ownership/corporate-relationship — field name is
 * `observedPayers`, never `relatedEntities`/`owners`.
 *
 * Matches invoices/sales by customer_name (the codebase's de facto customer
 * key on both tables) within the tenant, then aggregates confirmed
 * allocations against those invoices/sales.
 */
async function getObservedPayersForCustomer({ userId, customerName }) {
  if (!userId) throw new Error('getObservedPayersForCustomer: userId is required');
  if (!customerName) throw new Error('getObservedPayersForCustomer: customerName is required');

  const target = normalize(customerName);

  const [{ data: invoices, error: invErr }, { data: sales, error: saleErr }] = await Promise.all([
    supabase.from('invoices').select('id, customer_name').eq('user_id', userId),
    supabase.from('sales').select('id, customer_name').eq('user_id', userId),
  ]);
  if (invErr) throw invErr;
  if (saleErr) throw saleErr;

  const invoiceIds = (invoices || []).filter(i => normalize(i.customer_name) === target).map(i => i.id);
  const saleIds = (sales || []).filter(s => normalize(s.customer_name) === target).map(s => s.id);

  if (invoiceIds.length === 0 && saleIds.length === 0) {
    return { customerName, observedPayers: [] };
  }

  const { data: allocations, error } = await supabase
    .from('payment_allocations')
    .select('*')
    .eq('user_id', userId)
    .eq('allocation_status', 'CONFIRMED');

  if (error) throw error;

  const relevant = (allocations || []).filter(a =>
    (a.invoice_id && invoiceIds.includes(a.invoice_id)) ||
    (a.sale_id && saleIds.includes(a.sale_id))
  );

  const byPayer = new Map();
  for (const a of relevant) {
    const key = a.payer_reference;
    if (!byPayer.has(key)) {
      byPayer.set(key, { payer_reference: key, count: 0, total_amount: 0 });
    }
    const entry = byPayer.get(key);
    entry.count += 1;
    entry.total_amount += Number(a.amount) || 0;
  }

  return {
    customerName,
    // Observational only — this is NOT an ownership/relationship claim.
    observedPayers: Array.from(byPayer.values()).sort((a, b) => b.count - a.count),
  };
}

/**
 * Once an allocation is CONFIRMED, reflect it in the existing aggregate
 * payment_status/payment_amount fields on invoices/sales — reusing the
 * existing update path rather than duplicating "is this paid" logic.
 * This does NOT change how evaluationAgent.js/collectionsAgent.js read
 * "is this invoice paid" — it just keeps those existing fields accurate.
 */
async function markInvoicePaidFromAllocation({ allocationId, userId }) {
  if (!allocationId) throw new Error('markInvoicePaidFromAllocation: allocationId is required');
  if (!userId) throw new Error('markInvoicePaidFromAllocation: userId is required');

  const { data: allocation, error: fetchErr } = await supabase
    .from('payment_allocations')
    .select('*')
    .eq('id', allocationId)
    .eq('user_id', userId)
    .maybeSingle();
  if (fetchErr) throw fetchErr;
  if (!allocation) throw new Error('markInvoicePaidFromAllocation: allocation not found');
  if (allocation.allocation_status !== 'CONFIRMED') {
    throw new Error('markInvoicePaidFromAllocation: allocation must be CONFIRMED first');
  }

  if (allocation.invoice_id) {
    const { data, error } = await supabase
      .from('invoices')
      .update({
        payment_status: 'Paid',
        payment_amount: allocation.amount,
        payment_date: allocation.payment_date || new Date().toISOString().split('T')[0],
        payment_method: allocation.payment_method || null,
        payment_notes: allocation.evidence_notes || null,
      })
      .eq('id', allocation.invoice_id)
      .eq('user_id', userId)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  if (allocation.sale_id) {
    const { data, error } = await supabase
      .from('sales')
      .update({
        status: 'paid',
        paid_amount: allocation.amount,
      })
      .eq('id', allocation.sale_id)
      .eq('user_id', userId)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  return null;
}

module.exports = {
  VALID_PAYER_TYPES,
  VALID_STATUSES,
  recordPaymentAllocation,
  confirmAllocation,
  reverseAllocation,
  getAllocationEvidence,
  getObservedPayersForCustomer,
  markInvoicePaidFromAllocation,
};
