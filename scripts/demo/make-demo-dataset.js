#!/usr/bin/env node
// FILE: scripts/demo/make-demo-dataset.js
// `npm run demo:dataset` — writes the Apex Industrial Supplies demo files.
//
// Apex Industrial Supplies Pvt Ltd is fictional. Its books are a Tally-style
// "Bills Receivable" export (XLSX, with title rows) and the same bills as a
// plain CSV (DD/MM/YYYY). Both enter Starlane through the normal import, like
// any customer's file; nothing here touches a database.
//
// Bill dates are counted back from the day the files are made, so overdue
// figures stay true whenever the demo runs. Regenerate on the morning of a
// meeting. EXPECTED.md lists the totals worked out independently of Starlane,
// to check the screen against.
//
// Usage: node scripts/demo/make-demo-dataset.js [outDir] [--as-of YYYY-MM-DD]

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const args = process.argv.slice(2);
const asOfArg = args.indexOf('--as-of');
const asOf = asOfArg >= 0 ? new Date(`${args[asOfArg + 1]}T00:00:00Z`) : new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
const outDir = path.resolve(args.find((a, i) => !a.startsWith('--') && (asOfArg < 0 || i !== asOfArg + 1)) || path.join(__dirname, '..', '..', 'demo'));

// party, credit days, bills as [days since the bill was raised, pending amount in ₹]
const PARTIES = [
  ['Narmada Valves & Fittings Pvt Ltd', 45, [[164, 685000], [96, 412500], [58, 538000], [31, 296400], [12, 318750]]],
  ['Kaveri Pumps Ltd', 60, [[118, 248600], [74, 186300], [22, 204900]]],
  ['Shakti Agro Equipment', 30, [[103, 92800], [67, 118400], [39, 74250]]],
  ['Rathod Engineering Works', 30, [[52, 64300], [44, 58750], [9, 47200]]],
  ['Gujarat Hydraulic Systems', 45, [[81, 176500], [36, 142800]]],
  ['Mahalaxmi Fabricators', 30, [[47, 38900], [18, 42600]]],
  ['Om Precision Components', 30, [[29, 86400], [6, 91250]]],
  ['Sabarmati Steel Traders', 15, [[24, 31800], [11, 27650], [4, 33900]]],
  ['Jyoti Motors & Controls', 60, [[71, 214700], [15, 168300]]],
  ['Patel Irrigation Products', 30, [[137, 56200]]],
  ['Vadodara Process Plant Co', 45, [[33, 129600], [8, 112400]]],
  ['Ambica Tools Corporation', 30, [[19, 22450]]],
];

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const back = (n) => { const x = new Date(asOf); x.setUTCDate(x.getUTCDate() - n); return x; };
const tally = (x) => `${String(x.getUTCDate()).padStart(2, '0')}-${MON[x.getUTCMonth()]}-${String(x.getUTCFullYear()).slice(2)}`;
const ddmmyyyy = (x) => `${String(x.getUTCDate()).padStart(2, '0')}/${String(x.getUTCMonth() + 1).padStart(2, '0')}/${x.getUTCFullYear()}`;
const inr = (n) => {
  const s = String(Math.round(n)); const last3 = s.slice(-3); const rest = s.slice(0, -3);
  return `₹${rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},` : ''}${last3}`;
};
const fy = asOf.getUTCMonth() >= 3 ? asOf.getUTCFullYear() : asOf.getUTCFullYear() - 1;
const prefix = `AIS/${String(fy).slice(2)}-${String(fy + 1).slice(2)}`;

const bills = [];
for (const [party, credit, list] of PARTIES) for (const [ago, amount] of list) bills.push({ party, credit, ago, amount });
bills.sort((a, b) => b.ago - a.ago || a.party.localeCompare(b.party));
let no = 2401;
for (const b of bills) {
  b.ref = `${prefix}/${no++}`;
  b.date = back(b.ago);
  b.due = back(b.ago - b.credit);
  b.overdueDays = Math.max(0, b.ago - b.credit);
}

fs.mkdirSync(outDir, { recursive: true });

const sheet = [
  ['Apex Industrial Supplies Pvt Ltd'], ['Plot 22, GIDC Vatva, Ahmedabad'], ['Bills Receivable'], [`1-Apr-${String(fy).slice(2)} to ${tally(asOf)}`], [],
  ['Date', 'Ref. No.', "Party's Name", 'Pending Amount', 'Due on', 'Overdue by days'],
  ...bills.map((b) => [tally(b.date), b.ref, b.party, b.amount, tally(b.due), b.overdueDays || '']),
];
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheet), 'Bills Receivable');
XLSX.writeFile(wb, path.join(outDir, 'Apex-Bills-Receivable.xlsx'));

const csvCell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const csv = [['Invoice No', 'Customer', 'Invoice Date', 'Due Date', 'Amount'],
  ...bills.map((b) => [b.ref, b.party, ddmmyyyy(b.date), ddmmyyyy(b.due), b.amount])].map((r) => r.map(csvCell).join(',')).join('\n');
fs.writeFileSync(path.join(outDir, 'apex-invoices.csv'), `${csv}\n`);

// Totals, worked out here from the rows above, independently of Starlane.
const sum = (xs) => xs.reduce((s, b) => s + b.amount, 0);
const overdue = bills.filter((b) => b.overdueDays > 0);
const over90 = bills.filter((b) => b.overdueDays > 90);
const notDue = bills.filter((b) => b.overdueDays === 0);
const byParty = PARTIES.map(([party]) => {
  const own = bills.filter((b) => b.party === party);
  const od = own.filter((b) => b.overdueDays > 0);
  return { party, count: own.length, total: sum(own), overdue: sum(od), oldest: Math.max(0, ...own.map((b) => b.overdueDays)) };
}).sort((a, b) => b.total - a.total);
const total = sum(bills);
const top = byParty[0];
const oldest = bills[0];

const md = `# Apex Industrial Supplies — demo dataset

