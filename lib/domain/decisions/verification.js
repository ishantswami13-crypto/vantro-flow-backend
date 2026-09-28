// FILE: lib/domain/decisions/verification.js
// Closes the loop on a Decision Contract: what actually happened after the
// decision, measured against what Starlane said would happen.
//
// Rules this file keeps:
//   - A prediction is resolved only after its horizon has elapsed, against
//     an observed value (forecastEngine.resolvePrediction does the error and
//     interval-coverage math; nothing here re-implements it).
//   - Only the world that actually happened is scored. In SHADOW mode nothing
//     was done, so reality is the do-nothing future and the chosen option's
//     forecast stays unobservable. In LIVE mode the opposite holds.
//   - Attribution is never claimed as causal. A live outcome is an observed
//     association; there is no control group for a single customer.
//   - Regret is reported ex ante (from the options' values at decision time).
//     Ex-post regret needs the counterfactual, which cannot be observed.

const { getDecision, appendEvent, agentActor, AGENT } = require('./store');
const { getSettings } = require('./controls');
const { deriveReceivablesState } = require('./snapshot');
const { loadRawReceivables } = require('./discovery');
const { reconstructCases } = require('./detectors/process');
const { median } = require('./behavior');
const { DAY_MS } = require('./dates');
const { resolvePrediction } = require('../intelligence/forecastEngine');
const { safeLog } = require('../../observability/logger');

const OPEN_CONTRACT = ['ACTIVE', 'ON_TRACK', 'OFF_TRACK'];
const FINAL_CONTRACT = ['MET', 'NOT_MET', 'ABORTED', 'UNKNOWN'];

function httpError(status, message, extra = {}) {
  return Object.assign(new Error(message), { status, ...extra });
}

function round2(n) { return Math.round(n * 100) / 100; }

// Which scenario's forecast describes the world that actually happened.
function realizedScenario(contract, decision) {
  const chosen = (decision.options || []).find((o) => o.key === contract.selected_option);
  if (contract.mode === 'LIVE' || chosen?.isDoNothing) return 'chosen';
  return 'do_nothing';
}

function outstandingAt(raw, ids, atMs, baseCurrency) {
  const state = deriveReceivablesState(raw, atMs, { mode: 'live', baseCurrency });
  let total = 0;
  const disputed = [];
  let paidDateUnknown = 0;
  for (const inv of state.invoices) {
    if (!ids.has(inv.id)) continue;
    total += inv.outstanding;
    if (inv.disputeOpen) disputed.push(inv.id);
    if (inv.paidDateUnknown) paidDateUnknown++;
  }
  return { total: round2(total), disputed, paidDateUnknown };
}

function exAnteRegret(contract) {
  const opts = (contract.rationale?.optionsAtDecisionTime || []).filter((o) => o.valid && o.value != null);
  const chosen = opts.find((o) => o.key === contract.selected_option);
  if (!chosen || !opts.length) return null;
  const best = opts.reduce((a, b) => (b.value > a.value ? b : a));
  return {
    exAnte: round2(Math.max(0, best.value - chosen.value)),
    bestAtDecisionTime: best.key,
    chosen: chosen.key,
    exPost: null,
    note: 'Ex-ante regret compares the chosen option with the best option using the values known when the decision was made. Ex-post regret would need the unchosen futures, which cannot be observed.',
  };
}

async function observeReceivables(pool, userId, decision, contract, defs, nowMs) {
  const raw = await loadRawReceivables(pool, userId);
  const ids = new Set((decision.affected_entities || []).filter((e) => e.type === 'invoice').map((e) => e.id));
  const activatedMs = new Date(contract.activated_at).getTime();
  const atStart = outstandingAt(raw, ids, activatedMs, defs.base_currency);
  const atNow = outstandingAt(raw, ids, nowMs, defs.base_currency);
  const horizons = {};
  for (const h of [30, 60, 90]) {
    const endMs = activatedMs + h * DAY_MS;
    if (endMs > nowMs) continue;
    const atEnd = outstandingAt(raw, ids, endMs, defs.base_currency);
    horizons[h] = round2(Math.max(0, atStart.total - atEnd.total));
  }
  return {
    metric: 'collected_amount',
    outstandingAtActivation: atStart.total,
    outstandingNow: atNow.total,
    collectedSoFar: round2(Math.max(0, atStart.total - atNow.total)),
    collectedByHorizon: horizons,
    newDisputes: atNow.disputed.filter((id) => !atStart.disputed.includes(id)),
    paidDateUnknown: atNow.paidDateUnknown,
    paidInFull: atNow.total <= 0.5,
  };
}

