// FILE: lib/domain/decisions/detectors/process.js
// Process intelligence for order-to-cash: reconstructs each invoice as a case
// (issued -> due -> paid) from the as-of snapshot and measures the collection
// cycle (days from invoice to payment). When the recent cycle is materially
// slower than the prior one, a process decision exists: the cost is working
// capital tied up, not a single customer's balance.
//
// Pure: works on snapshot.deriveReceivablesState output.

const { median } = require('../behavior');
const { mulberry32, uniform, quantile, seedFrom } = require('../rng');
const { DAY_MS, toIsoDate, addDays } = require('../dates');
const { ENGINE_VERSION, DEFINITIONS_VERSION } = require('../definitions');
const { fmtMoney } = require('./receivables');

const PROCESS_MODEL_VERSION = 'o2c-cycle@1';

function reconstructCases(state) {
  const cases = [];
  for (const inv of state.invoices) {
    const events = [{ type: 'ISSUED', day: inv.invoiceDay }];
    if (inv.dueDay != null) events.push({ type: 'DUE', day: inv.dueDay });
    if (inv.paidDay != null) events.push({ type: 'PAID', day: inv.paidDay });
    events.sort((a, b) => a.day - b.day);
    const path = events.map((e) => e.type).join('>');
    cases.push({
      id: inv.id,
      customerKey: inv.customerKey,
      currency: inv.currency,
      amount: inv.amount,
      path,
      cycleDays: inv.paidDay != null ? Math.round((inv.paidDay - inv.invoiceDay) / DAY_MS) : null,
      waitingAfterDue: inv.paidDay != null && inv.dueDay != null ? Math.round((inv.paidDay - inv.dueDay) / DAY_MS) : null,
      paidDay: inv.paidDay,
      open: inv.outstanding > 0,
    });
  }
  return cases;
}

function processSummary(state, defs) {
  const cases = reconstructCases(state);
  const recentFrom = state.asOfDay - defs.cycle_recent_days * DAY_MS;
  const priorFrom = recentFrom - defs.cycle_prior_days * DAY_MS;
  const byCurrency = {};
  for (const c of cases) {
    const b = byCurrency[c.currency] || (byCurrency[c.currency] = { recent: [], prior: [], variants: {}, billed90: 0, openCount: 0 });
    b.variants[c.path] = (b.variants[c.path] || 0) + 1;
    if (c.open) b.openCount++;
    if (c.cycleDays != null && c.paidDay > recentFrom) b.recent.push(c);
    else if (c.cycleDays != null && c.paidDay > priorFrom && c.paidDay <= recentFrom) b.prior.push(c);
  }
  for (const inv of state.invoices) {
    if (inv.invoiceDay > state.asOfDay - 90 * DAY_MS) byCurrency[inv.currency].billed90 += inv.amount;
  }
  const out = {};
  for (const [currency, b] of Object.entries(byCurrency)) {
    const recentCycle = median(b.recent.map((c) => c.cycleDays));
    const priorCycle = median(b.prior.map((c) => c.cycleDays));
    const recentWait = median(b.recent.map((c) => c.waitingAfterDue).filter((v) => v != null));
    const priorWait = median(b.prior.map((c) => c.waitingAfterDue).filter((v) => v != null));
    out[currency] = {
      recent: { n: b.recent.length, medianCycleDays: recentCycle, medianDaysPastDue: recentWait },
      prior: { n: b.prior.length, medianCycleDays: priorCycle, medianDaysPastDue: priorWait },
      variants: Object.entries(b.variants).map(([path, count]) => ({ path, count })).sort((x, y) => y.count - x.count),
      dailyCreditSales: b.billed90 / 90,
      openCases: b.openCount,
      recentCases: b.recent,
    };
  }
  return { version: PROCESS_MODEL_VERSION, byCurrency: out };
}

