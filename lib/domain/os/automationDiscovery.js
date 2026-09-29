// FILE: lib/domain/os/automationDiscovery.js
// SCAN: find repetitive work that can be automated, rank it, and say which
// steps stay with a person.
//
// A candidate is only proposed when the ledger shows the work actually
// recurring (at least MIN_EPISODES_PER_MONTH). Every score component is
// reported with its value and weight, so the ranking can be checked by hand.
// Nothing here writes; persistence is in scan.js.

const { DAY, median, cv, round, clamp01 } = require('./stats');
const { DEFAULTS } = require('./workflowTemplates');

const MIN_EPISODES_PER_MONTH = 3;
const WEIGHTS = Object.freeze({ frequency: 0.25, humanEffort: 0.15, slippage: 0.15, predictability: 0.15, businessValue: 0.2, lowRisk: 0.05, reversibility: 0.05 });

/**
 * Of invoices that reached `triggerDays` past due, the share paid within the
 * following `withinDays`, with no Starlane action. This is the bar a
 * reminder workflow has to beat. Invoices still inside the window are
 * censored (left out), so the rate is not biased towards "unpaid".
 */
function historicalBaseline(state, triggerDays, withinDays = DEFAULTS.verifyWithinDays) {
  let reached = 0;
  let paidWithin = 0;
  for (const inv of state.invoices) {
    if (inv.dueDay == null || inv.currency !== state.baseCurrency) continue;
    if (inv.status === 'paid') {
      if (inv.paidDay == null) continue;
      const late = Math.round((inv.paidDay - inv.dueDay) / DAY);
      if (late < triggerDays) continue;
      reached++;
      if (late <= triggerDays + withinDays) paidWithin++;
    } else {
      if (inv.disputeOpen || inv.ageDays == null) continue;
      if (inv.ageDays >= triggerDays + withinDays) reached++;
    }
  }
  return {
    triggerDays,
    withinDays,
    reached,
    paidWithin,
    rate: reached >= 5 ? round(paidWithin / reached, 3) : null,
    enough: reached >= 5,
    label: reached >= 5
      ? `${paidWithin} of ${reached} invoices that reached ${triggerDays} days overdue were paid within the next ${withinDays} days without a reminder from Starlane.`
      : `Only ${reached} past invoice(s) reached ${triggerDays} days overdue, too few to set a baseline yet.`,
  };
}

/**
 * The trigger day: when most late payers have already paid on their own.
 * Chasing earlier mostly reminds people who were about to pay.
 */
function chooseTriggerDays(process) {
  const step = (process.steps || []).find((s) => s.key === 'DUE_TO_PAID');
  if (!step || step.n < 5 || step.medianDays == null) return { days: DEFAULTS.overdueDays, why: `Default of ${DEFAULTS.overdueDays} days: too few late payments to choose from the data.`, fromData: false };
  const days = Math.min(60, Math.max(15, Math.ceil(step.medianDays / 15) * 15));
  return { days, why: `Late payers here pay a median ${step.medianDays} days after the due date on their own, so the follow-up starts at ${days} days.`, fromData: true };
}

function inScopeNow(state, triggerDays, minBalance) {
  const byCustomer = new Map();
  for (const inv of state.invoices) {
    if (inv.currency !== state.baseCurrency || inv.outstanding <= 0 || inv.disputeOpen || inv.ageDays == null || inv.ageDays < triggerDays) continue;
    const c = byCustomer.get(inv.customerKey) || { amount: 0, invoices: 0 };
    c.amount += inv.outstanding;
    c.invoices++;
    byCustomer.set(inv.customerKey, c);
  }
  const eligible = [...byCustomer.entries()].filter(([key, c]) => {
    const rec = state.customers.get(key)?.record;
    return c.amount >= minBalance && !(rec && rec.escalation_paused);
  });
  return { customers: eligible.length, invoices: eligible.reduce((a, [, c]) => a + c.invoices, 0), amount: round(eligible.reduce((a, [, c]) => a + c.amount, 0)) };
}

