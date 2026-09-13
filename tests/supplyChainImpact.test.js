const assert = require('assert');
const {
  calculateInventoryCoverage,
  calculateStockoutDate,
  findAffectedProducts,
  calculateAffectedDemand,
  calculateRevenueExposure,
  calculateCashExposure,
  rankInterventions,
} = require('../lib/domain/intelligence/supplyChainImpact');

function testCoverageInsufficientData() {
  assert.strictEqual(calculateInventoryCoverage({ currentStock: null, avgDailyDemand: 5 }).sufficientData, false, 'missing stock -> insufficient data, never a guessed coverage');
  assert.strictEqual(calculateInventoryCoverage({ currentStock: 100, avgDailyDemand: 0 }).sufficientData, false, 'zero demand -> undefined coverage, not Infinity or a fabricated number');
}
function testCoverageMath() {
  const r = calculateInventoryCoverage({ currentStock: 100, avgDailyDemand: 25 });
  assert.strictEqual(r.sufficientData, true);
  assert.strictEqual(r.coverageDays, 4);
}
function testStockoutDate() {
  const r = calculateStockoutDate({ currentStock: 100, avgDailyDemand: 10, safetyStock: 20, asOfIso: '2026-09-13T00:00:00Z' });
  assert.strictEqual(r.sufficientData, true);
  assert.strictEqual(r.daysUntilStockout, 8);
  assert.strictEqual(r.stockoutDate, '2026-09-21');
}
function testStockoutAlreadyBelowSafety() {
  const r = calculateStockoutDate({ currentStock: 10, avgDailyDemand: 5, safetyStock: 20, asOfIso: '2026-09-13T00:00:00Z' });
  assert.strictEqual(r.alreadyBelowSafetyStock, true);
  assert.strictEqual(r.daysUntilStockout, 0);
}
function testBomTraversalDirectAndTransitive() {
  // component C1 -> P1 (qty 2); P1 -> P2 (qty 3, i.e. P2 also consumes P1 as a sub-part)
  const components = [
    { finished_product_id: 'P1', component_product_id: 'C1', quantity_per_unit: 2 },
    { finished_product_id: 'P2', component_product_id: 'P1', quantity_per_unit: 3 },
  ];
  const affected = findAffectedProducts('C1', components);
  const byId = Object.fromEntries(affected.map((a) => [a.finishedProductId, a.quantityPerUnit]));
  assert.strictEqual(byId.P1, 2, 'direct consumer quantity');
  assert.strictEqual(byId.P2, 6, 'transitive consumer multiplies through the chain (2*3)');
}
function testBomTraversalUnaffectedProductExcluded() {
  const components = [
    { finished_product_id: 'P1', component_product_id: 'C1', quantity_per_unit: 1 },
    { finished_product_id: 'P_UNRELATED', component_product_id: 'C_OTHER', quantity_per_unit: 1 },
  ];
  const affected = findAffectedProducts('C1', components);
  assert.strictEqual(affected.some((a) => a.finishedProductId === 'P_UNRELATED'), false, 'a product with no dependency on the disrupted component must never appear as affected');
}
function testAffectedDemandAndRevenue() {
  const lines = [
    { order_id: 'O1', product_id: 'P1', quantity: 10, unit_price: 5 },
    { order_id: 'O2', product_id: 'P_SAFE', quantity: 99, unit_price: 100 },
  ];
  const demand = calculateAffectedDemand(lines, ['P1']);
  assert.strictEqual(demand.affectedOrderCount, 1);
  assert.strictEqual(demand.affectedOrderIds[0], 'O1');
  const revenue = calculateRevenueExposure(demand.affectedLineItems);
  assert.strictEqual(revenue.totalRevenueExposure, 50, 'unaffected order revenue must never leak into the exposure total');
}
function testCashExposureWithheldWithoutMargin() {
  const r = calculateCashExposure({ totalRevenueExposure: 1000, marginRatio: null });
  assert.strictEqual(r.sufficientData, false, 'no margin on record -> cash exposure withheld, never assumed at a default margin');
}
function testRankInterventions() {
  const ranked = rankInterventions([
    { id: 'a', avoidedRevenueExposure: 1000, cost: 500, leadTimeDays: 10 },
    { id: 'b', avoidedRevenueExposure: 900, cost: 100, leadTimeDays: 5 },
  ]);
  assert.strictEqual(ranked[0].id, 'b', 'higher benefit-to-cost ratio ranks first even with lower absolute avoided exposure');
}

testCoverageInsufficientData();
testCoverageMath();
testStockoutDate();
testStockoutAlreadyBelowSafety();
testBomTraversalDirectAndTransitive();
testBomTraversalUnaffectedProductExcluded();
testAffectedDemandAndRevenue();
testCashExposureWithheldWithoutMargin();
testRankInterventions();
console.log('[PASS] supplyChainImpact tests');