async function observeProcess(pool, userId, decision, contract, defs, nowMs) {
  const raw = await loadRawReceivables(pool, userId);
  const state = deriveReceivablesState(raw, nowMs, { mode: 'live', baseCurrency: defs.base_currency });
  const activatedMs = new Date(contract.activated_at).getTime();
  const horizons = {};
  const endMs = activatedMs + 60 * DAY_MS;
  const cycles = reconstructCases(state)
    .filter((c) => c.currency === decision.currency && c.paidDay != null && c.paidDay >= activatedMs && c.paidDay <= Math.min(endMs, nowMs))
    .map((c) => c.cycleDays);
  if (endMs <= nowMs && cycles.length >= defs.cycle_min_samples) horizons[60] = median(cycles);
  return { metric: 'median_cycle_days', paidSinceActivation: cycles.length, medianCycleSoFar: cycles.length ? median(cycles) : null, collectedByHorizon: horizons, minSamples: defs.cycle_min_samples };
}

async function observeSupply(pool, userId, decision, contract, nowMs) {
  const componentId = (decision.affected_entities || []).find((e) => e.type === 'product')?.id;
  if (!componentId) return { metric: 'stockout_occurred', observable: false };
  const r = await pool.query('SELECT current_stock FROM products WHERE id::text = $1 AND user_id = $2', [String(componentId), userId]);
  const stock = r.rows[0] ? Number(r.rows[0].current_stock) : null;
  const prior = contract.verification?.observation?.stockoutSeen === true;
  const stockoutSeen = prior || (stock != null && stock <= 0);
  const horizons = {};
  if (new Date(contract.activated_at).getTime() + 45 * DAY_MS <= nowMs) horizons[45] = stockoutSeen ? 1 : 0;
  return {
    metric: 'stockout_occurred',
    currentStock: stock,
    stockoutSeen,
    collectedByHorizon: horizons,
    samplingNote: 'Stock is sampled at each check. A stockout that started and ended between checks would be missed, so "no stockout" is only as good as the check frequency.',
  };
}

/**
 * Checks one contract against reality. Safe to call repeatedly: resolved
 * predictions are not touched again, and final contracts are returned as is.
 */
