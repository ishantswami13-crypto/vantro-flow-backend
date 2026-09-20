'use strict';
// scripts/verify-connection.js
// Verifies the frontend → backend → Supabase chain end to end.
//
// Run this after pointing the backend at a fresh Supabase project (see
// scripts/setup-fresh-database.js) to confirm login actually works before
// debugging it through the browser.
//
// Usage:
//   node scripts/verify-connection.js
//   node scripts/verify-connection.js --email owner@example.com --password <password>
//   node scripts/verify-connection.js --api https://your-backend.up.railway.app --origin https://your-frontend.vercel.app
//
// Checks, in order:
//   1. Required env vars are present and not placeholders
//   2. Supabase REST is reachable with the service-role key
//   3. The `users` table exists and is queryable
//   4. The backend /api/ready endpoint reports healthy
//   5. CORS preflight from the frontend origin is accepted
//   6. A real login round-trip returns a usable token (only with --email/--password)
//
// Exit code is 0 only if every executed check passed.

// Optional: this script is a diagnostic tool and must stay runnable before
// `npm install` has been run, so a missing dotenv is not fatal — env vars can
// also come from the shell or the hosting platform.
try {
  require('dotenv').config();
} catch {
  console.log('ℹ️  dotenv not installed — reading environment from the shell only.');
}

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const API = (arg('api', process.env.VERIFY_API_URL || 'http://localhost:' + (process.env.PORT || 3001))).replace(/\/$/, '');
const ORIGIN = arg('origin', process.env.VERIFY_ORIGIN || 'http://localhost:3000');
const EMAIL = arg('email');
const PASSWORD = arg('password');

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}
function skip(name, why) {
  console.log(`⏭️  ${name} — skipped (${why})`);
}

const isPlaceholder = (v) => !v || /your-|replace-|\[PASSWORD\]|\[PROJECT\]|xxxx/i.test(v);

