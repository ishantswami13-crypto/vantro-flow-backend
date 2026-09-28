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
// Import never GUESSES a payment. The one exception is Tally's own bill-wise
// allocation: a Receipt or Credit Note that the owner settled "Agst Ref <bill>"
// in Tally reduces exactly that bill (same party, same bill name) — the books
// say so. Everything else (on-account/advance receipts, bills Starlane has not
// seen) is counted and left to the reconciliation service behind
// FEATURE_BANK_RECONCILIATION_ENABLED.
//
// Sales keep Tally's due date (from the bill's credit period); without one the
// bill is due on its date, as Tally treats it. Credit and Debit Notes are
// adjustments, never new receivables or payables.
//
// "Opening Bill" rows come from Tally's Bills Receivable report as of the day
// before the synced range: bills from earlier years still unpaid then, at the
// amount still owed. A bill is one invoice however it arrives — an opening
// bill and a day-book sale with the same party, bill number and date are the
// same bill, and whichever came first is kept.

'use strict';

const MAX_VOUCHERS = 5000;
const OPENING_PREFIX = 'TLY-OPENINGB-';

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
  if (t === 'opening bill') return 'opening';
  if (t.includes('credit note')) return 'credit_note';
  if (t.includes('debit note')) return 'debit_note';
  if (t.includes('sales')) return 'sales';
  if (t.includes('purchase')) return 'purchase';
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
    const dueDate = toISODate(raw.dueDate);
    const bills = Array.isArray(raw.bills)
      ? raw.bills
          .map((b) => ({ name: String(b?.name || '').trim().slice(0, 60), type: String(b?.type || ''), amount: toAmount(b?.amount) }))
          .filter((b) => b.name && b.amount)
          .slice(0, 50)
      : [];
    vouchers.push({ kind, type: raw.type, date, amount, party, voucherNo: raw.voucherNo || '', items, ref: tallyRef(raw), dueDate, bills });
  }
  return { vouchers, rejected };
}

// A customer's mobile number as written in a Tally ledger: Indian mobiles
// only (10 digits starting 6-9, with or without +91 / 0). Anything else is
// left out rather than guessed at.
function toMobile(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? d : null;
}

/** Tally party ledgers' mobile numbers: [{ party, phone }] -> Map(lower(party) -> 10-digit mobile). */
function normalizeContacts(list) {
  const out = new Map();
  let invalid = 0;
  for (const c of Array.isArray(list) ? list.slice(0, MAX_VOUCHERS) : []) {
    const party = String(c?.party || '').trim().slice(0, 200);
    const phone = toMobile(c?.phone);
    if (!party) continue;
    if (!phone) { invalid++; continue; }
    if (!out.has(party.toLowerCase())) out.set(party.toLowerCase(), { party, phone });
  }
  return { byParty: out, invalid };
}

