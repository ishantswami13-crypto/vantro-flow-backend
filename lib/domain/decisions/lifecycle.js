// FILE: lib/domain/decisions/lifecycle.js
// Decision lifecycle after discovery:
//   select option -> Decision Contract (falsifiable expected outcomes)
//   -> approve (human) -> execute through the Action Fabric (or record what
//   Starlane WOULD have done, in shadow mode) -> verification (verification.js).
//
// Action Fabric: every option names a normalized intent (HOLD_CREDIT,
// CONTACT_CUSTOMER, OFFER_PAYMENT_PLAN, CREATE_PO, CREATE_DUNNING_RULES,
// CHANGE_PAYMENT_TERMS, REQUEST_INFORMATION). Each intent maps to one adapter
// that declares its connector, whether it is internal or external, how to
// check preconditions, how to verify the write actually happened
// (postcondition), and how to undo it (rollback). Policy (pilot mode, kill
// switches, approval) is checked here, outside any model.

const crypto = require('crypto');
const { getDecision, appendEvent, humanActor, agentActor, AGENT } = require('./store');
const { getSettings, checkStops } = require('./controls');
const { deriveReceivablesState } = require('./snapshot');
const { loadRawReceivables } = require('./discovery');
const { addDays, toIsoDate, startOfUtcDay } = require('./dates');
const { safeLog } = require('../../observability/logger');
const { receivablesFreshness } = require('./sourceHealth');

function httpError(status, message, extra = {}) {
  return Object.assign(new Error(message), { status, ...extra });
}

// ── Contracts ────────────────────────────────────────────────────────────

function expectedOutcomesFor(decision, option) {
  const dn = decision.options.find((o) => o.isDoNothing);
  if (decision.kind === 'RECEIVABLE_RISK') {
    const invoiceIds = decision.affected_entities.filter((e) => e.type === 'invoice').map((e) => e.id);
    const outcomes = [];
    for (const [h, key] of [[30, 'cash30'], [60, 'cash60'], [90, 'cash90']]) {
      outcomes.push({ metric: 'collected_amount', horizonDays: h, scenario: 'chosen', option: option.key, invoiceIds, ...option.futures[key] });
      if (dn && dn.key !== option.key) outcomes.push({ metric: 'collected_amount', horizonDays: h, scenario: 'do_nothing', option: dn.key, invoiceIds, ...dn.futures[key] });
    }
    return outcomes;
  }
  if (decision.kind === 'PROCESS_DEGRADATION') {
    const p = decision.analysis?.process;
    const recent = p?.recent?.medianCycleDays;
    const prior = p?.prior?.medianCycleDays;
    if (recent == null || prior == null) return [];
    const extra = recent - prior;
    const share = option.assumptions?.[0]?.range || [0, 0];
    return [{ metric: 'median_cycle_days', horizonDays: 60, scenario: 'chosen', option: option.key, mean: Math.round(recent - extra * ((share[0] + share[1]) / 2)), p10: Math.round(recent - extra * share[1]), p90: Math.round(recent - extra * share[0]) }];
  }
  if (decision.kind === 'SUPPLY_STOCKOUT') {
    const componentId = decision.affected_entities.find((e) => e.type === 'product')?.id;
    return [{ metric: 'stockout_occurred', horizonDays: 45, scenario: 'chosen', option: option.key, componentId, probability: option.futures.stockoutProbability }];
  }
  return [];
}

function criteriaFor(decision, option) {
  if (decision.kind === 'RECEIVABLE_RISK') {
    return {
      success: [{ metric: 'collected_amount', horizonDays: 60, operator: '>=', value: option.futures.cash60.p10, label: `At least ${Math.round(option.futures.cash60.p10)} collected within 60 days (the low end of the expected range)` }],
      failure: [{ metric: 'collected_amount', horizonDays: 60, operator: '<', value: option.futures.cash60.p10, label: 'Less than the low end of the expected range within 60 days' }],
      abort: [
        { key: 'dispute_opened', label: 'A dispute is opened on any invoice in this decision (collection stops)' },
        { key: 'paid_in_full', label: 'All invoices are paid (success, stop early)' },
        { key: 'exposure_drift', label: 'The collectable balance changes by more than 25% for another reason (re-plan)' },
      ],
    };
  }
  if (decision.kind === 'PROCESS_DEGRADATION') {
    const eo = expectedOutcomesFor(decision, option)[0];
    return {
      success: eo ? [{ metric: 'median_cycle_days', horizonDays: 60, operator: '<=', value: eo.p90, label: `Median collection cycle at or below ${eo.p90} days` }] : [],
      failure: eo ? [{ metric: 'median_cycle_days', horizonDays: 60, operator: '>', value: eo.p90, label: 'Cycle stays slower than the expected range' }] : [],
      abort: [{ key: 'volume_shift', label: 'Credit sales volume changes by more than 30%' }],
    };
  }
  return {
    success: [{ metric: 'stockout_occurred', horizonDays: 45, operator: '==', value: 0, label: 'No stockout of the component within 45 days' }],
    failure: [{ metric: 'stockout_occurred', horizonDays: 45, operator: '==', value: 1, label: 'Component stocks out' }],
    abort: [{ key: 'supplier_recovered', label: 'The supplier signal resolves before the order is needed' }],
  };
}

function rollbackPlanFor(option) {
  const steps = option.intent.type === 'COMPOSITE' ? option.intent.steps : [option.intent];
  return steps.map((s, i) => ({ step: i, intent: s.type, ...(ADAPTERS[s.type]?.rollbackDescription ? { how: ADAPTERS[s.type].rollbackDescription } : { how: 'Nothing to undo' }) }));
}

