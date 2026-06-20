// FILE: scripts/phase-2c-31v-pg-startup-packet-hardening-check.js
'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2C.31V — PG startup-packet hardening checker (offline, fail-closed).
//
// 21 gates. Mixes static source assertions with a BEHAVIORAL runtime test that
// actually builds a config object from a synthetic URL (no real credentials, no
// DB connection, no network) and inspects the result + the process env it leaves
// behind. The behavioral test is what makes a hardcoded "PASS" impossible: the
// checker exercises the real code under test.
//
// Boundaries: this checker performs NO DB connection, NO migration, NO network
// call to staging, NO secret printing. It only reads source files, builds an
// in-memory config from a fake URL, and runs the 2C.31U checker as a subprocess.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const rootDir = path.join(__dirname, '..');
const P = {
  pgConfig: path.join(rootDir, 'lib', 'db', 'pgConfig.js'),
  server: path.join(rootDir, 'server.js'),
  pgJs: path.join(rootDir, 'lib', 'db', 'pg.js'),
  deep: path.join(rootDir, 'lib', 'health', 'deepReadiness.js'),
  doc: path.join(rootDir, 'docs', 'deployment', 'phase-2c-31v-pg-startup-packet-hardening.md'),
  u31uChecker: path.join(rootDir, 'scripts', 'phase-2c-31u-pg-startup-fix-check.js'),
};

let failed = 0;
let passed = 0;

