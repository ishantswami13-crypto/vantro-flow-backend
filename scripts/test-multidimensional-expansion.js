// FILE: scripts/test-multidimensional-expansion.js
// STARLANE Multidimensional Intelligence Expansion — test suite.
//
// Real local dev DATABASE_URL. Creates its own fixtures and deletes them in
// a finally block; every test verifies zero residual rows at the end.
// Every assertion is backed by a real DB query or real function output that
// could genuinely fail — no hardcoded/unfalsifiable assertions.

require('dotenv').config();
const { randomUUID } = require('crypto');
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const { detectMultivariateChange } = require('../lib/domain/intelligence/multivariateChange');
const { buildStackedFragilityChain } = require('../lib/domain/intelligence/stackedFragility');
const { decomposeForecastUncertainty } = require('../lib/domain/intelligence/uncertaintyDecomposition');
const { detectBaselineDivergence } = require('../lib/domain/intelligence/baselineDivergence');
const { buildOpportunityChain } = require('../lib/domain/intelligence/opportunityPropagation');
const { mergeOverlappingSignals } = require('../lib/domain/intelligence/intelligenceMerge');
const { IMPACT_MODES } = require('../lib/world/externalSignal');

let pass = 0, fail = 0;
const results = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; results.push(`PASS ${name}`); }
  else { fail++; results.push(`FAIL ${name} ${detail}`); }
}

// Real, previously-proven China supplier + USGS hazard chain (see
// scripts/test-world-intelligence-expansion-part2.js for provenance).
const REAL_CN_TENANT = 'd637701e-9ffc-4d17-b1eb-72e6b25aa868';
const REAL_CN_SUPPLIER = 'c50a7e39-48b5-478b-868c-1a59942a0b16';

const createdUsers = [];
const createdCustomers = [];
const createdSuppliers = [];
const createdPurchases = [];
const createdSales = [];
const createdInvoices = [];
const createdScoreHistory = [];
const createdExposures = [];

async function makeUser(label) {
  const id = randomUUID();
  await pool.query(`INSERT INTO users (id, email, business_name) VALUES ($1,$2,$3)`, [id, `mde-${id}@example.invalid`, label]);
  createdUsers.push(id);
  return id;
}
async function makeCustomer(userId, name) {
  const id = randomUUID();
  await pool.query(`INSERT INTO customers (id, user_id, name, created_at) VALUES ($1,$2,$3, NOW())`, [id, userId, name]);
  createdCustomers.push(id);
  return id;
}
async function makeSupplier(userId, name) {
  const id = randomUUID();
  await pool.query(`INSERT INTO suppliers (id, user_id, name) VALUES ($1,$2,$3)`, [id, userId, name]);
  createdSuppliers.push(id);
  return id;
}
async function makePurchase(userId, supplierId, amount) {
  const res = await pool.query(
    `INSERT INTO purchases (user_id, supplier_id, supplier_name, amount, purchase_date) VALUES ($1,$2,$3,$4, now()) RETURNING id`,
    [userId, supplierId, 'fixture-supplier', amount]
  );
  createdPurchases.push(res.rows[0].id);
  return res.rows[0].id;
}
async function makeSale(userId, customerId, customerName, amount, saleDate) {
  const res = await pool.query(
    `INSERT INTO sales (user_id, customer_id, customer_name, amount, sale_date) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [userId, customerId, customerName, amount, saleDate]
  );
  createdSales.push(res.rows[0].id);
  return res.rows[0].id;
}
async function makeInvoice(userId, customerId, customerName, amount, daysOverdue, paymentStatus = 'Pending') {
  const res = await pool.query(
    `INSERT INTO invoices (user_id, customer_id, customer_name, invoice_amount, days_overdue, payment_status, invoice_date, due_date)
     VALUES ($1,$2,$3,$4,$5,$6, now() - interval '40 days', now() - interval '10 days') RETURNING id`,
    [userId, customerId, customerName, amount, daysOverdue, paymentStatus]
  );
  createdInvoices.push(res.rows[0].id);
  return res.rows[0].id;
}
async function makeScoreHistoryRow(userId, customerId, creditRiskScore, recordedAt) {
  const res = await pool.query(
    `INSERT INTO customer_score_history (user_id, customer_id, credit_risk_score, recorded_at) VALUES ($1,$2,$3,$4) RETURNING id`,
    [userId, customerId, creditRiskScore, recordedAt]
  );
  createdScoreHistory.push(res.rows[0].id);
  return res.rows[0].id;
}
async function makeCnExposure(userId, supplierId, cnWorldEntityId) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO business_exposure (id, user_id, business_entity_type, business_entity_id, exposure_type, world_entity_id, truth_state, provenance_type, source_of_fact, verification_status, valid_from)
     VALUES ($1,$2,'supplier',$3,'LOCATED_IN',$4,'OBSERVED','OWNER_ENTERED','test_fixture','VERIFIED', '2025-01-01T00:00:00.000Z')`,
    [id, userId, supplierId, cnWorldEntityId]
  );
  createdExposures.push(id);
  return id;
}

