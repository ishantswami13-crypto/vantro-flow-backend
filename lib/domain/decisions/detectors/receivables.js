// FILE: lib/domain/decisions/detectors/receivables.js
// Decision discovery for receivables: "a decision now exists about this
// customer's overdue balance".
//
// A decision is created only when BOTH hold:
//   1. it is material: the simulated do-nothing path leaves at least
//      max(material_amount_min, material_share_min x open receivables)
//      uncollected after 90 days; and
//   2. something about it changed or crossed a line (an aging bucket was
//      crossed in the last 14 days, payment delay deteriorated, a promise was
//      broken, the customer holds a concentrated share, or credit is still
//      being extended while balances are overdue).
// Otherwise the customer is "watched", not surfaced. Disputed invoices are
// never simulated as collectable (Dispute Safety Layer).
//
// Pure: input is a snapshot + behaviour model + live context; output is a
// list of decision drafts with their full analysis attached.

const { buildBehaviorModel, probPaidWithin } = require('../behavior');
const { simulateOptions, toLots } = require('../simulate');
const { recommend, robustness, costOfDelay, stressTest, sensitivity, valueOfInformation } = require('../analysis');
const { seedFrom } = require('../rng');
const { toIsoDate, addDays, DAY_MS } = require('../dates');
const { ENGINE_VERSION, DEFINITIONS_VERSION } = require('../definitions');
const { MODEL_VERSION } = require('../behavior');

const AGING_BUCKETS = [30, 60, 90];

function fmtMoney(amount, currency) {
  const n = Math.round(Number(amount) || 0);
  if (currency === 'INR') {
    if (Math.abs(n) >= 10000000) return `₹${(n / 10000000).toFixed(2)} Cr`;
    if (Math.abs(n) >= 100000) return `₹${(n / 100000).toFixed(2)}L`;
    return `₹${n.toLocaleString('en-IN')}`;
  }
  return `${currency} ${n.toLocaleString('en-US')}`;
}

function pct(x) {
  return `${Math.round(x * 100)}%`;
}

function buildOptions({ customer, newCredit, marginKnown, keepRate, liveContext }) {
  const options = [
    {
      key: 'do_nothing',
      kind: 'baseline',
      label: 'Do nothing new',
      summary: 'Keep the current follow-up routine. Nothing is sent or changed.',
      intent: { type: 'NONE' },
      reversibility: 'HIGHLY_REVERSIBLE',
      params: [],
    },
    {
      key: 'escalate_contact',
      kind: 'hazard_multiplier',
      label: 'Escalate: firm reminder and an owner call',
      summary: 'Send a firm payment reminder and have the owner call the customer this week.',
      intent: { type: 'CONTACT_CUSTOMER', tone: 'firm', channel: liveContext.externalSendEnabled ? 'whatsapp' : 'prepared_draft' },
      reversibility: 'IRREVERSIBLE',
      params: [
        { name: 'hazard_multiplier', lo: 1.05, hi: 1.6, basis: 'ASSUMPTION', label: 'How much an escalation raises the weekly chance of payment (1.05x to 1.6x)' },
      ],
    },
    {
      key: 'payment_plan',
      kind: 'payment_plan',
      label: 'Offer a three-part payment plan',
      summary: 'Offer to split the overdue balance into three instalments over twelve weeks. No discount (discounts are not allowed for AI proposals).',
      intent: { type: 'OFFER_PAYMENT_PLAN', installments: 3, intervalDays: 28 },
      reversibility: 'MODERATELY_REVERSIBLE',
      params: [
        { name: 'acceptance', lo: 0.3, hi: 0.7, basis: 'ASSUMPTION', label: 'Chance the customer accepts a plan (30% to 70%)' },
        keepRate
          ? { name: 'keep_rate', lo: keepRate.lo, hi: keepRate.hi, basis: 'OBSERVED_RANGE', label: `Chance each instalment is paid (from ${keepRate.n} recorded promises)` }
          : { name: 'keep_rate', lo: 0.4, hi: 0.8, basis: 'ASSUMPTION', label: 'Chance each instalment is paid (40% to 80%, no promise history)' },
      ],
    },
  ];
  if (newCredit.next60 > 0) {
    const params = [
      { name: 'hazard_multiplier', lo: 1.0, hi: 1.3, basis: 'ASSUMPTION', label: 'Leverage from holding credit on existing dues (1.0x to 1.3x)' },
      { name: 'churn', lo: 0.1, hi: 0.4, basis: 'ASSUMPTION', lowIsWorse: false, label: 'Share of this customer\'s orders lost if advance payment is required (10% to 40%)' },
    ];
    if (marginKnown == null) params.push({ name: 'gross_margin', lo: 0.08, hi: 0.25, basis: 'ASSUMPTION', lowIsWorse: false, label: 'Gross margin on lost orders (8% to 25%, not defined for this business)' });
    options.push({
      key: 'credit_hold',
      kind: 'credit_hold',
      label: 'Hold credit until dues are cleared',
      summary: 'Require advance payment on new orders from this customer until the overdue balance is cleared.',
      intent: { type: 'HOLD_CREDIT', customerId: customer.customerId },
      reversibility: 'HIGHLY_REVERSIBLE',
      params,
    });
    options.push({
      key: 'escalate_and_hold',
      kind: 'credit_hold',
      label: 'Escalate and hold credit together',
      summary: 'Hold credit on new orders first, then send a firm reminder and call. Two steps; if the second fails the hold is reversed.',
      intent: { type: 'COMPOSITE', steps: [{ type: 'HOLD_CREDIT', customerId: customer.customerId }, { type: 'CONTACT_CUSTOMER', tone: 'firm', channel: liveContext.externalSendEnabled ? 'whatsapp' : 'prepared_draft' }] },
      reversibility: 'IRREVERSIBLE',
      params: [
        { name: 'escalation_multiplier', lo: 1.05, hi: 1.6, basis: 'ASSUMPTION', label: 'How much an escalation raises the weekly chance of payment (1.05x to 1.6x)' },
        ...params.map((prm) => ({ ...prm })),
      ],
    });
  }
  return options;
}

