// FILE: lib/domain/decisions/detectors/supplyChain.js
// Turns an existing supply-chain business_signal (world event -> supplier ->
// component -> finished product -> open orders, built by
// supplyChainOrchestrator.getSignalImpact) into a Decision. Nothing about
// the exposure path is recomputed here; this module adds the decision layer:
// options including do nothing, a stockout simulation with explicit lead-time
// and demand ranges, a latest-safe-order date, and the execution intent
// (CREATE_PO through the existing supply-chain execution adapter).
//
// Live only: business_signals has no as-of history, so it is excluded from
// historical replays (the backtest says so).

const { mulberry32, uniform, seedFrom, quantile } = require('../rng');
const { toIsoDate, addDays, startOfUtcDay } = require('../dates');
const { ENGINE_VERSION, DEFINITIONS_VERSION } = require('../definitions');
const { fmtMoney } = require('./receivables');

const SUPPLY_MODEL_VERSION = 'stockout-mc@1';

function simulateComponent(component, iterations, seed) {
  const rand = mulberry32(seed);
  const stock = Number(component.stock);
  const demand = Number(component.demand);
  const safety = Number(component.safety || 0);
  const lead = Number(component.leadTimeDays);
  const exposure = Number(component.revenueExposure || 0);
  const specs = [
    { key: 'do_nothing', arrival: null },
    { key: 'expedite', arrival: [0.6, 0.9], costShare: 0.03 },
    ...(component.alternate ? [{ key: 'switch_supplier', arrival: [0.8, 1.4], costShare: 0.08 }] : []),
  ];
  const acc = specs.map(() => ({ stockouts: 0, loss: new Float64Array(iterations) }));
  for (let it = 0; it < iterations; it++) {
    const d = demand * uniform(rand, 0.8, 1.25);
    const daysToStockout = Math.max(0, (stock - safety) / d);
    const disruption = uniform(rand, 1.0, 1.5); // current supplier's lead time under the disruption
    specs.forEach((s, si) => {
      let stockout;
      if (!s.arrival) stockout = daysToStockout < 45;
      else {
        const base = s.key === 'expedite' ? lead * disruption : lead;
        stockout = base * uniform(rand, s.arrival[0], s.arrival[1]) > daysToStockout;
      }
      const cost = s.costShare ? exposure * s.costShare : 0;
      if (stockout) acc[si].stockouts++;
      acc[si].loss[it] = (stockout ? exposure : 0) + cost;
    });
  }
  return specs.map((s, si) => {
    const sorted = Float64Array.from(acc[si].loss).sort();
    let sum = 0; for (const v of acc[si].loss) sum += v;
    return {
      key: s.key,
      stockoutProbability: Math.round((acc[si].stockouts / iterations) * 1000) / 1000,
      expectedCost: { mean: Math.round(sum / iterations), p10: Math.round(quantile(sorted, 0.1)), p50: Math.round(quantile(sorted, 0.5)), p90: Math.round(quantile(sorted, 0.9)) },
      premium: s.costShare ? Math.round(exposure * s.costShare) : 0,
    };
  });
}

/**
 * @param {object} deps { pool, getSignalImpact }
 */
