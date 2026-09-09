// Offline proof for the Starlane Brain engine. No DB, no network.
// Run: node lib/brain/brainSummary.test.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { computeBrainSummary } = require('./brainSummary.js');

const asOf = new Date('2026-07-21');
const M = (mm) => `2026-${mm}`; // dates within 2026

const invoices = [
  // this month (Jul) sales
  { customer_name: 'Sharma Traders', invoice_amount: 120000, invoice_date: M('07-05'), payment_status: 'Pending', days_overdue: 16 },
  { customer_name: 'Gupta & Sons',   invoice_amount: 128500, invoice_date: M('07-18'), payment_status: 'Pending', days_overdue: 3 },
  { customer_name: 'New Light House', invoice_amount: 64000, invoice_date: M('07-10'), payment_status: 'Pending', days_overdue: 11 },
  // last month (Jun) — bigger, so Jul shows a drop
  { customer_name: 'Sharma Traders', invoice_amount: 200000, invoice_date: M('06-12'), payment_status: 'Paid', payment_amount: 200000 },
  { customer_name: 'Bansal Hardware', invoice_amount: 150000, invoice_date: M('06-20'), payment_status: 'Paid', payment_amount: 150000 },
];

const transactions = [
  // purchases this month (payables)
  { type: 'out', category: 'purchase', amount: 96000, party_name: 'Metro Wholesale', transaction_date: M('07-08') },
  { type: 'out', category: 'purchase', amount: 85000, party_name: 'Sharma Traders', transaction_date: M('07-09') }, // Sharma is ALSO a supplier -> set-off
  // a payment reduces payable
  { type: 'out', category: 'payment', amount: 20000, party_name: 'Metro Wholesale', transaction_date: M('07-15') },
  // cash in/out
  { type: 'in',  category: 'receipt', amount: 200000, party_name: 'Sharma Traders', transaction_date: M('07-16') },
];

const products = [
  { id: 'p1', name: 'Copper Wire 1.5mm', current_stock: 42, unit_price: 1750, low_stock_alert: 120 }, // low
  { id: 'p2', name: 'Modular Switch',    current_stock: 3200, unit_price: 75, low_stock_alert: 400 }, // slow
  { id: 'p3', name: 'Halogen Lamp',      current_stock: 118, unit_price: 70, low_stock_alert: 0 },    // dead
  { id: 'p4', name: 'LED Bulb 9W',       current_stock: 900, unit_price: 85, low_stock_alert: 500 },  // fast
];

const stockMovements = [
  { product_id: 'p1', movement_type: 'sale', quantity: 190, moved_at: M('07-05') },
  { product_id: 'p1', movement_type: 'sale', quantity: 205, moved_at: M('06-05') },
  { product_id: 'p2', movement_type: 'sale', quantity: 160, moved_at: M('07-05') },
  { product_id: 'p2', movement_type: 'sale', quantity: 840, moved_at: M('06-05') },  // big drop -> slow
  { product_id: 'p4', movement_type: 'sale', quantity: 2100, moved_at: M('07-05') },
  // p3 halogen: no sales -> dead
];

const r = computeBrainSummary({ invoices, transactions, products, stockMovements, asOf });

let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✅' : '❌'} ${label}: ${JSON.stringify(got)}${ok ? '' : ' (expected ' + JSON.stringify(want) + ')'}`);
  ok ? pass++ : fail++;
}

check('sales this month', r.kpis.salesThis, 312500);              // 120000+128500+64000
check('sales last month', r.kpis.salesPrev, 350000);             // 200000+150000
check('sales direction is down', r.kpis.salesDelta < 0, true);
check('receivable total', r.position.receivable, 312500);        // 3 pending invoices
check('payable total', r.position.payable, 161000);              // Metro (96000-20000=76000) + Sharma 85000
check('set-off found for Sharma', r.setoff.some(s => s.name === 'Sharma Traders' && s.settle === 85000), true);
check('gross profit = sales - purchases', r.kpis.grossProfit, 312500 - 181000);
check('Copper Wire flagged low', r.products.find(p => p.name === 'Copper Wire 1.5mm').signal, 'low');
check('Modular Switch flagged slow', r.products.find(p => p.name === 'Modular Switch').signal, 'slow');
check('Halogen flagged dead', r.products.find(p => p.name === 'Halogen Lamp').signal, 'dead');
check('LED flagged fast', r.products.find(p => p.name === 'LED Bulb 9W').signal, 'fast');
check('has ranked actions', r.actions.length > 0, true);
check('top action is high severity', r.actions[0].sev, 'hi');

console.log(`\n${fail === 0 ? '🎉 ALL PASS' : '⚠️ FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