async function main() {
  console.log(`\n🔍 Verifying connection\n   backend: ${API}\n   origin:  ${ORIGIN}\n`);

  // ── 1. Environment ────────────────────────────────────────────────────────
  // DATABASE_URL belongs here even though the app serves requests without it.
  // Eight tables — purchases, sales, suppliers, khata_entries, purchase_orders,
  // notifications, inventory, prospect_notes — are created only by DDL inside
  // server.js, and that DDL runs through a pg Pool that is never constructed
  // when DATABASE_URL is unset. Between them they back 60 query sites. Leaving
  // it out of this list meant a deployment with only the SUPABASE_* variables
  // reported a clean verification while a third of the product's tables did not
  // exist. npm run security:schema-drift lists the affected tables.
  const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'JWT_SECRET', 'DATABASE_URL'];
  const missing = required.filter(k => isPlaceholder(process.env[k]));
  record(
    'Environment variables set',
    missing.length === 0,
    missing.length ? `missing or placeholder: ${missing.join(', ')}` : required.join(', ')
  );
  if (missing.includes('DATABASE_URL')) {
    console.log('   ⚠️  Without DATABASE_URL the boot migration is skipped and purchases, sales,');
    console.log('       suppliers, khata_entries, purchase_orders, notifications, inventory and');
    console.log('       prospect_notes are never created — those endpoints will return 500.');
  }

  if (process.env.JWT_SECRET && process.env.JWT_SECRET.length < 32) {
    console.log('   ⚠️  JWT_SECRET is shorter than 32 chars — generate one with: openssl rand -hex 32');
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  // ── 2 & 3. Supabase reachability + users table ────────────────────────────
  if (isPlaceholder(supabaseUrl) || isPlaceholder(serviceKey)) {
    skip('Supabase reachable', 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured');
    skip('users table queryable', 'Supabase not configured');
    skip('boot-migration tables present', 'Supabase not configured');
  } else {
    try {
      const res = await fetch(`${supabaseUrl.replace(/\/$/, '')}/rest/v1/users?select=id&limit=1`, {
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
      });
      record('Supabase reachable', res.status !== 401 && res.status !== 403,
        res.status === 401 || res.status === 403 ? `auth rejected (HTTP ${res.status}) — check SUPABASE_SERVICE_ROLE_KEY` : `HTTP ${res.status}`);

      if (res.ok) {
        record('users table queryable', true, 'schema present');
      } else {
        const body = await res.text().catch(() => '');
        const missingTable = res.status === 404 || /does not exist|could not find/i.test(body);
        record('users table queryable', false,
          missingTable ? 'table missing — run: node scripts/setup-fresh-database.js' : `HTTP ${res.status} ${body.slice(0, 120)}`);
      }
      // purchases is now created two ways: migrations/006_boot_migration_promoted.sql
      // (part of setup:database, no DATABASE_URL needed to create the table) and
      // runAutoMigrations() in server.js at boot (needs DATABASE_URL, and keeps
      // patching a long-running deployment that hasn't re-run setup:database).
      // Either path failing to have run is still worth surfacing, so this stays —
      // `purchases` is the heaviest of the tables either path owns, at 21 query
      // sites, so it is the most useful canary.
      try {
        const bootRes = await fetch(`${supabaseUrl.replace(/\/$/, '')}/rest/v1/purchases?select=id&limit=1`, {
          headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
        });
        if (bootRes.ok) {
          record('boot-migration tables present', true, 'purchases queryable');
        } else {
          const body = await bootRes.text().catch(() => '');
          record('boot-migration tables present', false,
            'purchases missing — run: node scripts/setup-fresh-database.js ' +
            `(HTTP ${bootRes.status} ${body.slice(0, 80)})`);
        }
      } catch (e) {
        skip('boot-migration tables present', e.message);
      }
    } catch (e) {
      record('Supabase reachable', false, e.message);
      skip('users table queryable', 'Supabase unreachable');
      skip('boot-migration tables present', 'Supabase unreachable');
    }
  }

  // ── 4. Backend health ─────────────────────────────────────────────────────
  let backendUp = false;
  try {
    const res = await fetch(`${API}/api/ready`);
    const body = await res.json().catch(() => ({}));
    backendUp = res.ok;
    const bad = Object.entries(body.checks || {}).filter(([, v]) => v === 'missing').map(([k]) => k);
    record('Backend /api/ready', res.ok && bad.length === 0,
      !res.ok ? `HTTP ${res.status}` : bad.length ? `missing config: ${bad.join(', ')}` : 'all checks ok');
  } catch (e) {
    record('Backend /api/ready', false, `${e.message} — is the backend running at ${API}?`);
  }

  // ── 5. CORS preflight ─────────────────────────────────────────────────────
  if (!backendUp) {
    skip('CORS allows frontend origin', 'backend unreachable');
  } else {
    try {
      const res = await fetch(`${API}/api/auth/login`, {
        method: 'OPTIONS',
        headers: {
          Origin: ORIGIN,
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'content-type,authorization',
        },
      });
      const allowOrigin = res.headers.get('access-control-allow-origin');
      const allowCreds = res.headers.get('access-control-allow-credentials');
      const ok = Boolean(allowOrigin) && allowCreds === 'true';
      record('CORS allows frontend origin', ok,
        ok ? `allow-origin: ${allowOrigin}` : `origin ${ORIGIN} rejected — add it to ALLOWED_ORIGINS`);
    } catch (e) {
      record('CORS allows frontend origin', false, e.message);
    }
  }

  // ── 6. Login round-trip ───────────────────────────────────────────────────
  if (!EMAIL || !PASSWORD) {
    skip('Login round-trip', 'pass --email and --password to test');
  } else if (!backendUp) {
    skip('Login round-trip', 'backend unreachable');
  } else {
    try {
      const res = await fetch(`${API}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
        body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        record('Login round-trip', false, `HTTP ${res.status} — ${body.error || 'unknown error'}`);
      } else if (!body.token) {
        record('Login round-trip', false, 'no token in response');
      } else {
        record('Login round-trip', true, `token issued${body.csrf_token ? ' + cookie mode active' : ' (bearer mode)'}`);

        // Confirm the issued token is actually accepted by a protected route
        const me = await fetch(`${API}/api/auth/me`, {
          headers: { Authorization: `Bearer ${body.token}`, Origin: ORIGIN },
        });
        const meBody = await me.json().catch(() => ({}));
        record('Token accepted by /api/auth/me', me.ok,
          me.ok ? `authenticated as ${meBody.user?.email || 'unknown'}` : `HTTP ${me.status} — ${meBody.error || ''}`);
      }
    } catch (e) {
      record('Login round-trip', false, e.message);
    }
  }

  // ── 7. Feature flags ──────────────────────────────────────────────────────
  // Not a pass/fail check — every AI feature defaults off, so "nothing is
  // happening" is usually this rather than a broken install.
  let flags = null;
  try {
    ({ FLAGS: flags } = require('../lib/featureFlags'));
  } catch {
    // featureFlags is only importable from a checkout; skip quietly otherwise.
  }

  if (flags) {
    const on = Object.entries(flags).filter(([, v]) => v === true).map(([k]) => k);
    const off = Object.entries(flags).filter(([, v]) => v !== true).map(([k]) => k);
    console.log(`\n🧠 Cortex / AI features — ${on.length} on, ${off.length} off`);

    if (!flags.cortex_enabled) {
      console.log('   ⚠️  FEATURE_CORTEX_ENABLED is off — the master switch. No agents run,');
      console.log('      no AI actions are created, and the app behaves as plain CRUD.');
    }
    if (flags.cortex_enabled && !flags.agent_planner_enabled) {
      console.log('   ℹ️  Planner off — plans come from rules rather than the LLM.');
    }
    if (flags.agent_planner_enabled && isPlaceholder(process.env.ANTHROPIC_API_KEY)) {
      console.log('   ⚠️  Planner is on but ANTHROPIC_API_KEY is unset — it will fall back to rules.');
    }
    if (flags.external_message_sending_enabled) {
      console.log('   🚨 External message sending is ON — agents can contact real customers.');
    }
    if (on.length) console.log(`   on:  ${on.join(', ')}`);
    if (off.length) console.log(`   off: ${off.join(', ')}`);
  } else {
    skip('Feature flags', 'run from the backend checkout to inspect them');
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const failed = results.filter(r => !r.ok);
  console.log(`\n${failed.length === 0 ? '🎉' : '⚠️ '} ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log(`   Failed: ${failed.map(f => f.name).join(', ')}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });
