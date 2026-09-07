-- FILE: migrations/020_payment_allocations.sql
-- Day 1 sprint (2026-09-07): support "customer A's invoice paid by a distinct
-- payer B" (related company, director, distributor, or unrelated third party).
--
-- AUDIT FINDING (verified against real local dev DB, 2026-09-07):
--   - invoices.payment_amount/payment_date/payment_method/payment_notes are
--     columns bolted directly onto the invoice row. They record "how much was
--     paid, in aggregate" but carry NO payer identity at all — there is no
--     "who actually paid" column anywhere on invoices or sales.
--   - `select column_name from information_schema.columns where
--     table_name='invoices' and column_name like '%payment%'` returns only:
--     payment_amount, payment_date, payment_status, payment_notes,
--     payment_link, payment_link_id, payment_method. No payer_name/payer_id.
--   - `payments` table: does not exist (0 columns in information_schema).
--   - `transactions` / `bank_transactions`: bank_transactions exists with
--     matched_type/matched_id/match_confidence/match_method (bank-statement
--     reconciliation), but again no payer-identity column distinct from the
--     matched invoice's own customer.
--   - server.js's Razorpay webhook handler (around line 7721) actually reads
--     `payment?.notes?.contact` into a local `payerName` variable — Razorpay
--     DOES tell us who paid — but that value is discarded; it is never
--     written anywhere. This is the concrete, live gap this migration closes
--     the schema side of.
--   - evaluationAgent.js/collectionsAgent.js key strictly off
--     invoices.payment_status / invoices.payment_amount to decide "is this
--     invoice paid" — this migration does not touch those columns or that
--     read path. This table is purely additive evidence alongside it.
--
-- DESIGN: additive-only. No existing table is altered. An invoice/sale that
-- never has a distinct payer needs no row here — payment_status/payment_amount
-- on invoices/sales continue to be the aggregate paid/unpaid source of truth.
-- This table exists only for the cases where "who paid" needs to be recorded
-- as distinct from "whose invoice it is."
--
-- Supports (without further schema change):
--   - partial payments: multiple rows per invoice summing to less than total
--   - multiple payments per invoice: multiple rows, no uniqueness constraint
--     blocks this
--   - one payment split across multiple invoices: multiple rows sharing the
--     same payer_reference/payment_date/amount-per-row, each referencing a
--     different invoice/sale — nothing here forces 1:1
--   - learned payer relationships: see paymentAllocation.js's
--     getObservedPayersForCustomer(), aggregating CONFIRMED rows only
--   - reversible allocations: allocation_status can transition to 'REVERSED';
--     reversed_at/reversed_by_user_id preserve history non-destructively

CREATE TABLE IF NOT EXISTS payment_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,

  -- The "A" side: the invoice/sale this payment is being allocated against.
  -- This codebase has two parallel invoice-shaped tables (invoices, sales);
  -- exactly one of these two FKs must be set, never both, never neither.
  invoice_id UUID REFERENCES invoices(id),
  sale_id BIGINT REFERENCES sales(id),
  CONSTRAINT payment_allocations_exactly_one_target CHECK (
    (invoice_id IS NOT NULL AND sale_id IS NULL) OR
    (invoice_id IS NULL AND sale_id IS NOT NULL)
  ),

  -- The "B" side: the actual payer. Free text by design — B may not exist as
  -- a customers/suppliers row at all (a director's personal account, an
  -- unregistered financier, etc). customer_id/supplier_id are optional,
  -- nullable links for when B genuinely does correspond to an existing row —
  -- this is never inferred, only set when explicitly confirmed as such.
  payer_reference TEXT NOT NULL,
  payer_customer_id UUID REFERENCES customers(id),
  payer_supplier_id UUID REFERENCES suppliers(id),

  -- Low-commitment classification of the payer relationship. Never asserts
  -- a corporate/ownership fact — SAME_AS_CUSTOMER is only used when
  -- payer_reference genuinely matches the invoice's own customer identity
  -- (an honest observation, not a guess); RELATED_ENTITY/THIRD_PARTY/UNKNOWN
  -- otherwise, always via explicit human input, never inferred by the code.
  payer_type TEXT NOT NULL CHECK (payer_type IN (
    'SAME_AS_CUSTOMER', 'RELATED_ENTITY', 'THIRD_PARTY', 'UNKNOWN'
  )),

  amount NUMERIC NOT NULL CHECK (amount > 0),
  payment_date DATE,
  payment_method TEXT,

  -- Ambiguous matches must never auto-resolve to CONFIRMED. Only explicit
  -- human confirmation (confirmed_by_user_id/confirmed_at set) moves a row
  -- from AMBIGUOUS/UNALLOCATED to CONFIRMED. REVERSED preserves history
  -- rather than deleting a mistaken confirmation.
  allocation_status TEXT NOT NULL DEFAULT 'UNALLOCATED' CHECK (allocation_status IN (
    'UNALLOCATED', 'AMBIGUOUS', 'CONFIRMED', 'REVERSED'
  )),

  -- Provenance: why this payment was matched to this invoice/sale. Free
  -- text, e.g. "amount matches exactly; bank ref cites invoice number".
  evidence_notes TEXT,

  confirmed_by_user_id UUID,
  confirmed_at TIMESTAMPTZ,
  reversed_by_user_id UUID,
  reversed_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_allocations_user_id ON payment_allocations(user_id);
CREATE INDEX IF NOT EXISTS idx_payment_allocations_invoice_id ON payment_allocations(invoice_id) WHERE invoice_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payment_allocations_sale_id ON payment_allocations(sale_id) WHERE sale_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payment_allocations_payer_reference ON payment_allocations(user_id, payer_reference);
CREATE INDEX IF NOT EXISTS idx_payment_allocations_status ON payment_allocations(allocation_status);
