// FILE: lib/domain/os/workflowLogic.js
// MISSIONS / SIMULATE: the pure parts of the workflow engine. No DB, no clock.
//
//   parseWorkflowText  one sentence -> workflow parameters (or a clear "no")
//   selectTargets      as-of state + manifest -> who the workflow acts on
//   draftReminder      ledger facts -> reminder text (never free text from users)
//   replayWorkflow     historical replay with no future information

const crypto = require('crypto');
const { DAY, round } = require('./stats');
const { deriveReceivablesState, assertNoFutureLeakage } = require('../decisions/snapshot');
const { probPaidWithin } = require('../decisions/behavior');
const { detectPromptInjection } = require('../../services/orchestrator/promptGuard.service');
const { DEFAULTS } = require('./workflowTemplates');
const { MANUAL_MINUTES_PER_EPISODE: MANUAL_MINUTES } = require('./processDiscovery');

const MULTIPLIERS = { k: 1e3, thousand: 1e3, l: 1e5, lac: 1e5, lakh: 1e5, lakhs: 1e5, cr: 1e7, crore: 1e7, crores: 1e7 };

/**
 * Deterministic reading of a workflow sentence. It understands overdue
 * follow-ups ("Whenever a customer is overdue 45 days, prepare a reminder",
 * optional "above ₹50,000"). Anything else is refused with what it did and
 * did not understand; nothing is guessed.
 */
function parseWorkflowText(text) {
  const raw = String(text || '').trim();
  if (!raw) return { ok: false, why: 'Describe the workflow in a sentence.' };
  if (raw.length > 500) return { ok: false, why: 'Keep the description under 500 characters.' };
  const guard = detectPromptInjection(raw);
  if (guard.hardBlock || guard.isSuspicious) return { ok: false, why: 'That text looks like an instruction to Starlane rather than a description of a workflow, so it was not used.', safety: { flags: guard.flags } };

  const t = raw.toLowerCase();
  const understood = [];
  const notes = [];
  const isOverdue = /\b(overdue|past due|late|unpaid)\b/.test(t);
  const isFollowUp = /\b(remind(?:er)?s?|follow[\s-]?ups?|chase|nudge|messages?|contact)\b/.test(t);
  if (!isOverdue || !isFollowUp) {
    return {
      ok: false,
      why: 'Starlane can build overdue-invoice follow-ups from a sentence today, for example "Whenever a customer is overdue 45 days, prepare a reminder". Stock, purchasing and order workflows are not built yet.',
      understood,
    };
  }
  const daysMatch = t.match(/(\d{1,3})\s*\+?\s*(?:days?|d\b)/);
  const overdueDays = daysMatch ? Number(daysMatch[1]) : DEFAULTS.overdueDays;
  if (overdueDays < 1 || overdueDays > 365) return { ok: false, why: 'The number of days overdue must be between 1 and 365.' };
  understood.push(daysMatch ? `Trigger: an invoice is ${overdueDays}+ days overdue` : `No number of days given, so the trigger is ${overdueDays}+ days overdue`);

  let minBalance = DEFAULTS.minBalance;
  const bal = t.match(/(?:above|over|more than|at least|greater than|exceeds?|>=?)\s*(?:₹|rs\.?|inr)?\s*([\d,]+(?:\.\d+)?)\s*(k|thousand|lakhs?|lac|l|crores?|cr)?\b/);
  if (bal) {
    const n = Number(bal[1].replace(/,/g, ''));
    const mult = bal[2] ? MULTIPLIERS[bal[2]] || 1 : 1;
    if (Number.isFinite(n) && n >= 0) { minBalance = Math.round(n * mult); understood.push(`Only when the customer owes at least ${minBalance.toLocaleString('en-IN')}`); }
  } else {
    understood.push(`No minimum balance given, so it applies from ${minBalance.toLocaleString('en-IN')}`);
  }
  understood.push('Action: draft a personalised reminder from the customer\'s own invoices and payment history');
  understood.push('Control: you approve every reminder before it goes out');
  if (/\b(without (asking|approval)|automatically send|auto[\s-]?send|send (it )?automatically|no approval)\b/.test(t)) {
    notes.push('You asked for no approval. Starlane still asks: contacting a customer cannot be undone, and sending without approval is not allowed.');
  }
  notes.push('Outcome checked: payment received within 7 days, not "message sent".');
  return { ok: true, params: { overdueDays, minBalance }, understood, notes };
}