function discoverProcessDecisions(state, defs) {
  const summary = processSummary(state, defs);
  const drafts = [];
  const watched = [];
  for (const [currency, s] of Object.entries(summary.byCurrency)) {
    if (s.recent.n < defs.cycle_min_samples || s.prior.n < defs.cycle_min_samples) {
      watched.push({ process: 'order_to_cash', currency, reason: `Not enough paid invoices to measure a trend (${s.recent.n} recent, ${s.prior.n} prior; need ${defs.cycle_min_samples} each)` });
      continue;
    }
    const delta = s.recent.medianCycleDays - s.prior.medianCycleDays;
    const ratio = s.prior.medianCycleDays > 0 ? delta / s.prior.medianCycleDays : 0;
    if (delta < defs.cycle_worsen_days || ratio < defs.cycle_worsen_ratio) {
      watched.push({ process: 'order_to_cash', currency, reason: `Collection cycle ${Math.round(s.prior.medianCycleDays)} -> ${Math.round(s.recent.medianCycleDays)} days; within tolerance` });
      continue;
    }
    const tiedUp = s.dailyCreditSales * delta;
    const threshold = Math.max(defs.material_amount_min, 0);
    if (tiedUp < threshold) {
      watched.push({ process: 'order_to_cash', currency, reason: `Cycle slowed by ${Math.round(delta)} days but ties up only ${fmtMoney(tiedUp, currency)}` });
      continue;
    }

    // Which customers drive the slowdown (share of recent cases paid later than the prior median).
    const slowCustomers = new Map();
    for (const c of s.recentCases) if (c.cycleDays > s.prior.medianCycleDays) slowCustomers.set(c.customerKey, (slowCustomers.get(c.customerKey) || 0) + c.amount);
    const drivers = [...slowCustomers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([key, amount]) => {
      const name = state.customers.get(key)?.name || key;
      return { customerKey: key, name, amountPaidLate: Math.round(amount) };
    });

    // Option effects on the slowdown (fraction of the extra days removed) are
    // assumptions; simulate them as ranges.
    const rand = mulberry32(seedFrom(`process|${currency}|${state.asOfDay}`));
    const optionsSpec = [
      { key: 'do_nothing', label: 'Do nothing new', summary: 'Keep current terms and follow-up.', intent: { type: 'NONE' }, reversibility: 'HIGHLY_REVERSIBLE', recovered: [0, 0] },
      { key: 'reminder_cadence', label: 'Turn on a fixed reminder cadence', summary: 'Remind 3 days before due, on the due date, and 7 days after, for every customer.', intent: { type: 'CREATE_DUNNING_RULES', rules: [{ trigger_day: -3, tone: 'polite' }, { trigger_day: 0, tone: 'polite' }, { trigger_day: 7, tone: 'firm' }] }, reversibility: 'HIGHLY_REVERSIBLE', recovered: [0.15, 0.5], label2: 'Share of the extra days a reminder cadence removes (15% to 50%)' },
      { key: 'tighten_terms', label: 'Shorten terms for the slowest payers', summary: `Cut default payment terms by 15 days for ${drivers.length} customer(s) driving the slowdown.`, intent: { type: 'CHANGE_PAYMENT_TERMS', customers: drivers.map((d) => d.customerKey), deltaDays: -15 }, reversibility: 'MODERATELY_REVERSIBLE', recovered: [0.2, 0.7], label2: 'Share of the extra days shorter terms remove (20% to 70%)' },
    ];
    const N = defs.simulation_iterations;
    const results = optionsSpec.map((o) => ({ key: o.key, freed: new Float64Array(N) }));
    for (let it = 0; it < N; it++) {
      const volume = uniform(rand, 0.85, 1.15); // sales volume variation (assumption)
      optionsSpec.forEach((o, oi) => {
        const r = uniform(rand, o.recovered[0], o.recovered[1]);
        results[oi].freed[it] = tiedUp * volume * r;
      });
    }
    const optionViews = optionsSpec.map((o, oi) => {
      const sorted = Float64Array.from(results[oi].freed).sort();
      let sum = 0; for (const v of results[oi].freed) sum += v;
      return {
        key: o.key,
        label: o.label,
        summary: o.summary,
        intent: o.intent,
        isDoNothing: o.key === 'do_nothing',
        reversibility: o.reversibility,
        blastRadius: o.key === 'do_nothing'
          ? { customers: 0, moneyTouched: 0, currency, externalParties: 0, systemsTouched: [], summary: 'Nothing changes.' }
          : o.key === 'reminder_cadence'
            ? { customers: state.customers.size, moneyTouched: 0, currency, externalParties: state.customers.size, systemsTouched: ['dunning_rules'], summary: 'Every customer receives scheduled reminders once external sending is on.' }
            : { customers: drivers.length, moneyTouched: 0, currency, externalParties: drivers.length, systemsTouched: ['customers.default_payment_terms'], summary: `${drivers.length} customer(s) get shorter terms on new invoices.` },
        approval: o.key === 'do_nothing' ? { required: false, approvers: 0, reason: 'No action is taken.' } : { required: true, approvers: 1, role: 'owner', reason: 'Owner approval required: changes how customers are treated.' },
        valid: true,
        executableAs: o.key === 'do_nothing' ? 'no action' : o.key === 'reminder_cadence' ? 'internal rules (dunning_rules); sends still gated by external-send policy' : 'internal change to default terms for new invoices',
        assumptions: o.label2 ? [{ key: `${o.key}.recovered_share`, label: o.label2, range: o.recovered, basis: 'ASSUMPTION' }] : [],
        futures: {
          workingCapitalFreed: { mean: Math.round(sum / N), p10: Math.round(quantile(sorted, 0.1)), p50: Math.round(quantile(sorted, 0.5)), p90: Math.round(quantile(sorted, 0.9)) },
          value: { mean: Math.round(sum / N), p10: Math.round(quantile(sorted, 0.1)), p50: Math.round(quantile(sorted, 0.5)), p90: Math.round(quantile(sorted, 0.9)) },
        },
      };
    });
    const recommended = optionViews.slice().sort((a, b) => b.futures.value.mean - a.futures.value.mean)[0];

    drafts.push({
      kind: 'PROCESS_DEGRADATION',
      dedupKey: `process:order_to_cash:${currency}`,
      title: `Collections now take ${Math.round(s.recent.medianCycleDays)} days instead of ${Math.round(s.prior.medianCycleDays)}. Change how we collect?`,
      description: `The slower cycle ties up about ${fmtMoney(tiedUp, currency)} of working capital at current credit sales.`,
      currency,
      affectedEntities: drivers.map((d) => ({ type: 'customer', key: d.customerKey, name: d.name })),
      affectedProcesses: ['order_to_cash'],
      triggerSignals: [{ code: 'CYCLE_TIME_DETERIORATION', label: `Median invoice-to-payment time rose from ${Math.round(s.prior.medianCycleDays)} to ${Math.round(s.recent.medianCycleDays)} days`, recent: s.recent, prior: s.prior }],
      whyNow: [`Median invoice-to-payment time rose from ${Math.round(s.prior.medianCycleDays)} to ${Math.round(s.recent.medianCycleDays)} days (${s.recent.n} recent vs ${s.prior.n} earlier payments).`],
      whatIfIgnored: `About ${fmtMoney(tiedUp, currency)} stays tied up in receivables for as long as the slower cycle lasts.`,
      window: { discoveredAt: new Date(state.asOf).toISOString(), usefulFrom: toIsoDate(state.asOfDay), latestSafeAt: toIsoDate(addDays(state.asOfDay, 30)), costOfDelayPerWeek: { delayDays: 7, valueLost: Math.round((recommended.futures.value.mean / 30) * 7) }, basis: 'No hard deadline. Each week of delay keeps the extra working capital tied up.', timezone: defs.timezone },
      objectives: [{ key: 'cash', label: 'Free working capital', weight: defs.objective_weights.cash }],
      constraints: [{ key: 'no_discount', type: 'POLICY', hard: true, label: 'No discounts or amount changes', status: 'RESPECTED' }],
      options: optionViews,
      doNothingKey: 'do_nothing',
      evidence: [
        { kind: 'CALCULATED_FACT', label: 'Recent collection cycle', detail: `Median ${Math.round(s.recent.medianCycleDays)} days over ${s.recent.n} invoices paid in the last ${defs.cycle_recent_days} days`, calculation: 'median(payment_date - invoice_date)' },
        { kind: 'CALCULATED_FACT', label: 'Earlier collection cycle', detail: `Median ${Math.round(s.prior.medianCycleDays)} days over ${s.prior.n} invoices paid in the ${defs.cycle_prior_days} days before that`, calculation: 'median(payment_date - invoice_date)' },
        { kind: 'CALCULATED_FACT', label: 'Working capital tied up', detail: `${fmtMoney(s.dailyCreditSales, currency)} credit sales per day x ${Math.round(delta)} extra days = ${fmtMoney(tiedUp, currency)}`, calculation: 'average daily credit sales (last 90 days) x increase in median cycle' },
        ...drivers.map((d) => ({ kind: 'OBSERVED_FACT', label: `Slow payer: ${d.name}`, detail: `${fmtMoney(d.amountPaidLate, currency)} paid slower than the earlier median`, source: { table: 'invoices', customer: d.name } })),
        { kind: 'CALCULATED_FACT', label: 'Process variants', detail: s.variants.slice(0, 4).map((v) => `${v.path} (${v.count})`).join(', '), calculation: `${PROCESS_MODEL_VERSION}: cases reconstructed from invoice, due and payment dates` },
      ],
      unknowns: [{ key: 'recovered_share', label: 'How much of the slowdown each change actually removes', status: 'UNKNOWN', valueOfInformation: null, acquisition: { type: 'LEARN_FROM_OUTCOMES', how: 'Measured when this decision is verified' } }],
      assumptions: [{ key: 'volume', label: 'Credit sales volume varies ±15% from the last 90 days', basis: 'ASSUMPTION' }, ...optionViews.flatMap((o) => o.assumptions)],
      contradictions: [],
      expectedValue: recommended.futures.value.mean,
      downsideRisk: recommended.futures.value.mean - recommended.futures.value.p10,
      upsidePotential: recommended.futures.value.p90 - recommended.futures.value.mean,
      reversibility: recommended.reversibility,
      blastRadius: recommended.blastRadius,
      urgency: 0.4,
      materiality: { workingCapitalTiedUp: Math.round(tiedUp), threshold: Math.round(threshold) },
      confidence: {
        score: Math.min(0.9, 0.5 + Math.min(s.recent.n, 30) / 60),
        band: s.recent.n >= 20 ? 'LIKELY' : 'POSSIBLE',
        components: [{ name: 'sample_size', value: s.recent.n, detail: `${s.recent.n} recent and ${s.prior.n} earlier paid invoices` }],
        meaning: 'Strength of evidence that the cycle really slowed. The effect of each option is an assumption.',
      },
      recommendation: {
        key: recommended.key,
        label: recommended.label,
        why: `${recommended.label} frees the most working capital in expectation (${fmtMoney(recommended.futures.value.mean, currency)}).`,
        whyNot: optionViews.filter((o) => o.key !== recommended.key).map((o) => ({ key: o.key, reason: `Frees ${fmtMoney(o.futures.value.mean, currency)} in expectation` })),
        wouldChangeIf: [{ assumption: 'recovered_share', label: 'If shorter terms remove less than about a third of the extra days, the reminder cadence is better', detail: 'Ranges overlap' }],
        informationFirst: null,
      },
      analysis: { process: { version: PROCESS_MODEL_VERSION, recent: s.recent, prior: s.prior, variants: s.variants, drivers }, simulation: { iterations: N } },
      modelVersions: { engine: ENGINE_VERSION, process: PROCESS_MODEL_VERSION, definitions: DEFINITIONS_VERSION },
    });
  }
  return { drafts, watched, summary };
}

module.exports = { discoverProcessDecisions, processSummary, reconstructCases, PROCESS_MODEL_VERSION };