async function verifyContract(pool, userId, decisionId, { nowMs = Date.now(), correlationId = null, onBehalfOf = null } = {}) {
  const decision = await getDecision(pool, userId, decisionId);
  if (!decision) throw httpError(404, 'Decision not found');
  const cRes = await pool.query(
    `SELECT * FROM decision_contracts WHERE decision_id = $1 AND user_id = $2 AND status = ANY($3) ORDER BY created_at DESC LIMIT 1`,
    [decisionId, userId, [...OPEN_CONTRACT, ...FINAL_CONTRACT]]
  );
  const contract = cRes.rows[0];
  if (!contract) throw httpError(409, 'This decision has no active contract yet. Select, approve and run an option first.');
  if (FINAL_CONTRACT.includes(contract.status)) return { contract, final: true, alreadyFinal: true };
  if (!contract.activated_at) throw httpError(409, 'The contract has not been activated.');

  const settings = await getSettings(pool, userId);
  const defs = settings.definitions;
  const scenario = realizedScenario(contract, decision);
  const daysSince = Math.floor((nowMs - new Date(contract.activated_at).getTime()) / DAY_MS);

  let observation;
  if (decision.kind === 'RECEIVABLE_RISK') observation = await observeReceivables(pool, userId, decision, contract, defs, nowMs);
  else if (decision.kind === 'PROCESS_DEGRADATION') observation = await observeProcess(pool, userId, decision, contract, defs, nowMs);
  else observation = await observeSupply(pool, userId, decision, contract, nowMs);

  // Resolve every prediction for the realized scenario whose horizon elapsed.
  const preds = await pool.query(
    `SELECT id, target, horizon_days, point_estimate, lower_bound, upper_bound, evaluation_status, actual_value, coverage_hit
     FROM predictions WHERE user_id = $1 AND entity_type = 'decision_contract' AND entity_id = $2 ORDER BY horizon_days, target`,
    [userId, contract.id]
  );
  const resolvedNow = [];
  for (const p of preds.rows) {
    const [metric, scen] = String(p.target).split(':');
    if (p.evaluation_status === 'RESOLVED') continue;
    if (scen !== scenario) {
      if (p.evaluation_status !== 'COUNTERFACTUAL') {
        await pool.query(`UPDATE predictions SET evaluation_status = 'COUNTERFACTUAL' WHERE id = $1 AND user_id = $2`, [p.id, userId]);
      }
      continue;
    }
    if (metric !== observation.metric) continue;
    const actual = observation.collectedByHorizon?.[p.horizon_days];
    if (actual == null) continue;
    const r = await resolvePrediction(p.id, actual);
    resolvedNow.push({ target: p.target, horizonDays: p.horizon_days, predicted: r.predicted, actual, coverageHit: r.coverageHit, absError: round2(r.absError) });
  }
  const allPreds = await pool.query(
    `SELECT target, horizon_days, point_estimate, lower_bound, upper_bound, evaluation_status, actual_value, coverage_hit, absolute_error
     FROM predictions WHERE user_id = $1 AND entity_type = 'decision_contract' AND entity_id = $2 ORDER BY horizon_days, target`,
    [userId, contract.id]
  );

  // Contract status.
  let status = contract.status;
  let reason = null;
  const successCrit = (contract.success_criteria || [])[0];
  const realizedIsChosen = scenario === 'chosen';
  if (observation.newDisputes?.length) {
    status = 'ABORTED';
    reason = `${observation.newDisputes.length} invoice(s) were disputed after the decision; collection on them stops.`;
  } else if (observation.paidInFull && realizedIsChosen) {
    status = 'MET';
    reason = 'Every invoice in this decision has been paid.';
  } else if (successCrit && observation.collectedByHorizon?.[successCrit.horizonDays] != null) {
    const actual = observation.collectedByHorizon[successCrit.horizonDays];
    if (!realizedIsChosen) {
      status = 'UNKNOWN';
      reason = 'Shadow mode: the option was never carried out, so whether it would have met its target cannot be observed. The do-nothing forecast was scored instead.';
    } else {
      const ok = successCrit.operator === '>=' ? actual >= successCrit.value : successCrit.operator === '<=' ? actual <= successCrit.value : actual === successCrit.value;
      status = ok ? 'MET' : 'NOT_MET';
      reason = `${successCrit.label}: observed ${actual}.`;
    }
  } else if (observation.paidInFull && !realizedIsChosen) {
    status = 'UNKNOWN';
    reason = 'Shadow mode: the customer paid in full without any action.';
  } else {
    // Interim: compare with the earliest elapsed horizon, if any.
    const elapsed = allPreds.rows.filter((p) => p.target.endsWith(`:${scenario}`) && p.evaluation_status === 'RESOLVED');
    const latest = elapsed[elapsed.length - 1];
    if (latest) {
      status = Number(latest.actual_value) >= Number(latest.lower_bound ?? -Infinity) ? 'ON_TRACK' : 'OFF_TRACK';
      reason = `At ${latest.horizon_days} days: observed ${Number(latest.actual_value)} against an expected range of ${Number(latest.lower_bound)} to ${Number(latest.upper_bound)}.`;
    } else {
      status = 'ACTIVE';
      reason = `Day ${daysSince} of the contract. The first check against a forecast is at day ${decision.kind === 'SUPPLY_STOCKOUT' ? 45 : decision.kind === 'PROCESS_DEGRADATION' ? 60 : 30}.`;
    }
  }
  const final = FINAL_CONTRACT.includes(status);
  const attribution = contract.mode === 'LIVE'
    ? 'OBSERVED_ASSOCIATION'
    : 'SHADOW_NO_ACTION_TAKEN';
  const regret = exAnteRegret(contract);
  const verification = {
    checkedAt: new Date(nowMs).toISOString(),
    daysSinceActivation: daysSince,
    mode: contract.mode,
    realizedScenario: scenario,
    observation,
    resolvedNow,
    predictions: allPreds.rows.map((p) => ({
      target: p.target, horizonDays: p.horizon_days, expected: p.point_estimate == null ? null : Number(p.point_estimate),
      range: p.lower_bound == null ? null : [Number(p.lower_bound), Number(p.upper_bound)],
      status: p.evaluation_status, actual: p.actual_value == null ? null : Number(p.actual_value), insideRange: p.coverage_hit,
    })),
    status,
    reason,
    attributionNote: contract.mode === 'LIVE'
      ? 'This outcome followed the action. It is an association, not proof the action caused it: the customer might have paid anyway.'
      : 'Nothing was executed (shadow mode). This outcome shows what happened without acting and is used to score the do-nothing forecast.',
  };

  await pool.query(
    `UPDATE decision_contracts SET status = $3, verification = $4, regret = $5, attribution = $6, last_checked_at = to_timestamp($7/1000.0),
            verified_at = CASE WHEN $8 THEN to_timestamp($7/1000.0) ELSE verified_at END, updated_at = NOW()
     WHERE id = $1 AND user_id = $2`,
    [contract.id, userId, status, JSON.stringify(verification), JSON.stringify(regret), attribution, nowMs, final]
  );
  if (final) {
    await pool.query(`UPDATE decisions SET status = 'VERIFIED', resolved_at = NOW(), resolution_reason = $3, updated_at = NOW() WHERE id = $1 AND user_id = $2`, [decisionId, userId, reason]);
    await writeMemory(pool, userId, decision, contract, verification);
  }
  await appendEvent(pool, {
    userId, decisionId, type: final ? 'VERIFIED' : 'CONTRACT_CHECKED', actor: agentActor(onBehalfOf), correlationId,
    payload: { contractId: contract.id, status, reason, realizedScenario: scenario, resolved: resolvedNow.length, attribution },
  });
  safeLog('info', '[decisions] contract checked', { userId, decisionId, status, resolved: resolvedNow.length });
  return { contract: { ...contract, status, verification, regret, attribution }, final };
}

