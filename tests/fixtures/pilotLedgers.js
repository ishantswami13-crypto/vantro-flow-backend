// FILE: tests/fixtures/pilotLedgers.js
// Receivables ledgers as a business would export them (DD/MM/YYYY dates,
// Indian digit grouping, "Paid"/"Unpaid" status), used to prove the import
// path and the red-team cases. Every customer name ends in "(Fixture)" so
// nothing here can be mistaken for real data.
//
//   slippingCustomer - one customer's payment delay has worsened and ₹4.2L
//                      is overdue: exactly one decision should be found.
//   healthy          - everyone pays on time, nothing material is overdue:
//                      Starlane must say nothing needs attention.
//   noDueDates       - the same slipping story but no due dates or credit
//                      days: Starlane must refuse to call anything overdue.

const { buildGoldenReceivables } = require('./goldenReceivables');

const DAY = 86400000;

function dmy(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

function inr(n) {
  return Number(n).toLocaleString('en-IN', { minimumFractionDigits: 0 });
}

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(header, rows) {
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
}

const HEADER = ['Party Name', 'Bill No', 'Bill Date', 'Due Date', 'Bill Amount', 'Status', 'Payment Date'];

function row(inv, { dueDate = true } = {}) {
  return [inv.customer_name, inv.invoice_number, dmy(inv.invoice_date), dueDate ? dmy(inv.due_date) : undefined, inr(inv.invoice_amount), inv.payment_status === 'Paid' ? 'Paid' : 'Unpaid', dmy(inv.payment_date)].filter((v, i) => dueDate || i !== 3);
}

function relabel(invoices) {
  return invoices.map((i) => ({ ...i, customer_name: i.customer_name.replace('(Golden Fixture)', '(Fixture)') }));
}

/** Sharma slipping (₹4.2L overdue), Mehta on time, Kapoor small. No disputes in a plain ledger, so Rao is left out. */
function slippingCustomerCsv(asOfIso) {
  const fx = buildGoldenReceivables(asOfIso);
  const invoices = relabel(fx.raw.invoices.filter((i) => !i.customer_name.startsWith('Rao')));
  return toCsv(HEADER, invoices.map((i) => row(i)));
}

/** Twelve months of customers who pay within a few days of the due date. */
function healthyCsv(asOfIso) {
  const asOf = Date.parse(`${asOfIso}T00:00:00Z`);
  const iso = (off) => new Date(asOf + off * DAY).toISOString().slice(0, 10);
  const customers = ['Mehta Stores (Fixture)', 'Iyer Agencies (Fixture)', 'Gupta Wholesale (Fixture)', 'Nair Traders (Fixture)'];
  const rows = [];
  customers.forEach((name, c) => {
    for (let k = 0; k < 12; k++) {
      const invOff = -360 + k * 30 + c * 3;
      const due = invOff + 30;
      const delay = [0, 1, -2, 2, 0, 3, -1, 1, 0, 2, 1, 0][(k + c) % 12];
      const paidOff = due + delay;
      const paid = paidOff < 0;
      rows.push([name, `${name.slice(0, 2).toUpperCase()}-${k}`, dmy(iso(invOff)), dmy(iso(due)), inr(50000 + c * 5000), paid ? 'Paid' : 'Unpaid', paid ? dmy(iso(paidOff)) : '']);
    }
  });
  // One small invoice a few days late: real, but not material.
  rows.push(['Small Buyer (Fixture)', 'SB-1', dmy(iso(-40)), dmy(iso(-10)), inr(6000), 'Unpaid', '']);
  return toCsv(HEADER, rows);
}

/** The slipping story without any due date or credit-days column. */
function noDueDatesCsv(asOfIso) {
  const fx = buildGoldenReceivables(asOfIso);
  const invoices = relabel(fx.raw.invoices.filter((i) => !i.customer_name.startsWith('Rao')));
  return toCsv(HEADER.filter((h) => h !== 'Due Date'), invoices.map((i) => row(i, { dueDate: false })));
}

/** The mapping a person would confirm for these files. */
function confirmedOptions({ dueDate = true } = {}) {
  const mapping = { customer: 'Party Name', invoice_number: 'Bill No', invoice_date: 'Bill Date', amount: 'Bill Amount', status: 'Status', payment_date: 'Payment Date' };
  const dateOrders = { 'Bill Date': 'DMY', 'Payment Date': 'DMY' };
  if (dueDate) { mapping.due_date = 'Due Date'; dateOrders['Due Date'] = 'DMY'; }
  return { mapping, dateOrders, currency: 'INR' };
}

module.exports = { slippingCustomerCsv, healthyCsv, noDueDatesCsv, confirmedOptions, HEADER };
