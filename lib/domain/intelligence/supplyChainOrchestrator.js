// FILE: lib/domain/intelligence/supplyChainOrchestrator.js
// Thin DB-orchestration layer connecting the real relevance pipeline
// (lib/world/relevance.js) to the pure calculation module
// (supplyChainImpact.js) and the existing ai_actions/predictions tables.
// No new matching logic, no new action/command abstraction — this file
// only loads real rows, calls pure functions, and writes results into the
// tables that already exist for this purpose.
const { getPool } = require('../../db/pg');
const {
  calculateInventoryCoverage,
  calculateStockoutDate,
  findAffectedProducts,
  calculateAffectedDemand,
  calculateRevenueExposure,
  calculateCashExposure,
  rankInterventions,
} = require('./supplyChainImpact');

// ─── Evidence chain classification ─────────────────────────────────────
// Every fact surfaced in the impact view is tagged with one of these kinds
// so the UI can render "observed fact" vs "assumption" vs "forecast"
// distinctly, per the zero-fabrication requirement. Never collapse these.
const EVIDENCE_KIND = {
  OBSERVED_FACT: 'OBSERVED_FACT',       // a value read directly from a system-of-record row
  CALCULATED_FACT: 'CALCULATED_FACT',   // a deterministic function of observed facts
  ASSUMPTION: 'ASSUMPTION',             // an owner-entered planning parameter (lead time, safety stock)
  FORECAST: 'FORECAST',                 // a projection assuming no intervention
  EXTERNAL_EVIDENCE: 'EXTERNAL_EVIDENCE', // sourced from a world_event / world_source
  INTERNAL_EVIDENCE: 'INTERNAL_EVIDENCE', // sourced from this tenant's own business data
};

function confidenceLabel(value) {
  if (value == null) return 'UNKNOWN';
  if (value >= 0.75) return 'HIGH';
  if (value >= 0.5) return 'MEDIUM';
  return 'LOW';
}