Made ${asOf.toISOString().slice(0, 10)} by \`npm run demo:dataset\`. Bill dates are counted back from that day, so make the files again on the morning of a meeting.

Apex Industrial Supplies Pvt Ltd is a fictional business. Import these files through Sources, as a customer would. Never load them into a database directly.

| File | What it is |
|---|---|
| \`Apex-Bills-Receivable.xlsx\` | A Tally-style Bills Receivable export with 5 title rows and dates like ${tally(oldest.date)} |
| \`apex-invoices.csv\` | The same ${bills.length} bills as a plain CSV with DD/MM/YYYY dates |

## Expected figures (computed from the rows, not by Starlane)

| | |
|---|---|
| Bills | ${bills.length} across ${PARTIES.length} customers |
| Outstanding | ${inr(total)} |
| Overdue | ${inr(sum(overdue))} on ${overdue.length} bills |
| Not yet due | ${inr(sum(notDue))} on ${notDue.length} bills |
| More than 90 days overdue | ${inr(sum(over90))} on ${over90.length} bills |
| Oldest bill | ${oldest.party}, ${oldest.ref}, ${inr(oldest.amount)}, ${oldest.overdueDays} days overdue |
| Largest customer | ${top.party}: ${inr(top.total)}, ${Math.round((top.total / total) * 100)}% of everything outstanding |

## By customer

| Customer | Bills | Outstanding | Overdue | Most days overdue |
|---|---:|---:|---:|---:|
${byParty.map((p) => `| ${p.party} | ${p.count} | ${inr(p.total)} | ${inr(p.overdue)} | ${p.oldest || '—'} |`).join('\n')}

## Bills more than 90 days overdue

| Bill | Customer | Amount | Days overdue |
|---|---|---:|---:|
${over90.map((b) => `| ${b.ref} | ${b.party} | ${inr(b.amount)} | ${b.overdueDays} |`).join('\n')}
`;
fs.writeFileSync(path.join(outDir, 'EXPECTED.md'), md);
fs.writeFileSync(path.join(outDir, 'expected.json'), `${JSON.stringify({
  asOf: asOf.toISOString().slice(0, 10), bills: bills.length, customers: PARTIES.length,
  outstanding: total, overdue: sum(overdue), overdueBills: overdue.length, notDue: sum(notDue),
  over90: sum(over90), over90Bills: over90.length, largestCustomer: { name: top.party, outstanding: top.total },
  oldestBill: { ref: oldest.ref, party: oldest.party, amount: oldest.amount, overdueDays: oldest.overdueDays },
}, null, 2)}\n`);

console.log(`Wrote ${bills.length} bills to ${outDir}: outstanding ${inr(total)}, overdue ${inr(sum(overdue))}, over 90 days ${inr(sum(over90))}.`);