function blastRadius(option, { exposure, currency, customer }) {
  switch (option.intent.type) {
    case 'NONE':
      return { customers: 0, moneyTouched: 0, currency, externalParties: 0, systemsTouched: [], durationDays: 0, summary: 'Nothing changes.' };
    case 'CONTACT_CUSTOMER':
      return { customers: 1, moneyTouched: 0, currency, externalParties: 1, systemsTouched: ['ai_actions', 'messaging'], durationDays: 7, summary: `One message to ${customer.name} and one call. A sent message cannot be recalled.` };
    case 'OFFER_PAYMENT_PLAN':
      return { customers: 1, moneyTouched: exposure, currency, externalParties: 1, systemsTouched: ['payment_plans'], durationDays: 84, summary: `Reschedules ${fmtMoney(exposure, currency)} over 12 weeks once the customer agrees.` };
    case 'HOLD_CREDIT':
      return { customers: 1, moneyTouched: 0, currency, externalParties: 1, systemsTouched: ['customers.advance_required'], durationDays: null, summary: `${customer.name} must pay in advance for new orders until cleared. One switch reverses it.` };
    case 'COMPOSITE':
      return { customers: 1, moneyTouched: 0, currency, externalParties: 1, systemsTouched: ['customers.advance_required', 'ai_actions', 'messaging'], durationDays: 7, summary: `Credit hold on ${customer.name} plus one firm message and a call. The hold reverses with one switch; a sent message cannot be recalled.` };
    default:
      return { customers: 0, moneyTouched: 0, currency, externalParties: 0, systemsTouched: [], durationDays: 0 };
  }
}

function approvalPolicy(option, blast) {
  if (option.intent.type === 'NONE') return { required: false, approvers: 0, reason: 'No action is taken.' };
  const reasons = [];
  if (blast.externalParties > 0) reasons.push('affects an external party');
  if (option.reversibility === 'IRREVERSIBLE' || option.reversibility === 'DIFFICULT_TO_REVERSE') reasons.push('cannot be fully undone');
  if (blast.moneyTouched > 50000) reasons.push('touches more than ₹50,000');
  return { required: true, approvers: 1, role: 'owner', reason: reasons.length ? `Owner approval required: ${reasons.join(', ')}.` : 'Owner approval required for every Starlane action.' };
}

