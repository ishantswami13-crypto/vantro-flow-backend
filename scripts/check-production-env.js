'use strict';
// scripts/check-production-env.js — validate a deployment's configuration
// WITHOUT printing any value.
//
//   railway run --environment production node scripts/check-production-env.js
//   node scripts/check-production-env.js --env=staging     (target explicitly)
//   node scripts/check-production-env.js --frontend        (also check NEXT_PUBLIC_* in this env)
//
// Reads process.env only. Output per variable: OK / MISSING / INVALID /
// UNSAFE / WARN with a reason — never the value (at most its length or
// whether it looks like a placeholder). Exit 1 when anything fails.

require('dotenv').config();
const { deploymentEnv } = require('../lib/config/deployEnv');

const argEnv = (process.argv.find((a) => a.startsWith('--env=')) || '').slice(6);
const target = argEnv || deploymentEnv();
const strict = target === 'production';
const env = process.env;
const results = [];
const add = (level, name, reason) => results.push({ level, name, reason });

// The placeholder shapes used in .env.example ("your-project", "replace-with-…",
// "[PASSWORD]", "rzp_live_...") — not generic words, so real secrets and real
// domains (e.g. one containing "example") are not misreported.
const PLACEHOLDER = /your-(project|service-role|anon)|replace-with|\[(PASSWORD|PROJECT)\]|^changeme$|\.\.\.$/i;
const has = (k) => typeof env[k] === 'string' && env[k].trim() !== '';
const isHttps = (v) => { try { return new URL(v).protocol === 'https:'; } catch { return false; } };
const isUrl = (v) => { try { return !!new URL(v); } catch { return false; } };

function required(name, { check, why, severity = 'MISSING' } = {}) {
  if (!has(name)) return add(severity === 'WARN' ? 'WARN' : 'FAIL', name, `not set${why ? ` — ${why}` : ''}`);
  if (PLACEHOLDER.test(env[name])) return add('FAIL', name, 'looks like a placeholder value');
  if (check) {
    const problem = check(env[name]);
    if (problem) return add('FAIL', name, problem);
  }
  add('OK', name, '');
}
function unsafeIfTrue(name, why) {
  if (env[name] === 'true') add(strict ? 'FAIL' : 'WARN', name, `is true — ${why}`);
  else add('OK', name, 'off');
}

