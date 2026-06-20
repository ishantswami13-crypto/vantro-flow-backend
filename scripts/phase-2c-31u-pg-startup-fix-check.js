// FILE: scripts/phase-2c-31u-pg-startup-fix-check.js
'use strict';

const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');

const serverJsPath = path.join(rootDir, 'server.js');
const pgJsPath = path.join(rootDir, 'lib', 'db', 'pg.js');
const pgConfigJsPath = path.join(rootDir, 'lib', 'db', 'pgConfig.js');
const deepReadinessPath = path.join(rootDir, 'lib', 'health', 'deepReadiness.js');

let hasError = false;

function error(msg) {
  console.error(`[FAIL] ${msg}`);
  hasError = true;
}

function success(msg) {
  console.log(`[PASS] ${msg}`);
}

const serverJsContent = fs.readFileSync(serverJsPath, 'utf8');
const pgJsContent = fs.readFileSync(pgJsPath, 'utf8');
const pgConfigJsContent = fs.existsSync(pgConfigJsPath) ? fs.readFileSync(pgConfigJsPath, 'utf8') : null;
const deepReadinessContent = fs.existsSync(deepReadinessPath) ? fs.readFileSync(deepReadinessPath, 'utf8') : '';

// 1. connectionString checks
if (serverJsContent.includes('connectionString:')) {
  error('server.js still contains "connectionString:".');
} else {
  success('server.js does not contain "connectionString:"');
}

if (pgJsContent.includes('connectionString:')) {
  error('lib/db/pg.js still contains "connectionString:".');
} else {
  success('lib/db/pg.js does not contain "connectionString:"');
}

// 2. buildSanitizedPgConfig checks
if (!serverJsContent.includes('buildSanitizedPgConfig')) {
  error('server.js is not using buildSanitizedPgConfig.');
} else {
  success('server.js is using buildSanitizedPgConfig.');
}

if (!pgJsContent.includes('buildSanitizedPgConfig')) {
  error('lib/db/pg.js is not using buildSanitizedPgConfig.');
} else {
  success('lib/db/pg.js is using buildSanitizedPgConfig.');
}

if (!pgConfigJsContent) {
  error('lib/db/pgConfig.js does not exist.');
} else {
  success('lib/db/pgConfig.js exists.');
  
  // 3. Forward URL query/search params
  if (pgConfigJsContent.includes('search:') || pgConfigJsContent.includes('query:')) {
    error('pgConfig.js forwards search/query params.');
  } else {
    success('pgConfig.js does not forward search/query params.');
  }

  // 4. application_name
  if (pgConfigJsContent.includes('application_name')) {
    error('pgConfig.js forwards application_name.');
  } else {
    success('pgConfig.js does not forward application_name.');
  }

  // 5. options
  if (pgConfigJsContent.includes('options:')) {
    error('pgConfig.js forwards options.');
  } else {
    success('pgConfig.js does not forward options.');
  }

  // 6. SSL config
  if (!pgConfigJsContent.includes('ssl: { rejectUnauthorized: false }')) {
    error('pgConfig.js is missing expected SSL config.');
  } else {
    success('pgConfig.js preserves SSL config.');
  }

  // 7. Leak checks
  if (pgConfigJsContent.includes('console.log(') || pgConfigJsContent.includes('console.error(')) {
    error('lib/db/pgConfig.js contains console logging which might leak secrets.');
  } else {
    success('lib/db/pgConfig.js has no console logging.');
  }
}

// 8. false-green readiness checks
// Deep health shared path preserved: deepReadiness should take `pool` and not create a new one with connectionString
if (deepReadinessContent.includes('new Pool') || deepReadinessContent.includes('connectionString:')) {
  error('deepReadiness.js creates its own Pool instead of using the shared pool.');
} else {
  success('deepReadiness.js relies on shared pool.');
}

// 9. safe_to_load_data:true check
if (deepReadinessContent.includes('safe_to_load_data: true')) {
  error('deepReadiness.js sets safe_to_load_data to true illegally.');
} else {
  success('deepReadiness.js does not illegally set safe_to_load_data to true.');
}

if (hasError) {
  process.exit(1);
} else {
  process.exit(0);
}
