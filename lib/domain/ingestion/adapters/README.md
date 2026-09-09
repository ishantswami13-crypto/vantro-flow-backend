# Source Adapters

A minimal interface so a bookkeeping/accounting data source is "one adapter
among several" instead of a special case wired straight into the ingestion
pipeline. This does NOT replace or duplicate the already-approved generic
layers in `lib/domain/ingestion/` (observation contract, entity resolution,
idempotent commit) — those stay exactly as they are and are shared by every
adapter. An adapter's only job is: know how to reach ITS source and know
its source's field names.

## Interface

Every adapter module exports:

```
discover(config)                 -> Promise<{ available, detail... }>
extract(config, { from, to })    -> Promise<rawRecords[]>   // source's own shape
normalize(rawRecords)            -> mappedRows[]             // Universal Observation
                                                              // Contract / csvImport
                                                              // row shape
```

`discover` answers "what's here?" (company/file name, counts if knowable,
date range if knowable) without committing anything — this is the same
read-only-probe pattern `scripts/tally/diagnose.js` already used for Tally,
generalized so a file adapter can answer the same question about an
uploaded file.

`extract` pulls raw records in the source's own shape — Tally XML parsed to
JS voucher objects for the Tally adapter, parsed spreadsheet rows for the
File adapter (this literally reuses `fileParser.js`, nothing new).

`normalize` maps those raw records to the field set `csvImport.js` already
expects (`sku, supplierName, supplierTaxId, quantity, unitPrice, currency,
orderedAt, expectedAt, sourceRecordId`) — the same alias-table pattern
`columnMapping.js` already uses for Tally-flavoured CSV headers, just applied
to a different raw shape.

## What is genuinely shared across every adapter

`csvImport.commitImport` (idempotent write to `purchase_line_items` /
`product_suppliers`, with conservative entity resolution and content-hash
dedup) is the ONE commit path both adapters in this repo route through for
purchase-type data. Adapters differ only in how they fetch data and what
their field names are — never in how a row is safely written. This is the
core architectural point of this framework.

## What is honestly NOT unified (yet)

Tally also emits Sales / Receipt / Payment vouchers and stock movements,
which target `invoices` / `bank_transactions` / `stock_movements` — tables
the current generic commit path (`purchase_line_items` /
`product_suppliers`) does not write to at all. Those voucher kinds still go
through the separate, already-built `lib/services/tallyImport.service.js`
bespoke writer (feature/tally-full-ingestion branch). Folding ledger/bank
data into one generic commit path is real future work, not something this
pass claims to have done — see the adapters' own header comments.