function cleanName(name) {
  return String(name || 'Customer').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}

function isStrategic(record) {
  const tags = Array.isArray(record?.tags) ? record.tags : [];
  return tags.some((x) => String(x).toLowerCase() === 'strategic');
}

/**
 * Who the workflow acts on at this as-of state: one target per customer,
 * covering all their invoices past the trigger.
 */
function selectTargets(state, params, behavior) {
  const { overdueDays, minBalance } = params;
  const excluded = { disputed: 0, paused: 0, belowMinimum: 0, otherCurrency: 0 };
  const byCustomer = new Map();
  for (const inv of state.invoices) {
    if (inv.outstanding <= 0 || inv.ageDays == null || inv.ageDays < overdueDays) continue;
    if (inv.currency !== state.baseCurrency) { excluded.otherCurrency++; continue; }
    if (inv.disputeOpen) { excluded.disputed++; continue; }
    const list = byCustomer.get(inv.customerKey) || [];
    list.push(inv);
    byCustomer.set(inv.customerKey, list);
  }
  const targets = [];
  for (const [key, invoices] of byCustomer) {
    const customer = state.customers.get(key);
    const record = customer?.record || null;
    if (record?.escalation_paused) { excluded.paused++; continue; }
    const amount = round(invoices.reduce((a, i) => a + i.outstanding, 0), 2);
    if (amount < minBalance) { excluded.belowMinimum++; continue; }
    const model = behavior ? (behavior.customers.get(key) || behavior.tenant) : null;
    let atRisk = amount;
    let baselineProbability = null;
    if (model) {
      atRisk = invoices.reduce((a, i) => a + i.outstanding * (1 - probPaidWithin(model.daily, i.ageDays, 14)), 0);
      // Probability at least one of these invoices is paid within the verification window with no action.
      const pNone = invoices.reduce((a, i) => a * (1 - probPaidWithin(model.daily, i.ageDays, DEFAULTS.verifyWithinDays)), 1);
      baselineProbability = round(1 - pNone, 3);
    }
    targets.push({
      customerKey: key,
      customerName: cleanName(customer?.name || invoices[0].customerName),
      strategic: isStrategic(record),
      invoices: invoices.sort((a, b) => b.ageDays - a.ageDays).map((i) => ({ id: i.id, number: i.number, outstanding: i.outstanding, dueDay: i.dueDay, ageDays: i.ageDays })),
      amount,
      maxAgeDays: Math.max(...invoices.map((i) => i.ageDays)),
      priority: round(atRisk, 2),
      baselineProbability,
      history: model ? { paidInvoices: model.paidSamples, medianDelayDays: model.medianDelay == null ? null : round(model.medianDelay), onTimeRate: model.onTimeRate == null ? null : round(model.onTimeRate, 2) } : null,
    });
  }
  targets.sort((a, b) => b.priority - a.priority || b.maxAgeDays - a.maxAgeDays);
  return { targets, excluded };
}

/**
 * One item per customer per set of overdue invoices: re-running is a no-op.
 * The episode part identifies the work; the version part lets an item that
 * was cancelled under an old policy be prepared again under the new one.
 */
function episodeKey(workflowId, target) {
  const ids = target.invoices.map((i) => i.id).sort().join(',');
  const h = crypto.createHash('sha256').update(`${target.customerKey}|${ids}`).digest('hex').slice(0, 24);
  return `wf:${workflowId}:${h}`;
}

function idempotencyKey(workflowId, version, target) {
  return `${episodeKey(workflowId, target)}:v${version}`;
}

function money(n, currency) {
  return `${currency === 'INR' ? '₹' : `${currency} `}${Math.round(n).toLocaleString('en-IN')}`;
}

