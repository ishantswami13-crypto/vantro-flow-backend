#!/usr/bin/env node
/**
 * Phase 2C.35 — Backend Launch-Hardening Static Checker
 * ----------------------------------------------------------------------------
 * SAFE, READ-ONLY, OFFLINE. This script ONLY reads source files with
 * fs.readFileSync and matches regex patterns. It does NOT:
 *   - require()/execute server.js or any app module (no DB connect, no listen)
 *   - open any network/DB/Railway connection
 *   - send any WhatsApp/SMS/email/push/webhook
 *   - read or print any secret, env value, token, OTP, phone, or tenant id
 *
 * Purpose: fail-closed gate that flags the launch-hardening blockers found in
 * the Phase 2C.35 audit. Each gate asserts that an UNSAFE pattern is absent (or
 * a SAFE control is present). A RED gate means the unsafe condition is still in
 * the code. The checker exits non-zero while any BLOCKER- or HIGH-severity gate
 * is RED, so CI / a pre-launch gate stays red until the fixes land.
 *
 * Usage:
 *   node scripts/phase-2c-35-backend-launch-hardening-check.js
 *   node scripts/phase-2c-35-backend-launch-hardening-check.js --warn-high   # HIGH = warning, not failing
 *   node scripts/phase-2c-35-backend-launch-hardening-check.js --json
 *
 * Exit codes: 0 = no BLOCKER/HIGH RED (or --warn-high and no BLOCKER RED); 1 = gate(s) RED; 2 = checker error.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const WARN_HIGH = argv.includes('--warn-high');
const AS_JSON = argv.includes('--json');

/** Read a repo-relative file as text; returns null if missing (gate decides how to treat absence). */
function read(rel) {
  try {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8');
  } catch {
    return null;
  }
}

/** Count regex matches in text (global). */
function count(text, re) {
  if (!text) return 0;
  const m = text.match(re);
  return m ? m.length : 0;
}

const results = [];
/**
 * Register a gate.
 * @param {string} id
 * @param {'BLOCKER'|'HIGH'|'MEDIUM'} severity
 * @param {string} title
 * @param {() => {red: boolean, detail: string}} probe  red:true = unsafe condition present
 */
function gate(id, severity, title, probe) {
  let red = false;
  let detail = '';
  try {
    const r = probe();
    red = !!r.red;
    detail = r.detail || '';
  } catch (e) {
    // A probe that throws (e.g. unexpected file shape) is treated as RED/unknown, never as silent green.
    red = true;
    detail = `probe error: ${e.message}`;
  }
  results.push({ id, severity, title, status: red ? 'RED' : 'GREEN', detail });
}

const serverJs = read('server.js');
const featureFlags = read('lib/featureFlags.js');
const pgConfig = read('lib/db/pgConfig.js');
const rustConfig = read('vantro-automation-rs/src/config.rs');
const rustAuth = read('vantro-automation-rs/src/auth.rs');
const rustQueries = read('vantro-automation-rs/src/db/queries.rs');

// ───────────────────────────────────────────────────────────────────────────
// BLOCKER gates
// ───────────────────────────────────────────────────────────────────────────

