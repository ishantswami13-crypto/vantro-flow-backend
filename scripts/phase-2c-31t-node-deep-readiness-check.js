// FILE: scripts/phase-2c-31t-node-deep-readiness-check.js
// Phase 2C.31T - Node deep readiness probe gate (repository-side truth only).
//
// Verifies the additive /api/health/deep probe is safe: the route delegates to the
// deep-readiness module, the DB check is exactly one SELECT 1 over the shared pool
// with the actual query call timeout-wrapped, Rust health uses the existing safe
// client, prior liveness/readiness routes stay unchanged, and the contract doc makes
// no production / 2C.32 merge / staging-data-load overclaim.
//
// READ-ONLY and OFFLINE: reads + hashes files only; no process spawn, no network,
// no DB, no Railway, no env-file access, and no file writes. The mutation matrix runs
// against in-memory copies of the loaded text and proves unsafe edits fail while safe
// controls pass. Exit is fail-closed from gate records; display booleans are not
// trusted as proof.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const CHECKER_PATH = __filename;
const F = {
  server: path.join(ROOT, 'server.js'),
  deep: path.join(ROOT, 'lib', 'health', 'deepReadiness.js'),
  doc: path.join(ROOT, 'docs', 'deployment', 'phase-2c-31t-node-deep-readiness.md'),
};
const ALL_FILES = { ...F, checker: CHECKER_PATH };
const BASE_EXPECTED_GATES = 23;
const EXPECTED_GATES = 26;
const EXPECTED_UNSAFE_MUTATIONS = 24;
const SELECT_ONE_SQL = 'SELECT 1';
const QUERY_CALL_TOKEN = '.que' + 'ry(';

// Deprecated prior-probe artifact names: their presence would mean scope leftover.
const DEPRECATED = [
  path.join(ROOT, 'docs', 'deployment', 'phase-2c-31t-node-readiness-probe.md'),
  path.join(ROOT, 'scripts', 'phase-2c-31t-node-readiness-probe-check.js'),
];

