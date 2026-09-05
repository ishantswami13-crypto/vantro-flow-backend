// Offline proof for STARLANE Phase 10 revenueIntelligence.service.js pure functions.
// No DB, no network — exercises deterministic aggregation/decision-table logic only.
// Run: node lib/services/orchestrator/revenueIntelligence.test.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  aggregateSales,
  computeCustomerValue,
  computeMomentum,
  computeConcentration,
  computeDormancy,
  computeHealthLabel,
  computeAttentionScore,
  splitByWindow,
  MOMENTUM_MIN_ORDER_COUNT,
} = require('./revenueIntelligence.service.js');

let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✅' : '❌'} ${label}: ${JSON.stringify(got)}${ok ? '' : ' (expected ' + JSON.stringify(want) + ')'}`);
  ok ? pass++ : fail++;
}
function checkTrue(label, cond) {
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  cond ? pass++ : fail++;
}

const isoDaysAgo = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
const sale = (amount, daysAgo, customer_id = 'c1') => ({ id: `s-${Math.random()}`, amount, sale_date: isoDaysAgo(daysAgo), customer_id, customer_name: 'Test Customer' });

// ── aggregateSales ────────────────────────────────────────────────────────────
check('aggregateSales empty', aggregateSales([]), { revenue: 0, orderCount: 0, aov: 0 });
check('aggregateSales sums amounts', aggregateSales([sale(100, 1), sale(200, 2)]), { revenue: 300, orderCount: 2, aov: 150 });

// ── computeCustomerValue ──────────────────────────────────────────────────────
{
  const v = computeCustomerValue([sale(1000, 1), sale(2000, 2)], 90);
  check('customerValue revenue', v.revenue, 3000);
  check('customerValue orderCount', v.orderCount, 2);
  checkTrue('customerValue evidence mentions revenue and window', v.evidence.includes('₹3,000') && v.evidence.includes('90 days'));
}
{
  const v = computeCustomerValue([], 90);
  checkTrue('customerValue zero-order evidence is honest, not fabricated', v.evidence.includes('No sales recorded'));
}

// ── computeMomentum ────────────────────────────────────────────────────────────
{
  // insufficient prior history (< MOMENTUM_MIN_ORDER_COUNT orders in prior window)
  const m = computeMomentum([sale(500, 1)], [sale(500, 91)], 90);
  check('momentum insufficient history status', m.status, 'INSUFFICIENT_HISTORY');
  check('momentum insufficient history changePct is null (never fabricated)', m.changePct, null);
}
{
  // sufficient history, growth
  const cur = [sale(1000, 1), sale(1000, 2), sale(1000, 3)];
  const prior = [sale(500, 91), sale(500, 92), sale(500, 93)];
  const m = computeMomentum(cur, prior, 90);
  check('momentum growth status', m.status, 'GROWING');
  checkTrue('momentum growth changePct positive', m.changePct > 0);
}
{
  // sufficient history, decline
  const cur = [sale(300, 1), sale(300, 2), sale(300, 3)];
  const prior = [sale(1000, 91), sale(1000, 92), sale(1000, 93)];
  const m = computeMomentum(cur, prior, 90);
  check('momentum decline status', m.status, 'DECLINING');
  checkTrue('momentum decline changePct negative', m.changePct < 0);
}

// ── computeConcentration ──────────────────────────────────────────────────────
{
  const c = computeConcentration(30000, 100000, 90);
  check('concentration sharePct', c.sharePct, 30);
  check('concentration isConcentrationRisk (>25%)', c.isConcentrationRisk, true);
}
{
  const c = computeConcentration(10000, 100000, 90);
  check('concentration below threshold not flagged', c.isConcentrationRisk, false);
}
{
  // exact boundary: 25% exactly should NOT trip ">25%" (exclusive per plan §8)
  const c = computeConcentration(25000, 100000, 90);
  check('concentration exactly-25% boundary is exclusive (not flagged)', c.isConcentrationRisk, false);
}
{
  // division-by-zero edge case must not throw
  const c = computeConcentration(0, 0, 90);
  check('concentration zero-tenant-revenue does not throw, share is 0', c.share, 0);
  check('concentration zero-tenant-revenue not flagged', c.isConcentrationRisk, false);
}

// ── computeDormancy ────────────────────────────────────────────────────────────
{
  const d = computeDormancy([]);
  check('dormancy no history', d.isDormant, false);
}
{
  // >=3 orders, gaps ~10 days, but last sale only 5 days ago -> not dormant
  const rows = [sale(100, 30), sale(100, 20), sale(100, 10), sale(100, 5)];
  const d = computeDormancy(rows);
  check('dormancy active customer not flagged', d.isDormant, false);
}
{
  // >=3 orders, gaps ~10 days, last sale 90 days ago (> 2x avg gap and > flat 45) -> dormant
  const rows = [sale(100, 130), sale(100, 120), sale(100, 110), sale(100, 90)];
  const d = computeDormancy(rows);
  check('dormancy customer with long gap flagged', d.isDormant, true);
  checkTrue('dormancy evidence names the gap and cadence', d.evidence.includes('90 days ago') && d.evidence.includes('normally orders'));
}
{
  // <3 orders, flat 60-day threshold
  const rows = [sale(100, 70), sale(100, 65)];
  const d = computeDormancy(rows);
  check('dormancy thin-history uses flat threshold', d.isDormant, true);
  checkTrue('dormancy thin-history evidence discloses flat threshold', d.evidence.includes('flat 60-day threshold'));
}

