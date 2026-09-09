// FILE: lib/brain/brainSummary.js
// Starlane Brain — read-only business intelligence summary.
//
// Aggregates the owner's existing data (invoices, transactions, products,
// stock_movements) into a single "brain" view: sales direction, gross
// profit, cash flow, receivables/payables, smart set-off (owe <-> owed),
// product movement (fast / slow / dead / low-stock), and a ranked
// "do today" action list.
//
// This module is PURE COMPUTE. It never writes, never sends a message, and
// never calls an LLM. `computeBrainSummary(data)` takes plain rows and
// returns a plain object, so it is fully unit-testable offline.
// `loadBrainSummary(supabase, userId)` is the thin DB adapter.
//
// NOTE (v1 honesty): gross profit is approximated as
// (sales revenue − purchase cost) for the period, and cash is net flow
// (money in − money out). Exact accrual figures land in a later phase when
// we pull Tally ledger balances directly.

'use strict';

// ── small helpers ───────────────────────────────────────────────
function toNum(v) {
  if (v == null) return 0;
  const n = parseFloat(String(v).replace(/[₹,\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function monthKey(dateLike) {
  if (!dateLike) return null;
  const d = dateLike instanceof Date ? dateLike : new Date(String(dateLike));
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(key) {
  const [y, m] = key.split('-');
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${names[parseInt(m, 10) - 1]} ${String(y).slice(2)}`;
}

function pctChange(cur, prev) {
  if (!prev) return cur ? 100 : 0;
  return ((cur - prev) / Math.abs(prev)) * 100;
}

function normName(s) {
  return String(s || '').trim().toLowerCase();
}

// last N month keys ending at `asOf` (inclusive), oldest first
function recentMonthKeys(asOf, n) {
  const keys = [];
  const d = new Date(asOf.getFullYear(), asOf.getMonth(), 1);
  for (let i = n - 1; i >= 0; i--) {
    const m = new Date(d.getFullYear(), d.getMonth() - i, 1);
    keys.push(`${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`);
  }
  return keys;
}

// ── main compute ────────────────────────────────────────────────
function computeBrainSummary(data = {}) {
  const invoices = data.invoices || [];
  const transactions = data.transactions || [];
  const purchases = data.purchases || [];
  const products = data.products || [];
  const movements = data.stockMovements || [];
  const asOf = data.asOf ? new Date(data.asOf) : new Date();

  const monthsWindow = recentMonthKeys(asOf, 6);
  const thisMonth = monthsWindow[monthsWindow.length - 1];
  const prevMonth = monthsWindow[monthsWindow.length - 2];

  // ── sales trend (from invoices) ──────────────────────────────
  const salesByMonth = {};
  // Fair-period comparison for the "vs last month" figure (Q4 requirement):
  // when the current month is still in progress, comparing its to-date
  // total against a FULL previous month overstates any decline (and
  // understates any rise) — day 8 of September will always look tiny next
  // to all of August. `salesByMonthSameDayRange` accumulates each month
  // only through the same day-of-month as `asOf`, so a partial month is
  // always compared against an equally partial one. Once the month being
  // compared is complete, the two totals are identical.
  const dayOfMonth = asOf.getDate();
  const salesByMonthSameDayRange = {};
  for (const inv of invoices) {
    const dateStr = inv.invoice_date || inv.created_at;
    const k = monthKey(dateStr);
    if (!k) continue;
    const amt = toNum(inv.invoice_amount);
    salesByMonth[k] = (salesByMonth[k] || 0) + amt;
    const d = new Date(String(dateStr));
    if (!Number.isNaN(d.getTime()) && d.getDate() <= dayOfMonth) {
      salesByMonthSameDayRange[k] = (salesByMonthSameDayRange[k] || 0) + amt;
    }
  }
  const salesTrend = monthsWindow.map((k) => ({ key: k, m: monthLabel(k), s: Math.round(salesByMonth[k] || 0) }));
  const salesThis = salesByMonth[thisMonth] || 0;
  // Fair comparison figure — same number of days into each month.
  const salesPrev = salesByMonthSameDayRange[prevMonth] || 0;
  const salesDelta = pctChange(salesThis, salesPrev);

  // ── purchases ──────────────────────────────────────────────────
  // Cost of goods has TWO possible sources in this codebase, because they
  // are written by two independent code paths that never cross-write:
  //   1. the dedicated `purchases` table (POST /api/purchases — the
  //      Purchases page's real flow), keyed by `purchase_date`/`amount`.
  //   2. `transactions` rows whose `category` matches /purchase/ (an older,
  //      manually-logged ledger path — some tenants only have this).
  // The original version of this function read ONLY source (2). For any
  // tenant using the real Purchases page (source 1), that meant
  // `purchasesThis` was always 0 regardless of actual spend, silently
  // inflating gross profit and margin to ~100% — a confirmed bug, not a
  // "no purchases recorded" state. Both sources are summed here (they are
  // disjoint tables, so this cannot double-count the same purchase).
  const isPurchase = (t) => /purchase/i.test(t.category || '');
  const isPayment = (t) => /payment|paid/i.test(t.category || '');
  const isReceipt = (t) => /receipt|collection|received/i.test(t.category || '');
  const inMonth = (t, k) => monthKey(t.transaction_date || t.created_at) === k;
  const inMonthPurchase = (p, k) => monthKey(p.purchase_date || p.created_at) === k;

  const purchasesThisFromTransactions = transactions.filter((t) => isPurchase(t) && inMonth(t, thisMonth)).reduce((a, t) => a + toNum(t.amount), 0);
  const purchasesThisFromTable = purchases.filter((p) => inMonthPurchase(p, thisMonth)).reduce((a, p) => a + toNum(p.amount ?? p.total_amount), 0);
  const purchasesThis = purchasesThisFromTransactions + purchasesThisFromTable;

  // ── gross profit (approx: sales − purchases for the month) ────
  const grossProfit = salesThis - purchasesThis;
  const margin = salesThis ? (grossProfit / salesThis) * 100 : 0;

  // ── cash flow (net money in − money out, this month) ─────────
  const cashIn = transactions.filter((t) => t.type === 'in' && inMonth(t, thisMonth)).reduce((a, t) => a + toNum(t.amount), 0);
  const cashOut = transactions.filter((t) => t.type === 'out' && inMonth(t, thisMonth)).reduce((a, t) => a + toNum(t.amount), 0);
  const netCashFlow = cashIn - cashOut;

  // ── receivables per customer (unpaid invoices) ───────────────
  const recvByParty = {};
  for (const inv of invoices) {
    const paid = /paid|clear/i.test(inv.payment_status || '');
    if (paid) continue;
    const due = toNum(inv.invoice_amount) - toNum(inv.payment_amount);
    if (due <= 0) continue;
    const key = normName(inv.customer_name);
    if (!key) continue;
    if (!recvByParty[key]) recvByParty[key] = { name: String(inv.customer_name).trim(), amount: 0, maxOverdue: 0 };
    recvByParty[key].amount += due;
    recvByParty[key].maxOverdue = Math.max(recvByParty[key].maxOverdue, parseInt(inv.days_overdue, 10) || 0);
  }

  // ── payables per supplier (purchases − payments, by party) ───
  // Same two-source fix as purchasesThis above: a supplier's unpaid balance
  // must include real `purchases` rows (amount − paid_amount), not only the
  // older transactions-ledger path, or a supplier owed money through the
  // real Purchases page would never show up here.
  const payByParty = {};
  for (const t of transactions) {
    const key = normName(t.party_name);
    if (!key) continue;
    if (isPurchase(t)) {
      if (!payByParty[key]) payByParty[key] = { name: String(t.party_name).trim(), amount: 0, nearestDueDate: null };
      payByParty[key].amount += toNum(t.amount);
    } else if (isPayment(t)) {
      if (!payByParty[key]) payByParty[key] = { name: String(t.party_name).trim(), amount: 0, nearestDueDate: null };
      payByParty[key].amount -= toNum(t.amount);
    }
  }
  for (const p of purchases) {
    const key = normName(p.supplier_name);
    if (!key) continue;
    const due = toNum(p.amount ?? p.total_amount) - toNum(p.paid_amount);
    if (!payByParty[key]) payByParty[key] = { name: String(p.supplier_name).trim(), amount: 0, nearestDueDate: null };
    payByParty[key].amount += due;
    if (due > 0.5 && p.due_date) {
      if (!payByParty[key].nearestDueDate || p.due_date < payByParty[key].nearestDueDate) {
        payByParty[key].nearestDueDate = p.due_date;
      }
    }
  }
  for (const k of Object.keys(payByParty)) if (payByParty[k].amount <= 0.5) delete payByParty[k];

  const totalRecv = Object.values(recvByParty).reduce((a, p) => a + p.amount, 0);
  const totalPay = Object.values(payByParty).reduce((a, p) => a + p.amount, 0);

  // ── smart set-off (party present in both) ────────────────────
  const setoff = [];
  for (const key of Object.keys(recvByParty)) {
    if (!payByParty[key]) continue;
    const recv = recvByParty[key].amount;
    const pay = payByParty[key].amount;
    setoff.push({
      name: recvByParty[key].name,
      recv: Math.round(recv),
      pay: Math.round(pay),
      net: Math.round(recv - pay),
      settle: Math.round(Math.min(recv, pay)),
    });
  }
  setoff.sort((a, b) => b.settle - a.settle);
  const setoffTotal = setoff.reduce((a, s) => a + s.settle, 0);

  // ── product movement (from stock_movements, outward = sold) ──
  const isOutward = (mv) => /sale|out|sold|issue/i.test(mv.movement_type || '');
  const soldThisByProduct = {};
  const soldLastByProduct = {};
  for (const mv of movements) {
    if (!isOutward(mv)) continue;
    const k = monthKey(mv.moved_at);
    const qty = toNum(mv.quantity);
    if (k === thisMonth) soldThisByProduct[mv.product_id] = (soldThisByProduct[mv.product_id] || 0) + qty;
    else if (k === prevMonth) soldLastByProduct[mv.product_id] = (soldLastByProduct[mv.product_id] || 0) + qty;
  }

  const productRows = products.map((p) => {
    const soldThis = soldThisByProduct[p.id] || 0;
    const soldLast = soldLastByProduct[p.id] || 0;
    const stock = toNum(p.current_stock);
    const capitalTied = stock * toNum(p.unit_price);
    const reorder = toNum(p.low_stock_alert);
    const drop = pctChange(soldThis, soldLast);
    let signal, why;
    if (soldThis === 0 && stock > 0) { signal = 'dead'; why = 'capital stuck, 0 sold'; }
    else if (stock < reorder) { signal = 'low'; why = 'below reorder level'; }
    else if (drop < -40 && soldLast > 0) { signal = 'slow'; why = `sales ${Math.round(drop)}%`; }
    else { signal = 'fast'; why = 'healthy'; }
    return { name: p.name, sku: p.sku || null, soldThis, soldLast, stock, capitalTied: Math.round(capitalTied), reorder, signal, why };
  });
  const sigOrder = { low: 0, dead: 1, slow: 2, fast: 3 };
  productRows.sort((a, b) => sigOrder[a.signal] - sigOrder[b.signal] || b.capitalTied - a.capitalTied);

  // ── ranked "do today" actions ────────────────────────────────
  const actions = [];
  if (salesDelta < -5 && salesPrev > 0) {
    actions.push({ sev: 'hi', title: `Sales down ${Math.abs(salesDelta).toFixed(1)}% this month`, sub: 'Revenue fell vs last month — review why', value: Math.round(salesThis - salesPrev) });
  }
  const topRecv = Object.values(recvByParty).sort((a, b) => b.amount - a.amount)[0];
  if (topRecv) actions.push({ sev: 'hi', title: `Collect from ${topRecv.name}`, sub: 'Largest amount owed to you', value: Math.round(topRecv.amount) });
  for (const s of setoff) actions.push({ sev: 'lo', title: `Set off with ${s.name}`, sub: `${s.settle} cancels — no cash needed`, value: s.settle });
  for (const p of productRows.filter((r) => r.signal === 'low')) actions.push({ sev: 'hi', title: `Reorder ${p.name}`, sub: `${p.stock} left, below reorder`, value: null });
  for (const p of productRows.filter((r) => r.signal === 'slow')) actions.push({ sev: 'mid', title: `Review ${p.name}`, sub: p.why + `, capital tied`, value: p.capitalTied });
  for (const p of productRows.filter((r) => r.signal === 'dead')) actions.push({ sev: 'mid', title: `Clear dead stock — ${p.name}`, sub: '0 sold, capital stuck', value: p.capitalTied });
  const sevOrder = { hi: 0, mid: 1, lo: 2 };
  actions.sort((a, b) => sevOrder[a.sev] - sevOrder[b.sev]);

  return {
    asOf: asOf.toISOString(),
    generatedAt: new Date().toISOString(),
    kpis: {
      salesThis: Math.round(salesThis),
      salesPrev: Math.round(salesPrev),
      salesDelta: Number(salesDelta.toFixed(1)),
      grossProfit: Math.round(grossProfit),
      margin: Number(margin.toFixed(1)),
      netCashFlow: Math.round(netCashFlow),
      cashIn: Math.round(cashIn),
      cashOut: Math.round(cashOut),
      receivable: Math.round(totalRecv),
      payable: Math.round(totalPay),
      // True only when there is zero purchase/cost data anywhere in the
      // lookback window (not just this month) — lets the UI tell "no costs
      // recorded yet" apart from "you're at 100% margin this month".
      hasCostData: purchases.length > 0 || transactions.some((t) => isPurchase(t)),
    },
    position: {
      receivable: Math.round(totalRecv),
      payable: Math.round(totalPay),
      net: Math.round(totalRecv - totalPay),
      setoffTotal: Math.round(setoffTotal),
      customerCount: Object.keys(recvByParty).length,
      supplierCount: Object.keys(payByParty).length,
    },
    salesTrend,
    products: productRows,
    setoff,
    // Per-customer / per-supplier breakdowns — additive fields, plain data
    // already computed above (recvByParty/payByParty), just also returned
    // as lists so the UI can show "who owes me, and how late" rather than
    // only the aggregate totals in `position`.
    receivables: Object.values(recvByParty)
      .map((r) => ({ name: r.name, amount: Math.round(r.amount), daysLate: r.maxOverdue }))
      .sort((a, b) => b.amount - a.amount),
    payables: Object.values(payByParty)
      .map((p) => ({ name: p.name, amount: Math.round(p.amount), dueDate: p.nearestDueDate || null }))
      .sort((a, b) => b.amount - a.amount),
    actions: actions.slice(0, 12),
    approximations: {
      grossProfit: 'sales minus recorded purchases for the month — not accounting profit: purchases here are total spend booked this month (not cost of goods actually sold), and operating expenses like rent or salaries are not included',
      cash: 'net money in − money out for the month',
    },
  };
}

// Maps a `bank_transactions` row (the table GET/POST /api/transactions
// actually reads and writes — see server.js mapBankTransactionToLedger) into
// the plain {type, category, amount, party_name, transaction_date} shape
// computeBrainSummary() expects. `bank_transactions` has no separate
// party_name/category columns — party name is the first ' · '-delimited
// segment of `description`, same convention server.js's own ledger mapper
// uses, so this stays consistent with what the Ledger page shows the owner.
function mapBankTransactionForBrain(row) {
  const type = row.type === 'credit' ? 'in' : 'out';
  const parts = String(row.description || '').split(' · ').map((p) => p.trim()).filter(Boolean);
  const reference = parts.find((p) => /^(Receipt|Payment)\s+#/i.test(p)) || '';
  const partyName = parts[0] && parts[0] !== reference ? parts[0] : '';
  return {
    type,
    category: type === 'in' ? 'Customer Payment' : 'Supplier Payment',
    amount: Number(row.amount || 0),
    party_name: partyName,
    transaction_date: row.txn_date || row.created_at,
    created_at: row.created_at,
  };
}

// ── DB adapter (reads only) ─────────────────────────────────────
async function loadBrainSummary(supabase, userId, asOf) {
  const since = new Date();
  since.setMonth(since.getMonth() - 7);
  const sinceIso = since.toISOString();
  const sinceDate = sinceIso.split('T')[0];

  const [invoicesRes, txnRes, purchasesRes, productsRes, movementsRes] = await Promise.all([
    supabase.from('invoices').select('customer_name,invoice_amount,invoice_date,payment_status,payment_amount,days_overdue,created_at').eq('user_id', userId),
    // `bank_transactions` is the table the app's own Ledger/Transactions
    // page actually reads and writes (GET/POST /api/transactions/*, see
    // server.js). The plain `transactions` table this used to read from is
    // not written by any current code path, so cash-in/cash-out was always
    // computed as 0 regardless of real activity — a confirmed bug, not a
    // "no transactions" state. Fixed by reading the real table and mapping
    // it into the same shape via mapBankTransactionForBrain() above.
    supabase.from('bank_transactions').select('type,amount,description,txn_date,created_at').eq('user_id', userId).gte('txn_date', sinceDate),
    // Real purchases table — see the comment above `purchasesThis` in
    // computeBrainSummary for why this is read alongside transactions.
    supabase.from('purchases').select('supplier_name,amount,total_amount,paid_amount,purchase_date,due_date,created_at').eq('user_id', userId).gte('purchase_date', sinceDate),
    supabase.from('products').select('id,name,sku,current_stock,unit_price,low_stock_alert,category').eq('user_id', userId),
    supabase.from('stock_movements').select('product_id,movement_type,quantity,unit_cost,moved_at').eq('user_id', userId).gte('moved_at', sinceIso),
  ]);

  return computeBrainSummary({
    invoices: invoicesRes.data || [],
    transactions: (txnRes.data || []).map(mapBankTransactionForBrain),
    purchases: purchasesRes.data || [],
    products: productsRes.data || [],
    stockMovements: movementsRes.data || [],
    asOf: asOf || new Date(),
  });
}

module.exports = { computeBrainSummary, loadBrainSummary };
