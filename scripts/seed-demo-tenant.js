// FILE: scripts/seed-demo-tenant.js
// Day 7 Human Test Experience — Part 12: demo tenant seeding.
//
// Creates ONE real tenant ("Demo Textiles Co" — an obviously-a-demo Indian
// SME) via real INSERT statements against the real local dev DB
// (process.env.DATABASE_URL — Neon dev instance, NEVER NEON_READONLY_URL,
// NEVER production). Seeds only the UNDERLYING real data; it never
// hardcodes narrative text. After seeding, it calls the REAL production
// intelligence functions (buildCashRiskNarrative, getWorldExposureStatus,
// classifyScoreTrajectory via the narrative, getIntelligenceReadiness) and
// prints their actual output so this script is honest proof, not a
// one-off insert-with-no-verification.
//
// Scenarios seeded (mission Part 12 a-f):
//   a. Rajesh Fabrics — deteriorating: 2 customer_score_history rows, score worsening
//   b. Rajesh Fabrics also carries revenue concentration (>25% of trailing 90-day revenue)
//   c. Rajesh Fabrics — 2 CONFIRMED payment_allocations rows from the same third-party payer
//   d. A supplier ("Anand Textile Mills") with a VERIFIED LOCATED_IN business_exposure row
//   e. Sunrise Garments — genuinely healthy: on-time payment, no concentration
//   f. New Threads Traders — genuinely sparse: single customer_score_history point
//
// Usage: node scripts/seed-demo-tenant.js
require('dotenv').config();
const { Client } = require('pg');
const { randomUUID } = require('crypto');