// ── computeHealthLabel — one fixture per decision-table branch (plan §13.5) ──
check('health: dormant wins first', computeHealthLabel({
  dormancy: { isDormant: true, evidence: 'dormant-evidence' },
  momentum: { status: 'GROWING', evidence: 'x' },
  concentration: { isConcentrationRisk: true },
  creditRiskScore: 90, trajectory: 'DETERIORATING', sustainedDeterioration: true,
}).label, 'DORMANT');

check('health: high risk score -> AT_RISK', computeHealthLabel({
  dormancy: { isDormant: false }, momentum: { status: 'FLAT' }, concentration: { isConcentrationRisk: false },
  creditRiskScore: 75, trajectory: 'STABLE', sustainedDeterioration: false,
}).label, 'AT_RISK');

check('health: sustained deterioration -> AT_RISK even with low score', computeHealthLabel({
  dormancy: { isDormant: false }, momentum: { status: 'FLAT' }, concentration: { isConcentrationRisk: false },
  creditRiskScore: 20, trajectory: 'DETERIORATING', sustainedDeterioration: true,
}).label, 'AT_RISK');

check('health: negative momentum -> WATCH', computeHealthLabel({
  dormancy: { isDormant: false }, momentum: { status: 'DECLINING', evidence: 'declining-evidence' }, concentration: { isConcentrationRisk: false },
  creditRiskScore: 20, trajectory: 'STABLE', sustainedDeterioration: false,
}).label, 'WATCH');

check('health: concentrated + medium risk -> WATCH', computeHealthLabel({
  dormancy: { isDormant: false }, momentum: { status: 'FLAT' }, concentration: { isConcentrationRisk: true, evidence: 'conc-evidence' },
  creditRiskScore: 45, trajectory: 'STABLE', sustainedDeterioration: false,
}).label, 'WATCH');

check('health: positive momentum + low risk -> GROWING', computeHealthLabel({
  dormancy: { isDormant: false }, momentum: { status: 'GROWING', evidence: 'growing-evidence' }, concentration: { isConcentrationRisk: false },
  creditRiskScore: 10, trajectory: 'STABLE', sustainedDeterioration: false,
}).label, 'GROWING');

check('health: all-clear / insufficient-history default -> HEALTHY', computeHealthLabel({
  dormancy: { isDormant: false }, momentum: { status: 'INSUFFICIENT_HISTORY', evidence: 'insuff' }, concentration: { isConcentrationRisk: false },
  creditRiskScore: 0, trajectory: 'UNKNOWN', sustainedDeterioration: false,
}).label, 'HEALTHY');

{
  const h = computeHealthLabel({ dormancy: { isDormant: true, evidence: 'ev' }, momentum: {}, concentration: {}, creditRiskScore: 0, trajectory: 'UNKNOWN' });
  checkTrue('health label always carries non-empty evidence array (never bare enum)', Array.isArray(h.evidence) && h.evidence.length > 0);
}

// ── computeAttentionScore — deterministic, inspectable, bounded 0-100 ────────
{
  const high = computeAttentionScore({ concentrationSharePct: 40, creditRiskScore: 90, trajectory: 'DETERIORATING', dormancyIsDormant: true });
  const low = computeAttentionScore({ concentrationSharePct: 2, creditRiskScore: 5, trajectory: 'IMPROVING', dormancyIsDormant: false });
  checkTrue('attentionScore ranks high-risk-high-value above low-risk-low-value', high > low);
  checkTrue('attentionScore bounded 0-100 (high)', high >= 0 && high <= 100);
  checkTrue('attentionScore bounded 0-100 (low, can go negative internally but clamps)', low >= 0 && low <= 100);
}

// ── splitByWindow — no double counting, no overlap between current/prior ────
{
  const rows = [sale(100, 1), sale(100, 45), sale(100, 100), sale(100, 200)];
  const { current, prior } = splitByWindow(rows, 90);
  check('splitByWindow current has recent rows only', current.length, 2);
  check('splitByWindow prior has adjacent-window row only', prior.length, 1);
  checkTrue('splitByWindow current and prior share no rows (no double count)',
    !current.some(c => prior.includes(c)));
}

