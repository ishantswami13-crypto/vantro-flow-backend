// FILE: lib/services/tallyImport.service.js
// Tally voucher ingestion — maps normalised Tally vouchers into existing tables:
//   Sales        -> invoices          (receivables; what collections/brain reads)
//   Purchase     -> purchases         (payables)
//   Receipt      -> bank_transactions (credit — money in)
//   Payment      -> bank_transactions (debit — money out)
//   voucher items-> products + stock_movements (stock in on purchase, out on sale)
//
// Idempotent by design: every voucher gets a stable ref "TLY-<type>-<vchNo>-<date>"
// stored in invoice_number / bill_number / bank description / stock reference.
// Re-importing the same date range never duplicates rows.
//
// Import NEVER auto-marks anything paid — matching receipts to invoices stays the
// job of the reconciliation service behind FEATURE_BANK_RECONCILIATION_ENABLED.

'use strict';

const MAX_VOUCHERS = 5000;

function tallyRef(v) {
  const type = String(v.type || '').replace(/\s+/g, '').slice(0, 8).toUpperCase();
  const no = String(v.voucherNo || 'NA').replace(/[^\w-]/g, '').slice(0, 24);
  const date = String(v.date || '').replace(/-/g, '');
  return `TLY-${type}-${no}-${date}`;
}