function confidenceFrom({ stability, paidSamples, freshness, contradictions, dueDateGapShare }) {
  const components = [];
  let dataFactor;
  if (paidSamples >= 8) { dataFactor = 1; components.push({ name: 'payment_history', value: 1, detail: `${paidSamples} paid invoices on record for this customer` }); }
  else if (paidSamples >= 3) { dataFactor = 0.85; components.push({ name: 'payment_history', value: 0.85, detail: `Only ${paidSamples} paid invoices on record; the business-wide pattern fills the gap` }); }
  else { dataFactor = 0.65; components.push({ name: 'payment_history', value: 0.65, detail: paidSamples ? `Only ${paidSamples} paid invoice(s) on record` : 'No paid invoices on record for this customer; the business-wide pattern and a prior are used' }); }
  const freshFactor = { FRESH: 1, AGING: 0.9, STALE: 0.7, UNKNOWN: 0.8 }[freshness.status] ?? 0.8;
  components.push({ name: 'freshness', value: freshFactor, detail: freshness.detail });
  const qualityFactor = dueDateGapShare > 0.2 ? 0.85 : 1;
  if (qualityFactor < 1) components.push({ name: 'data_completeness', value: qualityFactor, detail: `${pct(dueDateGapShare)} of this business's invoices have no usable due date` });
  components.push({ name: 'recommendation_stability', value: stability, detail: `The recommended option came out best in ${pct(stability)} of simulated futures` });
  const score = Math.round(stability * dataFactor * freshFactor * qualityFactor * 100) / 100;
  let band = score >= 0.8 ? 'KNOWN' : score >= 0.6 ? 'LIKELY' : score >= 0.4 ? 'POSSIBLE' : 'UNKNOWN';
  if (contradictions > 0) band = 'CONTRADICTED';
  return { score, band, components, meaning: 'Share of simulated futures in which the recommendation is best, discounted for thin, stale or conflicting data. Not a probability that the business outcome will happen.' };
}

/**
 * @param {object} state         snapshot.deriveReceivablesState output
 * @param {object} defs          effective definitions
 * @param {object} liveContext   { externalSendEnabled, freshness, contradictionsByInvoice: Map, reminderEvidence, fullAnalysis }
 */