// Loads one business_signal plus everything needed to render/compute its
// full impact: the supplier it's about, the components that supplier
// provides, the BOM traversal to finished products, open orders against
// those products, and evidence for each step. Returns null if the signal
// doesn't belong to this tenant (never leaks cross-tenant data).
async function getSignalImpact(signalId, userId) {
  const pool = getPool();

  const sigRes = await pool.query(
    `SELECT bs.*, we.title AS event_title, we.summary AS event_summary, we.event_type,
            we.observed_at AS event_observed_at, we.source_url AS event_source_url,
            we.magnitude, we.magnitude_unit, we.confidence AS event_confidence,
            tc.channel_code, tc.mechanism, tc.rule_explanation, tc.required_evidence
     FROM business_signals bs
     LEFT JOIN world_events we ON we.id = bs.world_event_id
     LEFT JOIN world_transmission_channels tc ON tc.id = bs.transmission_channel_id
     WHERE bs.id = $1 AND bs.user_id = $2`,
    [signalId, userId]
  );
  if (sigRes.rows.length === 0) return null;
  const signal = sigRes.rows[0];

  const evidence = [];
  evidence.push({
    kind: EVIDENCE_KIND.EXTERNAL_EVIDENCE,
    label: 'External event',
    detail: signal.event_title,
    source: signal.event_source_url || 'internal reference record',
    timestamp: signal.event_observed_at,
    confidence: confidenceLabel(signal.event_confidence),
  });
  evidence.push({
    kind: EVIDENCE_KIND.INTERNAL_EVIDENCE,
    label: 'Business exposure',
    detail: signal.why_exists,
    source: `business_exposure ${signal.business_exposure_id}`,
    timestamp: signal.first_detected_at,
    confidence: confidenceLabel(signal.exposure_confidence_component),
  });

  if (signal.related_entity_type !== 'supplier') {
    // This signal isn't about a supplier — the BOM/inventory traversal below
    // doesn't apply. Return what we have rather than fabricating a path.
    return { signal, evidence, sufficientDataForQuantification: false, reason: 'Signal is not supplier-scoped; no dependency traversal defined for this entity type.' };
  }

  const supplierId = signal.related_entity_id;
  const supplierRes = await pool.query(`SELECT id, name, country FROM suppliers WHERE id = $1 AND user_id = $2`, [supplierId, userId]);
  const supplier = supplierRes.rows[0] || null;
  if (!supplier) return { signal, evidence, sufficientDataForQuantification: false, reason: 'Supplier record not found.' };
  evidence.push({ kind: EVIDENCE_KIND.OBSERVED_FACT, label: 'Supplier', detail: `${supplier.name} (${supplier.country})`, source: `suppliers ${supplier.id}`, confidence: 'HIGH' });

  // Components this supplier provides (product_suppliers link).
  const compRes = await pool.query(
    `SELECT p.id, p.name, p.sku, p.current_stock, p.lead_time_days, p.safety_stock, p.avg_daily_demand
     FROM product_suppliers ps JOIN products p ON p.id = ps.product_id
     WHERE ps.user_id = $1 AND ps.supplier_id = $2`,
    [userId, supplierId]
  );
  const components = compRes.rows;
  if (components.length === 0) {
    return { signal, evidence, sufficientDataForQuantification: false, reason: 'No components on record from this supplier; cannot trace downstream impact.' };
  }

  const allComponentsRes = await pool.query(`SELECT id, name, is_alternate_for_id FROM products WHERE user_id = $1`, [userId]);
  const bomRes = await pool.query(`SELECT finished_product_id, component_product_id, quantity_per_unit FROM product_components WHERE user_id = $1`, [userId]);
  const bomRows = bomRes.rows;

  const orderLinesRes = await pool.query(
    `SELECT oli.order_id, oli.product_id, oli.quantity, oli.unit_price, oli.needed_by, o.customer_name, o.status
     FROM order_line_items oli JOIN orders o ON o.id = oli.order_id
     WHERE oli.user_id = $1 AND o.status NOT IN ('delivered', 'cancelled')`,
    [userId]
  );

  const perComponent = [];
  for (const component of components) {
    const coverage = calculateInventoryCoverage({ currentStock: component.current_stock, avgDailyDemand: component.avg_daily_demand });
    const stockout = calculateStockoutDate({
      currentStock: component.current_stock,
      avgDailyDemand: component.avg_daily_demand,
      safetyStock: component.safety_stock,
      asOfIso: new Date().toISOString(),
    });
    const affectedFinished = findAffectedProducts(component.id, bomRows);
    const affectedProductIds = affectedFinished.map((a) => a.finishedProductId);
    const demand = calculateAffectedDemand(orderLinesRes.rows, affectedProductIds);
    const revenue = calculateRevenueExposure(demand.affectedLineItems);
    const alternate = allComponentsRes.rows.find((p) => p.is_alternate_for_id === component.id) || null;

    evidence.push({
      kind: EVIDENCE_KIND.OBSERVED_FACT,
      label: 'Component inventory',
      detail: `${component.name}: ${component.current_stock ?? 'unknown'} units on hand, avg daily demand ${component.avg_daily_demand ?? 'unknown'}`,
      source: `products ${component.id}`,
      confidence: 'HIGH',
    });
    if (coverage.sufficientData) {
      evidence.push({ kind: EVIDENCE_KIND.CALCULATED_FACT, label: 'Inventory coverage', detail: `${coverage.coverageDays} days of stock remaining at current demand`, source: 'calculateInventoryCoverage()', confidence: 'HIGH' });
    }
    if (stockout.sufficientData) {
      evidence.push({ kind: EVIDENCE_KIND.FORECAST, label: 'Projected stockout', detail: stockout.alreadyBelowSafetyStock ? 'Already below safety stock' : `${stockout.stockoutDate} (${stockout.daysUntilStockout} days) if no action is taken`, source: 'calculateStockoutDate()', confidence: 'MEDIUM' });
    }
    evidence.push({ kind: EVIDENCE_KIND.CALCULATED_FACT, label: 'Downstream products affected', detail: `${affectedFinished.length} finished product(s) consume this component`, source: 'findAffectedProducts() — BOM traversal', confidence: 'HIGH' });
    if (demand.affectedOrderCount > 0) {
      evidence.push({ kind: EVIDENCE_KIND.OBSERVED_FACT, label: 'Open orders at risk', detail: `${demand.affectedOrderCount} open order(s) include an affected product`, source: 'order_line_items', confidence: 'HIGH' });
      evidence.push({ kind: EVIDENCE_KIND.CALCULATED_FACT, label: 'Revenue exposure', detail: `₹${revenue.totalRevenueExposure.toLocaleString('en-IN')} across at-risk open orders${revenue.excludedLineCount ? ` (${revenue.excludedLineCount} line(s) excluded — missing price data)` : ''}`, source: 'calculateRevenueExposure()', confidence: 'HIGH' });
    }
    if (component.lead_time_days != null) {
      evidence.push({ kind: EVIDENCE_KIND.ASSUMPTION, label: 'Supplier lead time', detail: `${component.lead_time_days} days (owner-recorded)`, source: `products ${component.id}`, confidence: 'MEDIUM' });
    }
    if (alternate) {
      evidence.push({ kind: EVIDENCE_KIND.OBSERVED_FACT, label: 'Alternate source on record', detail: `${alternate.name} is recorded as an alternate for this component`, source: `products ${alternate.id}`, confidence: 'HIGH' });
    }

    perComponent.push({
      component: { id: component.id, name: component.name, sku: component.sku },
      coverage,
      stockout,
      affectedFinishedProducts: affectedFinished,
      affectedDemand: demand,
      revenueExposure: revenue,
      alternateSource: alternate,
      leadTimeDays: component.lead_time_days,
    });
  }

  const totalRevenueExposure = perComponent.reduce((s, c) => s + (c.revenueExposure.totalRevenueExposure || 0), 0);

  return {
    signal,
    supplier,
    evidence,
    sufficientDataForQuantification: true,
    components: perComponent,
    totalRevenueExposure: Math.round(totalRevenueExposure * 100) / 100,
  };
}

