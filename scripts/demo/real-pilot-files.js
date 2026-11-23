#!/usr/bin/env node
// FILE: scripts/demo/real-pilot-files.js
// `npm run demo:real-pilot:files [folder]`: writes the four synthetic files of
// the Nirmal Pumps pilot demo (docs/pilot/README.md), dated relative to
// today, for uploading by hand through Decisions -> Import orders & POs.
// Writes files only; touches no database.
const fs = require('fs');
const path = require('path');
const { productsCsv, componentsCsv, purchaseCsv, ordersXlsx } = require('../../tests/fixtures/realPilot');

const out = path.resolve(process.argv[2] || 'pilot-demo-files');
const today = new Date().toISOString().slice(0, 10);
fs.mkdirSync(out, { recursive: true });
const files = [
  ['1-nirmal-item-master.csv', productsCsv()],
  ['2-nirmal-bill-of-materials.csv', componentsCsv()],
  ['3-nirmal-open-purchase-orders.csv', purchaseCsv(today)],
  ['4-nirmal-open-sales-orders.xlsx', ordersXlsx(today)],
];
for (const [name, buf] of files) fs.writeFileSync(path.join(out, name), buf);
console.log(`Wrote ${files.length} files dated from ${today} to ${out}:\n${files.map(([f]) => `  ${f}`).join('\n')}`);
