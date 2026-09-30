// FILE: lib/domain/decisions/backtest.js
// Walk-forward backtest of the receivables decision engine on the tenant's
// own history.
//
// For each past cutoff T:
//   1. Rebuild the ledger as it was known at T (replay mode: no payment dated
//      after T, no paid-without-date rows, no current customer settings) and
//      assert there is no future leakage.
//   2. Run the same detector the live product runs.
//   3. Only then look at what happened in (T, T+H] to score it.
//
// The evaluator is the only code that reads future data, and it never feeds
// anything back into step 2. Results are compared with a simple rule
// ("flag any customer with a material balance more than 60 days overdue") so
// the owner can see whether the engine is better than a rule of thumb.

const { deriveReceivablesState, assertNoFutureLeakage } = require('./snapshot');
const { discoverReceivableDecisions } = require('./detectors/receivables');
const { loadRawReceivables } = require('./discovery');
const { getSettings } = require('./controls');
const { AGENT } = require('./store');
const { median } = require('./behavior');
const { parseBusinessDate, toIsoDate, startOfUtcDay, DAY_MS } = require('./dates');

const MAX_CUTOFFS = 12;

function round(n, d = 3) { const f = 10 ** d; return Math.round(n * f) / f; }
function ratio(a, b) { return b ? round(a / b) : null; }

function defaultCutoffs(raw, horizonDays, nowMs, stepDays = 14) {
  const days = (raw.invoices || []).map((i) => parseBusinessDate(i.invoice_date)).filter((d) => d != null);
  if (!days.length) return [];
  const first = Math.min(...days) + 90 * DAY_MS; // need some history before the first cutoff
  const last = startOfUtcDay(nowMs) - horizonDays * DAY_MS;
  if (last < first) return [];
  const out = [];
  for (let t = last; t >= first && out.length < MAX_CUTOFFS; t -= stepDays * DAY_MS) out.push(t);
  return out.reverse();
}

// Ground truth for one customer at T: the overdue, undisputed invoices at T,
// and how much of them was still unpaid at T+H. Invoices whose payment date
// is unknown cannot be scored and are excluded.
function groundTruth(stateT, evalByInvoiceId, customerKey, currency) {
  const set = stateT.invoices.filter((i) => i.customerKey === customerKey && i.currency === currency && i.outstanding > 0 && i.ageDays != null && i.ageDays > 0 && !i.disputeOpen);
  let exposure = 0;
  let unpaidLater = 0;
  let excluded = 0;
  let oldestDue = null;
  for (const inv of set) {
    const later = evalByInvoiceId.get(inv.id);
    if (!later || later.paidDateUnknown) { excluded++; continue; }
    exposure += inv.outstanding;
    unpaidLater += Math.min(inv.outstanding, later.outstanding);
    if (inv.dueDay != null && (oldestDue == null || inv.dueDay < oldestDue)) oldestDue = inv.dueDay;
  }
  return { exposure, unpaidLater, excluded, oldestDue, maxAge: set.reduce((m, i) => Math.max(m, i.ageDays), 0) };
}

