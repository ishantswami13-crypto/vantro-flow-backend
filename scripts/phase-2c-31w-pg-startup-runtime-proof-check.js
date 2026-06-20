// FILE: scripts/phase-2c-31w-pg-startup-runtime-proof-check.js
'use strict';

// Phase 2C.31W-R — Runtime PG startup-packet proof checker (offline, fail-closed).
//
// Boundaries: NO DB connection, NO migration, NO network call, NO staging data,
// NO secret printing. This script reads source files, executes the estimator/build helper
// only on synthetic values, runs prior repository-side checkers, and runs an in-memory
// mutation matrix. It never writes to repo files.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const rootDir = path.join(__dirname, '..');
const P = {
  pgConfig: path.join(rootDir, 'lib', 'db', 'pgConfig.js'),
  est: path.join(rootDir, 'lib', 'db', 'pgStartupEstimate.js'),
  server: path.join(rootDir, 'server.js'),
  pgJs: path.join(rootDir, 'lib', 'db', 'pg.js'),
  deep: path.join(rootDir, 'lib', 'health', 'deepReadiness.js'),
  doc: path.join(rootDir, 'docs', 'deployment', 'phase-2c-31w-pg-startup-runtime-proof.md'),
  lock: path.join(rootDir, 'package-lock.json'),
  self: __filename,
  u31vChecker: path.join(rootDir, 'scripts', 'phase-2c-31v-pg-startup-packet-hardening-check.js'),
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

function byteLen(value) {
  return Buffer.byteLength(String(value), 'utf8');
}

function field(result, name) {
  return (result.fields || []).find((x) => x.name === name) || {};
}

function fieldKeysOnly(result) {
  return Array.isArray(result.fields) && result.fields.every((x) =>
    Object.keys(x).sort().join(',') === 'keyBytes,name,pairBytes,present,valueBytes' &&
    typeof x.name === 'string' &&
    typeof x.present === 'boolean' &&
    typeof x.keyBytes === 'number' &&
    typeof x.valueBytes === 'number' &&
    typeof x.pairBytes === 'number'
  );
}

function loadEstimatorFromSource(source) {
  const module = { exports: {} };
  const fn = new Function('module', 'exports', 'process', 'Buffer', `${source}\n;return module.exports;`);
  return fn(module, module.exports, process, Buffer);
}

function loadRealModule() {
  const modPath = require.resolve(P.pgConfig);
  delete require.cache[modPath];
  delete require.cache[require.resolve(P.est)];
  return require(modPath);
}

function withCleanPgEnv(fn) {
  const keys = ['PGOPTIONS', 'PGAPPNAME', 'PGREPLICATION', 'PGUSER', 'PGDATABASE'];
  const previous = {};
  for (const key of keys) {
    previous[key] = Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined;
    delete process.env[key];
  }
  try {
    return fn();
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

function evaluateEstimator(estimate) {
  const out = {};
  withCleanPgEnv(() => {
    const minimal = estimate({ user: 'postgres', database: 'postgres' });
    out.minimal = minimal;
    out.minimal62 = minimal.totalBytes === 62 && minimal.limit === 1024 && minimal.belowLimit === true;
    out.clientEncoding = field(minimal, 'client_encoding');
    out.clientEncodingIncluded = out.clientEncoding.present === true &&
      out.clientEncoding.keyBytes === 15 &&
      out.clientEncoding.valueBytes === 4 &&
      out.clientEncoding.pairBytes === 21;
    out.basicShape = field(minimal, 'user').present === true &&
      field(minimal, 'user').keyBytes === 4 &&
      field(minimal, 'user').valueBytes === 8 &&
      field(minimal, 'user').pairBytes === 14 &&
      field(minimal, 'database').present === true &&
      field(minimal, 'database').keyBytes === 8 &&
      field(minimal, 'database').valueBytes === 8 &&
      field(minimal, 'database').pairBytes === 18 &&
      field(minimal, 'application_name').present === false &&
      field(minimal, 'options').present === false &&
      field(minimal, 'replication').present === false;
    out.fieldKeysOnly = fieldKeysOnly(minimal);
    out.totalTypes = typeof minimal.totalBytes === 'number' &&
      typeof minimal.limit === 'number' &&
      typeof minimal.belowLimit === 'boolean';

    const multi = estimate({ user: '₹₹', database: 'db' });
    out.utf8Bytes = field(multi, 'user').valueBytes === byteLen('₹₹') && field(multi, 'user').valueBytes !== '₹₹'.length;

    const secret = estimate({ user: 'SUPERSECRETUSERVALUE', database: 'SECRETDB' });
    const secretJson = JSON.stringify(secret);
    out.noSecretValues = !secretJson.includes('SUPERSECRETUSERVALUE') && !secretJson.includes('SECRETDB');
    out.secretLengths = field(secret, 'user').valueBytes === 20 && field(secret, 'database').valueBytes === 8;

    const oversized = estimate({ user: 'x'.repeat(1100), database: 'd' });
    out.oversizedDetected = oversized.belowLimit === false && oversized.totalBytes > 1024;

    process.env.PGUSER = 'aa';
    const pgUserShort = estimate({});
    process.env.PGUSER = 'b'.repeat(123);
    const pgUserLong = estimate({});
    process.env.PGUSER = 'shouldNotBeUsedAsUser';
    const explicitUser = estimate({ user: 'explicit', database: 'db' });
    out.pgUserFallback = field(pgUserShort, 'user').present === true &&
      field(pgUserShort, 'user').valueBytes === 2 &&
      field(pgUserLong, 'user').present === true &&
      field(pgUserLong, 'user').valueBytes === 123 &&
      !JSON.stringify(pgUserLong).includes('b'.repeat(123)) &&
      field(explicitUser, 'user').valueBytes === 8;
    delete process.env.PGUSER;

    process.env.PGDATABASE = 'cc';
    const pgDbShort = estimate({ user: 'u' });
    process.env.PGDATABASE = 'd'.repeat(121);
    const pgDbLong = estimate({ user: 'u' });
    process.env.PGDATABASE = 'shouldNotBeUsedAsDatabase';
    const explicitDb = estimate({ user: 'u', database: 'explicitdb' });
    out.pgDatabaseFallback = field(pgDbShort, 'database').present === true &&
      field(pgDbShort, 'database').valueBytes === 2 &&
      field(pgDbLong, 'database').present === true &&
      field(pgDbLong, 'database').valueBytes === 121 &&
      !JSON.stringify(pgDbLong).includes('d'.repeat(121)) &&
      field(explicitDb, 'database').valueBytes === 10;
    delete process.env.PGDATABASE;

    const optional = estimate({
      user: 'u',
      database: 'd',
      application_name: 'app',
      fallback_application_name: 'fb',
      options: '-c x=1',
      replication: 'database',
      statement_timeout: 5000,
      lock_timeout: 3000,
      idle_in_transaction_session_timeout: 1000,
    });
    out.optional = optional;
    out.optionalPresent = ['user', 'database', 'application_name', 'replication', 'options',
      'statement_timeout', 'lock_timeout', 'idle_in_transaction_session_timeout', 'client_encoding']
      .every((name) => field(optional, name).present === true);
    out.optionalBytes = field(optional, 'application_name').valueBytes === 3 &&
      field(optional, 'options').valueBytes === 6 &&
      field(optional, 'replication').valueBytes === 8 &&
      field(optional, 'statement_timeout').valueBytes === 4 &&
      field(optional, 'lock_timeout').valueBytes === 4 &&
      field(optional, 'idle_in_transaction_session_timeout').valueBytes === 4 &&
      field(optional, 'client_encoding').pairBytes === 21;
    const sumPairs = optional.fields.filter((x) => x.present).reduce((sum, x) => sum + x.pairBytes, 0);
    out.optionalTotalConsistent = optional.totalBytes === 9 + sumPairs;
    out.noFalseFallbackField = !optional.fields.some((x) => x.name === 'fallback_application_name');
  });
  return out;
}

function evaluateBuild(build) {
  const out = {};
  withCleanPgEnv(() => {
    process.env.PGOPTIONS = 'o'.repeat(50);
    process.env.PGAPPNAME = 'a'.repeat(50);
    process.env.PGREPLICATION = 'database';
    const cfg = build('postgresql://us%65r:p%40ss@h.example.com:6543/po%73tgres?foo=bar');
    out.decode = cfg.user === 'user' && cfg.password === 'p@ss' && cfg.database === 'postgres';
    out.noSearch = !('foo' in cfg) && !('search' in cfg) && !('searchParams' in cfg) && !('query' in cfg);
    out.noOptionalStartupParams = !('application_name' in cfg) && !('fallback_application_name' in cfg) &&
      !('options' in cfg) && !('replication' in cfg);
    out.ssl = !!cfg.ssl && cfg.ssl.rejectUnauthorized === false && Object.keys(cfg.ssl).length === 1;
    out.pool = cfg.max === 10 && cfg.idleTimeoutMillis === 30000 && cfg.connectionTimeoutMillis === 5000;
    out.envCleared = !('PGOPTIONS' in process.env) && !('PGAPPNAME' in process.env) && !('PGREPLICATION' in process.env);
  });
  return out;
}

function readinessSafe(serverSource) {
  const start = serverSource.indexOf("app.get('/api/ready'");
  const end = start === -1 ? -1 : serverSource.indexOf('// ── Phase 2C.31T', start);
  const block = start === -1 ? '' : serverSource.slice(start, end === -1 ? undefined : end);
  const codeBlock = block.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  return {
    present: !!block,
    configured: /database_configured:\s*!!process\.env\.DATABASE_URL/.test(codeBlock),
    notChecked: /database_connectivity:\s*'not_checked'/.test(codeBlock),
    endpoint: /db_readiness_endpoint:\s*'\/api\/health\/deep'/.test(codeBlock),
    dataLoadFalse: /ready_for_data_load:\s*false/.test(codeBlock),
    noOldDbOk: !/database:\s*process\.env\.DATABASE_URL\s*\?\s*['"]ok['"]/.test(codeBlock) && !/database:\s*['"]ok['"]/.test(codeBlock),
    noSafeTrue: !/safe_to_load_data:\s*true/.test(codeBlock) && !/ready_for_data_load:\s*true/.test(codeBlock),
    noDbQuery: !/\.query\(|SELECT\s+1|checkDb|deepReadiness\(/i.test(codeBlock),
  };
}

function staticChecks(src) {
  const ready = readinessSafe(src.server || '');
  const runtimeDbSources = [src.pgConfig || '', src.server || '', src.pgJs || ''].join('\n');
  const newSources = [src.pgConfig || '', src.est || ''].join('\n');
  const doc = src.doc || '';
  return {
    clientEncodingSource: (src.est || '').includes('CLIENT_ENCODING_KEY') &&
      (src.est || '').includes("'client_encoding'") &&
      (src.est || '').includes("'UTF8'"),
    usesBufferByteLength: /Buffer\.byteLength\(String\(v\),\s*'utf8'\)/.test(src.est || ''),
    hasFramingAndNulls: (src.est || '').includes('LENGTH_PREFIX_BYTES = 4') &&
      (src.est || '').includes('PROTOCOL_VERSION_BYTES = 4') &&
      (src.est || '').includes('FINAL_NUL_BYTES = 1') &&
      (src.est || '').includes('keyBytes + 1 + valueBytes + 1') &&
      (src.est || '').includes('FRAMING_BYTES + paramBytes'),
    noConsoleSecrets: !(src.pgConfig || '').includes('console.') && !(src.est || '').includes('console.'),
    noRawConnectionString: !/connectionString\s*:/.test(runtimeDbSources),
    noRawDbUrlCtor: !/new\s+(Pool|Client)\s*\(\s*(process\.env\.DATABASE_URL|dbUrlStr|dbUrl|DATABASE_URL)\b/.test(runtimeDbSources),
    nativeUrl: (src.pgConfig || '').includes('new URL('),
    safeDecode: (src.pgConfig || '').includes('decodeURIComponent'),
    noSearchForward: !(src.pgConfig || '').includes('url.search') && !(src.pgConfig || '').includes('searchParams'),
    envClears: /delete\s+process\.env\.PGOPTIONS/.test(src.pgConfig || '') &&
      /delete\s+process\.env\.PGAPPNAME/.test(src.pgConfig || '') &&
      /delete\s+process\.env\.PGREPLICATION/.test(src.pgConfig || ''),
    ssl: (src.pgConfig || '').includes('ssl: { rejectUnauthorized: false }'),
    pool: (src.pgConfig || '').includes('max: 10') &&
      (src.pgConfig || '').includes('idleTimeoutMillis: 30000') &&
      (src.pgConfig || '').includes('connectionTimeoutMillis: 5000'),
    serverHelper: (src.server || '').includes('new Pool(buildSanitizedPgConfig(') &&
      (src.server || '').includes('new Client(buildSanitizedPgConfig(') &&
      !/new\s+(Pool|Client)\s*\(\s*(?!buildSanitizedPgConfig)/.test([src.server || '', src.pgJs || ''].join('\n')),
    pgJsHelper: (src.pgJs || '').includes('new Pool(buildSanitizedPgConfig('),
    autoMigrationShared: (src.server || '').includes('runAutoMigrations') && (src.server || '').includes('pgPool.connect('),
    deepShared: (src.server || '').includes('deepReadiness(pgPool'),
    noSideReadiness: !/new\s+(Pool|Client)/.test(src.deep || '') &&
      !(src.deep || '').includes('connectionString') &&
      !(src.deep || '').includes('buildSanitizedPgConfig') &&
      /function\s+checkDb\(pool\)/.test(src.deep || '') &&
      /deepReadiness\(pool/.test(src.deep || ''),
    readySafe: ready.present && ready.configured && ready.notChecked && ready.endpoint &&
      ready.dataLoadFalse && ready.noOldDbOk && ready.noSafeTrue && ready.noDbQuery,
    noUrlSecretPiiLogged: !(src.pgConfig || '').includes('console.') &&
      !(src.est || '').includes('console.') &&
      (src.server || '').includes("'[pg] startup packet estimate'") &&
      (src.server || '').includes('totalBytes: est.totalBytes') &&
      (src.server || '').includes('fields: est.fields') &&
      !(src.server || '').includes('password: est') &&
      !/safeLog\([^)]*process\.env\.DATABASE_URL/.test(src.server || ''),
    noBusinessQueries: !/\b(SELECT|INSERT|UPDATE|DELETE|FROM|JOIN|DROP)\b/.test(newSources) &&
      !newSources.includes('.query('),
    noExternalSends: !/twilio|whatsapp|sendmessage|nodemailer|axios|fetch\(|workflow|agentexecute/i.test(newSources),
    docBlocks32: /2c\.32[^.]*blocked/i.test(doc),
    docBlocksData: /staging data[^.]*blocked/i.test(doc),
    noSafeTrue: !/safe_to_load_data:\s*true|ready_for_data_load:\s*true/.test([src.pgConfig, src.est, src.deep, src.server].join('\n')),
    noMerge32Claim: !/2c\.32 can merge|safe to merge (phase )?2c\.32|merge 2c\.32 now|2c\.32 is (now )?safe/i.test(doc),
    noHardcodedBypass: !/CHECKER_BYPASS|SKIP_CHECK|FORCE_PASS|HARDCODE_PASS|ALWAYS_PASS|NO_VERIFY/.test(
      [src.pgConfig, src.est, src.server, src.doc].join('\n')
    ),
    lockPinned: (src.lock || '').includes('"node_modules/pg"') &&
      (src.lock || '').includes('"version": "8.21.0"') &&
      (src.lock || '').includes('"node_modules/pg-protocol"') &&
      (src.lock || '').includes('"version": "1.14.0"'),
    docHonestNoNodeModulesAssumption: /node_modules[^.]*absent/i.test(doc) &&
      /pg@8\.21\.0/.test(doc) &&
      /pg-protocol@1\.14\.0/.test(doc),
  };
}

function runMutationMatrix(src) {
  const mutations = [
    {
      id: 'remove_client_encoding',
      mutate: (s) => ({ ...s, est: s.est.replace(/\n\s*\{ name: CLIENT_ENCODING_KEY, present: true, value: CLIENT_ENCODING_VALUE \},/, '') }),
      rejected: (s) => !evaluateEstimator(loadEstimatorFromSource(s.est).estimateStartupPacket).clientEncodingIncluded,
    },
    {
      id: 'minimal_packet_not_62',
      mutate: (s) => ({ ...s, est: s.est.replace("const CLIENT_ENCODING_VALUE = 'UTF8';", "const CLIENT_ENCODING_VALUE = 'UTF8X';") }),
      rejected: (s) => !evaluateEstimator(loadEstimatorFromSource(s.est).estimateStartupPacket).minimal62,
    },
    {
      id: 'string_length_instead_of_byte_length',
      mutate: (s) => ({ ...s, est: s.est.replace("Buffer.byteLength(String(v), 'utf8')", 'String(v).length') }),
      rejected: (s) => !evaluateEstimator(loadEstimatorFromSource(s.est).estimateStartupPacket).utf8Bytes,
    },
    {
      id: 'omit_final_null_terminator',
      mutate: (s) => ({ ...s, est: s.est.replace('const FINAL_NUL_BYTES = 1;', 'const FINAL_NUL_BYTES = 0;') }),
      rejected: (s) => !evaluateEstimator(loadEstimatorFromSource(s.est).estimateStartupPacket).minimal62,
    },
    {
      id: 'estimator_returns_raw_values',
      mutate: (s) => ({
        ...s,
        est: s.est.replace(
          'return { name: f.name, present: f.present, keyBytes, valueBytes, pairBytes };',
          'return { name: f.name, present: f.present, keyBytes, valueBytes, pairBytes, value: f.value };'
        ),
      }),
      rejected: (s) => !evaluateEstimator(loadEstimatorFromSource(s.est).estimateStartupPacket).noSecretValues,
    },
    {
      id: 'estimator_logs_secrets',
      mutate: (s) => ({ ...s, est: s.est.replace('const totalBytes = FRAMING_BYTES + paramBytes;', 'console.log(user, database);\n  const totalBytes = FRAMING_BYTES + paramBytes;') }),
      rejected: (s) => !staticChecks(s).noConsoleSecrets,
    },
    {
      id: 'raw_connection_string',
      mutate: (s) => ({ ...s, server: s.server.replace('new Pool(buildSanitizedPgConfig(process.env.DATABASE_URL))', 'new Pool({ connectionString: process.env.DATABASE_URL })') }),
      rejected: (s) => !staticChecks(s).noRawConnectionString,
    },
    {
      id: 'raw_database_url_to_pool_client',
      mutate: (s) => ({ ...s, server: s.server.replace('new Pool(buildSanitizedPgConfig(process.env.DATABASE_URL))', 'new Pool(process.env.DATABASE_URL)') }),
      rejected: (s) => !staticChecks(s).noRawDbUrlCtor,
    },
    {
      id: 'forward_search_params',
      mutate: (s) => ({ ...s, pgConfig: s.pgConfig.replace('password: safeDecode(url.password),', 'password: safeDecode(url.password),\n      searchParams: url.searchParams,') }),
      rejected: (s) => !staticChecks(s).noSearchForward || !evaluateBuild(loadRealModule().buildSanitizedPgConfig).noSearch,
    },
    {
      id: 'allow_pgappname_pgoptions',
      mutate: (s) => ({
        ...s,
        pgConfig: s.pgConfig
          .replace("if ('PGOPTIONS' in process.env) delete process.env.PGOPTIONS;", "if ('PGOPTIONS' in process.env) process.env.PGOPTIONS = process.env.PGOPTIONS;")
          .replace("if ('PGAPPNAME' in process.env) delete process.env.PGAPPNAME;", "if ('PGAPPNAME' in process.env) process.env.PGAPPNAME = process.env.PGAPPNAME;"),
      }),
      rejected: (s) => !staticChecks(s).envClears,
    },
    {
      id: 'hide_pgdatabase_fallback',
      mutate: (s) => ({ ...s, est: s.est.replace("resolveVal(config, 'database', 'PGDATABASE', undefined)", "resolveVal(config, 'database', false, undefined)") }),
      rejected: (s) => !evaluateEstimator(loadEstimatorFromSource(s.est).estimateStartupPacket).pgDatabaseFallback,
    },
    {
      id: 'ready_false_db_ok',
      mutate: (s) => ({ ...s, server: s.server.replace("database_connectivity: 'not_checked',", "database: process.env.DATABASE_URL ? 'ok' : 'missing',") }),
      rejected: (s) => !staticChecks(s).readySafe,
    },
    {
      id: 'readiness_only_side_pool',
      mutate: (s) => ({ ...s, deep: `${s.deep}\nconst sidePool = new Pool({});\n` }),
      rejected: (s) => !staticChecks(s).noSideReadiness,
    },
    {
      id: 'safe_to_load_data_true',
      mutate: (s) => ({ ...s, deep: s.deep.replace('safe_to_load_data: false', 'safe_to_load_data: true') }),
      rejected: (s) => !staticChecks(s).noSafeTrue,
    },
    {
      id: 'phase_2c32_overclaim',
      mutate: (s) => ({ ...s, doc: `${s.doc}\n\nPhase 2C.32 can merge now.\n` }),
      rejected: (s) => !staticChecks(s).noMerge32Claim,
    },
    {
      id: 'hardcoded_pass',
      mutate: (s) => ({ ...s, est: `${s.est}\nconst CHECKER_BYPASS = true;\n` }),
      rejected: (s) => !staticChecks(s).noHardcodedBypass,
    },
  ];

  const results = [];
  for (const mutation of mutations) {
    try {
      const mutated = mutation.mutate(src);
      results.push({ id: mutation.id, rejected: mutation.rejected(mutated) === true });
    } catch (e) {
      results.push({ id: mutation.id, rejected: true, error: e && e.message ? e.message : String(e) });
    }
  }
  return results;
}

const src = {
  pgConfig: readOrNull(P.pgConfig),
  est: readOrNull(P.est),
  server: readOrNull(P.server),
  pgJs: readOrNull(P.pgJs),
  deep: readOrNull(P.deep),
  doc: readOrNull(P.doc),
  lock: readOrNull(P.lock),
  self: readOrNull(P.self),
};

const required = [
  ['lib/db/pgConfig.js', src.pgConfig],
  ['lib/db/pgStartupEstimate.js', src.est],
  ['server.js', src.server],
  ['lib/db/pg.js', src.pgJs],
  ['lib/health/deepReadiness.js', src.deep],
  ['docs/deployment/phase-2c-31w-pg-startup-runtime-proof.md', src.doc],
  ['package-lock.json', src.lock],
];
const missing = required.filter(([, content]) => content == null).map(([name]) => name);
if (missing.length) {
  console.error(`[FATAL] Missing required file(s): ${missing.join(', ')}`);
  process.exit(1);
}

let bhv = { ran: false };
let build = {};
try {
  const mod = loadRealModule();
  bhv = evaluateEstimator(mod.estimateStartupPacket);
  bhv.exported = typeof mod.estimateStartupPacket === 'function' && typeof mod.buildSanitizedPgConfig === 'function';
  build = evaluateBuild(mod.buildSanitizedPgConfig);
  bhv.ran = true;
} catch (e) {
  bhv.error = e && e.message ? e.message : String(e);
}

const stat = staticChecks(src);
const mutations = runMutationMatrix(src);
const rejectedCount = mutations.filter((m) => m.rejected).length;
const mutationFailures = mutations.filter((m) => !m.rejected).map((m) => m.id);

gate(1, 'client_encoding=UTF8 included',
  stat.clientEncodingSource && bhv.clientEncodingIncluded === true,
  bhv.error);

gate(2, 'postgres/postgres minimal packet equals 62 bytes',
  bhv.minimal62 === true,
  bhv.error || `total=${bhv.minimal && bhv.minimal.totalBytes}`);

gate(3, 'Estimator uses UTF-8 Buffer.byteLength',
  stat.usesBufferByteLength && bhv.utf8Bytes === true,
  bhv.error);

gate(4, 'Estimator includes framing and null terminators',
  stat.hasFramingAndNulls && bhv.minimal62 === true && bhv.basicShape === true,
  bhv.error);

gate(5, 'Estimator output contains no field values',
  bhv.fieldKeysOnly === true && bhv.noSecretValues === true && bhv.secretLengths === true,
  bhv.error || 'value leak detected');

gate(6, 'Optional fields total consistency tested',
  bhv.optionalPresent === true && bhv.optionalBytes === true && bhv.optionalTotalConsistent === true,
  bhv.error);

gate(7, 'Oversized fields return belowLimit false',
  bhv.oversizedDetected === true,
  bhv.error);

gate(8, 'PGUSER fallback behaviorally tested',
  bhv.pgUserFallback === true,
  bhv.error);

gate(9, 'PGDATABASE fallback behaviorally tested',
  bhv.pgDatabaseFallback === true,
  bhv.error);

gate(10, 'PGAPPNAME blocked/minimized',
  stat.envClears && build.envCleared === true && build.noOptionalStartupParams === true &&
  field(bhv.minimal || {}, 'application_name').present === false,
  bhv.error);

gate(11, 'PGOPTIONS blocked/minimized',
  stat.envClears && build.envCleared === true && build.noOptionalStartupParams === true &&
  field(bhv.minimal || {}, 'options').present === false,
  bhv.error);

gate(12, 'PGREPLICATION blocked/minimized',
  stat.envClears && build.envCleared === true && build.noOptionalStartupParams === true &&
  field(bhv.minimal || {}, 'replication').present === false,
  bhv.error);

gate(13, 'fallback_application_name is not a separate wire startup field',
  bhv.noFalseFallbackField === true,
  bhv.error);

gate(14, 'No raw connectionString',
  stat.noRawConnectionString);

gate(15, 'No raw DATABASE_URL passed to Pool/Client',
  stat.noRawDbUrlCtor);

gate(16, 'URL parsing/decoding still safe',
  stat.nativeUrl && stat.safeDecode && build.decode === true,
  bhv.error);

gate(17, 'Query/search params not forwarded',
  stat.noSearchForward && build.noSearch === true);

gate(18, 'SSL preserved',
  stat.ssl && build.ssl === true);

gate(19, 'Pool settings preserved',
  stat.pool && build.pool === true);

gate(20, 'server.js uses hardened helper',
  stat.serverHelper);

gate(21, 'lib/db/pg.js uses hardened helper',
  stat.pgJsHelper);

gate(22, 'Auto-migration uses real shared path',
  stat.autoMigrationShared);

gate(23, 'Deep health uses real shared path',
  stat.deepShared);

gate(24, 'No readiness-only side pool/client',
  stat.noSideReadiness);

gate(25, '/api/ready cannot falsely report DB connectivity ok from env presence',
  stat.readySafe);

gate(26, 'No URL/secrets/PII logged',
  stat.noUrlSecretPiiLogged && bhv.noSecretValues === true);

gate(27, 'No business/customer queries added',
  stat.noBusinessQueries);

gate(28, 'No external sends/agents/workflows',
  stat.noExternalSends);

let u31vPass = false;
let u31vDetail = '';
try {
  execFileSync(process.execPath, [P.u31vChecker], { stdio: 'pipe' });
  u31vPass = true;
} catch (e) {
  u31vDetail = ((e.stdout && e.stdout.toString()) || '') + ((e.stderr && e.stderr.toString()) || '');
}
const u31vContent = readOrNull(P.u31vChecker) || '';
const u31vReal = u31vContent.includes('process.exit') &&
  u31vContent.includes('buildSanitizedPgConfig') &&
  (u31vContent.match(/gate\(/g) || []).length >= 15;
gate(29, '2C.31V checker still passes',
  u31vPass && u31vReal,
  u31vDetail.split('\n').filter((line) => line.includes('[FAIL]')).join('; ') || (u31vReal ? '' : '2C.31V checker looks stubbed'));

gate(30, 'No 2C.32/data-load overclaim',
  stat.docBlocks32 && stat.docBlocksData && stat.noSafeTrue && stat.noMerge32Claim);

gate(31, 'Mutation matrix rejects critical cases; no hardcoded PASS/self-attestation',
  stat.noHardcodedBypass && bhv.ran === true && rejectedCount === mutations.length && mutations.length === 16 &&
  stat.lockPinned && stat.docHonestNoNodeModulesAssumption,
  `rejected=${rejectedCount}/${mutations.length} failures=${mutationFailures.join(',') || 'none'}`);

const EXPECTED_GATES = 32;
const beforeIntegrity = passed + failed;
gate(32, 'Gate-count integrity assertion',
  beforeIntegrity === EXPECTED_GATES - 1,
  `expected ${EXPECTED_GATES - 1} pre-integrity gates, ran ${beforeIntegrity}`);

if (passed + failed !== EXPECTED_GATES) {
  console.error(`[FAIL] Gate integrity: expected ${EXPECTED_GATES} gates, ${passed + failed} ran`);
  failed++;
}

console.log(`\n[2C.31W] mutation matrix: ${rejectedCount}/${mutations.length} rejected`);
for (const m of mutations) {
  console.log(`[MUTATION ${m.rejected ? 'REJECTED' : 'SURVIVED'}] ${m.id}`);
}

console.log(`\n[2C.31W] ${passed} passed, ${failed} failed of ${EXPECTED_GATES} gates.`);
if (bhv.ran) {
  console.log('[2C.31W] behavioral: client_encoding=UTF8 counted; minimal postgres/postgres=62B; UTF-8 byte math, oversized detection, PGUSER/PGDATABASE fallbacks, and secret-safe output verified.');
}
process.exit(failed === 0 ? 0 : 1);