// Learning memory: a compact record per customer of what was decided and
// what happened, for the next decision about the same customer.
async function writeMemory(pool, userId, decision, contract, verification) {
  const customer = (decision.affected_entities || []).find((e) => e.type === 'customer');
  const entityType = customer?.id && /^[0-9a-f-]{36}$/i.test(customer.id) ? 'customer' : 'global';
  const entityId = entityType === 'customer' ? customer.id : null;
  const key = `decision_outcome:${decision.kind.toLowerCase()}${entityType === 'global' && customer ? `:${customer.key}` : ''}`;
  const value = {
    decisionId: decision.id,
    option: contract.selected_option,
    mode: contract.mode,
    status: verification.status,
    realizedScenario: verification.realizedScenario,
    observation: verification.observation?.collectedByHorizon || null,
    recordedAt: verification.checkedAt,
    agent: AGENT.key,
  };
  try {
    if (entityId) {
      await pool.query(
        `INSERT INTO business_memory (user_id, entity_type, entity_id, memory_key, memory_value, confidence, source)
         VALUES ($1,$2,$3,$4,$5,$6,'decision_verification')
         ON CONFLICT (user_id, entity_type, entity_id, memory_key) DO UPDATE SET memory_value = EXCLUDED.memory_value, confidence = EXCLUDED.confidence, updated_at = NOW()`,
        [userId, entityType, entityId, key, JSON.stringify(value), contract.mode === 'LIVE' ? 0.6 : 0.4]
      );
    } else {
      // NULL entity_id never conflicts in a unique index; replace explicitly.
      await pool.query('DELETE FROM business_memory WHERE user_id = $1 AND entity_type = $2 AND entity_id IS NULL AND memory_key = $3', [userId, entityType, key]);
      await pool.query(
        `INSERT INTO business_memory (user_id, entity_type, entity_id, memory_key, memory_value, confidence, source) VALUES ($1,$2,NULL,$3,$4,$5,'decision_verification')`,
        [userId, entityType, key, JSON.stringify(value), contract.mode === 'LIVE' ? 0.6 : 0.4]
      );
    }
  } catch (err) {
    safeLog('warn', '[decisions] memory write failed', { userId, error: err.message });
  }
}

/** Verifies every open contract for a tenant (used by the scheduled check). */
async function verifyDueContracts(pool, userId, opts = {}) {
  const res = await pool.query(`SELECT decision_id FROM decision_contracts WHERE user_id = $1 AND status = ANY($2)`, [userId, OPEN_CONTRACT]);
  const out = [];
  for (const r of res.rows) {
    try {
      const v = await verifyContract(pool, userId, r.decision_id, opts);
      out.push({ decisionId: r.decision_id, status: v.contract.status });
    } catch (err) {
      out.push({ decisionId: r.decision_id, error: err.message });
    }
  }
  return out;
}

/**
 * Track record: what Starlane's decisions have produced, in the units the
 * owner cares about, with the evidence behind each number. Also suggests an
 * autonomy level per action class from verified live outcomes. The
 * suggestion is advisory: autonomy is only ever changed by the owner, and
 * never above the tenant's ceiling.
 */
