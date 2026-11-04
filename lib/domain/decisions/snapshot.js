// FILE: lib/domain/decisions/snapshot.js
// The single as-of boundary for the decision engine.
//
// Everything the engine knows about receivables at time T comes through
// deriveReceivablesState(raw, asOf). Live discovery calls it with asOf = now;
// backtests call it with a historical T. Same code, so a backtest exercises
// exactly the logic that runs in production.
//
// Leakage rules (enforced here and asserted by assertNoFutureLeakage):
//   - an invoice exists at T only if its business invoice_date <= T
//     (created_at is used only when invoice_date is unparseable, and is flagged);
//   - an invoice is paid at T only if payment_status='Paid' AND payment_date <= T;
//     a Paid invoice with no usable payment_date is kept in live mode (the
//     status is current truth) but EXCLUDED from historical replays, because
//     we cannot tell whether it was already paid at T;
//   - partial payments count only when their own payment_date <= T;
//   - a dispute is open at T if created_at <= T and not resolved by T;
//   - a promise counts only if created at or before T, and is kept/broken only
//     if it was resolved at or before T.
// Mutable customer flags (credit_limit, advance_required, tags) carry no
// history, so a replay records that it could not use them.

const { parseBusinessDate, daysBetween, startOfUtcDay } = require('./dates');

