// FILE: scripts/start-automation-service.js
// Launches the vantro-automation binary as a managed child process.
// Used in local development. In Railway, the binary runs as a separate process type.

'use strict';
const { spawn }  = require('child_process');
const path       = require('path');
const fs         = require('fs');
require('dotenv').config();

const IS_WIN   = process.platform === 'win32';
const BIN_NAME = IS_WIN ? 'vantro-automation.exe' : 'vantro-automation';
const ROOT     = path.resolve(__dirname, '..');

const CANDIDATES = [
  path.join(ROOT, 'bin', BIN_NAME),
  path.join(ROOT, 'target', 'release', BIN_NAME),
  path.join(ROOT, 'target', 'x86_64-pc-windows-gnu', 'release', BIN_NAME),
];
const bin = CANDIDATES.find(p => fs.existsSync(p));

if (!bin) {
  console.error('[automation] Binary not found. Run: npm run automation:build');
  process.exit(1);
}

const PORT = process.env.RUST_AUTOMATION_PORT || '3002';
console.log(`[automation] Starting ${bin} on port ${PORT}`);

const child = spawn(bin, [], {
  env:   { ...process.env, RUST_LOG: process.env.RUST_LOG || 'vantro_automation_rs=info' },
  stdio: 'inherit',
});

child.on('error',  (err) => { console.error('[automation] Failed to start:', err.message); process.exit(1); });
child.on('exit',   (code) => { console.log(`[automation] Exited with code ${code}`); process.exit(code || 0); });

// Forward SIGTERM/SIGINT.
process.on('SIGTERM', () => child.kill('SIGTERM'));
process.on('SIGINT',  () => child.kill('SIGINT'));