async function trackRecord(pool, userId) {
  const [contracts, settings] = await Promise.all([
    pool.query(
      `SELECT c.id, c.decision_id, c.selected_option, c.mode, c.status, c.rationale, c.verification, c.regret, c.allowed_actions, c.activated_at, d.kind, d.title, d.currency
       FROM decision_contracts c JOIN decisions d ON d.id = c.decision_id AND d.user_id = c.user_id
       WHERE c.user_id = $1 AND c.status NOT IN ('DRAFT','SUPERSEDED') ORDER BY c.activated_at DESC NULLS LAST LIMIT 500`,
      [userId]
    ),
    getSettings(pool, userId),
  ]);
  const rows = contracts.rows;
  const byStatus = {};
  for (const r of rows) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  const followed = rows.filter((r) => r.rationale?.followsRecommendation === true).length;

  // Value ledger: only LIVE, verified receivable contracts, where both the
  // observed collection and the do-nothing forecast exist for the same
  // horizon. Reported as an estimate, never as proven value.
  const ledger = [];
  for (const r of rows) {
    if (r.mode !== 'LIVE' || r.kind !== 'RECEIVABLE_RISK' || !r.verification) continue;
    const preds = r.verification.predictions || [];
    for (const h of [60, 30]) {
      const actual = preds.find((p) => p.target === 'collected_amount:chosen' && p.horizonDays === h && p.actual != null);
      const counter = preds.find((p) => p.target === 'collected_amount:do_nothing' && p.horizonDays === h);
      if (actual && counter) {
        ledger.push({ decisionId: r.decision_id, title: r.title, currency: r.currency, horizonDays: h, collected: actual.actual, doNothingExpected: counter.expected, estimatedUplift: round2(actual.actual - counter.expected), evidenceClass: 'ESTIMATED_AGAINST_MODELLED_COUNTERFACTUAL' });
        break;
      }
    }
  }
  const upliftByCurrency = {};
  for (const l of ledger) upliftByCurrency[l.currency] = round2((upliftByCurrency[l.currency] || 0) + l.estimatedUplift);

  const perAction = {};
  for (const r of rows) {
    if (r.mode !== 'LIVE' || !['MET', 'NOT_MET'].includes(r.status)) continue;
    for (const a of r.allowed_actions || []) {
      const s = perAction[a] || (perAction[a] = { met: 0, notMet: 0 });
      if (r.status === 'MET') s.met++; else s.notMet++;
    }
  }
  const ceilingRank = { L0: 0, L1: 1, L2: 2, L3: 3, L4: 4 };
  const autonomy = Object.entries(perAction).map(([action, s]) => {
    const n = s.met + s.notMet;
    const rate = n ? s.met / n : 0;
    let level = 'L1';
    if (n >= 10 && rate >= 0.8) level = 'L3';
    else if (n >= 5 && rate >= 0.6) level = 'L2';
    if (action === 'CONTACT_CUSTOMER' && ceilingRank[level] > 2) level = 'L2';
    if (ceilingRank[level] > (ceilingRank[settings.autonomyCeiling] ?? 2)) level = settings.autonomyCeiling;
    return { action, verifiedLive: n, met: s.met, successRate: n ? Math.round(rate * 1000) / 1000 : null, suggestedLevel: level, basis: n < 5 ? 'Too few verified live outcomes; stays at recommend-and-approve' : `${s.met} of ${n} verified live outcomes met their target` };
  });

  return {
    contracts: rows.length,
    byStatus,
    followedRecommendation: rows.length ? { count: followed, share: Math.round((followed / rows.length) * 1000) / 1000 } : null,
    valueLedger: { entries: ledger.slice(0, 50), estimatedUpliftByCurrency: upliftByCurrency, note: 'Uplift = collected after a live decision minus what the do-nothing forecast expected for the same invoices and horizon. It is an estimate against a model, not proven causal value.' },
    autonomy: { ceiling: settings.autonomyCeiling, perAction: autonomy, note: 'Suggestions only. Starlane never raises its own autonomy.' },
    recent: rows.slice(0, 20).map((r) => ({ decisionId: r.decision_id, title: r.title, option: r.selected_option, mode: r.mode, status: r.status, activatedAt: r.activated_at, reason: r.verification?.reason || null, regret: r.regret })),
  };
}

module.exports = { verifyContract, verifyDueContracts, trackRecord, realizedScenario, exAnteRegret, OPEN_CONTRACT, FINAL_CONTRACT };
