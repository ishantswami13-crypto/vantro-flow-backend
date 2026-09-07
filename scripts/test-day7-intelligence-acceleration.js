// Integration test (real Neon dev DB, process.env.DATABASE_URL) for Day 7
// Intelligence Acceleration: contextAssembly, cashRiskNarrative,
// fxExposureNarrative, evidenceExplorer, priorityScoring.
//
// Creates clearly-labeled synthetic fixture rows (tenant/customer/invoices/
// payment_allocations/customer_scores/customer_score_history, and one
// business_exposure+world_event pair for the FX scenario since no real
// matching pair exists in the DB today — confirmed by direct query before
// writing this test) and DELETES them all at the end, verifying zero
// residue.
require('dotenv').config();
const { randomUUID } = require('crypto');
const { supabase } = require('../lib/config/supabaseClient');
const { assembleEntityContext } = require('../lib/domain/intelligence/contextAssembly');
const { buildCashRiskNarrative } = require('../lib/domain/intelligence/cashRiskNarrative');
const { buildFxExposureNarrative } = require('../lib/domain/intelligence/fxExposureNarrative');
const { getInsightEvidence } = require('../lib/domain/intelligence/evidenceExplorer');
const { computePriorityScore } = require('../lib/domain/intelligence/priorityScoring');

let pass = 0, fail = 0;
function check(label, cond) {
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  cond ? pass++ : fail++;
}

const TENANT_A = randomUUID();
const TENANT_B = randomUUID(); // second tenant for isolation checks
const cleanup = []; // { table, filter }

async function del(table, column, value) {
  await supabase.from(table).delete().eq(column, value);
}

// Sweep any orphaned fixture rows left behind by a previous interrupted
// (crashed/killed) run of this script, BEFORE creating this run's fixtures.
// Scoped tightly to this test's own fixture markers only:
//   - users.email LIKE 'day7-test-%@test.starlane.local' (this script is the
//     only writer of that email pattern)
//   - world_events/world_event_entities/business_exposure rows carrying the
//     literal 'Day7 test fixture' marker this script stamps into
//     title/evidence_notes (see the FX fixture below)
// Never touches any row without one of these exact markers, so it cannot
// reach real production-shaped data.
async function sweepOrphanedFixtures() {
  const { data: orphanedUsers } = await supabase
    .from('users')
    .select('id')
    .like('email', 'day7-test-%@test.starlane.local');
  const orphanedUserIds = (orphanedUsers || []).map(u => u.id);
  if (orphanedUserIds.length) {
    console.log(`(residue sweep) found ${orphanedUserIds.length} orphaned fixture user(s) from a previous run — cleaning up first`);
  }
  for (const uid of orphanedUserIds) {
    // Children first (FK order), same tables this script itself fixtures.
    for (const table of [
      'payment_allocations', 'customer_score_history', 'customer_scores',
      'invoices', 'sales', 'business_exposure', 'suppliers', 'customers',
    ]) {
      try { await del(table, 'user_id', uid); } catch (e) { /* table may not have user_id or no rows — ignore */ }
    }
    try { await del('users', 'id', uid); } catch (e) { /* ignore */ }
  }

  // Orphaned FX-narrative world_events/business_exposure fixtures, marked by
  // the literal title/evidence_notes prefix this script always uses.
  const { data: orphanedEvents } = await supabase
    .from('world_events')
    .select('id')
    .like('title', 'Day7 test fixture%');
  for (const ev of orphanedEvents || []) {
    try { await del('world_event_entities', 'event_id', ev.id); } catch (e) { /* ignore */ }
    try { await del('world_events', 'id', ev.id); } catch (e) { /* ignore */ }
  }
  try {
    await supabase.from('business_exposure').delete().like('evidence_notes', 'Day7 test fixture%');
  } catch (e) { /* ignore */ }
}

