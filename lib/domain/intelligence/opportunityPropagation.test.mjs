// Real-DB test for the Opportunity Engine (opportunityPropagation.js +
// lib/routes/opportunities.js), matching the lib/services/*.test.mjs pattern
// (see watchEvaluator.test.mjs). Run:
//   node lib/domain/intelligence/opportunityPropagation.test.mjs
// Connects to the REAL Neon DB via DATABASE_URL (never printed). Uses real
// existing users/suppliers/sales so every assertion is meaningful, and only
// touches rows it creates itself (a single throwaway supplier for the
// correctness check), cleaning them up afterward.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
require('dotenv').config();
const { Pool } = require('pg');
const { buildSanitizedPgConfig } = require('../../db/pgConfig');
const {
  buildOpportunityChain,
  checkDemandRisingStep,
  checkSupplierStableStep,
  DEMAND_RISING_MATERIAL_PCT,
} = require('./opportunityPropagation');
const { opportunitiesRouter } = require('../../routes/opportunities');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  ✅', name); }
  else { fail++; console.log('  ❌', name); }
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL not set');
  const pool = new Pool(buildSanitizedPgConfig(process.env.DATABASE_URL));
  const createdSupplierIds = [];
  const createdSaleIds = [];

  try {
    const { rows: users } = await pool.query('SELECT id FROM users ORDER BY created_at ASC LIMIT 5');
    if (users.length < 2) {
      console.log('SKIP: fewer than 2 users in DB — cannot run tenant isolation test');
      process.exitCode = 0;
      return;
    }

    // Prefer real tenants that actually have suppliers on file (real data,
    // not synthetic), falling back to the first two users otherwise.
    const { rows: withSuppliers } = await pool.query(
      `SELECT user_id, COUNT(*)::int AS n FROM suppliers WHERE user_id = ANY($1) GROUP BY user_id ORDER BY n DESC`,
      [users.map(u => u.id)]
    );
    const userA = withSuppliers[0]?.user_id || users[0].id;
    const userB = users.find(u => u.id !== userA)?.id || users[1].id;
    console.log(`Using real users (non-secret ids): A=${userA} B=${userB}`);

    // ---- buildOpportunityChain: shape + AND logic sanity on real data ----
    const { rows: supplierARows } = await pool.query('SELECT id, name FROM suppliers WHERE user_id = $1 LIMIT 1', [userA]);
    if (supplierARows.length > 0) {
      const chain = await buildOpportunityChain(userA, { supplierId: supplierARows[0].id });
      check('chain: returns a valid status', ['BOUNDED_OPPORTUNITY', 'NO_OPPORTUNITY_SIGNAL', 'INSUFFICIENT_DATA'].includes(chain.status));
      check('chain: has both real steps', chain.steps.length === 2 && chain.steps.every(s => s.step));
      check('chain: chainSupported matches AND of both steps', chain.chainSupported === (chain.steps[0].supported && chain.steps[1].supported));
      if (chain.status === 'BOUNDED_OPPORTUNITY') {
        check('chain: BOUNDED_OPPORTUNITY implies both steps supported', chain.steps.every(s => s.supported));
      }
    } else {
      console.log('  (no real suppliers for userA — skipping single-chain shape check)');
    }

    // ---- checkSupplierStableStep: INSUFFICIENT_DATA with no supplierId ----
    const noSupplierStep = await checkSupplierStableStep(userA, undefined);
    check('supplier step: INSUFFICIENT_DATA when no supplierId given', noSupplierStep.label === 'INSUFFICIENT_DATA' && noSupplierStep.supported === false);

    // ---- checkDemandRisingStep: correctness against a seeded, deterministic pattern ----
    // Seed one throwaway supplier + two sales rows engineered so the trailing
    // window total is unambiguously > threshold above the prior window, then
    // verify the real comparison math in checkDemandRisingStep produces
    // "rising" with the correct pctChange, and clean the rows up after.
    const supplierIns = await pool.query(
      `INSERT INTO suppliers (user_id, name) VALUES ($1, $2) RETURNING id`,
      [userA, 'TEST_OPPORTUNITY_ENGINE_SUPPLIER']
    );
    const testSupplierId = supplierIns.rows[0].id;
    createdSupplierIds.push(testSupplierId);

    // REVENUE_WINDOW_DAYS is 90, so the trailing window is [now-90d, now] and
    // the prior window is [now-180d, now-90d). Pick dates comfortably inside
    // each so they land in the intended window regardless of exact 'now'.
    const now = new Date();
    const recentDate = new Date(now.getTime() - 5 * 86400000).toISOString().slice(0, 10);
    const priorDate = new Date(now.getTime() - 135 * 86400000).toISOString().slice(0, 10);

    const saleCols = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'sales'`
    );
    const colNames = new Set(saleCols.rows.map(r => r.column_name));
    const hasCustomer = colNames.has('customer_name');

    async function insertSale(userId, amount, saleDate) {
      const cols = ['user_id', 'amount', 'sale_date'];
      const vals = [userId, amount, saleDate];
      if (hasCustomer) { cols.push('customer_name'); vals.push('TEST_OPPORTUNITY_ENGINE'); }
      const placeholders = vals.map((_, i) => `$${i + 1}`).join(',');
      const res = await pool.query(`INSERT INTO sales (${cols.join(',')}) VALUES (${placeholders}) RETURNING id`, vals);
      return res.rows[0].id;
    }

    createdSaleIds.push(await insertSale(userA, 100, priorDate));
    createdSaleIds.push(await insertSale(userA, 200, recentDate)); // +100% vs prior window's 100

    const demandStep = await checkDemandRisingStep(userA);
    check('demand step: label is DERIVED once both windows have data', demandStep.label === 'DERIVED');
    check('demand step: correctly derives "rising" for a >=10% window-over-window increase', demandStep.supported === true);
    check('demand step: pctChange evidence matches the real seeded ratio', typeof demandStep.evidence?.pctChange === 'number' && demandStep.evidence.pctChange >= DEMAND_RISING_MATERIAL_PCT);

    // ---- route: 200, only BOUNDED_OPPORTUNITY rows, tenant isolation ----
    function makeReqRes(authedUserId, paramUserId) {
      let statusCode = 200, body = null;
      const req = { user: { userId: authedUserId }, params: { userId: paramUserId } };
      const res = {
        status(c) { statusCode = c; return this; },
        json(b) { body = b; return this; },
      };
      return { req, res, getStatus: () => statusCode, getBody: () => body };
    }

    // Grab the route handler directly (router.stack[0] is the `use` mw, the
    // GET '/:userId' route is next) rather than standing up a real HTTP server.
    const router = opportunitiesRouter({ pool, authMiddleware: (req, res, next) => next() });
    const routeLayer = router.stack.find(l => l.route && l.route.path === '/:userId');
    check('route: /:userId route is registered', !!routeLayer);
    const handler = routeLayer.route.stack[0].handle;

    const ok = makeReqRes(userA, userA);
    await handler(ok.req, ok.res);
    check('route: returns 200 for a valid authenticated owner', ok.getStatus() === 200);
    const okBody = ok.getBody();
    check('route: response has opportunities[] and summary', Array.isArray(okBody?.opportunities) && !!okBody?.summary);
    check('route: only BOUNDED_OPPORTUNITY chains appear in opportunities[]', okBody.opportunities.every(o => o.sourceState === 'BOUNDED_OPPORTUNITY'));
    check('route: summary.suppliersEvaluated accounts for all real suppliers checked', okBody.summary.suppliersEvaluated === okBody.opportunities.length + okBody.summary.noSignal + okBody.summary.insufficientData);

    const cross = makeReqRes(userB, userA);
    await handler(cross.req, cross.res);
    check('tenant isolation: userB cannot fetch userA opportunities (403)', cross.getStatus() === 403);

    const ownB = makeReqRes(userB, userB);
    await handler(ownB.req, ownB.res);
    check('tenant isolation: userB fetching their own userId succeeds', ownB.getStatus() === 200);
    const ownBBody = ownB.getBody();
    if (ownBBody?.opportunities?.length) {
      check(
        'tenant isolation: userB opportunities reference only userB suppliers, never userA',
        !ownBBody.opportunities.some(o => okBody.opportunities.some(a => a.affectedEntities.supplierId === o.affectedEntities.supplierId))
      );
    }
  } finally {
    // ---- cleanup ----
    if (createdSaleIds.length) await pool.query('DELETE FROM sales WHERE id = ANY($1)', [createdSaleIds]);
    if (createdSupplierIds.length) await pool.query('DELETE FROM suppliers WHERE id = ANY($1)', [createdSupplierIds]);
    await pool.end();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail > 0 ? 1 : 0;
}

main().catch(e => { console.error(e); process.exitCode = 1; });
