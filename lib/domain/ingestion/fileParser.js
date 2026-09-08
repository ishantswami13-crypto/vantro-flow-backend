// FILE: lib/domain/ingestion/fileParser.js
// STARLANE — Real Customer Bootstrap & File Ingestion, Part 1.
//
// Actual byte-level file parsing for CSV and XLSX. This is the piece that
// was explicitly deferred by the previous (Reality Acquisition) phase's
// csvImport.js, which only accepted pre-parsed row arrays. This module
// reads real file bytes (via fs.readFileSync by the caller, or a Buffer/
// string passed directly) and turns them into a headers[] + rows[] shape
// that lib/domain/ingestion/columnMapping.js and csvImport.js can consume.
//
// Library availability check performed at build time (see delivery doc):
// `xlsx` (SheetJS, v0.18.5) was already declared in package.json but NOT
// present in node_modules — `npm install xlsx` succeeded against the real
// npm registry, so BOTH CSV and XLSX are supported here. XLSX cell values
// are read via sheet_to_json with raw:false (computed/static values only —
// this module never evaluates workbook formulas/macros itself; it relies
// on the values already computed and stored in the file, exactly as the
// hard constraint requires).
//
// CSV parsing is hand-rolled (not delegated to a dependency) because CSV
// has no binary format to get wrong — proper handling of quoted fields,
// embedded commas, embedded newlines inside quotes, and escaped quotes
// ("") is straightforward to get right in isolation and is unit-tested
// here directly.

const XLSX = require('xlsx');

/**
 * Parse a CSV string into headers + row arrays. Handles:
 *  - quoted fields containing commas, newlines, and escaped quotes ("")
 *  - CRLF and LF line endings
 *  - blank lines (skipped)
 *  - a trailing blank line at EOF
 * Returns { headers: string[], rows: string[][] }.
 */
function parseCSV(text) {
  if (text == null) throw new Error('parseCSV: text is required');
  const raw = String(text).replace(/^﻿/, ''); // strip BOM if present
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const n = raw.length;

  function endField() {
    row.push(field);
    field = '';
  }
  function endRow() {
    endField();
    rows.push(row);
    row = [];
  }

  while (i < n) {
    const c = raw[i];
    if (inQuotes) {
      if (c === '"') {
        if (raw[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { endField(); i++; continue; }
    if (c === '\r') { i++; continue; } // normalize CRLF -> LF handling below
    if (c === '\n') { endRow(); i++; continue; }
    field += c; i++;
  }
  // flush final field/row if the file didn't end with a newline
  if (field.length > 0 || row.length > 0) endRow();

  // drop fully-blank rows (a single empty field from a stray trailing newline)
  const nonBlank = rows.filter((r) => !(r.length === 1 && r[0] === ''));
  if (nonBlank.length === 0) return { headers: [], rows: [] };

  const headers = nonBlank[0].map((h) => String(h).trim());
  const dataRows = nonBlank.slice(1);
  return { headers, rows: dataRows };
}

/**
 * Parse an XLSX Buffer. Reads static/computed cell values only (never
 * evaluates formulas/macros — XLSX.read with cellFormula:false, and
 * sheet_to_json's default reads the cached computed value, not source
 * formula text). Returns { sheetNames, headers, rows, sheetsInspected }
 * using the FIRST non-empty sheet as the primary headers/rows (a file
 * inspection caller can still see all sheet names).
 */
function parseXLSX(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellFormula: false, cellHTML: false });
  const sheetNames = wb.SheetNames;
  let headers = [];
  let rows = [];
  let chosenSheet = null;
  for (const name of sheetNames) {
    const sheet = wb.Sheets[name];
    const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '', blankrows: false });
    if (aoa.length > 0) {
      chosenSheet = name;
      headers = (aoa[0] || []).map((h) => String(h).trim());
      rows = aoa.slice(1).map((r) => headers.map((_, idx) => (r[idx] !== undefined ? String(r[idx]) : '')));
      break;
    }
  }
  return { sheetNames, chosenSheet, headers, rows };
}

