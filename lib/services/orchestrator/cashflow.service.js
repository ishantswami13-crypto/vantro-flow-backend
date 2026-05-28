// FILE: lib/services/orchestrator/cashflow.service.js
// Creates and updates cashflow_events rows so the forecast page always reflects reality.
// Before Cortex: cash sales had no ledger entry; credit sales had no expected-inflow tracking.
// After Cortex: every sale, purchase, and payment creates the right cashflow_event.
// Never throws — cashflow failures are logged and swallowed.
const { supabase } = require('../../config/supabaseClient');
const { safeLog } = require('../../observability/logger');

function today() {
  return new Date().toISOString().split('T')[0];
}

// Called after a sale is created.
// Cash portion   → actual_inflow  (money already received)
// Credit portion → expected_inflow (money coming on due date)
async function createFromSale(userId, sale, totalAmount, paidAmount) {
  if (!userId || !sale?.id) return;
  const paid    = parseFloat(paidAmount  || 0);
  const total   = parseFloat(totalAmount || 0);
  const unpaid  = Math.max(0, total - paid);
  const saleDate = sale.sale_date || today();
  const dueDate  = sale.due_date  || saleDate;

  const rows = [];

  if (paid > 0) {
    rows.push({
      user_id:       userId,
      event_type:    'actual_inflow',
      source_type:   'sale',
      source_id:     sale.id,
      amount:        paid,
      expected_date: saleDate,
      actual_date:   saleDate,
      status:        'confirmed',
      notes:         `Cash received — ${sale.customer_name || 'sale'}`,
    });
  }

  if (unpaid > 0) {
    rows.push({
      user_id:       userId,
      event_type:    'expected_inflow',
      source_type:   'sale',
      source_id:     sale.id,
      amount:        unpaid,
      expected_date: dueDate,
      status:        'expected',
      notes:         `Receivable — ${sale.customer_name || 'sale'}`,
    });
  }

  if (!rows.length) return;

  try {
    const { error } = await supabase.from('cashflow_events').insert(rows);
    if (error) safeLog('warn', '[CashflowService] createFromSale failed', { error: error.message, saleId: sale.id });
  } catch (err) {
    safeLog('error', '[CashflowService] createFromSale unexpected error', { error: err.message });
  }
}

// Called after a purchase is created.
// Cash portion   → actual_outflow
// Credit portion → expected_outflow (payable due on due_date)
async function createFromPurchase(userId, purchase, totalAmount, paidAmount) {
  if (!userId || !purchase?.id) return;
  const paid         = parseFloat(paidAmount  || 0);
  const total        = parseFloat(totalAmount || 0);
  const unpaid       = Math.max(0, total - paid);
  const purchaseDate = purchase.purchase_date || today();
  const dueDate      = purchase.due_date      || purchaseDate;

  const rows = [];

  if (paid > 0) {
    rows.push({
      user_id:       userId,
      event_type:    'actual_outflow',
      source_type:   'purchase',
      source_id:     purchase.id,
      amount:        paid,
      expected_date: purchaseDate,
      actual_date:   purchaseDate,
      status:        'confirmed',
      notes:         `Cash paid — ${purchase.supplier_name || 'purchase'}`,
    });
  }

  if (unpaid > 0) {
    rows.push({
      user_id:       userId,
      event_type:    'expected_outflow',
      source_type:   'purchase',
      source_id:     purchase.id,
      amount:        unpaid,
      expected_date: dueDate,
      status:        'expected',
      notes:         `Payable — ${purchase.supplier_name || 'purchase'}`,
    });
  }

  if (!rows.length) return;

  try {
    const { error } = await supabase.from('cashflow_events').insert(rows);
    if (error) safeLog('warn', '[CashflowService] createFromPurchase failed', { error: error.message, purchaseId: purchase.id });
  } catch (err) {
    safeLog('error', '[CashflowService] createFromPurchase unexpected error', { error: err.message });
  }
}

// Called when a payment is received (mark-paid).
// Marks any pending expected_inflow for this invoice as confirmed.
// Also inserts a fresh actual_inflow so the forecast sees real money in.
async function confirmInflow(userId, invoiceId, amount, actualDate) {
  if (!userId || !invoiceId) return;
  const dateStr = actualDate || today();

  try {
    // 1. Mark existing expected_inflow as confirmed
    await supabase
      .from('cashflow_events')
      .update({ status: 'confirmed', actual_date: dateStr })
      .eq('user_id',    userId)
      .eq('source_id',  invoiceId)
      .eq('event_type', 'expected_inflow')
      .eq('status',     'expected');

    // 2. Insert actual_inflow (idempotent: check not already created for this invoice today)
    const { data: existing } = await supabase
      .from('cashflow_events')
      .select('id')
      .eq('user_id',    userId)
      .eq('source_id',  invoiceId)
      .eq('event_type', 'actual_inflow')
      .eq('actual_date', dateStr)
      .maybeSingle();

    if (!existing) {
      await supabase.from('cashflow_events').insert([{
        user_id:       userId,
        event_type:    'actual_inflow',
        source_type:   'invoice',
        source_id:     invoiceId,
        amount:        parseFloat(amount || 0),
        expected_date: dateStr,
        actual_date:   dateStr,
        status:        'confirmed',
        notes:         'Payment received',
      }]);
    }
  } catch (err) {
    safeLog('error', '[CashflowService] confirmInflow unexpected error', { error: err.message, invoiceId });
  }
}

// Read 7-day cashflow window for rules engine evaluation.
// Returns { expected_inflow, expected_outflow } for the next 7 days.
async function getWeekForecast(userId) {
  const from = today();
  const to   = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  const { data } = await supabase
    .from('cashflow_events')
    .select('event_type, amount')
    .eq('user_id', userId)
    .eq('status', 'expected')
    .gte('expected_date', from)
    .lte('expected_date', to);

  const rows = data || [];
  return {
    expected_inflow:  rows.filter(r => r.event_type === 'expected_inflow') .reduce((s, r) => s + parseFloat(r.amount || 0), 0),
    expected_outflow: rows.filter(r => r.event_type === 'expected_outflow').reduce((s, r) => s + parseFloat(r.amount || 0), 0),
  };
}

module.exports = { createFromSale, createFromPurchase, confirmInflow, getWeekForecast };
