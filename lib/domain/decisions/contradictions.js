// FILE: lib/domain/decisions/contradictions.js
// Material conflicts between sources that touch a receivables decision.
// None is "resolved" by guessing. Each carries the authority rule the engine
// applies (the ledger is the authority for balances; human-entered flags and
// promises are claims about intent) and what information would settle it.
// Pure: runs on a live snapshot.

const { DAY_MS } = require('./dates');

function detectDecisionContradictions(state) {
  const byInvoice = new Map();
  const add = (invoiceId, c) => {
    if (!byInvoice.has(invoiceId)) byInvoice.set(invoiceId, []);
    byInvoice.get(invoiceId).push(c);
  };

  for (const customer of state.customers.values()) {
    const rec = customer.record;
    if (rec && rec.advance_required) {
      const recentCredit = customer.invoices.filter((i) => i.invoiceDay > state.asOfDay - 30 * DAY_MS && i.outstanding > 0);
      for (const inv of recentCredit) {
        add(inv.id, {
          type: 'CREDIT_HOLD_VS_LEDGER',
          severity: 'MODERATE',
          sources: [{ table: 'customers', id: rec.id, field: 'advance_required', value: true }, { table: 'invoices', id: inv.id, field: 'outstanding', value: inv.outstanding }],
          claim: `${customer.name} is marked "advance payment required"`,
          contradiction: `invoice ${inv.number || inv.id.slice(0, 8)} was issued on credit in the last 30 days`,
          authorityRule: 'The ledger is the authority for balances; the credit flag is not being enforced at billing.',
          toResolve: 'Confirm whether the hold was lifted on purpose.',
        });
      }
    }
    for (const inv of customer.invoices) {
      if (inv.paidDateUnknown) {
        add(inv.id, {
          type: 'PAID_WITHOUT_PAYMENT_DATE',
          severity: 'WEAK',
          sources: [{ table: 'invoices', id: inv.id, field: 'payment_status', value: 'Paid' }, { table: 'invoices', id: inv.id, field: 'payment_date', value: null }],
          claim: `invoice ${inv.number || inv.id.slice(0, 8)} is marked Paid`,
          contradiction: 'it has no payment date, so it cannot be used to learn how fast this customer pays',
          authorityRule: 'Treated as paid for balances; excluded from payment-timing history and from replays.',
          toResolve: 'Record the payment date.',
        });
      }
    }
    if (customer.promises.kept > 0) {
      const open = customer.invoices.filter((i) => i.outstanding > 0 && i.ageDays != null && i.ageDays > 60);
      if (open.length && customer.promises.kept >= customer.promises.made && customer.promises.made > 0) {
        for (const inv of open) {
          add(inv.id, {
            type: 'PROMISES_KEPT_VS_AGED_BALANCE',
            severity: 'WEAK',
            sources: [{ table: 'promises', customer: customer.name, field: 'status', value: 'kept' }, { table: 'invoices', id: inv.id, field: 'ageDays', value: inv.ageDays }],
            claim: 'Every recorded promise from this customer is marked kept',
            contradiction: `invoice ${inv.number || inv.id.slice(0, 8)} is still open ${inv.ageDays} days past due`,
            authorityRule: 'The open balance stands; promise records may be incomplete.',
            toResolve: 'Check whether a promise covering this invoice was recorded.',
          });
        }
      }
    }
  }
  return byInvoice;
}

module.exports = { detectDecisionContradictions };
