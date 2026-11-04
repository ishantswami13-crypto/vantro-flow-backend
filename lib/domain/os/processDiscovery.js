// FILE: lib/domain/os/processDiscovery.js
// SCAN: reconstruct how the invoice-to-payment process actually runs, from
// ledger events only.
//
// Input is an as-of state from decisions/snapshot.deriveReceivablesState, so
// the same code serves live scans and historical replays with no future
// information. Everything reported is counted from rows; anything the ledger
// cannot show (handoffs, rework, who approved credit) is listed as not
// observable instead of being guessed.

const { DAY, median, quantile, round } = require('./stats');

const MIN_INSTANCES = 5;
const LOOKBACK_DAYS = 365;
const WINDOW_DAYS = 30;
const WINDOWS = 3;
// Minutes a person spends noticing an overdue invoice, checking its history
// and writing a reminder. An assumption, always reported as one.
const MANUAL_MINUTES_PER_EPISODE = 10;

function iso(ms) {
  return ms == null ? null : new Date(ms).toISOString().slice(0, 10);
}

/**
 * The day an invoice first needed chasing (the day after its due date), or
 * null when it was paid on time or is not yet due.
 */
function overdueEpisodeDay(inv, asOfDay) {
  if (inv.dueDay == null) return null;
  const firstLate = inv.dueDay + DAY;
  if (firstLate > asOfDay) return null;
  if (inv.status === 'paid') {
    if (inv.paidDay == null) return null; // cannot tell whether it was late
    return inv.paidDay > inv.dueDay ? firstLate : null;
  }
  return firstLate;
}

function variantOf(inv) {
  if (inv.disputeOpen && inv.outstanding > 0) return 'DISPUTED';
  if (inv.status === 'paid') {
    if (inv.paidDateUnknown || inv.paidDay == null) return 'PAID_DATE_UNKNOWN';
    if (inv.dueDay == null) return 'PAID_NO_TERMS';
    return inv.paidDay <= inv.dueDay ? 'PAID_ON_TIME' : 'PAID_LATE';
  }
  if (inv.paidAmount > 0) return 'PART_PAID_OPEN';
  if (inv.dueDay == null) return 'OPEN_NO_TERMS';
  return inv.ageDays > 0 ? 'OPEN_OVERDUE' : 'OPEN_NOT_DUE';
}

const VARIANT_LABELS = {
  PAID_ON_TIME: 'Paid by the due date',
  PAID_LATE: 'Paid after the due date',
  OPEN_OVERDUE: 'Still unpaid past the due date',
  OPEN_NOT_DUE: 'Unpaid, not yet due',
  PART_PAID_OPEN: 'Part-paid, balance open',
  DISPUTED: 'Disputed',
  PAID_DATE_UNKNOWN: 'Paid, payment date not recorded',
  PAID_NO_TERMS: 'Paid, no due date recorded',
  OPEN_NO_TERMS: 'Unpaid, no due date recorded',
};

/**
 * @param {object} state  deriveReceivablesState output
 * @param {object} [opts] { touches: {reminders, followups, promises} } observed human touches in the lookback
 */
