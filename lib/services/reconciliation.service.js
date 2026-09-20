// FILE: lib/services/reconciliation.service.js
// Bank statement reconciliation — CSV import + amount+reference auto-matching.
//
// Scope (per user-approved scoping decision, see outputs/scoping-plan doc):
//   - Model this on the existing Razorpay-webhook auto-match already in server.js
//     (matched_type/matched_id/status on bank_transactions), not a new mechanism.
//   - Only an EXACT amount + explicit reference match is auto-applied, and only
//     when FEATURE_BANK_RECONCILIATION_ENABLED is on. Everything else (amount-only
//     match, multiple candidates, no reference found) is left for the owner to
//     confirm via the existing POST /api/bank/match route — surfaced as a
//     requires_approval ai_actions row, never silently auto-confirmed.
//   - Deliberately does NOT re-trigger the full mark-paid pipeline (WhatsApp
//     "payment celebration" message, cortex confirmInflow, customer score
//     recalculation) on auto-match — those are owner/customer-facing side
//     effects that shouldn't fire silently as a side effect of importing a
//     spreadsheet. They still fire normally when the owner uses the existing
//     manual mark-paid / bank-match flows.
const { supabase } = require('../config/supabaseClient');
const { safeLog }  = require('../observability/logger');
const { isEnabled } = require('../featureFlags');

const AMOUNT_TOLERANCE = 1; // paise-level rounding only — not a fuzzy-match tolerance

// ---------------------------------------------------------------------------
// CSV parsing — deliberately simple, matching the existing style used by
// POST /api/import/excel's CSV branch in server.js (line-split, not a full
// RFC-4180 parser). Flexible header matching so common Indian bank statement
// exports (which vary a lot in column naming) work without configuration.
// ---------------------------------------------------------------------------
const HEADER_ALIASES = {
  date:        ['date', 'txn date', 'transaction date', 'value date', 'posting date'],
  description: ['description', 'narration', 'particulars', 'remarks', 'details'],
  debit:       ['debit', 'withdrawal', 'withdrawal amt', 'withdrawal amount', 'dr'],
  credit:      ['credit', 'deposit', 'deposit amt', 'deposit amount', 'cr'],
  amount:      ['amount', 'txn amount', 'transaction amount'],
  type:        ['type', 'txn type', 'dr/cr', 'crdr'],
  reference:   ['reference', 'ref no', 'ref no.', 'cheque no', 'chq no', 'utr', 'upi ref no'],
};

function findHeaderIndex(headers, aliases) {
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i].trim().toLowerCase();
    if (aliases.includes(h)) return i;
  }
  return -1;
}

