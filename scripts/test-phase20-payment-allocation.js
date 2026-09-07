// Phase 20 ("Payment Allocation Model — Day 1") verification.
// Covers the real-DB scenario: Customer A's invoice paid by distinct payer B,
// ambiguous-case rejection, observed-payer aggregation, tenant isolation.
//
// Run: node scripts/test-phase20-payment-allocation.js
require('dotenv').config();
const { randomUUID } = require('crypto');
const { supabase } = require('../lib/config/supabaseClient');
const {
  recordPaymentAllocation,
  confirmAllocation,
  getAllocationEvidence,
  getObservedPayersForCustomer,
  markInvoicePaidFromAllocation,
} = require('../lib/services/paymentAllocation');

let pass = 0, fail = 0;
function check(label, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}`);
  cond ? pass++ : fail++;
}

const USER_ID = randomUUID();
const OTHER_USER_ID = randomUUID(); // for tenant isolation test
const STAFF_USER_ID = randomUUID(); // "confirming" staff member

const createdInvoiceIds = [];
const createdAllocationIds = [];

async function cleanup() {
  if (createdAllocationIds.length) {
    await supabase.from('payment_allocations').delete().in('id', createdAllocationIds);
  }
  if (createdInvoiceIds.length) {
    await supabase.from('invoices').delete().in('id', createdInvoiceIds);
  }
  await supabase.from('users').delete().in('id', [USER_ID, OTHER_USER_ID]);
}

async function main() {
  try {
    // ── Setup: tenant user rows (invoices.user_id has an FK to users) ───
    await supabase.from('users').insert([
      { id: USER_ID, email: `phase20-${USER_ID}@test.local`, password_hash: 'x', business_name: 'Phase20 Tenant' },
      { id: OTHER_USER_ID, email: `phase20-other-${OTHER_USER_ID}@test.local`, password_hash: 'x', business_name: 'Phase20 Other Tenant' },
    ]);

    // ── Setup: Customer A's invoice for an F6 machine, ₹52,000 ──────────
    const { data: invoiceA, error: invErr } = await supabase
      .from('invoices')
      .insert([{
        user_id: USER_ID,
        customer_name: 'Customer A',
        invoice_amount: 52000,
        payment_status: 'Pending',
        invoice_number: 'INV-F6-TEST-1',
        notes: 'F6 machine',
      }])
      .select()
      .single();
    check('setup: invoice A created', !invErr && !!invoiceA);
    createdInvoiceIds.push(invoiceA.id);

    const originalCustomerName = invoiceA.customer_name;
    const originalInvoiceId = invoiceA.id;

    // ── Second invoice of A's, for the repeat-payer test ────────────────
    const { data: invoiceA2, error: invErr2 } = await supabase
      .from('invoices')
      .insert([{
        user_id: USER_ID,
        customer_name: 'Customer A',
        invoice_amount: 15000,
        payment_status: 'Pending',
        invoice_number: 'INV-F6-TEST-2',
        notes: 'Spare parts',
      }])
      .select()
      .single();
    check('setup: invoice A2 created', !invErr2 && !!invoiceA2);
    createdInvoiceIds.push(invoiceA2.id);

    // A decoy invoice with the SAME amount, for the ambiguous-match test
    const { data: decoyInvoice, error: decoyErr } = await supabase
      .from('invoices')
      .insert([{
        user_id: USER_ID,
        customer_name: 'Customer Z (unrelated)',
        invoice_amount: 52000,
        payment_status: 'Pending',
        invoice_number: 'INV-DECOY',
        notes: 'Unrelated invoice, same amount as A',
      }])
      .select()
      .single();
    check('setup: decoy invoice created', !decoyErr && !!decoyInvoice);
    createdInvoiceIds.push(decoyInvoice.id);

    // ── Scenario: payment of ₹52,000 arrives from Company B for A's invoice ─
    const allocation1 = await recordPaymentAllocation({
      userId: USER_ID,
      invoiceId: invoiceA.id,
      payerReference: 'Company B',
      payerType: 'THIRD_PARTY',
      amount: 52000,
      paymentDate: '2026-09-07',
      paymentMethod: 'bank_transfer',
      evidenceNotes: 'Amount matches exactly (₹52,000); bank statement references invoice INV-F6-TEST-1.',
      allocationStatus: 'CONFIRMED',
      confirmedByUserId: STAFF_USER_ID,
    });
    createdAllocationIds.push(allocation1.id);
    check('allocation recorded with THIRD_PARTY payer_type', allocation1.payer_type === 'THIRD_PARTY');
    check('allocation references invoice A, not a merged/new customer row', allocation1.invoice_id === invoiceA.id);
    check('allocation status is CONFIRMED after explicit confirmedByUserId', allocation1.allocation_status === 'CONFIRMED');

    // ── Invariant: A's invoice record is completely unchanged/unmerged ──
    const { data: invoiceAAfter } = await supabase.from('invoices').select('*').eq('id', invoiceA.id).single();
    check('invoice A customer_name unchanged (never overwritten with payer B)', invoiceAAfter.customer_name === originalCustomerName);
    check('invoice A id unchanged (no merge occurred)', invoiceAAfter.id === originalInvoiceId);
    check('invoice A payment_status NOT auto-changed by recordPaymentAllocation alone', invoiceAAfter.payment_status === 'Pending');

    // ── Provenance: "why was this payment allocated to this invoice?" ──
    const evidence = await getAllocationEvidence({ allocationId: allocation1.id, userId: USER_ID });
    check('evidence query returns a result', !!evidence);
    check('evidence explains the match ("amount matches exactly")', /amount matches exactly/i.test(evidence.evidenceNotes || ''));
    check('evidence correctly attributes payer as Company B, distinct from Customer A', evidence.payerReference === 'Company B');

    // ── Reuse existing payment_status update path via markInvoicePaidFromAllocation ──
    const updatedInvoice = await markInvoicePaidFromAllocation({ allocationId: allocation1.id, userId: USER_ID });
    check('markInvoicePaidFromAllocation sets invoices.payment_status=Paid (existing aggregate field, reused)', updatedInvoice.payment_status === 'Paid');
    check('markInvoicePaidFromAllocation sets invoices.payment_amount=52000', Number(updatedInvoice.payment_amount) === 52000);
    check('invoice customer_name still Customer A after paid-status update', updatedInvoice.customer_name === 'Customer A');

    // ── Ambiguous case: same amount could match invoice A OR the decoy ──
    // Caller does not know which invoice this really belongs to -> must not
    // auto-confirm. We simulate the caller correctly recognizing ambiguity
    // and recording it as AMBIGUOUS rather than guessing.
    const ambiguous = await recordPaymentAllocation({
      userId: USER_ID,
      invoiceId: decoyInvoice.id, // best-guess target, but marked ambiguous
      payerReference: 'Unknown Payer XYZ',
      payerType: 'UNKNOWN',
      amount: 52000,
      evidenceNotes: 'Amount ₹52,000 matches BOTH invoice A and the decoy invoice; no reference number on the bank statement to disambiguate.',
      allocationStatus: 'AMBIGUOUS',
    });
    createdAllocationIds.push(ambiguous.id);
    check('ambiguous case lands in AMBIGUOUS status, not auto-confirmed', ambiguous.allocation_status === 'AMBIGUOUS');
    check('ambiguous case has no confirmed_by_user_id', ambiguous.confirmed_by_user_id === null);
    check('ambiguous case has no confirmed_at', ambiguous.confirmed_at === null);

    // Attempting to pass CONFIRMED without a confirming user must throw.
    let threw = false;
    try {
      await recordPaymentAllocation({
        userId: USER_ID,
        invoiceId: decoyInvoice.id,
        payerReference: 'Sneaky Auto-Confirm',
        payerType: 'UNKNOWN',
        amount: 52000,
        allocationStatus: 'CONFIRMED',
        // confirmedByUserId deliberately omitted
      });
    } catch (e) {
      threw = true;
    }
    check('recordPaymentAllocation refuses CONFIRMED without confirmedByUserId (no silent auto-confirm)', threw);

    // Decoy invoice must remain untouched by the ambiguous allocation.
    const { data: decoyAfter } = await supabase.from('invoices').select('*').eq('id', decoyInvoice.id).single();
    check('decoy invoice payment_status untouched by ambiguous allocation', decoyAfter.payment_status === 'Pending');

    // ── Second confirmed B->A payment (different invoice) for the pattern query ──
    const allocation2 = await recordPaymentAllocation({
      userId: USER_ID,
      invoiceId: invoiceA2.id,
      payerReference: 'Company B',
      payerType: 'THIRD_PARTY',
      amount: 15000,
      paymentDate: '2026-09-10',
      paymentMethod: 'bank_transfer',
      evidenceNotes: 'Same payer as prior confirmed allocation; amount matches invoice INV-F6-TEST-2 exactly.',
      allocationStatus: 'CONFIRMED',
      confirmedByUserId: STAFF_USER_ID,
    });
    createdAllocationIds.push(allocation2.id);
    check('second B->A allocation confirmed', allocation2.allocation_status === 'CONFIRMED');

    // ── "Who commonly pays for A" — observed pattern, honestly framed ──
    const observed = await getObservedPayersForCustomer({ userId: USER_ID, customerName: 'Customer A' });
    check('getObservedPayersForCustomer returns observedPayers field (not relatedEntities/owners)', Array.isArray(observed.observedPayers));
    const companyB = observed.observedPayers.find(p => p.payer_reference === 'Company B');
    check('Company B appears in observed payers for Customer A', !!companyB);
    check('Company B observed count is 2 (two CONFIRMED allocations)', companyB && companyB.count === 2);
    check('Company B observed total_amount is 67000 (52000+15000)', companyB && Number(companyB.total_amount) === 67000);
    check('ambiguous/unconfirmed allocations excluded from observed pattern (Unknown Payer XYZ absent)',
      !observed.observedPayers.find(p => p.payer_reference === 'Unknown Payer XYZ'));

    // ── Field-naming invariant: never implies ownership ─────────────────
    const serialized = JSON.stringify(observed);
    check('observed-pattern output never uses "owns"/"relatedEntity"/"subsidiary" language',
      !/owns|relatedEntit|subsidiary/i.test(serialized));

    // ── Tenant isolation ─────────────────────────────────────────────────
    const otherTenantView = await getObservedPayersForCustomer({ userId: OTHER_USER_ID, customerName: 'Customer A' });
    check('a different tenant (OTHER_USER_ID) sees no observed payers for "Customer A" (tenant-scoped)', otherTenantView.observedPayers.length === 0);

    const { data: crossTenantAlloc } = await supabase
      .from('payment_allocations')
      .select('*')
      .eq('id', allocation1.id)
      .eq('user_id', OTHER_USER_ID)
      .maybeSingle();
    check('allocation row not visible under a different user_id filter (row-level tenant scoping)', !crossTenantAlloc);

    let otherTenantEvidenceThrew = false;
    const otherEvidence = await getAllocationEvidence({ allocationId: allocation1.id, userId: OTHER_USER_ID });
    check('getAllocationEvidence returns null for wrong tenant (never leaks cross-tenant evidence)', otherEvidence === null);

    // ── Extensibility check: schema allows multiple rows per invoice (partial payments) ──
    const partial1 = await recordPaymentAllocation({
      userId: USER_ID,
      invoiceId: invoiceA2.id,
      payerReference: 'Company B',
      payerType: 'THIRD_PARTY',
      amount: 5000,
      evidenceNotes: 'Partial payment, part 1 of 2',
      allocationStatus: 'UNALLOCATED',
    });
    createdAllocationIds.push(partial1.id);
    const partial2 = await recordPaymentAllocation({
      userId: USER_ID,
      invoiceId: invoiceA2.id,
      payerReference: 'Company B',
      payerType: 'THIRD_PARTY',
      amount: 4000,
      evidenceNotes: 'Partial payment, part 2 of 2',
      allocationStatus: 'UNALLOCATED',
    });
    createdAllocationIds.push(partial2.id);
    check('schema/service allows multiple allocation rows against the same invoice (no unique constraint blocks partials)', !!partial1.id && !!partial2.id && partial1.id !== partial2.id);

    // ── Reversal is non-destructive ──────────────────────────────────────
    const { reverseAllocation } = require('../lib/services/paymentAllocation');
    const reversed = await reverseAllocation({ allocationId: partial1.id, userId: USER_ID, reversedByUserId: STAFF_USER_ID });
    check('reverseAllocation sets status to REVERSED', reversed.allocation_status === 'REVERSED');
    check('reverseAllocation preserves the row (non-destructive) with reversed_at set', !!reversed.reversed_at);

  } catch (err) {
    console.error('FATAL', err);
    fail++;
  } finally {
    await cleanup();
    // Verify zero residue
    const { data: residueAlloc } = await supabase.from('payment_allocations').select('id').eq('user_id', USER_ID);
    const { data: residueInv } = await supabase.from('invoices').select('id').eq('user_id', USER_ID);
    check('cleanup: zero residual payment_allocations rows for test tenant', (residueAlloc || []).length === 0);
    check('cleanup: zero residual invoices rows for test tenant', (residueInv || []).length === 0);

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail > 0 ? 1 : 0);
  }
}

main();
