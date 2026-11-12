// Knowledge upload text extraction (lib/platform/extract.js): PDF text layer,
// Word (.docx) and plain text are read; scanned PDFs, legacy Office files,
// other archives and binaries are refused with a reason, never stored empty.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { extractText, kindOf, MAX_UPLOAD_BYTES } = require('../lib/platform/extract.js');
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'knowledge');
const fixture = (f) => readFileSync(path.join(dir, f));

let pass = 0; let fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✅', name); } else { fail++; console.log('  ❌', name, detail !== undefined ? `— ${JSON.stringify(detail)}` : ''); }
};
const refusal = async (buf) => { try { await extractText(buf); return null; } catch (e) { return e; } };

const pdf = await extractText(fixture('warranty.pdf'));
check('PDF text layer is read', pdf.kind === 'pdf' && /18 month warranty/.test(pdf.text) && /invoice number/.test(pdf.text), pdf);
check('PDF page count reported', pdf.pages === 1, pdf.pages);
check('PDF mime type comes from the bytes', pdf.mimeType === 'application/pdf');

const docx = await extractText(fixture('onboarding.docx'));
check('Word .docx text is read', docx.kind === 'docx' && /credit agreement/.test(docx.text) && /^Onboarding checklist/.test(docx.text), docx);

const txt = await extractText(Buffer.from('﻿Line one  \r\nLine two\f\n\n\n\n\nEnd'));
check('text is tidied (BOM, CRLF, form feed, blank runs)', txt.kind === 'text' && txt.text === 'Line one\nLine two\n\n\nEnd', txt.text);

const scanned = await refusal(fixture('scanned.pdf'));
check('scanned PDF refused with the reason', scanned?.status === 400 && /no text layer/.test(scanned.message), scanned?.message);
const legacy = await refusal(fixture('legacy.doc'));
check('legacy .doc refused', legacy?.status === 400 && /\.doc/.test(legacy.message), legacy?.message);
const zip = await refusal(Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('xl/workbook.xml')]));
check('spreadsheet zip refused', zip?.status === 400 && /Spreadsheets/.test(zip.message), zip?.message);
const bin = await refusal(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
check('binary (image) refused', bin?.status === 400 && /PDF, Word/.test(bin.message), bin?.message);
const broken = await refusal(Buffer.from('%PDF-1.4\nthis is not really a pdf'));
check('damaged PDF refused, not stored', broken?.status === 400, broken?.message);
check('empty file refused', (await refusal(Buffer.alloc(0)))?.status === 400);
check('oversize file refused', (await refusal(Buffer.alloc(MAX_UPLOAD_BYTES + 1, 0x41)))?.status === 400);
check('a .pdf name on a text file does not make it a PDF', kindOf(Buffer.from('plain words')) === 'text');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