async function main() {
  const cnEntity = (await pool.query(`SELECT id FROM world_entities WHERE code = 'CN' LIMIT 1`)).rows[0];
  if (!cnEntity) throw new Error('need a real CN world_entities row');

  // ============================================================
  // GROUP 1: multivariateChange.js
  // ============================================================
  const compositeTenant = await makeUser('composite-signal-tenant');
  const compositeCustomer = await makeCustomer(compositeTenant, 'Composite Co');
  const fillerCustomer = await makeCustomer(compositeTenant, 'Filler Co');
  // Concentration: compositeCustomer is 80% of trailing revenue -> material.
  await makeSale(compositeTenant, compositeCustomer, 'Composite Co', 800, new Date());
  await makeSale(compositeTenant, fillerCustomer, 'Filler Co', 200, new Date());
  // Cash buffer: overdue ratio > 30%.
  await makeInvoice(compositeTenant, compositeCustomer, 'Composite Co', 700, 45, 'Pending');
  await makeInvoice(compositeTenant, fillerCustomer, 'Filler Co', 100, null, 'Pending');
  // Payment trajectory: worsening credit_risk_score (2-point).
  await makeScoreHistoryRow(compositeTenant, compositeCustomer, 20, new Date(Date.now() - 30 * 86400000));
  await makeScoreHistoryRow(compositeTenant, compositeCustomer, 80, new Date());

  const compositeResult = await detectMultivariateChange(compositeTenant);
  check('1a. composite tenant: concentration dimension is MATERIAL_CONCERN', compositeResult.dimensions.find(d => d.dimension === 'customer_concentration').status === 'MATERIAL_CONCERN', JSON.stringify(compositeResult.dimensions[0]));
  check('1b. composite tenant: cash_buffer dimension is MATERIAL_CONCERN', compositeResult.dimensions.find(d => d.dimension === 'cash_buffer').status === 'MATERIAL_CONCERN', JSON.stringify(compositeResult.dimensions.find(d => d.dimension === 'cash_buffer')));
  check('1c. composite tenant: payment_trajectory dimension is MATERIAL_CONCERN', compositeResult.dimensions.find(d => d.dimension === 'payment_trajectory').status === 'MATERIAL_CONCERN', JSON.stringify(compositeResult.dimensions.find(d => d.dimension === 'payment_trajectory')));
  check('1d. composite tenant: significance is COMPOSITE (3 concurrent real dimensions)', compositeResult.significance === 'COMPOSITE' && compositeResult.concerningDimensionCount >= 2, JSON.stringify(compositeResult.significance));

  const healthyTenant = await makeUser('healthy-sparse-tenant-mvc');
  const healthyResult = await detectMultivariateChange(healthyTenant);
  check('1e. healthy/sparse tenant: no fabricated composite signal (INSUFFICIENT_DATA, not COMPOSITE)', healthyResult.significance === 'INSUFFICIENT_DATA', JSON.stringify(healthyResult.significance));

  // ============================================================
  // GROUP 2: stackedFragility.js
  // ============================================================
  const realChain = await buildStackedFragilityChain(REAL_CN_TENANT, { supplierId: REAL_CN_SUPPLIER });
  check('2a. real China-supplier chain: product_to_supplier hop is DERIVED with a real materiality band', realChain.hops.find(h => h.hop === 'product_to_supplier').label === 'DERIVED', JSON.stringify(realChain.hops));
  check('2b. real China-supplier chain: supplier_to_event hop resolves OBSERVED+DERIVED (real matched event)', realChain.hops.find(h => h.hop === 'supplier_to_event').label === 'OBSERVED+DERIVED', JSON.stringify(realChain.hops.find(h => h.hop === 'supplier_to_event')));
  check('2c. real China-supplier chain: reports compounded fragility given HIGH/MEDIUM materiality + real event', realChain.compoundedFragility === true, JSON.stringify(realChain));

  const isolatedTenant = await makeUser('isolated-fragility-tenant');
  const isolatedSupplier = await makeSupplier(isolatedTenant, 'Domestic Supplier');
  await makePurchase(isolatedTenant, isolatedSupplier, 100);
  const isolatedChain = await buildStackedFragilityChain(isolatedTenant, { supplierId: isolatedSupplier });
  check('2d. supplier with no real exposure/event: supplier_to_event hop is NOT OBSERVED+DERIVED', isolatedChain.hops.find(h => h.hop === 'supplier_to_event').label !== 'OBSERVED+DERIVED', JSON.stringify(isolatedChain.hops.find(h => h.hop === 'supplier_to_event')));
  check('2e. supplier with no real exposure/event: no fabricated compounded fragility', isolatedChain.compoundedFragility === false);

  const unknownHopChain = await buildStackedFragilityChain(isolatedTenant, { supplierId: isolatedSupplier, customerId: randomUUID() });
  check('2f. customer_to_product hop with no real linkage data is honestly UNKNOWN, not fabricated', unknownHopChain.hops.find(h => h.hop === 'customer_to_product').label === 'UNKNOWN', JSON.stringify(unknownHopChain.hops[0]));

  // ============================================================
  // GROUP 3: uncertaintyDecomposition.js
  // ============================================================
  const uncertaintyTenant = await makeUser('uncertainty-decomposition-tenant');
  const bigCustomer = await makeCustomer(uncertaintyTenant, 'Big Customer');
  const smallCustomer = await makeCustomer(uncertaintyTenant, 'Small Customer');
  await makeInvoice(uncertaintyTenant, bigCustomer, 'Big Customer', 9000, 60, 'Pending');
  await makeInvoice(uncertaintyTenant, smallCustomer, 'Small Customer', 100, 5, 'Pending');
  await makeScoreHistoryRow(uncertaintyTenant, bigCustomer, 10, new Date(Date.now() - 30 * 86400000));
  await makeScoreHistoryRow(uncertaintyTenant, bigCustomer, 90, new Date());

  const decomposition = await decomposeForecastUncertainty(uncertaintyTenant);
  check('3a. decomposition status is DECOMPOSED for a tenant with real open receivables', decomposition.status === 'DECOMPOSED', JSON.stringify(decomposition.status));
  check('3b. top contributor is the real large + worsening customer, not the small stable one', decomposition.topContributors[0] && decomposition.topContributors[0].customerName === 'Big Customer', JSON.stringify(decomposition.topContributors));
  check('3c. every contributor has a real named customer/invoice, not an anonymous entry', decomposition.topContributors.every(c => c.invoiceId && c.customerName), JSON.stringify(decomposition.topContributors));
  check('3d. rank weights strictly order by the disclosed formula (big+worsening > small+stable)', decomposition.topContributors[0].rankWeight > decomposition.topContributors[1].rankWeight, JSON.stringify(decomposition.topContributors));

  const noReceivablesTenant = await makeUser('no-receivables-tenant');
  const emptyDecomposition = await decomposeForecastUncertainty(noReceivablesTenant);
  check('3e. tenant with zero open receivables gets an honest empty decomposition, not fabricated contributors', emptyDecomposition.status === 'NO_OPEN_RECEIVABLES' && emptyDecomposition.contributors.length === 0, JSON.stringify(emptyDecomposition));

  // ============================================================
  // GROUP 4: baselineDivergence.js
  // ============================================================
  const divergenceTenant = await makeUser('baseline-divergence-tenant');
  const divergingCustomer = await makeCustomer(divergenceTenant, 'Diverging Customer');
  // Baseline (>30d ago): stable low scores. Recent (<30d): much higher scores.
  await makeScoreHistoryRow(divergenceTenant, divergingCustomer, 15, new Date(Date.now() - 90 * 86400000));
  await makeScoreHistoryRow(divergenceTenant, divergingCustomer, 16, new Date(Date.now() - 60 * 86400000));
  await makeScoreHistoryRow(divergenceTenant, divergingCustomer, 14, new Date(Date.now() - 45 * 86400000));
  await makeScoreHistoryRow(divergenceTenant, divergingCustomer, 85, new Date(Date.now() - 5 * 86400000));
  await makeScoreHistoryRow(divergenceTenant, divergingCustomer, 88, new Date());

  const divergence = await detectBaselineDivergence(divergenceTenant, divergingCustomer, 'credit_risk_score');
  check('4a. diverging customer: status is ASSESSED with a real baseline and recent window', divergence.status === 'ASSESSED', JSON.stringify(divergence.status));
  check('4b. diverging customer: baseline window uses the 3 older real points', divergence.baselineWindow.pointCount === 3, JSON.stringify(divergence.baselineWindow));
  check('4c. diverging customer: recent window uses the 2 newer real points', divergence.recentWindow.pointCount === 2, JSON.stringify(divergence.recentWindow));
  check('4d. diverging customer: material divergence detected against ITS OWN baseline', divergence.diverges === true, JSON.stringify(divergence.divergence));

  const stableCustomer = await makeCustomer(divergenceTenant, 'Stable Customer');
  await makeScoreHistoryRow(divergenceTenant, stableCustomer, 30, new Date(Date.now() - 90 * 86400000));
  await makeScoreHistoryRow(divergenceTenant, stableCustomer, 31, new Date(Date.now() - 60 * 86400000));
  await makeScoreHistoryRow(divergenceTenant, stableCustomer, 30, new Date(Date.now() - 5 * 86400000));
  const stableDivergence = await detectBaselineDivergence(divergenceTenant, stableCustomer, 'credit_risk_score');
  check('4e. stable customer: no fabricated divergence claim', stableDivergence.diverges === false, JSON.stringify(stableDivergence.divergence));

  const noBaselineCustomer = await makeCustomer(divergenceTenant, 'New Customer');
  await makeScoreHistoryRow(divergenceTenant, noBaselineCustomer, 50, new Date());
  const noBaselineResult = await detectBaselineDivergence(divergenceTenant, noBaselineCustomer, 'credit_risk_score');
  check('4f. brand-new customer with only a recent point: honestly NO_BASELINE_WINDOW, not fabricated stable/divergent', noBaselineResult.status === 'NO_BASELINE_WINDOW', JSON.stringify(noBaselineResult.status));

  // ============================================================
  // GROUP 5: opportunityPropagation.js
  // ============================================================
  const opportunityTenant = await makeUser('opportunity-chain-tenant');
  const oppCustomer = await makeCustomer(opportunityTenant, 'Opportunity Customer');
  const oppSupplier = await makeSupplier(opportunityTenant, 'Stable Supplier');
  await makePurchase(opportunityTenant, oppSupplier, 500);
  // demandRising compares the trailing REVENUE_WINDOW_DAYS window against the
  // prior one of the same length (both real, both required — see
  // opportunityPropagation.js). Prior window (91-180d ago): modest sales.
  // Recent window (0-90d ago): much higher (real demand rising).
  await makeSale(opportunityTenant, oppCustomer, 'Opportunity Customer', 100, new Date(Date.now() - 150 * 86400000));
  await makeSale(opportunityTenant, oppCustomer, 'Opportunity Customer', 100, new Date(Date.now() - 120 * 86400000));
  await makeSale(opportunityTenant, oppCustomer, 'Opportunity Customer', 500, new Date(Date.now() - 30 * 86400000));
  await makeSale(opportunityTenant, oppCustomer, 'Opportunity Customer', 500, new Date(Date.now() - 5 * 86400000));

  const opportunity = await buildOpportunityChain(opportunityTenant, { supplierId: oppSupplier });
  check('5a. real rising demand + stable supplier: demand_rising step is supported', opportunity.steps.find(s => s.step === 'demand_rising').supported === true, JSON.stringify(opportunity.steps.find(s => s.step === 'demand_rising')));
  check('5b. real rising demand + stable supplier: supplier_stable step is supported (no real active event)', opportunity.steps.find(s => s.step === 'supplier_stable').supported === true, JSON.stringify(opportunity.steps.find(s => s.step === 'supplier_stable')));
  check('5c. full chain yields BOUNDED_OPPORTUNITY, never asserts guaranteed revenue', opportunity.status === 'BOUNDED_OPPORTUNITY' && !/guaranteed (revenue|upside|profit)|will generate|certain(ly)? (to )?(profit|revenue)/i.test(opportunity.statement), JSON.stringify(opportunity.statement));

  // Same tenant, but check against the REAL fragile CN supplier as a
  // negative control: supplier_stable step must NOT be supported.
  const negativeControlOpportunity = await buildOpportunityChain(opportunityTenant, { supplierId: REAL_CN_SUPPLIER });
  // Note: REAL_CN_SUPPLIER belongs to a different tenant, so
  // widenSupplierUncertaintyFromEvent(opportunityTenant, REAL_CN_SUPPLIER) should
  // find no exposure rows for opportunityTenant -> NO_EFFECT -> "stable" per this
  // module's tenant-scoped read. This documents the module scopes checks strictly
  // per-tenant (see cross-tenant isolation group below for the direct check).
  check('5d. supplier lookup is tenant-scoped: a real CN supplier id foreign to this tenant yields no exposure found here, not another tenant\'s exposure', negativeControlOpportunity.steps.find(s => s.step === 'supplier_stable').supported === true, JSON.stringify(negativeControlOpportunity.steps.find(s => s.step === 'supplier_stable')));

  const sparseOpportunityTenant = await makeUser('sparse-opportunity-tenant');
  const sparseOpportunity = await buildOpportunityChain(sparseOpportunityTenant, {});
  check('5e. sparse tenant with zero real sales: INSUFFICIENT_DATA, not fabricated opportunity', sparseOpportunity.status === 'INSUFFICIENT_DATA', JSON.stringify(sparseOpportunity.status));

  // ============================================================
  // GROUP 6: intelligenceMerge.js
  // ============================================================
  const sameEntitySignals = [
    { entityType: 'customer', entityId: 'cust-1', sourceType: 'cash_risk', severity: 'MEDIUM', statement: 'cash risk signal' },
    { entityType: 'customer', entityId: 'cust-1', sourceType: 'concentration', severity: 'HIGH', statement: 'concentration signal' },
    { entityType: 'customer', entityId: 'cust-2', sourceType: 'cash_risk', severity: 'LOW', statement: 'unrelated customer signal' },
  ];
  const mergeResult = mergeOverlappingSignals(sameEntitySignals);
  check('6a. two signals on the same entity are merged into one item', mergeResult.mergedCount === 2, JSON.stringify(mergeResult));
  const mergedCust1 = mergeResult.merged.find(m => m.entityId === 'cust-1');
  check('6b. merged item carries the HIGHEST real severity of its inputs (HIGH, not MEDIUM)', mergedCust1.severity === 'HIGH', JSON.stringify(mergedCust1));
  check('6c. merged item records both real source types', mergedCust1.sourceTypes.includes('cash_risk') && mergedCust1.sourceTypes.includes('concentration'), JSON.stringify(mergedCust1.sourceTypes));
  const unrelatedCust2 = mergeResult.merged.find(m => m.entityId === 'cust-2');
  check('6d. an unrelated entity signal is left un-merged (mergedFromCount 1)', unrelatedCust2.mergedFromCount === 1, JSON.stringify(unrelatedCust2));
  check('6e. compaction ratio reflects the real reduction (3 inputs -> 2 outputs)', mergeResult.originalCount === 3 && mergeResult.mergedCount === 2, JSON.stringify(mergeResult));

  // ============================================================
  // CROSS-CUTTING: cross-tenant isolation
  // ============================================================
  const tenantA = await makeUser('isolation-tenant-a');
  const tenantB = await makeUser('isolation-tenant-b');
  const tenantACustomer = await makeCustomer(tenantA, 'Tenant A Customer');
  await makeSale(tenantA, tenantACustomer, 'Tenant A Customer', 900, new Date());
  await makeInvoice(tenantA, tenantACustomer, 'Tenant A Customer', 800, 50, 'Pending');
  await makeScoreHistoryRow(tenantA, tenantACustomer, 10, new Date(Date.now() - 30 * 86400000));
  await makeScoreHistoryRow(tenantA, tenantACustomer, 90, new Date());

  const tenantAResult = await detectMultivariateChange(tenantA);
  const tenantBResult = await detectMultivariateChange(tenantB);
  check('7a. tenant A shows real dimensions (has real data)', tenantAResult.checkableDimensionCount > 0, JSON.stringify(tenantAResult.checkableDimensionCount));
  check('7b. tenant B (no data) never sees tenant A\'s composite signal', tenantBResult.significance === 'INSUFFICIENT_DATA' && tenantBResult.concerningDimensionCount === 0, JSON.stringify(tenantBResult));

  const tenantADecomposition = await decomposeForecastUncertainty(tenantA);
  const tenantBDecomposition = await decomposeForecastUncertainty(tenantB);
  check('7c. tenant B\'s uncertainty decomposition contains none of tenant A\'s real invoice ids', tenantBDecomposition.status === 'NO_OPEN_RECEIVABLES' || tenantBDecomposition.topContributors.every(c => !createdInvoices.includes(c.invoiceId) || !tenantADecomposition.topContributors.map(t => t.invoiceId).includes(c.invoiceId)), JSON.stringify(tenantBDecomposition));
  check('7d. tenant A\'s decomposition top contributor is really tenant A\'s own customer', tenantADecomposition.topContributors.length > 0 && tenantADecomposition.topContributors[0].customerName === 'Tenant A Customer', JSON.stringify(tenantADecomposition.topContributors));

  const finalResults = { pass, fail, results };
  console.log(JSON.stringify({ pass, fail }, null, 2));
  for (const r of results) console.log(r);
  return finalResults;
}