async function runBacktest(pool, userId, { cutoffs: requested, horizonDays = 60, nowMs = Date.now() } = {}) {
  const H = Math.max(30, Math.min(180, Number(horizonDays) || 60));
  const settings = await getSettings(pool, userId);
  // Fewer simulated futures than live: the backtest scores detection and the
  // do-nothing interval, which are stable at this size.
  const defs = { ...settings.definitions, simulation_iterations: 600 };
  const raw = await loadRawReceivables(pool, userId);

  let cutoffs;
  if (Array.isArray(requested) && requested.length) {
    cutoffs = requested.slice(0, MAX_CUTOFFS).map((c) => parseBusinessDate(c)).filter((c) => c != null && c + H * DAY_MS <= nowMs).sort((a, b) => a - b);
  } else {
    cutoffs = defaultCutoffs(raw, H, nowMs);
  }
  if (!cutoffs.length) {
    return { status: 'INSUFFICIENT_HISTORY', detail: `Need at least 90 days of invoices before a cutoff and ${H} days after it to score anything.`, cutoffs: [], scorecard: null };
  }

  const rows = [];
  const intervals = [];
  const firstWarning = new Map();
  let leakageChecks = 0;
  let excludedInvoices = 0;

  for (const T of cutoffs) {
    const stateT = deriveReceivablesState(raw, T, { mode: 'replay', baseCurrency: defs.base_currency });
    assertNoFutureLeakage(stateT);
    leakageChecks++;
    const { drafts } = discoverReceivableDecisions(stateT, defs, { fullAnalysis: false, externalSendEnabled: false });
    const flagged = new Map(drafts.map((d) => [d.dedupKey, d]));

    // ---- evaluator: the only place future data is read ----
    const evalState = deriveReceivablesState(raw, T + H * DAY_MS, { mode: 'live', baseCurrency: defs.base_currency });
    const evalById = new Map(evalState.invoices.map((i) => [i.id, i]));
    const eval60 = H === 60 ? evalById : new Map(deriveReceivablesState(raw, T + 60 * DAY_MS, { mode: 'live', baseCurrency: defs.base_currency }).invoices.map((i) => [i.id, i]));

    const keys = new Set();
    for (const inv of stateT.invoices) if (inv.outstanding > 0 && inv.ageDays > 0) keys.add(`${inv.customerKey}|${inv.currency}`);
    for (const k of keys) {
      const [customerKey, currency] = k.split('|');
      const gt = groundTruth(stateT, evalById, customerKey, currency);
      excludedInvoices += gt.excluded;
      if (gt.exposure <= 0) continue;
      const event = gt.unpaidLater >= defs.material_amount_min;
      const draft = flagged.get(`receivables:${customerKey}:${currency}`);
      const ruleFlag = gt.exposure >= defs.material_amount_min && gt.maxAge > 60;
      rows.push({ cutoff: toIsoDate(T), customerKey, currency, exposure: round(gt.exposure, 2), unpaidAfterHorizon: round(gt.unpaidLater, 2), event, flagged: !!draft, ruleFlag });
      if (draft && event && gt.oldestDue != null && !firstWarning.has(k)) {
        const crosses = gt.oldestDue + defs.bad_debt_threshold_days * DAY_MS;
        firstWarning.set(k, Math.round((crosses - T) / DAY_MS));
      }
      if (draft) {
        const dn = draft.options.find((o) => o.isDoNothing);
        const ids = draft.affectedEntities.filter((e) => e.type === 'invoice').map((e) => e.id);
        let collected = 0;
        let scorable = true;
        for (const id of ids) {
          const before = stateT.invoices.find((i) => i.id === id);
          const after = eval60.get(id);
          if (!before || !after || after.paidDateUnknown) { scorable = false; break; }
          collected += Math.max(0, before.outstanding - after.outstanding);
        }
        if (scorable && dn?.futures?.cash60) {
          const f = dn.futures.cash60;
          intervals.push({ cutoff: toIsoDate(T), customerKey, predictedP50: f.p50, p10: f.p10, p90: f.p90, actual: round(collected, 2), inside: collected >= f.p10 && collected <= f.p90 });
        }
      }
    }
  }

  const score = (flagKey) => {
    const tp = rows.filter((r) => r[flagKey] && r.event).length;
    const fp = rows.filter((r) => r[flagKey] && !r.event).length;
    const fn = rows.filter((r) => !r[flagKey] && r.event).length;
    return { flagged: tp + fp, materialEvents: tp + fn, detected: tp, missed: fn, falsePositives: fp, precision: ratio(tp, tp + fp), recall: ratio(tp, tp + fn) };
  };
  const engine = score('flagged');
  const rule = score('ruleFlag');
  const leads = [...firstWarning.values()];
  const errors = intervals.map((i) => i.actual - i.predictedP50);
  const scorecard = {
    engine: { ...engine, medianWarningDaysBeforeBadDebt: leads.length ? median(leads) : null },
    simpleRule: { ...rule, rule: `Flag a customer with at least ${defs.material_amount_min} overdue and any invoice more than 60 days past due` },
    doNothingForecast: {
      intervals: intervals.length,
      coverage: ratio(intervals.filter((i) => i.inside).length, intervals.length),
      nominalCoverage: 0.8,
      meanAbsoluteError: intervals.length ? round(errors.reduce((s, e) => s + Math.abs(e), 0) / errors.length, 2) : null,
      bias: intervals.length ? round(errors.reduce((s, e) => s + e, 0) / errors.length, 2) : null,
      biasNote: 'Positive bias means customers paid more than the do-nothing forecast expected.',
    },
    sampleWarning: engine.materialEvents < 10 ? `Only ${engine.materialEvents} material event(s) in this history. Treat precision and recall as indicative, not measured.` : null,
  };

  const result = {
    status: 'OK',
    method: {
      horizonDays: H,
      cutoffs: cutoffs.map(toIsoDate),
      materialEvent: `At least ${defs.material_amount_min} of a customer's overdue balance at the cutoff still unpaid ${H} days later`,
      leakageGuard: `Ledger rebuilt as known at each cutoff; ${leakageChecks} leakage assertions passed`,
      excludedInvoiceObservations: excludedInvoices,
      engineVersion: AGENT.version,
      definitions: settings.definitionsLabel,
    },
    scorecard,
    rows: rows.slice(0, 500),
    intervals: intervals.slice(0, 200),
  };

  await pool.query(
    `INSERT INTO agent_runs (user_id, agent_key, status, started_at, finished_at, input_json, output_json)
     VALUES ($1,$2,'completed',NOW(),NOW(),$3,$4)`,
    [userId, `${AGENT.key}.backtest`, JSON.stringify({ horizonDays: H, cutoffs: result.method.cutoffs }), JSON.stringify({ scorecard })]
  ).catch(() => {});
  return result;
}

module.exports = { runBacktest, defaultCutoffs };