function normalizeName(name) {
  return String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * @param {object} raw { invoices, customers, disputes, promises, allocations }
 * @param {number|string|Date} asOfInput
 * @param {object} opts { mode: 'live'|'replay', baseCurrency }
 */
function deriveReceivablesState(raw, asOfInput, opts = {}) {
  const mode = opts.mode === 'replay' ? 'replay' : 'live';
  const baseCurrency = opts.baseCurrency || 'INR';
  const asOfMs = typeof asOfInput === 'number' ? asOfInput : new Date(asOfInput).getTime();
  const asOfDay = startOfUtcDay(asOfMs);

  const quality = {
    invoicesSeen: 0,
    invoicesInScope: 0,
    futureInvoicesExcluded: 0,
    unparseableInvoiceDate: 0,
    unparseableDueDate: 0,
    paidWithoutDate: 0,
    paidWithoutDateExcludedFromReplay: 0,
    currencyMissing: 0,
    nonPositiveAmount: 0,
    duplicateInvoiceNumbers: 0,
    partialPaymentsWithoutDateExcludedFromReplay: 0,
  };

  const customersByKey = new Map();
  for (const c of raw.customers || []) {
    const key = normalizeName(c.name);
    if (!key) continue;
    if (!customersByKey.has(key)) customersByKey.set(key, c);
  }

  const openDisputeInvoiceIds = new Set();
  for (const d of raw.disputes || []) {
    const created = d.created_at ? new Date(d.created_at).getTime() : null;
    if (created == null || created > asOfMs) continue;
    const resolvedAt = d.resolved_at ? new Date(d.resolved_at).getTime() : null;
    const resolvedByT = resolvedAt != null && resolvedAt <= asOfMs;
    const statusOpen = !['resolved', 'closed', 'Resolved', 'Closed'].includes(d.status);
    const open = mode === 'live' ? statusOpen && !resolvedByT : !resolvedByT;
    if (open && d.invoice_id) openDisputeInvoiceIds.add(String(d.invoice_id));
  }

  const allocationsByInvoice = new Map();
  for (const a of raw.allocations || []) {
    if (a.allocation_status && a.allocation_status !== 'CONFIRMED') continue;
    if (a.reversed_at) {
      const rev = new Date(a.reversed_at).getTime();
      if (rev <= asOfMs) continue;
    }
    const paidAt = parseBusinessDate(a.payment_date);
    if (paidAt == null || paidAt > asOfDay) continue;
    const key = String(a.invoice_id);
    allocationsByInvoice.set(key, (allocationsByInvoice.get(key) || 0) + (num(a.amount) || 0));
  }

  const seenNumbers = new Map();
  const invoices = [];
  for (const inv of raw.invoices || []) {
    quality.invoicesSeen++;
    let invoiceDay = parseBusinessDate(inv.invoice_date);
    let invoiceDateSource = 'invoice_date';
    if (invoiceDay == null) {
      quality.unparseableInvoiceDate++;
      invoiceDay = inv.created_at ? startOfUtcDay(new Date(inv.created_at).getTime()) : null;
      invoiceDateSource = 'created_at';
    }
    if (invoiceDay == null || invoiceDay > asOfDay) {
      quality.futureInvoicesExcluded++;
      continue;
    }
    const amount = num(inv.invoice_amount);
    if (amount == null || amount <= 0) { quality.nonPositiveAmount++; continue; }

    const dueDay = parseBusinessDate(inv.due_date);
    if (dueDay == null) quality.unparseableDueDate++;

    let currency = inv.currency ? String(inv.currency).toUpperCase() : null;
    if (!currency) { quality.currencyMissing++; currency = baseCurrency; }

    const isPaidNow = inv.payment_status === 'Paid';
    const paidDay = parseBusinessDate(inv.payment_date);
    let paidAt = null;
    if (isPaidNow) {
      if (paidDay == null) {
        quality.paidWithoutDate++;
        if (mode === 'replay') { quality.paidWithoutDateExcludedFromReplay++; continue; }
        paidAt = 'unknown';
      } else if (paidDay <= asOfDay) {
        paidAt = paidDay;
      }
    }

    const paidAmountFull = num(inv.payment_amount) != null && num(inv.payment_amount) > 0 ? num(inv.payment_amount) : amount;
    let outstanding;
    let paidAmount;
    if (paidAt != null) {
      paidAmount = Math.min(paidAmountFull, amount);
      outstanding = 0;
    } else {
      // A part-payment recorded on the invoice itself (payment_amount on an
      // unpaid invoice, as the rest of the app and the ledger import store
      // it) counts like an allocation: in live mode always, in a replay only
      // when its payment_date proves it happened by T. Allocations and the
      // invoice field describe the same money, so the larger is used, never
      // the sum.
      // A Paid invoice whose payment_date is after T lands here too; its
      // payment_amount is that future payment, so it never counts.
      let partial = 0;
      const recorded = num(inv.payment_amount);
      if (!isPaidNow && recorded != null && recorded > 0) {
        if (paidDay != null) { if (paidDay <= asOfDay) partial = recorded; }
        else if (mode === 'live') partial = recorded;
        else quality.partialPaymentsWithoutDateExcludedFromReplay++;
      }
      paidAmount = Math.min(Math.max(allocationsByInvoice.get(String(inv.id)) || 0, partial), amount);
      outstanding = round2(amount - paidAmount);
    }

    const customerKey = normalizeName(inv.customer_name) || `unnamed:${inv.id}`;
    if (inv.invoice_number) {
      const dupKey = `${customerKey}|${String(inv.invoice_number).trim().toLowerCase()}`;
      if (seenNumbers.has(dupKey)) quality.duplicateInvoiceNumbers++;
      else seenNumbers.set(dupKey, inv.id);
    }

    quality.invoicesInScope++;
    invoices.push({
      id: String(inv.id),
      number: inv.invoice_number || null,
      customerKey,
      customerName: inv.customer_name || 'Unnamed customer',
      currency,
      currencyAssumed: !inv.currency,
      amount: round2(amount),
      paidAmount: round2(paidAmount),
      outstanding,
      invoiceDay,
      invoiceDateSource,
      dueDay,
      paidDay: typeof paidAt === 'number' ? paidAt : null,
      paidDateUnknown: paidAt === 'unknown',
      status: outstanding > 0 ? 'open' : 'paid',
      ageDays: dueDay != null ? daysBetween(dueDay, asOfDay) : null,
      disputeOpen: openDisputeInvoiceIds.has(String(inv.id)),
      sourceType: inv.source_type || null,
      updatedAt: inv.updated_at || inv.created_at || null,
    });
  }

  const customers = new Map();
  for (const inv of invoices) {
    if (!customers.has(inv.customerKey)) {
      const record = customersByKey.get(inv.customerKey) || null;
      customers.set(inv.customerKey, {
        key: inv.customerKey,
        name: record ? record.name : inv.customerName,
        customerId: record ? String(record.id) : null,
        record: mode === 'live' ? record : null,
        invoices: [],
        promises: { made: 0, kept: 0, broken: 0, open: 0 },
      });
    }
    customers.get(inv.customerKey).invoices.push(inv);
  }

  const customerIdToKey = new Map();
  for (const c of customers.values()) if (c.customerId) customerIdToKey.set(c.customerId, c.key);
  for (const p of raw.promises || []) {
    const created = p.created_at ? new Date(p.created_at).getTime() : null;
    if (created == null || created > asOfMs) continue;
    const key = customerIdToKey.get(String(p.customer_id));
    if (!key) continue;
    const bucket = customers.get(key).promises;
    bucket.made++;
    const resolvedAt = p.resolved_at ? new Date(p.resolved_at).getTime() : null;
    const resolvedByT = resolvedAt != null && resolvedAt <= asOfMs;
    const status = String(p.status || '').toLowerCase();
    if (mode === 'live' ? ['kept', 'fulfilled', 'paid'].includes(status) : resolvedByT && ['kept', 'fulfilled', 'paid'].includes(status)) bucket.kept++;
    else if (mode === 'live' ? status === 'broken' : resolvedByT && status === 'broken') bucket.broken++;
    else bucket.open++;
  }

  const totalsByCurrency = {};
  for (const inv of invoices) {
    const t = totalsByCurrency[inv.currency] || (totalsByCurrency[inv.currency] = { open: 0, overdue: 0, openCount: 0, overdueCount: 0 });
    if (inv.outstanding > 0) {
      t.open = round2(t.open + inv.outstanding);
      t.openCount++;
      if (inv.ageDays != null && inv.ageDays > 0) { t.overdue = round2(t.overdue + inv.outstanding); t.overdueCount++; }
    }
  }

  return { asOf: asOfMs, asOfDay, mode, baseCurrency, invoices, customers, totalsByCurrency, quality };
}

/**
 * Throws if anything in a derived state carries information from after T.
 * Called by every replay; a failure here means a bug, never a data problem.
 */
function assertNoFutureLeakage(state) {
  for (const inv of state.invoices) {
    if (inv.invoiceDay > state.asOfDay) throw new Error(`leakage: invoice ${inv.id} dated after as-of`);
    if (inv.paidDay != null && inv.paidDay > state.asOfDay) throw new Error(`leakage: invoice ${inv.id} paid after as-of counted as paid`);
    if (state.mode === 'replay' && inv.paidDateUnknown) throw new Error(`leakage: invoice ${inv.id} with unknown payment date in replay`);
  }
  for (const c of state.customers.values()) {
    if (state.mode === 'replay' && c.record) throw new Error('leakage: current customer record used in replay');
  }
  return true;
}

module.exports = { deriveReceivablesState, assertNoFutureLeakage, normalizeName };
