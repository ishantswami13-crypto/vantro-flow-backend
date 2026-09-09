// FILE: lib/domain/ingestion/adapters/fileAdapter.js
// Generic CSV/XLSX file as ONE source adapter under the generic adapter
// interface (see adapters/README.md). Every piece here already existed —
// this file only reshapes fileParser.js + columnMapping.js +
// fileImportOrchestrator.js into discover()/extract()/normalize() plus a
// commit() passthrough, so it conforms to the same shape as tallyAdapter.js.
// No parsing/mapping/commit logic is duplicated.
//
// This is the "any software that can export a spreadsheet" tier: Tally,
// QuickBooks, Zoho Books, Xero, Busy, Marg, a bank's own CSV export, or a
// hand-built Excel sheet all work here IF their export is mapped by
// columnMapping.js's alias table (CORE_ALIASES, plus TALLY_ALIASES for
// Tally-style CSV headers specifically). Adding support for another
// software's export format is a matter of adding its alias table to
// columnMapping.js — no new adapter needed.

const { inspectFile } = require('../fileParser');
const { mapHeaders, applyMapping } = require('../columnMapping');
const { commitFile } = require('../fileImportOrchestrator');

/**
 * discover(buffer, filename) -> { available, fileType, headers, rowCount, mappingProfile }
 * Read-only: parses the file but writes nothing, same "what's here?"
 * contract as tallyAdapter.discover().
 */
function discover(buffer, filename, { profile = 'core' } = {}) {
  const inspection = inspectFile(buffer, filename);
  if (!inspection.supported) {
    return { available: false, error: inspection.error || 'unsupported file type' };
  }
  const headerMapping = mapHeaders(inspection.headers, { profile });
  return {
    available: true,
    fileType: inspection.fileType,
    headers: inspection.headers,
    rowCount: inspection.rows.length,
    mappingProfile: profile,
    headerMapping,
  };
}

/**
 * extract(buffer, filename) -> raw parsed rows in the FILE'S OWN shape
 * (i.e. objects keyed by the file's original column headers). Reuses
 * fileParser.js directly — no new parser.
 */
function extract(buffer, filename) {
  const inspection = inspectFile(buffer, filename);
  if (!inspection.supported) throw new Error(inspection.error || 'unsupported file type');
  return inspection.rows;
}

/**
 * normalize(rawRows, headers) -> rows in csvImport.js's row shape.
 * Reuses columnMapping.js's applyMapping directly — no new mapping logic.
 */
function normalize(rawRows, headers, { profile = 'core' } = {}) {
  const headerMapping = mapHeaders(headers, { profile });
  return applyMapping(headers, rawRows, headerMapping.byField);
}

/**
 * commit(...) is a direct passthrough to the already-approved, already
 * shared commit path (parse+map+idempotent write via
 * fileImportOrchestrator.commitFile -> csvImport.commitImport). Exposed
 * here so callers can go through the adapter interface uniformly instead
 * of importing fileImportOrchestrator directly.
 */
async function commit(buffer, filename, opts) {
  return commitFile(buffer, filename, opts);
}

module.exports = { discover, extract, normalize, commit };
