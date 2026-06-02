// FILE: cortex-lab/seed.js
// Helpers to create test fixtures via the public API (never direct DB writes).
// Every row name/notes/description carries the run-ID marker for cleanup.

'use strict';

function tagged(runId, suffix = '') { return `[cortex-test ${runId}${suffix ? ' ' + suffix : ''}]`; }

async function createCustomer(http, token, { runId, name = 'Cortex Test Customer', phone = '+919900000001' }) {
  // Public customer endpoint isn't surfaced in core API — instead customers
  // are auto-created from invoices. Return a synthetic customer descriptor.
  return { name: `${name} ${tagged(runId)}`, phone, _marker: tagged(runId) };
}

async function createCreditSale(http, token, { runId, customer, amount = 5000, dueInDays = 15 }) {
  return http.post('/api/sales', {
    token,
    body: {
      customer_name: customer.name,
      phone:         customer.phone,
      total_amount:  amount,
      paid_amount:   0,
      payment_method:'credit',
      notes:         `${tagged(runId, 'credit-sale')} synthetic test row`,
      due_in_days:   dueInDays,
    },
  });
}

async function recordPayment(http, token, { runId, invoiceId, amount }) {
  return http.post('/api/mark-paid', {
    token,
    body: { invoice_id: invoiceId, amount, notes: `${tagged(runId, 'payment')}` },
  });
}

module.exports = { tagged, createCustomer, createCreditSale, recordPayment };