// Writes a real forecast row into the existing `predictions` table — no
// parallel forecast/prediction system. `impact` is the output of
// getSignalImpact(). Only writes a point estimate when the underlying
// coverage/stockout math had sufficient data; otherwise records
// evaluation_status accordingly rather than a fabricated number.
async function writeDoNothingForecast(userId, signalId, impact) {
  const pool = getPool();
  const horizons = [7, 14, 30];
  const written = [];
  if (!impact.sufficientDataForQuantification) return written;

  for (const component of impact.components) {
    for (const horizonDays of horizons) {
      const projectedDate = new Date(Date.now() + horizonDays * 86400000).toISOString();
      const willHaveStockedOut = component.stockout.sufficientData
        ? (component.stockout.alreadyBelowSafetyStock || component.stockout.daysUntilStockout <= horizonDays)
        : null;
      const pointEstimate = component.stockout.sufficientData ? (willHaveStockedOut ? 1 : 0) : null;
      const res = await pool.query(
        `INSERT INTO predictions
           (user_id, entity_type, entity_id, target, prediction_type, as_of, horizon_days,
            point_estimate, model_name, model_version, baseline_model, assumptions, evidence, data_quality)
         VALUES ($1,'product',$2,'stockout_within_horizon','deterministic_baseline',NOW(),$3,$4,
                 'supplyChainImpact.calculateStockoutDate','v1','deterministic',$5,$6,$7)
         RETURNING *`,
        [
          userId, component.component.id, horizonDays, pointEstimate,
          JSON.stringify({ leadTimeDays: component.leadTimeDays, safetyStockAssumed: true }),
          JSON.stringify({ signalId, projectedDate, stockout: component.stockout }),
          component.stockout.sufficientData ? 'sufficient' : 'insufficient',
        ]
      );
      written.push(res.rows[0]);

      // Second prediction type: revenue exposure carried forward under the
      // "no action taken" assumption. We do not model per-horizon decay of
      // this figure (no data supports one yet) — the same current exposure
      // is projected at each horizon, and that carried-forward assumption is
      // recorded explicitly in `assumptions` rather than hidden. What DOES
      // change per horizon is the real, later observation: how much of this
      // revenue is still actually exposed once real order data has moved.
      const revRes = await pool.query(
        `INSERT INTO predictions
           (user_id, entity_type, entity_id, target, prediction_type, as_of, horizon_days,
            point_estimate, model_name, model_version, baseline_model, assumptions, evidence, data_quality)
         VALUES ($1,'product',$2,'revenue_exposure_within_horizon','deterministic_baseline',NOW(),$3,$4,
                 'supplyChainImpact.calculateRevenueExposure','v1','deterministic',$5,$6,$7)
         RETURNING *`,
        [
          userId, component.component.id, horizonDays, component.revenueExposure.totalRevenueExposure,
          JSON.stringify({ noDecayModel: true, note: 'Current exposure carried forward unchanged; no per-horizon decay model exists yet.' }),
          JSON.stringify({ signalId, projectedDate, revenueExposure: component.revenueExposure }),
          component.revenueExposure.sufficientData ? 'sufficient' : 'insufficient',
        ]
      );
      written.push(revRes.rows[0]);
    }
  }
  return written;
}