function discoverReceivableDecisions(state, defs, liveContext = {}) {
  const model = buildBehaviorModel(state);
  const freshness = liveContext.freshness || { status: 'UNKNOWN', detail: 'Freshness not assessed' };
  const contradictionsByInvoice = liveContext.contradictionsByInvoice || new Map();
  const drafts = [];
  const watched = [];
  const DAY = DAY_MS;
  const dueDateGapShare = state.quality.invoicesInScope ? state.quality.unparseableDueDate / state.quality.invoicesInScope : 0;

  const only = liveContext.only || null; // what-if: re-simulate a single customer
  for (const customer of state.customers.values()) {
    if (only && customer.key !== only.customerKey) continue;
    const byCurrency = new Map();
    for (const inv of customer.invoices) {
      if (!byCurrency.has(inv.currency)) byCurrency.set(inv.currency, []);
      byCurrency.get(inv.currency).push(inv);
    }

    for (const [currency, invoices] of byCurrency) {
      if (only && only.currency && currency !== only.currency) continue;
      const open = invoices.filter((i) => i.outstanding > 0);
      const overdue = open.filter((i) => i.ageDays != null && i.ageDays > defs.overdue_after_days);
      if (!overdue.length) continue;
      const disputed = overdue.filter((i) => i.disputeOpen);
      const collectable = overdue.filter((i) => !i.disputeOpen);
      const totals = state.totalsByCurrency[currency] || { open: 0 };

      if (!collectable.length) {
        watched.push({ customer: customer.name, currency, reason: 'All overdue invoices are under dispute; collection is paused until the disputes are resolved.' });
        continue;
      }

      const beh = model.customers.get(customer.key);
      const { lots, grouped } = toLots(collectable);
      const exposure = collectable.reduce((s, i) => s + i.outstanding, 0);

      const recentBilled = invoices.filter((i) => i.invoiceDay > state.asOfDay - 90 * DAY).reduce((s, i) => s + i.amount, 0);
      const newCredit = { monthly: recentBilled / 3, next60: Math.round((recentBilled / 3) * 2) };
      const p = customer.promises;
      const resolvedPromises = p.kept + p.broken;
      const keepRate = resolvedPromises >= 3
        ? (() => { const r = p.kept / resolvedPromises; return { lo: Math.max(0.05, r - 0.1), hi: Math.min(0.95, r + 0.1), n: resolvedPromises, rate: r }; })()
        : null;

      // Quick materiality screen with the analytic do-nothing expectation
      // before paying for a full simulation.
      let expectedUncollected = 0;
      for (const inv of collectable) expectedUncollected += inv.outstanding * (1 - probPaidWithin(beh.daily, inv.ageDays, 90));
      const threshold = Math.max(defs.material_amount_min, defs.material_share_min * (totals.open || 0));
      const share = totals.open ? (open.reduce((s, i) => s + i.outstanding, 0) / totals.open) : 0;

      const triggers = [];
      for (const b of AGING_BUCKETS) {
        const crossed = collectable.filter((i) => i.ageDays >= b && i.ageDays < b + 14);
        if (crossed.length) triggers.push({ code: `AGING_CROSSED_${b}`, label: `${crossed.length} invoice(s) crossed ${b} days overdue in the last two weeks`, invoices: crossed.map((i) => i.id) });
      }
      const pastBadDebt = collectable.filter((i) => i.ageDays >= defs.bad_debt_threshold_days);
      if (pastBadDebt.length) triggers.push({ code: 'PAST_BAD_DEBT_THRESHOLD', label: `${pastBadDebt.length} invoice(s) are past ${defs.bad_debt_threshold_days} days overdue`, invoices: pastBadDebt.map((i) => i.id) });
      const t = beh.trend;
      if (t.recentN >= defs.trend_min_samples && t.priorN >= defs.trend_min_samples && t.recentMedian - t.priorMedian >= defs.deterioration_days) {
        triggers.push({ code: 'DELAY_DETERIORATION', label: `Median payment delay rose from ${Math.round(t.priorMedian)} to ${Math.round(t.recentMedian)} days past due`, recent: t.recentMedian, prior: t.priorMedian, recentN: t.recentN, priorN: t.priorN });
      }
      if (p.broken > 0) triggers.push({ code: 'BROKEN_PROMISES', label: `${p.broken} payment promise(s) broken`, broken: p.broken, made: p.made });
      if (share >= defs.concentration_share) triggers.push({ code: 'CONCENTRATION', label: `This customer holds ${pct(share)} of all open receivables`, share });
      const newWhileOverdue = invoices.filter((i) => i.invoiceDay > state.asOfDay - 30 * DAY && i.outstanding > 0 && !overdue.includes(i));
      if (newWhileOverdue.length) triggers.push({ code: 'CREDIT_STILL_EXTENDED', label: `${newWhileOverdue.length} new invoice(s) issued on credit in the last 30 days while older ones are overdue`, invoices: newWhileOverdue.map((i) => i.id) });

      const material = expectedUncollected >= threshold;
      if (!material || !triggers.length) {
        watched.push({
          customer: customer.name,
          currency,
          overdue: Math.round(exposure),
          expectedUncollected90: Math.round(expectedUncollected),
          threshold: Math.round(threshold),
          reason: !material ? 'Below the materiality threshold' : 'Material but nothing changed recently',
        });
        continue;
      }

      const seed = seedFrom(`${customer.key}|${currency}|${state.asOfDay}`);
      const marginKnown = defs.gross_margin_pct;
      const options = buildOptions({ customer, newCredit, marginKnown, keepRate, liveContext });
      const baseInput = {
        lots, daily: beh.daily, options, newCredit, margin: { known: marginKnown },
        weights: defs.objective_weights, iterations: defs.simulation_iterations, seed,
        ...(liveContext.whatIf ? { fixedParams: liveContext.whatIf.fixedParams || {}, fixedShock: liveContext.whatIf.fixedShock ?? null } : {}),
      };
      const sim = simulateOptions(baseInput);
      const rec = recommend(sim, options);
      const doNothing = sim.summary.find((s) => s.key === 'do_nothing');
      const tolerance = Math.max(0.02 * exposure, 1000);
      const robust = robustness(sim, tolerance);
      const full = liveContext.fullAnalysis !== false;
      const delay = full ? costOfDelay(baseInput, options, rec.key, 7) : null;
      const stress = full ? stressTest(baseInput, options) : null;
      const sens = full ? sensitivity(baseInput, options, rec.key) : null;
      const voi = valueOfInformation(sim, options, 5, Math.max(1000, 0.005 * exposure));

      // Decision window.
      const oldest = collectable.reduce((a, b) => (a.ageDays >= b.ageDays ? a : b));
      const daysToBadDebt = defs.bad_debt_threshold_days - oldest.ageDays;
      const latestSafeAt = daysToBadDebt > 0 ? addDays(state.asOfDay, daysToBadDebt) : state.asOfDay;
      const windowNote = daysToBadDebt > 0
        ? `The oldest invoice (${oldest.number || oldest.id.slice(0, 8)}) reaches ${defs.bad_debt_threshold_days} days overdue on ${toIsoDate(latestSafeAt)}, when recovery odds typically fall sharply.`
        : `The oldest invoice is already ${oldest.ageDays} days overdue, past the ${defs.bad_debt_threshold_days}-day bad-debt line. The window is closing now.`;

      const contradictions = [];
      for (const inv of invoices) {
        for (const c of contradictionsByInvoice.get(inv.id) || []) contradictions.push(c);
      }

      const confidence = confidenceFrom({
        stability: rec.stability,
        paidSamples: beh.paidSamples,
        freshness,
        contradictions: contradictions.length,
        dueDateGapShare,
      });

      const evidence = [];
      for (const inv of collectable.slice().sort((a, b) => b.outstanding - a.outstanding).slice(0, 25)) {
        evidence.push({
          kind: 'OBSERVED_FACT',
          label: `Invoice ${inv.number || inv.id.slice(0, 8)}`,
          detail: `${fmtMoney(inv.outstanding, currency)} outstanding, ${inv.ageDays} days past due (due ${toIsoDate(inv.dueDay)})`,
          source: { table: 'invoices', id: inv.id },
          observedAt: inv.updatedAt,
          value: inv.outstanding,
        });
      }
      if (collectable.length > 25) evidence.push({ kind: 'OBSERVED_FACT', label: 'More invoices', detail: `${collectable.length - 25} smaller overdue invoices are also included in the totals`, source: { table: 'invoices' } });
      for (const inv of disputed) {
        evidence.push({ kind: 'OBSERVED_FACT', label: `Disputed invoice ${inv.number || inv.id.slice(0, 8)}`, detail: `${fmtMoney(inv.outstanding, currency)} excluded: a dispute is open, so no collection action may touch it`, source: { table: 'disputes', invoiceId: inv.id } });
      }
      evidence.push({
        kind: 'CALCULATED_FACT',
        label: 'Collectable overdue balance',
        detail: `${fmtMoney(exposure, currency)} across ${collectable.length} invoice(s)`,
        calculation: 'sum(invoice_amount - confirmed payments) over overdue, undisputed invoices as of the decision date',
        value: Math.round(exposure),
      });
      evidence.push({
        kind: 'CALCULATED_FACT',
        label: 'Payment history used',
        detail: beh.paidSamples
          ? `${beh.paidSamples} paid invoice(s) for this customer (median ${Math.round(beh.medianDelay)} days past due), blended with ${model.tenant.paidSamples} across the business`
          : `No paid invoices for this customer yet. Uses ${model.tenant.paidSamples} paid invoices across the business and a prior of ${Math.round(model.prior.weeklyHazard * 100)}% paid per week`,
        calculation: `${MODEL_VERSION}: weekly survival table of days-past-due at payment, open invoices censored at their age, customer shrunk to business (k=${model.prior.kCustomer})`,
      });
      for (const tr of triggers) evidence.push({ kind: 'CALCULATED_FACT', label: 'Change detected', detail: tr.label, trigger: tr.code });
      if (liveContext.reminderEvidence && liveContext.reminderEvidence.n >= 5) {
        const r = liveContext.reminderEvidence;
        evidence.push({ kind: 'OBSERVED_ASSOCIATION', label: 'Past firm reminders', detail: `${r.effective} of ${r.n} firm reminders/escalations were followed by payment within the review window. This is an association, not proof they caused payment.`, source: { table: 'ai_actions' } });
      }
      evidence.push({ kind: 'SIMULATED', label: 'If nothing changes', detail: `${fmtMoney(doNothing.cash.d60.p50, currency)} expected within 60 days (80% range ${fmtMoney(doNothing.cash.d60.p10, currency)} to ${fmtMoney(doNothing.cash.d60.p90, currency)})`, calculation: `${sim.iterations} simulated futures, seed ${seed}` });

      const unknowns = voi.filter((v) => v.basis !== 'OBSERVED_RANGE').map((v) => ({
        key: v.unknown,
        label: v.label,
        status: 'UNKNOWN',
        valueOfInformation: v.expectedValueOfKnowing,
        changesRecommendation: v.recommendationDependsOnIt,
        acquisition: acquisitionFor(v.unknown, customer),
      }));
      if (!customer.customerId) unknowns.push({ key: 'customer_record', label: 'No customer record matches this name, so contact details and credit terms are unknown', status: 'UNKNOWN', valueOfInformation: null, acquisition: { type: 'REQUEST_INFORMATION', how: 'Create or link the customer record in Customers' } });
      if (freshness.status === 'STALE' || freshness.status === 'UNKNOWN') unknowns.push({ key: 'recent_payments', label: `Payments received since the last sync may be missing (${freshness.detail})`, status: 'UNKNOWN', valueOfInformation: null, acquisition: { type: 'REQUEST_INFORMATION', how: 'Import the latest ledger or confirm recent receipts' } });

      const assumptions = [];
      for (const o of options) for (const prm of o.params || []) {
        assumptions.push({ key: `${o.key}.${prm.name}`, option: o.key, label: prm.label, range: [prm.lo, prm.hi], basis: prm.basis });
      }
      assumptions.push({ key: 'model.prior', label: `Where history is thin, ${Math.round(model.prior.weeklyHazard * 100)}% of remaining balance is assumed paid per week`, basis: 'ASSUMPTION' });
      assumptions.push({ key: 'model.shock', label: 'Future payment speed varies around history (lognormal, 25% spread)', basis: 'ASSUMPTION' });
      if (collectable.some((i) => i.currencyAssumed)) assumptions.push({ key: 'currency', label: `Invoices with no currency are treated as ${state.baseCurrency}`, basis: 'ASSUMPTION' });

      const optionViews = options.map((o) => {
        const s = sim.summary.find((x) => x.key === o.key);
        const blast = blastRadius(o, { exposure, currency, customer });
        const validity = optionValidity(o, customer, liveContext);
        return {
          key: o.key,
          label: o.label,
          summary: o.summary,
          intent: o.intent,
          isDoNothing: o.kind === 'baseline',
          reversibility: o.reversibility,
          blastRadius: blast,
          approval: approvalPolicy(o, blast),
          valid: validity.valid,
          invalidReason: validity.reason,
          executableAs: validity.executableAs,
          assumptions: (o.params || []).map((prm) => ({ key: `${o.key}.${prm.name}`, label: prm.label, range: [prm.lo, prm.hi], basis: prm.basis })),
          futures: {
            cash30: s.cash.d30, cash60: s.cash.d60, cash90: s.cash.d90,
            probFullRecovery90: s.probFullRecovery90,
            creditLossAvoided: s.lossAvoided, marginLost: s.marginLost,
            value: s.value, bestShare: s.bestShare,
            robustness: robust.find((r) => r.key === o.key)?.acceptableShare ?? null,
          },
        };
      });

      // Never recommend an invalid option.
      let recKey = rec.key;
      const recView = optionViews.find((o) => o.key === recKey);
      if (!recView.valid) {
        const validSorted = optionViews.filter((o) => o.valid).sort((a, b) => b.futures.value.mean - a.futures.value.mean);
        recKey = validSorted[0].key;
      }
      const chosen = optionViews.find((o) => o.key === recKey);
      const dn = optionViews.find((o) => o.isDoNothing);
      const whyNot = optionViews.filter((o) => o.key !== recKey).map((o) => ({
        key: o.key,
        reason: !o.valid ? o.invalidReason
          : `Expected value ${fmtMoney(o.futures.value.mean, currency)} vs ${fmtMoney(chosen.futures.value.mean, currency)} for the recommendation; best in ${pct(o.futures.bestShare)} of futures`,
      }));
      const wouldChange = (sens?.results || []).filter((r) => r.flips).slice(0, 3).map((r) => ({
        assumption: r.assumption,
        label: r.label,
        detail: r.switches.map((sw) => `switches from ${sw.from} to ${sw.to} between ${sw.between[0]} and ${sw.between[1]}`).join('; '),
      }));

      const valueGain = chosen.futures.value.mean - dn.futures.value.mean;
      const urgency = daysToBadDebt <= 0 ? 1 : Math.max(0.1, Math.min(1, 1 - daysToBadDebt / 90));

      drafts.push({
        kind: 'RECEIVABLE_RISK',
        dedupKey: `receivables:${customer.key}:${currency}`,
        title: `How should we recover ${fmtMoney(exposure, currency)} overdue from ${customer.name}?`,
        description: `${collectable.length} overdue invoice(s). If nothing changes, about ${fmtMoney(expectedUncollected, currency)} is expected to still be unpaid in 90 days.`,
        currency,
        affectedEntities: [
          { type: 'customer', id: customer.customerId, key: customer.key, name: customer.name },
          ...collectable.map((i) => ({ type: 'invoice', id: i.id, number: i.number, outstanding: i.outstanding })),
        ],
        affectedProcesses: ['order_to_cash'],
        triggerSignals: triggers,
        whyNow: triggers.map((tr) => tr.label),
        whatIfIgnored: `About ${fmtMoney(doNothing.cash.d60.p50, currency)} of ${fmtMoney(exposure, currency)} comes in within 60 days (80% range ${fmtMoney(doNothing.cash.d60.p10, currency)}–${fmtMoney(doNothing.cash.d60.p90, currency)}); full recovery within 90 days in ${pct(doNothing.probFullRecovery90)} of simulated futures.`,
        window: {
          discoveredAt: new Date(state.asOf).toISOString(),
          usefulFrom: toIsoDate(state.asOfDay),
          latestSafeAt: toIsoDate(latestSafeAt),
          costOfDelayPerWeek: delay,
          basis: windowNote,
          timezone: defs.timezone,
        },
        objectives: [
          { key: 'cash', label: 'Collect cash within 60 days', weight: defs.objective_weights.cash },
          { key: 'credit_risk', label: 'Limit new credit exposure to a slow payer', weight: defs.objective_weights.credit_risk },
          { key: 'margin', label: 'Protect margin from lost orders', weight: defs.objective_weights.margin },
        ],
        constraints: constraintsFor(customer, disputed, liveContext),
        options: optionViews,
        doNothingKey: 'do_nothing',
        evidence,
        unknowns,
        assumptions,
        contradictions,
        expectedValue: Math.round(chosen.futures.value.mean),
        // How far below its expectation the recommendation can land (P10) and
        // how far above (P90), in the same value units.
        downsideRisk: Math.round(chosen.futures.value.mean - chosen.futures.value.p10),
        upsidePotential: Math.round(chosen.futures.value.p90 - chosen.futures.value.mean),
        reversibility: chosen.reversibility,
        blastRadius: chosen.blastRadius,
        urgency: Math.round(urgency * 100) / 100,
        materiality: { expectedUncollected90: Math.round(expectedUncollected), threshold: Math.round(threshold), exposure: Math.round(exposure), shareOfOpenReceivables: Math.round(share * 1000) / 1000 },
        confidence,
        recommendation: {
          key: recKey,
          label: chosen.label,
          why: `${chosen.label} has the highest expected value (${fmtMoney(chosen.futures.value.mean, currency)}, ${valueGain >= 0 ? '+' : ''}${fmtMoney(valueGain, currency)} vs doing nothing) and is best in ${pct(chosen.futures.bestShare)} of simulated futures.`,
          whyNot,
          wouldChangeIf: wouldChange,
          informationFirst: unknowns[0] && unknowns[0].changesRecommendation && unknowns[0].valueOfInformation > Math.abs(valueGain) * 0.25
            ? { key: unknowns[0].key, label: unknowns[0].label, valueOfInformation: unknowns[0].valueOfInformation }
            : null,
        },
        analysis: {
          simulation: { iterations: sim.iterations, seed, horizons: sim.horizons, exposure: sim.exposure, grouped },
          stress,
          sensitivity: sens,
          robustness: robust,
          valueOfInformation: voi,
          costOfDelay: delay,
          method: [
            `Payment timing: ${MODEL_VERSION}.`,
            'Options compared on common random numbers.',
            grouped ? 'Invoices were grouped by weekly age for speed; totals are exact, the spread is slightly wider.' : null,
            'Value = cash collected within 60 days + expected loss avoided on new credit - margin lost from lost orders (each weighted by the tenant objective weights).',
          ].filter(Boolean),
        },
        modelVersions: { engine: ENGINE_VERSION, behavior: MODEL_VERSION, definitions: DEFINITIONS_VERSION },
      });
    }
  }

  return { drafts, watched, model: { version: model.version, tenantPaidSamples: model.tenant.paidSamples } };
}