// G01 — External-send kill-switch must be enforced in code (not merely defined/reported).
gate('G01', 'BLOCKER', 'External-send kill-switch (FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED) enforced on send paths', () => {
  if (!serverJs) return { red: true, detail: 'server.js unreadable' };
  const definedInFlags = featureFlags && /external_message_sending_enabled/.test(featureFlags);
  // The flag must be REFERENCED somewhere in server.js (the choke point sendWhatsAppMessage / send routes / crons).
  const enforcedInServer = /external_message_sending_enabled|FEATURE_EXTERNAL_MESSAGE_SENDING/.test(serverJs);
  const sendSites =
    count(serverJs, /sendWhatsAppMessage\s*\(/g) +
    count(serverJs, /\.(messages|calls)\.create\s*\(/g) +
    count(serverJs, /webpush\.sendNotification\s*\(/g);
  if (!enforcedInServer) {
    return {
      red: true,
      detail: `flag ${definedInFlags ? 'defined in featureFlags' : 'NOT defined'} but referenced 0x in server.js; ${sendSites} send call-sites are ungated. Add a fail-closed guard inside sendWhatsAppMessage()/calls.create()/sendNotification().`,
    };
  }
  return { red: false, detail: `flag referenced in server.js across send paths (${sendSites} send sites present)` };
});

// G02 — Pre-OTP "preVerify" token must be rejected by the session middlewares (authMiddleware / requireOwner / adminOnly).
gate('G02', 'BLOCKER', 'preVerify (pre-OTP) token rejected by session auth middleware', () => {
  if (!serverJs) return { red: true, detail: 'server.js unreadable' };
  const mints = /preVerify\s*:\s*true/.test(serverJs);
  // A rejection guard looks like:  if (... preVerify ...) return res.status(401|403)
  const hasRejection = /preVerify[^\n;]{0,80}return\s+res\.status\(\s*(401|403)/.test(serverJs);
  if (mints && !hasRejection) {
    return { red: true, detail: 'preVerify token is minted but no `if (req.user.preVerify) return res.status(401)` guard exists in authMiddleware/requireOwner/adminOnly — unverified session is accepted.' };
  }
  if (!mints) return { red: false, detail: 'no preVerify token minted (n/a)' };
  return { red: false, detail: 'preVerify rejection guard present' };
});

// G03 — Rust sidecar x-user-id auth bypass must not fail OPEN (NODE_ENV default to "development" with no Railway fail-safe).
gate('G03', 'BLOCKER', 'Rust sidecar x-user-id bypass is fail-closed (no insecure default env)', () => {
  if (rustConfig === null && rustAuth === null) {
    return { red: false, detail: 'rust sidecar sources not present in this checkout (skipped)' };
  }
  const hasBypass = rustAuth && /x-user-id/.test(rustAuth);
  // Closure param may be `||` or `|_|`; match either form of the insecure default.
  const insecureDefault = rustConfig && /unwrap_or_else\(\s*\|[^|]*\|\s*"development"/.test(rustConfig);
  const hasRailwayFailsafe = rustConfig && /RAILWAY_/.test(rustConfig);
  if (hasBypass && insecureDefault && !hasRailwayFailsafe) {
    return { red: true, detail: 'auth.rs accepts `x-user-id` when is_dev(); config.rs defaults app_env to "development" (NODE_ENV unwrap_or_else) with NO RAILWAY_* fail-safe → fail-OPEN tenant impersonation if NODE_ENV unset.' };
  }
  if (hasBypass && insecureDefault) {
    return { red: true, detail: 'x-user-id bypass present and config defaults to "development"; verify a fail-closed gate exists.' };
  }
  return { red: false, detail: 'no fail-open x-user-id bypass detected' };
});

// ───────────────────────────────────────────────────────────────────────────
// HIGH gates
// ───────────────────────────────────────────────────────────────────────────

// G04 — payment_status === 'Overdue' phantom reads (no write path ever stores 'Overdue').
gate('G04', 'HIGH', "No read filters on payment_status='Overdue' (a value no write path stores)", () => {
  const overdueRe = /payment_status['"\s,)]*[=:]+\s*['"]Overdue['"]|payment_status\s*===\s*['"]Overdue['"]|=\s*'Overdue'/g;
  const writeRe = /(insert|update)[\s\S]{0,200}payment_status[^a-zA-Z]{0,6}['"]Overdue['"]/gi;
  const jsReads = count(serverJs, overdueRe);
  const rustReads = count(rustQueries, /payment_status\s*=\s*'Overdue'/g);
  const writes = count(serverJs, writeRe);
  const total = jsReads + rustReads;
  if (total > 0 && writes === 0) {
    return { red: true, detail: `${jsReads} JS + ${rustReads} Rust read site(s) filter on payment_status='Overdue' but 0 write paths store it → overdue KPIs structurally 0. Use payment_status='Pending' AND days_overdue>0.` };
  }
  return { red: false, detail: `overdue reads=${total}, writes=${writes}` };
});

// G05 — Plaintext OTP / full message body must not be written to logs.
gate('G05', 'HIGH', 'No plaintext OTP or message body written to logs', () => {
  if (!serverJs) return { red: true, detail: 'server.js unreadable' };
  const otpLog = /console\.log\([^)]*Code:\s*[`'"]?\s*\$\{?\s*otp/.test(serverJs) || /console\.log\([^)]*\$\{otp\}/.test(serverJs);
  const waMockBody = /\[WA MOCK\][^\n]*\$\{message\}/.test(serverJs);
  if (otpLog || waMockBody) {
    return { red: true, detail: `${otpLog ? 'OTP value logged; ' : ''}${waMockBody ? 'full WhatsApp message body logged at mock path; ' : ''}route through safeLog with values omitted/masked.` };
  }
  return { red: false, detail: 'no OTP/message-body console logs detected' };
});

// G06 — No bare req.user.id / req.user?.id without the userId fallback (JWT signs { userId }).
gate('G06', 'HIGH', 'No bare req.user.id (JWT claim is userId; bare .id is undefined)', () => {
  if (!serverJs) return { red: true, detail: 'server.js unreadable' };
  // Match req.user.id / req.user?.id that is NOT immediately the right side of `userId || `.
  const bareRe = /(?<!userId\s*\|\|\s*)req\.user\??\.id\b/g;
  const n = count(serverJs, bareRe);
  if (n > 0) {
    return { red: true, detail: `${n} bare req.user(.|?.)id occurrence(s) not guarded by req.user.userId || fallback → undefined identity. Use req.user?.userId || req.user?.id.` };
  }
  return { red: false, detail: 'all req.user identity reads use userId (with safe fallback)' };
});

// G07 — Public bill endpoint must default to requiring a signed token (fail-closed), not REQUIRE_SIGNED===true opt-in.
gate('G07', 'HIGH', 'Public bill endpoint requires signed token by default (no fail-open PII)', () => {
  if (!serverJs) return { red: true, detail: 'server.js unreadable' };
  const hasPublicBill = /\/api\/bills\/public\//.test(serverJs);
  if (!hasPublicBill) return { red: false, detail: 'no public bill route present (n/a)' };
  // Fail-open shape: signing only required when env === 'true'.
  const failOpen = /REQUIRE_SIGNED_PUBLIC_BILLS\s*===\s*'true'/.test(serverJs);
  if (failOpen) {
    return { red: true, detail: 'signed-token enforcement is gated behind REQUIRE_SIGNED_PUBLIC_BILLS===\'true\' (default OFF) → unauthenticated PII disclosure by bill UUID. Default to required.' };
  }
  return { red: false, detail: 'public bill route does not appear to default fail-open' };
});

// ───────────────────────────────────────────────────────────────────────────
// MEDIUM gates (informational; never affect exit code)
// ───────────────────────────────────────────────────────────────────────────

// G08 — Postgres TLS peer-cert verification disabled.
gate('G08', 'MEDIUM', 'Postgres TLS verifies server certificate (rejectUnauthorized not false)', () => {
  if (pgConfig === null) return { red: false, detail: 'pgConfig.js not present (skipped)' };
  const disabled = /rejectUnauthorized\s*:\s*false/.test(pgConfig);
  return disabled
    ? { red: true, detail: 'lib/db/pgConfig.js sets ssl.rejectUnauthorized:false — MITM-hardening gap (encrypted but unverified). Pin Supabase CA or document accepted risk.' }
    : { red: false, detail: 'no rejectUnauthorized:false in pgConfig' };
});

// G09 — jwt.verify pins an algorithms allowlist.
gate('G09', 'MEDIUM', 'jwt.verify pins an algorithms allowlist', () => {
  if (!serverJs) return { red: false, detail: 'server.js unreadable (skipped)' };
  const verifies = /jwt\.verify\s*\(/.test(serverJs);
  const pinned = /jwt\.verify\s*\([^)]*algorithms\s*:/.test(serverJs) || /algorithms\s*:\s*\[\s*['"]HS256/.test(serverJs);
  if (verifies && !pinned) {
    return { red: true, detail: 'verifyJWT calls jwt.verify with no { algorithms:[\'HS256\'] } allowlist (defense-in-depth).' };
  }
  return { red: false, detail: 'algorithms allowlist present or no jwt.verify' };
});

// ───────────────────────────────────────────────────────────────────────────
// Report
// ───────────────────────────────────────────────────────────────────────────

const sev = (s) => results.filter((r) => r.severity === s && r.status === 'RED').length;
const redBlocker = sev('BLOCKER');
const redHigh = sev('HIGH');
const redMedium = sev('MEDIUM');

if (AS_JSON) {
  process.stdout.write(JSON.stringify({ results, summary: { redBlocker, redHigh, redMedium } }, null, 2) + '\n');
} else {
  const line = '─'.repeat(78);
  console.log(line);
  console.log('Phase 2C.35 — Backend Launch-Hardening Static Checker (safe, read-only)');
  console.log(line);
  for (const r of results) {
    const mark = r.status === 'GREEN' ? 'PASS' : 'FAIL';
    console.log(`[${mark}] ${r.id} (${r.severity})  ${r.title}`);
    if (r.detail) console.log(`        ${r.detail}`);
  }
  console.log(line);
  console.log(`RED gates → BLOCKER: ${redBlocker}   HIGH: ${redHigh}   MEDIUM: ${redMedium}`);
  console.log('Note: a RED gate documents an OPEN launch-hardening item. This gate stays');
  console.log('red until the corresponding fix lands. MEDIUM gates never affect exit code.');
  console.log(line);
}

const fail = redBlocker > 0 || (!WARN_HIGH && redHigh > 0);
process.exit(fail ? 1 : 0);
