// FILE: tests/fixtures/operatingSystemLedger.js
// A deterministic receivables ledger for a trading business, used to prove
// the seven-surface loop end to end. Clearly a fixture: every customer name
// ends in "(Fixture)", and it is generated, not real.
//
// The story (relative to the as-of date, 240 days of history, 30-day terms):
//   - 8 reliable customers pay within a few days of the due date;
//   - 10 habitual late payers pay 15-50 days late, so about 10 invoices a
//     month pass their due date and someone has to chase them;
//   - 3 customers have slipped: their recent invoices are 35-80 days overdue;
//   - 2 regular customers stopped buying about four months ago (dormant).

const { mulberry32, seedFrom } = require('../../lib/domain/decisions/rng');

const DAY = 86400000;
const HEADER = ['Party Name', 'Bill No', 'Bill Date', 'Due Date', 'Bill Amount', 'Status', 'Payment Date'];

function dmy(ms) {
  const d = new Date(ms);
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
}

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildOperatingSystemLedger(asOfIso) {
  const asOf = Date.parse(`${asOfIso}T00:00:00Z`);
  const rand = mulberry32(seedFrom('starlane-os-fixture-v1'));
  const rows = [];
  const add = (name, prefix, k, invOff, amount, paidLate) => {
    const inv = asOf + invOff * DAY;
    const due = inv + 30 * DAY;
    const paidAt = paidLate == null ? null : due + paidLate * DAY;
    const paid = paidAt != null && paidAt <= asOf;
    rows.push({ name, number: `${prefix}-${String(k).padStart(3, '0')}`, invoiceDate: inv, dueDate: due, amount, paid, paymentDate: paid ? paidAt : null });
  };
  const reliable = ['Mehta Stores', 'Iyer Agencies', 'Gupta Wholesale', 'Nair Traders', 'Das Enterprises', 'Kulkarni & Co', 'Bose Retail', 'Pillai Supplies'];
  const late = ['Sharma Traders', 'Verma Distributors', 'Khan Brothers', 'Reddy Mart', 'Joshi Hardware', 'Sinha Stores', 'Patel Agencies', 'Chopra Traders', 'Menon Retail', 'Ghosh & Sons'];
  const slipping = ['Rao Distributors', 'Kapoor Industries', 'Malhotra Mart'];
  const dormant = ['Arora Foods', 'Bhatia Textiles'];

  reliable.forEach((base, c) => {
    const name = `${base} (Fixture)`;
    for (let k = 0; k < 8; k++) {
      const invOff = -240 + k * 30 + c * 2;
      add(name, `R${c}`, k, invOff, 40000 + Math.round(rand() * 60000), Math.round(rand() * 6) - 3);
    }
  });
  late.forEach((base, c) => {
    const name = `${base} (Fixture)`;
    for (let k = 0; k < 8; k++) {
      const invOff = -240 + k * 30 + c * 3;
      add(name, `L${c}`, k, invOff, 30000 + Math.round(rand() * 90000), 15 + Math.round(rand() * 35));
    }
  });
  slipping.forEach((base, c) => {
    const name = `${base} (Fixture)`;
    for (let k = 0; k < 8; k++) {
      const invOff = -240 + k * 30 + c * 4;
      // Earlier invoices paid ~10 days late; the last three are still open.
      const lateBy = k < 5 ? 5 + Math.round(rand() * 10) : null;
      add(name, `S${c}`, k, invOff, 80000 + Math.round(rand() * 120000), lateBy);
    }
  });
  dormant.forEach((base, c) => {
    const name = `${base} (Fixture)`;
    for (let k = 0; k < 4; k++) {
      const invOff = -240 + k * 25 + c * 5;
      add(name, `D${c}`, k, invOff, 50000 + Math.round(rand() * 50000), Math.round(rand() * 4));
    }
  });

  const csvRows = rows.map((r) => [r.name, r.number, dmy(r.invoiceDate), dmy(r.dueDate), r.amount.toLocaleString('en-IN'), r.paid ? 'Paid' : 'Unpaid', r.paymentDate ? dmy(r.paymentDate) : '']);
  const csv = [HEADER, ...csvRows].map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
  return { csv, rows, customers: { reliable, late, slipping, dormant } };
}

module.exports = { buildOperatingSystemLedger, HEADER };