function optionValidity(option, customer, liveContext) {
  const rec = customer.record;
  if (option.intent.type === 'CONTACT_CUSTOMER') {
    if (rec && rec.escalation_paused) return { valid: false, reason: 'The owner has paused escalation for this customer.' };
    if (liveContext.externalSendEnabled) return { valid: true, executableAs: 'ai_action for owner-approved send' };
    return { valid: true, executableAs: 'prepared draft (external sending is switched off)' };
  }
  if (option.intent.type === 'HOLD_CREDIT') {
    if (!customer.customerId) return { valid: false, reason: 'No customer record to put on hold. Link the customer first.' };
    if (rec && rec.advance_required) return { valid: false, reason: 'Credit is already on hold for this customer.' };
    return { valid: true, executableAs: 'internal switch (customers.advance_required)' };
  }
  if (option.intent.type === 'COMPOSITE') {
    for (const step of option.intent.steps) {
      const v = optionValidity({ intent: step }, customer, liveContext);
      if (!v.valid) return v;
    }
    return { valid: true, executableAs: 'two steps: internal credit hold, then a contact that is ' + (liveContext.externalSendEnabled ? 'sent after owner approval' : 'prepared as a draft') };
  }
  if (option.intent.type === 'OFFER_PAYMENT_PLAN') return { valid: true, executableAs: 'draft payment plan the customer must agree to' };
  return { valid: true, executableAs: 'no action' };
}

