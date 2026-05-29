// FILE: scripts/copy-automation-binary.js
// Copies vantro-automation binary from target/release/ to bin/ after cargo build.

'use strict';
const fs   = require('fs');
const path = require('path');

const IS_WIN   = process.platform === 'win32';
const BIN_NAME = IS_WIN ? 'vantro-automation.exe' : 'vantro-automation';
const ROOT     = path.resolve(__dirname, '..');

const CANDIDATES = [
  path.join(ROOT, 'target', 'release', BIN_NAME),
  path.join(ROOT, 'target', 'x86_64-pc-windows-gnu', 'release', BIN_NAME),
];

const src = CANDIDATES.find(p => fs.existsSync(p));
if (!src) {
  console.error(`[copy-automation-binary] Source not found in:\n  ${CANDIDATES.join('\n  ')}`);
  process.exit(1);
}

const dest = path.join(ROOT, 'bin', BIN_NAME);
if (!fs.existsSync(path.join(ROOT, 'bin'))) fs.mkdirSync(path.join(ROOT, 'bin'), { recursive: true });
fs.copyFileSync(src, dest);
if (!IS_WIN) fs.chmodSync(dest, 0o755);
const stat = fs.statSync(dest);
console.log(`[copy-automation-binary] ✓ ${dest}  (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