const CUSTOMER_TABLES = [
  'customers', 'invoices', 'payments', 'ai_actions', 'ai_plans', 'customer_scores',
  'business_memory', 'suppliers', 'khata_entries', 'khata', 'purchases', 'promises',
  'transactions', 'notifications', 'owner_briefing',
];
const DATA_LEAK_TOKENS = [
  '.rows', 'rowCount', '.password', '.secret', '.apiKey', '.api_key',
  '.token', '.jwt', '.email', '.phone', '.address', '.gstin',
];
const ROUTE_FORBIDDEN = [
  { n: 'db_query', re: /\.\s*query\s*\(|\?\.\s*query\s*\(|\[\s*['"`]query['"`]\s*\]\s*\(|\bquery\s*\(|\bquery\s*\.bind\s*\(|\.\s*query\s*\.bind\s*\(|\.\s*from\s*\(|\bsupabase\b/i },
  { n: 'db_query_alias', re: /\b(const|let|var)\s+(?:\{\s*query\s*\}|[A-Za-z_$][\w$]*\s*=\s*[^;\n]*query\s*\.bind\s*\()/i },
  { n: 'pool_reference', re: /\b(pgPool|pool|client)\b/ },
  { n: 'sql_statement', re: /\b(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i },
  { n: 'db_write_ddl', re: /\b(insert|update|delete|create|alter|drop|truncate)\b/i },
  { n: 'migration', re: /runAutoMigrations|ensureTransactionsTable|migrat\w*\s*\(/i },
  { n: 'external_send', re: /twilio|whatsapp|\bsms\b|\bvoice\b|email|sendEmail|sendSms|sendSMS|sendWhatsApp|sendVoice|razorpay|sendMessage|nodemailer|\bsend\s*\(/i },
  { n: 'agent_workflow', re: /workflow|agent|runWorkflow|executeWorkflow|runAgent|executeAgent|triggerAgent|dispatchAction|executeAction|orchestrat|workflowRunner|agentRegistry|\.\s*run\s*\(/i },
  { n: 'env_or_secret', re: /process\.env|\bJWT_SECRET\b|\bDATABASE_URL\b|\bSUPABASE(?:_[A-Z_]+)?\b/ },
  { n: 'business_table', re: /\b(customers|invoices|payments|suppliers|khata|khata_entries|owner_briefing|purchases|promises|business_memory|customer_scores|ai_actions|ai_plans|transactions|notifications)\b/i },
  { n: 'direct_rust_business', re: /checkRustHealth|rustAutomation|getDashboardBootstrapRust|scoreCustomerRust|calculateCpiRust|evaluatePolicyRust/ },
  { n: 'raw_error_leak', re: /\.(message|stack)\b|String\(\s*e(rr)?\s*\)|JSON\.stringify\(\s*e(rr)?\b/i },
];
const OVERCLAIM_PROD = [
  'production ready', 'production-ready', 'is now live in production',
  'live in production', 'verified in production',
];
const OVERCLAIM_232 = [
  'phase 2c32 can merge', '2c32 can merge',
  'safe to merge phase 2c32', 'phase 2c32 is safe to merge',
];
const OVERCLAIM_DATA = [
  'safe to load staging data', 'staging data loaded',
  'data load is safe', 'ready to load staging data',
];
const NEG = [
  ' no ', 'no ', 'not ', 'never', 'remains blocked', 'blocked', 'pending',
  'must', 'cannot', 'does not', 'is not', 'nothing', 'without', 'not yet',
  'requires', 'false', 'until',
];
const SECRET = [
  { n: 'email', re: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i },
  { n: 'pg_url', re: /postgres(ql)?:\/\/[^\s]/i },
  { n: 'long_digits', re: /\d{10,}/ },
];
const FORBIDDEN_CHECKER = [
  'child' + '_process', 'spa' + 'wn(', 'exe' + 'cSync', 'exe' + 'c(', '.que' + 'ry(',
  'write' + 'FileSync', 'create' + 'WriteStream', '.conn' + 'ect(', 'http.' + 'request',
  'https.' + 'get', 'fet' + 'ch(', "require('h" + "ttps')",
];
const FORBIDDEN_SELF_KEYS = [
  'checker_pass', 'self_certified', 'is_safe', 'verified_safe',
  'production_ready', 'safe_to_load_data_true',
];
const FORBIDDEN_CHECKER_HARDCODE = /overall_pass\s*:\s*true/;
const ENV_STAGING = '.env' + '.staging';

const read = (p) => fs.readFileSync(p, 'utf8');
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const clauses = (t) => String(t)
  .toLowerCase()
  .replace(/(2c)\.(\d)/g, '$1$2')
  .split(/[\n.,;:!?|#]|--/)
  .map((s) => s.trim())
  .filter(Boolean);
const hasNeg = (c) => NEG.some((n) => c.includes(n));
const overclaimHits = (text, phrases) => {
  const hits = [];
  clauses(text).forEach((c) => phrases.forEach((p) => {
    if (c.includes(p) && !hasNeg(c)) hits.push(p);
  }));
  return hits;
};
const stripJsComments = (src) => String(src)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');
const normalizedCode = (src) => stripJsComments(src);
const routeScanCode = (src) => normalizedCode(src)
  .replace(/deepReadiness\s*\(\s*pgPool\s*,\s*req\.requestId\s*\)/g, 'deepReadiness(__sharedPool, req.requestId)');
const cloneTexts = (src) => ({
  server: src.server,
  deep: src.deep,
  doc: src.doc,
  checker: src.checker,
});

function addGate(results, id, name, pass, detail) {
  results.push({ id, name, pass: pass === true, detail: detail || {} });
}

function skipQuotedString(src, i, quote) {
  for (let j = i + 1; j < src.length; j += 1) {
    if (src[j] === '\\') {
      j += 1;
    } else if (src[j] === quote) {
      return j;
    }
  }
  return src.length;
}

function skipLineComment(src, i) {
  const end = src.indexOf('\n', i + 2);
  return end < 0 ? src.length : end;
}

function skipBlockComment(src, i) {
  const end = src.indexOf('*/', i + 2);
  return end < 0 ? src.length : end + 1;
}

function skipTemplateLiteral(src, i) {
  for (let j = i + 1; j < src.length; j += 1) {
    if (src[j] === '\\') {
      j += 1;
    } else if (src[j] === '`') {
      return j;
    }
  }
  return src.length;
}

function skipIgnorableCodeSpan(src, i) {
  const ch = src[i];
  const next = src[i + 1];
  if (ch === '"' || ch === "'") return skipQuotedString(src, i, ch);
  if (ch === '`') return skipTemplateLiteral(src, i);
  if (ch === '/' && next === '/') return skipLineComment(src, i);
  if (ch === '/' && next === '*') return skipBlockComment(src, i);
  return i;
}

function findCodeToken(src, token, start, end) {
  const limit = typeof end === 'number' ? end : src.length;
  for (let i = start; i < limit; i += 1) {
    const skipped = skipIgnorableCodeSpan(src, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    if (src.startsWith(token, i)) return i;
  }
  return -1;
}

function nextCodeIndex(src, start, end) {
  const limit = typeof end === 'number' ? end : src.length;
  for (let i = start; i < limit; i += 1) {
    if (/\s/.test(src[i])) continue;
    if (src[i] === '/' && src[i + 1] === '/') {
      i = skipLineComment(src, i);
      continue;
    }
    if (src[i] === '/' && src[i + 1] === '*') {
      i = skipBlockComment(src, i);
      continue;
    }
    return i;
  }
  return -1;
}

function findMatchingCodePair(src, open, openCh, closeCh) {
  if (open < 0 || src[open] !== openCh) return -1;
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const skipped = skipIgnorableCodeSpan(src, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    const ch = src[i];
    if (ch === openCh) depth += 1;
    else if (ch === closeCh) {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

function findDeepRouteRegistration(src) {
  let search = 0;
  while (search < src.length) {
    const routeStart = findCodeToken(src, 'app.get', search, src.length);
    if (routeStart < 0) return null;
    const callOpen = nextCodeIndex(src, routeStart + 'app.get'.length, src.length);
    if (callOpen < 0 || src[callOpen] !== '(') {
      search = routeStart + 'app.get'.length;
      continue;
    }
    const callClose = findMatchingCodePair(src, callOpen, '(', ')');
    if (callClose < 0) return null;
    const firstArgStart = nextCodeIndex(src, callOpen + 1, callClose);
    if (firstArgStart >= 0) {
      const quote = src[firstArgStart];
      if ((quote === '"' || quote === "'" || quote === '`') &&
          src.slice(firstArgStart + 1, firstArgStart + '/api/health/deep'.length + 1) === '/api/health/deep' &&
          src[firstArgStart + '/api/health/deep'.length + 1] === quote) {
        return { routeStart, callOpen, callClose };
      }
    }
    search = callClose + 1;
  }
  return null;
}

function findDeepRoute(src) {
  const registration = findDeepRouteRegistration(src);
  if (!registration) return null;
  const arrow = findCodeToken(src, '=>', registration.callOpen + 1, registration.callClose);
  let bodyOpen = -1;
  if (arrow >= 0) {
    const afterArrow = nextCodeIndex(src, arrow + 2, registration.callClose);
    if (afterArrow >= 0 && src[afterArrow] === '{') bodyOpen = afterArrow;
  } else {
    const fn = findCodeToken(src, 'function', registration.callOpen + 1, registration.callClose);
    if (fn >= 0) {
      for (let i = fn + 'function'.length; i < registration.callClose; i += 1) {
        const skipped = skipIgnorableCodeSpan(src, i);
        if (skipped !== i) {
          i = skipped;
          continue;
        }
        if (src[i] === '{') {
          bodyOpen = i;
          break;
        }
      }
    }
  }
  if (bodyOpen < 0) return null;
  const bodyClose = findMatchingCodePair(src, bodyOpen, '{', '}');
  if (bodyClose < 0 || bodyClose > registration.callClose) return null;
  let routeEnd = registration.callClose + 1;
  const semicolon = src.slice(routeEnd, routeEnd + 4).match(/^\s*;/);
  if (semicolon) routeEnd += semicolon[0].length;
  return {
    start: registration.routeStart,
    callOpen: registration.callOpen,
    callClose: registration.callClose,
    bodyOpen,
    bodyClose,
    routeEnd,
  };
}

function extractRouteBlock(src) {
  const route = findDeepRoute(src);
  return route ? src.slice(route.bodyOpen + 1, route.bodyClose) : null;
}

function injectIntoDeepRoute(src, code) {
  const route = findDeepRoute(src);
  if (!route) return src;
  return src.slice(0, route.bodyOpen + 1) + '\n' + code + '\n' + src.slice(route.bodyOpen + 1);
}

function injectBeforeDeepRouteClose(src, code) {
  const route = findDeepRoute(src);
  if (!route) return src;
  return src.slice(0, route.bodyClose) + '\n' + code + '\n' + src.slice(route.bodyClose);
}

function removeDeepRoute(src) {
  const route = findDeepRoute(src);
  if (!route) return src;
  return src.slice(0, route.start) + src.slice(route.routeEnd);
}

function findSelectOneQueries(src) {
  const calls = [];
  const re = /\bpool\s*\.\s*query\s*\(\s*(['"`])SELECT 1\1\s*\)/g;
  for (const m of src.matchAll(re)) {
    calls.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
  }
  return calls;
}

function isTimeoutWrapped(src, call) {
  const before = src.slice(Math.max(0, call.start - 120), call.start);
  const after = src.slice(call.end, Math.min(src.length, call.end + 220));
  const withTimeoutWrapped = /withTimeout\s*\(\s*$/.test(before) && /^\s*,\s*DB_TIMEOUT_MS\b/.test(after);
  const promiseRaceWrapped = /Promise\.race\s*\(\s*\[\s*$/.test(before) && /DB_TIMEOUT_MS/.test(after);
  return withTimeoutWrapped || promiseRaceWrapped;
}

function dbTimeoutProof(deepCode) {
  const selectOneQueries = findSelectOneQueries(deepCode);
  const poolQueryCount = (deepCode.match(/\bpool\s*\.\s*query\s*\(/g) || []).length;
  const actualQuery = selectOneQueries.length === 1 ? selectOneQueries[0] : null;
  const wrappedQuery = !!actualQuery && isTimeoutWrapped(deepCode, actualQuery);
  const finiteTimeoutConst = /const\s+DB_TIMEOUT_MS\s*=\s*\d+/.test(deepCode);
  const timeoutArgApplied = !!actualQuery && (
    /withTimeout\s*\(\s*pool\s*\.\s*query\s*\(\s*['"`]SELECT 1['"`]\s*\)\s*,\s*DB_TIMEOUT_MS/.test(deepCode) ||
    /Promise\.race\s*\(\s*\[\s*pool\s*\.\s*query\s*\(\s*['"`]SELECT 1['"`]\s*\)[\s\S]{0,160}DB_TIMEOUT_MS/.test(deepCode)
  );
  const timerMechanism = /setTimeout\s*\(/.test(deepCode);
  return {
    selectOneCount: selectOneQueries.length,
    poolQueryCount,
    singleActualQuery: selectOneQueries.length === 1 && poolQueryCount === 1,
    wrappedQuery,
    finiteTimeoutConst,
    timeoutArgApplied,
    timerMechanism,
  };
}

function evaluateSnapshot(txt) {
  const results = [];
  const server = txt.server;
  const deepRaw = txt.deep;
  const doc = txt.doc;
  const dl = doc.toLowerCase();
  const deep = normalizedCode(deepRaw);

  addGate(results, 'G01', 'deep_route_exists', /app\.get\((['"`])\/api\/health\/deep\1/.test(server), {});
  addGate(results, 'G02', 'health_unchanged', /app\.get\((['"`])\/api\/health\1/.test(server) && /status:\s*'alive'/.test(server) && /uptime:\s*process\.uptime\(\)/.test(server), {});
  addGate(results, 'G03', 'ready_unchanged', /app\.get\((['"`])\/api\/ready\1/.test(server) && /status:\s*'ready'/.test(server) &&
    /database:\s*process\.env\.DATABASE_URL\s*\?\s*'ok'\s*:\s*'missing'/.test(server) &&
    /metrics:\s*process\.env\.METRICS_TOKEN\s*\?\s*'ok'\s*:\s*'missing'/.test(server), {});

  const dbProof = dbTimeoutProof(deep);
  const noBusinessSql = !/(insert|update|delete|drop|alter|truncate|create\s+table)/i.test(deep) &&
    !/\.from\s*\(/.test(deep) &&
    !/\bfrom\s+(customers|invoices|payments|suppliers|khata|khata_entries|owner_briefing|business_memory|customer_scores|ai_actions|ai_plans|transactions|notifications)\b/i.test(deep);
  addGate(results, 'G04', 'db_select1_only', dbProof.singleActualQuery && noBusinessSql, { ...dbProof, noBusinessSql });
  addGate(results, 'G05', 'db_timeout_wrapped', dbProof.singleActualQuery && dbProof.wrappedQuery &&
    dbProof.finiteTimeoutConst && dbProof.timeoutArgApplied && dbProof.timerMechanism, dbProof);
  addGate(results, 'G06', 'rust_uses_checkRustHealth', /checkRustHealth/.test(deep), {});
  addGate(results, 'G07', 'no_customer_tables', !CUSTOMER_TABLES.some((t) => new RegExp('\\b' + t + '\\b').test(deep)) && !/supabase\s*\.\s*from\s*\(|\.\s*from\s*\(/i.test(deep), {});
  addGate(results, 'G08', 'no_migrations', !/runAutoMigrations\s*\(|CREATE\s+TABLE|ALTER\s+TABLE|\.migrate\s*\(|migrat\w*\s*\(/i.test(deep), {});
  addGate(results, 'G09', 'no_external_send', !/twilio|whatsapp|sendMessage|external_message|EXTERNAL_MESSAGE|nodemailer|\.\s*send\s*\(/i.test(deep), {});
  addGate(results, 'G10', 'no_agents_workflows', !/runWorkflow\s*\(|executeWorkflow\s*\(|runAgent\s*\(|executeAgent\s*\(|triggerAgent\s*\(|dispatchAction\s*\(|executeAction\s*\(|orchestrat|workflowRunner|agentRegistry|\.\s*run\s*\(/i.test(deep), {});
  addGate(results, 'G11', 'no_env_returned', !/process\.env/.test(deep) && SECRET.every((s) => !s.re.test(deep)), {});
  addGate(results, 'G12', 'safe_to_load_data_false', /safe_to_load_data:\s*false/.test(deep) && !/safe_to_load_data:\s*true/.test(deep) && /safe_to_load_data:\s*false/.test(server), {});

  const keysPresent = ['success', 'checks', 'node', 'db', 'rust', 'safe_to_load_data', 'timestamp', 'request_id'].every((k) => deep.includes(k));
  const noLeak = !DATA_LEAK_TOKENS.some((t) => deep.includes(t));
  addGate(results, 'G13', 'safe_response_shape', keysPresent && noLeak, { keysPresent, noLeak });
  addGate(results, 'G14', 'no_production_claim', overclaimHits(doc, OVERCLAIM_PROD).length === 0, { hits: overclaimHits(doc, OVERCLAIM_PROD).slice(0, 4) });
  addGate(results, 'G15', 'no_232_merge_claim', overclaimHits(doc, OVERCLAIM_232).length === 0, { hits: overclaimHits(doc, OVERCLAIM_232).slice(0, 4) });
  addGate(results, 'G16', 'no_staging_load_claim', overclaimHits(doc, OVERCLAIM_DATA).length === 0 && /safe_to_load_data:\s*false/.test(deep), { hits: overclaimHits(doc, OVERCLAIM_DATA).slice(0, 4) });
  addGate(results, 'G17', 'no_env_staging_read', !deep.includes(ENV_STAGING) && !dl.includes(ENV_STAGING) && !txt.checker.includes(ENV_STAGING), {});

  const approvedOk = Object.keys(F).every((k) => txt[k] && txt[k].length > 0) && txt.checker && txt.checker.length > 0;
  const deprecatedAbsent = DEPRECATED.every((p) => !fs.existsSync(p));
  addGate(results, 'G18', 'scope_limited', approvedOk && deprecatedAbsent, { approvedOk, deprecatedAbsent });

  const noSelfKey = !FORBIDDEN_SELF_KEYS.some((k) => doc.includes(k) || dl.includes(k.replace(/_/g, ' ')));
  const checkerOffline = !FORBIDDEN_CHECKER.some((t) => txt.checker.includes(t));
  const noHardcodedPass = !FORBIDDEN_CHECKER_HARDCODE.test(txt.checker);
  addGate(results, 'G19', 'no_self_attestation', approvedOk && noSelfKey && checkerOffline && noHardcodedPass,
    { noSelfKey, checkerOffline, noHardcodedPass });

  const routeBlock = extractRouteBlock(server);
  const routeScan = routeBlock ? routeScanCode(routeBlock) : null;
  addGate(results, 'G20', 'route_body_extracted', typeof routeBlock === 'string' && routeBlock.length > 0 && /deepReadiness/.test(routeBlock), { extracted: !!routeBlock, len: routeBlock ? routeBlock.length : 0 });
  const routeHits = routeScan ? ROUTE_FORBIDDEN.filter((p) => p.re.test(routeScan)).map((p) => p.n) : ['no_route_block'];
  addGate(results, 'G21', 'route_body_no_unsafe', routeHits.length === 0, { hits: routeHits });
  const delegates = !!routeScan && /deepReadiness\s*\(/.test(routeScan)
    && /res\.(status\(\s*\d+\s*\)\.)?json\s*\(/.test(routeScan)
    && /safe_to_load_data:\s*false/.test(routeScan)
    && !/safe_to_load_data:\s*true/.test(routeScan);
  addGate(results, 'G22', 'route_body_delegates_safely', delegates, { hasBlock: !!routeScan });

  const uniqueSoFar = new Set(results.map((r) => r.id)).size;
  addGate(results, 'G23', 'no_vacuous_gateset', BASE_EXPECTED_GATES === 23 && results.length === 22 && uniqueSoFar === 22, { soFar: results.length, uniqueSoFar });

  const failed = results.filter((r) => !r.pass);
  const uniqueIdCount = new Set(results.map((r) => r.id)).size;
  const countOk = results.length === BASE_EXPECTED_GATES && uniqueIdCount === BASE_EXPECTED_GATES;
  return {
    results,
    failed,
    failedIds: failed.map((r) => r.id),
    countOk,
    overallPass: failed.length === 0 && countOk,
  };
}

const routeHiddenAfterStringBraceQuery = "const extractorBypass = '}';\n  await pgPool" + QUERY_CALL_TOKEN + "'SELECT * FROM customers');";
const routePgPoolSelectOneQuery = 'await pgPool' + QUERY_CALL_TOKEN + "'SELECT 1');";
const routePgPoolBracketSingleQuery = "await pgPool['query']('SELECT 1');";
const routePgPoolBracketDoubleQuery = 'await pgPool["query"](\'SELECT 1\');';
const routeOptionalQuery = 'await pool?' + QUERY_CALL_TOKEN + "'SELECT 1');";
const routeDestructuredQueryAlias = "const { query } = pgPool;\n  await query('SELECT 1');";
const routeBoundQueryAlias = "const q = pgPool.query.bind(pgPool);\n  await q('SELECT 1');";
const routeCustomerQuery = 'await pgPool' + QUERY_CALL_TOKEN + "'SELECT * FROM customers');";
const bareSelectOne = 'await pool' + QUERY_CALL_TOKEN + "'SELECT 1');";
const hardcodedOverall = 'overall_' + 'pass: true';

const UNSAFE_MUTATIONS = [
  {
    id: 'route_hidden_after_string_brace_query',
    expected: ['G21'],
    mutate: (s) => ({ ...s, server: injectBeforeDeepRouteClose(s.server, routeHiddenAfterStringBraceQuery) }),
  },
  {
    id: 'route_pgpool_dot_query',
    expected: ['G21'],
    mutate: (s) => ({ ...s, server: injectIntoDeepRoute(s.server, routePgPoolSelectOneQuery) }),
  },
  {
    id: 'route_pgpool_bracket_single_query',
    expected: ['G21'],
    mutate: (s) => ({ ...s, server: injectIntoDeepRoute(s.server, routePgPoolBracketSingleQuery) }),
  },
  {
    id: 'route_pgpool_bracket_double_query',
    expected: ['G21'],
    mutate: (s) => ({ ...s, server: injectIntoDeepRoute(s.server, routePgPoolBracketDoubleQuery) }),
  },
  {
    id: 'route_optional_pool_query',
    expected: ['G21'],
    mutate: (s) => ({ ...s, server: injectIntoDeepRoute(s.server, routeOptionalQuery) }),
  },
  {
    id: 'route_destructured_query_alias',
    expected: ['G21'],
    mutate: (s) => ({ ...s, server: injectIntoDeepRoute(s.server, routeDestructuredQueryAlias) }),
  },
  {
    id: 'route_bound_query_alias',
    expected: ['G21'],
    mutate: (s) => ({ ...s, server: injectIntoDeepRoute(s.server, routeBoundQueryAlias) }),
  },
  {
    id: 'route_customer_query',
    expected: ['G21'],
    mutate: (s) => ({ ...s, server: injectIntoDeepRoute(s.server, routeCustomerQuery) }),
  },
  {
    id: 'route_migration_call',
    expected: ['G21'],
    mutate: (s) => ({ ...s, server: injectIntoDeepRoute(s.server, 'await runAutoMigrations();') }),
  },
  {
    id: 'route_external_send',
    expected: ['G21'],
    mutate: (s) => ({ ...s, server: injectIntoDeepRoute(s.server, 'await notificationClient.sendMessage({ channel: "whatsapp" });') }),
  },
  {
    id: 'route_agent_workflow_call',
    expected: ['G21'],
    mutate: (s) => ({ ...s, server: injectIntoDeepRoute(s.server, 'await agentRegistry.run("core.owner_briefing");') }),
  },
  {
    id: 'route_env_secret_leak',
    expected: ['G21'],
    mutate: (s) => ({ ...s, server: injectIntoDeepRoute(s.server, 'const leaked = process.env.JWT_SECRET;') }),
  },
  {
    id: 'bare_db_probe',
    expected: ['G05'],
    mutate: (s) => ({
      ...s,
      deep: s.deep.replace(/await\s+withTimeout\(\s*pool\s*\.\s*query\(\s*['"`]SELECT 1['"`]\s*\)\s*,\s*DB_TIMEOUT_MS\s*,\s*['"`]db_timeout['"`]\s*\);/, bareSelectOne),
    }),
  },
  {
    id: 'remove_deep_route',
    expected: ['G01', 'G20', 'G21', 'G22'],
    mutate: (s) => ({ ...s, server: removeDeepRoute(s.server) }),
  },
  {
    id: 'modify_health_route',
    expected: ['G02'],
    mutate: (s) => ({ ...s, server: s.server.replace(/status:\s*'alive'/, "status: 'changed'") }),
  },
  {
    id: 'modify_ready_route',
    expected: ['G03'],
    mutate: (s) => ({ ...s, server: s.server.replace(/status:\s*'ready'/, "status: 'changed'") }),
  },
  {
    id: 'business_table_db_probe',
    expected: ['G04', 'G05', 'G07'],
    mutate: (s) => ({
      ...s,
      deep: s.deep.replace(/\bpool\s*\.\s*query\s*\(\s*(['"`])SELECT 1\1\s*\)/, 'pool' + QUERY_CALL_TOKEN + "'SELECT * FROM customers')"),
    }),
  },
  {
    id: 'remove_db_timeout',
    expected: ['G05'],
    mutate: (s) => ({
      ...s,
      deep: s.deep.replace(/await\s+withTimeout\(\s*pool\s*\.\s*query\(\s*['"`]SELECT 1['"`]\s*\)\s*,\s*DB_TIMEOUT_MS\s*,\s*['"`]db_timeout['"`]\s*\);/, bareSelectOne),
    }),
  },
  {
    id: 'remove_rust_health',
    expected: ['G06'],
    mutate: (s) => ({ ...s, deep: s.deep.replace(/checkRustHealth/g, 'checkRustProbe') }),
  },
  {
    id: 'safe_to_load_data_true',
    expected: ['G12', 'G16'],
    mutate: (s) => ({ ...s, deep: s.deep.replace(/safe_to_load_data:\s*false/, 'safe_to_load_data: true') }),
  },
  {
    id: 'migration_in_deep_module',
    expected: ['G08'],
    mutate: (s) => ({ ...s, deep: s.deep.replace(/try\s*\{/, 'try {\n    await runAutoMigrations();') }),
  },
  {
    id: 'phase_232_can_merge_claim',
    expected: ['G15'],
    mutate: (s) => ({ ...s, doc: s.doc + '\nPhase 2C.32 can merge.\n' }),
  },
  {
    id: 'hardcoded_pass_while_gate_fails',
    expected: ['G19', 'G21'],
    mutate: (s) => ({
      ...s,
      server: injectIntoDeepRoute(s.server, routeCustomerQuery),
      checker: s.checker + '\n' + hardcodedOverall + '\n',
    }),
  },
  {
    id: 'dotted_232_overclaim',
    expected: ['G15'],
    mutate: (s) => ({ ...s, doc: s.doc + '\n2c.32 can merge.\n' }),
  },
];

const SAFE_CONTROLS = [
  {
    id: 'base_snapshot',
    mutate: (s) => cloneTexts(s),
  },
  {
    id: 'negated_overclaim_phrases',
    mutate: (s) => ({
      ...s,
      doc: s.doc + '\nIt is not safe to merge Phase 2C.32 and not safe to load staging data.\n',
    }),
  },
];

function runMutationMatrix(baseTxt, baseOverallPass) {
  const unsafe = UNSAFE_MUTATIONS.map((m) => {
    const mutated = m.mutate(cloneTexts(baseTxt));
    const evaluated = evaluateSnapshot(mutated);
    const failed = new Set(evaluated.failedIds);
    const expectedHit = m.expected.some((id) => failed.has(id));
    return {
      id: m.id,
      rejected: baseOverallPass && evaluated.overallPass === false && expectedHit,
      failed_gate_ids: evaluated.failedIds,
      expected_gate_ids: m.expected,
    };
  });
  const safe = SAFE_CONTROLS.map((m) => {
    const mutated = m.mutate(cloneTexts(baseTxt));
    const evaluated = evaluateSnapshot(mutated);
    return {
      id: m.id,
      passed: evaluated.overallPass === true,
      failed_gate_ids: evaluated.failedIds,
    };
  });
  return {
    unsafe,
    safe,
    unsafe_total: unsafe.length,
    unsafe_rejected: unsafe.filter((m) => m.rejected).length,
    safe_total: safe.length,
    safe_passed: safe.filter((m) => m.passed).length,
    failed_unsafe: unsafe.filter((m) => !m.rejected),
    failed_safe_controls: safe.filter((m) => !m.passed),
  };
}

function hashAll(pathsByKey) {
  const out = {};
  for (const [k, p] of Object.entries(pathsByKey)) out[k] = sha(p);
  return out;
}

const results = [];
let loadError = null;
const txt = {};
let before = {};
let after = {};
let baseEval = null;
let mutationMatrix = {
  unsafe_total: 0,
  unsafe_rejected: 0,
  safe_total: 0,
  safe_passed: 0,
  failed_unsafe: [],
  failed_safe_controls: [],
};
let mutatedFiles = [];

try {
  for (const k of Object.keys(F)) txt[k] = read(F[k]);
  txt.checker = read(CHECKER_PATH);
  before = hashAll(ALL_FILES);
} catch (e) {
  loadError = String(e && e.message ? e.message : e);
}

if (loadError) {
  for (let i = 1; i <= EXPECTED_GATES; i += 1) {
    addGate(results, 'G' + String(i).padStart(2, '0'), 'load_error', false, { loadError });
  }
} else {
  baseEval = evaluateSnapshot(txt);
  results.push(...baseEval.results);

  mutationMatrix = runMutationMatrix(txt, baseEval.overallPass);
  addGate(results, 'G24', 'unsafe_mutations_rejected',
    mutationMatrix.unsafe_total === EXPECTED_UNSAFE_MUTATIONS && mutationMatrix.unsafe_rejected === mutationMatrix.unsafe_total,
    {
      unsafe_total: mutationMatrix.unsafe_total,
      unsafe_rejected: mutationMatrix.unsafe_rejected,
      failed_unsafe: mutationMatrix.failed_unsafe,
    });
  addGate(results, 'G25', 'safe_controls_pass',
    mutationMatrix.safe_total === 2 && mutationMatrix.safe_passed === mutationMatrix.safe_total,
    {
      safe_total: mutationMatrix.safe_total,
      safe_passed: mutationMatrix.safe_passed,
      failed_safe_controls: mutationMatrix.failed_safe_controls,
    });

  after = hashAll(ALL_FILES);
  mutatedFiles = Object.keys(before).filter((k) => before[k] !== after[k]);
  addGate(results, 'G26', 'files_unchanged', mutatedFiles.length === 0, { mutatedFiles });
}

const failed = results.filter((r) => !r.pass);
const uniqueIdCount = new Set(results.map((r) => r.id)).size;
const countOk = results.length === EXPECTED_GATES && uniqueIdCount === EXPECTED_GATES;
const gateById = Object.fromEntries(results.map((r) => [r.id, r]));

const summary = {
  phase: '2C.31T',
  overall_pass: !loadError && failed.length === 0 && countOk,
  gates_passed: results.length - failed.length,
  gates_total: results.length,
  expected_gate_count: EXPECTED_GATES,
  unique_gate_ids: uniqueIdCount,
  load_error: loadError,
  endpoint: '/api/health/deep',
  safe_to_load_data: false,
  route_body_extraction: gateById.G20 ? gateById.G20.pass : false,
  route_body_unsafe_scan: gateById.G21 ? gateById.G21.pass : false,
  actual_db_timeout_wrapper: gateById.G05 ? gateById.G05.pass : false,
  mutation_matrix: {
    unsafe_total: mutationMatrix.unsafe_total,
    unsafe_rejected: mutationMatrix.unsafe_rejected,
    safe_total: mutationMatrix.safe_total,
    safe_passed: mutationMatrix.safe_passed,
    failed_unsafe: mutationMatrix.failed_unsafe,
    failed_safe_controls: mutationMatrix.failed_safe_controls,
  },
  byte_identical_restoration: mutatedFiles.length === 0,
  files_mutated_by_check: mutatedFiles,
  failed_gate_ids: failed.map((r) => r.id),
  failed_gates: failed.map((r) => ({ id: r.id, name: r.name, detail: r.detail })),
};

console.log('NODE_DEEP_READINESS_JSON:' + JSON.stringify(summary, null, 1));

if (loadError || failed.length > 0 || !countOk) {
  const why = loadError ? ('load_error ' + loadError)
    : (failed.length > 0 ? ('failed=[' + failed.map((f) => f.id).join(',') + ']')
      : ('gate_integrity gates=' + results.length + '/' + EXPECTED_GATES + ' unique=' + uniqueIdCount));
  console.error('NODE_DEEP_READINESS_FAIL: ' + why + '.');
  process.exit(failed.length || 1);
}
console.log('NODE_DEEP_READINESS_PASS: all ' + EXPECTED_GATES + ' repository-side gates passed.');
process.exit(0);