async function importTallyVouchers(supabase, userId, rawList, { contacts: rawContacts } = {}) {
  if (!Array.isArray(rawList)) {
    return { error: 'vouchers array required', status: 400 };
  }
  if (rawList.length > MAX_VOUCHERS) {
    return { error: `Too many vouchers in one request (max ${MAX_VOUCHERS}). Split into smaller date ranges.`, status: 400 };
  }

  const { vouchers, rejected } = normalizeVouchers(rawList);
  const counts = { opening: 0, sales: 0, purchase: 0, receipt: 0, payment: 0, products: 0, stock_movements: 0, bills_settled: 0, bills_part_paid: 0 };
  const skippedExisting = { opening: 0, sales: 0, purchase: 0, receipt: 0, payment: 0 };
  // Money Starlane could not tie to a bill it knows — reported, never guessed.
  const unapplied = { on_account: 0, bill_not_found: 0, debit_notes: 0 };

  const byKind = { opening: [], sales: [], purchase: [], receipt: [], payment: [], credit_note: [], debit_note: [] };
  for (const v of vouchers) byKind[v.kind].push(v);

  // ── Existing refs (one query per table, not per voucher) ──────────────────
  const [{ data: exInv }, { data: exPur }, { data: exBank }, { data: exMov }, { data: phones }] = await Promise.all([
    supabase.from('invoices').select('invoice_number, customer_name').eq('user_id', userId).like('invoice_number', 'TLY-%'),
    supabase.from('purchases').select('bill_number').eq('user_id', userId).like('bill_number', 'TLY-%'),
    supabase.from('bank_transactions').select('description').eq('user_id', userId).like('description', '[TLY-%'),
    supabase.from('stock_movements').select('reference').eq('user_id', userId).like('reference', 'TLY-%'),
    // Tally vouchers carry no phone number; a customer's number already on file
    // (on their other invoices) goes on their new bills, so reminders can reach them.
    supabase.from('invoices').select('customer_name, customer_phone').eq('user_id', userId).not('customer_phone', 'is', null),
  ]);
  const phoneOf = new Map();
  for (const r of phones || []) {
    const k = String(r.customer_name || '').trim().toLowerCase();
    if (r.customer_phone && String(r.customer_phone).trim() && !phoneOf.has(k)) phoneOf.set(k, String(r.customer_phone).trim());
  }
  // Numbers from Tally's party ledgers fill only where Starlane has none: a
  // number the owner already has on file is never replaced.
  const contacts = normalizeContacts(rawContacts);
  const contactUse = { received: Array.isArray(rawContacts) ? rawContacts.length : 0, customers_updated: 0, not_a_mobile: contacts.invalid };
  const fromTally = [];
  for (const [k, c] of contacts.byParty) {
    if (!phoneOf.has(k)) { phoneOf.set(k, c.phone); fromTally.push(c); }
  }
  const haveInv = new Set((exInv || []).map((r) => r.invoice_number));
  // The same bill under another voucher type: party + "<billNo>-<date>".
  const billKey = (party, ref) => `${String(party || '').trim().toLowerCase()}|${String(ref).replace(/^TLY-[^-]*-/, '')}`;
  const anyBill = new Set((exInv || []).map((r) => billKey(r.customer_name, r.invoice_number)));
  const openingBill = new Set((exInv || []).filter((r) => r.invoice_number.startsWith(OPENING_PREFIX)).map((r) => billKey(r.customer_name, r.invoice_number)));
  const havePur = new Set((exPur || []).map((r) => r.bill_number));
  const haveBank = new Set((exBank || []).map((r) => String(r.description).match(/^\[([^\]]+)\]/)?.[1]).filter(Boolean));
  const haveMov = new Set((exMov || []).map((r) => r.reference));

  // ── Opening bills + Sales -> invoices ────────────────────────────────────
  const invRows = [];
  for (const v of [...byKind.opening, ...byKind.sales]) {
    const key = billKey(v.party, v.ref);
    if (haveInv.has(v.ref) || (v.kind === 'opening' ? anyBill.has(key) : openingBill.has(key))) { skippedExisting[v.kind]++; continue; }
    haveInv.add(v.ref);
    anyBill.add(key);
    if (v.kind === 'opening') openingBill.add(key);
    const due = v.dueDate || v.date;
    const daysOverdue = Math.max(0, Math.floor((Date.now() - new Date(`${due}T00:00:00Z`).getTime()) / 86400000));
    invRows.push({
      user_id: userId,
      customer_name: v.party,
      customer_phone: phoneOf.get(v.party.toLowerCase()) || null,
      invoice_amount: v.amount,
      invoice_date: v.date,
      due_date: due,
      invoice_number: v.ref,
      payment_status: 'Pending',
      days_overdue: daysOverdue,
      ...(v.kind === 'opening' ? { payment_notes: 'Opening balance from Tally: the amount still owed when the synced range starts.' } : {}),
      created_at: new Date(),
    });
    counts[v.kind]++;
  }
  if (invRows.length) {
    const { error } = await supabase.from('invoices').insert(invRows);
    if (error) return { error: `invoices insert failed: ${error.message}`, status: 500 };
  } else {
    counts.opening = 0;
    counts.sales = 0;
  }

  // Existing bills of those customers get the number too.
  for (const c of fromTally) {
    const { data, error } = await supabase.from('invoices').update({ customer_phone: c.phone })
      .eq('user_id', userId).eq('customer_name', c.party).is('customer_phone', null).select('id');
    if (!error && (data || []).length) contactUse.customers_updated++;
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

  // ── Bill-wise settlement: "Agst Ref" on Receipts / Credit Notes ───────────
  const settle = await applyBillSettlements(supabase, userId, [...byKind.receipt, ...byKind.credit_note], counts, unapplied);
  if (settle?.error) return settle;
  unapplied.debit_notes = byKind.debit_note.length;

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

  const notApplied = Object.values(unapplied).reduce((a, b) => a + b, 0);
  return {
    success: true,
    imported: counts,
    skipped_existing: skippedExisting,
    unapplied,
    contacts: contactUse,
    rejected,
    message: `Tally import: ${counts.opening ? `${counts.opening} opening bills, ` : ''}${counts.sales} sales, ${counts.purchase} purchases, ${counts.receipt} receipts, ${counts.payment} payments, ${counts.stock_movements} stock movements; ${counts.bills_settled} bills settled, ${counts.bills_part_paid} part-paid (${Object.values(skippedExisting).reduce((a, b) => a + b, 0)} already imported, ${notApplied} not tied to a bill, ${rejected.length} rejected).`,
  };
}