function splitCsvLine(line) {
  // Handles simple quoted fields (commas inside quotes) — a small step up from
  // the plain .split(',') used elsewhere in server.js, since bank statement
  // narrations frequently contain commas.
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === ',' && !inQuotes) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function toMoney(v) {
  const n = parseFloat(String(v || '0').replace(/[₹,]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Parse raw CSV text (a bank statement export) into normalised transaction rows.
 * @returns {{ txn_date, description, amount, type, reference }[]}
 */
function parseBankStatementCSV(csvText) {
  const lines = String(csvText || '').split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];

  const headers = splitCsvLine(lines[0]).map(h => h.toLowerCase());
  const idx = {
    date:        findHeaderIndex(headers, HEADER_ALIASES.date),
    description: findHeaderIndex(headers, HEADER_ALIASES.description),
    debit:       findHeaderIndex(headers, HEADER_ALIASES.debit),
    credit:      findHeaderIndex(headers, HEADER_ALIASES.credit),
    amount:      findHeaderIndex(headers, HEADER_ALIASES.amount),
    type:        findHeaderIndex(headers, HEADER_ALIASES.type),
    reference:   findHeaderIndex(headers, HEADER_ALIASES.reference),
  };

  const rows = [];
  for (const line of lines.slice(1)) {
    const cols = splitCsvLine(line);
    if (!cols.length || cols.every(c => !c)) continue;

    let amount = 0;
    let type = null;
    if (idx.debit >= 0 && toMoney(cols[idx.debit]) > 0) {
      amount = toMoney(cols[idx.debit]);
      type = 'debit';
    } else if (idx.credit >= 0 && toMoney(cols[idx.credit]) > 0) {
      amount = toMoney(cols[idx.credit]);
      type = 'credit';
    } else if (idx.amount >= 0) {
      amount = Math.abs(toMoney(cols[idx.amount]));
      const rawType = (idx.type >= 0 ? cols[idx.type] : '').toLowerCase();
      type = rawType.startsWith('cr') || rawType.startsWith('deposit') ? 'credit'
           : rawType.startsWith('dr') || rawType.startsWith('withdraw') ? 'debit'
           : (toMoney(cols[idx.amount]) < 0 ? 'debit' : 'credit');
    }
    if (!amount || !type) continue; // can't make sense of this row — skip rather than guess

    rows.push({
      txn_date:    idx.date >= 0 ? (cols[idx.date] || new Date().toISOString().split('T')[0]) : new Date().toISOString().split('T')[0],
      description: idx.description >= 0 ? cols[idx.description] : '',
      amount,
      type,
      reference:   idx.reference >= 0 ? cols[idx.reference] : '',
    });
  }
  return rows;
}

/**
 * Find candidate open entities (invoices for credit txns, purchases for debit
 * txns) that could match this transaction by amount, and classify the match.
 */
async function findCandidates(userId, txn) {
  const table = txn.type === 'credit' ? 'invoices' : 'purchases';
  let query;
  if (table === 'invoices') {
    query = supabase.from('invoices')
      .select('id, invoice_number, customer_name, invoice_amount, payment_amount')
      .eq('user_id', userId)
      .eq('payment_status', 'Pending');
  } else {
    query = supabase.from('purchases')
      .select('id, bill_number, supplier_name, amount, paid_amount')
      .eq('user_id', userId)
      .neq('status', 'paid');
  }
  const { data, error } = await query;
  if (error) { safeLog('error', '[Reconciliation] candidate lookup failed', { error: error.message, userId }); return []; }

  const desc = (txn.description || '').toLowerCase();
  const ref  = (txn.reference || '').toLowerCase();

  return (data || [])
    .map(row => {
      const outstanding = table === 'invoices'
        ? toMoney(row.invoice_amount) - toMoney(row.payment_amount)
        : toMoney(row.amount) - toMoney(row.paid_amount);
      const amountMatch = Math.abs(outstanding - txn.amount) <= AMOUNT_TOLERANCE;
      const refString = (table === 'invoices' ? row.invoice_number : row.bill_number || '') || '';
      const refMatch = !!refString && (desc.includes(refString.toLowerCase()) || (ref && ref.includes(refString.toLowerCase())));
      return { table, id: row.id, name: table === 'invoices' ? row.customer_name : row.supplier_name, outstanding, amountMatch, refMatch };
    })
    .filter(c => c.amountMatch);
}

/**
 * Decide how to handle one parsed transaction: auto-match (exact amount+ref,
 * only when the reconciliation flag is on), flag for review (ambiguous), or
 * leave unmatched (no candidates at all).
 */
async function reconcileTransaction(userId, txn, accountId) {
  const candidates = await findCandidates(userId, txn);
  const exactRefMatches = candidates.filter(c => c.refMatch);

  const base = {
    user_id:    userId,
    account_id: accountId || null,
    txn_date:   txn.txn_date,
    description: txn.description,
    amount:     txn.amount,
    type:       txn.type,
    source:     'csv_import',
  };

  // High confidence: exactly one candidate matches both amount AND reference,
  // and auto-apply is turned on.
  if (exactRefMatches.length === 1 && isEnabled('bank_reconciliation_enabled')) {
    const match = exactRefMatches[0];
    const { data: inserted, error } = await supabase.from('bank_transactions').insert([{
      ...base,
      status: 'matched',
      matched_type: match.table === 'invoices' ? 'invoice' : 'purchase',
      matched_id: String(match.id),
      match_confidence: 0.95,
      match_method: 'exact_ref',
    }]).select().single();
    if (error) { safeLog('error', '[Reconciliation] insert (matched) failed', { error: error.message, userId }); return null; }

    await applyMatchToEntity(userId, match, txn.amount);
    return inserted;
  }

  // No candidates at all → leave unmatched, no review action needed.
  if (!candidates.length) {
    const { data: inserted, error } = await supabase.from('bank_transactions').insert([{
      ...base, status: 'unmatched', match_confidence: null, match_method: null,
    }]).select().single();
    if (error) { safeLog('error', '[Reconciliation] insert (unmatched) failed', { error: error.message, userId }); return null; }
    return inserted;
  }

  // Everything else (amount-only matches, multiple candidates, ref match found
  // but auto-apply flag is off) → needs_review, surfaced as an owner-facing action.
  const { data: inserted, error } = await supabase.from('bank_transactions').insert([{
    ...base,
    status: 'needs_review',
    match_confidence: exactRefMatches.length ? 0.9 : 0.5,
    match_method: exactRefMatches.length ? 'exact_ref_flag_off' : 'amount_only',
  }]).select().single();
  if (error) { safeLog('error', '[Reconciliation] insert (needs_review) failed', { error: error.message, userId }); return null; }

  await supabase.from('ai_actions').insert([{
    user_id: userId,
    action_type: 'BANK_TXN_NEEDS_REVIEW',
    title: `Review bank transaction: ₹${txn.amount.toLocaleString('en-IN')} (${txn.type})`,
    description: `${txn.description || 'No description'} — ${candidates.length} possible match${candidates.length > 1 ? 'es' : ''}. Confirm the right one via Bank > Transactions.`,
    priority: 'medium',
    risk_level: 'low',
    related_entity_type: 'bank_transaction',
    related_entity_id: String(inserted.id),
    suggested_by: 'system',
    requires_approval: true,
    reason_json: {
      candidates: candidates.slice(0, 5).map(c => ({ type: c.table === 'invoices' ? 'invoice' : 'purchase', id: c.id, name: c.name, outstanding: c.outstanding, ref_match: c.refMatch })),
    },
  }]).catch(err => safeLog('warn', '[Reconciliation] failed to write review action', { error: err.message }));

  return inserted;
}

// Mirrors the paid-status update server.js's /api/mark-paid and /api/bank/match
// routes already do for their respective tables — kept intentionally narrow
// (no WhatsApp celebration send, no cortex confirmInflow/scoring recalc) since
// those are separate, owner/customer-facing side effects out of scope for a
// silent CSV-import auto-match.
async function applyMatchToEntity(userId, match, amount) {
  try {
    if (match.table === 'invoices') {
      await supabase.from('invoices').update({
        payment_status: 'Paid',
        payment_date: new Date().toISOString().split('T')[0],
        payment_amount: amount,
        updated_at: new Date(),
      }).eq('id', match.id).eq('user_id', userId);
    } else {
      const { data: purchase } = await supabase.from('purchases').select('amount, paid_amount').eq('id', match.id).eq('user_id', userId).maybeSingle();
      if (purchase) {
        const newPaid = toMoney(purchase.paid_amount) + amount;
        await supabase.from('purchases').update({
          paid_amount: newPaid,
          status: newPaid >= toMoney(purchase.amount) - AMOUNT_TOLERANCE ? 'paid' : 'partial',
        }).eq('id', match.id).eq('user_id', userId);
      }
    }
  } catch (err) {
    safeLog('error', '[Reconciliation] applyMatchToEntity failed', { error: err.message, userId, match });
  }
}

/**
 * Import a full bank statement CSV: parse, then reconcile each row.
 * @returns {{ imported: number, matched: number, needsReview: number, unmatched: number }}
 */
async function importStatement(userId, csvText, accountId) {
  const rows = parseBankStatementCSV(csvText);
  let matched = 0, needsReview = 0, unmatched = 0;

  for (const txn of rows) {
    const result = await reconcileTransaction(userId, txn, accountId);
    if (!result) continue;
    if (result.status === 'matched') matched++;
    else if (result.status === 'needs_review') needsReview++;
    else unmatched++;
  }

  safeLog('info', '[Reconciliation] Statement import complete', { userId, imported: rows.length, matched, needsReview, unmatched });
  return { imported: rows.length, matched, needsReview, unmatched };
}

module.exports = { parseBankStatementCSV, findCandidates, reconcileTransaction, importStatement };
