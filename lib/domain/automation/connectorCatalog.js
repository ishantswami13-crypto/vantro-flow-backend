// A product truth registry. A connector may only advertise capabilities that
// have an implementation and a tested safety policy. This prevents UI or API
// layers from silently treating a planned integration as live.

const CONNECTORS = Object.freeze({
  TALLY: {
    state: 'READ_SYNC_READY', transport: 'local_windows_agent',
    reads: ['sales', 'purchases', 'receipts', 'payments', 'stock_items'],
    writes: [],
    limitations: ['Read-only: Starlane cannot write back to Tally.', 'Records are not yet matched on the stable Tally company ID.'],
  },
  QUICKBOOKS: { state: 'PLANNED', transport: 'oauth2', reads: [], writes: [], limitations: ['No connector yet. Export invoices to CSV or Excel and upload the file.'] },
  ZOHO_BOOKS: { state: 'PLANNED', transport: 'oauth2', reads: [], writes: [], limitations: ['No connector yet. Export invoices to CSV or Excel and upload the file.'] },
  XERO: { state: 'PLANNED', transport: 'oauth2', reads: [], writes: [], limitations: ['No connector yet. Export invoices to CSV or Excel and upload the file.'] },
  BUSY: { state: 'PLANNED', transport: 'local_windows_agent', reads: [], writes: [], limitations: ['No connector yet. Export invoices to CSV or Excel and upload the file.'] },
  ODOO: { state: 'PLANNED', transport: 'oauth2_or_api_key', reads: [], writes: [], limitations: ['No connector yet. Export invoices to CSV or Excel and upload the file.'] },
  SAP: { state: 'PLANNED', transport: 'enterprise_api', reads: [], writes: [], limitations: ['No connector yet. Export invoices to CSV or Excel and upload the file.'] },
});

function connectorInfo(sourceType) { return CONNECTORS[sourceType] || null; }
function isWriteEnabled(sourceType, operation) {
  const connector = connectorInfo(sourceType);
  return !!connector && connector.state === 'WRITE_SYNC_READY' && connector.writes.includes(operation);
}

module.exports = { CONNECTORS, connectorInfo, isWriteEnabled };
