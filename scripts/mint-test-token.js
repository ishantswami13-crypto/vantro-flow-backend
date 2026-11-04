#!/usr/bin/env node
// mint-test-token.js — LOCAL DEV ONLY.
//
// Mints a valid session JWT for a given user id, using the exact same
// signing call the real app makes on login (see server.js /api/auth/login
// and /api/auth/verify-otp: jwt.sign({ userId, email }, JWT_SECRET,
// { expiresIn: '30d' })), so the token is accepted as-is by authMiddleware
// in server.js. This does NOT add any new capability — it just reuses the
// app's own existing signing logic instead of re-deriving it ad hoc every
// session.
//
// NEVER use this against a production deployment. It reads JWT_SECRET from
// the local backend's .env (via dotenv) and never prints the secret itself
// — only the resulting token.
//
// Usage:
//   node scripts/mint-test-token.js <userId> [email]
//
// If [email] is omitted, the script looks the user up in the local
// Postgres DB (DATABASE_URL) to get their real email, matching the claims
// a real login would produce. Falls back to a placeholder email if the DB
// lookup fails or is unavailable.
//
// Example:
//   node scripts/mint-test-token.js 4a8d8781-c415-4e3d-aa4b-11384719577e
//
// Then in the browser (matching how lib/api.ts / saveAuth() stores it):
//   localStorage.setItem('vantro_token', '<printed token>')

'use strict';

require('dotenv').config();
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;

async function lookupEmail(userId) {
  try {
    const { Pool } = require('pg');
    if (!process.env.DATABASE_URL) return null;
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    const { rows } = await pool.query('SELECT email FROM users WHERE id = $1', [userId]);
    await pool.end();
    return rows[0]?.email || null;
  } catch {
    return null;
  }
}

async function main() {
  const userId = process.argv[2];
  let email = process.argv[3];

  if (!userId) {
    console.error('Usage: node scripts/mint-test-token.js <userId> [email]');
    process.exit(1);
  }

  if (!JWT_SECRET) {
    console.error('[FATAL] JWT_SECRET is missing from environment (.env). Refusing to mint a token.');
    process.exit(1);
  }

  if (!email) {
    email = await lookupEmail(userId);
    if (!email) email = `test-${userId}@local.dev`;
  }

  // Same shape/claims as server.js's real login routes.
  const token = jwt.sign({ userId, email }, JWT_SECRET, { expiresIn: '30d' });

  console.log(token);
  console.error(`\n[mint-test-token] Minted 30d token for userId=${userId} email=${email}`);
  console.error(`[mint-test-token] Load into the app with: localStorage.setItem('vantro_token', '<token>')`);
}

main();