// ── Core runtime ────────────────────────────────────────────────────────
add(has('STARLANE_ENV') ? 'OK' : 'WARN', 'STARLANE_ENV', has('STARLANE_ENV') ? `target=${target}` : `not set; inferred "${target}". Set it explicitly on every deployment.`);
required('JWT_SECRET', { check: (v) => (v.length < 32 ? `too short (${v.length} chars; need ≥32)` : null) });
required('DATABASE_URL', { check: (v) => (/^postgres(ql)?:\/\//.test(v) ? null : 'not a postgres:// URL') });
if (env.PGSSLMODE === 'disable') add(strict ? 'FAIL' : 'WARN', 'PGSSLMODE', 'is "disable" — only valid for a loopback test database');
required('SUPABASE_URL', { check: (v) => (isHttps(v) ? null : 'must be an https URL') });
if (!has('SUPABASE_SERVICE_ROLE_KEY') && !has('SUPABASE_KEY')) add('FAIL', 'SUPABASE_SERVICE_ROLE_KEY', 'not set (nor SUPABASE_KEY)');
else if (PLACEHOLDER.test(env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_KEY)) add('FAIL', 'SUPABASE_SERVICE_ROLE_KEY', 'looks like a placeholder value');
else add('OK', 'SUPABASE_SERVICE_ROLE_KEY', '');

// ── Public URLs (links in emails, bridge pairing command, CORS) ──────────
required('PUBLIC_APP_URL', { check: (v) => (strict && !isHttps(v) ? 'must be https in production' : isUrl(v) ? null : 'not a URL') });
required('PUBLIC_API_URL', { check: (v) => (strict && !isHttps(v) ? 'must be https in production' : isUrl(v) ? null : 'not a URL') });
if (has('PUBLIC_APP_URL')) {
  const { isAllowedOrigin } = require('../lib/security/originPolicy');
  let origin = null; try { origin = new URL(env.PUBLIC_APP_URL).origin; } catch { /* reported above */ }
  if (origin && !isAllowedOrigin(origin)) add('FAIL', 'ALLOWED_ORIGINS', 'PUBLIC_APP_URL origin is not allowed by CORS — add it to ALLOWED_ORIGINS');
  else if (origin) add('OK', 'ALLOWED_ORIGINS', 'PUBLIC_APP_URL origin allowed');
}

// ── Access rollout ───────────────────────────────────────────────────────
required('ADMIN_EMAILS', { check: (v) => (v.split(',').map((x) => x.trim()).filter(Boolean).every((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) ? null : 'contains an entry that is not an email address') });
required('RESEND_API_KEY', { why: 'applicants will not be emailed; admins must send links by hand', severity: strict ? 'MISSING' : 'WARN' });
required('ACCESS_EMAIL_FROM', { check: (v) => (/<[^>]+@[^>]+>|^[^\s@]+@[^\s@]+$/.test(v) ? null : 'expected "Name <addr@domain>" or an address'), why: 'falls back to Resend\'s shared test sender, which only delivers to the account owner', severity: strict ? 'MISSING' : 'WARN' });
if (!has('ACCESS_IP_SALT')) add('WARN', 'ACCESS_IP_SALT', 'not set; IP hashes are salted with JWT_SECRET (rotating JWT_SECRET breaks abuse correlation)');
else add('OK', 'ACCESS_IP_SALT', '');
add(env.ACCESS_AUTO_APPROVE === 'true' ? 'WARN' : 'OK', 'ACCESS_AUTO_APPROVE', env.ACCESS_AUTO_APPROVE === 'true' ? 'on: "ready" applications are approved without a person' : 'off (admin review)');
add('OK', 'FEATURE_ACCESS_GATE_ENABLED', env.FEATURE_ACCESS_GATE_ENABLED === 'true' ? 'on: signup requires an approved application' : 'off: signup is open');

// ── Signing secrets ──────────────────────────────────────────────────────
for (const k of ['ACTION_APPROVAL_SECRET', 'PUBLIC_LINK_SECRET']) {
  if (!has(k)) add('WARN', k, 'not set; falls back to JWT_SECRET (rotating JWT_SECRET then invalidates every link)');
  else if (env[k] === env.JWT_SECRET) add('WARN', k, 'equals JWT_SECRET; use a distinct secret');
  else add('OK', k, '');
}
if (has('DEVICE_TOKEN_SECRET') && env.DEVICE_TOKEN_SECRET === env.JWT_SECRET) add('WARN', 'DEVICE_TOKEN_SECRET', 'equals JWT_SECRET; use a distinct secret');

// ── Things that must be off in production ────────────────────────────────
unsafeIfTrue('OTP_VERIFICATION_DISABLED', 'OTP bypass (ignored on production, but must not be set)');
unsafeIfTrue('DEMO_RESET_ENABLED', 'internal demo reset');
unsafeIfTrue('TEST_MODE', 'test-only behaviour');
unsafeIfTrue('CORTEX_TEST_MODE', 'test-only endpoints');
if (env.ENABLE_AUTH_COOKIES === 'true' && (env.COOKIE_AUTH_SAMESITE || 'None') === 'None' && env.COOKIE_AUTH_SECURE === 'false') {
  add('FAIL', 'COOKIE_AUTH_SECURE', 'SameSite=None cookies require Secure; browsers will drop them');
}
if (env.FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED === 'true') {
  const twilio = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_WHATSAPP_NUMBER'].filter((k) => !has(k));
  add(twilio.length ? 'FAIL' : 'OK', 'FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED', twilio.length ? `on, but ${twilio.join(', ')} not set` : 'on, Twilio configured');
} else add('OK', 'FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED', 'off (no WhatsApp sends)');
// Pilot emergency stop: approvals are recorded but nothing is carried out.
add('OK', 'ACTION_EXECUTION_PAUSED', env.ACTION_EXECUTION_PAUSED === 'true'
  ? 'on: approvals are recorded, nothing is executed (no message, call, PO or payout)'
  : 'off (approved actions are carried out; set true to stop them without a deploy)');
// Real payouts happen only when the payout gateway is configured.
add(has('RAZORPAYX_KEY_ID') && has('RAZORPAYX_KEY_SECRET') ? 'WARN' : 'OK', 'RAZORPAYX_*',
  has('RAZORPAYX_KEY_ID') && has('RAZORPAYX_KEY_SECRET') ? 'set: approving a supplier payment can move money' : 'not set (supplier payments stay manual)');

// ── App builds (must be real https builds if set) ─────────────────────────
for (const k of ['DESKTOP_DOWNLOAD_URL_WINDOWS', 'DESKTOP_DOWNLOAD_URL_MACOS', 'DESKTOP_DOWNLOAD_URL_LINUX', 'MOBILE_DOWNLOAD_URL_ANDROID', 'MOBILE_DOWNLOAD_URL_IOS']) {
  if (has(k) && !isHttps(env[k])) add('FAIL', k, 'must be an https URL');
}

// ── Frontend (when run with the frontend's env, e.g. `vercel env pull`) ──
if (process.argv.includes('--frontend')) {
  required('NEXT_PUBLIC_API_URL', { check: (v) => (strict && !isHttps(v) ? 'must be https in production' : null) });
  if (has('NEXT_PUBLIC_API_URL') && has('PUBLIC_API_URL') && new URL(env.NEXT_PUBLIC_API_URL).origin !== new URL(env.PUBLIC_API_URL).origin) {
    add('FAIL', 'NEXT_PUBLIC_API_URL', 'origin differs from the backend PUBLIC_API_URL');
  }
  unsafeIfTrue('NEXT_PUBLIC_DEMO_CONTROLS', 'internal demo reset control');
  const leaked = Object.keys(env).filter((k) => k.startsWith('NEXT_PUBLIC_') && /SECRET|SERVICE_ROLE|PRIVATE|TOKEN|PASSWORD/.test(k));
  add(leaked.length ? 'FAIL' : 'OK', 'NEXT_PUBLIC_*', leaked.length ? `secret-looking public variables: ${leaked.join(', ')}` : 'no secret-looking public variables');
}

const order = { FAIL: 0, WARN: 1, OK: 2 };
results.sort((a, b) => order[a.level] - order[b.level] || a.name.localeCompare(b.name));
console.log(`Starlane environment check — target: ${target}${strict ? ' (strict)' : ''}\n`);
for (const r of results) console.log(`  ${r.level.padEnd(4)} ${r.name.padEnd(42)} ${r.reason}`);
const fails = results.filter((r) => r.level === 'FAIL').length;
const warns = results.filter((r) => r.level === 'WARN').length;
console.log(`\n${fails ? 'FAIL' : 'PASS'} — ${fails} failure(s), ${warns} warning(s)`);
process.exitCode = fails ? 1 : 0;