async function discoverSupplyChainDecisions(userId, defs, deps) {
  const { pool, getSignalImpact } = deps;
  const drafts = [];
  const watched = [];
  const sigRes = await pool.query(
    `SELECT id FROM business_signals WHERE user_id = $1 AND status IN ('CANDIDATE','ACTIVE','UPDATED') AND related_entity_type = 'supplier' ORDER BY last_updated_at DESC NULLS LAST LIMIT 25`,
    [userId]
  );
  const asOfDay = startOfUtcDay(Date.now());
  for (const { id: signalId } of sigRes.rows) {
    const impact = await getSignalImpact(signalId, userId);
    if (!impact) continue;
    if (!impact.sufficientDataForQuantification) { watched.push({ signalId, reason: impact.reason }); continue; }
    for (const comp of impact.components) {
      if (!comp.stockout.sufficientData || comp.leadTimeDays == null) { watched.push({ signalId, component: comp.component.name, reason: 'Stock, demand or lead time missing; cannot size the risk' }); continue; }
      const productRes = await pool.query('SELECT current_stock, avg_daily_demand, safety_stock FROM products WHERE id = $1 AND user_id = $2', [comp.component.id, userId]);
      const p = productRes.rows[0];
      if (!p) continue;
      const exposure = comp.revenueExposure.totalRevenueExposure || 0;
      const input = { stock: p.current_stock, demand: p.avg_daily_demand, safety: p.safety_stock, leadTimeDays: comp.leadTimeDays, revenueExposure: exposure, alternate: comp.alternateSource };
      const seed = seedFrom(`supply|${signalId}|${comp.component.id}|${asOfDay}`);
      const futures = simulateComponent(input, defs.simulation_iterations, seed);
      const dn = futures.find((f) => f.key === 'do_nothing');
      if (dn.stockoutProbability < 0.1 || exposure < defs.material_amount_min) {
        watched.push({ signalId, component: comp.component.name, reason: `Stockout chance ${Math.round(dn.stockoutProbability * 100)}% with ${fmtMoney(exposure, defs.base_currency)} exposed; below threshold` });
        continue;
      }
      const lastSafeOffset = Math.floor(comp.stockout.daysUntilStockout - comp.leadTimeDays);
      const options = futures.map((f) => {
        const isDn = f.key === 'do_nothing';
        return {
          key: f.key,
          label: isDn ? 'Do nothing new' : f.key === 'expedite' ? `Expedite a reorder from ${impact.supplier.name}` : `Switch to ${comp.alternateSource.name}`,
          summary: isDn ? 'Wait and watch the supplier.' : f.key === 'expedite' ? 'Place an expedited order with the current supplier (about 3% premium, an assumption).' : 'Order from the alternate source on record (about 8% premium; its lead time is not on record).',
          intent: isDn ? { type: 'NONE' } : { type: 'CREATE_PO', signalId, componentId: comp.component.id, intervention: f.key },
          isDoNothing: isDn,
          reversibility: isDn ? 'HIGHLY_REVERSIBLE' : 'DIFFICULT_TO_REVERSE',
          blastRadius: isDn ? { customers: 0, moneyTouched: 0, externalParties: 0, systemsTouched: [], summary: 'Nothing changes.' }
            : { customers: comp.affectedDemand.affectedOrderCount, moneyTouched: f.premium, externalParties: 1, systemsTouched: ['purchase_orders'], summary: `One purchase order; protects ${comp.affectedDemand.affectedOrderCount} open order(s).` },
          approval: isDn ? { required: false, approvers: 0 } : { required: true, approvers: 1, role: 'owner', reason: 'Owner approval required: commits money to a supplier.' },
          valid: true,
          executableAs: isDn ? 'no action' : 'draft purchase order through the supply-chain adapter (no live ERP write)',
          assumptions: isDn ? [] : [{ key: `${f.key}.arrival`, label: f.key === 'expedite' ? 'Expedited delivery takes 60–90% of the disrupted lead time' : 'Alternate supplier delivers in 80–140% of the normal lead time', basis: 'ASSUMPTION' }],
          futures: { stockoutProbability: f.stockoutProbability, expectedCost: f.expectedCost, value: { mean: -f.expectedCost.mean, p10: -f.expectedCost.p90, p50: -f.expectedCost.p50, p90: -f.expectedCost.p10 } },
        };
      });
      const rec = options.slice().sort((a, b) => b.futures.value.mean - a.futures.value.mean)[0];
      drafts.push({
        kind: 'SUPPLY_STOCKOUT',
        dedupKey: `supply:${signalId}:${comp.component.id}`,
        title: `Act now to protect ${fmtMoney(exposure, defs.base_currency)} of orders that need ${comp.component.name}?`,
        description: `${impact.supplier.name} is exposed to "${impact.signal.event_title || 'an external event'}". ${comp.component.name} has ${comp.coverage.coverageDays} days of stock.`,
        currency: defs.base_currency,
        affectedEntities: [
          { type: 'supplier', id: String(impact.supplier.id), name: impact.supplier.name },
          { type: 'product', id: comp.component.id, name: comp.component.name },
          ...comp.affectedDemand.affectedOrderIds.map((id) => ({ type: 'order', id })),
        ],
        affectedProcesses: ['procure_to_pay', 'order_to_cash'],
        triggerSignals: [{ code: 'EXTERNAL_EXPOSURE', label: impact.signal.why_exists || 'External event linked to a supplier', signalId }],
        whyNow: [
          `${comp.component.name}: ${comp.coverage.coverageDays} days of stock at current demand`,
          `Supplier lead time on record: ${comp.leadTimeDays} days`,
          `${comp.affectedDemand.affectedOrderCount} open order(s) worth ${fmtMoney(exposure, defs.base_currency)} depend on it`,
        ],
        whatIfIgnored: `Stockout within 45 days in ${Math.round(dn.stockoutProbability * 100)}% of simulated futures, putting ${fmtMoney(exposure, defs.base_currency)} of open orders at risk.`,
        window: {
          discoveredAt: new Date().toISOString(),
          usefulFrom: toIsoDate(asOfDay),
          latestSafeAt: toIsoDate(addDays(asOfDay, Math.max(0, lastSafeOffset))),
          costOfDelayPerWeek: null,
          basis: lastSafeOffset > 0 ? `An order placed after ${toIsoDate(addDays(asOfDay, lastSafeOffset))} arrives after stock runs out at the recorded lead time.` : 'Stock runs out before a normal-lead-time order could arrive. Only expediting or switching can help.',
          timezone: defs.timezone,
        },
        objectives: [{ key: 'revenue', label: 'Protect confirmed orders', weight: 1 }],
        constraints: [{ key: 'no_live_erp', type: 'OPERATIONAL', hard: true, label: 'No live ERP connector: purchase orders are drafted in Starlane only', status: 'LIMITS_EXECUTION' }],
        options,
        doNothingKey: 'do_nothing',
        evidence: impact.evidence.map((e) => ({ ...e, source: typeof e.source === 'string' ? { ref: e.source } : e.source })),
        unknowns: [
          ...(comp.alternateSource ? [{ key: 'alternate_lead_time', label: `${comp.alternateSource.name}'s lead time is not on record`, status: 'UNKNOWN', valueOfInformation: null, acquisition: { type: 'REQUEST_INFORMATION', how: `Ask ${comp.alternateSource.name} for a delivery date` } }] : []),
          { key: 'supplier_capacity', label: `${impact.supplier.name}'s actual capacity under the disruption`, status: 'UNKNOWN', valueOfInformation: null, acquisition: { type: 'REQUEST_INFORMATION', how: `Ask ${impact.supplier.name} to confirm the next delivery date` } },
        ],
        assumptions: [{ key: 'demand', label: 'Daily demand varies 80–125% of the recorded average', basis: 'ASSUMPTION' }, { key: 'disruption', label: 'The disruption stretches the current supplier\'s lead time by 0–50%', basis: 'ASSUMPTION' }, ...options.flatMap((o) => o.assumptions)],
        contradictions: [],
        expectedValue: rec.futures.value.mean,
        downsideRisk: rec.futures.expectedCost.p90 - rec.futures.expectedCost.mean,
        upsidePotential: rec.futures.expectedCost.mean - rec.futures.expectedCost.p10,
        reversibility: rec.reversibility,
        blastRadius: rec.blastRadius,
        urgency: lastSafeOffset <= 0 ? 1 : Math.max(0.1, 1 - lastSafeOffset / 30),
        materiality: { revenueExposure: exposure, stockoutProbability: dn.stockoutProbability },
        confidence: { score: 0.6, band: 'POSSIBLE', components: [{ name: 'lead_time', value: 0.6, detail: 'Lead times are owner-recorded, not measured deliveries' }], meaning: 'Evidence strength for the exposure path; option effects are assumptions.' },
        recommendation: {
          key: rec.key,
          label: rec.label,
          why: `${rec.label} has the lowest expected cost of stockout plus premium (${fmtMoney(-rec.futures.value.mean, defs.base_currency)}).`,
          whyNot: options.filter((o) => o.key !== rec.key).map((o) => ({ key: o.key, reason: `Expected cost ${fmtMoney(-o.futures.value.mean, defs.base_currency)}; stockout chance ${Math.round(o.futures.stockoutProbability * 100)}%` })),
          wouldChangeIf: [],
          informationFirst: null,
        },
        analysis: { simulation: { iterations: defs.simulation_iterations, seed, model: SUPPLY_MODEL_VERSION }, signalId },
        modelVersions: { engine: ENGINE_VERSION, supply: SUPPLY_MODEL_VERSION, definitions: DEFINITIONS_VERSION },
      });
    }
  }
  return { drafts, watched };
}

module.exports = { discoverSupplyChainDecisions, simulateComponent, SUPPLY_MODEL_VERSION };