function discoverReceivablesProcess(state, opts = {}) {
  const asOfDay = state.asOfDay;
  const from = asOfDay - LOOKBACK_DAYS * DAY;
  const invoices = state.invoices.filter((i) => i.invoiceDay >= from && i.currency === state.baseCurrency);
  const otherCurrency = state.invoices.filter((i) => i.invoiceDay >= from && i.currency !== state.baseCurrency).length;
  const withDue = invoices.filter((i) => i.dueDay != null);
  const earliest = invoices.length ? Math.min(...invoices.map((i) => i.invoiceDay)) : null;

  const coverage = {
    from: iso(earliest),
    to: iso(asOfDay),
    days: earliest == null ? 0 : Math.round((asOfDay - earliest) / DAY),
    invoices: invoices.length,
    withDueDate: withDue.length,
    customers: new Set(invoices.map((i) => i.customerKey)).size,
    excludedOtherCurrency: otherCurrency,
    lookbackDays: LOOKBACK_DAYS,
  };

  const notObservable = [
    { what: 'Handoffs and who did each step', why: 'The ledger records invoices and payments, not who worked on them.' },
    { what: 'Rework (re-issued or corrected invoices)', why: 'Corrections are not distinguishable from new invoices in this data.' },
    { what: 'Order and quote steps before the invoice', why: 'No order or quote data is connected yet.' },
  ];

  if (withDue.length < MIN_INSTANCES) {
    return {
      process: 'ORDER_TO_CASH',
      label: 'Invoice to payment',
      status: 'INSUFFICIENT_DATA',
      reason: withDue.length === 0
        ? 'No invoice has a due date, so on-time and late cannot be told apart.'
        : `Only ${withDue.length} invoice(s) with a due date in the last ${LOOKBACK_DAYS} days; at least ${MIN_INSTANCES} are needed.`,
      coverage,
      notObservable,
    };
  }

  const variantCounts = {};
  for (const inv of invoices) {
    const v = variantOf(inv);
    variantCounts[v] = (variantCounts[v] || 0) + 1;
  }
  const variants = Object.entries(variantCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => ({ key, label: VARIANT_LABELS[key], count, share: round(count / invoices.length, 3) }));

  const terms = withDue.map((i) => (i.dueDay - i.invoiceDay) / DAY);
  const paid = withDue.filter((i) => i.status === 'paid' && i.paidDay != null);
  const cycle = paid.map((i) => (i.paidDay - i.invoiceDay) / DAY);
  const late = paid.filter((i) => i.paidDay > i.dueDay);
  const lateness = late.map((i) => (i.paidDay - i.dueDay) / DAY);
  const openOverdue = withDue.filter((i) => i.status !== 'paid' && i.ageDays > 0 && !i.disputeOpen);

  const dueByNow = withDue.filter((i) => i.dueDay < asOfDay && !(i.status === 'paid' && i.paidDay == null));
  const slaMet = dueByNow.filter((i) => i.status === 'paid' && i.paidDay <= i.dueDay).length;
  const slaViolated = dueByNow.length - slaMet;

  const steps = [
    { key: 'ISSUED_TO_DUE', label: 'Invoice issued to due date (credit terms)', medianDays: round(median(terms)), p90Days: round(quantile(terms, 0.9)), n: terms.length, performer: 'SYSTEM' },
    { key: 'DUE_TO_PAID', label: 'Waiting after the due date', medianDays: round(median(lateness)), p90Days: round(quantile(lateness, 0.9)), n: lateness.length, performer: 'CUSTOMER' },
    { key: 'OVERDUE_OPEN', label: 'Unpaid past the due date now', medianDays: round(median(openOverdue.map((i) => i.ageDays))), p90Days: round(quantile(openOverdue.map((i) => i.ageDays), 0.9)), n: openOverdue.length, performer: 'CUSTOMER' },
  ];

  const lateShare = dueByNow.length ? slaViolated / dueByNow.length : 0;
  let bottleneck = null;
  if (lateness.length >= 3 && median(lateness) > 0 && lateShare >= 0.25) {
    bottleneck = {
      step: 'DUE_TO_PAID',
      label: 'Waiting after the due date',
      medianDays: round(median(lateness)),
      why: `${Math.round(lateShare * 100)}% of invoices that fell due were not paid by the due date; late payers took a median ${round(median(lateness))} extra days.`,
    };
  }

  const termsMedian = median(terms);
  const cycleMedian = median(cycle);
  const documentedVsActual = cycle.length >= 3 ? {
    documented: { days: round(termsMedian), label: `Invoices say payment is due in ${round(termsMedian)} days`, source: 'Due dates on the invoices' },
    actual: { days: round(cycleMedian), label: `Payment actually arrives a median ${round(cycleMedian)} days after the invoice`, n: cycle.length },
    gapDays: round(cycleMedian - termsMedian),
  } : null;

  // Manual work: every invoice that passes its due date unpaid needs someone
  // to notice it and chase it. Counted per 30-day window.
  const episodes = withDue.filter((i) => !i.disputeOpen || i.status === 'paid').map((i) => overdueEpisodeDay(i, asOfDay)).filter((d) => d != null);
  const windows = [];
  for (let w = WINDOWS - 1; w >= 0; w--) {
    const end = asOfDay - w * WINDOW_DAYS * DAY;
    const start = end - WINDOW_DAYS * DAY;
    windows.push({ from: iso(start + DAY), to: iso(end), count: episodes.filter((d) => d > start && d <= end).length });
  }
  const perMonth = round(windows.reduce((a, w) => a + w.count, 0) / WINDOWS, 1);
  const touches = opts.touches || null;

  return {
    process: 'ORDER_TO_CASH',
    label: 'Invoice to payment',
    status: 'RECONSTRUCTED',
    coverage,
    steps,
    cycle: { medianDays: round(cycleMedian), p90Days: round(quantile(cycle, 0.9)), n: cycle.length },
    variants,
    sla: { label: 'Paid by the due date', met: slaMet, violated: slaViolated, rate: dueByNow.length ? round(slaMet / dueByNow.length, 3) : null },
    exceptions: {
      disputed: variantCounts.DISPUTED || 0,
      partPaid: variantCounts.PART_PAID_OPEN || 0,
      paidDateUnknown: variantCounts.PAID_DATE_UNKNOWN || 0,
    },
    bottleneck,
    documentedVsActual,
    manualWork: {
      trigger: 'An invoice passes its due date unpaid',
      windows,
      perMonth,
      observedTouches: touches,
      humanEffort: {
        minutesPerEpisode: MANUAL_MINUTES_PER_EPISODE,
        hoursPerMonth: round((perMonth * MANUAL_MINUTES_PER_EPISODE) / 60, 1),
        assumption: `${MANUAL_MINUTES_PER_EPISODE} minutes per overdue invoice to notice it, check the history and write a reminder (an assumption, not measured).`,
      },
    },
    notObservable,
  };
}

module.exports = { discoverReceivablesProcess, overdueEpisodeDay, variantOf, MANUAL_MINUTES_PER_EPISODE, MIN_INSTANCES };