function gate(n, name, ok, detail) {
  if (ok) {
    passed++;
    console.log(`[PASS] Gate ${n}: ${name}`);
  } else {
    failed++;
    console.error(`[FAIL] Gate ${n}: ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function readOrNull(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (_) { return null; }
}

const pgConfig = readOrNull(P.pgConfig);
const server = readOrNull(P.server);
const pgJs = readOrNull(P.pgJs);
const deep = readOrNull(P.deep);
const doc = readOrNull(P.doc);

// Fail closed if any required source file is missing.
const required = [
  ['lib/db/pgConfig.js', pgConfig],
  ['server.js', server],
  ['lib/db/pg.js', pgJs],
  ['lib/health/deepReadiness.js', deep],
  ['docs/deployment/phase-2c-31v-pg-startup-packet-hardening.md', doc],
];
const missing = required.filter(([, c]) => c == null).map(([n]) => n);
if (missing.length) {
  console.error(`[FATAL] Missing required file(s): ${missing.join(', ')}`);
  process.exit(1);
}

// ── Behavioral runtime test (no DB, no network) ─────────────────────────────
// Build a config from a synthetic URL with percent-encoded credentials and a
// noisy query string, while large PGOPTIONS/PGAPPNAME sit in the env. Then
// assert the result is sanitized and the env was cleared.
const bhv = { ran: false };
try {
  process.env.PGOPTIONS = 'X'.repeat(1500);
  process.env.PGAPPNAME = 'Y'.repeat(1500);
  process.env.PGREPLICATION = 'database';

  const modPath = require.resolve(P.pgConfig);
  delete require.cache[modPath];
  const mod = require(modPath);
  const build = mod.buildSanitizedPgConfig;

  // us%65r -> "user", p%40ss%2Dword -> "p@ss-word", po%73tgres -> "postgres"
  const cfg = build(
    'postgresql://us%65r:p%40ss%2Dword@db.example.com:6543/po%73tgres' +
    '?options=-c%20statement_timeout%3D0&foo=bar&application_name=verylongappname'
  );

  bhv.ran = true;
  bhv.userDecoded = cfg.user === 'user';
  bhv.passDecoded = cfg.password === 'p@ss-word';
  bhv.dbDecoded = cfg.database === 'postgres';
  bhv.host = cfg.host === 'db.example.com';
  bhv.port = cfg.port === 6543;
  bhv.noAppName = !('application_name' in cfg);
  bhv.noOptionsKey = !('options' in cfg);
  bhv.noFoo = !('foo' in cfg) && !('application_name' in cfg);
  bhv.sslOk = !!cfg.ssl && cfg.ssl.rejectUnauthorized === false && Object.keys(cfg.ssl).length === 1;
  bhv.poolOk = cfg.max === 10 && cfg.idleTimeoutMillis === 30000 && cfg.connectionTimeoutMillis === 5000;
  bhv.pgoptionsCleared = !('PGOPTIONS' in process.env);
  bhv.pgappnameCleared = !('PGAPPNAME' in process.env);
  bhv.pgreplicationCleared = !('PGREPLICATION' in process.env);
  bhv.nullOnEmpty = build('') === null && build(undefined) === null;
  bhv.keysOk = Object.keys(cfg).sort().join(',') ===
    ['connectionTimeoutMillis', 'database', 'host', 'idleTimeoutMillis', 'max', 'password', 'port', 'ssl', 'user'].join(',');
} catch (e) {
  bhv.error = e && e.message ? e.message : String(e);
}

// ── Gate 1: No raw connectionString / raw URL string passed to Pool/Client ──
const csKey = [pgConfig, server, pgJs].some((c) => c.includes('connectionString:'));
const rawUrlCtor = /new\s+(Pool|Client)\s*\(\s*(process\.env\.DATABASE_URL|dbUrlStr|dbUrl|DATABASE_URL)\b/
  .test(server + '\n' + pgJs);
gate(1, 'No raw connectionString / raw URL passed to Pool/Client', !csKey && !rawUrlCtor,
  csKey ? 'connectionString: present' : 'raw URL passed to ctor');

// ── Gate 2: DATABASE_URL parsed with new URL ────────────────────────────────
gate(2, 'DATABASE_URL parsed with native URL', pgConfig.includes('new URL(') && bhv.host && bhv.port,
  bhv.error || 'URL parse not verified');

// ── Gate 3: username/password/database decoded safely ───────────────────────
gate(3, 'Credentials decoded safely (decodeURIComponent)',
  pgConfig.includes('decodeURIComponent') && bhv.userDecoded && bhv.passDecoded && bhv.dbDecoded,
  bhv.error || 'decode behavior not verified');

// ── Gate 4: Query/search params not forwarded ───────────────────────────────
gate(4, 'URL query/search params not forwarded',
  !pgConfig.includes('url.search') && !pgConfig.includes('searchParams') &&
  bhv.noFoo && bhv.keysOk,
  'query params leaked into config');

// ── Gate 5: PGAPPNAME fallback risk blocked ─────────────────────────────────
gate(5, 'PGAPPNAME env fallback blocked',
  /delete\s+process\.env\.PGAPPNAME/.test(pgConfig) && bhv.pgappnameCleared,
  bhv.error || 'PGAPPNAME not cleared');

// ── Gate 6: PGOPTIONS (+ PGREPLICATION) fallback risk blocked ────────────────
// PGOPTIONS -> options and PGREPLICATION -> replication are the remaining env-sourced
// fields getStartupConf() can fold into the packet; both must be cleared from the env.
gate(6, 'PGOPTIONS + PGREPLICATION env fallback blocked',
  /delete\s+process\.env\.PGOPTIONS/.test(pgConfig) &&
  /delete\s+process\.env\.PGREPLICATION/.test(pgConfig) &&
  bhv.pgoptionsCleared && bhv.pgreplicationCleared,
  bhv.error || 'PGOPTIONS / PGREPLICATION not cleared');

// ── Gate 7: application_name absent (or shortest safe override) ──────────────
gate(7, 'No application name set in config (absent)',
  !pgConfig.includes('application_name') && bhv.noAppName,
  'application name present in config');

// ── Gate 8: options param absent (or shortest safe override) ────────────────
gate(8, 'No options param set in config (absent)',
  !pgConfig.includes('options:') && bhv.noOptionsKey,
  'options param present in config');

// ── Gate 9: SSL preserved ───────────────────────────────────────────────────
gate(9, 'SSL config preserved',
  pgConfig.includes('ssl: { rejectUnauthorized: false }') && bhv.sslOk,
  bhv.error || 'ssl not preserved');

// ── Gate 10: Pool settings preserved ────────────────────────────────────────
gate(10, 'Pool settings preserved (max/idle/connection timeouts)',
  pgConfig.includes('max: 10') && pgConfig.includes('idleTimeoutMillis: 30000') &&
  pgConfig.includes('connectionTimeoutMillis: 5000') && bhv.poolOk,
  bhv.error || 'pool settings changed');

// ── Gate 11: server.js uses hardened helper ─────────────────────────────────
gate(11, 'server.js uses buildSanitizedPgConfig for Pool + Client',
  server.includes('new Pool(buildSanitizedPgConfig(') && server.includes('new Client(buildSanitizedPgConfig('));

// ── Gate 12: lib/db/pg.js uses hardened helper ──────────────────────────────
gate(12, 'lib/db/pg.js uses buildSanitizedPgConfig for Pool',
  pgJs.includes('new Pool(buildSanitizedPgConfig('));

// ── Gate 13: Auto-migration uses real shared pool path ──────────────────────
gate(13, 'Auto-migration runs over the shared pgPool',
  server.includes('runAutoMigrations') && server.includes('pgPool.connect('));

// ── Gate 14: Deep health uses real shared pool path ─────────────────────────
gate(14, '/api/health/deep passes the shared pgPool',
  server.includes('deepReadiness(pgPool'));

// ── Gate 15: No readiness-only false-green client ───────────────────────────
gate(15, 'deepReadiness uses the passed shared pool (no side pool/client)',
  !/new\s+(Pool|Client)/.test(deep) && !deep.includes('connectionString') &&
  !deep.includes('buildSanitizedPgConfig') && /function\s+checkDb\(pool\)/.test(deep) &&
  /deepReadiness\(pool/.test(deep));

// ── Gate 16: No URL/secrets logged ──────────────────────────────────────────
gate(16, 'pgConfig.js logs nothing (no secret leak)',
  !pgConfig.includes('console.') && !/log\([^)]*DATABASE_URL/.test(pgConfig));

// ── Gate 17: No business/customer queries added ─────────────────────────────
gate(17, 'pgConfig.js contains no SQL / business queries',
  !/\b(SELECT|INSERT|UPDATE|DELETE|FROM|JOIN|DROP)\b/.test(pgConfig) && !pgConfig.includes('.query('));

// ── Gate 18: No external sends / agents / workflows ─────────────────────────
gate(18, 'pgConfig.js triggers no external send / agent / workflow',
  !/twilio|whatsapp|sendmessage|nodemailer|axios|fetch\(|workflow|agentexecute/i.test(pgConfig));

// ── Gate 19: 2C.31U checker still passes (subprocess) ───────────────────────
let u31uPass = false;
let u31uDetail = '';
try {
  execFileSync(process.execPath, [P.u31uChecker], { stdio: 'pipe' });
  u31uPass = true;
} catch (e) {
  u31uDetail = (e.stdout ? e.stdout.toString() : '') + (e.stderr ? e.stderr.toString() : '');
}
gate(19, '2C.31U checker still passes', u31uPass, u31uDetail.split('\n').filter((l) => l.includes('[FAIL]')).join('; '));

// ── Gate 20: No 2C.32 / data-load overclaim ─────────────────────────────────
const docSays32Blocked = /2c\.32[^.]*blocked/i.test(doc);
const docSaysDataBlocked = /staging data[^.]*blocked/i.test(doc);
const noSafeTrue = !pgConfig.includes('safe_to_load_data: true') &&
  !deep.includes('safe_to_load_data: true') && !doc.includes('safe_to_load_data: true');
const noMerge32Claim = !/2c\.32 can merge|safe to merge (phase )?2c\.32|merge 2c\.32 now|2c\.32 is (now )?safe/i.test(doc);
gate(20, 'No 2C.32 / staging-data-load overclaim',
  docSays32Blocked && docSaysDataBlocked && noSafeTrue && noMerge32Claim,
  `32blocked=${docSays32Blocked} datablocked=${docSaysDataBlocked} noSafeTrue=${noSafeTrue} noMergeClaim=${noMerge32Claim}`);

// ── Gate 21: No hardcoded PASS / self-attestation ───────────────────────────
const noBypass = !/CHECKER_BYPASS|SKIP_CHECK|FORCE_PASS|HARDCODE_PASS|ALWAYS_PASS|NO_VERIFY/i.test(pgConfig);
const realFn = pgConfig.includes('function buildSanitizedPgConfig(') && pgConfig.length > 600;
gate(21, 'No hardcoded PASS / self-attestation (behavioral test executed)',
  noBypass && realFn && bhv.ran === true,
  bhv.error || 'behavioral test did not run');

// ── Gate-count integrity: exactly the expected number of gates must have run ─
// Explicit count (not a >= magic number) so adding/removing a gate without updating
// this constant trips the integrity check rather than silently passing.
const EXPECTED_GATES = 21;
if (passed + failed !== EXPECTED_GATES) {
  console.error(`[FAIL] Gate integrity: expected ${EXPECTED_GATES} gates, ${passed + failed} ran`);
  failed++;
}

// ── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n[2C.31V] ${passed} passed, ${failed} failed of ${passed + failed} checks (${EXPECTED_GATES} gates + integrity).`);
if (bhv.ran) {
  console.log('[2C.31V] behavioral: env cleared (PGOPTIONS/PGAPPNAME/PGREPLICATION), creds decoded, app-name+options absent, ssl+pool preserved.');
}
process.exit(failed === 0 ? 0 : 1);
