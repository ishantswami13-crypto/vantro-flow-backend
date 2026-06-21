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

// G01 — External-send kill-switch must be enforced via the central guard at every send path.
gate('G01', 'BLOCKER', 'External-send kill-switch enforced via central guard on every send path', () => {
  if (!serverJs) return { red: true, detail: 'server.js unreadable' };
  const guardModule = read('lib/safety/externalSend.js');
  const moduleEnforcesFlag = !!guardModule && /external_message_sending_enabled/.test(guardModule) && /guardExternalSend/.test(guardModule);
  const requiredInServer = /require\(['"]\.\/lib\/safety\/externalSend['"]\)/.test(serverJs);
  const guardCalls = count(serverJs, /guardExternalSend\s*\(/g);
  // The WhatsApp choke point (covers all sendWhatsAppMessage call-sites) must call the guard.
  const waIdx = serverJs.indexOf('async function sendWhatsAppMessage');
  const waBody = waIdx >= 0 ? serverJs.slice(waIdx, waIdx + 1600) : '';
  const waGuarded = /guardExternalSend\s*\(\s*['"]whatsapp['"]/.test(waBody);
  // Every voice calls.create site should be guarded (3 sites → at least 3 voice guards).
  const voiceSites = count(serverJs, /\.calls\.create\s*\(/g);
  const voiceGuards = count(serverJs, /guardExternalSend\s*\(\s*['"]voice['"]/g);
  if (!moduleEnforcesFlag) return { red: true, detail: 'lib/safety/externalSend.js missing or does not enforce external_message_sending_enabled.' };
  if (!requiredInServer || guardCalls < 1) return { red: true, detail: 'server.js does not require/use the external-send guard.' };
  if (!waGuarded) return { red: true, detail: 'sendWhatsAppMessage choke point does not route through guardExternalSend.' };
  if (voiceSites > voiceGuards) return { red: true, detail: `${voiceSites} voice calls.create site(s) but only ${voiceGuards} voice guard(s).` };
  return { red: false, detail: `guard enforces flag; ${guardCalls} guard call-site(s); WhatsApp choke point + ${voiceGuards}/${voiceSites} voice sites guarded.` };
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

// G03 — Rust sidecar x-user-id bypass must be fail-closed: explicit opt-in, never on Railway, never prod.
gate('G03', 'BLOCKER', 'Rust sidecar x-user-id bypass is fail-closed (explicit opt-in, never Railway/prod)', () => {
  if (rustConfig === null && rustAuth === null) {
    return { red: false, detail: 'rust sidecar sources not present in this checkout (skipped)' };
  }
  const hasBypass = rustAuth && /x-user-id/.test(rustAuth);
  if (!hasBypass) return { red: false, detail: 'no x-user-id bypass present' };
  // Insecure default: NODE_ENV unwrap_or_else to "development" (|| or |_| closure form).
  const insecureDefault = rustConfig && /unwrap_or_else\(\s*\|[^|]*\|\s*"development"/.test(rustConfig);
  const gatedByExplicit = rustAuth && /config\.dev_auth_bypass/.test(rustAuth);
  const stillGatedByIsDev = rustAuth && /is_dev\(\)\s*\{[\s\S]{0,200}x-user-id/.test(rustAuth);
  const hasPolicy = rustConfig && /compute_dev_auth_bypass/.test(rustConfig) && /RAILWAY_/.test(rustConfig);
  if (insecureDefault) return { red: true, detail: 'config.rs still defaults app_env to "development" (fail-open).' };
  if (stillGatedByIsDev || !gatedByExplicit) return { red: true, detail: 'auth.rs x-user-id branch is not gated by config.dev_auth_bypass (fail-open).' };
  if (!hasPolicy) return { red: true, detail: 'config.rs lacks compute_dev_auth_bypass + RAILWAY_* fail-safe.' };
  return { red: false, detail: 'x-user-id gated by explicit RUST_DEV_AUTH_BYPASS; disabled on Railway; default env = production.' };
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
  // Ignore comment-only lines so prose mentioning the pattern cannot trip the gate.
  const codeOnly = serverJs
    .split('\n')
    .filter((ln) => !ln.trim().startsWith('//') && !ln.trim().startsWith('*'))
    .join('\n');
  // Match req.user.id / req.user?.id that is NOT immediately the right side of `userId || `.
  const bareRe = /(?<!userId\s*\|\|\s*)req\.user\??\.id\b/g;
  const n = count(codeOnly, bareRe);
  if (n > 0) {
    return { red: true, detail: `${n} bare req.user(.|?.)id occurrence(s) not guarded by req.user.userId || fallback → undefined identity. Use req.user?.userId || req.user?.id.` };
  }
  return { red: false, detail: 'all req.user identity reads use userId (with safe fallback)' };
});

// G07 — Public bill: fail-closed by default AND minimal payload (no customer/seller PII).
gate('G07', 'HIGH', 'Public bill requires signed token by default + minimal payload (no PII)', () => {
  if (!serverJs) return { red: true, detail: 'server.js unreadable' };
  const idx = serverJs.indexOf("app.get('/api/bills/public/:id'");
  if (idx < 0) return { red: false, detail: 'no public bill route present (n/a)' };
  const block = serverJs.slice(idx, idx + 2600);
  // Fail-open shape: signing only required when env === 'true'.
  if (/REQUIRE_SIGNED_PUBLIC_BILLS\s*===\s*'true'/.test(serverJs)) {
    return { red: true, detail: "signed-token enforcement gated behind REQUIRE_SIGNED_PUBLIC_BILLS==='true' (default OFF) → PII disclosure by bill UUID. Default to required." };
  }
  // Inspect ONLY the .select(...) field list (not surrounding comments).
  const selMatch = block.match(/\.from\(['"]bills['"]\)\s*\.select\(\s*['"]([^'"]+)['"]/);
  if (!selMatch) return { red: true, detail: 'could not locate the bills public .select(...) to verify payload fields.' };
  const sel = selMatch[1];
  const leaks = ['customer_phone', 'customer_email', 'customer_gstin', 'business_address', 'owner_name'].filter((f) => sel.includes(f));
  if (/users\([^)]*\bgstin\b/.test(sel)) leaks.push('users.gstin');
  if (leaks.length) {
    return { red: true, detail: `public bill payload still exposes: ${leaks.join(', ')}. Remove from the default external-safe payload.` };
  }
  return { red: false, detail: 'public bill fail-closed by default; payload excludes customer/seller PII + owner name' };
});

// G10 — invoices.status='unpaid' reads (invoices use payment_status, not a status column).
gate('G10', 'HIGH', "No invoices reads on a non-existent status='unpaid' column", () => {
  if (!serverJs) return { red: true, detail: 'server.js unreadable' };
  const re = /from\(['"]invoices['"]\)[\s\S]{0,200}?\.eq\(\s*['"]status['"]\s*,\s*['"]unpaid['"]\s*\)/g;
  const n = count(serverJs, re);
  if (n > 0) return { red: true, detail: `${n} invoices query(ies) filter status='unpaid' — invoices canonical is payment_status='Pending'/'Paid'; returns nothing.` };
  return { red: false, detail: "invoices use payment_status (no status='unpaid' reads)" };
});

// G11 — No direct console.* leaking raw PII / message bodies.
gate('G11', 'HIGH', 'No direct console.* logs leaking PII (transcript/phone/email/OTP/message/name)', () => {
  if (!serverJs) return { red: true, detail: 'server.js unreadable' };
  const risky = [
    /\$\{transcript\}/, /\$\{otp\}/, /\$\{email\}/, /\$\{message\}/, /\$\{digits\}/,
    /\$\{customer_name\}/, /\$\{invoice\.customer_name\}/, /\$\{customer_phone\}/, /\$\{user\.phone\}/,
  ];
  const hits = [];
  for (const ln of serverJs.split('\n')) {
    if (!/console\.(log|error|warn|info)\s*\(/.test(ln)) continue;
    for (const re of risky) {
      if (re.test(ln)) { hits.push(ln.trim().slice(0, 64)); break; }
    }
  }
  if (hits.length) return { red: true, detail: `${hits.length} console.* PII leak(s); e.g. ${hits[0]}` };
  return { red: false, detail: 'no direct console.* PII/message leaks (mask helpers used)' };
});

// G12 — OTP/web-push send policy is explicit (auth-OTP flag default ON; push fail-closed).
gate('G12', 'HIGH', 'OTP via explicit flag (default ON) + web-push fail-closed', () => {
  const mod = read('lib/safety/externalSend.js');
  if (!mod) return { red: true, detail: 'lib/safety/externalSend.js missing' };
  const otpPolicy = /authOtpSendEnabled/.test(mod) && /FEATURE_AUTH_OTP_SENDING_ENABLED/.test(mod);
  const pushPolicy = /pushSendEnabled/.test(mod) && /FEATURE_PUSH_NOTIFICATIONS_ENABLED/.test(mod);
  const pushGated = !!serverJs && /guardPush\(\)/.test(serverJs);
  if (!otpPolicy) return { red: true, detail: 'auth-OTP policy (FEATURE_AUTH_OTP_SENDING_ENABLED) not defined in the guard module.' };
  if (!pushPolicy || !pushGated) return { red: true, detail: 'web-push not fail-closed (needs FEATURE_PUSH_NOTIFICATIONS_ENABLED + guardPush()).' };
  return { red: false, detail: 'OTP=explicit flag (default ON); web-push=fail-closed (default OFF) via guardPush' };
});

// ───────────────────────────────────────────────────────────────────────────
// MEDIUM gates (informational; never affect exit code)
// ───────────────────────────────────────────────────────────────────────────

// G08 — Postgres TLS peer-cert verification disabled.
gate('G08', 'MEDIUM', 'Postgres TLS verifies server certificate (rejectUnauthorized not false)', () => {
  if (pgConfig === null) return { red: false, detail: 'pgConfig.js not present (skipped)' };
  const disabled = /rejectUnauthorized\s*:\s*false/.test(pgConfig);
  return disabled
    ? { red: true, detail: 'DOCUMENTED MEDIUM (not changed in code): pgConfig.js keeps ssl.rejectUnauthorized:false (TLS on, peer cert NOT verified). The 2C.31V/W startup-packet gates assert this exact ssl shape and flipping it without the Supabase CA would break the DB runtime. OWNER ACTION: supply the Supabase CA + enable cert verification via staging/production env (do NOT mutate env from code).' }
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
