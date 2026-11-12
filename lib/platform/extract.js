'use strict';
// Text extraction for Knowledge uploads: PDF (text layer), Word (.docx) and
// plain text. The file type is decided from the file's own bytes, not from
// the name or the type the browser claims. Nothing is guessed: a scanned PDF
// with no text layer, a legacy .doc or a spreadsheet is refused with the
// reason, never stored as an empty or garbled document.

const { badRequest } = require('./errors');

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const PARSE_TIMEOUT_MS = 30_000;

function kindOf(buf) {
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) {
    // A ZIP: .docx keeps its body in word/document.xml (the name is stored uncompressed in the archive).
    return buf.includes(Buffer.from('word/document.xml')) ? 'docx' : 'zip';
  }
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0xd0cf11e0) return 'ole'; // legacy .doc / .xls
  return buf.subarray(0, 4096).includes(0) ? 'binary' : 'text';
}

function withTimeout(promise, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(badRequest(`Reading the ${what} took too long. Try a smaller file.`)), PARSE_TIMEOUT_MS); }),
  ]).finally(() => clearTimeout(timer));
}

/** Normalise extracted text: unify line breaks, drop page-break noise and trailing spaces. */
function tidy(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\f/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

/**
 * Extract text from an uploaded file.
 * @returns {Promise<{ text: string, mimeType: string, kind: 'pdf'|'docx'|'text', pages?: number }>}
 */
async function extractText(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw badRequest('The file is empty.');
  if (buffer.length > MAX_UPLOAD_BYTES) throw badRequest('Files up to 15 MB can be added to Knowledge.');
  const kind = kindOf(buffer);

  if (kind === 'pdf') {
    const { PDFParse } = require('pdf-parse');
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    let result;
    try {
      result = await withTimeout(parser.getText(), 'PDF');
    } catch (err) {
      if (err && err.code === 'BAD_REQUEST') throw err;
      throw badRequest(/password/i.test(String(err?.message)) ? 'That PDF is password-protected. Remove the password and upload it again.' : 'That PDF could not be read. It may be damaged.');
    } finally {
      await parser.destroy().catch(() => {});
    }
    const text = tidy(result?.text).replace(/^-- \d+ of \d+ --$/gm, '').trim();
    if (text.replace(/\s/g, '').length < 20) {
      throw badRequest('That PDF has no text layer (it looks scanned). Starlane does not read scanned pages yet; export it with text or paste the text.');
    }
    return { text, mimeType: 'application/pdf', kind: 'pdf', pages: result?.total ?? undefined };
  }

  if (kind === 'docx') {
    const mammoth = require('mammoth');
    let result;
    try {
      result = await withTimeout(mammoth.extractRawText({ buffer }), 'Word document');
    } catch (err) {
      if (err && err.code === 'BAD_REQUEST') throw err;
      throw badRequest('That Word document could not be read. It may be damaged.');
    }
    const text = tidy(result?.value);
    if (!text) throw badRequest('That Word document has no text.');
    return { text, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', kind: 'docx' };
  }

  if (kind === 'text') {
    const text = tidy(buffer.toString('utf8').replace(/^﻿/, ''));
    if (!text) throw badRequest('That file has no text.');
    return { text, mimeType: 'text/plain', kind: 'text' };
  }

  if (kind === 'ole') throw badRequest('Older Word and Excel files (.doc, .xls) are not supported. Save it as .docx, PDF or text.');
  if (kind === 'zip') throw badRequest('Only Word (.docx) is read from Office files. Spreadsheets and other archives are not supported yet.');
  throw badRequest('Starlane reads PDF, Word (.docx) and text files. This file is none of those.');
}

module.exports = { extractText, kindOf, MAX_UPLOAD_BYTES };