// Builds ranked, quantified intervention candidates for a signal's impact
// and persists them as real ai_actions rows (reusing the existing action/
// approval lifecycle rather than inventing a new one).
async function createRecommendedActions(userId, signalId, impact) {
  const pool = getPool();
  if (!impact.sufficientDataForQuantification) return [];

  const created = [];
  for (const component of impact.components) {
    if (!component.stockout.sufficientData || component.stockout.daysUntilStockout > 45) continue; // not urgent enough to recommend

    const candidates = [];
    candidates.push({
      id: 'expedite',
      label: `Expedite reorder of ${component.component.name} from current supplier`,
      avoidedRevenueExposure: component.revenueExposure.totalRevenueExposure,
      cost: Math.round((component.revenueExposure.totalRevenueExposure || 0) * 0.03), // 3% expedite premium — transparent assumption
      leadTimeDays: component.leadTimeDays,
    });
    if (component.alternateSource) {
      candidates.push({
        id: 'switch_supplier',
        label: `Switch to alternate source: ${component.alternateSource.name}`,
        avoidedRevenueExposure: component.revenueExposure.totalRevenueExposure,
        cost: Math.round((component.revenueExposure.totalRevenueExposure || 0) * 0.08), // higher cost: new-supplier premium
        leadTimeDays: component.leadTimeDays, // unknown precisely; real system would look up alt lead time
      });
    }
    const ranked = rankInterventions(candidates);
    const top = ranked[0];
    if (!top) continue;

    const res = await pool.query(
      `INSERT INTO ai_actions
         (user_id, action_type, title, description, priority, related_entity_type, related_entity_id,
          supplier_id, status, suggested_by, reason_json, risk_level, requires_approval)
       VALUES ($1,'supply_chain_intervention',$2,$3,$4,'business_signal',$5,$6,'pending','inventory_agent',$7,$8,true)
       RETURNING *`,
      [
        userId,
        top.label,
        `Ranked ${ranked.length} option(s) for ${component.component.name}. Top choice: benefit-to-cost ratio ${top.benefitToCostRatio}. Revenue exposure avoided: ₹${(top.avoidedRevenueExposure || 0).toLocaleString('en-IN')}. Estimated cost: ₹${(top.cost || 0).toLocaleString('en-IN')}.`,
        component.stockout.daysUntilStockout <= 14 ? 'urgent' : 'high',
        signalId,
        impact.supplier.id,
        JSON.stringify({ signalId, componentId: component.component.id, rankedOptions: ranked }),
        component.stockout.daysUntilStockout <= 14 ? 'high' : 'medium',
      ]
    );
    created.push(res.rows[0]);
  }
  return created;
}

module.exports = { getSignalImpact, writeDoNothingForecast, createRecommendedActions, EVIDENCE_KIND, confidenceLabel };