function constraintsFor(customer, disputed, liveContext) {
  const out = [];
  out.push({ key: 'no_discount', type: 'POLICY', hard: true, label: 'AI proposals may not offer discounts, change amounts or mark invoices paid', status: 'RESPECTED' });
  if (disputed.length) out.push({ key: 'dispute_safety', type: 'POLICY', hard: true, label: `${disputed.length} disputed invoice(s) are excluded from every collection option`, status: 'RESPECTED' });
  if (customer.record && customer.record.escalation_paused) out.push({ key: 'escalation_paused', type: 'POLICY', hard: true, label: 'Escalation is paused for this customer', status: 'BLOCKS_ESCALATION' });
  if (!liveContext.externalSendEnabled) out.push({ key: 'external_send_off', type: 'OPERATIONAL', hard: true, label: 'External messaging is switched off; messages can only be prepared, not sent', status: 'LIMITS_EXECUTION' });
  const tags = Array.isArray(customer.record?.tags) ? customer.record.tags.map((t) => String(t).toLowerCase()) : [];
  if (tags.includes('strategic')) out.push({ key: 'strategic_relationship', type: 'OBJECTIVE', hard: false, label: 'Tagged strategic: relationship protection weighs against credit hold and escalation', status: 'TRADE_OFF' });
  return out;
}

function acquisitionFor(unknownKey, customer) {
  if (unknownKey.endsWith('acceptance')) return { type: 'REQUEST_INFORMATION', how: `Ask ${customer.name} whether instalments would work for them before committing` };
  if (unknownKey.endsWith('keep_rate')) return { type: 'REQUEST_INFORMATION', how: 'Record past payment promises and whether they were kept' };
  if (unknownKey.endsWith('churn')) return { type: 'REQUEST_INFORMATION', how: `Ask the sales owner how dependent ${customer.name} is on credit terms` };
  if (unknownKey.endsWith('gross_margin')) return { type: 'SET_DEFINITION', how: 'Set the business gross margin in Starlane definitions' };
  if (unknownKey.endsWith('hazard_multiplier') || unknownKey.endsWith('escalation_multiplier')) return { type: 'LEARN_FROM_OUTCOMES', how: 'Measured automatically as decisions with this action are verified' };
  if (unknownKey === 'shock') return { type: 'REQUEST_INFORMATION', how: `Ask ${customer.name} for a committed payment date` };
  return { type: 'REQUEST_INFORMATION', how: 'Confirm with the owner' };
}

module.exports = { discoverReceivableDecisions, fmtMoney };
