// node --test lib/ai/directAnswers.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { answerFromLedger, detectIntent } = require('./directAnswers.js');

const asOf = Date.parse('2026-11-03T12:00:00Z');
const inv = (customer_name, invoice_amount, due_date, extra = {}) => ({ customer_name, invoice_amount, due_date, payment_status: 'Pending', ...extra });
const ledger = [
  inv('Narmada Valves (Fixture)', 685000, '2026-07-07', { invoice_number: 'A/1' }),   // 119 days
  inv('Narmada Valves (Fixture)', 300000, '2026-12-01', { invoice_number: 'A/2' }),   // not due
  inv('Kaveri Pumps (Fixture)', 248600, '2026-09-06', { invoice_number: 'A/3' }),     // 58 days
  inv('Patel Irrigation (Fixture)', 56200, '2026-10-20', { invoice_number: 'A/4', payment_amount: 6200 }), // 14 days, 50,000 left
  inv('Paid Co (Fixture)', 99999, '2026-01-01', { payment_status: 'Paid' }),
];

test('who owes the most: ranked by open balance, share of the total, no model', () => {
  const a = answerFromLedger('Who owes us the most right now?', ledger, { currency: 'INR', asOf });
  assert.equal(a.intent, 'top');
  assert.equal(a.figures.total, 685000 + 300000 + 248600 + 50000);
  assert.equal(a.figures.top[0].customer, 'Narmada Valves (Fixture)');
  assert.match(a.message, /^Narmada Valves \(Fixture\) owes you the most: ₹9,85,000, 77% of the ₹12,83,600/);
  assert.match(a.message, /without an AI model/);
  assert.doesNotMatch(a.message, /Paid Co/);
});

test('total outstanding and overdue, part-payments reduce what is owed', () => {
  const a = answerFromLedger('What is our total outstanding, and how much of it is overdue?', ledger, { currency: 'INR', asOf });
  assert.equal(a.intent, 'total');
  assert.equal(a.figures.overdue, 685000 + 248600 + 50000);
  assert.equal(a.figures.overdueInvoices, 3);
  assert.match(a.message, /oldest is 119 days late/);
});

test('invoices more than N days overdue', () => {
  const a = answerFromLedger('Which invoices are more than 30 days overdue?', ledger, { currency: 'INR', asOf });
  assert.equal(a.intent, 'overdue_over');
  assert.equal(a.figures.count, 2);
  assert.equal(a.figures.sum, 685000 + 248600);
  const none = answerFromLedger('anything over 200 days overdue', ledger, { currency: 'INR', asOf });
  assert.equal(none.figures.count, 0);
});

test('a named customer', () => {
  const a = answerFromLedger('How much does Kaveri owe?', ledger, { currency: 'INR', asOf });
  assert.equal(a.intent, 'customer');
  assert.equal(a.figures.owed, 248600);
});

test('the business currency is used, and mixed currencies are never summed', () => {
  const usd = answerFromLedger('total outstanding', [inv('Harbor (Fixture)', 12000, '2026-12-01')], { currency: 'USD', asOf });
  assert.match(usd.message, /\$12,000/);
  const mixed = answerFromLedger('total outstanding', [inv('A (Fixture)', 1, '2026-12-01', { currency: 'USD' }), inv('B (Fixture)', 1, '2026-12-01', { currency: 'EUR' })], { currency: 'USD', asOf });
  assert.equal(mixed.figures, null);
  assert.match(mixed.message, /more than one currency/);
});

test('questions it does not recognise are left to the model', () => {
  for (const q of ['Write a polite reminder for Kaveri', 'What will cash look like next quarter?', 'hello', '']) {
    assert.equal(answerFromLedger(q, ledger, { currency: 'INR', asOf }), null, q);
  }
  assert.equal(detectIntent('Who are our best-paying customers?', []), null);
});

test('an empty ledger says so instead of inventing figures', () => {
  const a = answerFromLedger('Who owes us the most?', [], { currency: 'INR', asOf });
  assert.match(a.message, /no unpaid invoices/);
});
