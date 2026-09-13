// A product truth registry. A connector may only advertise capabilities that
// have an implementation and a tested safety policy. This prevents UI or API
// layers from silently treating a planned integration as live.

const CONNECTORS = Object.freeze({
  TALLY: {
    state: 'READ_SYNC_READY', transport: 'local_windows_agent',
    reads: ['sales', 'purchases', 'receipts', 'payments', 'stock_items'],
    writes: [],
    limitations: ['No source write-back adapter yet', 'Stable company/GUID reconciliation upgrade pending'],
  },
  QUICKBOOKS: { state: 'PLANNED', transport: 'oauth2', reads: [], writes: [], limitations: ['Adapter not implemented'] },
  ZOHO_BOOKS: { state: 'PLANNED', transport: 'oauth2', reads: [], writes: [], limitations: ['Adapter not implemented'] },
  XERO: { state: 'PLANNED', transport: 'oauth2', reads: [], writes: [], limitations: ['Adapter not implemented'] },
  BUSY: { state: 'PLANNED', transport: 'local_windows_agent', reads: [], writes: [], limitations: ['Adapter not implemented'] },
  ODOO: { state: 'PLANNED', transport: 'oauth2_or_api_key', reads: [], writes: [], limitations: ['Adapter not implemented'] },
  SAP: { state: 'PLANNED', transport: 'enterprise_api', reads: [], writes: [], limitations: ['Adapter not implemented'] },
});

function connectorInfo(sourceType) { return CONNECTORS[sourceType] || null; }
function isWriteEnabled(sourceType, operation) {
  const connector = connectorInfo(sourceType);
  return !!connector && connector.state === 'WRITE_SYNC_READY' && connector.writes.includes(operation);
}

module.exports = { CONNECTORS, connectorInfo, isWriteEnabled };
