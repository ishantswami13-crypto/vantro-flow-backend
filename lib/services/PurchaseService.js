// FILE: lib/services/PurchaseService.js
const { supabase } = require('../config/supabaseClient');
const { emitBusinessEvent } = require('../events/EventEngine');
const { safeLog } = require('../observability/logger');

class PurchaseService {
  /**
   * Fetch purchases with fallback to transactions/bills to restore missing data visibility
   */
  async getPurchases(userId, businessId, filters = {}) {
    try {
      // 1. Try fetching from new purchases table
      let q = supabase.from('purchases').select('*').eq('user_id', userId).order('purchase_date', { ascending: false });
      if (filters.status) q = q.eq('status', filters.status);
      
      const { data, error } = await q;

      if (error) {
        // If table doesn't exist, fallback to transactions (Data Ownership Repair)
        if (this._isMissingSchemaError(error)) {
          safeLog('warn', '[PurchaseService] purchases table missing, falling back to transactions for data visibility', { userId, businessId });
          return await this._getPurchasesFromTransactions(userId, filters);
        }
        throw error;
      }

      return (data || []).map(p => ({ ...p, total_amount: parseFloat(p.amount) || 0 }));
    } catch (err) {
      safeLog('error', '[PurchaseService] Error fetching purchases', { error: err.message, userId });
      throw err;
    }
  }

  async _getPurchasesFromTransactions(userId, filters) {
    let q = supabase.from('transactions').select('*').eq('user_id', userId).eq('type', 'out').order('transaction_date', { ascending: false });
    const { data, error } = await q;
    if (error) {
      if (this._isMissingSchemaError(error)) return [];
      throw error;
    }
    
    // Map transactions to purchases structure
    let mapped = (data || []).map(txn => ({
      id: txn.id,
      user_id: txn.user_id,
      supplier_name: txn.party_name || txn.description || 'Unknown Supplier',
      amount: txn.amount,
      total_amount: parseFloat(txn.amount) || 0,
      paid_amount: txn.amount, // old transactions are typically fully paid if they are in the ledger
      status: 'paid',
      purchase_date: txn.transaction_date,
      created_at: txn.created_at
    }));

    if (filters.status) {
      mapped = mapped.filter(p => p.status === filters.status);
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

module.exports = new PurchaseService();