async function main() {
  console.log('=== Day 7 Intelligence Acceleration — real-DB tests ===');
  console.log('Tenant A (fixture):', TENANT_A);

  await sweepOrphanedFixtures();

  // Fixture tenants themselves (users table FK requirement) — created and
  // torn down alongside every other fixture row.
  await supabase.from('users').insert({ id: TENANT_A, email: `day7-test-a-${TENANT_A}@test.starlane.local` });
  await supabase.from('users').insert({ id: TENANT_B, email: `day7-test-b-${TENANT_B}@test.starlane.local` });
  cleanup.push(['users', 'id', TENANT_A], ['users', 'id', TENANT_B]);

  // ---------------------------------------------------------------------
  // Fixture: Customer A / Company B scenario (concentration + payer
  // dependency + 2-point deteriorating trajectory), tenant A.
  // ---------------------------------------------------------------------
  const customerAId = randomUUID();
  await supabase.from('customers').insert({ id: customerAId, user_id: TENANT_A, name: 'Day7 Customer A', phone: '9990001111' });

  const invoiceId = randomUUID();
  await supabase.from('invoices').insert({
    id: invoiceId, user_id: TENANT_A, customer_id: customerAId, customer_name: 'Day7 Customer A',
    invoice_amount: 900000, payment_status: 'Unpaid', days_overdue: 20,
    invoice_date: new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10),
    due_date: new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10),
  });
  // A small "everyone else" invoice so tenant-wide revenue isn't 100% this customer's sales.
  const otherCustomerId = randomUUID();
  await supabase.from('customers').insert({ id: otherCustomerId, user_id: TENANT_A, name: 'Day7 Customer Other' });

  // sales rows feed revenueIntelligence's concentration computation
  const saleAId = randomUUID();
  const saleOtherId = randomUUID();
  // sales.id is bigint/auto-increment — do not set it; capture the generated id via .select().
  const s1 = await supabase.from('sales').insert({ user_id: TENANT_A, customer_id: customerAId, customer_name: 'Day7 Customer A', amount: 900000, sale_date: new Date().toISOString().slice(0, 10), status: 'unpaid' }).select();
  const s2 = await supabase.from('sales').insert({ user_id: TENANT_A, customer_id: otherCustomerId, customer_name: 'Day7 Customer Other', amount: 100000, sale_date: new Date().toISOString().slice(0, 10), status: 'paid' }).select();
  if (s1.error || s2.error) console.log('FIXTURE INSERT ERROR (sales)', s1.error, s2.error);
  const realSaleAId = s1.data?.[0]?.id;
  const realSaleOtherId = s2.data?.[0]?.id;

  // 2-point deteriorating customer_score_history (honest: exactly 2 rows)
  const histOldId = randomUUID();
  const histNewId = randomUUID();
  await supabase.from('customer_score_history').insert({ id: histOldId, user_id: TENANT_A, customer_id: customerAId, credit_risk_score: 40, recorded_at: new Date(Date.now() - 20 * 86400000).toISOString() });
  await supabase.from('customer_score_history').insert({ id: histNewId, user_id: TENANT_A, customer_id: customerAId, credit_risk_score: 78, recorded_at: new Date().toISOString() });
  await supabase.from('customer_scores').insert({ id: randomUUID(), user_id: TENANT_A, customer_id: customerAId, credit_risk_score: 78, collection_priority_score: 90 });

  // Company B pays on behalf of Customer A twice, confirmed — observational payer pattern
  const alloc1 = randomUUID(), alloc2 = randomUUID();
  const a1r = await supabase.from('payment_allocations').insert({
    id: alloc1, user_id: TENANT_A, invoice_id: invoiceId, payer_reference: 'Day7 Company B', payer_type: 'THIRD_PARTY',
    amount: 400000, allocation_status: 'CONFIRMED', confirmed_at: new Date().toISOString(),
  });
  const a2r = await supabase.from('payment_allocations').insert({
    id: alloc2, user_id: TENANT_A, invoice_id: invoiceId, payer_reference: 'Day7 Company B', payer_type: 'THIRD_PARTY',
    amount: 200000, allocation_status: 'CONFIRMED', confirmed_at: new Date().toISOString(),
  });
  if (a1r.error || a2r.error) console.log('FIXTURE INSERT ERROR (allocations)', a1r.error, a2r.error);

  cleanup.push(['payment_allocations', 'id', alloc1], ['payment_allocations', 'id', alloc2]);
  cleanup.push(['customer_score_history', 'id', histOldId], ['customer_score_history', 'id', histNewId]);
  cleanup.push(['customer_scores', 'customer_id', customerAId]);
  if (realSaleAId != null) cleanup.push(['sales', 'id', realSaleAId]);
  if (realSaleOtherId != null) cleanup.push(['sales', 'id', realSaleOtherId]);
  cleanup.push(['invoices', 'id', invoiceId]);
  cleanup.push(['customers', 'id', customerAId], ['customers', 'id', otherCustomerId]);

  try {
    // -------------------------------------------------------------------
    // Scenario 1/2: cash-risk narrative — concentration + trajectory + payer dependency
    // -------------------------------------------------------------------
    const cashRisk = await buildCashRiskNarrative({ userId: TENANT_A, customerId: customerAId });
    console.log('\n--- cashRiskNarrative (Customer A / Company B) ---');
    console.log(JSON.stringify(cashRisk, null, 2));

    check('cashRisk: not insufficient evidence', cashRisk.insufficientEvidence === false);
    check('cashRisk: trajectory is DETERIORATING (2-point, honest)', cashRisk.observation.includes('deteriorating'));
    check('cashRisk: concentration risk flagged (90% share)', cashRisk.evidence.some(e => e.type === 'revenue_concentration'));
    check('cashRisk: payer dependency surfaced (Company B)', cashRisk.evidence.some(e => e.type === 'observed_payer_pattern' && e.payer_reference === 'Day7 Company B'));
    check('cashRisk: no ownership language ("owns"/"subsidiary")', !/owns|subsidiary|parent company/i.test(cashRisk.relationship_context));
    check('cashRisk: relationship_context is observational ("observed")', /observed/i.test(cashRisk.relationship_context));

    // evidence explorer traces every claim to a real row
    const evidence = await getInsightEvidence('cash_risk', { userId: TENANT_A, narrative: cashRisk });
    console.log('\n--- evidenceExplorer(cash_risk) ---');
    console.log(JSON.stringify(evidence, null, 2));
    check('evidenceExplorer: items non-empty', evidence.items.length > 0);
    check('evidenceExplorer: score_trajectory item traces to customer_score_history id', evidence.items.some(i => i.table === 'customer_score_history' && i.id));
    check('evidenceExplorer: payer item traces to payment_allocations table', evidence.items.some(i => i.table === 'payment_allocations'));

    // priority scoring v2
    const scored = computePriorityScore({
      priority: 'high', risk_level: 'high', trajectory: 'DETERIORATING',
      concentrationSharePct: cashRisk.evidence.find(e => e.type === 'revenue_concentration')?.sharePct,
      confidenceComponents: cashRisk.confidence_components,
    });
    console.log('\n--- priorityScoreV2 ---');
    console.log(JSON.stringify(scored, null, 2));
    check('priorityScoring: returns a score in [0,1]', scored && scored.priorityScoreV2 >= 0 && scored.priorityScoreV2 <= 1);
    check('priorityScoring: components separately named', Object.keys(scored.components).length === 5);
    check('priorityScoring: additive/optional — returns null for no signal', computePriorityScore(null) === null);

    // context assembly
    const ctx = await assembleEntityContext(TENANT_A, 'customer', customerAId);
    console.log('\n--- contextAssembly (Customer A) ---');
    console.log(JSON.stringify({ availableEvidence: ctx.availableEvidence, missingContext: ctx.missingContext, outstandingTotal: ctx.relatedEntities.outstandingTotal }, null, 2));
    check('contextAssembly: found=true', ctx.found === true);
    check('contextAssembly: availableEvidence non-empty', ctx.availableEvidence.length > 0);
    check('contextAssembly: missingContext lists external exposure gap', ctx.missingContext.some(m => m.includes('external (world) exposure')));
    check('contextAssembly: outstandingTotal reflects unpaid invoice', ctx.relatedEntities.outstandingTotal === 900000);

    // -------------------------------------------------------------------
    // Scenario 5 (CRITICAL): healthy tenant, zero fabricated narratives
    // -------------------------------------------------------------------
    const healthyCustomerId = randomUUID();
    await supabase.from('customers').insert({ id: healthyCustomerId, user_id: TENANT_B, name: 'Day7 Healthy Customer' });
    await supabase.from('customer_scores').insert({ id: randomUUID(), user_id: TENANT_B, customer_id: healthyCustomerId, credit_risk_score: 10, collection_priority_score: 5 });
    cleanup.push(['customer_scores', 'customer_id', healthyCustomerId]);
    cleanup.push(['customers', 'id', healthyCustomerId]);

    const healthyNarrative = await buildCashRiskNarrative({ userId: TENANT_B, customerId: healthyCustomerId });
    console.log('\n--- Scenario 5: healthy tenant cashRiskNarrative ---');
    console.log(JSON.stringify(healthyNarrative, null, 2));
    check('CRITICAL Scenario 5: healthy customer -> insufficientEvidence=true (zero fabrication)', healthyNarrative.insufficientEvidence === true);
    check('CRITICAL Scenario 5: reasons array explains why', Array.isArray(healthyNarrative.reasons) && healthyNarrative.reasons.length > 0);

    // -------------------------------------------------------------------
    // Missing-context guardrails
    // -------------------------------------------------------------------
    const noScoresCustomer = randomUUID();
    await supabase.from('customers').insert({ id: noScoresCustomer, user_id: TENANT_B, name: 'Day7 No Scores Customer' });
    cleanup.push(['customers', 'id', noScoresCustomer]);
    const noScoresNarrative = await buildCashRiskNarrative({ userId: TENANT_B, customerId: noScoresCustomer });
    check('Guardrail: no customer_scores row -> insufficientEvidence', noScoresNarrative.insufficientEvidence === true);

    const noSuchCustomer = randomUUID();
    const noSuchNarrative = await buildCashRiskNarrative({ userId: TENANT_B, customerId: noSuchCustomer });
    check('Guardrail: nonexistent customer -> insufficientEvidence', noSuchNarrative.insufficientEvidence === true);

    const singlePointCustomer = randomUUID();
    await supabase.from('customers').insert({ id: singlePointCustomer, user_id: TENANT_B, name: 'Day7 Single Point Customer' });
    await supabase.from('customer_scores').insert({ id: randomUUID(), user_id: TENANT_B, customer_id: singlePointCustomer, credit_risk_score: 60 });
    const singleHistId = randomUUID();
    await supabase.from('customer_score_history').insert({ id: singleHistId, user_id: TENANT_B, customer_id: singlePointCustomer, credit_risk_score: 60, recorded_at: new Date().toISOString() });
    cleanup.push(['customer_score_history', 'id', singleHistId]);
    cleanup.push(['customer_scores', 'customer_id', singlePointCustomer]);
    cleanup.push(['customers', 'id', singlePointCustomer]);
    const singlePointNarrative = await buildCashRiskNarrative({ userId: TENANT_B, customerId: singlePointCustomer });
    check('Guardrail: single history point -> insufficientEvidence (no fabricated trend)', singlePointNarrative.insufficientEvidence === true);

    // -------------------------------------------------------------------
    // Tenant isolation
    // -------------------------------------------------------------------
    const crossTenant = await buildCashRiskNarrative({ userId: TENANT_B, customerId: customerAId }).catch(() => null);
    check('Tenant isolation: tenant B cannot see tenant A customer', !crossTenant || crossTenant.insufficientEvidence === true);

    const ctxCrossTenant = await assembleEntityContext(TENANT_B, 'customer', customerAId);
    check('Tenant isolation: contextAssembly cannot see cross-tenant customer', ctxCrossTenant.found === false);

    // -------------------------------------------------------------------
    // Scenario 4 (FX exposure) — real business_exposure data confirmed to
    // have ZERO real matches against real world_events today (verified by
    // direct query before writing this test: MACROECONOMICS events link to
    // CURRENCY entities; all business_exposure rows are LOCATED_IN/
    // OPERATES_IN linking to COUNTRY entities — no overlap). We therefore
    // construct one clearly-labeled synthetic fixture pair to prove the
    // wiring is real, and document this honestly rather than claim a real
    // match that doesn't exist.
    // -------------------------------------------------------------------
    const fxSupplierId = randomUUID();
    await supabase.from('suppliers').insert({ id: fxSupplierId, user_id: TENANT_A, name: 'Day7 FX Test Supplier' }).then(r => r, () => {});
    const { data: countryEntity } = await supabase.from('world_entities').select('id').eq('entity_type', 'COUNTRY').eq('name', 'CN').maybeSingle();
    let fxResult = null;
    let fixtureEventId = null;
    const { data: macroSource } = await supabase.from('world_sources').select('id').eq('data_category', 'MACROECONOMICS').limit(1).maybeSingle();
    if (countryEntity && macroSource) {
      const exposureId = randomUUID();
      await supabase.from('business_exposure').insert({
        id: exposureId, user_id: TENANT_A, business_entity_type: 'supplier', business_entity_id: fxSupplierId,
        exposure_type: 'LOCATED_IN', world_entity_id: countryEntity.id, valid_from: '2020-01-01T00:00:00Z',
        truth_state: 'OBSERVED', raw_value: 'China', normalized_value: 'china', verification_status: 'VERIFIED',
        provenance_type: 'OWNER_ENTERED', evidence_notes: 'Day7 test fixture — clearly-labeled synthetic pair, no real match existed in DB at test time',
      });
      const eventId = randomUUID();
      fixtureEventId = eventId;
      const weRes = await supabase.from('world_events').insert({
        id: eventId, event_type: 'MACROECONOMICS', title: 'Day7 test fixture — synthetic macro event',
        source_id: macroSource.id, observed_at: new Date().toISOString(), magnitude: 2.5, confidence: 0.8, severity: 'moderate',
      });
      if (weRes.error) console.log('FIXTURE INSERT ERROR (world_events)', weRes.error);
      const weeRes = await supabase.from('world_event_entities').insert({ id: randomUUID(), event_id: eventId, entity_id: countryEntity.id, relationship_type: 'AFFECTS' });
      if (weeRes.error) console.log('FIXTURE INSERT ERROR (world_event_entities)', weeRes.error);

      cleanup.push(['world_event_entities', 'event_id', eventId]);
      cleanup.push(['world_events', 'id', eventId]);
      cleanup.push(['business_exposure', 'id', exposureId]);

      fxResult = await buildFxExposureNarrative({ userId: TENANT_A, eventId });
      console.log('\n--- fxExposureNarrative (synthetic fixture: MACROECONOMICS event over LOCATED_IN/CN exposure) ---');
      console.log(JSON.stringify(fxResult, null, 2));
      check('FX: synthetic fixture produces a real (non-fabricated) match', fxResult.insufficientEvidence === false);
      if (fxResult.insufficientEvidence === false) {
        check('FX: evidence traces to real world_events + business_exposure ids', fxResult.evidence.every(e => e.id));
        const fxEvidence = await getInsightEvidence('fx_exposure', { userId: TENANT_A, narrative: fxResult });
        check('FX: evidenceExplorer traces fx narrative', fxEvidence.items.length > 0);
      }
    } else {
      check('FX: COUNTRY entity CN + MACROECONOMICS world_source exist for fixture', false);
    }
    cleanup.push(['suppliers', 'id', fxSupplierId]);

    // No real match sanity check: fetch a REAL pre-existing MACROECONOMICS
    // event that is NOT the fixture event we just inserted above (excluded
    // via .neq so this doesn't accidentally re-match the fixture's own CN
    // exposure and silently pass for the wrong reason). TENANT_B has no
    // business_exposure rows at all, so a real, unrelated event checked
    // against TENANT_B must be insufficientEvidence — a genuine guardrail
    // check, not a hardcoded pass.
    let realEventQuery = supabase.from('world_events').select('id').eq('event_type', 'MACROECONOMICS').limit(1);
    if (fixtureEventId) realEventQuery = realEventQuery.neq('id', fixtureEventId);
    const { data: realEvent } = await realEventQuery.maybeSingle();
    if (realEvent) {
      const noMatch = await buildFxExposureNarrative({ userId: TENANT_B, eventId: realEvent.id });
      check('FX guardrail: real event w/ no real exposure match -> insufficientEvidence', noMatch.insufficientEvidence === true);
    } else {
      console.log('(skipped FX guardrail check: no real MACROECONOMICS world_events row exists besides the fixture)');
    }

  } finally {
    console.log('\n--- Cleanup ---');
    // Reverse order: children (pushed later) deleted before parents (pushed
    // earlier, e.g. the fixture `users` rows), respecting FK constraints.
    for (const [table, col, val] of [...cleanup].reverse()) {
      try { await del(table, col, val); } catch (e) { console.log('cleanup warn', table, e.message); }
    }
    // verify zero residue
    let residue = 0;
    for (const [table, col, val] of cleanup) {
      const { data } = await supabase.from(table).select('*').eq(col, val).limit(1);
      if (data && data.length) residue++;
    }
    check('Cleanup: zero residue rows remain', residue === 0);
  }

  console.log(`\n=== RESULTS: ${pass} passed, ${fail} failed ===`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('FATAL', err);
  process.exit(1);
});