// A bill named in Tally is identified by party + bill name. Tally restarts
// voucher numbering each financial year, so the same name can recur: only
// bills dated on or before the settling voucher count, and if that still
// leaves more than one open bill it is reported, not guessed.
function billPattern(name) {
  const no = String(name).replace(/[^\w-]/g, '').slice(0, 24);
  return no ? new RegExp(`^TLY-[^-]*-${no.replace(/[-]/g, '\\-')}-\\d{8}$`) : null;
}

async function applyBillSettlements(supabase, userId, settling, counts, unapplied) {
  const withBills = settling.filter((v) => v.bills.length);
  if (!withBills.length) return null;
  const hasAgainst = withBills.some((v) => v.bills.some((b) => b.type === 'against'));
  let invoices = [];
  if (hasAgainst) {
    const { data, error } = await supabase
      .from('invoices')
      .select('id, customer_name, invoice_number, invoice_date, invoice_amount, payment_amount, payment_status, payment_notes')
      .eq('user_id', userId).like('invoice_number', 'TLY-%');
    if (error) return { error: `invoices read failed: ${error.message}`, status: 500 };
    invoices = data || [];
  }
  const byParty = new Map();
  for (const inv of invoices) {
    const k = String(inv.customer_name || '').trim().toLowerCase();
    if (!byParty.has(k)) byParty.set(k, []);
    byParty.get(k).push(inv);
  }

  // Oldest first, so part payments accumulate in the order they happened.
  for (const v of [...withBills].sort((a, b) => a.date.localeCompare(b.date))) {
    for (const bill of v.bills) {
      if (bill.type === 'on_account' || bill.type === 'advance') { unapplied.on_account++; continue; }
      if (bill.type !== 'against') continue;
      const re = billPattern(bill.name);
      const candidates = (byParty.get(v.party.toLowerCase()) || [])
        .filter((inv) => re && re.test(inv.invoice_number) && String(inv.invoice_date || '').slice(0, 10) <= v.date);
      const marker = `[${v.ref}]`;
      if (candidates.some((inv) => String(inv.payment_notes || '').includes(marker))) continue; // applied on an earlier sync
      const open = candidates.filter((inv) => !/^paid$/i.test(String(inv.payment_status || '')));
      if (open.length !== 1) { unapplied.bill_not_found++; continue; }
      const inv = open[0];
      const total = Number(inv.invoice_amount) || 0;
      const paid = Math.min(total, Math.round(((Number(inv.payment_amount) || 0) + bill.amount) * 100) / 100);
      const full = paid >= total;
      const label = v.kind === 'credit_note' ? 'Credit Note' : 'Receipt';
      const notes = `${inv.payment_notes ? `${inv.payment_notes} ` : ''}${marker} Tally ${label} ${v.voucherNo} ₹${bill.amount}`.slice(0, 2000);
      const patch = { payment_amount: paid, payment_notes: notes, payment_status: full ? 'Paid' : (inv.payment_status || 'Pending') };
      if (full) patch.payment_date = v.date;
      const { error } = await supabase.from('invoices').update(patch).eq('id', inv.id).eq('user_id', userId);
      if (error) return { error: `invoice settlement failed: ${error.message}`, status: 500 };
      Object.assign(inv, patch);
      if (full) counts.bills_settled++; else counts.bills_part_paid++;
    }
  }
  return null;
}

module.exports = { importTallyVouchers, normalizeVouchers, tallyRef };
