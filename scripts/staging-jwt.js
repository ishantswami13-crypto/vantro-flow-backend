'use strict';
// scripts/staging-jwt.js
// Generates a NON-PRODUCTION JWT for staging perf tests.
// Uses the same JWT_SECRET as the staging Railway service so the Rust auth
// middleware accepts the token.
//
// The token is written to .staging-token (gitignored) and its existence is
// printed to stdout. The token VALUE is never printed.
//
// Usage:
//   JWT_SECRET=<staging-secret> node scripts/staging-jwt.js
//
// Then set:
//   PERF_TEST_TOKEN=$(cat .staging-token) npm run perf:test
//   (or however the secret-safe env handoff works in your shell)

const jwt   = require('jsonwebtoken');
const fs    = require('fs');
const path  = require('path');
const crypto = require('crypto');

const SECRET = process.env.JWT_SECRET;
if (!SECRET) {
  console.error('[staging-jwt] ERROR: JWT_SECRET is not set.');
  process.exit(1);
}

// Test identity — deterministic UUID matching the seed user.
// This is NOT a real user; it exists only in the staging DB.
const TEST_USER_ID = '11111111-1111-1111-1111-111111111111';

const payload = {
  userId:   TEST_USER_ID,
  email:    'ownerA@harness.test',
  _staging: true,   // marker so token is clearly non-prod if inspected
  jti:      crypto.randomBytes(8).toString('hex'),
};

// 2-hour expiry — enough for a full perf run session, not so long it's dangerous
const token = jwt.sign(payload, SECRET, { expiresIn: '2h' });

const outPath = path.join(__dirname, '..', '.staging-token');
fs.writeFileSync(outPath, token, { mode: 0o600 });

// Print ONLY the file path and facts about the token — never the token value itself
console.log('[staging-jwt] Non-prod JWT written to .staging-token');
console.log(`  user_id: ${TEST_USER_ID}`);
console.log(`  email:   ownerA@harness.test`);
console.log(`  expires: 2h from now`);
console.log(`  marker:  _staging=true`);
console.log('');
console.log('  Load into perf test with:');
console.log('    PERF_TEST_TOKEN=$(cat .staging-token) npm run perf:test ...');
console.log('');
console.log('  Verify auth rejection before use:');
console.log('    node scripts/staging-verify-auth.js');
