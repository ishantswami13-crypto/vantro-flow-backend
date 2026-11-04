// FILE: tests/fixtures/goldenReceivables.js
// Deterministic golden scenario for the decision engine. Clearly a fixture:
// every customer name ends in "(Golden Fixture)" and the tenant email is on
// the reserved .invalid domain, so it can never be mistaken for real data.
//
// Built relative to an as-of date so the scenario is identical whenever it
// runs. The story:
//   - Sharma Traders paid ~10 days late for a year, then slipped to ~35 days
//     late over the last 90 days; three invoices (₹4.2L) are overdue now and a
//     new one was issued on credit 10 days ago; one promise was broken.
//     -> a material decision with a deadline must be discovered.
//   - Mehta Stores pays on time; one invoice not yet due. -> nothing.
//   - Kapoor & Sons owes ₹8,000, 40 days late. -> below materiality, watched.
//   - Rao Distributors owes ₹1.5L, 70 days late, but it is disputed.
//     -> never simulated as collectable; no collection decision.

const DAY = 86400000;

function iso(asOfMs, offsetDays) {
  return new Date(asOfMs + offsetDays * DAY).toISOString().slice(0, 10);
}

function buildGoldenReceivables(asOfIso, ids = {}) {
  const asOf = Date.parse(`${asOfIso}T00:00:00Z`);
  const idGen = ids.next || ((() => { let n = 0; return (p) => `${p}-${String(++n).padStart(4, '0')}`; })());
  const invoices = [];
  const customers = [];
  const disputes = [];
  const promises = [];

  const sharma = { id: idGen('cust'), name: 'Sharma Traders (Golden Fixture)', advance_required: false, escalation_paused: false, tags: [] };
  const mehta = { id: idGen('cust'), name: 'Mehta Stores (Golden Fixture)', advance_required: false, escalation_paused: false, tags: [] };
  const kapoor = { id: idGen('cust'), name: 'Kapoor & Sons (Golden Fixture)', advance_required: false, escalation_paused: false, tags: [] };
  const rao = { id: idGen('cust'), name: 'Rao Distributors (Golden Fixture)', advance_required: false, escalation_paused: false, tags: [] };
  customers.push(sharma, mehta, kapoor, rao);

  function inv(customer, invoiceOffset, termsDays, amount, paidOffsetFromDue, number) {
    const due = invoiceOffset + termsDays;
    const row = {
      id: idGen('inv'),
      invoice_number: number,
      customer_name: customer.name,
      invoice_amount: amount,
      invoice_date: iso(asOf, invoiceOffset),
      due_date: iso(asOf, due),
      payment_status: paidOffsetFromDue == null ? 'Pending' : 'Paid',
      payment_date: paidOffsetFromDue == null ? null : iso(asOf, due + paidOffsetFromDue),
      payment_amount: paidOffsetFromDue == null ? null : amount,
      currency: 'INR',
      created_at: new Date(asOf + invoiceOffset * DAY).toISOString(),
      updated_at: new Date(asOf + invoiceOffset * DAY).toISOString(),
    };
    invoices.push(row);
    return row;
  }

  // Sharma: 12 invoices a year ago, paid ~10 days late (prior window).
  const priorDelays = [8, 12, 9, 11, 10, 7, 13, 10, 9, 12, 11, 8];
  priorDelays.forEach((d, i) => inv(sharma, -360 + i * 20, 30, 90000, d, `SH-${100 + i}`));
  // Recent window: paid ~35 days late.
  [34, 38, 31, 36].forEach((d, i) => inv(sharma, -170 + i * 15, 30, 95000, d, `SH-${200 + i}`));
  // Overdue now: ages 25, 55, 88 days past due.
  inv(sharma, -55, 30, 140000, null, 'SH-301');
  inv(sharma, -85, 30, 150000, null, 'SH-302');
  inv(sharma, -118, 30, 130000, null, 'SH-303');
  // New credit invoice 10 days ago (not yet due).
  inv(sharma, -10, 30, 120000, null, 'SH-304');
  promises.push({ id: idGen('prom'), customer_id: sharma.id, promised_amount: 150000, promised_date: iso(asOf, -20), status: 'broken', created_at: new Date(asOf - 30 * DAY).toISOString(), resolved_at: new Date(asOf - 19 * DAY).toISOString() });

  // Mehta: on time.
  [0, -1, 1, 0, -2, 0].forEach((d, i) => inv(mehta, -300 + i * 45, 30, 40000, d, `ME-${i}`));
  inv(mehta, -5, 30, 45000, null, 'ME-9');

  // Kapoor: small, overdue.
  [5, 6, 4].forEach((d, i) => inv(kapoor, -250 + i * 60, 30, 7000, d, `KA-${i}`));
  inv(kapoor, -70, 30, 8000, null, 'KA-9');

  // Rao: disputed.
  [3, 5, 2].forEach((d, i) => inv(rao, -280 + i * 50, 30, 60000, d, `RA-${i}`));
  const raoOpen = inv(rao, -100, 30, 150000, null, 'RA-9');
  disputes.push({ id: idGen('disp'), invoice_id: raoOpen.id, status: 'open', created_at: new Date(asOf - 40 * DAY).toISOString(), resolved_at: null, customer_name: rao.name, disputed_amount: 150000, reason: 'Short delivery claimed' });

  return { asOfIso, raw: { invoices, customers, disputes, promises, allocations: [] }, ids: { sharma, mehta, kapoor, rao } };
}

module.exports = { buildGoldenReceivables };