async function cleanup() {
  // Delete in FK-safe order: children before parents.
  if (createdScoreHistory.length) await pool.query(`DELETE FROM customer_score_history WHERE id = ANY($1::uuid[])`, [createdScoreHistory]);
  if (createdInvoices.length) await pool.query(`DELETE FROM invoices WHERE id = ANY($1::uuid[])`, [createdInvoices]);
  if (createdSales.length) await pool.query(`DELETE FROM sales WHERE id = ANY($1::bigint[])`, [createdSales]);
  if (createdExposures.length) await pool.query(`DELETE FROM business_exposure WHERE id = ANY($1::uuid[])`, [createdExposures]);
  if (createdPurchases.length) await pool.query(`DELETE FROM purchases WHERE id = ANY($1::bigint[])`, [createdPurchases]);
  if (createdSuppliers.length) await pool.query(`DELETE FROM suppliers WHERE id = ANY($1::uuid[])`, [createdSuppliers]);
  if (createdCustomers.length) await pool.query(`DELETE FROM customers WHERE id = ANY($1::uuid[])`, [createdCustomers]);
  if (createdUsers.length) await pool.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [createdUsers]);
}

async function verifyResidualRows() {
  const checks = [
    ['customer_score_history', createdScoreHistory],
    ['invoices', createdInvoices],
    ['business_exposure', createdExposures],
    ['suppliers', createdSuppliers],
    ['customers', createdCustomers],
    ['users', createdUsers],
  ];
  let residual = 0;
  for (const [table, ids] of checks) {
    if (!ids.length) continue;
    const res = await pool.query(`SELECT COUNT(*)::int AS c FROM ${table} WHERE id = ANY($1::uuid[])`, [ids]);
    if (res.rows[0].c > 0) {
      residual += res.rows[0].c;
      console.error(`RESIDUAL: ${res.rows[0].c} row(s) remain in ${table}`);
    }
  }
  for (const [table, ids] of [['sales', createdSales], ['purchases', createdPurchases]]) {
    if (!ids.length) continue;
    const res = await pool.query(`SELECT COUNT(*)::int AS c FROM ${table} WHERE id = ANY($1::bigint[])`, [ids]);
    if (res.rows[0].c > 0) {
      residual += res.rows[0].c;
      console.error(`RESIDUAL: ${res.rows[0].c} row(s) remain in ${table}`);
    }
  }
  console.log(residual === 0 ? 'CLEANUP VERIFIED: zero residual fixture rows' : `CLEANUP FAILED: ${residual} residual rows`);
  return residual;
}

(async () => {
  let exitCode = 0;
  try {
    const result = await main();
    exitCode = result.fail > 0 ? 1 : 0;
  } catch (e) {
    console.error('TEST SUITE ERROR:', e);
    exitCode = 1;
  } finally {
    try {
      await cleanup();
      const residual = await verifyResidualRows();
      if (residual > 0) exitCode = 1;
    } catch (e) {
      console.error('CLEANUP ERROR:', e);
      exitCode = 1;
    }
    await pool.end();
  }
  process.exit(exitCode);
})();
