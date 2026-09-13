// FILE: lib/domain/automation/supplyChainExecutionAdapter.js
// Execution boundary for approved supply-chain ai_actions. Mirrors the
// connectorCatalog.js pattern: this file NEVER claims a live ERP write
// happened unless a real, WRITE_SYNC_READY connector actually ran. Per
// connectorCatalog.js, ODOO is state 'PLANNED' with writes: [] — there is
// no live Odoo write adapter anywhere in this codebase. This file provides:
//   1. a clean adapter interface (executeSupplyChainAction) any future real
//      ERP connector can implement without changing callers, and
//   2. the DEMO adapter — creates a REAL purchase_orders row in Starlane's
//      own database (not a fake/UI-only animation), clearly tagged
//      source: 'demo_erp_adapter' so it can never be mistaken for a
//      confirmed external Odoo write.
const { getPool } = require('../../db/pg');
const { connectorInfo } = require('./connectorCatalog');

// Always returns a mode string so callers/UI can render the execution
// boundary explicitly rather than assuming success implies "sent to Odoo".
function resolveExecutionMode() {
  const odoo = connectorInfo('ODOO');
  if (odoo && odoo.state === 'WRITE_SYNC_READY' && odoo.writes.includes('purchase_order')) {
    return 'LIVE_ODOO';
  }
  return 'DEMO_ADAPTER';
}

// Executes one approved ai_action of type 'supply_chain_intervention'.
// Creates a real purchase_orders row (draft) and a real execution_records
// row. Never mutates a row outside this tenant (user_id scoped throughout).
async function executeSupplyChainAction(userId, action) {
  const pool = getPool();
  const mode = resolveExecutionMode();

  const reason = action.reason_json || {};
  const componentId = reason.componentId;
  const componentRes = componentId
    ? await pool.query(`SELECT id, name FROM products WHERE id = $1 AND user_id = $2`, [componentId, userId])
    : { rows: [] };
  const component = componentRes.rows[0] || null;

  const supplierRes = action.supplier_id
    ? await pool.query(`SELECT id, name, phone FROM suppliers WHERE id = $1 AND user_id = $2`, [action.supplier_id, userId])
    : { rows: [] };
  const supplier = supplierRes.rows[0] || null;

  const topOption = Array.isArray(reason.rankedOptions) ? reason.rankedOptions[0] : null;

  if (mode === 'DEMO_ADAPTER') {
    const poRes = await pool.query(
      `INSERT INTO purchase_orders (user_id, supplier_name, supplier_phone, items, estimated_amount, status, related_ai_action_id, created_at)
       VALUES ($1,$2,$3,$4,$5,'draft_demo_adapter',$6,NOW())
       RETURNING *`,
      [
        userId,
        supplier ? supplier.name : 'Unknown supplier',
        supplier ? supplier.phone : null,
        JSON.stringify({ component_id: component ? component.id : null, component_name: component ? component.name : null, note: 'Created by Starlane demo ERP adapter — no live external system call was made.' }),
        topOption ? topOption.cost : null,
        action.id,
      ]
    );
    const execRes = await pool.query(
      `INSERT INTO execution_records (user_id, ai_action_id, channel, provider_message_id, status, sent_at, idempotency_key)
       VALUES ($1,$2,'demo_erp_adapter',$3,'completed',NOW(),$4)
       RETURNING *`,
      [userId, action.id, `demo-po-${poRes.rows[0].id}`, `supply_chain_action_${action.id}`]
    );
    return {
      mode,
      liveExternalWriteOccurred: false,
      purchaseOrder: poRes.rows[0],
      executionRecord: execRes.rows[0],
      note: 'Executed via the deterministic demo ERP adapter. No external Odoo (or any live ERP) write occurred — the ODOO connector is state PLANNED (see connectorCatalog.js). This created a real Starlane purchase_orders row.',
    };
  }

  // LIVE_ODOO branch intentionally left unimplemented — connectorCatalog.js
  // must first report ODOO as WRITE_SYNC_READY with 'purchase_order' before
  // this path can ever execute. Reaching here would be a catalog/adapter
  // mismatch bug, not a valid runtime state, so it fails loudly.
  throw new Error('LIVE_ODOO execution mode is not implemented. connectorCatalog.js must not report ODOO as WRITE_SYNC_READY until a real adapter exists here.');
}

module.exports = { executeSupplyChainAction, resolveExecutionMode };
