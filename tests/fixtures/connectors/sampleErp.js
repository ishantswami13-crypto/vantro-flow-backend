'use strict';
// A minimal connector for an imaginary ERP, written only against
// lib/connectors/sdk.js. It exists to prove a new system can be added without
// touching Starlane's core: this file is the whole integration.
//
// The "ERP" is an in-memory object the test controls (failures, schema).
const { defineConnector, ConnectorError } = require('../../../lib/connectors/sdk');

function sampleErp(erp) {
  return defineConnector({
    id: 'sample_erp',
    provider: 'Sample ERP Inc.',
    version: '1.0.0',
    mode: 'api',
    authType: 'api_key',
    capabilities: ['READ', 'EXECUTE'],
    rateLimit: { requestsPerMinute: 60 },
    freshness: { staleAfterMs: 60 * 60 * 1000 },
    entities: {
      customer: {
        sourceFields: ['party_id', 'party_name'],
        map: (r) => ({ sourceId: r.party_id, name: r.party_name, gstin: r.gstin || null }),
      },
      invoice: {
        sourceFields: ['doc_no', 'party_id', 'total', 'ccy', 'doc_date'],
        map: (r) => ({ sourceId: r.doc_no, customerRef: r.party_id, amount: Number(r.total), currency: r.ccy, issuedOn: r.doc_date, dueOn: r.due_date || null }),
      },
    },
    actions: {
      CREATE_PO: { vendorDedupesOnKey: erp.dedupes === true },
    },
    async test({ credentials }) {
      if (credentials.apiKey !== erp.apiKey) throw new ConnectorError('AUTH_EXPIRED', 'API key rejected');
      return true;
    },
    async discoverSchema() {
      return { customer: [...erp.schema.customer], invoice: [...erp.schema.invoice] };
    },
    async read(type) {
      const failure = erp.failures.shift();
      if (failure) throw ConnectorError.fromHttp(failure.status, failure.retryAfter);
      return type === 'customer' ? erp.customers : erp.invoices;
    },
    async execute(action, payload, { idempotencyKey }) {
      const failure = erp.failures.shift();
      if (failure) throw ConnectorError.fromHttp(failure.status, failure.retryAfter);
      if (erp.dedupes && erp.pos.some((p) => p.key === idempotencyKey)) return erp.pos.find((p) => p.key === idempotencyKey);
      const po = { key: idempotencyKey, number: `PO-${erp.pos.length + 1}`, ...payload };
      erp.pos.push(po);
      return po;
    },
  });
}

module.exports = { sampleErp };