function detectFileType(filename) {
  const ext = String(filename || '').toLowerCase().split('.').pop();
  if (ext === 'csv') return 'CSV';
  if (ext === 'xlsx' || ext === 'xlsm' || ext === 'xls') return 'XLSX';
  return 'UNKNOWN';
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}(T.*)?$|^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/;
const CURRENCY_SYMBOL_RE = /[₹$€£]/;
const NUMERIC_RE = /^-?[\d,]+(\.\d+)?$/;

function detectColumnType(values) {
  const nonEmpty = values.filter((v) => v !== null && v !== undefined && String(v).trim() !== '');
  if (nonEmpty.length === 0) return 'BLANK';
  let dateCount = 0, numericCount = 0, currencyCount = 0;
  for (const v of nonEmpty) {
    const s = String(v).trim();
    if (CURRENCY_SYMBOL_RE.test(s)) currencyCount++;
    if (DATE_RE.test(s) && isFinite(new Date(s).getTime())) dateCount++;
    else if (NUMERIC_RE.test(s.replace(/[₹$€£]/g, '').trim())) numericCount++;
  }
  const total = nonEmpty.length;
  if (currencyCount / total >= 0.5) return 'CURRENCY';
  if (dateCount / total >= 0.6) return 'DATE';
  if (numericCount / total >= 0.6) return 'NUMERIC';
  return 'TEXT';
}

/**
 * Produce a structured FILE INSPECTION result (mission Part 3) from raw
 * bytes + a filename (for extension-based type detection). Never writes
 * anything — pure parse + describe.
 */
function inspectFile(buffer, filename) {
  const fileType = detectFileType(filename);
  if (fileType === 'UNKNOWN') {
    return {
      fileType: 'UNKNOWN',
      supported: false,
      error: `Unrecognized file extension for "${filename}". Supported: .csv, .xlsx`,
    };
  }

  let parsed;
  if (fileType === 'CSV') {
    parsed = parseCSV(buffer.toString('utf8'));
    parsed.sheetNames = null;
  } else {
    parsed = parseXLSX(buffer);
  }

  const { headers, rows } = parsed;

  // duplicate header detection
  const headerCounts = new Map();
  for (const h of headers) headerCounts.set(h, (headerCounts.get(h) || 0) + 1);
  const duplicateHeaders = [...headerCounts.entries()].filter(([, c]) => c > 1).map(([h]) => h);

  // per-column type + blank-column detection
  const columnTypes = {};
  const blankColumns = [];
  headers.forEach((h, idx) => {
    const colValues = rows.map((r) => r[idx]);
    const type = detectColumnType(colValues);
    columnTypes[h || `(column ${idx + 1})`] = type;
    if (type === 'BLANK') blankColumns.push(h || `(column ${idx + 1})`);
  });

  const dataQualityIssues = [];
  if (duplicateHeaders.length > 0) dataQualityIssues.push(`duplicate header name(s): ${duplicateHeaders.join(', ')}`);
  if (blankColumns.length > 0) dataQualityIssues.push(`entirely blank column(s): ${blankColumns.join(', ')}`);
  if (headers.length === 0) dataQualityIssues.push('no headers detected (empty file)');

  return {
    fileType,
    supported: true,
    sheetNames: parsed.sheetNames || null,
    chosenSheet: parsed.chosenSheet || null,
    rowCount: rows.length,
    columnCount: headers.length,
    headers,
    sampleRows: rows.slice(0, 5),
    columnTypes,
    duplicateHeaders,
    blankColumns,
    dataQualityIssues,
    rows, // full parsed rows, for the caller to map + import
  };
}

module.exports = { parseCSV, parseXLSX, inspectFile, detectFileType, detectColumnType };
