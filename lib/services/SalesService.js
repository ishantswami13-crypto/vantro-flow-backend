// FILE: lib/services/SalesService.js
const { supabase } = require('../config/supabaseClient');
const { emitBusinessEvent } = require('../events/EventEngine');
const { safeLog } = require('../observability/logger');

class SalesService {
  /**
   * Fetch sales with fallback to 'invoices' table to restore missing data visibility
   */
  async getSales(userId, businessId, filters = {}) {
    try {
      // 1. Try fetching from new sales table
      let q = supabase.from('sales').select('*').eq('user_id', userId).order('sale_date', { ascending: false });
      if (filters.status) q = q.eq('status', filters.status);
      
      const { data, error } = await q;

      if (error) {
        // If table doesn't exist, fallback to invoices (Data Ownership Repair)
        if (this._isMissingSchemaError(error)) {
          safeLog('warn', '[SalesService] sales table missing, falling back to invoices for data visibility', { userId, businessId });
          return await this._getSalesFromInvoices(userId, filters);
        }
        throw error;
      }

      return (data || []).map(s => ({ ...s, total_amount: parseFloat(s.amount) || 0 }));
    } catch (err) {
      safeLog('error', '[SalesService] Error fetching sales', { error: err.message, userId });
      throw err;
    }
  }

  async _getSalesFromInvoices(userId, filters) {
    let q = supabase.from('invoices').select('*').eq('user_id', userId).order('created_at', { ascending: false });
    const { data, error } = await q;
    if (error) {
      if (this._isMissingSchemaError(error)) return [];
      throw error;
    }
    
    // Map invoices to sales structure
    let mapped = (data || []).map(inv => ({
      id: inv.id,
      user_id: inv.user_id,
      customer_name: inv.customer_name,
      amount: inv.invoice_amount,
      total_amount: parseFloat(inv.invoice_amount) || 0,
      paid_amount: inv.payment_amount || 0,
      status: inv.payment_status === 'Paid' ? 'paid' : (inv.payment_status === 'Partial' ? 'partial' : 'unpaid'),
      sale_date: inv.invoice_date || inv.created_at,
      due_date: inv.due_date,
      created_at: inv.created_at
    }));

    if (filters.status) {
      mapped = mapped.filter(s => s.status === filters.status);
    }
    return mapped;
  }

  _isMissingSchemaError(error) {
    const code = error?.code || '';
    const message = String(error?.message || '').toLowerCase();
    return (
      code === '42P01' ||
      code === '42703' ||
      code === 'PGRST204' ||
      message.includes('does not exist') ||
      message.includes('could not find') ||
      message.includes('schema cache')
    );
  }
}

module.exports = new SalesService();
