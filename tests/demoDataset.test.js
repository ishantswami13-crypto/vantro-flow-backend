// FILE: tests/demoDataset.test.js
// The Apex demo files: the generator's totals agree with the files it writes,
// overdue is counted from due dates on the day the files are made, and the
// XLSX carries the same bills as the CSV.
//
// Run: node --test tests/demoDataset.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const XLSX = require('xlsx');

test('demo dataset totals match the rows, on any day it is made', () => {
  for (const asOf of ['2026-10-19', '2027-02-01']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-'));
    execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'demo', 'make-demo-dataset.js'), dir, '--as-of', asOf]);
    const expected = JSON.parse(fs.readFileSync(path.join(dir, 'expected.json'), 'utf8'));
    const [, ...lines] = fs.readFileSync(path.join(dir, 'apex-invoices.csv'), 'utf8').trim().split('\n');
    const bills = lines.map((l) => { const c = l.split(','); const [d, m, y] = c[3].split('/').map(Number); return { due: Date.UTC(y, m - 1, d), amount: Number(c[4]) }; });
    const day = Date.parse(`${asOf}T00:00:00Z`);
    assert.equal(expected.asOf, asOf);
    assert.equal(bills.length, expected.bills);
    assert.equal(bills.reduce((s, b) => s + b.amount, 0), expected.outstanding);
    assert.equal(bills.filter((b) => b.due < day).reduce((s, b) => s + b.amount, 0), expected.overdue);
    assert.equal(expected.outstanding, 4721600, 'amounts do not move with the date');
    const sheet = XLSX.utils.sheet_to_json(XLSX.readFile(path.join(dir, 'Apex-Bills-Receivable.xlsx')).Sheets['Bills Receivable'], { header: 1 });
    const data = sheet.slice(6).filter((r) => r.length);
    assert.equal(data.length, expected.bills);
    assert.equal(data.reduce((s, r) => s + Number(r[3]), 0), expected.outstanding);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