async function selectOption(pool, userId, decisionId, { optionKey, note }, ctx = {}) {
  const decision = await getDecision(pool, userId, decisionId);
  if (!decision) throw httpError(404, 'Decision not found');
  if (!['OPEN', 'NEEDS_INFORMATION', 'SELECTED'].includes(decision.status)) throw httpError(409, `Decision is ${decision.status}; an option can no longer be selected.`, { decisionStatus: decision.status });
  const option = decision.options.find((o) => o.key === optionKey);
  if (!option) throw httpError(400, 'Unknown option');
  if (!option.valid) throw httpError(422, `This option violates a hard constraint: ${option.invalidReason}`);

  const settings = await getSettings(pool, userId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lock = await client.query('SELECT status FROM decisions WHERE id = $1 AND user_id = $2 FOR UPDATE', [decisionId, userId]);
    if (!['OPEN', 'NEEDS_INFORMATION', 'SELECTED'].includes(lock.rows[0].status)) throw httpError(409, 'Decision changed while selecting; reload.');
    await client.query(`UPDATE decision_contracts SET status = 'SUPERSEDED', updated_at = NOW() WHERE decision_id = $1 AND user_id = $2 AND status = 'DRAFT'`, [decisionId, userId]);
    const crit = criteriaFor(decision, option);
    const rec = decision.recommendation || {};
    const rationale = {
      chosen: option.key,
      chosenLabel: option.label,
      recommendedByStarlane: rec.key,
      followsRecommendation: rec.key === option.key,
      why: rec.key === option.key ? rec.why : `Owner chose ${option.label} over the recommendation (${rec.label}).`,
      whyNot: (rec.whyNot || []).filter((w) => w.key !== option.key),
      wouldChangeIf: rec.wouldChangeIf || [],
      ownerNote: note ? String(note).slice(0, 1000) : null,
      informationAtDecisionTime: { asOf: decision.as_of, revision: decision.revision, confidence: decision.confidence, unknowns: (decision.unknowns || []).map((u) => u.label) },
      optionsAtDecisionTime: decision.options.map((o) => ({ key: o.key, value: typeof o.futures?.value === 'object' && o.futures.value ? o.futures.value.mean : (o.futures?.value ?? null), valid: o.valid })),
    };
    const reviewAt = decision.kind === 'RECEIVABLE_RISK' ? [7, 14, 30, 60, 90] : decision.kind === 'PROCESS_DEGRADATION' ? [30, 60] : [7, 14, 45];
    const res = await client.query(
      `INSERT INTO decision_contracts (user_id, decision_id, selected_option, mode, status, rationale, evidence_snapshot, assumptions, expected_outcomes,
                                       success_criteria, failure_criteria, abort_conditions, review_at, owner_user_id, allowed_actions, rollback_plan)
       VALUES ($1,$2,$3,$4,'DRAFT',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [userId, decisionId, option.key, settings.pilotMode, JSON.stringify(rationale), JSON.stringify(decision.evidence || []),
        JSON.stringify([...(decision.assumptions || [])]), JSON.stringify(expectedOutcomesFor(decision, option)),
        JSON.stringify(crit.success), JSON.stringify(crit.failure), JSON.stringify(crit.abort), JSON.stringify(reviewAt.map((d) => ({ afterDays: d }))),
        userId, JSON.stringify(option.intent.type === 'COMPOSITE' ? option.intent.steps.map((s) => s.type) : [option.intent.type]),
        JSON.stringify(rollbackPlanFor(option))]
    );
    await client.query(`UPDATE decisions SET status = 'SELECTED', selected_option = $3, decided_by = $4, updated_at = NOW() WHERE id = $1 AND user_id = $2`, [decisionId, userId, option.key, userId]);
    await appendEvent(client, { userId, decisionId, type: 'OPTION_SELECTED', actor: humanActor(userId), correlationId: ctx.correlationId, payload: { option: option.key, followsRecommendation: rationale.followsRecommendation, contractId: res.rows[0].id, mode: settings.pilotMode } });
    await client.query('COMMIT');
    return { contract: res.rows[0] };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function approveDecision(pool, userId, decisionId, { note } = {}, ctx = {}) {
  const decision = await getDecision(pool, userId, decisionId);
  if (!decision) throw httpError(404, 'Decision not found');
  if (decision.status !== 'SELECTED') throw httpError(409, decision.status === 'OPEN' ? 'Select an option before approving.' : `Decision is ${decision.status}.`, { decisionStatus: decision.status });
  const option = decision.options.find((o) => o.key === decision.selected_option);
  const upd = await pool.query(
    `UPDATE decisions SET status = 'APPROVED', updated_at = NOW() WHERE id = $1 AND user_id = $2 AND status = 'SELECTED' RETURNING id`,
    [decisionId, userId]
  );
  if (!upd.rows.length) throw httpError(409, 'Decision changed while approving; reload.');
  await pool.query(
    `UPDATE decision_contracts SET approvers = $3, updated_at = NOW() WHERE decision_id = $1 AND user_id = $2 AND status = 'DRAFT'`,
    [decisionId, userId, JSON.stringify([{ userId, role: 'owner', at: new Date().toISOString(), note: note ? String(note).slice(0, 500) : null }])]
  );
  await appendEvent(pool, { userId, decisionId, type: 'APPROVED', actor: humanActor(userId), correlationId: ctx.correlationId, policy: option.approval, payload: { option: option.key, note: note || null } });
  return { status: 'APPROVED' };
}

async function rejectDecision(pool, userId, decisionId, { reason } = {}, ctx = {}) {
  const decision = await getDecision(pool, userId, decisionId);
  if (!decision) throw httpError(404, 'Decision not found');
  if (!['OPEN', 'NEEDS_INFORMATION', 'SELECTED', 'APPROVED'].includes(decision.status)) throw httpError(409, `Decision is ${decision.status}.`);
  await pool.query(`UPDATE decisions SET status = 'REJECTED', resolution_reason = $3, resolved_at = NOW(), updated_at = NOW() WHERE id = $1 AND user_id = $2`, [decisionId, userId, reason ? String(reason).slice(0, 1000) : 'Rejected by owner']);
  await pool.query(`UPDATE decision_contracts SET status = 'ABORTED', updated_at = NOW() WHERE decision_id = $1 AND user_id = $2 AND status = 'DRAFT'`, [decisionId, userId]);
  await appendEvent(pool, { userId, decisionId, type: 'REJECTED', actor: humanActor(userId), correlationId: ctx.correlationId, payload: { reason: reason || null } });
  return { status: 'REJECTED' };
}

async function requestInformation(pool, userId, decisionId, { unknownKey, note } = {}, ctx = {}) {
  const decision = await getDecision(pool, userId, decisionId);
  if (!decision) throw httpError(404, 'Decision not found');
  const unknown = (decision.unknowns || []).find((u) => u.key === unknownKey) || (decision.unknowns || [])[0];
  if (!unknown) throw httpError(400, 'This decision has no open unknowns');
  const stops = await checkStops(pool, userId, { agentKey: AGENT.key, decisionId, actionClass: 'REQUEST_INFORMATION', connector: 'internal' });
  if (!stops.allowed) throw httpError(423, 'Stopped by a kill switch', { blockedBy: stops.blockedBy });
  const taskRes = await pool.query(
    `INSERT INTO tasks (user_id, title, description, related_entity_type, related_entity_id, priority, status, due_date, created_by)
     VALUES ($1,$2,$3,'decision',$4,$5,'open',$6,$1) RETURNING id, title, due_date`,
    [userId, `Find out: ${unknown.label}`.slice(0, 250), `${unknown.acquisition?.how || 'Confirm this fact'}${note ? `\n\nNote: ${String(note).slice(0, 500)}` : ''}\n\nStarlane decision: ${decision.title}`,
      decisionId, decision.urgency >= 0.7 ? 'high' : 'medium', decision.decision_deadline || null]
  );
  const request = { unknownKey: unknown.key, label: unknown.label, taskId: taskRes.rows[0].id, requestedAt: new Date().toISOString(), requestedBy: userId, valueOfInformation: unknown.valueOfInformation ?? null, status: 'OPEN' };
  await pool.query(
    `UPDATE decisions SET information_requests = information_requests || $3::jsonb, status = CASE WHEN status = 'OPEN' THEN 'NEEDS_INFORMATION' ELSE status END, updated_at = NOW() WHERE id = $1 AND user_id = $2`,
    [decisionId, userId, JSON.stringify([request])]
  );
  await appendEvent(pool, { userId, decisionId, type: 'INFORMATION_REQUESTED', actor: humanActor(userId), correlationId: ctx.correlationId, payload: request });
  return { request };
}

async function addObservation(pool, userId, decisionId, { text, confidence }, ctx = {}) {
  const decision = await getDecision(pool, userId, decisionId);
  if (!decision) throw httpError(404, 'Decision not found');
  const clean = String(text || '').trim().slice(0, 2000);
  if (!clean) throw httpError(400, 'Observation text is required');
  const conf = ['LOW', 'MEDIUM', 'HIGH'].includes(String(confidence).toUpperCase()) ? String(confidence).toUpperCase() : 'MEDIUM';
  // Stored as evidence from a named person. It is data: it never changes
  // options, policy or permissions, whatever it says.
  const ev = await appendEvent(pool, { userId, decisionId, type: 'HUMAN_OBSERVATION', actor: humanActor(userId), correlationId: ctx.correlationId, payload: { text: clean, confidence: conf, trust: 'HUMAN_OBSERVATION_UNVERIFIED' } });
  return { observation: { id: ev.id, text: clean, confidence: conf, author: userId, at: ev.created_at } };
}

// ── Action Fabric adapters ───────────────────────────────────────────────

const FIRM_REMINDER_TEMPLATE = (customerName, amountText, invoiceList) =>
  `Dear ${customerName}, our records show ${amountText} outstanding on invoice(s) ${invoiceList}, now past the due date. Please share a payment date this week, or let us know if anything on these invoices needs attention. Thank you.`;

const ADAPTERS = {
  HOLD_CREDIT: {
    adapter: 'internal.customer_credit_hold',
    connector: 'internal',
    external: false,
    rollbackDescription: 'Set advance payment required back to its previous value for this customer.',
    async preconditions(db, userId, step) {
      if (!step.customerId) return [{ check: 'customer_record', ok: false, detail: 'No customer record' }];
      const r = await db.query('SELECT id, advance_required FROM customers WHERE id::text = $1 AND user_id = $2', [String(step.customerId), userId]);
      if (!r.rows.length) return [{ check: 'customer_exists', ok: false, detail: 'Customer not found for this tenant' }];
      return [{ check: 'customer_exists', ok: true }, { check: 'not_already_on_hold', ok: !r.rows[0].advance_required, detail: r.rows[0].advance_required ? 'Credit is already on hold' : null }];
    },
    describe(step) { return { write: 'customers.advance_required = true', customerId: step.customerId }; },
    async execute(db, userId, step) {
      const prior = await db.query('SELECT advance_required FROM customers WHERE id::text = $1 AND user_id = $2', [String(step.customerId), userId]);
      await db.query('UPDATE customers SET advance_required = TRUE, updated_at = NOW() WHERE id::text = $1 AND user_id = $2', [String(step.customerId), userId]);
      return { result: { customerId: step.customerId }, rollback: { table: 'customers', id: step.customerId, field: 'advance_required', priorValue: prior.rows[0]?.advance_required ?? false } };
    },
    async postcondition(db, userId, step) {
      const r = await db.query('SELECT advance_required FROM customers WHERE id::text = $1 AND user_id = $2', [String(step.customerId), userId]);
      return { verified: r.rows[0]?.advance_required === true, observed: { advance_required: r.rows[0]?.advance_required } };
    },
    async compensate(db, userId, run) {
      await db.query('UPDATE customers SET advance_required = $3, updated_at = NOW() WHERE id::text = $1 AND user_id = $2', [String(run.rollback.id), userId, !!run.rollback.priorValue]);
    },
  },
  CONTACT_CUSTOMER: {
    adapter: 'ai_actions.prepare_contact',
    connector: 'messaging',
    external: true,
    rollbackDescription: 'Cancel the prepared message if it has not been sent. A sent message cannot be recalled.',
    async preconditions(db, userId, step, decision) {
      const customer = decision.affected_entities.find((e) => e.type === 'customer');
      const checks = [{ check: 'customer_named', ok: !!customer }];
      if (customer?.id) {
        const r = await db.query('SELECT escalation_paused FROM customers WHERE id::text = $1 AND user_id = $2', [String(customer.id), userId]);
        checks.push({ check: 'escalation_not_paused', ok: !r.rows[0]?.escalation_paused, detail: r.rows[0]?.escalation_paused ? 'Owner paused escalation for this customer' : null });
      }
      return checks;
    },
    describe(step, decision) {
      const customer = decision.affected_entities.find((e) => e.type === 'customer');
      const invs = decision.affected_entities.filter((e) => e.type === 'invoice');
      return { write: 'ai_actions (SEND_FIRM_REMINDER, requires owner approval to send)', customer: customer?.name, invoices: invs.map((i) => i.number || i.id), channel: step.channel };
    },
    async execute(db, userId, step, decision) {
      const { validate } = require('../../services/orchestrator/policyGuard.service');
      const customer = decision.affected_entities.find((e) => e.type === 'customer');
      const invs = decision.affected_entities.filter((e) => e.type === 'invoice');
      const total = invs.reduce((s, i) => s + Number(i.outstanding || 0), 0);
      const amountText = `${decision.currency === 'INR' ? '₹' : `${decision.currency} `}${Math.round(total).toLocaleString('en-IN')}`;
      const message = FIRM_REMINDER_TEMPLATE(customer?.name || 'Customer', amountText, invs.map((i) => i.number || i.id.slice(0, 8)).join(', '));
      const spec = await validate({
        action_type: 'SEND_FIRM_REMINDER',
        title: `Firm reminder: ${customer?.name}`,
        description: `Prepared by Starlane decision "${decision.title}".`,
        customer_id: customer?.id && /^[0-9a-f-]{36}$/i.test(customer.id) ? customer.id : undefined,
        recommended_message: message,
        risk_level: 'high',
        requires_approval: true,
      }, userId);
      if (spec.status === 'system_blocked') throw Object.assign(new Error(`Policy guard blocked the message: ${spec.block_reason}`), { definite: true });
      const oldest = invs[0];
      const r = await db.query(
        `INSERT INTO ai_actions (user_id, action_type, title, description, priority, related_entity_type, related_entity_id, customer_id, status, suggested_by,
                                 reason_json, recommended_message, risk_level, requires_approval, decision_id, parameters)
         VALUES ($1,'SEND_FIRM_REMINDER',$2,$3,'urgent','invoice',$4,$5,'pending','agent',$6,$7,'high',true,$8,$9) RETURNING id`,
        [userId, spec.title, spec.description, oldest?.id || null, spec.customer_id || null,
          JSON.stringify({ decisionId: decision.id, agent: AGENT.key, agentVersion: AGENT.version }), message, decision.id,
          JSON.stringify({ channel: step.channel, invoices: invs.map((i) => i.id) })]
      );
      return { result: { aiActionId: r.rows[0].id, message, sendsAfter: 'owner approval in Control > Approvals; external sending must also be switched on' }, rollback: { table: 'ai_actions', id: r.rows[0].id, cancelIfStatus: ['pending'] }, aiActionId: r.rows[0].id };
    },
    async postcondition(db, userId, step, decision, exec) {
      const r = await db.query('SELECT status FROM ai_actions WHERE id = $1 AND user_id = $2', [exec.aiActionId, userId]);
      return { verified: r.rows.length === 1, observed: { aiActionStatus: r.rows[0]?.status }, note: 'Prepared, not sent. Delivery is verified separately by the messaging pipeline.' };
    },
    async compensate(db, userId, run) {
      await db.query(`UPDATE ai_actions SET status = 'cancelled', updated_at = NOW() WHERE id = $1 AND user_id = $2 AND status = 'pending'`, [run.rollback.id, userId]);
    },
  },
  OFFER_PAYMENT_PLAN: {
    adapter: 'internal.payment_plan_draft',
    connector: 'internal',
    external: false,
    rollbackDescription: 'Cancel the proposed plan.',
    async preconditions() { return [{ check: 'plan_is_proposal', ok: true, detail: 'Plan is recorded as proposed; the customer must agree' }]; },
    describe(step, decision) {
      const total = decision.affected_entities.filter((e) => e.type === 'invoice').reduce((s, i) => s + Number(i.outstanding || 0), 0);
      return { write: 'payment_plans (status proposed)', installments: step.installments, total };
    },
    async execute(db, userId, step, decision) {
      const customer = decision.affected_entities.find((e) => e.type === 'customer');
      const invs = decision.affected_entities.filter((e) => e.type === 'invoice');
      const total = invs.reduce((s, i) => s + Number(i.outstanding || 0), 0);
      const today = startOfUtcDay(Date.now());
      const per = Math.round((total / step.installments) * 100) / 100;
      const installments = Array.from({ length: step.installments }, (_, k) => ({ n: k + 1, due: toIsoDate(addDays(today, step.intervalDays * (k + 1))), amount: k === step.installments - 1 ? Math.round((total - per * (step.installments - 1)) * 100) / 100 : per }));
      const r = await db.query(
        `INSERT INTO payment_plans (user_id, invoice_id, customer_name, total_amount, installments, status, notes) VALUES ($1,$2,$3,$4,$5,'proposed',$6) RETURNING id`,
        [userId, invs[0]?.id || null, customer?.name || null, total, JSON.stringify(installments), `Proposed by Starlane decision ${decision.id}. Covers ${invs.length} invoice(s).`]
      );
      return { result: { paymentPlanId: r.rows[0].id, installments }, rollback: { table: 'payment_plans', id: r.rows[0].id } };
    },
    async postcondition(db, userId, step, decision, exec) {
      const r = await db.query('SELECT status FROM payment_plans WHERE id = $1 AND user_id = $2', [exec.result.paymentPlanId, userId]);
      return { verified: r.rows[0]?.status === 'proposed', observed: r.rows[0] || null };
    },
    async compensate(db, userId, run) {
      await db.query(`UPDATE payment_plans SET status = 'cancelled', updated_at = NOW() WHERE id = $1 AND user_id = $2`, [run.rollback.id, userId]);
    },
  },
  CREATE_DUNNING_RULES: {
    adapter: 'internal.dunning_rules',
    connector: 'internal',
    // Treated as external: enabled WhatsApp rules are picked up by the
    // legacy dunning cron, which sends on its own once sending is switched
    // on. So these rules can only be created when the tenant is live, never
    // by a one-off "authorise live" while the tenant is in shadow mode.
    external: true,
    rollbackDescription: 'Disable the reminder rules Starlane created.',
    async preconditions() { return [{ check: 'rules_only', ok: true, detail: 'Creates rules; sends stay gated by the external-send policy' }]; },
    describe(step) { return { write: 'dunning_rules', rules: step.rules }; },
    async execute(db, userId, step, decision) {
      const ids = [];
      for (const rule of step.rules) {
        const r = await db.query(`INSERT INTO dunning_rules (user_id, name, trigger_day, action, tone, enabled) VALUES ($1,$2,$3,'whatsapp',$4,true) RETURNING id`, [userId, `Starlane cadence (${decision.id.slice(0, 8)}) day ${rule.trigger_day}`, rule.trigger_day, rule.tone]);
        ids.push(r.rows[0].id);
      }
      return { result: { ruleIds: ids }, rollback: { table: 'dunning_rules', ids } };
    },
    async postcondition(db, userId, step, decision, exec) {
      const r = await db.query('SELECT COUNT(*)::int AS n FROM dunning_rules WHERE user_id = $1 AND id = ANY($2) AND enabled', [userId, exec.result.ruleIds]);
      return { verified: r.rows[0].n === exec.result.ruleIds.length, observed: { enabledRules: r.rows[0].n } };
    },
    async compensate(db, userId, run) {
      await db.query('UPDATE dunning_rules SET enabled = false WHERE user_id = $1 AND id = ANY($2)', [userId, run.rollback.ids]);
    },
  },
  CHANGE_PAYMENT_TERMS: {
    adapter: 'internal.customer_terms',
    connector: 'internal',
    external: false,
    rollbackDescription: 'Restore each customer\'s previous default payment terms.',
    async preconditions() { return [{ check: 'new_invoices_only', ok: true, detail: 'Existing invoices keep their due dates' }]; },
    describe(step) { return { write: 'customers.default_payment_terms', customers: step.customers, deltaDays: step.deltaDays }; },
    async execute(db, userId, step, decision) {
      const names = decision.affected_entities.filter((e) => e.type === 'customer').map((e) => e.name);
      const prior = await db.query('SELECT id, default_payment_terms FROM customers WHERE user_id = $1 AND lower(trim(name)) = ANY($2)', [userId, names.map((n) => n.trim().toLowerCase())]);
      for (const c of prior.rows) {
        const current = c.default_payment_terms == null ? 30 : Number(c.default_payment_terms);
        await db.query('UPDATE customers SET default_payment_terms = $3, updated_at = NOW() WHERE id = $1 AND user_id = $2', [c.id, userId, Math.max(0, current + step.deltaDays)]);
      }
      return { result: { customersChanged: prior.rows.length }, rollback: { table: 'customers', prior: prior.rows.map((c) => ({ id: c.id, default_payment_terms: c.default_payment_terms })) } };
    },
    async postcondition(db, userId, step, decision, exec) {
      return { verified: exec.result.customersChanged > 0, observed: exec.result };
    },
    async compensate(db, userId, run) {
      for (const c of run.rollback.prior) await db.query('UPDATE customers SET default_payment_terms = $3 WHERE id = $1 AND user_id = $2', [c.id, userId, c.default_payment_terms]);
    },
  },
  CREATE_PO: {
    adapter: 'supply_chain.execution_adapter',
    connector: 'erp',
    external: false,
    rollbackDescription: 'Cancel the draft purchase order before it is sent to the supplier.',
    async preconditions(db, userId, step) {
      const r = await db.query('SELECT id FROM business_signals WHERE id = $1 AND user_id = $2', [step.signalId, userId]);
      return [{ check: 'signal_exists', ok: r.rows.length === 1 }];
    },
    describe(step) { return { write: 'purchase_orders (draft, demo ERP adapter)', componentId: step.componentId, intervention: step.intervention }; },
    async execute(db, userId, step) {
      const { getSignalImpact, createRecommendedActions } = require('../intelligence/supplyChainOrchestrator');
      const { executeSupplyChainAction } = require('../automation/supplyChainExecutionAdapter');
      const impact = await getSignalImpact(step.signalId, userId);
      const actions = await createRecommendedActions(userId, step.signalId, impact);
      const action = actions.find((a) => a.reason_json?.componentId === step.componentId);
      if (!action) throw Object.assign(new Error('No reorder quantity could be computed for this component (missing stock, demand or lead time).'), { definite: true });
      await db.query(`UPDATE ai_actions SET status='approved', approved_by=$1, approved_at=NOW(), updated_at=NOW() WHERE id=$2 AND user_id=$1 AND status='pending'`, [userId, action.id]);
      const exec = await executeSupplyChainAction(userId, action);
      await db.query(`UPDATE ai_actions SET status='done', completed_at=NOW(), updated_at=NOW(), decision_id = COALESCE(decision_id, $3) WHERE id=$1 AND user_id=$2`, [action.id, userId, step.decisionId || null]);
      return { result: { aiActionId: action.id, purchaseOrderId: exec.purchaseOrder?.id || null, mode: exec.mode, liveExternalWriteOccurred: exec.liveExternalWriteOccurred }, rollback: { table: 'purchase_orders', id: exec.purchaseOrder?.id || null }, aiActionId: action.id };
    },
    async postcondition(db, userId, step, decision, exec) {
      if (!exec.result.purchaseOrderId) return { verified: false, observed: null };
      const r = await db.query('SELECT status FROM purchase_orders WHERE id = $1 AND user_id = $2', [exec.result.purchaseOrderId, userId]);
      return { verified: r.rows.length === 1, observed: r.rows[0] || null };
    },
    async compensate(db, userId, run) {
      if (run.rollback.id) await db.query(`UPDATE purchase_orders SET status = 'cancelled' WHERE id = $1 AND user_id = $2`, [run.rollback.id, userId]);
    },
  },
};

// ── Execution ────────────────────────────────────────────────────────────

function idemKey(decisionId, contractId, step, intent, mode) {
  return crypto.createHash('sha256').update(`${decisionId}|${contractId}|${step}|${intent}|${mode}`).digest('hex');
}

// Re-derives the live state and checks the world has not materially changed
// since the decision was analysed.
async function worldStillCurrent(pool, userId, decision, defs) {
  if (decision.kind !== 'RECEIVABLE_RISK') return { ok: true, checks: [{ check: 'state_current', ok: true, detail: 'No live re-check defined for this decision kind' }] };
  const raw = await loadRawReceivables(pool, userId);
  const state = deriveReceivablesState(raw, new Date().toISOString(), { mode: 'live', baseCurrency: defs.base_currency });
  const ids = new Set(decision.affected_entities.filter((e) => e.type === 'invoice').map((e) => e.id));
  const now = state.invoices.filter((i) => ids.has(i.id));
  const before = Number(decision.materiality?.exposure || 0);
  const current = now.filter((i) => !i.disputeOpen).reduce((s, i) => s + i.outstanding, 0);
  const disputed = now.filter((i) => i.disputeOpen);
  const drift = before > 0 ? Math.abs(current - before) / before : 0;
  const checks = [
    { check: 'invoices_still_open', ok: current > 0, detail: current > 0 ? null : 'Every invoice in this decision has been paid or removed' },
    { check: 'no_new_disputes', ok: disputed.length === 0, detail: disputed.length ? `${disputed.length} invoice(s) now disputed` : null },
    { check: 'exposure_within_25pct', ok: drift <= 0.25, detail: `Collectable balance then ${Math.round(before)}, now ${Math.round(current)}` },
  ];
  return { ok: checks.every((c) => c.ok), checks, currentExposure: current };
}

async function executeDecision(pool, userId, decisionId, { authorizeLive = false } = {}, ctx = {}) {
  const decision = await getDecision(pool, userId, decisionId);
  if (!decision) throw httpError(404, 'Decision not found');
  const option = decision.options.find((o) => o.key === decision.selected_option);
  const isDoNothing = option && option.isDoNothing;
  if (!(decision.status === 'APPROVED' || (decision.status === 'SELECTED' && isDoNothing))) {
    throw httpError(409, decision.status === 'SELECTED' ? 'This option needs owner approval before it can run.' : `Decision is ${decision.status}; nothing to execute.`, { decisionStatus: decision.status });
  }
  const contractRes = await pool.query(`SELECT * FROM decision_contracts WHERE decision_id = $1 AND user_id = $2 AND status = 'DRAFT' ORDER BY created_at DESC LIMIT 1`, [decisionId, userId]);
  const contract = contractRes.rows[0];
  if (!contract) throw httpError(409, 'No draft contract for this decision; select an option again.');

  const settings = await getSettings(pool, userId);
  const steps = isDoNothing ? [] : option.intent.type === 'COMPOSITE' ? option.intent.steps : [option.intent];
  // Shadow unless the tenant is LIVE, or the owner explicitly authorised this
  // one execution AND every step is internal and reversible.
  const allInternal = steps.every((s) => ADAPTERS[s.type] && !ADAPTERS[s.type].external);
  let mode = settings.pilotMode;
  if (mode === 'SHADOW' && authorizeLive) {
    if (!allInternal) throw httpError(422, 'Only internal, reversible actions can be individually authorised in shadow mode. Messages to customers need the tenant in live mode.');
    mode = 'LIVE';
  }

  const stopChecks = [];
  for (const [i, s] of steps.entries()) {
    const a = ADAPTERS[s.type];
    if (!a) throw httpError(422, `No adapter implements ${s.type}`);
    const st = await checkStops(pool, userId, { agentKey: AGENT.key, decisionId, actionClass: s.type, connector: a.connector });
    stopChecks.push({ step: i, ...st });
  }
  const tenantStop = await checkStops(pool, userId, { decisionId });
  const blocked = [...stopChecks.filter((s) => !s.allowed).flatMap((s) => s.blockedBy), ...tenantStop.blockedBy];
  if (blocked.length) {
    await appendEvent(pool, { userId, decisionId, type: 'EXECUTION_BLOCKED', actor: humanActor(userId), correlationId: ctx.correlationId, policy: { killSwitches: blocked }, payload: { mode } });
    for (const [i, s] of steps.entries()) {
      await pool.query(
        `INSERT INTO decision_action_runs (user_id, decision_id, contract_id, step_index, intent_type, adapter, connector, idempotency_key, mode, status, error, delegation_chain)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'BLOCKED',$10,$11) ON CONFLICT (user_id, idempotency_key) DO NOTHING`,
        [userId, decisionId, contract.id, i, s.type, ADAPTERS[s.type].adapter, ADAPTERS[s.type].connector, `${idemKey(decisionId, contract.id, i, s.type, mode)}:blocked:${Date.now()}`, mode,
          blocked.map((b) => b.reason).join('; '), JSON.stringify(delegationChain(userId, s))]
      );
    }
    throw httpError(423, 'Execution is stopped by a kill switch', { blockedBy: blocked });
  }

  // A real (LIVE) action is never taken on a stale ledger: the balances the
  // decision relied on may already be wrong. Shadow runs change nothing, so
  // they still go ahead and record what Starlane would have done.
  if (mode === 'LIVE' && steps.length) {
    const freshness = await receivablesFreshness(pool, userId, settings.definitions);
    if (freshness.status === 'STALE') {
      await appendEvent(pool, { userId, decisionId, type: 'EXECUTION_BLOCKED', actor: humanActor(userId), correlationId: ctx.correlationId, policy: { staleData: freshness }, payload: { mode } });
      throw httpError(409, `Your books have not been updated for ${Math.round(freshness.ageHours / 24)} days, so Starlane will not act on them. Sync Tally or upload a fresh file, then try again.`, { staleData: true, freshness });
    }
  }

  const current = await worldStillCurrent(pool, userId, decision, settings.definitions);
  if (!current.ok) {
    await pool.query(`UPDATE decisions SET status = 'OPEN', updated_at = NOW() WHERE id = $1 AND user_id = $2`, [decisionId, userId]);
    await pool.query(`UPDATE decision_contracts SET status = 'SUPERSEDED', updated_at = NOW() WHERE id = $1 AND user_id = $2`, [contract.id, userId]);
    await appendEvent(pool, { userId, decisionId, type: 'REPLAN_REQUIRED', actor: agentActor(userId), correlationId: ctx.correlationId, payload: { checks: current.checks } });
    throw httpError(409, 'The situation changed since this decision was analysed. It has been reopened for a fresh look.', { checks: current.checks, replanRequired: true });
  }

  const client = await pool.connect();
  const runs = [];
  try {
    const lock = await client.query(`UPDATE decisions SET status = 'EXECUTING', updated_at = NOW() WHERE id = $1 AND user_id = $2 AND status IN ('APPROVED','SELECTED') RETURNING id`, [decisionId, userId]);
    if (!lock.rows.length) throw httpError(409, 'Another request is already executing this decision.');
    await appendEvent(client, { userId, decisionId, type: 'EXECUTION_STARTED', actor: humanActor(userId), correlationId: ctx.correlationId, policy: { pilotMode: settings.pilotMode, mode, authorizeLive: !!authorizeLive, killSwitches: 'clear', approval: option.approval, preconditions: current.checks }, payload: { option: option.key, steps: steps.map((s) => s.type) } });

    let failure = null;
    for (const [i, step] of steps.entries()) {
      const a = ADAPTERS[step.type];
      const key = idemKey(decisionId, contract.id, i, step.type, mode);
      const prior = await client.query('SELECT * FROM decision_action_runs WHERE user_id = $1 AND idempotency_key = $2', [userId, key]);
      if (prior.rows.length) {
        const p = prior.rows[0];
        if (['SUCCEEDED', 'PREPARED', 'SHADOWED'].includes(p.status)) { runs.push({ ...p, duplicateSuppressed: true }); continue; }
        if (p.status === 'EXECUTING' || p.status === 'UNKNOWN') { failure = { step: i, error: 'A previous attempt of this step ended in an unknown state. Check the target system before retrying.', run: p }; break; }
      }
      const pre = await a.preconditions(client, userId, step, decision);
      const chain = delegationChain(userId, step);
      if (!pre.every((c) => c.ok)) {
        failure = { step: i, error: `Precondition failed: ${pre.filter((c) => !c.ok).map((c) => c.detail || c.check).join('; ')}`, pre };
        await upsertRun(client, { userId, decisionId, contractId: contract.id, i, step, a, key, mode, status: 'FAILED', pre, chain, error: failure.error });
        break;
      }
      if (mode === 'SHADOW') {
        const run = await upsertRun(client, { userId, decisionId, contractId: contract.id, i, step, a, key, mode, status: 'SHADOWED', pre, chain, wouldHave: a.describe({ ...step, decisionId }, decision) });
        runs.push(run);
        continue;
      }
      await upsertRun(client, { userId, decisionId, contractId: contract.id, i, step, a, key, mode, status: 'EXECUTING', pre, chain });
      try {
        const exec = await a.execute(client, userId, { ...step, decisionId }, decision);
        const post = await a.postcondition(client, userId, step, decision, exec);
        const status = !post.verified ? 'UNKNOWN' : step.type === 'CONTACT_CUSTOMER' ? 'PREPARED' : 'SUCCEEDED';
        const run = await upsertRun(client, { userId, decisionId, contractId: contract.id, i, step, a, key, mode, status, pre, chain, result: exec.result, post, rollback: exec.rollback, aiActionId: exec.aiActionId });
        runs.push(run);
        if (!post.verified) { failure = { step: i, error: 'The adapter reported success but the target system does not show the change.' }; break; }
      } catch (err) {
        const ambiguous = !err.definite && /timeout|ETIMEDOUT|ECONNRESET|unknown/i.test(String(err.message));
        await upsertRun(client, { userId, decisionId, contractId: contract.id, i, step, a, key, mode, status: ambiguous ? 'UNKNOWN' : 'FAILED', pre, chain, error: String(err.message).slice(0, 2000) });
        failure = { step: i, error: String(err.message) };
        break;
      }
    }

    if (failure) {
      // Compensate completed steps in reverse order. Distributed steps are
      // not atomic; this makes the partial state explicit and undone.
      const compensated = [];
      for (const run of runs.slice().reverse()) {
        if (!['SUCCEEDED', 'PREPARED'].includes(run.status) || run.duplicateSuppressed) continue;
        const a = ADAPTERS[run.intent_type];
        try {
          await a.compensate(client, userId, run);
          await client.query(`UPDATE decision_action_runs SET status = 'COMPENSATED', updated_at = NOW() WHERE id = $1 AND user_id = $2`, [run.id, userId]);
          compensated.push({ step: run.step_index, intent: run.intent_type });
        } catch (err) {
          compensated.push({ step: run.step_index, intent: run.intent_type, compensationFailed: String(err.message) });
        }
      }
      await client.query(`UPDATE decisions SET status = 'APPROVED', updated_at = NOW() WHERE id = $1 AND user_id = $2`, [decisionId, userId]);
      await appendEvent(client, { userId, decisionId, type: 'EXECUTION_FAILED', actor: agentActor(userId), correlationId: ctx.correlationId, payload: { failure: { step: failure.step, error: failure.error }, compensated } });
      safeLog('warn', '[decisions] execution failed and compensated', { userId, decisionId, correlationId: ctx.correlationId, step: failure.step, compensated: compensated.length });
      throw httpError(502, failure.error, { failedStep: failure.step, compensated });
    }

    const activatedAt = new Date();
    const baseline = { observedAt: activatedAt.toISOString(), exposure: current.currentExposure ?? null, mode };
    await client.query(
      `UPDATE decision_contracts SET status = 'ACTIVE', mode = $3, activated_at = $4, baseline = $5, updated_at = NOW() WHERE id = $1 AND user_id = $2`,
      [contract.id, userId, mode, activatedAt.toISOString(), JSON.stringify(baseline)]
    );
    await writeContractPredictions(client, userId, contract, decision, activatedAt, mode);
    const newStatus = mode === 'SHADOW' && steps.length ? 'SHADOWED' : 'EXECUTED';
    await client.query(`UPDATE decisions SET status = $3, updated_at = NOW() WHERE id = $1 AND user_id = $2`, [decisionId, userId, newStatus]);
    await appendEvent(client, { userId, decisionId, type: mode === 'SHADOW' ? 'SHADOW_RECORDED' : 'EXECUTION_COMPLETED', actor: agentActor(userId), correlationId: ctx.correlationId, payload: { mode, runs: runs.map((r) => ({ step: r.step_index, intent: r.intent_type, status: r.status, duplicateSuppressed: !!r.duplicateSuppressed })), contractId: contract.id } });
    return { mode, status: newStatus, contractId: contract.id, runs };
  } catch (err) {
    if (!err.status) {
      await pool.query(`UPDATE decisions SET status = 'APPROVED', updated_at = NOW() WHERE id = $1 AND user_id = $2 AND status = 'EXECUTING'`, [decisionId, userId]).catch(() => {});
    }
    throw err;
  } finally {
    client.release();
  }
}

function delegationChain(userId, step) {
  const a = ADAPTERS[step.type];
  return [
    { type: 'human', id: String(userId), role: 'approver' },
    { type: 'agent', id: AGENT.key, version: AGENT.version, model: AGENT.model, role: 'proposed and orchestrated' },
    { type: 'adapter', id: a?.adapter || 'none', connector: a?.connector || null },
    { type: 'system', id: a ? a.describe(step, { affected_entities: [] }).write || a.connector : null },
  ];
}

async function upsertRun(db, { userId, decisionId, contractId, i, step, a, key, mode, status, pre, chain, wouldHave = null, result = null, post = null, rollback = null, aiActionId = null, error = null }) {
  const res = await db.query(
    `INSERT INTO decision_action_runs (user_id, decision_id, contract_id, step_index, intent_type, adapter, connector, idempotency_key, mode, status,
                                       preconditions, would_have, result, postcondition, rollback, ai_action_id, delegation_chain, error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     ON CONFLICT (user_id, idempotency_key) DO UPDATE SET status = EXCLUDED.status, result = COALESCE(EXCLUDED.result, decision_action_runs.result),
       postcondition = COALESCE(EXCLUDED.postcondition, decision_action_runs.postcondition), rollback = COALESCE(EXCLUDED.rollback, decision_action_runs.rollback),
       ai_action_id = COALESCE(EXCLUDED.ai_action_id, decision_action_runs.ai_action_id), error = EXCLUDED.error, updated_at = NOW()
     RETURNING *`,
    [userId, decisionId, contractId, i, step.type, a.adapter, a.connector, key, mode, status, JSON.stringify(pre || []), wouldHave ? JSON.stringify(wouldHave) : null,
      result ? JSON.stringify(result) : null, post ? JSON.stringify(post) : null, rollback ? JSON.stringify(rollback) : null, aiActionId, JSON.stringify(chain || []), error]
  );
  return res.rows[0];
}

async function writeContractPredictions(db, userId, contract, decision, activatedAt, mode) {
  // Idempotent: a retried execution of the same contract does not duplicate
  // its forecasts.
  const existing = await db.query(`SELECT 1 FROM predictions WHERE user_id = $1 AND entity_type = 'decision_contract' AND entity_id = $2 LIMIT 1`, [userId, String(contract.id)]);
  if (existing.rows.length) return;
  for (const eo of contract.expected_outcomes || []) {
    const point = eo.metric === 'stockout_occurred' ? eo.probability : eo.mean;
    await db.query(
      `INSERT INTO predictions (user_id, entity_type, entity_id, target, prediction_type, as_of, horizon_days, point_estimate, lower_bound, upper_bound,
                                model_name, model_version, baseline_model, assumptions, evidence, uncertainty_band, data_quality)
       VALUES ($1,'decision_contract',$2,$3,$4,$5,$6,$7,$8,$9,'starlane.decision_engine',$10,$11,$12,$13,'p10-p90',$14)`,
      [userId, contract.id, `${eo.metric}:${eo.scenario}`, eo.metric === 'stockout_occurred' ? 'probability' : 'simulated_interval', activatedAt.toISOString(), eo.horizonDays, point,
        eo.p10 ?? null, eo.p90 ?? null, decision.model_versions?.engine || AGENT.version, eo.scenario,
        JSON.stringify({ option: eo.option, mode, decisionId: decision.id }), JSON.stringify({ invoiceIds: eo.invoiceIds || null, componentId: eo.componentId || null }),
        decision.confidence?.band || null]
    );
  }
}

module.exports = { selectOption, approveDecision, rejectDecision, requestInformation, addObservation, executeDecision, ADAPTERS, expectedOutcomesFor };