function discoverAutomations(state, process) {
  const out = { candidates: [], considered: [] };
  if (!process || process.status !== 'RECONSTRUCTED') {
    out.considered.push({ key: 'receivables_followup', proposed: false, why: process?.reason || 'The invoice-to-payment process could not be reconstructed.' });
    return out;
  }
  const mw = process.manualWork;
  if (mw.perMonth < MIN_EPISODES_PER_MONTH) {
    out.considered.push({ key: 'receivables_followup', proposed: false, why: `Invoices went overdue about ${mw.perMonth} times a month; below ${MIN_EPISODES_PER_MONTH} a month there is too little repeated work to automate.` });
    return out;
  }

  const trigger = chooseTriggerDays(process);
  const minBalance = DEFAULTS.minBalance;
  const baseline = historicalBaseline(state, trigger.days);
  const now = inScopeNow(state, trigger.days, minBalance);
  const totalOpen = state.totalsByCurrency[state.baseCurrency]?.open || 0;

  // Invoices that stayed unpaid 30+ days past due among those that went late:
  // the follow-up that did not happen, or did not work.
  const lateEver = state.invoices.filter((i) => i.dueDay != null && ((i.status === 'paid' && i.paidDay != null && i.paidDay > i.dueDay) || (i.status !== 'paid' && i.ageDays > 0 && !i.disputeOpen)));
  const slipped = lateEver.filter((i) => (i.status === 'paid' ? (i.paidDay - i.dueDay) / DAY : i.ageDays) >= 30);
  const slippageRate = lateEver.length ? slipped.length / lateEver.length : 0;
  const windowCounts = mw.windows.map((w) => w.count);
  const variability = cv(windowCounts);

  const components = [
    { key: 'frequency', label: 'How often it happens', value: round(clamp01(mw.perMonth / 20), 2), detail: `${mw.perMonth} overdue invoices a month (last ${mw.windows.length} months: ${windowCounts.join(', ')})` },
    { key: 'humanEffort', label: 'Human effort', value: round(clamp01(mw.humanEffort.hoursPerMonth / 8), 2), detail: `About ${mw.humanEffort.hoursPerMonth} hours a month. ${mw.humanEffort.assumption}` },
    { key: 'slippage', label: 'Work that slips today', value: round(clamp01(slippageRate), 2), detail: `${slipped.length} of ${lateEver.length} late invoices went 30+ days past due` },
    { key: 'predictability', label: 'Predictability', value: round(variability == null ? 0.5 : clamp01(1 - variability), 2), detail: variability == null ? 'Not enough months to measure variation' : `Month-to-month variation ${Math.round(variability * 100)}%` },
    { key: 'businessValue', label: 'Money involved', value: round(totalOpen ? clamp01((now.amount / totalOpen) * 2) : 0, 2), detail: `${now.amount.toLocaleString('en-IN')} ${state.baseCurrency} across ${now.customers} customer(s) is past the trigger now` },
    { key: 'lowRisk', label: 'Risk', value: 0.5, detail: 'Customer contact is external, so every reminder needs approval' },
    { key: 'reversibility', label: 'Reversibility', value: 0.3, detail: 'A sent message cannot be unsent; drafting and ranking are fully reversible' },
  ];
  const score = round(components.reduce((a, c) => a + c.value * WEIGHTS[c.key], 0), 3);

  out.candidates.push({
    key: 'receivables_followup',
    title: 'Overdue invoice follow-up',
    summary: `About ${mw.perMonth} invoices a month go past their due date and someone has to notice, check the history and chase. 4 of the 7 steps are deterministic, 1 can be drafted by Starlane, and approval stays with you.`,
    frequencyPerMonth: mw.perMonth,
    steps: { total: 7, deterministic: 4, agent: 1, human: 2, humanDetail: 'Approval, and sending until messaging is connected (manual completion required)' },
    score,
    weights: WEIGHTS,
    components,
    level: { current: 0, proposed: 2 },
    trigger,
    minBalance,
    baseline,
    inScopeNow: now,
    risks: [
      'Contacting a customer is external and cannot be undone, so each reminder waits for approval.',
      'Disputed invoices and customers with collections paused are excluded.',
      'Verification depends on the ledger being re-imported; stale data stops the workflow.',
    ],
    evidence: [
      { label: 'Overdue invoices per month', value: mw.perMonth, source: 'invoice due dates and payment dates' },
      { label: 'Late invoices that slipped 30+ days', value: `${slipped.length} of ${lateEver.length}`, source: 'invoice due dates and payment dates' },
      { label: 'Baseline', value: baseline.label, source: 'past invoices' },
    ],
  });
  out.considered.push({ key: 'receivables_followup', proposed: true, why: 'Recurring, mostly deterministic, and measurable against a baseline.' });
  return out;
}

/**
 * Opportunities found in the same data. Each is grounded in counted rows.
 */
