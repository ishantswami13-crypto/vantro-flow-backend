// FILE: scripts/world-phase3c-proof.js
// World Intelligence Phase 3C — proves that the two "documented gaps" from
// Phase 3B (no real supplier->product edge, no real product->order edge)
// were wrong, not schema limitations, and that signalPropagation.js now
// walks the real edges that were already sitting in the dev DB the whole
// time: product_suppliers (many-to-many, real) and orders.items (JSONB,
// but real product_id references in real order rows) plus a real BOM table
// (product_components) neither Phase 3A nor 3B had discovered.
//
// Uses ONLY the sanctioned 2xA demo tenant (owner@2xa-demo-meridian.invalid,
// docs/2xa-demo.md) — real seeded dev data, not synthetic fixtures, per the
// mission's "do not fabricate a fake production customer" instruction. This
// script is READ-ONLY against that tenant's data (it writes nothing, so
// there is nothing to clean up) — it only asserts that propagateSignalV2
// correctly reads relationships that already exist.
require('dotenv').config();
const { getPool } = require('../lib/db/pg');
const { propagateSignalV2 } = require('../lib/world/signalPropagation');
const { computeDependencyEvidence } = require('../lib/world/dependencyEvidence');

const DEMO_TENANT_EMAIL = 'owner@2xa-demo-meridian.invalid';
const RAW_MATERIAL_SKU = 'CMP-FRAME-AL'; // "Aluminum Frame Alloy Tube Set"

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`PASS - ${name}` + (detail ? ` :: ${JSON.stringify(detail)}` : '')); }
  else { failed++; console.log(`FAIL - ${name}` + (detail ? ` :: ${JSON.stringify(detail)}` : '')); }
}

async function main() {
  const pool = getPool();

  const userRes = await pool.query('SELECT id FROM users WHERE email = $1', [DEMO_TENANT_EMAIL]);
  if (userRes.rows.length === 0) {
    console.log(`SKIP - demo tenant ${DEMO_TENANT_EMAIL} not found. Run: node scripts/seed-2xa-demo.js`);
    process.exit(0);
  }
  const userId = userRes.rows[0].id;

  const prodRes = await pool.query('SELECT id, name FROM products WHERE user_id = $1 AND sku = $2', [userId, RAW_MATERIAL_SKU]);
  check('Setup: raw-material component product exists in demo tenant', prodRes.rows.length === 1, { sku: RAW_MATERIAL_SKU });
  const componentId = prodRes.rows[0]?.id;

  const linkRes = await pool.query('SELECT supplier_id FROM product_suppliers WHERE user_id = $1 AND product_id = $2', [userId, componentId]);
  check('Setup: real product_suppliers edge exists for this component', linkRes.rows.length >= 1);
  const supplierId = linkRes.rows[0]?.supplier_id;

  // ── The actual proof: propagate from the SUPPLIER exposure ──
  const result = await propagateSignalV2(userId, { related_entity_type: 'supplier', related_entity_id: supplierId }, null);
  const steps = result.steps;

  check('Propagation: reaches SUPPLIER', steps.some(s => s.step === 'SUPPLIER'));
  check('Propagation: reaches real SUPPLIER_PRODUCT (not a GAP)', steps.some(s => s.step === 'SUPPLIER_PRODUCT' && s.productId === componentId));
  check('Propagation: SUPPLIER_PRODUCT carries real provenance, not a fabricated certainty', steps.some(s => s.step === 'SUPPLIER_PRODUCT' && typeof s.provenance === 'string' && s.provenance.length > 0));
  check('Propagation: reaches real INVENTORY for the component', steps.some(s => s.step === 'INVENTORY' && s.productId === componentId));
  check('Propagation: reaches real COMPONENT_OF (BOM edge, not a GAP)', steps.some(s => s.step === 'COMPONENT_OF'));
  check('Propagation: reaches real OPEN_ORDERS for a finished product built from this component', steps.some(s => s.step === 'OPEN_ORDERS' && s.count > 0));

  const openOrdersSteps = steps.filter(s => s.step === 'OPEN_ORDERS' && s.count > 0);
  const totalExposedValue = openOrdersSteps.reduce((sum, s) => sum + s.totalValue, 0);
  const totalExposedQty = openOrdersSteps.reduce((sum, s) => sum + s.totalQuantity, 0);
  check('Propagation: real exposed order value is a positive real number, not fabricated', totalExposedValue > 0, { totalExposedValue, totalExposedQty });

  check('Propagation: no step in the successful path is a GAP for the component/BOM/order chain',
    !steps.some(s => s.step === 'GAP' && /product_components|orders\.items/i.test(s.reason || '')));

  // No causal-certainty language anywhere in the path.
  const causalWords = /\bwill\b|\bguarantee|\bcertain(ly)?\b/i;
  check('Truth-language: no step uses causal-certainty language', !steps.some(s => causalWords.test(JSON.stringify(s))));

  // ── dependencyEvidence.js should now report a real (non-null) open-order count ──
  const evidence = await computeDependencyEvidence(userId, 'supplier', supplierId);
  check('Dependency evidence: openOrdersCount is a real number now, not permanently null', typeof evidence.openOrdersCount === 'number', evidence);

  console.log(`\n=== PHASE 3C PROOF RESULT: ${failed === 0 ? 'PASS' : 'FAIL'} (${passed}/${passed + failed}) ===`);
  console.log('This script is read-only against seeded demo data — no residue to check.');
  await pool.end();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => { console.error('FATAL', err); process.exit(1); });
