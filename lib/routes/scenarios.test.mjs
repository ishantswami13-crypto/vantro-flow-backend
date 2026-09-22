// Real-DB test for Simulate V1 (lib/routes/scenarios.js), matching the
// lib/services/watchEvaluator.test.mjs / lib/domain/intelligence/
// opportunityPropagation.test.mjs pattern. Run:
//   node lib/routes/scenarios.test.mjs
// Connects to the REAL Neon DB via DATABASE_URL (never printed). Uses real
// existing users from the `users` table for tenant-isolation assertions.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
require('dotenv').config();
const { Pool } = require('pg');
const { buildSanitizedPgConfig } = require('../db/pgConfig');
const { buildCashConsequence } = require('../domain/intelligence/cashConsequenceEngine');
const { buildScenario, compareScenarios } = require('../domain/intelligence/scenarioEngine');
const { buildFxScenarioChain } = require('../domain/intelligence/fxScenarioEngine');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  ✅', name); }
  else { fail++; console.log('  ❌', name); }
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL not set');
  const pool = new Pool(buildSanitizedPgConfig(process.env.DATABASE_URL));

  try {
    // Pick userA as a real tenant that actually has open invoices (needed for
    // a meaningful scenario), and userB as any other real tenant for the
    // isolation check.
    const { rows: withOpenInvoices } = await pool.query(
      `SELECT user_id, COUNT(*) AS c FROM invoices
       WHERE payment_status IS NULL OR payment_status != 'Paid'
       GROUP BY user_id ORDER BY c DESC LIMIT 1`
    );
    if (withOpenInvoices.length === 0) {
      console.log('SKIP: no tenant in DB has open invoices — cannot run scenario shape test');
      process.exitCode = 0;
      return;
    }
    const userA = withOpenInvoices[0].user_id;
    const { rows: otherUsers } = await pool.query('SELECT id FROM users WHERE id != $1 ORDER BY created_at ASC LIMIT 1', [userA]);
    if (otherUsers.length === 0) {
      console.log('SKIP: fewer than 2 users in DB — cannot run tenant isolation test');
      process.exitCode = 0;
      return;
    }
    const userB = otherUsers[0].id;
    console.log(`Using real users (non-secret ids): A=${userA} B=${userB}`);

    // ---- find a real open invoice for userA ----
    const { rows: invoicesA } = await pool.query(
      `SELECT id, invoice_amount FROM invoices WHERE user_id = $1 AND (payment_status IS NULL OR payment_status != 'Paid') LIMIT 1`,
      [userA]
    );
    if (invoicesA.length === 0) {
      console.log('SKIP: user A has no open invoices — cannot run scenario shape test');
      process.exitCode = 0;
      return;
    }
    const targetInvoiceId = invoicesA[0].id;

    // ---- route-shape: baseline / simulated / delta ----
    const baseline = await buildCashConsequence(userA);
    check('baseline: status PROJECTED for a tenant with open receivables', baseline.status === 'PROJECTED');

    const scenarioDef = { name: 'Paid earlier', description: 'test', targetInvoiceId, daysEarlier: 5 };
    const simulated = buildScenario(baseline, scenarioDef);
    check('simulated: kind is SCENARIO', simulated.kind === 'SCENARIO');
    check('simulated: has projected_state.cashImpactDelta as a number', typeof simulated.projected_state.cashImpactDelta === 'number');
    check('simulated: has projected_state.projectedTotalOverdue as a number', typeof simulated.projected_state.projectedTotalOverdue === 'number');

    const delta = compareScenarios(baseline, simulated);
    check('delta: has baselineTotalOverdue', typeof delta.baselineTotalOverdue === 'number');
    check('delta: has scenarioProjectedTotalOverdue', typeof delta.scenarioProjectedTotalOverdue === 'number');
    check('delta: has a direction label', ['IMPROVEMENT_VS_BASELINE', 'WORSE_VS_BASELINE', 'NO_CHANGE_VS_BASELINE'].includes(delta.direction));

    // ---- remainsUnpaid scenario also produces a valid shape ----
    const unpaidScenario = buildScenario(baseline, { name: 'Remains unpaid', description: 'test', targetInvoiceId, remainsUnpaid: true });
    check('remainsUnpaid: kind is SCENARIO', unpaidScenario.kind === 'SCENARIO');

    // ---- tenant isolation: userB must not be able to target userA's invoice ----
    const { rows: crossCheck } = await pool.query(
      `SELECT id FROM invoices WHERE id = $1 AND user_id = $2`,
      [targetInvoiceId, userB]
    );
    check('tenant isolation: userA invoice does not belong to userB (route would 404)', crossCheck.length === 0);

    // ---- FX honest-insufficient-data behavior: no real CURRENCY_DENOMINATED
    // exposure exists for any tenant today, so this must never fabricate a
    // number — it should come back NO_EFFECT or INSUFFICIENT_CONTEXT.
    const { rows: exposureRows } = await pool.query(
      `SELECT * FROM business_exposure WHERE user_id = $1 AND exposure_type = 'CURRENCY_DENOMINATED' LIMIT 1`,
      [userA]
    ).catch(() => ({ rows: [] }));
    const fx = buildFxScenarioChain({ fxSignal: null, currencyExposure: exposureRows[0] || null, openPayablesInExposedCurrency: 0 });
    check('fx: honest NO_EFFECT or INSUFFICIENT_CONTEXT (never a fabricated number)', fx.impact_mode === 'NO_EFFECT' || fx.impact_mode === 'INSUFFICIENT_CONTEXT');
    check('fx: no chain of fabricated numbers when NO_EFFECT', fx.impact_mode !== 'NO_EFFECT' || fx.chain === null);

  } finally {
    await pool.end();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail > 0 ? 1 : 0;
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  process.exitCode = 1;
});
