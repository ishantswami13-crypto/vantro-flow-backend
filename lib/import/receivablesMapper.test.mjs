// Receivables import mapping: real-shaped exports from common Indian and
// global bookkeeping software must map without manual column choices, and the
// classic traps (Due Date read as money, Invoice No. read as a phone, totals
// rows, credits, day-first dates) must not slip through.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const M = require('./receivablesMapper');

let pass = 0, fail = 0;
const check = (name, ok, extra) => { if (ok) { pass++; console.log(`  ✅ ${name}`); } else { fail++; console.log(`  ❌ ${name}`, extra ?? ''); } };
const today = new Date('2026-09-27T10:00:00Z');
const csv = (text) => M.mapTable(M.parseDelimited(text), { today });

console.log('— known exports');
let r = csv(`Invoice Date,Invoice#,Customer Name,Status,Due Date,Total,Balance
10/08/2026,INV-0001,Mehta Hardware,Overdue,09/09/2026,"1,28,500.00","1,28,500.00"
15/09/2026,INV-0002,Kapoor & Co,Paid,15/10/2026,64000,0`);
check('Zoho Books detected', r.source.id === 'zoho_books', r.source);
check('Zoho: balance used as amount owed, due date drives overdue', r.invoices[0].invoice_amount === 128500 && r.invoices[0].days_overdue === 18 && r.invoices[0].overdue_from === 'due_date', r.invoices[0]);
check('Zoho: zero balance is paid', r.invoices[1].payment_status === 'Paid' && r.invoices[1].invoice_amount === 64000, r.invoices[1]);

r = csv(`Date,Num,Customer,Due Date,Amount,Open Balance
2026-08-01,1042,Sharma Traders,2026-08-31,25000,12500`);
check('QuickBooks detected, open balance owed', r.source.id === 'quickbooks' && r.invoices[0].invoice_amount === 12500 && r.invoices[0].invoice_number === '1042', r);

r = csv(`ContactName,InvoiceNumber,InvoiceDate,DueDate,Total,AmountDue
Gupta Stores,INV-77,2026-09-01,2026-09-16,9000,9000`);
check('Xero detected', r.source.id === 'xero' && r.invoices[0].days_overdue === 11, r);

r = csv(`Gupta Traders Pvt Ltd
Bills Receivable
1-Apr-2026 to 27-Sep-2026

Date,Ref. No.,Party's Name,Pending Amount,Due on,Overdue by days
12-Aug-2026,S/101,Mehta Hardware,"1,28,500.00 Dr",11-Sep-2026,16`);
check('Tally bills-receivable report: title rows skipped, header found, source recognised', r.headers[2] === "Party's Name" && r.source.id === 'tally' && r.invoices.length === 1, r);
check('Tally: "Dr" amount, dd-MMM-yyyy dates', r.invoices[0]?.invoice_amount === 128500 && r.invoices[0]?.due_date === '2026-09-11' && r.invoices[0]?.invoice_date === '2026-08-12', r.invoices[0]);

r = csv(`Party Name,Bill No,Bill Date,Bill Amt,Balance,Mobile No
Kapoor & Co,B-12,05/08/2026,64000,40000,+91 98100 00001`);
check('Busy detected; balance and phone', r.source.id === 'busy' && r.invoices[0].invoice_amount === 40000 && r.invoices[0].customer_phone === '9810000001', r);

r = csv(`Party Name,Invoice No,Invoice Date,Total Amount,Balance Due,Payment Status
Singh Electricals,12,01/09/2026,15000,15000,Unpaid`);
check('Vyapar detected; "Unpaid" stays pending', r.source.id === 'vyapar' && r.invoices[0].payment_status === 'Pending', r);

console.log('— traps');
r = csv(`Customer,Due Date,Invoice No.,Amount
Mehta Hardware,01/09/2026,9876543210,5000`);
check('"Due Date" is never read as the amount', r.invoices[0]?.invoice_amount === 5000, r.invoices[0]);
check('"Invoice No." is never read as a phone', r.invoices[0]?.customer_phone === null && r.invoices[0]?.invoice_number === '9876543210', r.invoices[0]);

r = csv(`Customer Name,Amount,Tax %,CGST,Invoice Date
A,1000,18,90,02/03/2026`);
check('tax columns are not the amount', r.invoices[0]?.invoice_amount === 1000);
check('02/03/2026 read day-first (2 March)', r.invoices[0]?.invoice_date === '2026-03-02', r.invoices[0]);
check('13/02/2026 unambiguous', M.parseDate('13/02/2026') === '2026-02-13');
check('02/13/2026 unambiguous month-first', M.parseDate('02/13/2026') === '2026-02-13');
check('invalid date rejected', M.parseDate('31/02/2026') === null);
check('Excel serial date', M.parseDate(46292) === '2026-09-27');

r = csv(`Party,Amount
Mehta Hardware,5000
Total,5000
Returns Co,(1200)`);
check('totals row skipped', r.skipped.some((s) => s.reason === 'a totals row'));
check('credit (negative) skipped, not imported as owed', r.skipped.some((s) => s.reason === 'a credit, not money owed') && r.invoices.length === 1);

r = csv(`Customer;Amount;Paid;Invoice Date;Credit Days
Kumar;"10.000";0;01/08/2026;30`);
check('semicolon CSV parsed', r.invoices.length === 1 || r.skipped.length === 1);
check('European "10.000" is not guessed as ten thousand', r.invoices.length === 0 && r.skipped[0]?.reason === 'no amount', r);

r = csv(`Customer,Amount,Paid,Invoice Date,Credit Days
Kumar,10000,4000,01/08/2026,30`);
check('amount minus paid = owed', r.invoices[0].invoice_amount === 6000, r.invoices[0]);
check('credit days produce the due date', r.invoices[0].due_date === '2026-08-31' && r.invoices[0].overdue_from === 'terms', r.invoices[0]);

r = csv(`"Name, Surname",Amount
"Mehta, Rakesh","1,000"`);
check('quoted commas handled', r.invoices[0]?.customer_name === 'Mehta, Rakesh' && r.invoices[0]?.invoice_amount === 1000, r);

r = csv(`Item,Qty,Rate
Bolts,10,5`);
check('a file with no customer/amount is reported as unmappable', r.mapping.confidence === 'insufficient' && r.invoices.length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
