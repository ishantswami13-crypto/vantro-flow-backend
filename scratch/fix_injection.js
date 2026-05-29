const fs = require('fs');
const path = require('path');

const serverPath = path.join(__dirname, '..', 'server.js');
let code = fs.readFileSync(serverPath, 'utf8');

// 1. Remove my injected block
const startMarker = '// ── PERFORMANCE BOOTSTRAP ENDPOINTS ─────────────────────────────────────────';
const endMarker = '// ────────────────────────────────────────────────────────────────────────────\n';

const startIdx = code.indexOf(startMarker);
const endIdx = code.indexOf(endMarker);
if (startIdx !== -1 && endIdx !== -1) {
  code = code.slice(0, startIdx) + code.slice(endIdx + endMarker.length);
  fs.writeFileSync(serverPath, code);
  console.log('Removed badly performing injected block');
} else {
  console.log('Could not find injected block');
}

// 2. Run the proper patch scripts
require('./patch_bootstrap.js');
require('./patch_cortex.js');

console.log('Ran correct patch scripts');