function toAmount(raw) {
  const n = parseFloat(String(raw ?? '').replace(/[₹,\s]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

function toISODate(raw) {
  const s = String(raw || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return null;
}

function classify(type) {
  const t = String(type || '').toLowerCase();
  if (t.includes('sales') || t.includes('credit note')) return 'sales';
  if (t.includes('purchase') || t.includes('debit note')) return 'purchase';
  if (t.includes('receipt')) return 'receipt';
  if (t.includes('payment')) return 'payment';
  return null;
}

/** Validate + normalise the incoming payload. Returns { vouchers, rejected }. */
function normalizeVouchers(rawList) {
  const vouchers = [];
  const rejected = [];
  for (const raw of rawList) {
    const kind = classify(raw.type);
    const date = toISODate(raw.date);
    const amount = toAmount(raw.amount);
    const party = String(raw.party || '').trim().slice(0, 200);
    if (!kind || !date || !amount || !party) {
      rejected.push({ voucherNo: raw.voucherNo || null, type: raw.type || null, reason: !kind ? 'unsupported_type' : !date ? 'bad_date' : !amount ? 'bad_amount' : 'missing_party' });
      continue;
    }
    const items = Array.isArray(raw.items)
      ? raw.items
          .map((it) => ({
            name: String(it.name || '').trim().slice(0, 200),
            qty: Math.abs(parseFloat(it.qty)) || 0,
            rate: toAmount(it.rate) || 0,
          }))
          .filter((it) => it.name && it.qty > 0)
          .slice(0, 100)
      : [];
    vouchers.push({ kind, type: raw.type, date, amount, party, voucherNo: raw.voucherNo || '', items, ref: tallyRef(raw) });
  }
  return { vouchers, rejected };
}

async function importTallyVouchers(supabase, userId, rawList) {
  if (!Array.isArray(rawList) || rawList.length === 0) {
    return { error: 'vouchers array required', status: 400 };
  }
  if (rawList.length > MAX_VOUCHERS) {
    return { error: `Too many vouchers in one request (max ${MAX_VOUCHERS}). Split into smaller date ranges.`, status: 400 };
  }

  const { vouchers, rejected } = normalizeVouchers(rawList);
  const counts = { sales: 0, purchase: 0, receipt: 0, payment: 0, products: 0, stock_movements: 0 };
  const skippedExisting = { sales: 0, purchase: 0, receipt: 0, payment: 0 };

  const byKind = { sales: [], purchase: [], receipt: [], payment: [] };
  for (const v of vouchers) byKind[v.kind].push(v);

  // ── Existing refs (one query per table, not per voucher) ──────────────────
  const [{ data: exInv }, { data: exPur }, { data: exBank }, { data: exMov }] = await Promise.all([
    supabase.from('invoices').select('invoice_number').eq('user_id', userId).like('invoice_number', 'TLY-%'),
    supabase.from('purchases').select('bill_number').eq('user_id', userId).like('bill_number', 'TLY-%'),
    supabase.from('bank_transactions').select('description').eq('user_id', userId).like('description', '[TLY-%'),
    supabase.from('stock_movements').select('reference').eq('user_id', userId).like('reference', 'TLY-%'),
  ]);
  const haveInv = new Set((exInv || []).map((r) => r.invoice_number));
  const havePur = new Set((exPur || []).map((r) => r.bill_number));
  const haveBank = new Set((exBank || []).map((r) => String(r.description).match(/^\[([^\]]+)\]/)?.[1]).filter(Boolean));
  const haveMov = new Set((exMov || []).map((r) => r.reference));

  // ── Sales -> invoices ─────────────────────────────────────────────────────
  const invRows = [];
  for (const v of byKind.sales) {
    if (haveInv.has(v.ref)) { skippedExisting.sales++; continue; }
    haveInv.add(v.ref);
    const daysOverdue = Math.max(0, Math.floor((Date.now() - new Date(v.date).getTime()) / 86400000));
    invRows.push({
      user_id: userId,
      customer_name: v.party,
      invoice_amount: v.amount,
      invoice_date: v.date,
      invoice_number: v.ref,
      payment_status: 'Pending',
      days_overdue: daysOverdue,
      created_at: new Date(),
    });
  }
  if (invRows.length) {
    const { error } = await supabase.from('invoices').insert(invRows);
    if (error) return { error: `invoices insert failed: ${error.message}`, status: 500 };
    counts.sales = invRows.length;
  }

  // ── Purchase -> purchases ─────────────────────────────────────────────────
  const purRows = [];
  for (const v of byKind.purchase) {
    if (havePur.has(v.ref)) { skippedExisting.purchase++; continue; }
    havePur.add(v.ref);
    purRows.push({
      user_id: userId,
      supplier_name: v.party,
      amount: v.amount,
      paid_amount: 0,
      status: 'unpaid',
      purchase_date: v.date,
      bill_number: v.ref,
      category: 'material',
      notes: 'Imported from Tally',
    });
  }
  if (purRows.length) {
    const { error } = await supabase.from('purchases').insert(purRows);
    if (error) return { error: `purchases insert failed: ${error.message}`, status: 500 };
    counts.purchase = purRows.length;
  }

  // ── Receipt / Payment -> bank_transactions ────────────────────────────────
  const bankRows = [];
  for (const v of [...byKind.receipt, ...byKind.payment]) {
    if (haveBank.has(v.ref)) { skippedExisting[v.kind]++; continue; }
    haveBank.add(v.ref);
    bankRows.push({
      user_id: userId,
      txn_date: v.date,
      amount: v.amount,
      type: v.kind === 'receipt' ? 'credit' : 'debit',
      description: `[${v.ref}] ${v.kind === 'receipt' ? 'Receipt from' : 'Payment to'} ${v.party}`,
      status: 'unmatched',
    });
    counts[v.kind]++;
  }
  if (bankRows.length) {
    const { error } = await supabase.from('bank_transactions').insert(bankRows);
    if (error) return { error: `bank_transactions insert failed: ${error.message}`, status: 500 };
  } else {
    counts.receipt = 0;
    counts.payment = 0;
  }

  // ── Voucher items -> products + stock_movements ───────────────────────────
  const itemVouchers = [...byKind.sales, ...byKind.purchase].filter((v) => v.items.length);
  if (itemVouchers.length) {
    const { data: prodData, error: prodErr } = await supabase
      .from('products').select('id, name, current_stock').eq('user_id', userId);
    if (prodErr) return { error: `products read failed: ${prodErr.message}`, status: 500 };
    const prodByName = new Map((prodData || []).map((p) => [p.name.toLowerCase(), p]));

    for (const v of itemVouchers) {
      const direction = v.kind === 'purchase' ? 'in' : 'out';
      for (const it of v.items) {
        const movRef = `${v.ref}:${it.name.slice(0, 60)}`;
        if (haveMov.has(movRef)) continue;
        haveMov.add(movRef);

        let prod = prodByName.get(it.name.toLowerCase());
        if (!prod) {
          const { data: created, error: cErr } = await supabase
            .from('products')
            .insert([{ user_id: userId, name: it.name, unit_price: it.rate || 0, unit: 'unit', current_stock: 0, low_stock_alert: 10 }])
            .select('id, name, current_stock').single();
          if (cErr || !created) continue;
          prod = created;
          prodByName.set(it.name.toLowerCase(), prod);
          counts.products++;
        }

        const qty = Math.round(it.qty);
        if (qty <= 0) continue;
        const delta = direction === 'in' ? qty : -qty;
        const newStock = Math.max(0, (prod.current_stock || 0) + delta);
        const [{ error: mErr }] = await Promise.all([
          supabase.from('stock_movements').insert([{
            user_id: userId, product_id: prod.id, movement_type: direction,
            quantity: qty, unit_cost: it.rate || null, reference: movRef,
            notes: `Tally ${v.type} ${v.voucherNo || ''}`.trim(),
          }]),
          supabase.from('products').update({ current_stock: newStock, updated_at: new Date() }).eq('id', prod.id).eq('user_id', userId),
        ]);
        if (!mErr) {
          prod.current_stock = newStock;
          counts.stock_movements++;
        }
      }
    }
  }

  return {
    success: true,
    imported: counts,
    skipped_existing: skippedExisting,
    rejected,
    message: `Tally import: ${counts.sales} sales, ${counts.purchase} purchases, ${counts.receipt} receipts, ${counts.payment} payments, ${counts.stock_movements} stock movements (${Object.values(skippedExisting).reduce((a, b) => a + b, 0)} already imported, ${rejected.length} rejected).`,
  };
}

module.exports = { importTallyVouchers, normalizeVouchers, tallyRef };