const DEMO_EMAIL_DOMAIN = 'demo-textiles-co.invalid';

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required (real local dev Neon instance) — refusing to run without it.');
  }
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const report = { createdAt: new Date().toISOString() };

  try {
    // ── Tenant ────────────────────────────────────────────────────────────
    const userId = randomUUID();
    const email = `owner@${DEMO_EMAIL_DOMAIN}`;
    await client.query(
      `INSERT INTO users (id, email, business_name, plan, password_hash, phone, owner_name, created_at)
       VALUES ($1, $2, 'Demo Textiles Co', 'free', 'x-not-a-real-hash', '9990001111', 'Demo Owner', NOW())`,
      [userId, email]
    );
    report.userId = userId;
    report.businessName = 'Demo Textiles Co';
    console.log(`Created demo tenant: ${userId} (${email})`);

    // ── a/b/c: Rajesh Fabrics — deteriorating + concentrated + payer dependency ──
    const rajeshId = randomUUID();
    await client.query(
      `INSERT INTO customers (id, user_id, name, phone, is_active, created_at, updated_at)
       VALUES ($1, $2, 'Rajesh Fabrics', '9812345001', true, NOW(), NOW())`,
      [rajeshId, userId]
    );

    // (a) 2-point deteriorating score_history (honest limit — exactly 2 points)
    await client.query(
      `INSERT INTO customer_score_history (id, user_id, customer_id, credit_risk_score, recorded_at)
       VALUES ($1, $2, $3, 35, NOW() - INTERVAL '20 days')`,
      [randomUUID(), userId, rajeshId]
    );
    await client.query(
      `INSERT INTO customer_score_history (id, user_id, customer_id, credit_risk_score, recorded_at)
       VALUES ($1, $2, $3, 68, NOW() - INTERVAL '1 day')`,
      [randomUUID(), userId, rajeshId]
    );

    // (b) Concentration: Rajesh Fabrics sales must be >25% of trailing-90-day
    // tenant revenue. Rajesh: 3 sales totalling 300000 in the last 30 days.
    // Everyone else combined must stay under 3x that (900000) so his share
    // clears 25%. Sunrise gets one modest sale (30000); New Threads gets one
    // small sale (5000) — comfortably keeps Rajesh's share high.
    const rajeshSaleIds = [];
    for (const amt of [120000, 100000, 80000]) {
      const r = await client.query(
        `INSERT INTO sales (user_id, customer_name, customer_id, amount, paid_amount, status, sale_date, created_at)
         VALUES ($1, 'Rajesh Fabrics', $2, $3, $3, 'completed', (NOW() - INTERVAL '10 days')::date, NOW())
         RETURNING id`,
        [userId, rajeshId, amt]
      );
      rajeshSaleIds.push(r.rows[0].id);
    }

    // (c) Two invoices for Rajesh Fabrics, each with a CONFIRMED payment_allocation
    // from the same third-party payer reference ("Anand Textile Mills Pvt Ltd" —
    // a plausible related/third-party payer, never asserted as ownership).
    const rajeshInvoiceIds = [];
    for (const amt of [50000, 45000]) {
      const invId = randomUUID();
      await client.query(
        `INSERT INTO invoices (id, user_id, customer_name, customer_id, invoice_amount, payment_status, days_overdue, created_at, updated_at)
         VALUES ($1, $2, 'Rajesh Fabrics', $3, $4, 'Paid', 0, NOW(), NOW())`,
        [invId, userId, rajeshId, amt]
      );
      rajeshInvoiceIds.push(invId);
    }
    for (let i = 0; i < rajeshInvoiceIds.length; i++) {
      await client.query(
        `INSERT INTO payment_allocations
           (id, user_id, invoice_id, payer_reference, payer_type, amount, payment_date, allocation_status, evidence_notes, confirmed_by_user_id, confirmed_at, created_at, updated_at)
         VALUES ($1, $2, $3, 'Anand Textile Mills Pvt Ltd', 'THIRD_PARTY', $4, (NOW() - INTERVAL '5 days')::date, 'CONFIRMED', 'Demo seed: bank reference cites Anand Textile Mills as remitter', $5, NOW(), NOW(), NOW())`,
        [randomUUID(), userId, rajeshInvoiceIds[i], i === 0 ? 50000 : 45000, userId]
      );
    }

    // ── d: supplier with a VERIFIED LOCATED_IN business_exposure row ────────
    const supplierId = randomUUID();
    await client.query(
      `INSERT INTO suppliers (id, user_id, name, is_active, created_at, updated_at, country)
       VALUES ($1, $2, 'Anand Textile Mills', true, NOW(), NOW(), 'BD')`,
      [supplierId, userId]
    );
    const { createExposure, verifyExposure } = require('../lib/world/exposureRegistry');
    const exposure = await createExposure(userId, {
      businessEntityType: 'supplier',
      businessEntityId: supplierId,
      exposureType: 'LOCATED_IN',
      rawValue: 'BD',
      kind: 'country',
      truthState: 'OBSERVED',
      confidence: 0.9,
      provenanceType: 'OWNER_ENTERED',
      sourceOfFact: 'owner_recorded',
      evidenceNotes: 'Demo seed: owner-recorded supplier country for Day 7 world-exposure UX proof.',
    });
    const verifiedExposure = await verifyExposure(userId, exposure.id, { verifiedByUserId: userId });
    report.supplierExposureId = verifiedExposure.id;

    // ── e: Sunrise Garments — genuinely healthy ──────────────────────────────
    const sunriseId = randomUUID();
    await client.query(
      `INSERT INTO customers (id, user_id, name, phone, is_active, created_at, updated_at)
       VALUES ($1, $2, 'Sunrise Garments', '9812345002', true, NOW(), NOW())`,
      [sunriseId, userId]
    );
    await client.query(
      `INSERT INTO sales (user_id, customer_name, customer_id, amount, paid_amount, status, sale_date, created_at)
       VALUES ($1, 'Sunrise Garments', $2, 30000, 30000, 'completed', (NOW() - INTERVAL '15 days')::date, NOW())`,
      [userId, sunriseId]
    );
    await client.query(
      `INSERT INTO invoices (id, user_id, customer_name, customer_id, invoice_amount, payment_status, days_overdue, created_at, updated_at)
       VALUES ($1, $2, 'Sunrise Garments', $3, 30000, 'Paid', 0, NOW(), NOW())`,
      [randomUUID(), userId, sunriseId]
    );
    // Two improving/stable score points so it never renders as "not enough data".
    await client.query(
      `INSERT INTO customer_score_history (id, user_id, customer_id, credit_risk_score, recorded_at)
       VALUES ($1, $2, $3, 10, NOW() - INTERVAL '20 days')`,
      [randomUUID(), userId, sunriseId]
    );
    await client.query(
      `INSERT INTO customer_score_history (id, user_id, customer_id, credit_risk_score, recorded_at)
       VALUES ($1, $2, $3, 8, NOW() - INTERVAL '1 day')`,
      [randomUUID(), userId, sunriseId]
    );

    // ── f: New Threads Traders — genuinely sparse (single data point) ───────
    const sparseId = randomUUID();
    await client.query(
      `INSERT INTO customers (id, user_id, name, phone, is_active, created_at, updated_at)
       VALUES ($1, $2, 'New Threads Traders', '9812345003', true, NOW(), NOW())`,
      [sparseId, userId]
    );
    await client.query(
      `INSERT INTO sales (user_id, customer_name, customer_id, amount, paid_amount, status, sale_date, created_at)
       VALUES ($1, 'New Threads Traders', $2, 5000, 5000, 'completed', (NOW() - INTERVAL '3 days')::date, NOW())`,
      [userId, sparseId]
    );
    await client.query(
      `INSERT INTO customer_score_history (id, user_id, customer_id, credit_risk_score, recorded_at)
       VALUES ($1, $2, $3, 15, NOW() - INTERVAL '2 days')`,
      [randomUUID(), userId, sparseId]
    );

    report.customers = { rajeshId, sunriseId, sparseId };
    report.supplierId = supplierId;

    console.log('Seed complete. Now running the REAL intelligence functions against this tenant...\n');

    // ── Verification: run the real narrative/orchestrator functions ─────────
    const { buildCashRiskNarrative } = require('../lib/domain/intelligence/cashRiskNarrative');
    const { getWorldExposureStatus } = require('../lib/world/businessStateBoundary');
    const { getIntelligenceReadiness } = require('../lib/domain/globalContext/readiness');

    const rajeshNarrative = await buildCashRiskNarrative({ userId, customerId: rajeshId });
    console.log('=== Rajesh Fabrics (deteriorating + concentrated + payer dependency) ===');
    console.log(JSON.stringify(rajeshNarrative, null, 2));
    report.rajeshNarrative = rajeshNarrative;

    const sunriseNarrative = await buildCashRiskNarrative({ userId, customerId: sunriseId });
    console.log('\n=== Sunrise Garments (healthy — expect insufficientEvidence) ===');
    console.log(JSON.stringify(sunriseNarrative, null, 2));
    report.sunriseNarrative = sunriseNarrative;

    const sparseNarrative = await buildCashRiskNarrative({ userId, customerId: sparseId });
    console.log('\n=== New Threads Traders (sparse — expect insufficientEvidence, <2 history rows) ===');
    console.log(JSON.stringify(sparseNarrative, null, 2));
    report.sparseNarrative = sparseNarrative;

    const worldExposure = await getWorldExposureStatus(userId);
    console.log('\n=== World exposure status (expect signals_present or NO_MATERIAL_SIGNALS depending on live world_events) ===');
    console.log(JSON.stringify(worldExposure, null, 2));
    report.worldExposure = worldExposure;

    const readiness = await getIntelligenceReadiness(userId);
    console.log('\n=== Intelligence readiness ===');
    console.log(JSON.stringify(readiness, null, 2));
    report.readiness = readiness;

    console.log('\n=== SUMMARY ===');
    console.log(`Demo tenant userId: ${userId}`);
    console.log(`Rajesh Fabrics insufficientEvidence: ${rajeshNarrative.insufficientEvidence} (expect false — real signal)`);
    console.log(`Sunrise Garments insufficientEvidence: ${sunriseNarrative.insufficientEvidence} (expect true — healthy, no signal)`);
    console.log(`New Threads Traders insufficientEvidence: ${sparseNarrative.insufficientEvidence} (expect true — sparse history)`);
    console.log(`World exposure status: ${worldExposure.world_exposure_status}`);
    console.log(`Verified exposure count: ${worldExposure.verified_exposure_count}`);

    return report;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch(err => {
      console.error('seed-demo-tenant failed:', err);
      process.exit(1);
    });
}

module.exports = { main };
