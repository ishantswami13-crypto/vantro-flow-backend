'use strict';
// Which assistant tools a session may use (Hard Rule 9: the assistant never
// changes records). Enforced by /api/ai-chat in two places: the tool list
// sent to the model, and executeTool.
//   - Web: look-ups + message drafts (wa.me links a person opens and sends).
//   - Desktop/mobile (native sessions): look-ups only.
//   - Both: stop_mission, which only ever moves toward safety (it sets the
//     same reversible kill switch as Control > Stop) and is audited.
// Anything not listed — mark_invoice_paid, add_prospect, update_prospect_status,
// place_order_with_supplier, any future tool — is refused by default.
const READ_TOOLS = Object.freeze(['get_summary', 'get_invoices', 'get_prospects', 'get_inventory', 'get_calls', 'get_cash_forecast', 'get_overdue', 'get_suppliers', 'navigate_to', 'get_decisions', 'get_missions', 'what_changed', 'what_if_sales']);
const DRAFT_TOOLS = Object.freeze(['send_whatsapp', 'send_collection_reminder', 'send_bulk_reminders']);
const STOP_TOOLS = Object.freeze(['stop_mission']);

function allowedToolsFor({ native }) {
  return new Set(native ? [...READ_TOOLS, ...STOP_TOOLS] : [...READ_TOOLS, ...DRAFT_TOOLS, ...STOP_TOOLS]);
}

module.exports = { READ_TOOLS, DRAFT_TOOLS, STOP_TOOLS, allowedToolsFor };
