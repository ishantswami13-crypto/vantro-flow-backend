// FILE: scripts/copy-cortex-binary.js
// Copies the compiled Rust binary from target/release/ to bin/ after cargo build.
// Run automatically by npm run cortex:rust:build.

'use strict';
const fs   = require('fs');
const path = require('path');

const IS_WIN    = process.platform === 'win32';
const BIN_NAME  = IS_WIN ? 'cortex-core.exe' : 'cortex-core';
const ROOT      = path.resolve(__dirname, '..');
const SRC       = path.join(ROOT, 'target', 'release', BIN_NAME);
const DEST_DIR  = path.join(ROOT, 'bin');
const DEST      = path.join(DEST_DIR, BIN_NAME);

if (!fs.existsSync(SRC)) {
  console.error(`[copy-cortex-binary] Source not found: ${SRC}`);
  console.error('Run: cargo build --release -p cortex-core  first.');
  process.exit(1);
}

if (!fs.existsSync(DEST_DIR)) fs.mkdirSync(DEST_DIR, { recursive: true });

fs.copyFileSync(SRC, DEST);
if (!IS_WIN) fs.chmodSync(DEST, 0o755);

const stat = fs.statSync(DEST);
console.log(`[copy-cortex-binary] ✓ ${DEST}  (${(stat.size / 1024).toFixed(0)} KB)`);
