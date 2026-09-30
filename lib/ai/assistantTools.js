'use strict';
// Which assistant tools a session may use (Hard Rule 9: the assistant never
// changes records). Enforced by /api/ai-chat in two places: the tool list
// sent to the model, and executeTool.
//   - Web: look-ups + message drafts (wa.me links a person opens and sends).
//   - Desktop/mobile (native sessions): look-ups only.
// Anything not listed — mark_invoice_paid, add_prospect, update_prospect_status,
// place_order_with_supplier, any future tool — is refused by default.
const READ_TOOLS = Object.freeze(['get_summary', 'get_invoices', 'get_prospects', 'get_inventory', 'get_calls', 'get_cash_forecast', 'get_overdue', 'get_suppliers', 'navigate_to']);
const DRAFT_TOOLS = Object.freeze(['send_whatsapp', 'send_collection_reminder', 'send_bulk_reminders']);

function allowedToolsFor({ native }) {
  return new Set(native ? READ_TOOLS : [...READ_TOOLS, ...DRAFT_TOOLS]);
}

module.exports = { READ_TOOLS, DRAFT_TOOLS, allowedToolsFor };