function isoDay(ms) {
  return new Date(ms).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/**
 * The reminder is assembled only from ledger facts (names, numbers, dates)
 * and fixed wording. No human-entered note or model output is inserted, so
 * nothing a customer or document says can steer it.
 */
function draftReminder(target, { businessName, currency }) {
  const tone = target.maxAgeDays >= 60 ? 'FIRM_CALL' : target.maxAgeDays >= 45 ? 'FIRM' : 'POLITE';
  const lines = target.invoices.slice(0, 6).map((i) => `${i.number || 'Invoice'}: ${money(i.outstanding, currency)}, due ${isoDay(i.dueDay)}`);
  if (target.invoices.length > 6) lines.push(`and ${target.invoices.length - 6} more`);
  const from = cleanName(businessName || 'us');
  const greeting = `Namaste ${target.customerName},`;
  const total = money(target.amount, currency);
  const body = tone === 'POLITE'
    ? `This is a gentle reminder from ${from} that ${target.invoices.length === 1 ? 'this invoice is' : 'these invoices are'} past due, ${total} in total:`
    : `${target.invoices.length === 1 ? 'This invoice is' : 'These invoices are'} now ${target.maxAgeDays} days past due, ${total} in total:`;
  const ask = tone === 'POLITE'
    ? 'Could you let us know when we can expect payment? Thank you.'
    : tone === 'FIRM'
      ? 'Please arrange payment this week, or tell us if something is holding it up.'
      : 'Please arrange payment this week. We will also call to understand if anything is holding it up.';
  return {
    tone,
    channel: 'WHATSAPP',
    text: [greeting, body, ...lines.map((l) => `• ${l}`), ask, `— ${from}`].join('\n'),
    facts: { invoices: target.invoices.map((i) => i.id), total: target.amount, maxAgeDays: target.maxAgeDays },
    generatedBy: 'template (no LLM)',
  };
}

/**
 * SIMULATE: replay the workflow over past weeks. At each weekly as-of date T
 * the state is rebuilt with replay rules (nothing after T is visible) and
 * leakage is asserted. What happened afterwards is then read from the raw
 * rows to measure how often the trigger fired and how often those customers
 * paid within the verification window on their own: the baseline the
 * workflow has to beat. It cannot say what a reminder would have changed;
 * that is what shadow mode and the approval phase measure.
 */
function replayWorkflow(raw, params, asOfIso, { lookbackDays = 180, stepDays = 7, baseCurrency = 'INR' } = {}) {
  const asOf = Date.parse(asOfIso);
  const within = DEFAULTS.verifyWithinDays;
  const payments = new Map();
  for (const inv of raw.invoices || []) {
    const d = inv.payment_date ? Date.parse(String(inv.payment_date).slice(0, 10)) : NaN;
    if (Number.isFinite(d) && (inv.payment_status === 'Paid' || Number(inv.payment_amount) > 0)) payments.set(String(inv.id), d);
  }
  const seen = new Set();
  const episodes = [];
  let leakageChecks = 0;
  for (let t = asOf - lookbackDays * DAY; t <= asOf - within * DAY; t += stepDays * DAY) {
    const state = deriveReceivablesState(raw, t, { mode: 'replay', baseCurrency });
    assertNoFutureLeakage(state);
    leakageChecks++;
    const { targets } = selectTargets(state, params, null);
    for (const target of targets) {
      const key = idempotencyKey('replay', 1, target);
      if (seen.has(key)) continue;
      seen.add(key);
      const tDay = state.asOfDay;
      const paidWithin = target.invoices.some((i) => {
        const p = payments.get(String(i.id));
        return p != null && p > tDay && p <= tDay + within * DAY;
      });
      episodes.push({ asOf: new Date(tDay).toISOString().slice(0, 10), customer: target.customerName, amount: target.amount, paidWithinWindow: paidWithin });
    }
  }
  const n = episodes.length;
  const paid = episodes.filter((e) => e.paidWithinWindow).length;
  const months = lookbackDays / 30;
  return {
    lookbackDays,
    stepDays,
    replays: leakageChecks,
    leakage: 'none (asserted at every replay date)',
    episodes: n,
    perMonth: round(n / months, 1),
    amountTriggered: round(episodes.reduce((a, e) => a + e.amount, 0)),
    paidWithinWindowWithoutAction: paid,
    baselineRate: n ? round(paid / n, 3) : null,
    humanHoursPerMonth: round(((n / months) * MANUAL_MINUTES) / 60, 1),
    cannotSay: 'What a reminder would have changed. Shadow mode and the approval phase measure that against this baseline.',
    sample: episodes.slice(-10),
  };
}

module.exports = { parseWorkflowText, selectTargets, idempotencyKey, episodeKey, draftReminder, replayWorkflow, cleanName, isStrategic };