function discoverOpportunities(state, behavior) {
  const out = [];
  const asOf = state.asOfDay;

  // Dormant customers: bought regularly, then stopped.
  const dormant = [];
  for (const c of state.customers.values()) {
    const days = c.invoices.map((i) => i.invoiceDay).sort((a, b) => a - b);
    if (days.length < 4) continue;
    const gaps = [];
    for (let k = 1; k < days.length; k++) gaps.push((days[k] - days[k - 1]) / DAY);
    const g = median(gaps);
    const since = (asOf - days[days.length - 1]) / DAY;
    if (g && since > Math.max(2 * g, 60)) {
      const yearly = c.invoices.filter((i) => i.invoiceDay > days[days.length - 1] - 365 * DAY).reduce((a, i) => a + i.amount, 0);
      dormant.push({ customer: c.name, lastInvoice: new Date(days[days.length - 1]).toISOString().slice(0, 10), usualGapDays: round(g), daysSince: round(since), billedInPriorYear: round(yearly) });
    }
  }
  if (dormant.length) {
    out.push({
      key: 'dormant_customers',
      kind: 'REVENUE',
      title: `${dormant.length} regular customer${dormant.length === 1 ? ' has' : 's have'} stopped buying`,
      detail: 'Each used to be invoiced regularly and has gone more than twice their usual gap without a new invoice.',
      value: round(dormant.reduce((a, d) => a + d.billedInPriorYear, 0)),
      valueLabel: 'billed to them in the year before they stopped',
      items: dormant.sort((a, b) => b.billedInPriorYear - a.billedInPriorYear).slice(0, 10),
    });
  }

  // Cash that reliable payers owe past due: usually an oversight, cheap to ask for.
  const reliable = [];
  for (const c of state.customers.values()) {
    const b = behavior?.customers.get(c.key);
    if (!b || b.paidSamples < 3 || b.onTimeRate == null || b.onTimeRate < 0.7) continue;
    const overdue = c.invoices.filter((i) => i.outstanding > 0 && i.ageDays > 0 && !i.disputeOpen && i.currency === state.baseCurrency);
    const amount = overdue.reduce((a, i) => a + i.outstanding, 0);
    if (amount > 0) reliable.push({ customer: c.name, amount: round(amount), invoices: overdue.length, onTimeRate: round(b.onTimeRate, 2), paidInvoices: b.paidSamples });
  }
  if (reliable.length) {
    out.push({
      key: 'cash_release_reliable_payers',
      kind: 'CASH',
      title: `${reliable.length} customer${reliable.length === 1 ? ' who usually pays' : 's who usually pay'} on time ${reliable.length === 1 ? 'is' : 'are'} overdue`,
      detail: 'They paid at least 70% of past invoices by the due date, so this is more likely an oversight than a problem.',
      value: round(reliable.reduce((a, r) => a + r.amount, 0)),
      valueLabel: 'overdue from reliable payers',
      items: reliable.sort((a, b) => b.amount - a.amount).slice(0, 10),
    });
  }
  return out;
}

/**
 * Theory of constraints, limited to what the connected data can show.
 */
function identifyConstraint(state, process) {
  const t = state.totalsByCurrency[state.baseCurrency];
  const missing = ['inventory levels', 'supplier lead times', 'production capacity', 'bank balance'];
  if (!t || t.open === 0 || process?.status !== 'RECONSTRUCTED') {
    return { constraint: null, confidence: 'LOW', why: 'Not enough receivables data to identify a constraint.', cannotSee: missing };
  }
  const overdueShare = t.overdue / t.open;
  if (overdueShare >= 0.3 && process.bottleneck) {
    return {
      constraint: 'CASH_CONVERSION',
      label: 'Cash conversion',
      confidence: 'MEDIUM',
      why: `${Math.round(overdueShare * 100)}% of open receivables is past due and the slowest step is waiting after the due date, so collecting is what currently limits cash.`,
      cannotSee: missing,
    };
  }
  return { constraint: null, confidence: 'LOW', why: `Receivables look healthy (${Math.round(overdueShare * 100)}% of open balance past due), so the constraint is probably elsewhere, in data Starlane cannot see yet.`, cannotSee: missing };
}

module.exports = { discoverAutomations, discoverOpportunities, identifyConstraint, historicalBaseline, chooseTriggerDays, inScopeNow, MIN_EPISODES_PER_MONTH, WEIGHTS };