// ── DOUBLE-COUNT PREVENTION ───────────────────────────────────────────────────
// Plan §6: `sales` is the ONLY canonical revenue source. Every `sales` row is
// mirrored into `invoices` with source_type='sales' by syncReceivableFromSale()
// elsewhere in the codebase — summing sales.amount + invoices.invoice_amount for
// the same customer would double the true revenue figure. Prove (a) this file
// never queries the `invoices` table at all, and (b) the arithmetic itself only
// ever counts a sale's amount once.
{
  const src = require('fs').readFileSync(require.resolve('./revenueIntelligence.service.js'), 'utf8');
  const queriesInvoicesTable = /supabase\s*\.\s*from\(\s*['"]invoices['"]\s*\)/.test(src);
  checkTrue('double-count prevention: revenueIntelligence.service.js never queries the `invoices` table', !queriesInvoicesTable);
  const salesQueryCount = (src.match(/supabase\s*\.\s*from\(\s*['"]sales['"]\s*\)/g) || []).length;
  checkTrue('double-count prevention: service queries `sales` (the canonical source) at least once', salesQueryCount > 0);

  const saleAmount = 5000;
  const mirroredInvoiceAmount = 5000; // what syncReceivableFromSale() would mirror into invoices
  const v = computeCustomerValue([sale(saleAmount, 1)], 90);
  checkTrue('double-count prevention: revenue equals the sale amount once, not sale+mirrored-invoice',
    v.revenue === saleAmount && v.revenue !== saleAmount + mirroredInvoiceAmount);
}

// ── TENANT ISOLATION ─────────────────────────────────────────────────────────
// Two synthetic owners (tenant A / tenant B) sharing an identical customer_id
// AND customer_name (the worst-case collision) prove fetchCustomerSalesRows()
// never leaks rows across tenants, using a fake Supabase query builder that
// records exactly which .eq()/.ilike() filters were applied per query and only
// returns rows matching ALL of them.
{
  const { fetchCustomerSalesRows } = require('./revenueIntelligence.service.js');
  const FAKE_ROWS = [
    { id: 'row-A', user_id: 'tenantA', customer_id: 'cust-shared', customer_name: 'Shared Co', amount: 1000, sale_date: isoDaysAgo(1) },
    { id: 'row-B', user_id: 'tenantB', customer_id: 'cust-shared', customer_name: 'Shared Co', amount: 9999, sale_date: isoDaysAgo(1) },
  ];

  function makeFakeSupabase() {
    return {
      from(table) {
        const filters = {};
        const ilikes = {};
        const builder = {
          select() { return builder; },
          eq(col, val) { filters[col] = val; return builder; },
          ilike(col, val) { ilikes[col] = String(val).replace(/%/g, ''); return builder; },
          gte() { return builder; },
          lt() { return builder; },
          maybeSingle() { return Promise.resolve({ data: null }); },
          then(resolve) {
            if (table !== 'sales') return resolve({ data: [] });
            const rows = FAKE_ROWS.filter(r => {
              if (filters.user_id && r.user_id !== filters.user_id) return false;
              if (filters.customer_id && r.customer_id !== filters.customer_id) return false;
              if (ilikes.customer_name && r.customer_name !== ilikes.customer_name) return false;
              return true;
            });
            return resolve({ data: rows });
          },
        };
        return builder;
      },
    };
  }

  // NOTE: revenueIntelligence.service.js does `const { supabase } = require(...)` at
  // load time, which binds to the SAME object this module's `supabase` export
  // currently points to — reassigning `realConfig.supabase = ...` afterward would
  // only change the export binding, not the object the service already holds a
  // reference to. So we mutate the shared object's `.from` method in place instead.
  const configPath = require.resolve('../../config/supabaseClient');
  const realConfig = require(configPath);
  const sharedSupabaseObj = realConfig.supabase;
  const originalFrom = sharedSupabaseObj.from;
  sharedSupabaseObj.from = makeFakeSupabase().from;

  await (async () => {
    const rowsForTenantA = await fetchCustomerSalesRows('tenantA', 'cust-shared', 'Shared Co');
    const rowsForTenantB = await fetchCustomerSalesRows('tenantB', 'cust-shared', 'Shared Co');

    checkTrue('tenant isolation: tenant A sees only its own row (amount 1000), never tenant B\'s',
      rowsForTenantA.length === 1 && rowsForTenantA[0].amount === 1000);
    checkTrue('tenant isolation: tenant B sees only its own row (amount 9999), never tenant A\'s',
      rowsForTenantB.length === 1 && rowsForTenantB[0].amount === 9999);
    checkTrue('tenant isolation: no cross-tenant leakage even with an identical customer_id/customer_name collision',
      rowsForTenantA[0].user_id === 'tenantA' && rowsForTenantB[0].user_id === 'tenantB');

    const rowsForUnknownTenant = await fetchCustomerSalesRows('tenantC-does-not-exist', 'cust-shared', 'Shared Co');
    checkTrue('tenant isolation: unknown tenant id returns zero rows, no throw',
      Array.isArray(rowsForUnknownTenant) && rowsForUnknownTenant.length === 0);
  })();

  sharedSupabaseObj.from = originalFrom; // restore real client for any subsequent code
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
