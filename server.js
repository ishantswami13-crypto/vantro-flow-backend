// FILE: server.js
// VANTRO FLOW BACKEND - Complete Node.js + Express API
// Deploy to: Railway.app

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cron = require('node-cron');
const rateLimit = require('express-rate-limit');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const path = require('path');
const webpush = require('web-push');
const { createClient } = require('@supabase/supabase-js');

function validateSecurityEnvironment() {
  const status = {
    JWT_SECRET: !!process.env.JWT_SECRET,
    SUPABASE_URL: !!process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    DATABASE_URL: !!process.env.DATABASE_URL,
    METRICS_TOKEN: !!process.env.METRICS_TOKEN,
    RAZORPAY_WEBHOOK_SECRET: !!process.env.RAZORPAY_WEBHOOK_SECRET,
    VOICE_WEBHOOK_SECRET: !!process.env.VOICE_WEBHOOK_SECRET,
    PUBLIC_LINK_SECRET: !!process.env.PUBLIC_LINK_SECRET,
    ENABLE_AUTH_COOKIES: process.env.ENABLE_AUTH_COOKIES === 'true',
    NODE_ENV: process.env.NODE_ENV || 'development'
  };

  console.log('[SECURITY] Environment Validation Status:', JSON.stringify(status));

  if (!process.env.JWT_SECRET) {
    console.error('[FATAL] JWT_SECRET is missing. Refusing to start.');
    process.exit(1);
  }
}

validateSecurityEnvironment();

function getSecret(name) {
  // Centralized secret access - allows future migration to AWS Secrets Manager/Vault
  // Prioritize _CURRENT for zero-downtime rotation
  const val = process.env[`${name}_CURRENT`] || process.env[name];
  if (!val && process.env.NODE_ENV === 'production' && ['JWT_SECRET', 'SUPABASE_SERVICE_ROLE_KEY'].includes(name)) {
    console.error(`[FATAL] Missing critical secret: ${name}`);
    process.exit(1);
  }
  return val;
}

function getPreviousSecret(name) {
  return process.env[`${name}_PREVIOUS`] || null;
}

function verifyJWT(token) {
  const currentSecret = getSecret('JWT_SECRET');
  const previousSecret = getPreviousSecret('JWT_SECRET');
  try {
    // Phase 2C.35-P2: pin the algorithm allowlist (tokens are HS256-signed) to
    // prevent algorithm-confusion / alg:none acceptance.
    return jwt.verify(token, currentSecret, { algorithms: ['HS256'] });
  } catch (err) {
    if (previousSecret) {
      try {
        return jwt.verify(token, previousSecret, { algorithms: ['HS256'] });
      } catch (innerErr) {
        throw innerErr;
      }
    }
    throw err;
  }
}

const JWT_SECRET = getSecret('JWT_SECRET');

const promClient = require('prom-client');
const register = new promClient.Registry();
promClient.collectDefaultMetrics({ register });
const httpRequestDurationMicroseconds = new promClient.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'normalized_route', 'status_code'],
  buckets: [0.1, 0.3, 0.5, 0.7, 1, 3, 5, 7, 10]
});
const httpRequestsTotal = new promClient.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'normalized_route', 'status_code']
});
const httpErrorsTotal = new promClient.Counter({
  name: 'http_errors_total',
  help: 'Total number of HTTP errors',
  labelNames: ['method', 'normalized_route', 'status_code']
});
register.registerMetric(httpRequestDurationMicroseconds);
register.registerMetric(httpRequestsTotal);
register.registerMetric(httpErrorsTotal);

function normalizeRoute(path) {
  return (path || '').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/ig, ':id')
                     .replace(/\/\d+/g, '/:id');
}

const { safeLog } = require('./lib/observability/logger');
const { ErrorTaxonomy, SecurityEventTaxonomy, createErrorEvent, logErrorEvent, safeErrorResponse, logSecurityEvent } = require('./lib/observability/error-tracking');
const { isEnabled: isFeatureEnabled } = require('./lib/featureFlags'); // Vantro Cortex feature flags
const { guardExternalSend, guardPush } = require('./lib/safety/externalSend'); // Phase 2C.35 external-send kill switch + push policy
// Phase 2C.35-P2 log sanitizers — never emit full PII / raw tenant IDs to logs.
function maskId(id) { const s = String(id == null ? '' : id); return s ? s.slice(0, 8) + '…' : '∅'; }
function maskPhone(p) { const d = String(p == null ? '' : p).replace(/\D/g, ''); return d.length >= 4 ? '***' + d.slice(-2) : '***'; }
const app = express();
app.set('trust proxy', 1); // Railway sits behind a proxy — needed for express-rate-limit to see real IP

// Request ID & structured logging middleware
app.use((req, res, next) => {
  const requestId = req.headers['x-request-id'] || crypto.randomUUID();
  req.requestId = requestId;
  res.setHeader('X-Request-ID', requestId);

  const startHrTime = process.hrtime();

  res.on('finish', () => {
    const elapsedHrTime = process.hrtime(startHrTime);
    const durationMs = (elapsedHrTime[0] * 1000 + elapsedHrTime[1] / 1e6).toFixed(2);
    
    const normalizedRoute = normalizeRoute(req.path);
    const status = res.statusCode;

    const labels = { method: req.method, normalized_route: normalizedRoute, status_code: status };
    httpRequestsTotal.inc(labels);
    httpRequestDurationMicroseconds.observe(labels, parseFloat(durationMs) / 1000);
    if (status >= 400) {
      httpErrorsTotal.inc(labels);
    }

    const logData = {
      requestId: req.requestId,
      method: req.method,
      route: normalizedRoute,
      statusCode: status,
      userId: req.user?.userId || req.user?.id || null,
      businessId: req.user?.businessId || null,
      durationMs: parseFloat(durationMs)
    };

    if (status >= 400) {
      logData.errorName = res.statusMessage || 'HTTP Error';
      logData.errorMessage = res.locals.errorMessage || 'Request failed';
      safeLog('error', 'API Request Error', logData);
    } else {
      safeLog('info', 'API Request Success', logData);
    }

    if (parseFloat(durationMs) > 1000) {
      safeLog('warn', '[SLOW_REQUEST]', {
        route: normalizedRoute,
        method: req.method,
        latencyMs: parseFloat(durationMs),
        requestId: req.requestId
      });
    }
  });

  next();
});

const PORT = process.env.PORT || 3001;
const IS_PRODUCTION = process.env.NODE_ENV === 'production' || Boolean(
  process.env.RAILWAY_ENVIRONMENT ||
  process.env.RAILWAY_SERVICE_NAME ||
  process.env.RAILWAY_PROJECT_ID ||
  process.env.RAILWAY_PUBLIC_URL
);


// ── In-memory OTP store (keyed by userId) ──────────────────────────────────
// Structure: Map<userId, { code: string, expiresAt: number, attempts: number }>
const otpStore = new Map();
function generateOTP() { return String(Math.floor(100000 + Math.random() * 900000)); }
function storeOTP(userId) {
  const code = generateOTP();
  otpStore.set(userId, { code, expiresAt: Date.now() + 10 * 60 * 1000, attempts: 0 });
  return code;
}
function verifyOTP(userId, code) {
  const entry = otpStore.get(userId);
  if (!entry) return { valid: false, reason: 'No OTP found. Click Resend.' };
  if (Date.now() > entry.expiresAt) { otpStore.delete(userId); return { valid: false, reason: 'OTP expired. Click Resend.' }; }
  if (entry.attempts >= 5) { otpStore.delete(userId); return { valid: false, reason: 'Too many attempts. Click Resend.' }; }
  entry.attempts++;
  if (entry.code !== String(code)) return { valid: false, reason: 'Wrong OTP. Try again.' };
  otpStore.delete(userId);
  return { valid: true };
}

// ── In-memory User-Scoped Summary Cache ──────────────────────────────────────
const summaryCache = new Map();

function buildBusinessCacheKey(userId, module) {
  if (!userId) throw new Error('userId is required for cache key');
  return `biz:${userId}:${module}`;
}

function getCache(key) {
  const entry = summaryCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    summaryCache.delete(key);
    return null;
  }
  return entry.value;
}

function setCache(key, value, ttlSeconds = 60) {
  summaryCache.set(key, {
    value,
    expiresAt: Date.now() + (ttlSeconds * 1000)
  });
}

function invalidateBusinessCache(userId) {
  if (!userId) return;
  const prefix = `biz:${userId}:`;
  for (const key of summaryCache.keys()) {
    if (key.startsWith(prefix)) {
      summaryCache.delete(key);
    }
  }
  console.log(`[Cache] Invalidated cache for user ${maskId(userId)}`);
}

// Lightweight background cache warming helper
function warmBusinessCache(userId) {
  if (!userId) return;
  
  // Warm the control-room and analytics summaries asynchronously
  Promise.all([
    calculateDashboardControlRoom(userId).then(data => {
      const cacheKey = buildBusinessCacheKey(userId, 'control-room');
      setCache(cacheKey, data, 60);
      console.log(`[Cache Warmer] Dashboard warmed for user ${maskId(userId)}`);
    }),
    calculateAnalyticsSummary(userId).then(data => {
      const cacheKey = buildBusinessCacheKey(userId, 'analytics');
      setCache(cacheKey, data, 60);
      console.log(`[Cache Warmer] Analytics warmed for user ${maskId(userId)}`);
    })
  ]).catch(err => {
    console.warn(`[Cache Warmer] Silent background warming error for user ${maskId(userId)}:`, err.message);
  });
}

// Initialize Supabase
const { supabase } = require('./lib/config/supabaseClient');
const { getBusinessContext } = require('./lib/businessContext');
const salesService = require('./lib/services/SalesService');
const purchaseService = require('./lib/services/PurchaseService');

function isMissingSchemaError(error) {
  const code = error?.code || '';
  const message = String(error?.message || '').toLowerCase();
  return (
    code === '42P01' ||
    code === '42703' ||
    code === 'PGRST204' ||
    message.includes('does not exist') ||
    message.includes('could not find') ||
    message.includes('schema cache')
  );
}

// Middleware
const extraOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim()).filter(Boolean)
  : [];
const allowedOrigins = new Set([
  'https://vantro-flow-frontend.vercel.app',
  'http://localhost:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001',
  ...extraOrigins,
]);

const corsOptions = {
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) {
      return callback(null, true);
    }
    // Allow all Vercel preview deployments for the vantro-flow-frontend project
    if (origin && /^https:\/\/vantro-flow-frontend[a-z0-9-]*\.vercel\.app$/.test(origin)) {
      return callback(null, true);
    }
    return callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Authorization", "Content-Type", "X-CSRF-Token", "X-Request-ID"]
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

// Raw body preservation for Razorpay webhook (must come BEFORE express.json)
app.use((req, res, next) => {
  if (req.path === '/api/payments/webhook') {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      req.rawBody = data;
      try {
        req.body = data ? JSON.parse(data) : {};
      } catch (_) {
        req.body = {};
      }
      next();
    });
  } else {
    next();
  }
});

const jsonParser = express.json({ limit: '10mb' });
app.use((req, res, next) => {
  if (req.path === '/api/payments/webhook') return next();
  return jsonParser(req, res, next);
});
app.use(express.urlencoded({ extended: true })); // Twilio webhooks send form-encoded

// ── Security headers (helmet-equivalent, no extra dependency) ─────────────────
app.use((req, res, next) => {
  // Prevent clickjacking
  res.setHeader('X-Frame-Options', 'DENY');
  // Stop MIME-type sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // XSS filter (legacy browsers)
  res.setHeader('X-XSS-Protection', '1; mode=block');
  // HTTPS only for 1 year (HSTS)
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  // Don't send Referer header cross-origin
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Restrict browser features
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  // Remove server fingerprint
  res.removeHeader('X-Powered-By');
  next();
});

function setNoStoreHeaders(res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
}

app.use('/api', (req, res, next) => {
  setNoStoreHeaders(res);
  
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    res.on('finish', () => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        const userId = req.user?.userId || req.user?.id;
        if (userId) invalidateBusinessCache(userId);
      }
    });
  }
  
  next();
});

function makeLimiter({ windowMs, max, skipSuccessfulRequests = false }) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests,
    handler: (req, res, next, options) => {
      const requestId = req.requestId || crypto.randomUUID();
      res.status(options.statusCode).json({
        success: false,
        error: 'Too many requests. Please try again later.',
        requestId
      });
    }
  });
}

// Rate limiting — layered: auth + general API + heavier abuse-prone endpoints.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true, // only count failed attempts
  handler: (req, res, next, options) => {
    const requestId = req.requestId || crypto.randomUUID();
    res.status(options.statusCode).json({
      success: false,
      error: 'Too many failed login/verification attempts. Please try again in 15 minutes.',
      requestId
    });
  }
});
const apiLimiter = makeLimiter({ windowMs: 60 * 1000, max: 120 });
const uploadLimiter = makeLimiter({ windowMs: 15 * 60 * 1000, max: 20 });
const aiLimiter = makeLimiter({ windowMs: 10 * 60 * 1000, max: 40 });
const publicBillLimiter = makeLimiter({ windowMs: 10 * 60 * 1000, max: 80 });
const heavyReadLimiter = makeLimiter({ windowMs: 5 * 60 * 1000, max: 90 });
app.use('/api/auth', authLimiter);
app.use('/api', apiLimiter);
app.use(['/api/upload-csv', '/api/import/excel', '/api/scan-document', '/api/purchases/scan', '/api/sales/scan', '/api/transactions/scan', '/api/ai/extract-voice'], uploadLimiter);
app.use(['/api/ai-chat', '/api/ml/briefing', '/api/ai/brain', '/api/ai/call-script', '/api/ai/bulk-whatsapp'], aiLimiter);
app.use('/api/bills/public', publicBillLimiter);
app.use(['/api/analytics', '/api/cash-forecast', '/api/reports/export', '/api/reconcile/backfill'], heavyReadLimiter);

// Lightweight Performance Endpoint
app.get('/api/performance/summary', requireAdmin, (req, res) => {
  res.json({
    success: true,
    status: 'healthy',
    metrics: {
      uptime_seconds: process.uptime(),
      memory_usage_mb: Math.round(process.memoryUsage().rss / 1024 / 1024)
    }
  });
});

// JWT middleware — attach user to req if token valid
const ACCESS_COOKIE_NAME = process.env.ACCESS_COOKIE_NAME || 'vantro_access_token';
const CSRF_COOKIE_NAME = process.env.CSRF_COOKIE_NAME || 'vantro_csrf';
const COOKIE_AUTH_ENABLED = process.env.ENABLE_AUTH_COOKIES === 'true';
const COOKIE_AUTH_SECURE = process.env.COOKIE_AUTH_SECURE !== 'false';

function parseCookies(req) {
  const safeDecode = (value) => {
    try { return decodeURIComponent(value); } catch { return value; }
  };
  return String(req.headers.cookie || '')
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const idx = part.indexOf('=');
      if (idx === -1) return cookies;
      const key = safeDecode(part.slice(0, idx).trim());
      const value = safeDecode(part.slice(idx + 1).trim());
      cookies[key] = value;
      return cookies;
    }, {});
}

function getAuthToken(req) {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return { token: header.slice(7), source: 'bearer' };
  const cookieToken = parseCookies(req)[ACCESS_COOKIE_NAME];
  if (COOKIE_AUTH_ENABLED && cookieToken) return { token: cookieToken, source: 'cookie' };
  return { token: null, source: null };
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${encodeURIComponent(name)}=${encodeURIComponent(value)}`];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  if (options.path) parts.push(`Path=${options.path}`);
  return parts.join('; ');
}

function appendSetCookie(res, cookie) {
  const existing = res.getHeader('Set-Cookie');
  if (!existing) return res.setHeader('Set-Cookie', cookie);
  res.setHeader('Set-Cookie', Array.isArray(existing) ? [...existing, cookie] : [existing, cookie]);
}

function sessionCookieMaxAgeSeconds() {
  const hours = Number(process.env.ACCESS_TOKEN_HOURS || 12);
  const safeHours = Number.isFinite(hours) && hours > 0 && hours <= 24 * 30 ? hours : 12;
  return Math.round(safeHours * 60 * 60);
}

function setSessionCookies(res, token) {
  if (!COOKIE_AUTH_ENABLED) return null;
  const csrf = crypto.randomBytes(24).toString('hex');
  const cookieBase = {
    path: '/',
    secure: COOKIE_AUTH_SECURE,
    sameSite: process.env.COOKIE_AUTH_SAMESITE || 'None',
    maxAge: sessionCookieMaxAgeSeconds(),
  };
  appendSetCookie(res, serializeCookie(ACCESS_COOKIE_NAME, token, { ...cookieBase, httpOnly: true }));
  appendSetCookie(res, serializeCookie(CSRF_COOKIE_NAME, csrf, { ...cookieBase, httpOnly: false }));
  return csrf;
}

function clearSessionCookies(res) {
  const cookieBase = {
    path: '/',
    secure: COOKIE_AUTH_SECURE,
    sameSite: process.env.COOKIE_AUTH_SAMESITE || 'None',
    maxAge: 0,
  };
  appendSetCookie(res, serializeCookie(ACCESS_COOKIE_NAME, '', { ...cookieBase, httpOnly: true }));
  appendSetCookie(res, serializeCookie(CSRF_COOKIE_NAME, '', { ...cookieBase, httpOnly: false }));
}

function requireCookieCsrf(req, res) {
  if (req.authSource !== 'cookie') return true;
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return true;
  const csrfCookie = parseCookies(req)[CSRF_COOKIE_NAME];
  const csrfHeader = req.headers['x-csrf-token'];
  if (csrfCookie && csrfHeader && timingSafeEqualString(csrfCookie, csrfHeader)) return true;
  res.status(403).json({ error: 'CSRF validation failed' });
  return false;
}

function authMiddleware(req, res, next) {
  const { token, source } = getAuthToken(req);
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    req.user = verifyJWT(token);
    // Phase 2C.35-P1: pre-OTP "preVerify" tokens are NOT full sessions. Reject
    // them on every protected app/API route (the OTP verify/resend endpoints
    // decode the token themselves and are unaffected).
    if (req.user && req.user.preVerify) return res.status(401).json({ error: 'Verification incomplete' });
    req.authSource = source;
    if (!requireCookieCsrf(req, res)) return;

    // --- SECURITY: Force identity fields to safe values ---
    if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
      const safeId = req.user.userId || req.user.id;
      req.body.user_id = safeId;
      req.body.userId = safeId;
      if (req.user.businessId) req.body.business_id = req.user.businessId;
      delete req.body.role;
      delete req.body.plan;
      delete req.body.subscription;
    }
    // ------------------------------------------------------
    
    setNoStoreHeaders(res);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// requireOwner — authenticates AND verifies the caller owns the :userId resource
function requireOwner(req, res, next) {
  const { token, source } = getAuthToken(req);
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    req.user = verifyJWT(token);
    req.authSource = source;
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  // Phase 2C.35-P1: pre-OTP "preVerify" tokens are NOT full sessions.
  if (req.user && req.user.preVerify) return res.status(401).json({ error: 'Verification incomplete' });
  if (!requireCookieCsrf(req, res)) return;
  const paramId = req.params.userId;
  if (paramId && req.user.userId !== paramId) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  // --- SECURITY: Force identity fields to safe values ---
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    const safeId = req.user.userId || req.user.id;
    req.body.user_id = safeId;
    req.body.userId = safeId;
    if (req.user.businessId) req.body.business_id = req.user.businessId;
    delete req.body.role;
    delete req.body.plan;
    delete req.body.subscription;
  }
  // ------------------------------------------------------

  setNoStoreHeaders(res);
  next();
}

function authenticatedUserId(req) {
  return req.user?.userId || req.user?.id || null;
}

function isAdminEmail(email) {
  const admins = (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean);
  return admins.includes(String(email || '').toLowerCase());
}

function requireAdmin(req, res, next) {
  authMiddleware(req, res, () => {
    if (!isAdminEmail(req.user?.email)) return res.status(403).json({ error: 'Forbidden' });
    next();
  });
}

function pickAllowed(source, allowed) {
  return allowed.reduce((out, key) => {
    if (source[key] !== undefined) out[key] = source[key];
    return out;
  }, {});
}

function timingSafeEqualString(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function getPublicLinkSecret() {
  return getSecret('PUBLIC_LINK_SECRET') || JWT_SECRET;
}

function signPublicBillToken(billId, expiresAtMs) {
  const payload = Buffer.from(JSON.stringify({ billId: String(billId), exp: Number(expiresAtMs) }), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', getPublicLinkSecret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifyPublicBillToken(token, billId) {
  if (!token || typeof token !== 'string') return false;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return false;
  const expected = crypto.createHmac('sha256', getPublicLinkSecret()).update(payload).digest('base64url');
  if (!timingSafeEqualString(sig, expected)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return String(data.billId) === String(billId) && Number(data.exp) > Date.now();
  } catch {
    return false;
  }
}

// Module-level pg pool — reused across all requests (avoids per-request connection churn)
let pgPool = null;
if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
  const { buildSanitizedPgConfig, estimateStartupPacket } = require('./lib/db/pgConfig');
  pgPool = new Pool(buildSanitizedPgConfig(process.env.DATABASE_URL));
  // Phase 2C.31W — sanitized runtime proof of the PG startup-packet size. Logs ONLY field
  // names, presence, and byte lengths (never any value, credential, URL, or PII) so the
  // remaining ESTARTUPPACKETTOOLARGE source can be pinpointed from deployed logs. Never blocks
  // startup; never changes connection behavior.
  try {
    const est = estimateStartupPacket(buildSanitizedPgConfig(process.env.DATABASE_URL));
    safeLog('info', '[pg] startup packet estimate', {
      totalBytes: est.totalBytes,
      limit: est.limit,
      belowLimit: est.belowLimit,
      fields: est.fields,
    });
  } catch (_) { /* diagnostic only — never block startup */ }
}
function getPool() {
  if (!pgPool) throw new Error('DATABASE_URL is not configured');
  return pgPool;
}

async function ensureTransactionsTable() {
  const pool2 = getPool();
  await pool2.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;

    CREATE TABLE IF NOT EXISTS transactions (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL,
      type VARCHAR(10) NOT NULL,
      category VARCHAR(80) NOT NULL,
      amount DECIMAL(14,2) NOT NULL,
      description TEXT,
      party_name VARCHAR(240),
      transaction_date DATE NOT NULL DEFAULT CURRENT_DATE,
      payment_method VARCHAR(50) DEFAULT 'UPI',
      reference VARCHAR(240),
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS id UUID;
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS user_id UUID;
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS type VARCHAR(10);
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS category VARCHAR(80);
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS amount DECIMAL(14,2);
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS description TEXT;
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS party_name VARCHAR(240);
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS transaction_date DATE DEFAULT CURRENT_DATE;
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS payment_method VARCHAR(50) DEFAULT 'UPI';
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS reference VARCHAR(240);
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS notes TEXT;
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
    CREATE INDEX IF NOT EXISTS idx_txn_user ON transactions(user_id);
    CREATE INDEX IF NOT EXISTS idx_txn_date ON transactions(transaction_date DESC);

    CREATE TABLE IF NOT EXISTS bank_accounts (
      id BIGSERIAL PRIMARY KEY,
      user_id UUID NOT NULL,
      bank_name TEXT NOT NULL,
      account_last4 TEXT,
      account_type TEXT DEFAULT 'current',
      nickname TEXT,
      ifsc TEXT,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_bank_accounts_user ON bank_accounts(user_id);

    CREATE TABLE IF NOT EXISTS bank_transactions (
      id BIGSERIAL PRIMARY KEY,
      user_id UUID NOT NULL,
      account_id BIGINT REFERENCES bank_accounts(id) ON DELETE SET NULL,
      txn_date DATE NOT NULL DEFAULT CURRENT_DATE,
      description TEXT,
      amount NUMERIC(14,2) NOT NULL DEFAULT 0,
      type TEXT NOT NULL CHECK (type IN ('credit','debit')),
      status TEXT NOT NULL DEFAULT 'unmatched',
      matched_type TEXT,
      matched_id TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_bank_transactions_user ON bank_transactions(user_id);
    CREATE INDEX IF NOT EXISTS idx_bank_transactions_date ON bank_transactions(user_id, txn_date DESC);
    CREATE INDEX IF NOT EXISTS idx_bank_transactions_status ON bank_transactions(user_id, status);
  `);
}

function ledgerTypeToBankType(type) {
  return type === 'in' ? 'credit' : 'debit';
}

function bankTypeToLedgerType(type) {
  return type === 'credit' ? 'in' : 'out';
}

function composeLedgerDescription({ party_name, description, reference, category }) {
  return [party_name, reference, description || category].filter(Boolean).join(' · ');
}

function mapBankTransactionToLedger(row) {
  const ledgerType = bankTypeToLedgerType(row.type);
  const parts = String(row.description || '').split(' · ').map(part => part.trim()).filter(Boolean);
  const reference = parts.find(part => /^(Receipt|Payment)\s+#/i.test(part)) || '';
  const partyName = parts[0] && parts[0] !== reference ? parts[0] : '';

  return {
    id: String(row.id),
    user_id: row.user_id,
    type: ledgerType,
    category: ledgerType === 'in' ? 'Customer Payment' : 'Supplier Payment',
    amount: Number(row.amount || 0),
    party_name: partyName,
    description: parts.filter(part => part !== partyName && part !== reference).join(' · ') || row.description || '',
    transaction_date: row.txn_date || row.transaction_date || row.created_at,
    payment_method: 'Bank Transfer',
    reference,
    created_at: row.created_at,
  };
}

function buildLedgerSummary(transactions) {
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  return transactions.reduce((summary, txn) => {
    const amount = Number(txn.amount || 0);
    if (txn.type === 'in') summary.totalIn += amount;
    if (txn.type === 'out') summary.totalOut += amount;
    if (String(txn.transaction_date || '').startsWith(currentMonth)) {
      if (txn.type === 'in') summary.monthIn += amount;
      if (txn.type === 'out') summary.monthOut += amount;
    }
    summary.balance = summary.totalIn - summary.totalOut;
    summary.monthBalance = summary.monthIn - summary.monthOut;
    return summary;
  }, { totalIn: 0, totalOut: 0, balance: 0, monthIn: 0, monthOut: 0, monthBalance: 0 });
}

// ── Cortex test/seed data guard ───────────────────────────────────────────────
// cortex-lab/seed.js creates synthetic rows tagged "[cortex-test <runId>]" with
// the default name "Cortex Test Customer" (and "Cortex Chain" variants). These
// are real rows in the DB used for pipeline testing. This guard HIDES them from
// every tenant-facing API response so production demos never show fake debtors,
// fake receivables, or fake forecast inputs. It NEVER deletes data — the rows
// remain in the database and can be cleaned up separately by run-ID marker.
const CORTEX_TEST_PATTERN = /\[cortex-test|cortex[\s_-]*test|cortex[\s_-]*chain/i;
function isCortexTestRow(row) {
  if (!row || typeof row !== 'object') return false;
  const fields = [row.customer_name, row.party_name, row.supplier_name, row.name, row.notes, row.description];
  return fields.some((v) => typeof v === 'string' && CORTEX_TEST_PATTERN.test(v));
}
function stripCortexTestRows(rows) {
  return Array.isArray(rows) ? rows.filter((row) => !isCortexTestRow(row)) : rows;
}

// Razorpay instance (initialised lazily so missing keys don't crash startup)
let razorpay = null;
if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
  razorpay = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
}

const ALLOWED_UPLOAD_EXTENSIONS = new Set(['.csv', '.xls', '.xlsx']);
const ALLOWED_UPLOAD_MIME_TYPES = new Set([
  'text/csv',
  'text/plain',
  'application/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/octet-stream',
]);

function isAllowedUpload(file) {
  const ext = path.extname(file.originalname || '').toLowerCase();
  const mime = String(file.mimetype || '').toLowerCase();
  return ALLOWED_UPLOAD_EXTENSIONS.has(ext) && ALLOWED_UPLOAD_MIME_TYPES.has(mime);
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (!isAllowedUpload(file)) {
      const err = new Error('Unsupported file type');
      err.code = 'UNSUPPORTED_FILE_TYPE';
      return cb(err);
    }
    cb(null, true);
  },
});

// Web Push — VAPID
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    `mailto:${process.env.VAPID_EMAIL || 'hello@vantroflow.com'}`,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

// ============================================
// WHATSAPP DELIVERY HELPER
// Priority order:
//   1. Per-user Interakt key (legacy BYOK)
//   2. Per-user WATI creds  (legacy BYOK)
//   3. Vantro's Interakt env key (managed)
//   4. Vantro's WATI env creds  (managed)
//   5. Vantro's Twilio WhatsApp  (managed fallback)
//   6. Console mock             (dev only)
// ============================================
// creds: optional per-user { interakt_api_key, wati_api_url, wati_token }
// Falls back to Vantro env vars → Twilio → mock
async function sendWhatsAppMessage(phone, message, creds = {}, opts = {}) {
  const digits = String(phone || '').replace(/\D/g, '').replace(/^91/, '');
  if (!digits || digits.length < 10) {
    console.log('[WA] No valid phone (message body suppressed from logs)');
    return { success: false, reason: 'no_phone' };
  }
  // Phase 2C.35-P1: global fail-closed external-send kill switch at the lowest
  // boundary. Customer/collections sends are blocked unless
  // FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED === 'true'. Owner-auth OTP delivery
  // passes { transactional:true } and is exempt (required for login).
  const _sendBlock = guardExternalSend('whatsapp', { transactional: opts.transactional === true });
  if (_sendBlock) {
    console.log('[WA BLOCKED] external sending disabled (flag off) — not sent');
    return _sendBlock;
  }
  const interaktKey = creds.interakt_api_key || process.env.INTERAKT_API_KEY;
  const watiUrl     = creds.wati_api_url     || process.env.WATI_API_URL;
  const watiToken   = creds.wati_token       || process.env.WATI_TOKEN;
  try {
    if (interaktKey) {
      const b64 = Buffer.from(interaktKey + ':').toString('base64');
      const res = await fetch('https://api.interakt.ai/v1/public/message/', {
        method: 'POST',
        headers: { 'Authorization': `Basic ${b64}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ countryCode: '91', phoneNumber: digits, callbackData: 'vantro-auto', type: 'Text', data: { message } }),
      });
      const data = await res.json();
      console.log(`[WA Interakt] ${maskPhone(digits)}: ${data.result ? 'sent' : 'failed'}`);
      return { success: !!data.result, provider: 'interakt', data };
    }
    if (watiUrl && watiToken) {
      const res = await fetch(`${watiUrl}/api/v1/sendSessionMessage/${digits}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${watiToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageText: message }),
      });
      const data = await res.json();
      console.log(`[WA Wati] ${maskPhone(digits)}: ${data.result ? 'sent' : 'failed'}`);
      return { success: !!data.result, provider: 'wati', data };
    }
    // Vantro's Twilio WhatsApp — managed fallback for ALL users
    const twilioWaFrom = process.env.TWILIO_WHATSAPP_NUMBER; // e.g. whatsapp:+14155238886
    if (twilioWaFrom) {
      const twilioClient = getTwilio();
      if (twilioClient) {
        try {
          await twilioClient.messages.create({
            from: twilioWaFrom.startsWith('whatsapp:') ? twilioWaFrom : `whatsapp:${twilioWaFrom}`,
            to: `whatsapp:+91${digits}`,
            body: message,
          });
          console.log(`[WA Twilio] ${maskPhone(digits)}: sent`);
          return { success: true, provider: 'twilio_whatsapp' };
        } catch (twilioErr) {
          console.warn('[WA Twilio] Send failed, falling to mock:', twilioErr.message);
        }
      }
    }
    // Dev mode fallback — never log the phone or message body (PII/OTP/payment links).
    console.log(`[WA MOCK] queued (no provider configured) — len=${String(message || '').length}`);
    return { success: true, provider: 'mock' };
  } catch (err) {
    console.error('[WA] Send error:', err.message);
    return { success: false, error: err.message };
  }
}


// ── Email OTP helper (uses Resend if RESEND_API_KEY is set) ──────────────────
async function sendOTPEmail(email, name, otp) {
  const displayName = name || 'there';
  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;font-family:Arial,sans-serif;background:#0a0a0f;">
  <table width="100%" cellpadding="0" cellspacing="0">
    <tr><td align="center" style="padding:40px 20px;">
      <table width="480" cellpadding="0" cellspacing="0" style="background:#141419;border-radius:16px;border:1px solid #2a2a35;overflow:hidden;">
        <tr>
          <td style="background:linear-gradient(135deg,#0066ff,#00c853);padding:24px 32px;">
            <p style="margin:0;color:#ffffff;font-size:22px;font-weight:700;letter-spacing:-0.5px;">⚡ Vantro Flow</p>
            <p style="margin:4px 0 0;color:rgba(255,255,255,0.75);font-size:13px;">Collections OS for Indian MSMEs</p>
          </td>
        </tr>
        <tr>
          <td style="padding:32px;">
            <p style="margin:0 0 8px;color:#e0e0e8;font-size:16px;">Hi ${displayName},</p>
            <p style="margin:0 0 24px;color:#9090a0;font-size:14px;line-height:1.6;">
              Use this OTP to verify your Vantro Flow account. It expires in <strong style="color:#e0e0e8;">10 minutes</strong>.
            </p>
            <div style="background:#0d1117;border:2px solid #0066ff;border-radius:12px;padding:24px;text-align:center;margin:0 0 24px;">
              <p style="margin:0 0 6px;color:#6060a0;font-size:12px;letter-spacing:2px;text-transform:uppercase;">Your OTP</p>
              <p style="margin:0;color:#ffffff;font-size:40px;font-weight:900;letter-spacing:12px;font-family:monospace;">${otp}</p>
            </div>
            <p style="margin:0 0 8px;color:#6060a0;font-size:12px;line-height:1.6;">
              🔒 Never share this code with anyone. Vantro will never ask for your OTP over call or chat.
            </p>
            <p style="margin:0;color:#6060a0;font-size:12px;">
              If you didn't sign up for Vantro Flow, ignore this email.
            </p>
          </td>
        </tr>
        <tr>
          <td style="padding:16px 32px;border-top:1px solid #2a2a35;">
            <p style="margin:0;color:#404050;font-size:11px;text-align:center;">
              © 2025 Vantro Flow · Pune, India
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (RESEND_API_KEY) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
      body: JSON.stringify({
        from: 'Vantro Flow <onboarding@resend.dev>',
        to: email,
        subject: `${otp} is your Vantro Flow OTP`,
        html,
      }),
    });
    const data = await res.json().catch(() => ({}));
    console.log(`[EMAIL OTP] Resend delivery: ${data.id ? 'sent' : 'failed'}`);
  } else {
    // Email delivery not configured. NEVER log the OTP value or the recipient.
    console.log('[EMAIL OTP] delivery not configured (RESEND_API_KEY unset) — OTP not emailed');
  }
}

// ============================================
// AUTHENTICATION ENDPOINTS
// ============================================

app.post('/api/auth/signup', async (req, res) => {
  try {
    const { email, phone, business_name, password, referred_by } = req.body;
    if (!email || !phone || !business_name || !password) {
      return res.status(400).json({ error: 'All fields are required' });
    }
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    const { data: existing } = await supabase.from('users').select('id').eq('email', email).maybeSingle();
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const password_hash = await bcrypt.hash(password, 12);
    const insertPayload = { email, phone, business_name, password_hash, plan: 'free', created_at: new Date() };

    // Decode referral code (VFxxxxxxxx or CAxxxxxxxx) → actual referrer userId
    if (referred_by) {
      try {
        const codePrefix = referred_by.substring(0, 2).toUpperCase(); // 'VF' or 'CA'
        const codeBody   = referred_by.substring(2).toUpperCase();    // first 8 chars of UUID (no dashes)
        // Find user whose UUID (stripped of dashes) starts with that 8-char prefix
        // UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx; first group = first 8 hex chars
        const { data: referrerRows } = await supabase.from('users').select('id').ilike('id', codeBody + '-%');
        if (referrerRows?.length) {
          insertPayload.referred_by = referrerRows[0].id; // store actual UUID
        } else {
          // Fallback: store the raw code in case it's already a userId
          insertPayload.referred_by = referred_by;
        }
      } catch (_) {
        insertPayload.referred_by = referred_by;
      }
    }

    // Only insert columns that definitely exist in the schema
    // phone_verified / email_verified are optional columns — added via migration
    const safePayload = {
      email:         insertPayload.email,
      phone:         insertPayload.phone,
      business_name: insertPayload.business_name,
      password_hash: insertPayload.password_hash,
      plan:          insertPayload.plan,
      created_at:    insertPayload.created_at,
    };
    if (insertPayload.referred_by) safePayload.referred_by = insertPayload.referred_by;

    const { data, error } = await supabase
      .from('users')
      .insert([safePayload])
      .select('id, email, phone, business_name, plan, created_at');
    if (error) {
      console.error('[signup] Supabase insert error:', error);
      throw error;
    }

    const user = data[0];

    // Generate and send OTP
    const otp = storeOTP(user.id);
    const otpMsg = `Vantro Flow verification code: *${otp}*\n\nYe code 10 minute mein expire ho jaayega. Kisi ke saath share mat karein.`;

    // WhatsApp OTP — transactional owner-auth delivery (exempt from external-send kill switch)
    if (user.phone) {
      sendWhatsAppMessage(user.phone, otpMsg, {}, { transactional: true }).catch(e => console.error('[OTP WA]', e.message));
    }

    // Email OTP — send via Resend if configured
    sendOTPEmail(user.email, user.business_name, otp).catch(e => console.error('[OTP EMAIL]', e.message));

    // Return a short-lived pre-verification token (5 min), NOT the real 7d session token
    const preToken = jwt.sign({ userId: user.id, email: user.email, preVerify: true }, JWT_SECRET, { expiresIn: '10m' });
    res.json({ success: true, needs_otp: true, pre_token: preToken, user: { id: user.id, email: user.email, phone: user.phone, business_name: user.business_name } });
  } catch (error) {
    console.error('[signup] Error:', error);
    // Return a safe but informative message
    const msg = error?.message || 'Internal server error';
    const isDbError = msg.includes('column') || msg.includes('relation') || msg.includes('violates');
    res.status(500).json({ error: isDbError ? 'Database error — please contact support' : 'Internal server error' });
  }
});

// ── Resend OTP ────────────────────────────────────────────────────────────────
app.post('/api/auth/resend-otp', async (req, res) => {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing token' });
    const decoded = verifyJWT(header.slice(7));
    if (!decoded.preVerify) return res.status(400).json({ error: 'Invalid pre-verification token' });

    const { data: user } = await supabase.from('users').select('id, email, phone, business_name').eq('id', decoded.userId).single();
    if (!user) return res.status(404).json({ error: 'User not found' });

    const otp = storeOTP(user.id);
    const otpMsg = `Vantro Flow verification code: *${otp}*\n\nYe code 10 minute mein expire ho jaayega. Kisi ke saath share mat karein.`;

    if (user.phone) sendWhatsAppMessage(user.phone, otpMsg, {}, { transactional: true }).catch(() => {});
    sendOTPEmail(user.email, user.business_name, otp).catch(() => {});

    res.json({ success: true, message: 'OTP sent to your phone and email' });
  } catch (err) {
    res.status(400).json({ error: 'Invalid or expired token. Please sign up again.' });
  }
});

// ── Verify OTP → issue real session token ────────────────────────────────────
app.post('/api/auth/verify-otp', async (req, res) => {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing token' });
    const decoded = verifyJWT(header.slice(7));
    if (!decoded.preVerify) return res.status(400).json({ error: 'Invalid pre-verification token' });

    const { otp } = req.body;
    if (!otp) return res.status(400).json({ error: 'OTP required' });

    const result = verifyOTP(decoded.userId, String(otp).trim());
    if (!result.valid) return res.status(400).json({ error: result.reason });

    // Mark verified in DB (columns added gracefully — silently ignored if columns don't exist yet)
    await supabase.from('users').update({ phone_verified: true, email_verified: true }).eq('id', decoded.userId).catch(() => {});

    // Issue real 7-day session token
    const { data: user } = await supabase.from('users').select('id, email, phone, business_name, plan, created_at').eq('id', decoded.userId).single();
    const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
    const csrf_token = setSessionCookies(res, token);

    res.json({ success: true, token, csrf_token, user });
  } catch (err) {
    res.status(400).json({ error: 'Invalid or expired token. Please sign up again.' });
  }
});

// Referral count (public — used on /my-id page)
app.get('/api/public/referrals/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { count } = await supabase
      .from('users')
      .select('*', { count: 'exact', head: true })
      .eq('referred_by', userId);
    res.json({ success: true, referral_count: count || 0 });
  } catch (error) {
    res.json({ success: true, referral_count: 0 });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const { data, error } = await supabase
      .from('users')
      .select('id, email, phone, business_name, plan, password_hash, created_at')
      .eq('email', email)
      .maybeSingle();

    if (error || !data) return res.status(401).json({ error: 'Invalid email or password' });

    const valid = await bcrypt.compare(password, data.password_hash || '');
    if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

    const { password_hash, ...user } = data;
    const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
    const csrf_token = setSessionCookies(res, token);
    res.json({ success: true, token, csrf_token, user });
  } catch (error) {
    console.error('[login]', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  clearSessionCookies(res);
  res.json({ success: true });
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const tokenUserId = req.user?.userId || req.user?.id || null;
    if (!tokenUserId) {
      return res.status(401).json({ error: 'Invalid token payload' });
    }

    const fullColumns = 'id, email, phone, business_name, plan, gstin, created_at, industry, business_size, gst_registered, has_workers, owner_name, city, onboarding_done';
    const coreColumns = 'id, email, phone, business_name, plan, created_at';

    let { data, error } = await supabase
      .from('users')
      .select(fullColumns)
      .eq('id', tokenUserId)
      .maybeSingle();

    if (error && isMissingSchemaError(error)) {
      console.warn('[auth me] optional columns unavailable, falling back to core columns:', error.message);
      ({ data, error } = await supabase
        .from('users')
        .select(coreColumns)
        .eq('id', tokenUserId)
        .maybeSingle());
    }

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'User not found' });

    // Auto-reconcile and connect business data
    await ensureConnectedBusinessData(tokenUserId);

    const user = {
      ...data,
      id: data.id,
      userId: data.id,
      name: data.owner_name || data.business_name || data.email || 'User',
      businessId: data.id,
    };

    // Warm cache in the background (non-blocking)
    warmBusinessCache(tokenUserId);

    res.json({ success: true, user });
  } catch (error) {
    console.error('[auth me]', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// FORGOT PASSWORD
// ============================================

app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const { data: user } = await supabase.from('users').select('id, email, business_name').eq('email', email).maybeSingle();
    // Always respond success to prevent email enumeration
    if (!user) return res.json({ success: true, message: 'If that email exists, an OTP has been sent.' });

    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const expires_at = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    // Invalidate previous tokens for this email
    await supabase.from('password_reset_tokens').update({ used: true }).eq('email', email).eq('used', false);
    await supabase.from('password_reset_tokens').insert([{ email, otp, expires_at }]);

    // Send via Resend if configured, else log to console (dev mode)
    const RESEND_API_KEY = process.env.RESEND_API_KEY;
    if (RESEND_API_KEY) {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
        body: JSON.stringify({
          from: 'Vantro Flow <onboarding@resend.dev>',
          to: email,
          subject: `Your Vantro OTP: ${otp}`,
          html: `<p>Hi ${user.business_name},</p><p>Your OTP to reset your Vantro Flow password is: <strong style="font-size:24px">${otp}</strong></p><p>Valid for 15 minutes. Do not share this with anyone.</p>`
        })
      });
    } else {
      // OTP intentionally NOT logged — never put secrets in logs
    }

    res.json({ success: true, message: 'If that email exists, an OTP has been sent.' });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { email, otp, new_password } = req.body;
    if (!email || !otp || !new_password) return res.status(400).json({ error: 'Email, OTP, and new password required' });
    if (new_password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const { data: token } = await supabase
      .from('password_reset_tokens')
      .select('*')
      .eq('email', email)
      .eq('otp', otp)
      .eq('used', false)
      .gte('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!token) return res.status(400).json({ error: 'Invalid or expired OTP' });

    const password_hash = await bcrypt.hash(new_password, 12);
    await Promise.all([
      supabase.from('users').update({ password_hash }).eq('email', email),
      supabase.from('password_reset_tokens').update({ used: true }).eq('id', token.id)
    ]);

    res.json({ success: true, message: 'Password reset successfully. Please log in.' });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// CSV UPLOAD & INVOICE PROCESSING
// ============================================

/**
 * Parse a single CSV row, handling quoted fields with commas inside them.
 * e.g.: "Sharma, Traders",50000,2024-01-01,Pending
 */
function parseCSVRow(row) {
  const fields = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < row.length; i++) {
    const char = row[i];
    if (char === '"') {
      // Handle escaped quotes ("")
      if (inQuotes && row[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      fields.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current.trim());
  return fields;
}

app.post('/api/upload-csv', authMiddleware, upload.single('file'), async (req, res) => {
  try {
    const userId = req.user.userId;

    if (!userId || !req.file) {
      return res.status(400).json({ error: 'Missing file' });
    }

    const invoices = [];
    const csvContent = req.file.buffer.toString('utf-8');
    const rows = csvContent.split('\n').slice(1, 5001); // Skip header and cap import size

    for (const row of rows) {
      if (!row.trim()) continue;

      const fields = parseCSVRow(row);
      const [customer_name, invoice_amount, invoice_date, payment_status] = fields;

      if (!customer_name || !invoice_amount || !invoice_date) continue;

      const parsedAmount = parseFloat(invoice_amount);
      const parsedDate = new Date(invoice_date);

      if (isNaN(parsedAmount) || isNaN(parsedDate.getTime())) continue;

      const daysOverdue = Math.floor(
        (Date.now() - parsedDate.getTime()) / (1000 * 60 * 60 * 24)
      );

      invoices.push({
        user_id: userId,
        customer_name,
        invoice_amount: parsedAmount,
        invoice_date,
        payment_status: payment_status || 'Pending',
        days_overdue: daysOverdue,
        created_at: new Date()
      });
    }

    if (invoices.length === 0) {
      return res.status(400).json({ error: 'No valid invoices in CSV' });
    }

    const { data, error } = await supabase
      .from('invoices')
      .insert(invoices)
      .select();

    if (error) throw error;

    res.json({ success: true, count: invoices.length, invoices: data });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// CREATE SINGLE INVOICE (manual add)
// ============================================

// ── Create a single invoice (from UI) ────────────────────────────────────────
app.post('/api/invoices/create', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const {
      customer_name, customer_phone, customer_email,
      invoice_date, due_date,
      items,          // array: [{ name, qty, unit, rate }]
      invoice_amount, // fallback if no items
      notes,
    } = req.body;

    if (!customer_name) return res.status(400).json({ error: 'customer_name is required' });

    // Calculate total from items or fallback to invoice_amount
    let total = 0;
    let processedItems = null;
    if (Array.isArray(items) && items.length > 0) {
      processedItems = items.map(it => ({
        name: String(it.name || '').trim(),
        qty:  parseFloat(it.qty)  || 1,
        unit: String(it.unit || 'unit').trim(),
        rate: parseFloat(it.rate) || 0,
        amount: Math.round((parseFloat(it.qty) || 1) * (parseFloat(it.rate) || 0) * 100) / 100,
      })).filter(it => it.name && it.rate > 0);
      total = processedItems.reduce((s, it) => s + it.amount, 0);
    } else if (invoice_amount) {
      total = parseFloat(invoice_amount);
    }
    if (!total || total <= 0) return res.status(400).json({ error: 'invoice_amount or at least one line item with rate is required' });

    const invDate = invoice_date ? new Date(invoice_date) : new Date();
    const daysOverdue = Math.max(0, Math.floor((Date.now() - invDate.getTime()) / 86400000));

    // Auto-generate invoice number: PREFIX-YYYYMM-XXXX
    const { data: owner } = await supabase
      .from('users')
      .select('business_name, invoice_prefix, automation_enabled, interakt_api_key, wati_api_url, wati_token, upi_id')
      .eq('id', userId).single();

    const prefix = (owner?.invoice_prefix || (owner?.business_name || 'INV').replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 4)).toUpperCase();
    const ym = new Date().toISOString().slice(0, 7).replace('-', '');

    // Count existing invoices this month to get sequence
    const { count } = await supabase
      .from('invoices')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .ilike('invoice_number', `${prefix}-${ym}-%`);
    const seq = String((count || 0) + 1).padStart(4, '0');
    const invoiceNumber = `${prefix}-${ym}-${seq}`;

    const record = {
      user_id:        userId,
      customer_name:  customer_name.trim(),
      customer_phone: customer_phone ? String(customer_phone).replace(/\D/g, '').slice(-10) : null,
      customer_email: customer_email || null,
      invoice_amount: Math.round(total * 100) / 100,
      invoice_date:   invDate.toISOString().split('T')[0],
      due_date:       due_date || null,
      invoice_number: invoiceNumber,
      items:          processedItems ? JSON.stringify(processedItems) : null,
      notes:          notes || null,
      payment_status: 'Pending',
      days_overdue:   daysOverdue,
      created_at:     new Date(),
    };

    const { data, error } = await supabase.from('invoices').insert([record]).select().single();
    if (error) {
      console.error('[invoices/create] DB error:', error);
      throw error;
    }

    // Respond immediately
    res.json({ success: true, invoice: data, invoice_number: invoiceNumber });

    // Day-0 WhatsApp trigger (fire-and-forget, only if automation on + phone present)
    if (owner?.automation_enabled && data.customer_phone) {
      (async () => {
        try {
          const waCreds = { interakt_api_key: owner.interakt_api_key, wati_api_url: owner.wati_api_url, wati_token: owner.wati_token };
          const bizName = owner.business_name || 'Vantro';
          let payLink = null;
          let payLinkId = null;

          if (razorpay) {
            try {
              const pl = await razorpay.paymentLink.create({
                amount: Math.round(total * 100),
                currency: 'INR',
                description: `Invoice ${invoiceNumber} — ${customer_name}`,
                customer: { name: customer_name },
                notify: { sms: false, email: false },
                reminder_enable: false,
                notes: { invoice_id: data.id, invoice_number: invoiceNumber },
                callback_url: `${process.env.FRONTEND_URL || 'https://vantro-flow.vercel.app'}/collections`,
                callback_method: 'get',
              });
              payLink = pl.short_url;
              payLinkId = pl.id;
            } catch (e) { console.error('[create/day0] Razorpay:', e.message); }
          }
          if (!payLink && owner.upi_id) {
            payLink = `upi://pay?pa=${owner.upi_id}&pn=${encodeURIComponent(bizName)}&am=${total}&tn=${encodeURIComponent(invoiceNumber)}&cu=INR`;
          }

          const firstName = customer_name.split(' ')[0];
          const amtFmt = Number(total).toLocaleString('en-IN');
          const msg = payLink
            ? `${firstName} ji 🙏\n\n${bizName} ne aapko *${invoiceNumber}* ke liye ₹${amtFmt} ka invoice raise kiya hai.\n\nOnline pay karein:\n${payLink}\n\nUPI, Card, NetBanking — sab accept hota hai.\n\n— ${bizName}`
            : `${firstName} ji 🙏\n\n${bizName} ne aapko *${invoiceNumber}* ke liye ₹${amtFmt} ka invoice raise kiya hai. Kripya jaldi settle karein.\n\n— ${bizName}`;

          await sendWhatsAppMessage(data.customer_phone, msg, waCreds);
          await supabase.from('invoices').update({
            payment_link: payLink || null,
            payment_link_id: payLinkId || null,
            last_reminder_sent: new Date().toISOString(),
            reminder_count: 1,
          }).eq('id', data.id);
        } catch (bgErr) { console.error('[create/day0]', bgErr.message); }
      })();
    }
  } catch (err) {
    console.error('[invoices/create]', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

// ── Get single invoice by ID (authenticated, owner check) ────────────────────
app.get('/api/invoice/:invoiceId', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { invoiceId } = req.params;

    const { data, error } = await supabase
      .from('invoices')
      .select('*')
      .eq('id', invoiceId)
      .eq('user_id', userId)
      .single();

    if (error || !data) return res.status(404).json({ error: 'Invoice not found' });

    // Parse items if stored as string
    if (data.items && typeof data.items === 'string') {
      try { data.items = JSON.parse(data.items); } catch { data.items = []; }
    }

    // Fetch owner profile (business name, address, gstin, upi_id)
    const { data: owner } = await supabase
      .from('users')
      .select('business_name, gstin, business_address, city, upi_id, invoice_prefix')
      .eq('id', userId).single();

    res.json({ success: true, invoice: data, business: owner || {} });
  } catch (err) {
    console.error('[invoice/get]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// EXCEL / XLSX SMART IMPORT
// ============================================

app.post('/api/import/excel', authMiddleware, upload.single('file'), async (req, res) => {
  try {
    const userId = req.user.userId;
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const ext = (req.file.originalname || '').toLowerCase();
    let rows = [];

    if (ext.endsWith('.xlsx') || ext.endsWith('.xls') || req.file.mimetype.includes('spreadsheet') || req.file.mimetype.includes('excel')) {
      // Parse Excel
      try {
        const XLSX = require('xlsx');
        const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true, sheetRows: 5001 });
        const ws = wb.Sheets[wb.SheetNames[0]];
        rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
      } catch (e) {
        return res.status(400).json({ error: 'Could not parse Excel file. Please use .xlsx format.' });
      }
    } else {
      // Parse CSV
      const text = req.file.buffer.toString('utf-8');
      const lines = text.split('\n').filter(l => l.trim());
      if (lines.length < 2) return res.status(400).json({ error: 'CSV must have a header row and at least one data row' });
      const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, '').toLowerCase());
      rows = lines.slice(1).map(line => {
        const vals = line.split(',').map(v => v.trim().replace(/"/g, ''));
        const obj = {};
        headers.forEach((h, i) => { obj[h] = vals[i] || ''; });
        return obj;
      });
    }
    if (rows.length > 5000) return res.status(400).json({ error: 'File has too many rows. Please import 5000 rows or fewer.' });

    // Smart column detection — try many possible header names
    const findCol = (obj, candidates) => {
      const keys = Object.keys(obj).map(k => k.toLowerCase().trim());
      for (const c of candidates) {
        const match = keys.find(k => k.includes(c));
        if (match) return obj[Object.keys(obj).find(k => k.toLowerCase().trim() === match)];
      }
      return null;
    };

    const invoices = [];
    const skipped = [];

    for (const row of rows) {
      const name = findCol(row, ['customer', 'party', 'client', 'debtor', 'buyer', 'name', 'company']);
      const amountRaw = findCol(row, ['amount', 'outstanding', 'due', 'balance', 'pending', 'invoice_amount', 'receivable']);
      const dateRaw = findCol(row, ['date', 'invoice_date', 'bill_date', 'due_date', 'created']);
      const phone = findCol(row, ['phone', 'mobile', 'contact', 'number', 'whatsapp']);
      const statusRaw = findCol(row, ['status', 'payment_status', 'paid', 'cleared']);

      if (!name || !amountRaw) { skipped.push(row); continue; }

      const amount = parseFloat(String(amountRaw).replace(/[₹,\s]/g, ''));
      if (isNaN(amount) || amount <= 0) { skipped.push(row); continue; }

      // Date parsing — handle DD/MM/YYYY, MM/DD/YYYY, YYYY-MM-DD, serial numbers
      let invoiceDate = new Date();
      if (dateRaw) {
        if (dateRaw instanceof Date) {
          invoiceDate = dateRaw;
        } else if (typeof dateRaw === 'number') {
          // Excel serial date
          invoiceDate = new Date(Math.round((dateRaw - 25569) * 86400 * 1000));
        } else {
          const str = String(dateRaw).trim();
          // Try DD/MM/YYYY
          const ddmm = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
          if (ddmm) invoiceDate = new Date(`${ddmm[3]}-${ddmm[2].padStart(2,'0')}-${ddmm[1].padStart(2,'0')}`);
          else invoiceDate = new Date(str);
          if (isNaN(invoiceDate.getTime())) invoiceDate = new Date();
        }
      }

      const daysOverdue = Math.max(0, Math.floor((Date.now() - invoiceDate.getTime()) / 86400000));
      const statusLower = String(statusRaw || '').toLowerCase();
      const paymentStatus = statusLower.includes('paid') || statusLower.includes('clear') ? 'Paid' : 'Pending';

      invoices.push({
        user_id: userId,
        customer_name: String(name).trim(),
        customer_phone: phone ? String(phone).replace(/\D/g, '').slice(-10) : null,
        invoice_amount: amount,
        invoice_date: invoiceDate.toISOString().split('T')[0],
        payment_status: paymentStatus,
        days_overdue: paymentStatus === 'Paid' ? 0 : daysOverdue,
        created_at: new Date(),
      });
    }

    if (invoices.length === 0) {
      return res.status(400).json({
        error: 'No valid rows found. Make sure your file has columns: Customer Name, Amount, Date.',
        skipped: skipped.length,
        hint: 'Column names can be: customer_name, party, amount, outstanding, invoice_date, date, phone, mobile',
      });
    }

    const { data, error } = await supabase.from('invoices').insert(invoices).select('id');
    if (error) throw error;

    res.json({
      success: true,
      imported: invoices.length,
      skipped: skipped.length,
      message: `✅ ${invoices.length} invoices imported${skipped.length ? `, ${skipped.length} rows skipped (missing name/amount)` : ''}`,
    });
  } catch (err) {
    console.error('Import error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Quick manual add — add a single customer/invoice
app.post('/api/import/manual', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const entries = req.body.entries; // array of { customer_name, invoice_amount, days_overdue, customer_phone }
    if (!Array.isArray(entries) || entries.length === 0) return res.status(400).json({ error: 'entries array required' });

    const invoices = entries.map(e => {
      const daysOverdue = parseInt(e.days_overdue) || 0;
      const invoiceDate = new Date(Date.now() - daysOverdue * 86400000);
      return {
        user_id: userId,
        customer_name: e.customer_name,
        customer_phone: e.customer_phone || null,
        invoice_amount: parseFloat(e.invoice_amount),
        invoice_date: invoiceDate.toISOString().split('T')[0],
        payment_status: 'Pending',
        days_overdue: daysOverdue,
        created_at: new Date(),
      };
    }).filter(i => i.customer_name && i.invoice_amount > 0);

    if (invoices.length === 0) return res.status(400).json({ error: 'No valid entries' });
    const { data, error } = await supabase.from('invoices').insert(invoices).select();
    if (error) throw error;

    // Respond immediately — Day-0 WA fires in background
    res.json({ success: true, imported: invoices.length, invoices: data });

    // ── Day-0 WhatsApp trigger (fire-and-forget) ──────────────────
    (async () => {
      try {
        // Load owner settings once
        const { data: owner } = await supabase
          .from('users')
          .select('business_name, upi_id, automation_enabled, interakt_api_key, wati_api_url, wati_token')
          .eq('id', userId)
          .single();

        if (!owner?.automation_enabled) return; // automation off — skip

        const bizName = owner.business_name || 'Vantro';
        const waCreds = {
          interakt_api_key: owner.interakt_api_key,
          wati_api_url:     owner.wati_api_url,
          wati_token:       owner.wati_token,
        };

        for (const inv of data) {
          if (!inv.customer_phone || inv.payment_status !== 'Pending') continue;

          // Create Razorpay payment link if available
          let payLink = null;
          let payLinkId = null;
          if (razorpay) {
            try {
              const pl = await razorpay.paymentLink.create({
                amount: Math.round(parseFloat(inv.invoice_amount) * 100),
                currency: 'INR',
                description: `Invoice — ${inv.customer_name}`,
                customer: { name: inv.customer_name },
                notify: { sms: false, email: false },
                reminder_enable: false,
                notes: { invoice_id: inv.id, customer_name: inv.customer_name },
                callback_url: `${process.env.FRONTEND_URL || 'https://vantro-flow.vercel.app'}/collections`,
                callback_method: 'get',
              });
              payLink = pl.short_url;
              payLinkId = pl.id;
            } catch (e) {
              console.error('[day0] Razorpay link error:', e.message);
            }
          }
          // UPI fallback
          if (!payLink && owner.upi_id) {
            payLink = `upi://pay?pa=${owner.upi_id}&pn=${encodeURIComponent(bizName)}&am=${inv.invoice_amount}&tn=${encodeURIComponent('Invoice Payment')}&cu=INR`;
          }

          // Build intro message
          const firstName = (inv.customer_name || '').split(' ')[0];
          const amtFmt = Number(inv.invoice_amount).toLocaleString('en-IN');
          const msg = payLink
            ? `${firstName} ji 🙏\n\n${bizName} ne aapko ₹${amtFmt} ka invoice raise kiya hai.\n\nOnline pay karein:\n${payLink}\n\nUPI, Card, NetBanking — sab accept hota hai.\n\n— ${bizName}`
            : `${firstName} ji 🙏\n\n${bizName} ne aapko ₹${amtFmt} ka invoice raise kiya hai. Kripya jaldi settle karein.\n\n— ${bizName}`;

          // Send WhatsApp
          await sendWhatsAppMessage(inv.customer_phone, msg, waCreds);

          // Persist payment link + mark first reminder sent
          await supabase.from('invoices').update({
            payment_link:       payLink   || null,
            payment_link_id:    payLinkId || null,
            last_reminder_sent: new Date().toISOString(),
            reminder_count:     1,
          }).eq('id', inv.id);
        }
      } catch (bgErr) {
        console.error('[day0] Background WA error:', bgErr.message);
      }
    })();
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// DASHBOARD - GET ALL INVOICES
// ============================================

app.get('/api/invoices/:userId', requireOwner, async (req, res) => {
  try {
    const { userId } = req.params;

    await ensureConnectedBusinessData(userId);
    await syncExistingSalesReceivables(userId);

    const { data: rawInvoices, error } = await supabase
      .from('invoices')
      .select('*')
      .eq('user_id', userId)
      .order('days_overdue', { ascending: false });

    if (error) throw error;

    // Hide synthetic cortex-lab seed rows from the tenant's invoice list
    const data = stripCortexTestRows(rawInvoices || []);

    const totalOutstanding = data.reduce(
      (sum, inv) => sum + (inv.payment_status === 'Pending' ? calculateOutstanding(inv.invoice_amount, inv.payment_amount) : 0),
      0
    );

    res.json({
      success: true,
      invoices: data,
      summary: {
        total_outstanding: totalOutstanding,
        total_customers: new Set(data.map(inv => inv.customer_name)).size,
        most_overdue_days: data.length > 0 ? data[0].days_overdue : 0
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// PRIORITY RANKING - CALCULATE PRIORITY SCORES
// ============================================

function calculatePriorityScore(invoice, paymentHistory = 0) {
  return (invoice.invoice_amount * invoice.days_overdue) / (1 + paymentHistory);
}

function getUrgencyLabel(score) {
  if (score > 3000000) return 'CRITICAL';
  if (score > 1000000) return 'URGENT';
  if (score > 100000) return 'OVERDUE';
  return 'OKAY';
}

app.post('/api/calculate-priority/:userId', requireOwner, async (req, res) => {
  try {
    const { userId } = req.params;

    const { data: invoices, error } = await supabase
      .from('invoices')
      .select('*')
      .eq('user_id', userId)
      .eq('payment_status', 'Pending');

    if (error) throw error;

    const priorityList = invoices
      .map(inv => {
        const priority_score = calculatePriorityScore(inv, 0);
        return {
          ...inv,
          priority_score,
          urgency: getUrgencyLabel(priority_score)
        };
      })
      .sort((a, b) => b.priority_score - a.priority_score)
      .slice(0, 10);

    res.json({ success: true, priority_list: priorityList });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// MESSAGE GENERATION - CLAUDE API INTEGRATION
// ============================================

const MESSAGE_SYSTEM_PROMPT = `You are a collection message generator for small Indian business owners.

Generate a WhatsApp message in Hinglish (Hindi + English mix) to collect payment.

Rules:
1. Keep it short (3-4 lines max)
2. Be friendly but firm
3. Include specific amount and timeline
4. Ask for WhatsApp confirmation (✓✓)
5. Sound like a real business owner, not corporate
6. Use Hinglish (mix of Hindi and English)

Examples of good messages:
"Hi Kumar, ₹50,000 ka payment abhi tak nahi aaya. 40 din ho gaye. Kya aap kal tak pay kar sakte ho? Whatsapp par confirm kar dijiye thanks!"

"Sharma bhai, invoice ₹75,000 ka overdue ho gaya. 60 din ho gaye. Paisa bhej dijiye na. Confirm kar dijiye."

Generate the exact message (just the message, no intro/outro):`;

app.post('/api/generate-message', authMiddleware, async (req, res) => {
  try {
    const { customer_name, amount, days_overdue } = req.body;

    if (!customer_name || !amount || days_overdue === undefined) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 200,
        messages: [
          { role: 'system', content: MESSAGE_SYSTEM_PROMPT },
          { role: 'user', content: `Customer name: ${customer_name}\nAmount owed: ₹${amount}\nDays overdue: ${days_overdue} days` }
        ]
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error?.message || 'Groq API error');
    }

    const generatedText = data.choices[0]?.message?.content || '';

    res.json({
      success: true,
      message: generatedText.trim()
    });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// PAYMENT TRACKING
// ============================================

app.post('/api/mark-paid', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { invoice_id, payment_date, payment_amount, payment_method, payment_notes } = req.body;

    const { data, error } = await supabase
      .from('invoices')
      .update({
        payment_status: 'Paid',
        updated_at: new Date(),
        payment_date: payment_date || new Date().toISOString().split('T')[0],
        payment_amount: payment_amount || null,
        payment_method: payment_method || null,
        payment_notes: payment_notes || null
      })
      .eq('id', invoice_id)
      .eq('user_id', userId)
      .select();

    if (error) throw error;

    const inv = data[0];
    if (inv) {
      await createActivityLog(userId, 'invoice_marked_paid', {
        entityType: 'invoice',
        entityId: inv.id,
        source: 'api',
        amount: payment_amount || inv.invoice_amount || null,
      });
    }
    
    // Sync Bank Transaction (Credit)
    try {
      // Find a default bank account or create one
      let { data: bankAccount } = await supabase.from('bank_accounts').select('id').eq('user_id', userId).limit(1).single();
      if (!bankAccount) {
        const { data: newAcc } = await supabase.from('bank_accounts').insert([{
          user_id: userId,
          account_name: 'Main Business Account',
          account_type: 'checking',
          currency: 'INR',
          balance: 0
        }]).select('id').single();
        bankAccount = newAcc;
      }
      if (bankAccount) {
        await supabase.from('bank_transactions').insert([{
          user_id: userId,
          bank_account_id: bankAccount.id,
          txn_date: inv.payment_date || inv.created_at || new Date().toISOString(),
          amount: parseFloat(inv.payment_amount || inv.invoice_amount || 0),
          type: 'credit',
          description: `Payment for Invoice #${inv.invoice_number || inv.id}`,
          status: 'matched',
          matched_type: 'invoice',
          matched_id: inv.id
        }]);
      }
    } catch (btErr) { console.error('Bank transaction sync error:', btErr.message); }

    // Emit invoice.paid business event
    await emitBusinessEvent(userId, 'invoice.paid', {
      invoice: inv,
      amount: inv.payment_amount || inv.invoice_amount,
      customer: inv.customer_name
    });
    // Payment celebration WhatsApp to owner
    try {
      const { data: owner } = await supabase.from('users').select('phone, business_name, owner_name').eq('id', req.user.userId).single();
      if (owner?.phone && inv) {
        const amt = Number(payment_amount || inv.invoice_amount || 0).toLocaleString('en-IN');
        const { count: pendingCount } = await supabase.from('invoices').select('id', { count: 'exact', head: true }).eq('user_id', req.user.userId).eq('payment_status', 'Pending');
        const celebMsg = `Payment Received! ${inv.customer_name} ne Rs.${amt} bheja! ${pendingCount > 0 ? `Abhi bhi ${pendingCount} invoice pending hain — Vantro follow-up bhej raha hai.` : 'Sab payments clear! Badhai ho!'}`;
        await sendWhatsAppMessage(owner.phone, celebMsg);
      }
    } catch (waErr) { console.error('Celebration WA error:', waErr.message); }

    // ── Cortex: Cashflow confirm + customer score recalculation ───────────────
    if (isFeatureEnabled('cortex_enabled') && inv) {
      const _cfSvc = require('./lib/services/orchestrator/cashflow.service');
      _cfSvc.confirmInflow(
        req.user.userId,
        inv.id,
        parseFloat(payment_amount || inv.invoice_amount || 0),
        payment_date || new Date().toISOString().split('T')[0]
      ).catch(err => console.warn('[Cortex] confirmInflow failed:', err.message));

      if (isFeatureEnabled('customer_scoring')) {
        const _scoring = require('./lib/services/orchestrator/scoring.service');
        _scoring.resolveCustomerId(req.user.userId, inv.customer_name, inv.customer_phone)
          .then(cId => cId ? _scoring.recalculate(req.user.userId, cId) : null)
          .catch(err => console.warn('[Cortex] scoring recalc failed:', err.message));
      }

      // Memory learning: customer paid → record payment behaviour
      if (isFeatureEnabled('memory_enabled') && inv) {
        setImmediate(async () => {
          try {
            const _scoring = require('./lib/services/orchestrator/scoring.service');
            const cId = await _scoring.resolveCustomerId(req.user.userId, inv.customer_name, inv.customer_phone);
            if (cId) {
              await supabase.from('business_memory').upsert([{
                user_id:      req.user.userId,
                entity_type:  'customer',
                entity_id:    cId,
                memory_key:   'last_payment_at',
                memory_value: { v: payment_date || new Date().toISOString().split('T')[0], amount: parseFloat(payment_amount || inv.invoice_amount || 0) },
                source:       'payment_event',
                updated_at:   new Date().toISOString(),
              }], { onConflict: 'user_id,entity_type,entity_id,memory_key' });
            }
          } catch {}
        });
      }
    }
    // ─────────────────────────────────────────────────────────────────────────
    res.json({ success: true, data: inv });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ============================================
// CALL TRACKING
// ============================================

app.post('/api/log-call', authMiddleware, async (req, res) => {
  try {
    const {
      customer_name, amount, notes,
      invoice_id, customer_phone, call_duration_minutes,
      did_pick_up, promised_payment_date, promised_amount
    } = req.body;
    const user_id = req.user.userId;

    const { data, error } = await supabase
      .from('call_logs')
      .insert([{
        user_id,
        customer_name,
        amount,
        notes,
        invoice_id: invoice_id || null,
        customer_phone: customer_phone || null,
        call_duration_minutes: call_duration_minutes || null,
        did_pick_up: did_pick_up !== undefined ? did_pick_up : null,
        promised_payment_date: promised_payment_date || null,
        promised_amount: promised_amount || null,
        called_at: new Date()
      }])
      .select();

    if (error) throw error;

    res.json({ success: true, log: data[0] });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/calls/:userId', requireOwner, async (req, res) => {
  try {
    const { userId } = req.params;

    const { data, error } = await supabase
      .from('call_logs')
      .select('*')
      .eq('user_id', userId)
      .order('called_at', { ascending: false });

    if (error) throw error;

    res.json({ success: true, calls: data });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/call/:callId/update', authMiddleware, async (req, res) => {
  try {
    const { callId } = req.params;
    const { notes, did_pick_up, promised_payment_date, promised_amount, call_duration_minutes } = req.body;

    const { data, error } = await supabase
      .from('call_logs')
      .update({ notes, did_pick_up, promised_payment_date, promised_amount, call_duration_minutes })
      .eq('id', callId)
      .eq('user_id', req.user.userId)
      .select();

    if (error) throw error;
    if (!data?.length) return res.status(404).json({ error: 'Call log not found' });

    res.json({ success: true, log: data[0] });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/business/control-room', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const cacheKey = buildBusinessCacheKey(userId, 'control-room');
    const cached = getCache(cacheKey);
    if (cached) {
      return res.json({ success: true, ...cached, _cached: true });
    }

    await ensureConnectedBusinessData(userId);
    const data = await calculateDashboardControlRoom(userId);
    setCache(cacheKey, data, 60); // 60s TTL

    res.json({ success: true, ...data });
  } catch (error) {
    console.error('[business control room endpoint]', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ============================================
// METRICS & DASHBOARD
// ============================================

app.get('/api/metrics/:userId', requireOwner, async (req, res) => {
  try {
    const { userId } = req.params;

    await syncExistingSalesReceivables(userId);

    const [receivables, payables, { data: callLogs }] = await Promise.all([
      getReceivableRows(userId),
      getPayableRows(userId),
      supabase.from('call_logs').select('*').eq('user_id', userId),
    ]);

    const safeCallLogs = callLogs || [];
    const paidReceivables = receivables.filter((row) => row.outstanding_amount <= 0);
    const pendingReceivables = receivables.filter((row) => row.outstanding_amount > 0);

    const metrics = {
      total_outstanding: pendingReceivables.reduce((sum, row) => sum + row.outstanding_amount, 0),
      total_payable: payables.reduce((sum, row) => sum + row.outstanding_amount, 0),
      total_paid: receivables.reduce((sum, row) => sum + row.paid_amount, 0),
      pending_invoices: pendingReceivables.length,
      total_customers: new Set(receivables.map(row => row.customer_name)).size,
      total_suppliers: new Set(payables.map(row => row.supplier_name)).size,
      calls_made: safeCallLogs.length,
      avg_recovery_rate:
        receivables.length > 0
          ? (
              (paidReceivables.length /
                receivables.length) *
              100
            ).toFixed(1)
          : 0
    };

    res.json({ success: true, metrics });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// ANALYTICS
// ============================================

app.get('/api/analytics/:userId', requireOwner, async (req, res) => {
  try {
    const { userId } = req.params;
    const cacheKey = buildBusinessCacheKey(userId, 'analytics');
    const cached = getCache(cacheKey);
    if (cached) {
      return res.json({ success: true, analytics: cached, _cached: true });
    }

    await ensureConnectedBusinessData(userId);
    const analytics = await calculateAnalyticsSummary(userId);
    setCache(cacheKey, analytics, 60); // 60s TTL

    res.json({
      success: true,
      analytics
    });
  } catch (error) {
    console.error('[analytics]', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ============================================
// INVENTORY MANAGEMENT
// ============================================

// --- Products ---

async function sendInventoryForUser(userId, res) {
  await ensureConnectedBusinessData(userId);
  const [{ data: products }, { data: movements }, summary] = await Promise.all([
    supabase.from('products').select('*').eq('user_id', userId).order('name'),
    supabase.from('stock_movements').select('*').eq('user_id', userId).order('moved_at', { ascending: false }).limit(50),
    calculateInventorySummary(userId)
  ]);

  res.json({
    success: true,
    products: products || [],
    movements: movements || [],
    summary
  });
}

app.get('/api/inventory', authMiddleware, async (req, res) => {
  try {
    const userId = authenticatedUserId(req);
    if (!userId) return res.status(401).json({ error: 'Invalid token payload' });
    await sendInventoryForUser(userId, res);
  } catch (error) {
    console.error('[inventory alias endpoint]', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/inventory/:userId', requireOwner, async (req, res) => {
  try {
    const { userId } = req.params;
    await sendInventoryForUser(userId, res);
  } catch (error) {
    console.error('[inventory list endpoint]', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/products', authMiddleware, async (req, res) => {
  try {
    const userId = authenticatedUserId(req);
    const { name, sku, description, unit_price, unit, current_stock, low_stock_alert, category } = req.body;
    if (!userId || !name) return res.status(400).json({ error: 'name required' });

    const { data, error } = await supabase
      .from('products')
      .insert([{ user_id: userId, name, sku: sku || null, description: description || null, unit_price: unit_price || 0, unit: unit || 'unit', current_stock: current_stock || 0, low_stock_alert: low_stock_alert || 10, category: category || null }])
      .select();

    if (error) throw error;
    await createActivityLog(userId, 'product_created', {
      entityType: 'product',
      entityId: data[0]?.id,
      source: 'api',
    });
    res.json({ success: true, product: data[0] });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/products/:productId', authMiddleware, async (req, res) => {
  try {
    const { productId } = req.params;
    const { name, sku, description, unit_price, unit, low_stock_alert, category } = req.body;

    const { data, error } = await supabase
      .from('products')
      .update({ name, sku, description, unit_price, unit, low_stock_alert, category, updated_at: new Date() })
      .eq('id', productId)
      .eq('user_id', req.user.userId)
      .select();

    if (error) throw error;
    if (!data?.length) return res.status(404).json({ error: 'Product not found' });
    await createActivityLog(req.user.userId, 'product_updated', {
      entityType: 'product',
      entityId: productId,
      source: 'api',
    });
    res.json({ success: true, product: data[0] });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/products/:productId/delete', authMiddleware, async (req, res) => {
  try {
    const { productId } = req.params;
    const { error } = await supabase.from('products').delete().eq('id', productId).eq('user_id', req.user.userId);
    if (error) throw error;
    await createActivityLog(req.user.userId, 'product_deleted', {
      entityType: 'product',
      entityId: productId,
      source: 'api',
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- Stock Movements ---

app.post('/api/stock/move', authMiddleware, async (req, res) => {
  try {
    const userId = authenticatedUserId(req);
    const { product_id, movement_type, quantity, unit_cost, reference, notes } = req.body;
    if (!userId || !product_id || !movement_type || !quantity) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const qty = parseInt(quantity);
    if (!Number.isFinite(qty) || qty <= 0) return res.status(400).json({ error: 'quantity must be greater than zero' });
    if (!['in', 'out'].includes(movement_type)) return res.status(400).json({ error: 'movement_type must be in or out' });
    const delta = movement_type === 'in' ? qty : -qty;

    const { data: product, error: fetchErr } = await supabase
      .from('products').select('current_stock').eq('id', product_id).eq('user_id', userId).single();
    if (fetchErr) throw fetchErr;
    if (!product) return res.status(404).json({ error: 'Product not found' });

    const newStock = Math.max(0, (product.current_stock || 0) + delta);

    const [{ data: movement, error: movErr }, { error: updateErr }] = await Promise.all([
      supabase.from('stock_movements').insert([{
        user_id: userId, product_id, movement_type, quantity: qty,
        unit_cost: unit_cost || null, reference: reference || null, notes: notes || null
      }]).select(),
      supabase.from('products').update({ current_stock: newStock, updated_at: new Date() }).eq('id', product_id).eq('user_id', userId)
    ]);

    if (movErr) throw movErr;
    if (updateErr) throw updateErr;
    await createActivityLog(userId, 'stock_movement_created', {
      entityType: 'product',
      entityId: product_id,
      source: 'api',
      movementType: movement_type,
      quantity: qty,
    });

    res.json({ success: true, movement: movement[0], new_stock: newStock });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/stock/movements/:userId', requireOwner, async (req, res) => {
  try {
    const { userId } = req.params;
    const { data, error } = await supabase
      .from('stock_movements')
      .select('*, products(name, unit)')
      .eq('user_id', userId)
      .order('moved_at', { ascending: false });

    if (error) throw error;
    res.json({ success: true, movements: data });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

function toMoney(value) {
  const number = Number.parseFloat(value || 0);
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : 0;
}

function normalizePartyName(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizePartyKey(value) {
  return normalizePartyName(value).toLowerCase();
}

function calculateOutstanding(total, paid) {
  return Math.max(toMoney(total) - toMoney(paid), 0);
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function normalizePurchaseItem(item) {
  const source = item && typeof item === 'object' ? item : {};
  const qty = toMoney(source.qty ?? source.quantity ?? source.units ?? 0);
  const rate = toMoney(source.price ?? source.rate ?? source.unit_price ?? 0);
  const amount = toMoney(source.amount ?? source.line_total ?? (qty && rate ? qty * rate : 0));
  return {
    description: normalizePartyName(source.description || source.name || source.item || source.product_name || 'Item'),
    hsn_sac: cleanScanString(source.hsn_sac || source.hsn || source.hsn_code),
    qty,
    unit: cleanScanString(source.unit || source.per || source.uom) || 'pcs',
    price: rate,
    rate,
    amount,
  };
}

function getPurchaseItems(purchase) {
  const items = parseJsonArray(purchase?.items)
    .map(normalizePurchaseItem)
    .filter((item) => item.description && item.description !== 'Item');

  if (items.length === 0 && purchase && (purchase.amount > 0 || purchase.total_amount > 0)) {
    const amt = parseFloat(purchase.amount || purchase.total_amount || 0);
    const desc = purchase.description || purchase.notes || 
      (purchase.supplier_name ? `Material: ${purchase.supplier_name}` : null) || 
      (purchase.customer_name ? `Product: ${purchase.customer_name}` : null) || 
      'General Item';
    items.push({
      description: normalizePartyName(desc),
      hsn_sac: null,
      qty: 1,
      price: amt,
      amount: amt
    });
  }
  return items;
}

async function syncInventoryFromPurchase(userId, purchase) {
  const items = getPurchaseItems(purchase);
  if (!items.length) return [];

  const synced = [];
  for (const item of items) {
    const qty = toMoney(item.qty);
    if (!qty || qty <= 0) continue;
    const productName = item.description;
    const unitPrice = toMoney(item.price || item.rate || (item.amount && qty ? item.amount / qty : 0));
    const sku = item.hsn_sac || null;

    try {
      let { data: product, error: productError } = await supabase
        .from('products')
        .select('*')
        .eq('user_id', userId)
        .ilike('name', productName)
        .maybeSingle();

      if (productError) {
        console.warn('[inventory sync product lookup]', productError.message);
        continue;
      }

      if (!product) {
        const inserted = await supabase
          .from('products')
          .insert([{
            user_id: userId,
            name: productName,
            sku,
            description: `Auto-added from purchase ${purchase.bill_number || purchase.id || ''}`.trim(),
            unit_price: unitPrice,
            unit: item.unit || 'pcs',
            current_stock: qty,
            low_stock_alert: 1,
            category: 'Purchased Goods',
          }])
          .select()
          .single();
        if (inserted.error) {
          console.warn('[inventory sync product insert]', inserted.error.message);
          continue;
        }
        product = inserted.data;
      } else {
        const nextStock = toMoney(product.current_stock) + qty;
        const update = { current_stock: nextStock, updated_at: new Date() };
        if (unitPrice > 0) update.unit_price = unitPrice;
        if (sku && !product.sku) update.sku = sku;
        if (item.unit && (!product.unit || product.unit === 'unit')) update.unit = item.unit;
        const { error: updateError } = await supabase
          .from('products')
          .update(update)
          .eq('id', product.id)
          .eq('user_id', userId);
        if (updateError) {
          console.warn('[inventory sync product update]', updateError.message);
          continue;
        }
      }

      const { error: movementError } = await supabase.from('stock_movements').insert([{
        user_id: userId,
        product_id: product.id,
        movement_type: 'in',
        quantity: qty,
        unit_cost: unitPrice || null,
        reference: purchase.bill_number || String(purchase.id || ''),
        notes: `Auto-stocked from purchase bill ${purchase.bill_number || purchase.id || ''}`.trim(),
      }]);
      if (movementError) console.warn('[inventory sync movement]', movementError.message);
      synced.push({ product_id: product.id, name: productName, quantity: qty });
    } catch (err) {
      console.warn('[inventory sync]', err.message || err);
    }
  }

  return synced;
}

async function syncInventoryFromSale(userId, sale) {
  const items = getPurchaseItems(sale); // Works for sales too as structure is similar
  if (!items.length) return [];

  const synced = [];
  for (const item of items) {
    const qty = toMoney(item.qty);
    if (!qty || qty <= 0) continue;
    const productName = item.description;

    try {
      let { data: product, error: productError } = await supabase
        .from('products')
        .select('*')
        .eq('user_id', userId)
        .ilike('name', productName)
        .maybeSingle();

      if (productError || !product) {
        // If product doesn't exist, we don't auto-create on sale usually, 
        // but we might want to log it as out-of-stock movement if it's a known product
        if (productError) console.warn('[inventory sale sync lookup]', productError.message);
        continue;
      }

      const nextStock = toMoney(product.current_stock) - qty;
      const { error: updateError } = await supabase
        .from('products')
        .update({ current_stock: nextStock, updated_at: new Date() })
        .eq('id', product.id)
        .eq('user_id', userId);

      if (updateError) {
        console.warn('[inventory sale sync update]', updateError.message);
        continue;
      }

      await supabase.from('stock_movements').insert([{
        user_id: userId,
        product_id: product.id,
        movement_type: 'out',
        quantity: qty,
        reference: sale.invoice_number || String(sale.id || ''),
        notes: `Sold in invoice ${sale.invoice_number || sale.id || ''}`.trim(),
      }]);
      synced.push({ product_id: product.id, name: productName, quantity: qty });

      // Emit LOW_STOCK_DETECTED if stock dropped to or below the reorder threshold
      const minStock = product.low_stock_alert || product.reorder_level || 0;
      if (minStock > 0 && nextStock <= minStock) {
        setImmediate(() => {
          emitBusinessEvent(userId, 'LOW_STOCK_DETECTED', {
            entityType: 'product',
            entityId:   product.id,
            productName,
            currentStock: nextStock,
            minStock,
          });
        });
      }
    } catch (err) {
      console.warn('[inventory sale sync]', err.message || err);
    }
  }
  return synced;
}

// ─── Automated Reconciliation Logic ──────────────────────────────────────────
const RECONCILE_THROTTLE_MS = 5 * 60 * 1000; // 5 minutes
const lastReconciled = {}; // userId -> timestamp

async function ensureConnectedBusinessData(userId) {
  if (!userId) return;
  const now = Date.now();
  if (lastReconciled[userId] && (now - lastReconciled[userId] < RECONCILE_THROTTLE_MS)) {
    return; // Already ran recently
  }

  console.log(`[Auto-Reconcile] Starting for user ${maskId(userId)}...`);
  lastReconciled[userId] = now;

  try {
    // 1. BACKFILL PURCHASES
    const { data: purchases } = await supabase.from('purchases').select('*').eq('user_id', userId);
    const { data: pMovements } = await supabase.from('stock_movements').select('reference').eq('user_id', userId).not('reference', 'is', null);
    const movementRefs = new Set((pMovements || []).map(m => m.reference));

    for (const p of (purchases || [])) {
      const ref = p.bill_number || String(p.id);
      if (movementRefs.has(ref)) continue;
      const items = getPurchaseItems(p);
      if (!items.length) continue;

      for (const item of items) {
        const qty = toMoney(item.qty);
        if (qty <= 0) continue;
        let { data: product } = await supabase.from('products').select('id').eq('user_id', userId).ilike('name', item.description).maybeSingle();
        if (!product) {
          const { data: newProd } = await supabase.from('products').insert([{ user_id: userId, name: item.description, current_stock: 0 }]).select().single();
          product = newProd;
        }
        await supabase.from('stock_movements').insert([{
          user_id: userId, product_id: product.id, movement_type: 'in', quantity: qty,
          unit_cost: toMoney(item.unit_price) || null, reference: ref,
          notes: `Auto-backfilled from purchase ${ref}`
        }]);
      }
    }

    // 2. BACKFILL SALES
    const { data: sales } = await supabase.from('sales').select('*').eq('user_id', userId);
    for (const s of (sales || [])) {
      const ref = s.invoice_number || String(s.id);
      if (movementRefs.has(ref)) continue;
      const items = getPurchaseItems(s);
      if (!items.length) continue;
      for (const item of items) {
        const qty = toMoney(item.qty);
        if (qty <= 0) continue;
        let { data: product } = await supabase.from('products').select('id').eq('user_id', userId).ilike('name', item.description).maybeSingle();
        if (product) {
          await supabase.from('stock_movements').insert([{
            user_id: userId, product_id: product.id, movement_type: 'out', quantity: qty,
            reference: ref, notes: `Auto-backfilled from sale ${ref}`
          }]);
        }
      }
    }

    // 3. BACKFILL PAID INVOICES
    const { data: invoices } = await supabase.from('invoices').select('*').eq('user_id', userId).eq('payment_status', 'Paid');
    const { data: bTxns } = await supabase.from('bank_transactions').select('matched_id').eq('user_id', userId).eq('matched_type', 'invoice');
    const matchedIds = new Set((bTxns || []).map(t => String(t.matched_id)));

    for (const inv of (invoices || [])) {
      if (matchedIds.has(String(inv.id))) continue;
      await supabase.from('bank_transactions').insert([{
        user_id: userId,
        txn_date: inv.payment_date || inv.invoice_date || new Date().toISOString().split('T')[0],
        description: `Auto-backfill: Payment from ${inv.customer_name} for inv ${inv.invoice_number || inv.id}`,
        amount: toMoney(inv.payment_amount || inv.invoice_amount),
        type: 'credit', status: 'matched', matched_type: 'invoice', matched_id: String(inv.id),
      }]);
    }

    // 3a. BACKFILL PAID/PARTIAL SALES TO BANK TRANSACTIONS
    const { data: bTxnsSales } = await supabase.from('bank_transactions').select('matched_id').eq('user_id', userId).eq('matched_type', 'sale');
    const matchedSaleIds = new Set((bTxnsSales || []).map(t => String(t.matched_id)));

    for (const s of (sales || [])) {
      const paidAmt = toMoney(s.paid_amount || (s.status === 'paid' ? s.amount : 0));
      if (paidAmt <= 0) continue;
      if (matchedSaleIds.has(String(s.id))) continue;
      await supabase.from('bank_transactions').insert([{
        user_id: userId,
        txn_date: s.sale_date || new Date().toISOString().split('T')[0],
        description: `Auto-backfill: Payment from ${s.customer_name} for sale ${s.invoice_number || s.id}`,
        amount: paidAmt,
        type: 'credit', status: 'matched', matched_type: 'sale', matched_id: String(s.id),
      }]);
    }

    // 3b. BACKFILL PAID/PARTIAL PURCHASES TO BANK TRANSACTIONS
    const { data: bTxnsPurchases } = await supabase.from('bank_transactions').select('matched_id').eq('user_id', userId).eq('matched_type', 'purchase');
    const matchedPurchaseIds = new Set((bTxnsPurchases || []).map(t => String(t.matched_id)));

    for (const p of (purchases || [])) {
      const paidAmt = toMoney(p.paid_amount || (p.status === 'paid' ? p.amount : 0));
      if (paidAmt <= 0) continue;
      if (matchedPurchaseIds.has(String(p.id))) continue;
      await supabase.from('bank_transactions').insert([{
        user_id: userId,
        txn_date: p.purchase_date || new Date().toISOString().split('T')[0],
        description: `Auto-backfill: Payment to ${p.supplier_name} for purchase ${p.bill_number || p.id}`,
        amount: paidAmt,
        type: 'debit', status: 'matched', matched_type: 'purchase', matched_id: String(p.id),
      }]);
    }

    // 4. RECALCULATE STOCK
    const { data: products } = await supabase.from('products').select('id, name').eq('user_id', userId);
    for (const prod of (products || [])) {
      const { data: movements } = await supabase.from('stock_movements').select('movement_type, quantity').eq('product_id', prod.id);
      let stock = 0;
      (movements || []).forEach(m => {
        if (m.movement_type === 'in') stock += toMoney(m.quantity);
        else stock -= toMoney(m.quantity);
      });
      await supabase.from('products').update({ current_stock: stock, updated_at: new Date() }).eq('id', prod.id);
    }
    console.log(`[Auto-Reconcile] Completed for user ${maskId(userId)}.`);
  } catch (err) {
    console.error(`[Auto-Reconcile] Error for user ${maskId(userId)}:`, err.message);
  }
}

// ─── Core Activity Logging and Notification Helpers ──────────────────────────
async function createActivityLog(userId, action, metadata = {}) {
  try {
    await supabase.from('activity_logs').insert([{
      user_id: userId,
      action,
      metadata: typeof metadata === 'object' ? JSON.stringify(metadata) : metadata
    }]);
  } catch (err) {
    console.warn('[activity_log] Failed to create log:', err.message);
  }
}

async function createNotification(userId, type, message) {
  try {
    await supabase.from('notifications').insert([{
      user_id: userId,
      type,
      message
    }]);
  } catch (err) {
    console.warn('[notifications] Failed to create notification:', err.message);
  }
}

// ─── Business Event Engine Layer ─────────────────────────────────────────────
const businessEvents = new (require('events').EventEmitter)();

async function emitBusinessEvent(userId, eventType, payload = {}) {
  try {
    console.log(`[Event Engine] Emitting '${eventType}' for user ${maskId(userId)}`);

    // Invalidate user-scoped summary cache on write
    invalidateBusinessCache(userId);

    // Log event in database ActivityLog
    await createActivityLog(userId, eventType, {
      source: 'event_engine',
      ...payload
    }).catch(err => console.warn('[Event Engine] Activity log failed:', err.message));

    // Emit event to node process listener
    businessEvents.emit(eventType, { userId, payload });

    // Trigger connected updates automatically
    safelyRunConnectedUpdates(userId, eventType, payload).catch(err => {
      console.error(`[Event Engine] Connected updates failed for '${eventType}':`, err.message);
    });

    // ── Vantro Cortex: full pipeline — persist event → rules → actions → audit ─
    // Fire-and-observe via setImmediate — never blocks response, never throws to caller.
    try {
      const { isEnabled: _cxEnabled } = require('./lib/featureFlags');
      if (_cxEnabled('cortex_enabled')) {
        setImmediate(async () => {
          try {
            const eventSvc       = require('./lib/services/orchestrator/event.service');
            const rulesService   = require('./lib/services/orchestrator/rules.service');
            const policyGuard    = require('./lib/services/orchestrator/policyGuard.service');
            const actionService  = require('./lib/services/orchestrator/action.service');
            const auditService   = require('./lib/services/orchestrator/audit.service');
            const { isEnabled: _fe } = require('./lib/featureFlags');

            const normalizedType = eventSvc.normalizeLegacyEventType(eventType);

            // 1. Persist to business_events
            const savedEvent = await eventSvc.emit(userId, {
              eventType:  normalizedType,
              entityType: payload.entityType || null,
              entityId:   payload.entityId   || String(payload.sale?.id || payload.invoice?.id || payload.purchase?.id || payload.entityId || ''),
              actorType:  'user',
              actorId:    userId,
              payload,
            });

            if (!savedEvent) return; // persistence failed — stop, don't run rules on nothing

            // 2. Evaluate rules → persist actions through policyGuard
            const rawActions = await rulesService.evaluate(userId, savedEvent);
            for (const raw of rawActions) {
              try {
                const safe = await policyGuard.validate(raw, userId);
                if (safe.status !== 'system_blocked') {
                  await actionService.create(userId, safe);
                }
              } catch (actionErr) {
                console.warn('[Cortex] action create failed:', actionErr.message, { actionType: raw.action_type });
              }
            }

            // 3. Write Cortex audit log
            auditService.log(userId, {
              action:     normalizedType,
              entityType: savedEvent.entity_type  || null,
              entityId:   savedEvent.entity_id    || null,
              newValue:   payload,
            }).catch(() => {});

            // 4. Trigger customer score recalc for sale/payment events
            if (_fe('customer_scoring') && ['SALE_CREATED', 'SALE_UPDATED', 'INVOICE_PAID', 'PROMISE_BROKEN', 'PROMISE_KEPT'].includes(normalizedType)) {
              const custName  = payload?.customer_name || payload?.sale?.customer_name || payload?.invoice?.customer_name;
              const custPhone = payload?.customer_phone || payload?.sale?.customer_phone || payload?.invoice?.customer_phone;
              if (custName) {
                const scoring = require('./lib/services/orchestrator/scoring.service');
                scoring.resolveCustomerId(userId, custName, custPhone)
                  .then(cId => cId ? scoring.recalculate(userId, cId) : null)
                  .catch(() => {});
              }
            }
          } catch (pipelineErr) {
            console.warn('[Cortex] pipeline error for', eventType, ':', pipelineErr.message);
          }
        });
      }
    } catch (cortexErr) {
      console.warn('[Cortex] pipeline setup failed:', cortexErr.message);
    }
    // ── End Cortex pipeline ─────────────────────────────────────────────────
  } catch (err) {
    console.error('[Event Engine] Fatal emit error:', err.message);
  }
}

async function safelyRunConnectedUpdates(userId, eventType, payload) {
  // Always trigger core automated reconciliation in background to ensure integrity
  await ensureConnectedBusinessData(userId);

  switch (eventType) {
    case 'sale.created':
    case 'sale.updated':
      if (payload.sale) {
        await syncReceivableFromSale(userId, payload.sale).catch(() => {});
        await syncInventoryFromSale(userId, payload.sale).catch(() => {});
      }
      break;

    case 'purchase.created':
    case 'purchase.updated':
      if (payload.purchase) {
        await ensureSupplierFromPurchase(userId, payload.purchase).catch(() => {});
        await syncInventoryFromPurchase(userId, payload.purchase).catch(() => {});
      }
      break;

    case 'invoice.paid':
    case 'payment.received':
      // Handled directly via bank_transactions matching or mark-paid sync
      break;
  }
}


// ─── Shared Ledger Summary Service ───────────────────────────────────────────
async function calculateLedgerSummary(userId) {
  const { data, error } = await supabase
    .from('bank_transactions')
    .select('*')
    .eq('user_id', userId);
  if (error) throw error;
  const transactions = (data || []).map(mapBankTransactionToLedger);
  return buildLedgerSummary(transactions);
}

// ─── Shared Analytics Summary Service ────────────────────────────────────────
async function calculateAnalyticsSummary(userId) {
  await syncExistingSalesReceivables(userId);

  const [receivables, payables, { data: callLogs }] = await Promise.all([
    getReceivableRows(userId),
    getPayableRows(userId),
    supabase.from('call_logs').select('*').eq('user_id', userId)
  ]);

  const safeCallLogs = callLogs || [];
  const paidInvoices = receivables.filter(inv => inv.outstanding_amount <= 0);
  const pendingInvoices = receivables.filter(inv => inv.outstanding_amount > 0);

  // Monthly business movement for last 6 months
  const monthly = {};
  const now = new Date();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    monthly[key] = {
      month: key,
      recovered: 0,
      invoices_paid: 0,
      sales_booked: 0,
      purchases_booked: 0,
      payables_paid: 0,
      net_booked: 0,
      cash_net: 0,
    };
  }
  receivables.forEach(inv => {
    const bookedKey = (inv.invoice_date || inv.due_date || '').substring(0, 7);
    if (monthly[bookedKey]) monthly[bookedKey].sales_booked += Number(inv.amount || 0);

    const date = inv.payment_date || (inv.status === 'Paid' ? inv.invoice_date : null);
    if (!date) return;
    const key = date.substring(0, 7);
    if (monthly[key]) {
      monthly[key].recovered += Number(inv.paid_amount || inv.amount);
      if (Number(inv.paid_amount || inv.amount) > 0) monthly[key].invoices_paid += 1;
    }
  });
  payables.forEach(purchase => {
    const bookedKey = (purchase.purchase_date || purchase.due_date || '').substring(0, 7);
    if (monthly[bookedKey]) monthly[bookedKey].purchases_booked += Number(purchase.amount || 0);

    const paidKey = (purchase.status === 'paid' ? (purchase.purchase_date || purchase.due_date || '') : '').substring(0, 7);
    if (monthly[paidKey]) monthly[paidKey].payables_paid += Number(purchase.paid_amount || purchase.amount || 0);
  });
  Object.values(monthly).forEach(row => {
    row.net_booked = row.sales_booked - row.purchases_booked;
    row.cash_net = row.recovered - row.payables_paid;
  });

  const supplierMap = {};
  payables.forEach(purchase => {
    if (!supplierMap[purchase.supplier_name]) {
      supplierMap[purchase.supplier_name] = { name: purchase.supplier_name, amount: 0, outstanding: 0 };
    }
    supplierMap[purchase.supplier_name].amount += Number(purchase.amount || 0);
    supplierMap[purchase.supplier_name].outstanding += Number(purchase.outstanding_amount || 0);
  });
  const topSuppliers = Object.values(supplierMap)
    .sort((a, b) => b.outstanding - a.outstanding || b.amount - a.amount)
    .slice(0, 5);

  const customerMap = {};
  pendingInvoices.forEach(inv => {
    if (!customerMap[inv.customer_name]) customerMap[inv.customer_name] = 0;
    customerMap[inv.customer_name] += Number(inv.outstanding_amount);
  });
  const topCustomers = Object.entries(customerMap)
    .map(([name, amount]) => ({ name, amount }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 5);

  const totalOutstanding = pendingInvoices.reduce((s, i) => s + Number(i.outstanding_amount), 0);
  const totalRecovered = receivables.reduce((s, i) => s + Number(i.paid_amount || 0), 0);
  const salesBooked = receivables.reduce((s, i) => s + Number(i.amount || 0), 0);
  const purchasesBooked = payables.reduce((s, p) => s + Number(p.amount || 0), 0);
  const totalPayable = payables.reduce((s, p) => s + Number(p.outstanding_amount || 0), 0);
  const payablesPaid = payables.reduce((s, p) => s + Number(p.paid_amount || 0), 0);
  const grossMargin = salesBooked > 0 ? ((salesBooked - purchasesBooked) / salesBooked) * 100 : 0;
  const recoveryRate = receivables.length > 0
    ? ((paidInvoices.length / receivables.length) * 100).toFixed(1)
    : 0;

  return {
    total_outstanding: totalOutstanding,
    total_payable: totalPayable,
    total_recovered: totalRecovered,
    sales_booked: salesBooked,
    purchases_booked: purchasesBooked,
    payables_paid: payablesPaid,
    gross_margin_pct: Number(grossMargin.toFixed(1)),
    booked_net: salesBooked - purchasesBooked,
    cash_net: totalRecovered - payablesPaid,
    recovery_rate: recoveryRate,
    total_invoices: receivables.length,
    paid_invoices: paidInvoices.length,
    pending_invoices: pendingInvoices.length,
    calls_made: safeCallLogs.length,
    total_customers: new Set(receivables.map((i) => i.customer_name)).size,
    total_suppliers: new Set(payables.map((p) => p.supplier_name)).size,
    monthly_trend: Object.values(monthly),
    top_customers: topCustomers,
    top_suppliers: topSuppliers,
  };
}

// ─── Shared Control Room Summary Service ─────────────────────────────────────
async function calculateDashboardControlRoom(userId) {
  const [metricsRes, analytics, inventory, collections, ledgerData] = await Promise.all([
    supabase.from('users').select('id, business_name, owner_name, email').eq('id', userId).maybeSingle(),
    calculateAnalyticsSummary(userId).catch(() => ({})),
    calculateInventorySummary(userId).catch(() => ({})),
    calculateCollectionsSummary(userId).catch(() => ({})),
    calculateLedgerSummary(userId).catch(() => ({ balance: 0 })),
  ]);

  const [recentLogsRes, recentNotificationsRes] = await Promise.all([
    supabase.from('activity_logs').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(5),
    supabase.from('notifications').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(5)
  ]);

  const actions = [];
  if (collections?.buckets?.overdue_60_plus > 0) {
    actions.push({
      id: 'action_critical_debt',
      type: 'high_priority',
      title: 'Action Required: High Debt Risk',
      description: `₹${Number(collections.buckets.overdue_60_plus).toLocaleString('en-IN')} has been outstanding for more than 60 days. Run a reminder campaign now.`,
      action_url: '/collections'
    });
  }
  
  if (inventory?.low_stock_count > 0) {
    actions.push({
      id: 'action_low_stock',
      type: 'medium_priority',
      title: 'Inventory Alert: Low Stock Items',
      description: `${inventory.low_stock_count} products have dropped below their low-stock thresholds. Restock soon to prevent order delays.`,
      action_url: '/inventory'
    });
  }

  if (ledgerData?.balance < 0) {
    actions.push({
      id: 'action_negative_cash',
      type: 'high_priority',
      title: 'Cash Flow Warning: Negative Balance',
      description: 'Your mapped bank ledger reports a negative overall balance. Check for pending collections.',
      action_url: '/ledger'
    });
  }

  if (actions.length === 0) {
    actions.push({
      id: 'action_all_clear',
      type: 'low_priority',
      title: 'All Operations Healthy',
      description: 'Zero critical cash or inventory issues flagged. Keep up the great business momentum!',
      action_url: '/dashboard'
    });
  }

  return {
    business: metricsRes.data || null,
    metrics: {
      total_outstanding: collections?.total_outstanding || 0,
      total_payable: analytics?.total_payable || 0,
      ledger_balance: ledgerData?.balance || 0,
      inventory_value: inventory?.total_value || 0,
    },
    critical_actions: actions,
    recent_activity: recentLogsRes.data || [],
    recent_notifications: recentNotificationsRes.data || [],
    collections_summary: collections,
    inventory_summary: inventory,
  };
}

// ─── Shared Customer Timeline Service ────────────────────────────────────────
async function getCustomerTimeline(userId, customerId) {
  const [invoicesRes, callsRes, logsRes] = await Promise.all([
    supabase.from('invoices').select('*').eq('user_id', userId).eq('customer_name', customerId),
    supabase.from('call_logs').select('*').eq('user_id', userId).eq('customer_name', customerId),
    supabase.from('activity_logs').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(100),
  ]);

  const invoices = invoicesRes.data || [];
  const calls = callsRes.data || [];
  const logs = logsRes.data || [];

  const timeline = [];

  calls.forEach(c => {
    timeline.push({
      id: `call_${c.id}`,
      type: 'call',
      title: `Call with ${c.customer_name}`,
      description: c.notes || (c.did_pick_up ? 'Called, customer picked up.' : 'Called, no answer.'),
      date: c.called_at,
      metadata: {
        did_pick_up: c.did_pick_up,
        promised_payment_date: c.promised_payment_date,
        promised_amount: c.promised_amount,
        amount: c.amount,
        phone: c.customer_phone
      }
    });
  });

  invoices.forEach(inv => {
    timeline.push({
      id: `inv_create_${inv.id}`,
      type: 'invoice_created',
      title: `Invoice #${inv.invoice_number || 'INV'} Created`,
      description: `Created invoice for ${inv.customer_name} of ₹${Number(inv.invoice_amount).toLocaleString('en-IN')}`,
      date: inv.invoice_date || inv.created_at,
      metadata: {
        customer_name: inv.customer_name,
        invoice_amount: inv.invoice_amount,
        due_date: inv.due_date
      }
    });

    if (inv.payment_status === 'Paid' && inv.payment_date) {
      timeline.push({
        id: `inv_pay_${inv.id}`,
        type: 'payment_received',
        title: `Payment Received from ${inv.customer_name}`,
        description: `Received ₹${Number(inv.invoice_amount).toLocaleString('en-IN')} for invoice #${inv.invoice_number || 'INV'}`,
        date: inv.payment_date,
        metadata: {
          customer_name: inv.customer_name,
          amount: inv.invoice_amount,
          method: inv.payment_method
        }
      });
    }
  });

  logs.forEach(l => {
    let meta = {};
    try {
      meta = typeof l.metadata === 'string' ? JSON.parse(l.metadata || '{}') : l.metadata || {};
    } catch (_) {}
    if (meta.customer_name === customerId || meta.customerName === customerId) {
      timeline.push({
        id: `log_${l.id}`,
        type: 'activity',
        title: l.action.replace(/_/g, ' ').toUpperCase(),
        description: meta.message || `Activity logged: ${l.action}`,
        date: l.created_at,
        metadata: meta
      });
    }
  });

  timeline.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  return timeline;
}

// ─── Shared Supplier Timeline Service ────────────────────────────────────────
async function getSupplierTimeline(userId, supplierId) {
  const [purchasesRes, logsRes] = await Promise.all([
    supabase.from('purchases').select('*').eq('user_id', userId).eq('supplier_name', supplierId),
    supabase.from('activity_logs').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(100),
  ]);

  const purchases = purchasesRes.data || [];
  const logs = logsRes.data || [];

  const timeline = [];

  purchases.forEach(p => {
    timeline.push({
      id: `purchase_create_${p.id}`,
      type: 'purchase_created',
      title: `Purchase Bill #${p.bill_number || 'BILL'} Created`,
      description: `Recorded purchase from ${p.supplier_name} of ₹${Number(p.amount).toLocaleString('en-IN')}`,
      date: p.purchase_date || p.created_at,
      metadata: {
        supplier_name: p.supplier_name,
        amount: p.amount,
        status: p.status,
        due_date: p.due_date
      }
    });

    if (p.status === 'paid' && p.purchase_date) {
      timeline.push({
        id: `purchase_pay_${p.id}`,
        type: 'payment_made',
        title: `Payment Made to ${p.supplier_name}`,
        description: `Paid ₹${Number(p.paid_amount || p.amount).toLocaleString('en-IN')} for bill #${p.bill_number || 'BILL'}`,
        date: p.purchase_date,
        metadata: {
          supplier_name: p.supplier_name,
          amount: p.paid_amount || p.amount,
          status: p.status
        }
      });
    }
  });

  logs.forEach(l => {
    let meta = {};
    try {
      meta = typeof l.metadata === 'string' ? JSON.parse(l.metadata || '{}') : l.metadata || {};
    } catch (_) {}
    if (meta.supplier_name === supplierId || meta.supplierName === supplierId) {
      timeline.push({
        id: `log_${l.id}`,
        type: 'activity',
        title: l.action.replace(/_/g, ' ').toUpperCase(),
        description: meta.message || `Activity logged: ${l.action}`,
        date: l.created_at,
        metadata: meta
      });
    }
  });

  timeline.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  return timeline;
}


// ─── Shared Inventory Summary Service ─────────────────────────────────────────
async function calculateInventorySummary(userId) {
  const { data: products } = await supabase.from('products').select('*').eq('user_id', userId).order('name');
  const safeProducts = products || [];
  const totalValue = safeProducts.reduce((sum, p) => sum + Number(p.current_stock || 0) * Number(p.unit_price || 0), 0);
  const lowStock = safeProducts.filter(p => p.current_stock > 0 && p.current_stock <= p.low_stock_alert);
  const outOfStock = safeProducts.filter(p => p.current_stock === 0);

  // Fast-moving products (past 30 days)
  const thirtyDaysAgo = new Date(); thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const { data: recentOutMovements } = await supabase
    .from('stock_movements')
    .select('product_id, quantity')
    .eq('user_id', userId)
    .eq('movement_type', 'out')
    .gte('moved_at', thirtyDaysAgo.toISOString());

  const fastMovingMap = {};
  (recentOutMovements || []).forEach(m => {
    fastMovingMap[m.product_id] = (fastMovingMap[m.product_id] || 0) + Number(m.quantity || 0);
  });
  const fastMovingItems = safeProducts
    .filter(p => fastMovingMap[p.id] > 0)
    .map(p => ({
      product_id: p.id,
      name: p.name,
      sku: p.sku,
      unit: p.unit,
      quantity_sold_30d: fastMovingMap[p.id],
      value_sold_30d: fastMovingMap[p.id] * Number(p.unit_price || 0)
    }))
    .sort((a, b) => b.quantity_sold_30d - a.quantity_sold_30d)
    .slice(0, 5);

  // Dead stock (no movements in past 60 days)
  const sixtyDaysAgo = new Date(); sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);
  const { data: recentMovements } = await supabase
    .from('stock_movements')
    .select('product_id')
    .eq('user_id', userId)
    .gte('moved_at', sixtyDaysAgo.toISOString());

  const movedProductIds = new Set((recentMovements || []).map(m => m.product_id));
  const deadStock = safeProducts.filter(p => !movedProductIds.has(p.id) && Number(p.current_stock) > 0);

  // Reorder suggestions
  const reorderSuggestions = [...lowStock, ...outOfStock].map(p => {
    const recommendedQty = Math.max(50, Number(p.low_stock_alert || 10) * 2);
    return {
      product_id: p.id,
      name: p.name,
      sku: p.sku,
      current_stock: p.current_stock,
      low_stock_alert: p.low_stock_alert,
      unit: p.unit,
      recommended_reorder_qty: recommendedQty,
      estimated_cost: recommendedQty * Number(p.unit_price || 0)
    };
  });

  return {
    total_products: safeProducts.length,
    total_value: totalValue,
    low_stock_count: lowStock.length,
    out_of_stock_count: outOfStock.length,
    low_stock_items: lowStock,
    out_of_stock_items: outOfStock,
    fast_moving_items: fastMovingItems,
    dead_stock_items: deadStock,
    reorder_suggestions: reorderSuggestions
  };
}

// ─── Shared Collections Summary Service ───────────────────────────────────────
async function calculateCollectionsSummary(userId) {
  const { data: invoices } = await supabase.from('invoices').select('*').eq('user_id', userId);
  const safeInvoices = invoices || [];
  
  let totalOutstanding = 0;
  let dueToday = 0;
  let overdue_1_7 = 0;
  let overdue_8_30 = 0;
  let overdue_31_60 = 0;
  let overdue_60_plus = 0;
  const criticalOverdueInvoices = [];
  const pendingInvoices = [];

  safeInvoices.forEach(inv => {
    if (inv.payment_status === 'Pending') {
      const outstanding = calculateOutstanding(inv.invoice_amount, inv.payment_amount);
      if (outstanding > 0) {
        totalOutstanding += outstanding;
        pendingInvoices.push({ ...inv, outstanding });

        const days = Number(inv.days_overdue || 0);
        if (days <= 0) {
          dueToday += outstanding;
        } else if (days <= 7) {
          overdue_1_7 += outstanding;
        } else if (days <= 30) {
          overdue_8_30 += outstanding;
        } else if (days <= 60) {
          overdue_31_60 += outstanding;
        } else {
          overdue_60_plus += outstanding;
          criticalOverdueInvoices.push({ ...inv, outstanding });
        }
      }
    }
  });

  return {
    total_outstanding: totalOutstanding,
    total_customers: new Set(pendingInvoices.map(inv => inv.customer_name)).size,
    most_overdue_days: Math.max(...safeInvoices.map(inv => inv.days_overdue || 0), 0),
    buckets: {
      due_today: dueToday,
      overdue_1_7: overdue_1_7,
      overdue_8_30: overdue_8_30,
      overdue_31_60: overdue_31_60,
      overdue_60_plus: overdue_60_plus
    },
    critical_overdue_count: criticalOverdueInvoices.length,
    critical_overdue_items: criticalOverdueInvoices
  };
}

// ─── Shared Cash Flow Forecast Service ────────────────────────────────────────
async function calculateCashFlowForecast(userId, current_cash = 0, days = 30) {
  const [receivables, payables, bankTxnsResult] = await Promise.all([
    getReceivableRows(userId),
    getPayableRows(userId),
    supabase.from('bank_transactions').select('*').eq('user_id', userId)
  ]);

  const bankTxns = bankTxnsResult.error ? [] : bankTxnsResult.data || [];

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const thirtyDaysAgoStr = thirtyDaysAgo.toISOString().split('T')[0];

  // Calculate historical burn rate from actual bank debits
  const recentDebits = bankTxns.filter((t) => t.type === 'debit' && t.txn_date && t.txn_date >= thirtyDaysAgoStr);
  const totalDebitAmount = recentDebits.reduce((sum, t) => sum + Math.abs(Number(t.amount || 0)), 0);
  const bankBurnRate = recentDebits.length > 0 ? Math.round(totalDebitAmount / 30) : null;

  // Fallback to purchase burn rate
  const recentPurchases = payables.filter((p) => p.purchase_date && p.purchase_date >= thirtyDaysAgoStr);
  const purchaseTotal = recentPurchases.reduce((s, p) => s + Number(p.amount || 0), 0);
  const totalPayable = payables.reduce((s, p) => s + Number(p.outstanding_amount || 0), 0);
  const purchaseBurnRate = recentPurchases.length > 0 ? Math.round(purchaseTotal / 30) : Math.round(totalPayable / 30);

  // Real historical burn rate (prefer bank transaction debits, fallback to purchases)
  const calculatedBurnRate = bankBurnRate !== null ? bankBurnRate : purchaseBurnRate;

  // Calculate historical inflows from actual bank credits
  const recentCredits = bankTxns.filter((t) => t.type === 'credit' && t.txn_date && t.txn_date >= thirtyDaysAgoStr);
  const totalCreditAmount = recentCredits.reduce((sum, t) => sum + Math.abs(Number(t.amount || 0)), 0);
  const bankInflowDaily = recentCredits.length > 0 ? Math.round(totalCreditAmount / 30) : null;

  const paid = receivables.filter(i => i.paid_amount > 0);
  const paidLast90 = paid.filter((i) => {
    if (!i.payment_date) return true;
    const d = new Date(i.payment_date);
    const ninetyDaysAgo = new Date(); ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
    return !Number.isNaN(d.getTime()) && d >= ninetyDaysAgo;
  });
  const totalRecovered = paidLast90.reduce((s, i) => s + Number(i.paid_amount || 0), 0);
  const pending = receivables.filter(i => i.outstanding_amount > 0);
  const totalOutstanding = pending.reduce((s, i) => s + Number(i.outstanding_amount), 0);
  const totalOverdue30 = pending.filter(i => Number(i.days_overdue) >= 30).reduce((s, i) => s + Number(i.outstanding_amount), 0);

  // Prefer bank transaction credits for actual daily inflows, fallback to historical collections average
  const avgDailyCollections = bankInflowDaily !== null ? bankInflowDaily : (paidLast90.length > 0 ? Math.round(totalRecovered / 90) : Math.round(totalOutstanding * 0.03));

  const cashStart = Number(current_cash);
  const burnRate = calculatedBurnRate;
  const n = Number(days);

  const buildCurve = (inflow) => {
    const curve = [];
    let cash = cashStart;
    for (let d = 0; d <= n; d++) {
      curve.push({ day: d, cash: Math.max(0, Math.round(cash)) });
      cash += inflow - burnRate;
    }
    return curve;
  };

  const scenarios = {
    pessimistic: { dailyInflow: Math.round(avgDailyCollections * 0.5) },
    expected:    { dailyInflow: Math.round(avgDailyCollections * 0.8) },
    optimistic:  { dailyInflow: Math.round(avgDailyCollections * 0.95) },
  };

  Object.keys(scenarios).forEach(k => {
    const { dailyInflow } = scenarios[k];
    const netDaily = dailyInflow - burnRate;
    scenarios[k].curve = buildCurve(dailyInflow);
    scenarios[k].endCash = Math.max(0, Math.round(cashStart + netDaily * n));
    scenarios[k].runwayDays = netDaily >= 0 ? 999 : Math.floor(cashStart / Math.abs(netDaily));
  });

  return {
    cashStart,
    burnRate,
    avgDailyCollections,
    totalOutstanding,
    totalPayable,
    totalOverdue30,
    topOutstanding: pending
      .sort((a, b) => b.outstanding_amount - a.outstanding_amount)
      .slice(0, 5)
      .map((i) => ({
        name: i.customer_name,
        amount: i.outstanding_amount,
        days_overdue: i.days_overdue,
      })),
    scenarios
  };
}

function calculateDaysOverdue(dateValue, isPaid = false) {
  if (isPaid || !dateValue) return 0;
  const due = new Date(dateValue);
  if (Number.isNaN(due.getTime())) return 0;
  const today = new Date();
  due.setHours(0, 0, 0, 0);
  today.setHours(0, 0, 0, 0);
  return Math.max(Math.floor((today - due) / (1000 * 60 * 60 * 24)), 0);
}

function normalizeReceivableInvoice(inv) {
  const amount = toMoney(inv.invoice_amount);
  const paidAmount = inv.payment_status === 'Paid'
    ? toMoney(inv.payment_amount || amount)
    : toMoney(inv.payment_amount);
  const outstanding = inv.payment_status === 'Paid' ? 0 : calculateOutstanding(amount, paidAmount);
  const dueDate = inv.due_date || inv.invoice_date || inv.created_at;

  return {
    id: inv.id,
    source_type: inv.source_type || 'invoices',
    source_id: inv.source_id || String(inv.id),
    invoice_number: inv.invoice_number || null,
    customer_name: normalizePartyName(inv.customer_name),
    customer_phone: inv.customer_phone || null,
    amount,
    paid_amount: paidAmount,
    outstanding_amount: outstanding,
    status: outstanding <= 0 ? 'Paid' : 'Pending',
    invoice_date: inv.invoice_date || inv.created_at || null,
    due_date: dueDate || null,
    payment_date: inv.payment_date || null,
    days_overdue: calculateDaysOverdue(dueDate, outstanding <= 0),
    raw: inv,
  };
}

function normalizeReceivableSale(sale) {
  const amount = toMoney(sale.amount || sale.total_amount);
  const paidAmount = toMoney(sale.paid_amount);
  const outstanding = sale.status === 'paid' ? 0 : calculateOutstanding(amount, paidAmount);
  const dueDate = sale.due_date || sale.sale_date || sale.created_at;

  return {
    id: `sale:${sale.id}`,
    source_type: 'sales',
    source_id: String(sale.id),
    invoice_number: sale.invoice_number || `SALE-${sale.id}`,
    customer_name: normalizePartyName(sale.customer_name),
    customer_phone: sale.customer_phone || null,
    amount,
    paid_amount: paidAmount,
    outstanding_amount: outstanding,
    status: outstanding <= 0 ? 'Paid' : 'Pending',
    invoice_date: sale.sale_date || sale.created_at || null,
    due_date: dueDate || null,
    payment_date: sale.status === 'paid' ? sale.sale_date || sale.created_at || null : null,
    days_overdue: calculateDaysOverdue(dueDate, outstanding <= 0),
    raw: sale,
  };
}

function normalizePayablePurchase(purchase) {
  const amount = toMoney(purchase.amount || purchase.total_amount);
  const paidAmount = toMoney(purchase.paid_amount);
  const outstanding = purchase.status === 'paid' ? 0 : calculateOutstanding(amount, paidAmount);
  const dueDate = purchase.due_date || purchase.purchase_date || purchase.created_at;

  return {
    id: purchase.id,
    supplier_name: normalizePartyName(purchase.supplier_name),
    supplier_phone: purchase.supplier_phone || null,
    amount,
    paid_amount: paidAmount,
    outstanding_amount: outstanding,
    status: outstanding <= 0 ? 'paid' : purchase.status || 'unpaid',
    purchase_date: purchase.purchase_date || purchase.created_at || null,
    due_date: dueDate || null,
    days_overdue: calculateDaysOverdue(dueDate, outstanding <= 0),
    raw: purchase,
  };
}

async function getReceivableRows(userId) {
  const [invoiceResult, saleResult] = await Promise.all([
    supabase.from('invoices').select('*').eq('user_id', userId),
    supabase.from('sales').select('*').eq('user_id', userId),
  ]);

  const invoices = stripCortexTestRows(invoiceResult.error ? [] : invoiceResult.data || []);
  const sales = stripCortexTestRows(saleResult.error ? [] : saleResult.data || []);
  const invoiceRows = invoices.map(normalizeReceivableInvoice).filter((row) => row.customer_name && row.amount > 0);
  const linkedSaleIds = new Set(invoiceRows.filter((row) => row.source_type === 'sales').map((row) => String(row.source_id)));
  const invoiceNumbers = new Set(invoiceRows.map((row) => normalizePartyKey(row.invoice_number)).filter(Boolean));

  const saleRows = sales
    .filter((sale) => !linkedSaleIds.has(String(sale.id)))
    .filter((sale) => !sale.invoice_number || !invoiceNumbers.has(normalizePartyKey(sale.invoice_number)))
    .map(normalizeReceivableSale)
    .filter((row) => row.customer_name && row.amount > 0);

  return [...invoiceRows, ...saleRows];
}

async function getPayableRows(userId) {
  const { data, error } = await supabase.from('purchases').select('*').eq('user_id', userId);
  if (error) return [];
  return stripCortexTestRows(data || []).map(normalizePayablePurchase).filter((row) => row.supplier_name && row.amount > 0);
}

async function syncExistingSalesReceivables(userId) {
  const { data: sales, error } = await supabase.from('sales').select('*').eq('user_id', userId);
  if (error || !sales?.length) return;
  for (const sale of sales.slice(0, 100)) {
    await syncReceivableFromSale(userId, sale);
  }
}

async function buildKhataEntries(userId, partyName = null) {
  await syncExistingSalesReceivables(userId);

  const [{ data: manualEntries, error: manualError }, receivables, payables] = await Promise.all([
    supabase.from('khata_entries').select('*').eq('user_id', userId),
    getReceivableRows(userId),
    getPayableRows(userId),
  ]);
  if (manualError) {
    console.warn('[khata] manual entries unavailable; continuing with sales/purchases:', manualError.message || manualError);
  }

  const targetKey = partyName ? normalizePartyKey(partyName) : null;
  const rows = [];
  const addRow = (row) => {
    if (!row.customer_name || !row.amount) return;
    if (targetKey && normalizePartyKey(row.customer_name) !== targetKey) return;
    rows.push({
      id: row.id,
      customer_name: row.customer_name,
      customer_phone: row.customer_phone || null,
      type: row.type,
      amount: toMoney(row.amount),
      payment_mode: row.payment_mode || 'system',
      note: row.note || row.notes || null,
      notes: row.note || row.notes || null,
      created_at: row.created_at || row.entry_date || new Date().toISOString(),
      entry_date: row.entry_date || row.created_at || new Date().toISOString(),
      source_type: row.source_type || 'manual',
      party_type: row.party_type || 'customer',
    });
  };

  (manualError ? [] : manualEntries || []).forEach((entry) => addRow({
    id: entry.id,
    customer_name: normalizePartyName(entry.customer_name),
    customer_phone: entry.customer_phone || null,
    type: entry.type,
    amount: entry.amount,
    payment_mode: entry.payment_mode,
    note: entry.note || entry.notes,
    created_at: entry.entry_date || entry.created_at,
    entry_date: entry.entry_date || entry.created_at,
    source_type: 'manual',
    party_type: 'customer',
  }));

  receivables.forEach((invoice) => {
    addRow({
      id: `${invoice.source_type}:${invoice.source_id}:debit`,
      customer_name: invoice.customer_name,
      customer_phone: invoice.customer_phone,
      type: 'debit',
      amount: invoice.amount,
      payment_mode: 'invoice',
      note: invoice.invoice_number ? `Invoice ${invoice.invoice_number}` : 'Sale invoice',
      created_at: invoice.invoice_date || invoice.due_date,
      entry_date: invoice.invoice_date || invoice.due_date,
      source_type: invoice.source_type,
      party_type: 'customer',
    });
    if (invoice.paid_amount > 0) {
      addRow({
        id: `${invoice.source_type}:${invoice.source_id}:credit`,
        customer_name: invoice.customer_name,
        customer_phone: invoice.customer_phone,
        type: 'credit',
        amount: invoice.paid_amount,
        payment_mode: 'collection',
        note: invoice.invoice_number ? `Payment for ${invoice.invoice_number}` : 'Payment received',
        created_at: invoice.payment_date || invoice.invoice_date,
        entry_date: invoice.payment_date || invoice.invoice_date,
        source_type: invoice.source_type,
        party_type: 'customer',
      });
    }
  });

  payables.forEach((purchase) => {
    addRow({
      id: `purchase:${purchase.id}:credit`,
      customer_name: purchase.supplier_name,
      customer_phone: purchase.supplier_phone,
      type: 'credit',
      amount: purchase.amount,
      payment_mode: 'purchase',
      note: purchase.raw?.bill_number ? `Purchase bill ${purchase.raw.bill_number}` : 'Purchase bill',
      created_at: purchase.purchase_date || purchase.due_date,
      entry_date: purchase.purchase_date || purchase.due_date,
      source_type: 'purchases',
      party_type: 'supplier',
    });
    if (purchase.paid_amount > 0) {
      addRow({
        id: `purchase:${purchase.id}:debit`,
        customer_name: purchase.supplier_name,
        customer_phone: purchase.supplier_phone,
        type: 'debit',
        amount: purchase.paid_amount,
        payment_mode: 'supplier_payment',
        note: purchase.raw?.bill_number ? `Paid against ${purchase.raw.bill_number}` : 'Supplier payment',
        created_at: purchase.purchase_date || purchase.due_date,
        entry_date: purchase.purchase_date || purchase.due_date,
        source_type: 'purchases',
        party_type: 'supplier',
      });
    }
  });

  return rows.sort((a, b) => new Date(a.entry_date || a.created_at) - new Date(b.entry_date || b.created_at));
}

function summarizeKhataEntries(entries) {
  const customers = {};
  entries.forEach((entry) => {
    const name = entry.customer_name;
    if (!customers[name]) {
      customers[name] = {
        customer_name: name,
        customer_phone: entry.customer_phone || null,
        party_type: entry.party_type || 'customer',
        total_debit: 0,
        total_credit: 0,
        balance: 0,
        entries: [],
        entry_count: 0,
        last_entry: entry.entry_date || entry.created_at,
      };
    }
    const amount = toMoney(entry.amount);
    if (entry.type === 'debit') {
      customers[name].total_debit += amount;
      customers[name].balance += amount;
    } else {
      customers[name].total_credit += amount;
      customers[name].balance -= amount;
    }
    customers[name].entries.push(entry);
    customers[name].entry_count += 1;
    if ((entry.entry_date || entry.created_at) > customers[name].last_entry) {
      customers[name].last_entry = entry.entry_date || entry.created_at;
    }
    if (!customers[name].customer_phone && entry.customer_phone) customers[name].customer_phone = entry.customer_phone;
  });

  return Object.values(customers)
    .map((customer) => ({
      ...customer,
      total_debit: toMoney(customer.total_debit),
      total_credit: toMoney(customer.total_credit),
      balance: toMoney(customer.balance),
    }))
    .sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance));
}

function stripOptionalInvoiceColumns(payload) {
  const copy = { ...payload };
  delete copy.source_type;
  delete copy.source_id;
  delete copy.customer_gstin;
  return copy;
}

async function safeInvoiceInsert(payload) {
  let result = await supabase.from('invoices').insert([payload]).select().single();
  if (!result.error) return result;

  const retry = await supabase.from('invoices').insert([stripOptionalInvoiceColumns(payload)]).select().single();
  return retry.error ? result : retry;
}

async function safeInvoiceUpdate(invoiceId, userId, payload) {
  let result = await supabase
    .from('invoices')
    .update(payload)
    .eq('id', invoiceId)
    .eq('user_id', userId)
    .select()
    .single();
  if (!result.error) return result;

  const retry = await supabase
    .from('invoices')
    .update(stripOptionalInvoiceColumns(payload))
    .eq('id', invoiceId)
    .eq('user_id', userId)
    .select()
    .single();
  return retry.error ? result : retry;
}

async function findLinkedSalesInvoice(userId, sale) {
  if (sale?.id) {
    const bySource = await supabase
      .from('invoices')
      .select('*')
      .eq('user_id', userId)
      .eq('source_type', 'sales')
      .eq('source_id', String(sale.id))
      .limit(1)
      .maybeSingle();
    if (!bySource.error && bySource.data) return bySource.data;
  }

  const invoiceNumber = normalizePartyName(sale?.invoice_number || (sale?.id ? `SALE-${sale.id}` : ''));
  if (!invoiceNumber) return null;

  const byInvoiceNumber = await supabase
    .from('invoices')
    .select('*')
    .eq('user_id', userId)
    .eq('invoice_number', invoiceNumber)
    .limit(1)
    .maybeSingle();

  return byInvoiceNumber.error ? null : byInvoiceNumber.data;
}

async function syncReceivableFromSale(userId, sale) {
  const customerName = normalizePartyName(sale?.customer_name);
  const amount = toMoney(sale?.amount || sale?.total_amount);
  if (!userId || !customerName || amount <= 0) return null;

  const paidAmount = toMoney(sale?.paid_amount);
  const isPaid = paidAmount >= amount;
  const invoiceNumber = normalizePartyName(sale.invoice_number || `SALE-${sale.id}`);
  const invoiceDate = sale.sale_date || new Date().toISOString().split('T')[0];
  const dueDate = sale.due_date || invoiceDate;

  const payload = {
    user_id: userId,
    customer_name: customerName,
    customer_phone: sale.customer_phone || null,
    customer_gstin: sale.customer_gstin || null,
    invoice_amount: amount,
    invoice_number: invoiceNumber,
    invoice_date: invoiceDate,
    due_date: dueDate,
    items: sale.items || null,
    notes: sale.notes || `Created from Sales ${invoiceNumber}`,
    payment_status: isPaid ? 'Paid' : 'Pending',
    payment_amount: paidAmount > 0 ? paidAmount : null,
    payment_date: isPaid ? new Date().toISOString().split('T')[0] : null,
    days_overdue: calculateDaysOverdue(dueDate, isPaid),
    source_type: 'sales',
    source_id: String(sale.id),
  };

  const existing = await findLinkedSalesInvoice(userId, { ...sale, invoice_number: invoiceNumber });
  const result = existing
    ? await safeInvoiceUpdate(existing.id, userId, payload)
    : await safeInvoiceInsert(payload);

  if (result.error) {
    console.warn('Sales receivable sync failed:', result.error.message);
    return null;
  }

  return result.data;
}

async function deleteReceivableForSale(userId, saleId, invoiceNumber) {
  if (!userId || !saleId) return;
  let deleteResult = await supabase
    .from('invoices')
    .delete()
    .eq('user_id', userId)
    .eq('source_type', 'sales')
    .eq('source_id', String(saleId));

  if (deleteResult.error && invoiceNumber) {
    deleteResult = await supabase
      .from('invoices')
      .delete()
      .eq('user_id', userId)
      .eq('invoice_number', invoiceNumber);
  }

  if (deleteResult.error) {
    console.warn('Sales receivable delete sync failed:', deleteResult.error.message);
  }
}

async function ensureSupplierFromPurchase(userId, purchase) {
  const name = normalizePartyName(purchase?.supplier_name);
  if (!userId || !name) return null;

  const existingResult = await supabase
    .from('suppliers')
    .select('*')
    .eq('user_id', userId)
    .ilike('name', name)
    .limit(1)
    .maybeSingle();

  const existing = existingResult.error ? null : existingResult.data;
  if (existing) {
    const updates = {};
    if (purchase.supplier_phone && !existing.phone) updates.phone = purchase.supplier_phone;
    if (purchase.supplier_gstin && !existing.gstin) updates.gstin = purchase.supplier_gstin;

    if (Object.keys(updates).length === 0) return existing;

    let updated = await supabase
      .from('suppliers')
      .update(updates)
      .eq('id', existing.id)
      .eq('user_id', userId)
      .select()
      .single();

    if (updated.error && updates.gstin) {
      delete updates.gstin;
      updated = await supabase
        .from('suppliers')
        .update(updates)
        .eq('id', existing.id)
        .eq('user_id', userId)
        .select()
        .single();
    }

    return updated.error ? existing : updated.data;
  }

  const payload = {
    user_id: userId,
    name,
    phone: purchase.supplier_phone || null,
    email: null,
    address: null,
    payment_terms: 30,
    gstin: purchase.supplier_gstin || null,
  };

  let inserted = await supabase.from('suppliers').insert([payload]).select().single();
  if (inserted.error && payload.gstin) {
    delete payload.gstin;
    inserted = await supabase.from('suppliers').insert([payload]).select().single();
  }

  if (inserted.error) {
    console.warn('Supplier sync failed:', inserted.error.message);
    return null;
  }

  return inserted.data;
}

// --- Suppliers ---

app.get('/api/suppliers/:userId', requireOwner, async (req, res) => {
  try {
    const { userId } = req.params;
    const [{ data, error }, { data: purchases, error: purchaseError }] = await Promise.all([
      supabase
        .from('suppliers')
        .select('*')
        .eq('user_id', userId)
        .order('name'),
      supabase
        .from('purchases')
        .select('*')
        .eq('user_id', userId),
    ]);
    if (error) throw error;
    if (purchaseError) throw purchaseError;

    const payableBySupplier = {};
    (purchases || []).forEach((purchase) => {
      const key = normalizePartyKey(purchase.supplier_name);
      if (!key) return;
      if (!payableBySupplier[key]) {
        payableBySupplier[key] = {
          total_payable: 0,
          outstanding_amount: 0,
          purchase_count: 0,
          last_purchase_date: null,
          purchases: [],
        };
      }
      const total = toMoney(purchase.amount);
      const paid = toMoney(purchase.paid_amount);
      payableBySupplier[key].total_payable += total;
      payableBySupplier[key].outstanding_amount += Math.max(total - paid, 0);
      payableBySupplier[key].purchase_count += 1;
      payableBySupplier[key].purchases.push({
        id: purchase.id,
        bill_number: purchase.bill_number || null,
        purchase_date: purchase.purchase_date || purchase.created_at || null,
        due_date: purchase.due_date || null,
        status: purchase.status || (paid >= total ? 'paid' : paid > 0 ? 'partial' : 'unpaid'),
        total_amount: total,
        amount: total,
        paid_amount: paid,
        outstanding_amount: Math.max(total - paid, 0),
        subtotal: toMoney(purchase.subtotal),
        gst_type: purchase.gst_type || null,
        gst_rate: toMoney(purchase.gst_rate),
        gst_amount: toMoney(purchase.gst_amount),
        cgst_amount: toMoney(purchase.cgst_amount),
        sgst_amount: toMoney(purchase.sgst_amount),
        igst_amount: toMoney(purchase.igst_amount),
        notes: purchase.notes || null,
        items: getPurchaseItems(purchase),
      });
      if (
        purchase.purchase_date &&
        (!payableBySupplier[key].last_purchase_date || purchase.purchase_date > payableBySupplier[key].last_purchase_date)
      ) {
        payableBySupplier[key].last_purchase_date = purchase.purchase_date;
      }
    });

    const seenSupplierKeys = new Set();
    const suppliers = (data || []).map((supplier) => {
      seenSupplierKeys.add(normalizePartyKey(supplier.name));
      return ({
      ...supplier,
      total_payable: Math.round((payableBySupplier[normalizePartyKey(supplier.name)]?.total_payable || 0) * 100) / 100,
      outstanding_amount: Math.round((payableBySupplier[normalizePartyKey(supplier.name)]?.outstanding_amount || 0) * 100) / 100,
      purchase_count: payableBySupplier[normalizePartyKey(supplier.name)]?.purchase_count || 0,
      last_purchase_date: payableBySupplier[normalizePartyKey(supplier.name)]?.last_purchase_date || null,
      purchases: payableBySupplier[normalizePartyKey(supplier.name)]?.purchases || [],
      inferred_from_purchases: false,
    });
    });

    Object.entries(payableBySupplier).forEach(([key, totals]) => {
      if (seenSupplierKeys.has(key)) return;
      const sourcePurchase = (purchases || []).find((purchase) => normalizePartyKey(purchase.supplier_name) === key);
      suppliers.push({
        id: `purchase-supplier:${key}`,
        user_id: userId,
        name: normalizePartyName(sourcePurchase?.supplier_name || key),
        phone: sourcePurchase?.supplier_phone || null,
        email: null,
        address: null,
        payment_terms: 30,
        gstin: sourcePurchase?.supplier_gstin || null,
        total_payable: Math.round(totals.total_payable * 100) / 100,
        outstanding_amount: Math.round(totals.outstanding_amount * 100) / 100,
        purchase_count: totals.purchase_count,
        last_purchase_date: totals.last_purchase_date,
        purchases: totals.purchases || [],
        inferred_from_purchases: true,
      });
    });

    res.json({ success: true, suppliers });
  } catch (error) {
    console.error('[suppliers list]', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/suppliers', authMiddleware, async (req, res) => {
  try {
    const { name, phone, email, address, payment_terms, gstin } = req.body;
    const userId = req.user.userId;
    if (!name) return res.status(400).json({ error: 'name required' });

    let { data, error } = await supabase
      .from('suppliers')
      .insert([{ user_id: userId, name, phone: phone || null, email: email || null, address: address || null, payment_terms: payment_terms || 30, gstin: gstin || null }])
      .select()
      .single();

    if (error && gstin) {
      ({ data, error } = await supabase
        .from('suppliers')
        .insert([{ user_id: userId, name, phone: phone || null, email: email || null, address: address || null, payment_terms: payment_terms || 30 }])
        .select()
        .single());
    }

    if (error) throw error;
    res.json({ success: true, supplier: data });
  } catch (error) {
    console.error('[suppliers create]', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/suppliers/:supplierId', authMiddleware, async (req, res) => {
  try {
    const { supplierId } = req.params;
    const { name, phone, email, address, payment_terms, gstin } = req.body;
    const updates = { name, phone, email, address, payment_terms, gstin: gstin || null };
    Object.keys(updates).forEach((key) => updates[key] === undefined && delete updates[key]);

    let { data, error } = await supabase
      .from('suppliers')
      .update(updates)
      .eq('id', supplierId)
      .eq('user_id', req.user.userId)
      .select()
      .single();

    if (error && updates.gstin !== undefined) {
      delete updates.gstin;
      ({ data, error } = await supabase
        .from('suppliers')
        .update(updates)
        .eq('id', supplierId)
        .eq('user_id', req.user.userId)
        .select()
        .single());
    }
    if (error) throw error;
    res.json({ success: true, supplier: data });
  } catch (error) {
    console.error('[suppliers update]', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/suppliers/:supplierId/delete', authMiddleware, async (req, res) => {
  try {
    const { supplierId } = req.params;
    const { error } = await supabase.from('suppliers').delete().eq('id', supplierId).eq('user_id', req.user.userId);
    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// HEALTH CHECK
// ============================================

// ============================================
// AI INSIGHTS
// ============================================

app.get('/api/ai-insights/:userId', requireOwner, async (req, res) => {
  const { userId } = req.params;
  try {
    const [{ data: invoices }, { data: calls }, { data: movements }, { data: products }] = await Promise.all([
      supabase.from('invoices').select('*').eq('user_id', userId),
      supabase.from('call_logs').select('*').eq('user_id', userId),
      supabase.from('stock_movements').select('*, products(name)').eq('user_id', userId),
      supabase.from('products').select('*').eq('user_id', userId),
    ]);

    const safeInv = invoices || [];
    const safeCalls = calls || [];
    const safeMov = movements || [];
    const safeProd = products || [];

    // Customer stats
    const custMap = {};
    safeInv.forEach(inv => {
      if (!custMap[inv.customer_name]) custMap[inv.customer_name] = { name: inv.customer_name, total: 0, paid: 0, pending: 0, invoices: 0 };
      custMap[inv.customer_name].total += Number(inv.invoice_amount);
      custMap[inv.customer_name].invoices += 1;
      if (inv.payment_status === 'Paid') custMap[inv.customer_name].paid += Number(inv.payment_amount || inv.invoice_amount);
      else custMap[inv.customer_name].pending += Number(inv.invoice_amount);
    });
    const customers = Object.values(custMap).sort((a, b) => b.total - a.total);

    // Product sales from stock_movements out
    const prodMap = {};
    safeMov.filter(m => m.movement_type === 'out').forEach(m => {
      const name = m.products?.name || m.product_id;
      if (!prodMap[name]) prodMap[name] = { name, units_sold: 0 };
      prodMap[name].units_sold += m.quantity;
    });
    const productSales = Object.values(prodMap).sort((a, b) => b.units_sold - a.units_sold);

    // Call effectiveness
    const totalCalls = safeCalls.length;
    const pickedUp = safeCalls.filter(c => c.did_pick_up).length;
    const promised = safeCalls.filter(c => c.promised_payment_date).length;

    // Build context for Groq
    const context = `
Business Data Summary:
- Total invoices: ${safeInv.length}, Paid: ${safeInv.filter(i=>i.payment_status==='Paid').length}, Pending: ${safeInv.filter(i=>i.payment_status!=='Paid').length}
- Total outstanding: ₹${safeInv.filter(i=>i.payment_status!=='Paid').reduce((s,i)=>s+Number(i.invoice_amount),0).toLocaleString('en-IN')}
- Total collected: ₹${safeInv.filter(i=>i.payment_status==='Paid').reduce((s,i)=>s+Number(i.payment_amount||i.invoice_amount),0).toLocaleString('en-IN')}

Top customers by purchase value:
${customers.slice(0,5).map((c,i)=>`${i+1}. ${c.name}: ₹${c.total.toLocaleString('en-IN')} total, ₹${c.paid.toLocaleString('en-IN')} paid, ₹${c.pending.toLocaleString('en-IN')} pending`).join('\n')}

Lowest buying customers:
${customers.slice(-3).map((c,i)=>`${i+1}. ${c.name}: ₹${c.total.toLocaleString('en-IN')} total`).join('\n')}

Product sales (stock out movements):
${productSales.length ? productSales.map((p,i)=>`${i+1}. ${p.name}: ${p.units_sold} units sold`).join('\n') : 'No sales data yet'}

Products in inventory: ${safeProd.length}, Low stock: ${safeProd.filter(p=>p.current_stock>0&&p.current_stock<=p.low_stock_alert).length}, Out of stock: ${safeProd.filter(p=>p.current_stock===0).length}

Calls made: ${totalCalls}, Pick-up rate: ${totalCalls ? Math.round(pickedUp/totalCalls*100) : 0}%, Promises secured: ${promised}
`;

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 600,
        messages: [
          { role: 'system', content: 'You are a sharp business analyst for Indian MSMEs. Given data, provide 4-5 specific, actionable insights in plain English. Be direct and data-driven. Format as a JSON array of objects: [{title, insight, action, type}] where type is "success"|"warning"|"danger"|"info". No markdown, pure JSON only.' },
          { role: 'user', content: context }
        ]
      })
    });
    const groqData = await response.json();
    let insights = [];
    try {
      const text = groqData.choices[0]?.message?.content || '[]';
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      insights = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
    } catch(e) { insights = []; }

    res.json({
      success: true,
      stats: { customers: customers.slice(0,5), bottomCustomers: customers.slice(-3), productSales, totalCalls, pickedUp, promised },
      insights
    });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// DEEP AI ANALYSIS (Groq llama-3.3-70b — free)
// ============================================

app.get('/api/ai-deep-analysis/:userId', requireOwner, async (req, res) => {
  const { userId } = req.params;
  try {
    const [{ data: invoices }, { data: calls }, { data: movements }, { data: products }, { data: suppliers }] = await Promise.all([
      supabase.from('invoices').select('*').eq('user_id', userId),
      supabase.from('call_logs').select('*').eq('user_id', userId),
      supabase.from('stock_movements').select('*, products(name)').eq('user_id', userId),
      supabase.from('products').select('*').eq('user_id', userId),
      supabase.from('suppliers').select('*').eq('user_id', userId),
    ]);

    const inv = invoices || [];
    const cls = calls || [];
    const mov = movements || [];
    const prd = products || [];
    const sup = suppliers || [];

    const paid = inv.filter(i => i.payment_status === 'Paid');
    const pending = inv.filter(i => i.payment_status !== 'Paid');
    const totalOutstanding = pending.reduce((s, i) => s + Number(i.invoice_amount), 0);
    const totalRecovered = paid.reduce((s, i) => s + Number(i.payment_amount || i.invoice_amount), 0);
    const recoveryRate = inv.length ? Math.round(paid.length / inv.length * 100) : 0;

    // Customer breakdown
    const custMap = {};
    inv.forEach(i => {
      if (!custMap[i.customer_name]) custMap[i.customer_name] = { name: i.customer_name, phone: i.customer_phone, total: 0, paid: 0, pending: 0, overdue: 0, invoices: 0 };
      custMap[i.customer_name].total += Number(i.invoice_amount);
      custMap[i.customer_name].invoices++;
      if (i.payment_status === 'Paid') custMap[i.customer_name].paid += Number(i.payment_amount || i.invoice_amount);
      else { custMap[i.customer_name].pending += Number(i.invoice_amount); custMap[i.customer_name].overdue = Math.max(custMap[i.customer_name].overdue, i.days_overdue); }
    });
    const customers = Object.values(custMap).sort((a, b) => b.pending - a.pending);

    const callsByCustomer = {};
    cls.forEach(c => {
      if (!callsByCustomer[c.customer_name]) callsByCustomer[c.customer_name] = { calls: 0, pickup: 0 };
      callsByCustomer[c.customer_name].calls++;
      if (c.did_pick_up) callsByCustomer[c.customer_name].pickup++;
    });

    const lowStock = prd.filter(p => p.current_stock > 0 && p.current_stock <= p.low_stock_alert);
    const outOfStock = prd.filter(p => p.current_stock === 0);
    const stockValue = prd.reduce((s, p) => s + (Number(p.unit_price) * Number(p.current_stock)), 0);

    const prompt = `You are a senior business analyst for Indian MSMEs. Analyze this business data and produce a comprehensive, honest, and actionable report.

BUSINESS DATA:
Business: Collections & Inventory Management

INVOICES:
- Total: ${inv.length} | Paid: ${paid.length} | Pending: ${pending.length}
- Outstanding: ₹${totalOutstanding.toLocaleString('en-IN')} | Recovered: ₹${totalRecovered.toLocaleString('en-IN')}
- Recovery Rate: ${recoveryRate}% (Industry avg: 40%)

CUSTOMERS (sorted by pending amount):
${customers.slice(0, 8).map(c => `- ${c.name}: ₹${c.pending.toLocaleString('en-IN')} pending, ₹${c.paid.toLocaleString('en-IN')} paid, overdue ${c.overdue} days, calls: ${callsByCustomer[c.name]?.calls || 0} (pickup: ${callsByCustomer[c.name]?.pickup || 0})`).join('\n')}

CALLS: ${cls.length} total, ${cls.filter(c => c.did_pick_up).length} picked up, ${cls.filter(c => c.promised_payment_date).length} payment promises secured

INVENTORY:
- Products: ${prd.length} | Stock Value: ₹${stockValue.toLocaleString('en-IN')}
- Low stock: ${lowStock.map(p => `${p.name} (${p.current_stock} left)`).join(', ') || 'none'}
- Out of stock: ${outOfStock.map(p => p.name).join(', ') || 'none'}
- Stock movements (out): ${mov.filter(m => m.movement_type === 'out').length} dispatches

SUPPLIERS: ${sup.length} suppliers on record

Return a JSON object with this exact structure (no markdown, pure JSON):
{
  "health_score": <number 0-100>,
  "health_label": <"Excellent"|"Good"|"Average"|"Needs Work"|"Critical">,
  "health_color": <"#16a34a"|"#65a30d"|"#d97706"|"#ea580c"|"#dc2626">,
  "executive_summary": "<2-3 sentences honest overview>",
  "top_actions": [
    {"priority": 1, "action": "<specific action>", "impact": "<expected result>", "urgency": "TODAY"|"THIS WEEK"|"THIS MONTH"}
  ],
  "sections": [
    {
      "id": "collections",
      "title": "💰 Collections Analysis",
      "insights": ["<specific insight with numbers>"],
      "customers": [{"name": "", "status": "CHASE NOW"|"FOLLOW UP"|"RELIABLE"|"RISKY", "reason": "", "suggested_action": ""}]
    },
    {
      "id": "cashflow",
      "title": "📊 Cash Flow Health",
      "insights": ["<specific insight>"],
      "metrics": [{"label": "", "value": "", "trend": "up"|"down"|"neutral"}]
    },
    {
      "id": "inventory",
      "title": "📦 Inventory Intelligence",
      "insights": ["<specific insight>"],
      "alerts": [{"product": "", "issue": "", "action": ""}]
    },
    {
      "id": "strategy",
      "title": "🎯 This Week's Strategy",
      "insights": ["<specific actionable step with expected outcome>"]
    },
    {
      "id": "risks",
      "title": "⚠️ Risks & Warnings",
      "insights": ["<specific risk>"]
    }
  ]
}`;

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 3000,
        temperature: 0.3,
        messages: [
          { role: 'system', content: 'You are a senior business analyst for Indian MSMEs. Always respond with valid JSON only — no markdown, no explanation, just the JSON object.' },
          { role: 'user', content: prompt }
        ]
      })
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Groq API error');

    const text = data.choices?.[0]?.message?.content || '{}';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const analysis = jsonMatch ? JSON.parse(jsonMatch[0]) : {};

    res.json({ success: true, analysis });
  } catch (err) {
    console.error('Deep analysis error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// CAMERA / OCR SCAN
// ============================================

const VISION_MODEL = process.env.GROQ_VISION_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct';
const DEFAULT_SCAN_AI_PROVIDERS = ['groq', 'gemini', 'openrouter', 'huggingface', 'ocrspace'];

function cleanScanString(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  const lower = text.toLowerCase();
  if (['null', 'undefined', 'n/a', 'na', 'none', 'not found', 'not available', '-'].includes(lower)) return null;
  return text;
}

function pickScanValue(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const key of keys) {
    const value = obj[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  const lowerMap = Object.keys(obj).reduce((acc, key) => {
    acc[key.toLowerCase()] = obj[key];
    return acc;
  }, {});
  for (const key of keys) {
    const value = lowerMap[key.toLowerCase()];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function parseScanNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
  const text = cleanScanString(value);
  if (!text) return null;
  const normalized = text.replace(/,/g, '').replace(/\s+/g, '').replace(/\/-$/, '');
  const match = normalized.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = parseFloat(match[0]);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : null;
}

function makeIsoDate(year, month, day) {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!y || !m || !d || m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function parseScanDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().split('T')[0];
  const text = cleanScanString(value);
  if (!text) return null;
  const compact = text.replace(/\s+/g, ' ').trim();
  let match = compact.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (match) return makeIsoDate(match[1], match[2], match[3]);

  match = compact.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (match) {
    const year = Number(match[3]) < 100 ? 2000 + Number(match[3]) : Number(match[3]);
    return makeIsoDate(year, match[2], match[1]);
  }

  const months = {
    jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
    may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
    september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
  };
  match = compact.match(/(\d{1,2})\s*[- ]\s*([A-Za-z]{3,9})\s*[-, ]\s*(\d{2,4})/);
  if (match) {
    const year = Number(match[3]) < 100 ? 2000 + Number(match[3]) : Number(match[3]);
    return makeIsoDate(year, months[match[2].toLowerCase()], match[1]);
  }
  match = compact.match(/([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{2,4})/);
  if (match) {
    const year = Number(match[3]) < 100 ? 2000 + Number(match[3]) : Number(match[3]);
    return makeIsoDate(year, months[match[1].toLowerCase()], match[2]);
  }

  const parsed = new Date(compact);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().split('T')[0];
  return null;
}

function extractBalancedJson(text) {
  const cleaned = String(text || '').replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  const start = cleaned.indexOf('{');
  if (start === -1) return '';
  let depth = 0;
  let inString = false;
  let quote = '';
  let escaped = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return cleaned.slice(start, i + 1);
    }
  }
  return cleaned.slice(start);
}

function parseScanJson(rawText) {
  const json = extractBalancedJson(rawText);
  if (!json) return {};
  const attempts = [
    json,
    json.replace(/(:\s*)(-?\d{1,3}(?:,\d{2,3})+(?:\.\d+)?)(\s*[,}])/g, (_, prefix, number, suffix) => `${prefix}${number.replace(/,/g, '')}${suffix}`),
    json.replace(/,\s*([}\]])/g, '$1'),
    json
      .replace(/(:\s*)(-?\d{1,3}(?:,\d{2,3})+(?:\.\d+)?)(\s*[,}])/g, (_, prefix, number, suffix) => `${prefix}${number.replace(/,/g, '')}${suffix}`)
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/([{,]\s*)'([^']+?)'\s*:/g, '$1"$2":')
      .replace(/:\s*'([^']*?)'/g, ': "$1"'),
  ];
  for (const attempt of attempts) {
    try { return JSON.parse(attempt); } catch (_) {}
  }
  return {};
}

function imageToDataUrl(image, mimeType = 'image/jpeg') {
  const raw = cleanScanString(image);
  if (!raw) return null;
  if (/^data:/i.test(raw)) return raw;
  const safeMime = cleanScanString(mimeType) || 'image/jpeg';
  return `data:${safeMime};base64,${raw.replace(/^base64,/i, '')}`;
}

function splitDataUrl(dataUrl) {
  const text = cleanScanString(dataUrl);
  const match = text?.match(/^data:([^;,]+);base64,(.+)$/i);
  if (!match) return { mimeType: 'image/jpeg', base64: text || '' };
  return { mimeType: match[1], base64: match[2] };
}

function validateScanImagePayload(image, mimeType = 'image/jpeg') {
  const allowed = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
  const safeMime = String(mimeType || '').toLowerCase();
  if (!allowed.has(safeMime)) return { valid: false, error: 'Unsupported document type' };
  const { base64 } = splitDataUrl(image);
  const approxBytes = Math.ceil(String(base64 || '').length * 0.75);
  if (approxBytes > 5 * 1024 * 1024) return { valid: false, error: 'Document is too large' };
  return { valid: true };
}

function getConfiguredVisionProviders() {
  const rawOrder = cleanScanString(process.env.SCAN_AI_PROVIDERS);
  const order = rawOrder
    ? rawOrder.split(',').map(item => item.trim().toLowerCase()).filter(Boolean)
    : DEFAULT_SCAN_AI_PROVIDERS;
  return [...new Set(order)].filter(provider => DEFAULT_SCAN_AI_PROVIDERS.includes(provider));
}

function getVisionModels(envName, fallback) {
  const raw = cleanScanString(process.env[`${envName}S`]) || cleanScanString(process.env[envName]) || fallback;
  return String(raw || '').split(',').map(model => model.trim()).filter(Boolean);
}

function hasMeaningfulScanData(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).some((entry) => {
    if (entry === null || entry === undefined || entry === '') return false;
    if (Array.isArray(entry)) return entry.length > 0;
    return true;
  });
}

function getProviderRawText(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (Array.isArray(content)) {
    return content.map(part => part?.text || part?.content || '').filter(Boolean).join('\n').trim();
  }
  if (content && typeof content === 'object') return cleanScanString(content.text || content.content) || '';
  return cleanScanString(content) || '';
}

function makeVisionError(provider, status, message, data) {
  const err = new Error(message || `${provider} vision API error`);
  err.status = status;
  err.provider = provider;
  err.providerData = data;
  return err;
}

function isVisionRateLimit(err) {
  const lower = String(err?.message || '').toLowerCase();
  return err?.status === 429 || lower.includes('rate limit') || lower.includes('quota') || lower.includes('too many requests') || lower.includes('tokens per');
}

function findNextOcrValue(lines, labelRegex, validator = value => Boolean(value)) {
  const index = lines.findIndex(line => labelRegex.test(line));
  if (index === -1) return null;
  const inline = lines[index].replace(labelRegex, '').replace(/^[:\s.-]+/, '').trim();
  if (inline && validator(inline)) return inline;
  for (let i = index + 1; i < Math.min(lines.length, index + 5); i++) {
    const candidate = lines[i].trim();
    if (candidate && validator(candidate)) return candidate;
  }
  return null;
}

function parseOcrInvoiceNumber(lines, text) {
  const direct = text.match(/\b(?:invoice|bill|challan)\s*(?:no|number|#)?\.?\s*[:#-]?\s*([A-Z0-9][A-Z0-9/.-]{1,30})/i);
  const directValue = cleanScanString(direct?.[1]);
  if (directValue && !/^(no|number|dated|e-way)$/i.test(directValue)) return directValue;
  return findNextOcrValue(
    lines,
    /\b(?:invoice|bill|challan)\s*(?:no|number|#)?\.?\b/i,
    value => /^[A-Z0-9][A-Z0-9/.-]{1,30}$/i.test(value) && !/dated|delivery|supplier|buyer|e-way/i.test(value),
  );
}

function parseOcrDate(lines, text) {
  const datePattern = /\b(\d{1,2}\s*[-/. ]\s*(?:\d{1,2}|jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\s*[-/. ,]\s*\d{2,4})\b/i;
  const datedValue = findNextOcrValue(lines, /\bdated\b/i, value => datePattern.test(value) || Boolean(parseScanDate(value)));
  if (datedValue) return parseScanDate(datedValue.match(datePattern)?.[1] || datedValue);
  const match = text.match(datePattern);
  return parseScanDate(match?.[1]);
}

function parseOcrBuyerName(lines) {
  const buyerIndex = lines.findIndex(line => /^\s*(buyer|bill to|party|customer)\b/i.test(line));
  if (buyerIndex === -1) return null;
  const noise = /^(gstin|gstin\/uin|pan|pan\/it|state name|contact|email|e-mail|mode\/terms|supplier|invoice|dated|delivery|terms|despatched|destination)\b/i;
  const candidates = [];
  for (let i = buyerIndex + 1; i < Math.min(lines.length, buyerIndex + 8); i++) {
    const line = cleanScanString(lines[i]);
    if (!line || noise.test(line) || /\b\d{2}[A-Z0-9]{13}\b/i.test(line)) continue;
    if (/^[\d\s,./-]+$/.test(line)) continue;
    candidates.push(line.replace(/^[:\s.-]+/, '').trim());
  }
  if (!candidates.length) return null;
  if (/^cash$/i.test(candidates[0]) && candidates[1]) return candidates[1];
  return candidates[0];
}

function parseOcrTotalAmount(lines) {
  const amountPattern = /(?:₹|rs\.?|inr)?\s*(-?\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?|-?\d+\.\d{2})/ig;
  const preferred = [];
  const fallback = [];
  lines.forEach((line, index) => {
    const matches = [...line.matchAll(amountPattern)].map(match => parseScanNumber(match[1])).filter(amount => amount !== null);
    if (!matches.length) return;
    const lower = line.toLowerCase();
    const entry = { index, values: matches };
    if (/[₹]/.test(line) || lower.includes('grand') || lower.includes('amount chargeable') || lower.includes('e. & o.e') || lower.includes('e & o.e')) preferred.push(entry);
    if (lower.includes('total')) preferred.push(entry);
    fallback.push(entry);
  });

  const chooseLast = (entries) => {
    for (let i = entries.length - 1; i >= 0; i--) {
      const value = entries[i].values[entries[i].values.length - 1];
      if (value > 0) return value;
    }
    return null;
  };
  return chooseLast(preferred) ?? chooseLast(fallback);
}

function parseOcrTaxAmount(lines, label) {
  const labelRegex = new RegExp(label, 'i');
  const amountPattern = /(-?\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?|-?\d+\.\d{2})/g;
  for (const line of lines) {
    if (!labelRegex.test(line)) continue;
    const values = [...line.matchAll(amountPattern)].map(match => parseScanNumber(match[1])).filter(value => value !== null);
    if (values.length) return values[values.length - 1];
  }
  return null;
}

function parseOcrItems(lines) {
  const itemKeywords = /(machine|lockstitch|overlock|interlock|steam|cloth|button|stand|table|secondhand|industrial|sewing|heat transfer)/i;
  return lines
    .filter(line => itemKeywords.test(line) && !/declaration|service|jurisdiction|bank|subject/i.test(line))
    .slice(0, 8)
    .map((line) => {
      const hsn = line.match(/\b\d{8}\b/)?.[0] || null;
      const qty = parseScanNumber(line.match(/\b(\d+)\s*(?:set|pcs|nos?|piece)\b/i)?.[1]) ?? null;
      const amountMatches = [...line.matchAll(/\b\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?\b/g)].map(match => parseScanNumber(match[0]));
      const amount = amountMatches.length ? amountMatches[amountMatches.length - 1] : null;
      const description = line
        .replace(/\b\d{8}\b/g, '')
        .replace(/\b\d+\s*(?:set|pcs|nos?|piece)\b/ig, '')
        .replace(/\b\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?\b/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      return { description: description || line, hsn_sac: hsn, qty: qty || 1, unit: null, price: null, amount };
    });
}

function parseInvoiceFromOcrText(rawText) {
  const text = cleanScanString(rawText) || '';
  const lines = text.split(/\r?\n/).map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const gstins = [...text.matchAll(/\b\d{2}[A-Z0-9]{13}\b/gi)].map(match => match[0].toUpperCase());
  const phone = text.match(/\b(?:\+?91[-\s]?)?[6-9]\d{9}\b/)?.[0] || null;
  const invoiceNumber = parseOcrInvoiceNumber(lines, text);
  const invoiceDate = parseOcrDate(lines, text);
  const customerName = parseOcrBuyerName(lines);
  const totalAmount = parseOcrTotalAmount(lines);
  const igstAmount = parseOcrTaxAmount(lines, 'igst|integrated tax|output igst');
  const cgstAmount = parseOcrTaxAmount(lines, 'cgst|central tax|output cgst');
  const sgstAmount = parseOcrTaxAmount(lines, 'sgst|state tax|output sgst');
  const gstAmount = [igstAmount, cgstAmount, sgstAmount].filter(value => value !== null).reduce((sum, value) => sum + value, 0) || null;

  return {
    customer_name: customerName,
    customer_phone: phone,
    customer_gstin: gstins[1] || null,
    supplier_name: lines.find(line => /enterprises|trading|company|co\.|fashion|spares|clothing|creations/i.test(line)) || null,
    seller_gstin: gstins[0] || null,
    invoice_number: invoiceNumber,
    bill_number: invoiceNumber,
    invoice_date: invoiceDate,
    purchase_date: invoiceDate,
    sale_date: invoiceDate,
    items: parseOcrItems(lines),
    gst_amount: gstAmount,
    igst_amount: igstAmount,
    cgst_amount: cgstAmount,
    sgst_amount: sgstAmount,
    total_amount: totalAmount,
    invoice_amount: totalAmount,
    notes: 'Extracted with OCR fallback',
    ocr_text: text.substring(0, 3000),
  };
}

function hasUsableOcrInvoiceData(parsed) {
  return Boolean(
    parsed?.total_amount ||
    parsed?.invoice_number ||
    parsed?.customer_name ||
    parsed?.customer_gstin ||
    (Array.isArray(parsed?.items) && parsed.items.length > 0)
  );
}

function normalizeScanItems(value) {
  const rawItems = Array.isArray(value) ? value : [];
  return rawItems.map((item) => {
    if (typeof item === 'string') {
      return { description: item, hsn_sac: null, qty: 1, unit: null, price: null, amount: null };
    }
    const description = cleanScanString(pickScanValue(item, ['description', 'item', 'item_name', 'name', 'product', 'particulars']));
    const qty = parseScanNumber(pickScanValue(item, ['qty', 'quantity', 'pcs', 'nos']));
    const price = parseScanNumber(pickScanValue(item, ['price', 'rate', 'unit_price', 'unit_rate']));
    const explicitAmount = parseScanNumber(pickScanValue(item, ['amount', 'total', 'line_total', 'taxable_amount', 'value']));
    const amount = explicitAmount ?? (qty && price ? Math.round(qty * price * 100) / 100 : null);
    return {
      description: description || 'Item',
      hsn_sac: cleanScanString(pickScanValue(item, ['hsn_sac', 'hsn', 'sac'])),
      qty: qty ?? 1,
      unit: cleanScanString(pickScanValue(item, ['unit', 'uom'])) || null,
      price: price ?? null,
      amount: amount ?? null,
    };
  }).filter(item => item.description || item.amount);
}

function normalizeScanExtraction(raw, type = 'invoice') {
  const source = raw && typeof raw === 'object' ? raw : {};
  const items = normalizeScanItems(pickScanValue(source, ['items', 'line_items', 'products', 'particulars']));
  const subtotal = parseScanNumber(pickScanValue(source, ['subtotal', 'sub_total', 'taxable_amount', 'taxable_value', 'before_tax_amount']));
  const igstAmount = parseScanNumber(pickScanValue(source, ['igst_amount', 'igst']));
  const cgstAmount = parseScanNumber(pickScanValue(source, ['cgst_amount', 'cgst']));
  const sgstAmount = parseScanNumber(pickScanValue(source, ['sgst_amount', 'sgst']));
  const componentGst = [igstAmount, cgstAmount, sgstAmount].filter(n => n !== null).reduce((sum, n) => sum + n, 0);
  const gstAmount = parseScanNumber(pickScanValue(source, ['gst_amount', 'tax_amount', 'total_tax', 'tax'])) ?? (componentGst > 0 ? componentGst : null);
  let totalAmount = parseScanNumber(pickScanValue(source, [
    'total_amount', 'grand_total', 'invoice_total', 'bill_total', 'net_amount', 'amount', 'invoice_amount', 'bill_amount', 'total',
  ]));
  if (totalAmount === null && subtotal !== null && gstAmount !== null) totalAmount = Math.round((subtotal + gstAmount) * 100) / 100;
  if (totalAmount === null && items.length) {
    const itemTotal = items.reduce((sum, item) => sum + Number(item.amount || 0), 0);
    if (itemTotal > 0) totalAmount = Math.round(itemTotal * 100) / 100;
  }

  const invoiceNumber = cleanScanString(pickScanValue(source, [
    'invoice_number', 'invoice_no', 'invoice_num', 'bill_number', 'bill_no', 'challan_no', 'document_number',
  ]));
  const invoiceDate = parseScanDate(pickScanValue(source, [
    'invoice_date', 'bill_date', 'purchase_date', 'sale_date', 'date', 'document_date',
  ]));
  const notes = cleanScanString(pickScanValue(source, ['notes', 'summary', 'description'])) || (items.length ? `${items.length} items` : null);

  const common = {
    invoice_number: invoiceNumber,
    bill_number: invoiceNumber,
    invoice_date: invoiceDate,
    purchase_date: invoiceDate,
    sale_date: invoiceDate,
    due_date: parseScanDate(pickScanValue(source, ['due_date', 'payment_due_date'])),
    items,
    subtotal,
    gst_rate: parseScanNumber(pickScanValue(source, ['gst_rate', 'tax_rate'])),
    gst_amount: gstAmount,
    igst_amount: igstAmount,
    cgst_amount: cgstAmount,
    sgst_amount: sgstAmount,
    igst_rate: parseScanNumber(pickScanValue(source, ['igst_rate'])),
    cgst_rate: parseScanNumber(pickScanValue(source, ['cgst_rate'])),
    sgst_rate: parseScanNumber(pickScanValue(source, ['sgst_rate'])),
    total_amount: totalAmount,
    invoice_amount: totalAmount,
    notes,
  };

  if (type === 'purchase') {
    const supplierName = cleanScanString(pickScanValue(source, [
      'supplier_name', 'seller_name', 'vendor_name', 'company_name', 'business_name', 'from', 'billed_by',
    ]));
    const partyName = cleanScanString(pickScanValue(source, ['party_name', 'buyer_name', 'customer_name', 'bill_to', 'consignee']));
    return {
      ...common,
      supplier_name: supplierName,
      party_name: partyName,
      supplier_gstin: cleanScanString(pickScanValue(source, ['supplier_gstin', 'seller_gstin', 'vendor_gstin', 'gstin'])),
      customer_name: partyName,
    };
  }

  return {
    ...common,
    customer_name: cleanScanString(pickScanValue(source, ['customer_name', 'buyer_name', 'party_name', 'bill_to', 'receiver_name', 'consignee'])),
    customer_phone: cleanScanString(pickScanValue(source, ['customer_phone', 'phone', 'mobile', 'contact'])),
    customer_gstin: cleanScanString(pickScanValue(source, ['customer_gstin', 'buyer_gstin', 'party_gstin'])),
    seller_gstin: cleanScanString(pickScanValue(source, ['seller_gstin', 'supplier_gstin', 'vendor_gstin'])),
    supplier_name: cleanScanString(pickScanValue(source, ['supplier_name', 'seller_name', 'business_name', 'company_name'])),
  };
}

function normalizeSupplierExtraction(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    name: cleanScanString(pickScanValue(source, ['name', 'supplier_name', 'vendor_name', 'seller_name', 'company_name'])),
    phone: cleanScanString(pickScanValue(source, ['phone', 'mobile', 'contact'])),
    email: cleanScanString(pickScanValue(source, ['email', 'mail'])),
    address: cleanScanString(pickScanValue(source, ['address', 'billing_address'])),
    payment_terms: parseScanNumber(pickScanValue(source, ['payment_terms', 'credit_days', 'terms'])),
  };
}

async function runGroqVisionExtraction({ prompt, dataUrl, maxTokens }) {
  const apiKey = cleanScanString(process.env.GROQ_API_KEY);
  if (!apiKey) return null;
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: VISION_MODEL,
      messages: [{ role: 'user', content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: dataUrl } },
      ]}],
      max_tokens: maxTokens,
      temperature: 0,
    })
  });

  const data = await response.json().catch(() => ({}));
  const rawText = getProviderRawText(data);
  if (!response.ok) throw makeVisionError('groq', response.status, data.error?.message || 'Groq vision API error', data.error || data);
  const parsed = parseScanJson(rawText);
  if (!hasMeaningfulScanData(parsed)) throw makeVisionError('groq', 422, 'Groq returned no parseable invoice JSON', { rawText: rawText.substring(0, 300) });
  return { provider: 'groq', model: VISION_MODEL, rawText, parsed, status: response.status };
}

async function runGeminiVisionExtraction({ prompt, dataUrl, maxTokens }) {
  const apiKey = cleanScanString(process.env.GEMINI_API_KEY) || cleanScanString(process.env.GOOGLE_API_KEY);
  if (!apiKey) return null;
  const { mimeType, base64 } = splitDataUrl(dataUrl);
  const model = cleanScanString(process.env.GEMINI_VISION_MODEL) || 'gemini-3.5-flash';
  const modelPath = model.replace(/^models\//i, '');
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelPath}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{
        role: 'user',
        parts: [
          { text: prompt },
          { inline_data: { mime_type: mimeType, data: base64 } },
        ],
      }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: maxTokens,
        responseMimeType: 'application/json',
      },
    }),
  });

  const data = await response.json().catch(() => ({}));
  const rawText = (data.candidates?.[0]?.content?.parts || [])
    .map(part => part?.text || '')
    .filter(Boolean)
    .join('\n')
    .trim();
  if (!response.ok) throw makeVisionError('gemini', response.status, data.error?.message || 'Gemini vision API error', data.error || data);
  const parsed = parseScanJson(rawText);
  if (!hasMeaningfulScanData(parsed)) throw makeVisionError('gemini', 422, 'Gemini returned no parseable invoice JSON', { rawText: rawText.substring(0, 300) });
  return { provider: 'gemini', model, rawText, parsed, status: response.status };
}

async function runOpenRouterVisionExtraction({ prompt, dataUrl, maxTokens }) {
  const apiKey = cleanScanString(process.env.OPENROUTER_API_KEY);
  if (!apiKey) return null;
  const models = getVisionModels('OPENROUTER_VISION_MODEL', 'qwen/qwen2.5-vl-72b-instruct:free,qwen/qwen2.5-vl-32b-instruct:free');
  let lastError = null;
  for (const model of models) {
    try {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': process.env.PUBLIC_APP_URL || process.env.FRONTEND_URL || 'https://vantro-flow-frontend.vercel.app',
          'X-Title': 'Vantro Flow Scanner',
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: dataUrl } },
          ]}],
          max_tokens: maxTokens,
          temperature: 0,
        }),
      });
      const data = await response.json().catch(() => ({}));
      const rawText = getProviderRawText(data);
      if (!response.ok) throw makeVisionError('openrouter', response.status, data.error?.message || `OpenRouter model ${model} failed`, data.error || data);
      const parsed = parseScanJson(rawText);
      if (!hasMeaningfulScanData(parsed)) throw makeVisionError('openrouter', 422, `OpenRouter model ${model} returned no parseable invoice JSON`, { rawText: rawText.substring(0, 300) });
      return { provider: 'openrouter', model, rawText, parsed, status: response.status };
    } catch (err) {
      err.provider = err.provider || 'openrouter';
      err.model = err.model || model;
      lastError = err;
      if (!isVisionRateLimit(err) && err.status !== 404 && err.status !== 422) break;
    }
  }
  if (lastError) throw lastError;
  return null;
}

async function runHuggingFaceVisionExtraction({ prompt, dataUrl, maxTokens }) {
  const apiKey = cleanScanString(process.env.HF_TOKEN) || cleanScanString(process.env.HUGGINGFACE_API_KEY);
  if (!apiKey) return null;
  const model = cleanScanString(process.env.HF_VISION_MODEL) || 'zai-org/GLM-4.5V';
  const response = await fetch('https://router.huggingface.co/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: dataUrl } },
      ]}],
      max_tokens: maxTokens,
      temperature: 0,
    }),
  });

  const data = await response.json().catch(() => ({}));
  const rawText = getProviderRawText(data);
  if (!response.ok) throw makeVisionError('huggingface', response.status, data.error?.message || 'Hugging Face vision API error', data.error || data);
  const parsed = parseScanJson(rawText);
  if (!hasMeaningfulScanData(parsed)) throw makeVisionError('huggingface', 422, 'Hugging Face returned no parseable invoice JSON', { rawText: rawText.substring(0, 300) });
  return { provider: 'huggingface', model, rawText, parsed, status: response.status };
}

async function runOcrSpaceExtraction({ dataUrl }) {
  if (/^(true|1|yes)$/i.test(cleanScanString(process.env.DISABLE_OCRSPACE_FALLBACK) || '')) return null;
  const apiKey = cleanScanString(process.env.OCRSPACE_API_KEY) || cleanScanString(process.env.OCR_SPACE_API_KEY) || 'helloworld';
  const form = new FormData();
  form.append('base64Image', dataUrl);
  form.append('language', 'eng');
  form.append('isOverlayRequired', 'false');
  form.append('isTable', 'true');
  form.append('scale', 'true');
  form.append('OCREngine', cleanScanString(process.env.OCRSPACE_ENGINE) || '2');

  const response = await fetch('https://api.ocr.space/parse/image', {
    method: 'POST',
    headers: { apikey: apiKey },
    body: form,
  });
  const data = await response.json().catch(() => ({}));
  const rawText = (data.ParsedResults || [])
    .map(result => result?.ParsedText || '')
    .filter(Boolean)
    .join('\n')
    .trim();
  if (!response.ok || data.IsErroredOnProcessing) {
    const message = data.ErrorMessage || data.ErrorDetails || 'OCR.space API error';
    throw makeVisionError('ocrspace', response.status || 500, Array.isArray(message) ? message.join('; ') : message, data);
  }
  const parsed = parseInvoiceFromOcrText(rawText);
  if (!rawText || !hasUsableOcrInvoiceData(parsed)) throw makeVisionError('ocrspace', 422, 'OCR.space returned no readable invoice text', data);
  return { provider: 'ocrspace', model: `engine-${cleanScanString(process.env.OCRSPACE_ENGINE) || '2'}`, rawText, parsed, status: response.status };
}

async function runVisionExtraction({ prompt, image, mimeType = 'image/jpeg', maxTokens = 1200 }) {
  const dataUrl = imageToDataUrl(image, mimeType);
  if (!dataUrl) {
    const err = new Error('image is required');
    err.status = 400;
    throw err;
  }

  const runners = {
    groq: runGroqVisionExtraction,
    gemini: runGeminiVisionExtraction,
    openrouter: runOpenRouterVisionExtraction,
    huggingface: runHuggingFaceVisionExtraction,
    ocrspace: runOcrSpaceExtraction,
  };
  const providerOrder = getConfiguredVisionProviders();
  const providerErrors = [];
  let attempted = 0;

  for (const provider of providerOrder) {
    const runner = runners[provider];
    if (!runner) continue;
    try {
      const result = await runner({ prompt, dataUrl, maxTokens });
      if (!result) continue;
      attempted += 1;
      return { ...result, providersTried: [...providerErrors.map(error => error.provider), provider] };
    } catch (err) {
      attempted += 1;
      providerErrors.push({
        provider: err.provider || provider,
        model: err.model || null,
        status: err.status || 500,
        message: err.message || 'Unknown provider error',
        rateLimited: isVisionRateLimit(err),
      });
      console.warn(`Vision provider ${provider} failed:`, err.message || err);
      continue;
    }
  }

  const err = new Error(providerErrors.length
    ? providerErrors.map(error => `${error.provider}: ${error.message}`).join(' | ')
    : 'No scan AI providers are configured');
  err.status = attempted === 0 ? 503 : providerErrors.every(error => error.rateLimited) ? 429 : 500;
  err.providerErrors = providerErrors;
  throw err;
}

function sendVisionError(res, err, label) {
  const errMsg = err?.message || 'Unknown';
  const providerErrors = Array.isArray(err?.providerErrors) ? err.providerErrors : [];
  const isRateLimit = isVisionRateLimit(err) || (providerErrors.length > 0 && providerErrors.every(error => error.rateLimited));
  if (isRateLimit) {
    return res.status(429).json({
      error: 'rate_limit',
      details: 'All configured AI scan providers are rate limited. Try again in a few minutes.',
      providers: providerErrors,
    });
  }
  const status = err?.status === 400 || err?.status === 503 ? err.status : 500;
  console.error(`${label} scan error:`, errMsg, providerErrors);
  return res.status(status).json({
    error: status === 503 ? 'AI not configured' : 'AI scan failed',
    details: errMsg,
    providers: providerErrors,
  });
}

app.post('/api/scan-document', authMiddleware, async (req, res) => {
  const { image_base64, image, mimeType = 'image/jpeg', scan_type } = req.body; // scan_type: 'invoice' | 'supplier'
  const scanImage = image_base64 || image;
  if (!scanImage) return res.status(400).json({ error: 'No image provided' });
  const validation = validateScanImagePayload(scanImage, mimeType);
  if (!validation.valid) return res.status(400).json({ error: validation.error });

  const invoicePrompt = `You are an expert OCR system for Indian GST invoices, bills, and challans.

Read the full document: seller header, buyer/party block, invoice number, date, items table, taxes, and grand total.

Return ONLY a valid JSON object. Use null when a value is not visible.

{
  "customer_name": "buyer/customer/party name",
  "customer_phone": "phone or mobile if visible",
  "customer_gstin": "buyer GSTIN if visible",
  "supplier_name": "seller/business name at top",
  "seller_gstin": "seller GSTIN if visible",
  "invoice_number": "invoice/bill/challan number",
  "invoice_date": "YYYY-MM-DD",
  "due_date": "YYYY-MM-DD or null",
  "items": [{ "description": "item name", "hsn_sac": "HSN/SAC or null", "qty": number, "unit": "PCS/KG/etc", "price": unit_rate_number, "amount": line_total_number }],
  "subtotal": taxable_amount_before_tax,
  "gst_rate": gst_percent_number,
  "gst_amount": total_tax_amount,
  "igst_amount": igst_amount,
  "cgst_amount": cgst_amount,
  "sgst_amount": sgst_amount,
  "total_amount": grand_total_including_tax,
  "notes": "short item summary"
}

Rules: numbers only, no currency symbols or commas. Dates must be YYYY-MM-DD.`;

  const supplierPrompt = `Extract supplier/vendor details from this document image. Return ONLY a JSON object with these fields (use null if not found):
{"name": "", "phone": "", "email": "", "address": "", "payment_terms": null}`;

  try {
    const { rawText, parsed } = await runVisionExtraction({
      prompt: scan_type === 'supplier' ? supplierPrompt : invoicePrompt,
      image: scanImage,
      mimeType,
      maxTokens: scan_type === 'supplier' ? 500 : 1400,
    });
    const extracted = scan_type === 'supplier'
      ? normalizeSupplierExtraction(parsed)
      : normalizeScanExtraction(parsed, 'invoice');
    res.json({ success: true, extracted, data: extracted, _debug: IS_PRODUCTION ? undefined : rawText.substring(0, 300) });
  } catch (err) {
    sendVisionError(res, err, 'Document');
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    status: 'alive',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    requestId: req.requestId
  });
});

app.get('/api/live', (req, res) => {
  res.status(200).json({ status: 'live' });
});

app.get('/api/ready', (req, res) => {
  // Phase 2C.31W — liveness/config readiness ONLY. DATABASE_URL *presence* is NOT DB
  // connectivity, so this endpoint reports it honestly and never implies a working DB
  // connection. The real DB-connectivity proof is GET /api/health/deep (runs SELECT 1 over
  // the shared pool). This handler performs no DB query and never fakes DB readiness.
  // Removed false-green shape: database: process.env.DATABASE_URL ? 'ok' : 'missing'
  res.json({
    success: true,
    status: 'ready',
    checks: {
      database_configured: !!process.env.DATABASE_URL,
      database_connectivity: 'not_checked',
      authConfig: process.env.JWT_SECRET ? 'ok' : 'missing',
      supabaseConfig: process.env.SUPABASE_URL ? 'ok' : 'missing',
      metrics: process.env.METRICS_TOKEN ? 'ok' : 'missing'
    },
    db_readiness_endpoint: '/api/health/deep',
    ready_for_data_load: false,
    requestId: req.requestId
  });
});

// ── Phase 2C.31T: deep readiness probe (ADDITIVE — does not change /api/health or
// /api/ready). Reports Node liveness + real DB `SELECT 1` (short timeout, over the SAME
// shared application pgPool) + Node->Rust `/health` (existing fail-closed client). Safe
// booleans/status only: no secrets, no env values, no customer/tenant data, no table read,
// no schema mutation, no migration, no agent/workflow/external-send. Always HTTP 200 if the
// process is alive — the `success` body field conveys readiness; this is NOT the Railway
// liveness gate (that remains /api/health). safe_to_load_data is always false.
app.get('/api/health/deep', async (req, res) => {
  try {
    const { deepReadiness } = require('./lib/health/deepReadiness');
    const report = await deepReadiness(pgPool, req.requestId);
    res.status(200).json(report);
  } catch (e) {
    res.status(200).json({
      success: false,
      checks: { node: 'ok', db: 'fail', rust: 'fail' },
      safe_to_load_data: false,
      timestamp: new Date().toISOString(),
      request_id: req.requestId || null,
    });
  }
});

app.post('/api/client-errors', async (req, res) => {
  const { path, message, error_id, browser_info, stack_hash, type = ErrorTaxonomy.CLIENT_UI_ERROR } = req.body;
  
  const event = createErrorEvent({
    req,
    source: 'frontend',
    type,
    severity: 'error',
    safeMessage: message || 'Frontend Client Error',
    metadata: { browser: browser_info, frontendPath: path }
  });
  
  event.error_id = error_id || event.error_id; // trust frontend UUID for tracing
  event.stack_hash = stack_hash || null;
  
  await logErrorEvent(event, supabase);
  res.status(200).json({ success: true, logged: true });
});

// Admin error intelligence routes
app.get('/api/admin/error-events', authMiddleware, adminOnly, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const { data, error } = await supabase.from('error_events').select('*').order('created_at', { ascending: false }).limit(limit);
    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch error events' });
  }
});

app.patch('/api/admin/error-events/:id/resolve', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { data, error } = await supabase.from('error_events').update({ resolved_at: new Date().toISOString() }).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to resolve error event' });
  }
});

app.get('/api/admin/error-summary', authMiddleware, adminOnly, async (req, res) => {
  try {
    // Very basic summary for dashboard
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const { count: totalErrors } = await supabase.from('error_events').select('*', { count: 'exact', head: true }).gte('created_at', today.toISOString());
    const { count: criticalErrors } = await supabase.from('error_events').select('*', { count: 'exact', head: true }).gte('created_at', today.toISOString()).eq('severity', 'critical');
    res.json({ success: true, summary: { totalErrors, criticalErrors } });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch summary' });
  }
});

app.get('/metrics', async (req, res) => {
  const token = process.env.METRICS_TOKEN;
  if (IS_PRODUCTION && (!token || req.headers.authorization !== `Bearer ${token}`)) {
    return res.status(403).json({ error: 'Forbidden', requestId: req.requestId });
  }
  res.set('Content-Type', register.contentType);
  res.send(await register.metrics());
});

// ============================================
// SEED DEMO DATA — DISABLED
// Real users start with zero data. No sample/demo data injected on signup.
// ============================================

app.post('/api/seed/:userId', requireOwner, async (req, res) => {
  // Seed endpoint permanently disabled — users provide their own real data
  return res.status(410).json({ error: 'Seed endpoint disabled' });

  const { userId } = req.params; // unreachable below

  try {
    // Verify user exists
    const { data: user, error: userErr } = await supabase
      .from('users').select('id').eq('id', userId).single();
    if (userErr || !user) return res.status(404).json({ error: 'User not found' });

    const today = new Date();
    const daysAgo = (n) => {
      const d = new Date(today);
      d.setDate(d.getDate() - n);
      return d.toISOString().split('T')[0];
    };

    // --- INVOICES ---
    const invoices = [
      { user_id: userId, customer_name: 'Ramesh Traders', customer_phone: '9876543210', invoice_amount: 45000, invoice_date: daysAgo(62), payment_status: 'Pending', days_overdue: 62 },
      { user_id: userId, customer_name: 'Sunita Enterprises', customer_phone: '9823456789', invoice_amount: 28500, invoice_date: daysAgo(47), payment_status: 'Pending', days_overdue: 47 },
      { user_id: userId, customer_name: 'Kapoor & Sons', customer_phone: '9765432100', invoice_amount: 72000, invoice_date: daysAgo(38), payment_status: 'Pending', days_overdue: 38 },
      { user_id: userId, customer_name: 'Meena Stores', customer_phone: '9812345678', invoice_amount: 15000, invoice_date: daysAgo(31), payment_status: 'Pending', days_overdue: 31 },
      { user_id: userId, customer_name: 'Vijay Hardware', customer_phone: '9988776655', invoice_amount: 33500, invoice_date: daysAgo(22), payment_status: 'Pending', days_overdue: 22 },
      { user_id: userId, customer_name: 'Priya Textiles', customer_phone: '9001234567', invoice_amount: 19000, invoice_date: daysAgo(15), payment_status: 'Pending', days_overdue: 15 },
      { user_id: userId, customer_name: 'Ashok Medical', customer_phone: '9112233445', invoice_amount: 8500,  invoice_date: daysAgo(7),  payment_status: 'Pending', days_overdue: 7  },
      { user_id: userId, customer_name: 'Gupta Electricals', customer_phone: '9556677889', invoice_amount: 52000, invoice_date: daysAgo(55), payment_status: 'Paid', days_overdue: 0, payment_date: daysAgo(20), payment_amount: 52000, payment_method: 'UPI', payment_notes: 'Paid via GPay' },
      { user_id: userId, customer_name: 'Lakshmi Garments', customer_phone: '9443322110', invoice_amount: 24000, invoice_date: daysAgo(40), payment_status: 'Paid', days_overdue: 0, payment_date: daysAgo(10), payment_amount: 24000, payment_method: 'Bank Transfer' },
      { user_id: userId, customer_name: 'Sharma General Store', customer_phone: '9334455667', invoice_amount: 11000, invoice_date: daysAgo(18), payment_status: 'Paid', days_overdue: 0, payment_date: daysAgo(5), payment_amount: 11000, payment_method: 'Cash' },
    ];

    const { data: invData, error: invErr } = await supabase.from('invoices').insert(invoices).select();
    if (invErr) throw invErr;

    // Map customer name → invoice id for call logs
    const invMap = {};
    invData.forEach(i => { invMap[i.customer_name] = i.id; });

    // --- CALL LOGS ---
    const callLogs = [
      { user_id: userId, invoice_id: invMap['Ramesh Traders'],    customer_name: 'Ramesh Traders',    customer_phone: '9876543210', amount: 45000, did_pick_up: true,  call_duration_minutes: 6, promised_payment_date: daysAgo(-3), promised_amount: 45000, notes: 'Promised to pay by end of week. Said he is waiting for his own payment.' },
      { user_id: userId, invoice_id: invMap['Sunita Enterprises'],customer_name: 'Sunita Enterprises',customer_phone: '9823456789', amount: 28500, did_pick_up: false, call_duration_minutes: 0, notes: 'No answer. Tried twice.' },
      { user_id: userId, invoice_id: invMap['Kapoor & Sons'],     customer_name: 'Kapoor & Sons',     customer_phone: '9765432100', amount: 72000, did_pick_up: true,  call_duration_minutes: 12, promised_payment_date: daysAgo(-7), promised_amount: 36000, notes: 'Agreed to pay 50% now, rest in 2 weeks.' },
      { user_id: userId, invoice_id: invMap['Meena Stores'],      customer_name: 'Meena Stores',      customer_phone: '9812345678', amount: 15000, did_pick_up: true,  call_duration_minutes: 3, notes: 'Disputed 2000 in charges. Will verify and pay rest.' },
      { user_id: userId, invoice_id: invMap['Vijay Hardware'],    customer_name: 'Vijay Hardware',    customer_phone: '9988776655', amount: 33500, did_pick_up: false, call_duration_minutes: 0, notes: 'Phone switched off.' },
      { user_id: userId, invoice_id: invMap['Ramesh Traders'],    customer_name: 'Ramesh Traders',    customer_phone: '9876543210', amount: 45000, did_pick_up: true,  call_duration_minutes: 4, notes: 'Follow-up call. He asked for 3 more days.' },
    ];

    const { error: callErr } = await supabase.from('call_logs').insert(callLogs);
    if (callErr) throw callErr;

    // --- SUPPLIERS ---
    const suppliers = [
      { user_id: userId, name: 'National Steel Works',   phone: '9111222333', email: 'sales@nationalsteel.in',   address: '14, Industrial Area, Pune', payment_terms: 30 },
      { user_id: userId, name: 'Bharat Polymers Ltd',    phone: '9222333444', email: 'orders@bharatpolymers.com', address: 'MIDC Phase 2, Nashik',      payment_terms: 45 },
      { user_id: userId, name: 'Rajasthan Textile Mill', phone: '9333444555', email: 'info@rjtextile.co.in',      address: 'Jodhpur Industrial Estate',  payment_terms: 15 },
      { user_id: userId, name: 'Delhi Packaging Co',     phone: '9444555666', email: 'delhi@packagingco.in',      address: 'Okhla Phase 3, New Delhi',   payment_terms: 30 },
    ];

    const { error: supErr } = await supabase.from('suppliers').insert(suppliers);
    if (supErr) throw supErr;

    // --- PRODUCTS ---
    const products = [
      { user_id: userId, name: 'Steel Rods 12mm',    sku: 'STL-001', category: 'Raw Material', unit: 'kg',     unit_price: 85,   current_stock: 450,  low_stock_alert: 100 },
      { user_id: userId, name: 'Polypropylene Bags', sku: 'PKG-002', category: 'Packaging',    unit: 'pcs',    unit_price: 12,   current_stock: 1200, low_stock_alert: 200 },
      { user_id: userId, name: 'Cotton Fabric Roll', sku: 'TEX-003', category: 'Raw Material', unit: 'meters', unit_price: 145,  current_stock: 80,   low_stock_alert: 100 },
      { user_id: userId, name: 'Cardboard Boxes L',  sku: 'PKG-004', category: 'Packaging',    unit: 'pcs',    unit_price: 28,   current_stock: 0,    low_stock_alert: 50  },
      { user_id: userId, name: 'Machine Oil 5L',     sku: 'MNT-005', category: 'Maintenance',  unit: 'cans',   unit_price: 550,  current_stock: 18,   low_stock_alert: 5   },
      { user_id: userId, name: 'Safety Gloves',      sku: 'SAF-006', category: 'Safety',       unit: 'pairs',  unit_price: 75,   current_stock: 35,   low_stock_alert: 20  },
    ];

    const { data: prodData, error: prodErr } = await supabase.from('products').insert(products).select();
    if (prodErr) throw prodErr;

    // --- STOCK MOVEMENTS ---
    const moves = [
      { user_id: userId, product_id: prodData[0].id, movement_type: 'in',  quantity: 500,  unit_cost: 82, reference: 'PO-2024-001', notes: 'Received from National Steel' },
      { user_id: userId, product_id: prodData[0].id, movement_type: 'out', quantity: 50,   reference: 'SO-2024-011', notes: 'Dispatched to Ramesh Traders' },
      { user_id: userId, product_id: prodData[1].id, movement_type: 'in',  quantity: 1500, unit_cost: 11, reference: 'PO-2024-002', notes: 'Received from Bharat Polymers' },
      { user_id: userId, product_id: prodData[1].id, movement_type: 'out', quantity: 300,  reference: 'SO-2024-015', notes: 'Packaging for Kapoor & Sons order' },
      { user_id: userId, product_id: prodData[2].id, movement_type: 'in',  quantity: 150,  unit_cost: 140, reference: 'PO-2024-003', notes: 'From Rajasthan Textile Mill' },
      { user_id: userId, product_id: prodData[2].id, movement_type: 'out', quantity: 70,   reference: 'SO-2024-018', notes: 'Priya Textiles order' },
      { user_id: userId, product_id: prodData[3].id, movement_type: 'in',  quantity: 200,  unit_cost: 26, reference: 'PO-2024-004' },
      { user_id: userId, product_id: prodData[3].id, movement_type: 'out', quantity: 200,  reference: 'SO-2024-020', notes: 'All boxes dispatched' },
    ];

    const { error: movErr } = await supabase.from('stock_movements').insert(moves);
    if (movErr) throw movErr;

    res.json({
      success: true,
      seeded: {
        invoices: invData.length,
        calls: callLogs.length,
        suppliers: suppliers.length,
        products: prodData.length,
        movements: moves.length
      }
    });
  } catch (err) {
    console.error('Seed error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// PROSPECTS / CRM LITE
// ============================================

app.get('/api/prospects/:userId', requireOwner, async (req, res) => {
  const { userId } = req.params;
  try {
    const [{ data, error }, receivables] = await Promise.all([
      supabase
      .from('prospects')
      .select('*, prospect_notes(*)')
      .eq('user_id', userId)
        .order('created_at', { ascending: false }),
      getReceivableRows(userId),
    ]);
    if (error) throw error;

    const prospects = data || [];
    const existingNames = new Set(prospects.map((p) => normalizePartyKey(p.name)));
    const customerMap = {};
    receivables.forEach((row) => {
      const key = normalizePartyKey(row.customer_name);
      if (!key || existingNames.has(key)) return;
      if (!customerMap[key]) {
        customerMap[key] = {
          id: `customer:${key}`,
          user_id: userId,
          name: row.customer_name,
          phone: row.customer_phone || null,
          business_type: 'Customer',
          location: null,
          amount_stuck: 0,
          status: 'customer',
          source_type: 'customer',
          source_label: 'Auto from Sales/Collections',
          invoices_count: 0,
          created_at: row.invoice_date || new Date().toISOString(),
          prospect_notes: [],
        };
      }
      customerMap[key].amount_stuck += row.outstanding_amount;
      customerMap[key].invoices_count += 1;
      if (!customerMap[key].phone && row.customer_phone) customerMap[key].phone = row.customer_phone;
    });

    res.json({ success: true, prospects: [...Object.values(customerMap), ...prospects] });
  } catch (err) {
    console.error('[prospects list]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/prospects', authMiddleware, async (req, res) => {
  try {
    const { name, phone, email, business_type, location, amount_stuck, status } = req.body;
    const { data, error } = await supabase
      .from('prospects')
      .insert([{ user_id: req.user.userId, name, phone, email, business_type, location, amount_stuck: amount_stuck || null, status: status || 'lead' }])
      .select();
    if (error) throw error;
    res.json({ success: true, prospect: data[0] });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/prospects/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;
  try {
    if (id.startsWith('customer:')) return res.status(400).json({ error: 'Auto customers are updated from Sales, Collections, and Khata' });
    const updates = req.body;
    updates.updated_at = new Date();
    if (updates.status === 'trial' && !updates.trial_start_date) {
      updates.trial_start_date = new Date().toISOString().split('T')[0];
      const end = new Date(); end.setDate(end.getDate() + 14);
      updates.trial_end_date = end.toISOString().split('T')[0];
    }
    const { data, error } = await supabase.from('prospects').update(updates).eq('id', id).eq('user_id', req.user.userId).select();
    if (error) throw error;
    res.json({ success: true, prospect: data[0] });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/prospects/:id/delete', authMiddleware, async (req, res) => {
  const { id } = req.params;
  try {
    if (id.startsWith('customer:')) return res.status(400).json({ error: 'Auto customers are removed by clearing Sales/Collections dues' });
    const { error } = await supabase.from('prospects').delete().eq('id', id).eq('user_id', req.user.userId);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/prospects/:id/notes', authMiddleware, async (req, res) => {
  const { id } = req.params;
  try {
    const { text } = req.body;
    const { data: prospect } = await supabase
      .from('prospects')
      .select('id')
      .eq('id', id)
      .eq('user_id', req.user.userId)
      .maybeSingle();
    if (!prospect) return res.status(404).json({ error: 'Prospect not found' });
    const { data, error } = await supabase
      .from('prospect_notes')
      .insert([{ prospect_id: id, text }])
      .select();
    if (error) throw error;
    res.json({ success: true, note: data[0] });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

// ============================================
// CASH FLOW FORECAST
// ============================================

app.get('/api/cash-forecast/:userId', requireOwner, async (req, res) => {
  const { userId } = req.params;
  const { current_cash = 0, days = 30 } = req.query;

  try {
    const cacheKey = buildBusinessCacheKey(userId, `forecast:${current_cash}:${days}`);
    const cached = getCache(cacheKey);
    if (cached) {
      return res.json({ success: true, ...cached, days: Number(days), _cached: true });
    }

    await ensureConnectedBusinessData(userId);
    await syncExistingSalesReceivables(userId);

    const forecast = await calculateCashFlowForecast(userId, current_cash, days);
    setCache(cacheKey, forecast, 60); // 60s TTL

    res.json({
      success: true,
      ...forecast,
      days: Number(days)
    });
  } catch (err) {
    console.error('[cash forecast error]', err);
    const n = Number(days) || 30;
    const cashStart = Number(current_cash) || 0;
    const curve = Array.from({ length: n + 1 }, (_, day) => ({ day, cash: cashStart }));
    res.json({
      success: true,
      cashStart,
      burnRate: 0,
      avgDailyCollections: 0,
      totalOutstanding: 0,
      totalPayable: 0,
      totalOverdue30: 0,
      topOutstanding: [],
      scenarios: {
        pessimistic: { dailyInflow: 0, curve, endCash: cashStart, runwayDays: 999 },
        expected: { dailyInflow: 0, curve, endCash: cashStart, runwayDays: 999 },
        optimistic: { dailyInflow: 0, curve, endCash: cashStart, runwayDays: 999 },
      },
      days: n
    });
  }
});

// ============================================
// DB MIGRATION (safe to call multiple times)
// ============================================

app.post('/api/migrate', requireAdmin, async (req, res) => {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    return res.status(400).json({
      error: 'DATABASE_URL not set',
      instructions: 'Set DATABASE_URL in Railway environment variables to your Supabase PostgreSQL connection string (find it at: Supabase dashboard → Settings → Database → Connection string → URI mode)',
      sql: `CREATE TABLE IF NOT EXISTS prospects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  business_type TEXT DEFAULT 'Distributor',
  location TEXT,
  amount_stuck NUMERIC,
  status TEXT DEFAULT 'cold',
  trial_start_date DATE,
  trial_end_date DATE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS prospect_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id UUID NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_prospects_user_id ON prospects(user_id);
CREATE INDEX IF NOT EXISTS idx_prospect_notes_prospect_id ON prospect_notes(prospect_id);

CREATE TABLE IF NOT EXISTS transactions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  type VARCHAR(10) NOT NULL,
  category VARCHAR(80) NOT NULL,
  amount DECIMAL(14,2) NOT NULL,
  description TEXT,
  party_name VARCHAR(240),
  transaction_date DATE NOT NULL DEFAULT CURRENT_DATE,
  payment_method VARCHAR(50) DEFAULT 'UPI',
  reference VARCHAR(240),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_txn_user ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_txn_date ON transactions(transaction_date DESC);

CREATE TABLE IF NOT EXISTS bank_accounts (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL,
  bank_name TEXT NOT NULL,
  account_last4 TEXT,
  account_type TEXT DEFAULT 'current',
  nickname TEXT,
  ifsc TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bank_accounts_user ON bank_accounts(user_id);

CREATE TABLE IF NOT EXISTS bank_transactions (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL,
  account_id BIGINT REFERENCES bank_accounts(id) ON DELETE SET NULL,
  txn_date DATE NOT NULL DEFAULT CURRENT_DATE,
  description TEXT,
  amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  type TEXT NOT NULL CHECK (type IN ('credit','debit')),
  status TEXT NOT NULL DEFAULT 'unmatched',
  matched_type TEXT,
  matched_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bank_transactions_user ON bank_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_bank_transactions_date ON bank_transactions(user_id, txn_date DESC);
CREATE INDEX IF NOT EXISTS idx_bank_transactions_status ON bank_transactions(user_id, status);`
    });
  }

  let client;
  try {
    const { Client } = require('pg');
    const { buildSanitizedPgConfig } = require('./lib/db/pgConfig');
    client = new Client(buildSanitizedPgConfig(dbUrl));
    await client.connect();

    await client.query(`
      CREATE TABLE IF NOT EXISTS prospects (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL,
        name TEXT NOT NULL,
        phone TEXT,
        email TEXT,
        business_type TEXT DEFAULT 'Distributor',
        location TEXT,
        amount_stuck NUMERIC,
        status TEXT DEFAULT 'cold',
        trial_start_date DATE,
        trial_end_date DATE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS prospect_notes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        prospect_id UUID NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_prospects_user_id ON prospects(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_prospect_notes_prospect_id ON prospect_notes(prospect_id)`);
    await ensureTransactionsTable();

    await client.end();
    res.json({ success: true, message: '✅ Migration complete — prospects, ledger and bank tables created' });
  } catch (err) {
    if (client) await client.end().catch(() => {});
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// AI CHAT ASSISTANT (Groq tool-calling — free)
// ============================================

const AI_TOOLS = [
  { type:'function', function:{ name:'get_summary', description:'Get business overview: total invoices, outstanding amount, recovery rate, total customers', parameters:{ type:'object', properties:{} } } },
  { type:'function', function:{ name:'get_invoices', description:'Get invoices list, optionally filtered by status or customer name', parameters:{ type:'object', properties:{ status:{ type:'string', description:'Pending, Paid, or all' }, customer_name:{ type:'string', description:'Filter by customer (partial match)' }, limit:{ type:'number', description:'Max records to return' } } } } },
  { type:'function', function:{ name:'mark_invoice_paid', description:'Mark a specific invoice as paid using invoice_id or customer_name (marks the most overdue one)', parameters:{ type:'object', properties:{ invoice_id:{ type:'string' }, customer_name:{ type:'string' } } } } },
  { type:'function', function:{ name:'get_prospects', description:'Get CRM prospects, optionally filtered by stage', parameters:{ type:'object', properties:{ status:{ type:'string', description:'cold, contacted, trial, engaged, paid, churned, or all' } } } } },
  { type:'function', function:{ name:'add_prospect', description:'Add a new prospect to the CRM pipeline', parameters:{ type:'object', properties:{ name:{ type:'string' }, phone:{ type:'string' }, business_type:{ type:'string' }, location:{ type:'string' }, amount_stuck:{ type:'number' } }, required:['name'] } } },
  { type:'function', function:{ name:'update_prospect_status', description:'Move a prospect to a different CRM stage', parameters:{ type:'object', properties:{ prospect_name:{ type:'string', description:'Name of the prospect to update' }, status:{ type:'string', enum:['cold','contacted','trial','engaged','paid','churned'] } }, required:['prospect_name','status'] } } },
  { type:'function', function:{ name:'get_inventory', description:'Get product inventory levels, low stock alerts, and stock value', parameters:{ type:'object', properties:{} } } },
  { type:'function', function:{ name:'get_calls', description:'Get recent call history and performance stats', parameters:{ type:'object', properties:{ limit:{ type:'number' } } } } },
  { type:'function', function:{ name:'get_cash_forecast', description:'Get 3-scenario cash flow forecast for the next N days', parameters:{ type:'object', properties:{ days:{ type:'number', description:'Forecast horizon in days (14/30/60/90)' } } } } },
  { type:'function', function:{ name:'get_overdue', description:'Get customers with overdue invoices sorted by days overdue or amount', parameters:{ type:'object', properties:{ min_days:{ type:'number', description:'Minimum days overdue (e.g. 30)' } } } } },
  { type:'function', function:{ name:'navigate_to', description:'Navigate the user to a specific page in the app', parameters:{ type:'object', properties:{ page:{ type:'string', enum:['dashboard','payments','calls','priority','message','analytics','inventory','metrics','prospects','forecast','pricing'] }, reason:{ type:'string', description:'Why you are navigating there' } }, required:['page'] } } },
  { type:'function', function:{ name:'get_suppliers', description:'Get all suppliers with name, phone, email, payment terms', parameters:{ type:'object', properties:{} } } },
  { type:'function', function:{ name:'send_whatsapp', description:'Compose and prepare a WhatsApp message to any contact (customer or supplier). The message will be opened ready-to-send in WhatsApp.', parameters:{ type:'object', properties:{ to:{ type:'string', description:'Recipient name' }, phone:{ type:'string', description:'Phone number (digits only or with spaces)' }, message:{ type:'string', description:'The full message text — write it naturally in Hindi/English mix if appropriate' } }, required:['to','phone','message'] } } },
  { type:'function', function:{ name:'send_collection_reminder', description:'Compose a tailored payment reminder WhatsApp message for an overdue customer', parameters:{ type:'object', properties:{ customer_name:{ type:'string' }, tone:{ type:'string', enum:['friendly','firm','urgent'], description:'Tone of the message' } }, required:['customer_name'] } } },
  { type:'function', function:{ name:'send_bulk_reminders', description:'Prepare WhatsApp payment reminders for ALL overdue customers at once (or filtered by min days overdue)', parameters:{ type:'object', properties:{ min_days:{ type:'number', description:'Only customers overdue by at least this many days (default 1)' }, tone:{ type:'string', enum:['friendly','firm','urgent'] } } } } },
  { type:'function', function:{ name:'place_order_with_supplier', description:'Create a purchase order for a supplier and compose a WhatsApp order message to them', parameters:{ type:'object', properties:{ supplier_name:{ type:'string', description:'Name of the supplier' }, items:{ type:'array', items:{ type:'object', properties:{ name:{type:'string'}, quantity:{type:'number'}, unit:{type:'string',description:'e.g. boxes, kg, units'} } }, description:'Items to order' }, notes:{ type:'string', description:'Any special instructions' } }, required:['supplier_name','items'] } } },
];

async function groqChat(messages, tools, toolChoice = 'auto') {
  const body = { model:'llama-3.3-70b-versatile', max_tokens:1500, temperature:0.2, messages };
  if (tools?.length) { body.tools = tools; body.tool_choice = toolChoice; }
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method:'POST',
    headers:{ 'Content-Type':'application/json', 'Authorization':`Bearer ${process.env.GROQ_API_KEY}` },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Groq error');
  return data.choices[0];
}

app.post('/api/ai-chat', authMiddleware, async (req, res) => {
  const { messages, business_name } = req.body;
  const user_id = authenticatedUserId(req);
  if (!user_id || !messages) return res.status(400).json({ error: 'Missing messages' });

  // Pre-fetch top 5 overdue invoices so first response is instant and data-aware
  let overdueContext = '';
  try {
    const { data: topInvoices } = await supabase
      .from('invoices')
      .select('customer_name, invoice_amount, days_overdue, customer_phone')
      .eq('user_id', user_id)
      .eq('payment_status', 'Pending')
      .order('days_overdue', { ascending: false })
      .limit(5);

    if (topInvoices && topInvoices.length > 0) {
      overdueContext = `\n\nTop overdue customers right now:\n${topInvoices.map(i =>
        `- ${i.customer_name}: ₹${Number(i.invoice_amount).toLocaleString('en-IN')} (${i.days_overdue} days overdue${i.customer_phone ? ', phone: ' + i.customer_phone : ''})`
      ).join('\n')}`;
    }
  } catch (_) {}

  // Fetch owner voice profile
  let ownerName = '';
  let voiceContext = '';
  try {
    const { data: userProfile } = await supabase.from('users')
      .select('owner_name, city, voice_style, ai_persona')
      .eq('id', user_id).single();
    if (userProfile) {
      ownerName = userProfile.owner_name || '';
      const styleMap = {
        casual_hinglish: 'casual Hinglish — uses bhai/yaar, mixes Hindi-English naturally, short sentences',
        formal_hindi: 'formal respectful Hindi — uses aap, complete sentences, professional tone',
        direct_english: 'direct English — professional, concise, no-nonsense',
        friendly_urdu: 'friendly Urdu-Hindi mix — warm, relationship-first tone',
        regional_hindi: `regional ${userProfile.city || 'Indian'} Hinglish — local dialect and phrases`,
      };
      const styleDesc = styleMap[userProfile.voice_style] || 'natural Hinglish';
      if (ownerName || userProfile.ai_persona) {
        voiceContext = `\n\nOWNER VOICE PROFILE:
- Owner name: ${ownerName || 'the business owner'}
- Business city: ${userProfile.city || 'India'}
- Communication style: ${styleDesc}
${userProfile.ai_persona ? `- How they write/talk: ${userProfile.ai_persona}` : ''}

When generating WhatsApp messages, call scripts, or any communication: write EXACTLY as ${ownerName || 'the owner'} would — matching their exact style, tone, and language mix. Sound like a real person, not a bot.`;
      }
    }
  } catch (_) {}

  const system = `You are ${ownerName ? ownerName + "'s" : 'Vantro'} AI co-founder, built into Vantro Flow for ${business_name || 'this business'}. You help Indian MSME owners manage collections, invoices, CRM, inventory, and cash flow.

You have tools: fetch data, mark invoices paid, add prospects, get forecasts, navigate pages.
Be specific, use ₹ formatting, and when asked to do something — DO it with tools, don't just explain.
Summarise actions clearly after doing them.${voiceContext}${overdueContext}`;

  const chatMessages = [
    { role:'system', content: system },
    ...messages
  ];

  const actions = [];
  const waLinks = [];
  let navigateTo = null;

  const executeTool = async (name, args) => {
    try {
      switch(name) {
        case 'get_summary': {
          const { data:inv } = await supabase.from('invoices').select('invoice_amount,payment_status,days_overdue').eq('user_id', user_id);
          const safe = inv || [];
          const paid = safe.filter(i=>i.payment_status==='Paid');
          const pending = safe.filter(i=>i.payment_status!=='Paid');
          const outstanding = pending.reduce((s,i)=>s+Number(i.invoice_amount),0);
          const recovered = paid.reduce((s,i)=>s+Number(i.invoice_amount),0);
          const { data:cust } = await supabase.from('invoices').select('customer_name').eq('user_id',user_id);
          const uniqueCustomers = new Set((cust||[]).map(c=>c.customer_name)).size;
          return { total_invoices:safe.length, paid:paid.length, pending:pending.length, outstanding:`₹${outstanding.toLocaleString('en-IN')}`, recovered:`₹${recovered.toLocaleString('en-IN')}`, recovery_rate:`${safe.length?Math.round(paid.length/safe.length*100):0}%`, total_customers:uniqueCustomers };
        }
        case 'get_invoices': {
          let q = supabase.from('invoices').select('id,customer_name,customer_phone,invoice_amount,payment_status,days_overdue,invoice_date').eq('user_id',user_id);
          if (args.status && args.status!=='all') q = q.eq('payment_status', args.status);
          if (args.customer_name) q = q.ilike('customer_name', `%${args.customer_name}%`);
          q = q.order('days_overdue',{ascending:false}).limit(args.limit||20);
          const { data } = await q;
          return data || [];
        }
        case 'mark_invoice_paid': {
          let inv;
          if (args.invoice_id) {
            const { data } = await supabase.from('invoices').select('id,customer_name,invoice_amount').eq('id',args.invoice_id).eq('user_id',user_id).single();
            inv = data;
          } else if (args.customer_name) {
            const { data } = await supabase.from('invoices').select('id,customer_name,invoice_amount').eq('user_id',user_id).ilike('customer_name',`%${args.customer_name}%`).eq('payment_status','Pending').order('days_overdue',{ascending:false}).limit(1);
            inv = data?.[0];
          }
          if (!inv) return { error: 'Invoice not found' };
          await supabase.from('invoices').update({ payment_status:'Paid', payment_date:new Date().toISOString().split('T')[0], payment_amount:inv.invoice_amount }).eq('id',inv.id).eq('user_id',user_id);
          actions.push(`✅ Marked ${inv.customer_name} invoice (₹${Number(inv.invoice_amount).toLocaleString('en-IN')}) as paid`);
          return { success:true, message:`Marked ${inv.customer_name} as paid`, amount:inv.invoice_amount };
        }
        case 'get_prospects': {
          let q = supabase.from('prospects').select('id,name,phone,status,business_type,location,amount_stuck,created_at').eq('user_id',user_id);
          if (args.status && args.status!=='all') q = q.eq('status',args.status);
          const { data } = await q.order('created_at',{ascending:false});
          return data || [];
        }
        case 'add_prospect': {
          const { data, error } = await supabase.from('prospects').insert([{ user_id, name:args.name, phone:args.phone||null, business_type:args.business_type||'Distributor', location:args.location||null, amount_stuck:args.amount_stuck||null, status:'cold' }]).select();
          if (error) return { error: error.message };
          actions.push(`➕ Added prospect: ${args.name} to CRM`);
          return { success:true, prospect: data[0] };
        }
        case 'update_prospect_status': {
          const { data:prospects } = await supabase.from('prospects').select('id,name,status').eq('user_id',user_id).ilike('name',`%${args.prospect_name}%`).limit(1);
          const p = prospects?.[0];
          if (!p) return { error: `Prospect "${args.prospect_name}" not found` };
          const updates = { status:args.status, updated_at:new Date() };
          if (args.status==='trial') { updates.trial_start_date=new Date().toISOString().split('T')[0]; const e=new Date(); e.setDate(e.getDate()+14); updates.trial_end_date=e.toISOString().split('T')[0]; }
          await supabase.from('prospects').update(updates).eq('id',p.id).eq('user_id',user_id);
          actions.push(`🔄 Moved ${p.name} → ${args.status}`);
          return { success:true, message:`${p.name} moved to ${args.status}` };
        }
        case 'get_inventory': {
          const { data:products } = await supabase.from('products').select('*').eq('user_id',user_id);
          const prd = products||[];
          const lowStock = prd.filter(p=>p.current_stock>0&&p.current_stock<=p.low_stock_alert);
          const outOfStock = prd.filter(p=>p.current_stock===0);
          const stockValue = prd.reduce((s,p)=>s+(Number(p.unit_price)*Number(p.current_stock)),0);
          return { total_products:prd.length, stock_value:`₹${stockValue.toLocaleString('en-IN')}`, low_stock:lowStock.map(p=>({name:p.name,stock:p.current_stock,alert:p.low_stock_alert})), out_of_stock:outOfStock.map(p=>p.name), products:prd.map(p=>({name:p.name,stock:p.current_stock,unit_price:`₹${p.unit_price}`})) };
        }
        case 'get_calls': {
          const { data } = await supabase.from('call_logs').select('customer_name,did_pick_up,notes,promised_payment_date,created_at').eq('user_id',user_id).order('created_at',{ascending:false}).limit(args.limit||15);
          const cls = data||[];
          const pickupRate = cls.length ? Math.round(cls.filter(c=>c.did_pick_up).length/cls.length*100) : 0;
          return { total:cls.length, pickup_rate:`${pickupRate}%`, promises:cls.filter(c=>c.promised_payment_date).length, recent:cls.slice(0,10) };
        }
        case 'get_cash_forecast': {
          const days = args.days||30;
          const { data:invoices } = await supabase.from('invoices').select('invoice_amount,payment_status,payment_date').eq('user_id',user_id);
          const safe = invoices||[];
          const paid = safe.filter(i=>i.payment_status==='Paid'&&i.payment_date);
          const totalRecovered = paid.reduce((s,i)=>s+Number(i.invoice_amount),0);
          const outstanding = safe.filter(i=>i.payment_status!=='Paid').reduce((s,i)=>s+Number(i.invoice_amount),0);
          const avgDaily = paid.length>0?Math.round(totalRecovered/90):Math.round(outstanding*0.03);
          return { forecast_days:days, avg_daily_collections:`₹${avgDaily.toLocaleString('en-IN')}`, total_outstanding:`₹${outstanding.toLocaleString('en-IN')}`, pessimistic_day_n:`₹${Math.round(avgDaily*0.5*days).toLocaleString('en-IN')}`, expected_day_n:`₹${Math.round(avgDaily*0.8*days).toLocaleString('en-IN')}`, optimistic_day_n:`₹${Math.round(avgDaily*0.95*days).toLocaleString('en-IN')}` };
        }
        case 'get_overdue': {
          let q = supabase.from('invoices').select('customer_name,customer_phone,invoice_amount,days_overdue').eq('user_id',user_id).eq('payment_status','Pending').order('days_overdue',{ascending:false});
          if (args.min_days) q = q.gte('days_overdue',args.min_days);
          const { data } = await q.limit(20);
          return data||[];
        }
        case 'navigate_to': {
          navigateTo = args.page;
          actions.push(`🧭 Navigating to ${args.page}`);
          return { success:true, navigating_to:args.page, reason:args.reason };
        }
        case 'get_suppliers': {
          const { data } = await supabase.from('suppliers').select('*').eq('user_id', user_id);
          return data || [];
        }
        case 'send_whatsapp': {
          const phone = String(args.phone||'').replace(/\D/g,'');
          if (!phone) return { error: 'No phone number provided' };
          const url = `https://wa.me/91${phone}?text=${encodeURIComponent(args.message)}`;
          waLinks.push({ to: args.to, phone, message: args.message, url });
          actions.push(`💬 WhatsApp ready for ${args.to}`);
          return { success:true, whatsapp_url: url, to: args.to, message_preview: args.message.substring(0,80) };
        }
        case 'send_collection_reminder': {
          // Fetch customer invoice data
          const { data: inv } = await supabase.from('invoices').select('customer_name,customer_phone,invoice_amount,days_overdue').eq('user_id', user_id).ilike('customer_name', `%${args.customer_name}%`).eq('payment_status','Pending').order('days_overdue',{ascending:false}).limit(5);
          if (!inv?.length) return { error: `No pending invoices found for ${args.customer_name}` };
          const total = inv.reduce((s,i)=>s+Number(i.invoice_amount),0);
          const maxOverdue = Math.max(...inv.map(i=>Number(i.days_overdue)));
          const phone = String(inv[0].customer_phone||'').replace(/\D/g,'');
          const name = inv[0].customer_name;
          const tone = args.tone || 'friendly';
          let msg;
          if (tone === 'friendly') {
            msg = `Namaste ${name} ji 🙏\n\nAapke account mein ₹${total.toLocaleString('en-IN')} outstanding hai (${maxOverdue} din se).\n\nKripya jaldi payment karlein. Koi problem ho toh batayein, hum help karenge.\n\nDhanyawaad 🙏\n— ${business_name || 'Vantro Flow'}`;
          } else if (tone === 'firm') {
            msg = `Dear ${name},\n\nYe aapko yaad dilaana hai ki ₹${total.toLocaleString('en-IN')} ki payment ${maxOverdue} din se pending hai.\n\nKripya aaj hi payment karein ya 2 din mein confirm karein.\n\n— ${business_name || 'Vantro Flow'}`;
          } else {
            msg = `URGENT: ${name} ji, ₹${total.toLocaleString('en-IN')} ki payment ${maxOverdue} din overdue hai. Aaj payment nahi hui toh delivery ruk sakti hai. Turant sampark karein.\n— ${business_name || 'Vantro Flow'}`;
          }
          const url = phone ? `https://wa.me/91${phone}?text=${encodeURIComponent(msg)}` : null;
          if (url) { waLinks.push({ to: name, phone, message: msg, url }); actions.push(`💬 Reminder ready for ${name}`); }
          return { success:true, customer: name, amount: `₹${total.toLocaleString('en-IN')}`, days_overdue: maxOverdue, message_preview: msg.substring(0,100), whatsapp_url: url, note: url ? 'WhatsApp link ready' : 'No phone number on file' };
        }
        case 'send_bulk_reminders': {
          const minDays = args.min_days || 1;
          const tone = args.tone || 'friendly';
          const { data: inv } = await supabase.from('invoices').select('customer_name,customer_phone,invoice_amount,days_overdue').eq('user_id', user_id).eq('payment_status','Pending').gte('days_overdue', minDays).order('days_overdue',{ascending:false});
          if (!inv?.length) return { message: 'No overdue invoices found matching criteria' };
          // Group by customer
          const custMap = {};
          inv.forEach(i => {
            if (!custMap[i.customer_name]) custMap[i.customer_name] = { name:i.customer_name, phone:i.customer_phone, total:0, maxOverdue:0 };
            custMap[i.customer_name].total += Number(i.invoice_amount);
            custMap[i.customer_name].maxOverdue = Math.max(custMap[i.customer_name].maxOverdue, Number(i.days_overdue));
          });
          const customers = Object.values(custMap);
          let added = 0;
          customers.forEach(c => {
            const phone = String(c.phone||'').replace(/\D/g,'');
            if (!phone) return;
            let msg;
            if (tone === 'urgent') {
              msg = `URGENT: ${c.name} ji, ₹${c.total.toLocaleString('en-IN')} ki payment ${c.maxOverdue} din se overdue hai. Aaj payment karein.\n— ${business_name||''}`;
            } else if (tone === 'firm') {
              msg = `Dear ${c.name}, ₹${c.total.toLocaleString('en-IN')} ki payment ${c.maxOverdue} din se pending hai. Kripya jaldi karein.\n— ${business_name||''}`;
            } else {
              msg = `Namaste ${c.name} ji 🙏 ₹${c.total.toLocaleString('en-IN')} outstanding hai (${c.maxOverdue} din). Kripya payment karein. Dhanyawaad!\n— ${business_name||''}`;
            }
            waLinks.push({ to: c.name, phone, message: msg, url: `https://wa.me/91${phone}?text=${encodeURIComponent(msg)}` });
            added++;
          });
          actions.push(`💬 ${added} WhatsApp reminders ready`);
          return { success:true, total_customers: customers.length, reminders_prepared: added, no_phone: customers.length - added };
        }
        case 'place_order_with_supplier': {
          // Find supplier
          const { data: suppliers } = await supabase.from('suppliers').select('*').eq('user_id', user_id).ilike('name', `%${args.supplier_name}%`).limit(1);
          const supplier = suppliers?.[0];
          const phone = supplier?.phone ? String(supplier.phone).replace(/\D/g,'') : null;
          // Compose order message
          const itemLines = (args.items||[]).map(it=>`  • ${it.name} — ${it.quantity} ${it.unit||'units'}`).join('\n');
          const totalItems = (args.items||[]).length;
          const msg = `Namaste ${args.supplier_name} ji 🙏\n\nHumein aapki taraf se yeh order chahiye:\n\n${itemLines}\n\n${args.notes ? `Note: ${args.notes}\n\n` : ''}Kripya availability aur delivery time confirm karein.\n\nDhanyawaad!\n— ${business_name||'Vantro Flow'}`;
          // Log as stock movement "ordered"
          if (supplier) {
            for (const item of (args.items||[])) {
              const { data: prod } = await supabase.from('products').select('id,name').eq('user_id',user_id).ilike('name',`%${item.name}%`).limit(1);
              if (prod?.[0]) {
                await supabase.from('stock_movements').insert([{ user_id, product_id:prod[0].id, movement_type:'order', quantity:item.quantity, notes:`Order placed with ${args.supplier_name}${args.notes?'. '+args.notes:''}`, created_at:new Date() }]).catch(()=>{});
              }
            }
          }
          const url = phone ? `https://wa.me/91${phone}?text=${encodeURIComponent(msg)}` : null;
          if (url) { waLinks.push({ to: args.supplier_name, phone, message: msg, url }); actions.push(`📦 Order WhatsApp ready for ${args.supplier_name}`); }
          else { actions.push(`📦 Order composed for ${args.supplier_name} (no phone on file)`); }
          return { success:true, supplier: args.supplier_name, items_ordered: totalItems, message_preview: msg.substring(0,120), whatsapp_url: url || 'No phone number on file for this supplier', order_logged: !!supplier };
        }
        default: return { error:`Unknown tool: ${name}` };
      }
    } catch(err) { return { error: err.message }; }
  };

  try {
    let iteration = 0;
    const maxIter = 5;

    while (iteration < maxIter) {
      iteration++;
      const choice = await groqChat(chatMessages, AI_TOOLS);
      const msg = choice.message;
      chatMessages.push(msg);

      if (choice.finish_reason === 'tool_calls' && msg.tool_calls?.length) {
        const toolResults = [];
        for (const tc of msg.tool_calls) {
          let args = {};
          try { args = JSON.parse(tc.function.arguments||'{}'); } catch(e) {}
          const result = await executeTool(tc.function.name, args);
          toolResults.push({ role:'tool', tool_call_id:tc.id, content:JSON.stringify(result) });
        }
        chatMessages.push(...toolResults);
      } else {
        return res.json({ success:true, message:msg.content, actions, navigate:navigateTo, waLinks });
      }
    }

    return res.json({ success:true, message:'Done! Let me know if you need anything else.', actions, navigate:navigateTo, waLinks });
  } catch(err) {
    console.error('AI chat error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// PAYMENT LINKS — Send UPI link to debtor
// ============================================

app.post('/api/payments/create-link', authMiddleware, async (req, res) => {
  try {
    const { invoice_id, customer_name, amount, description } = req.body;
    if (!amount || !customer_name) return res.status(400).json({ error: 'amount and customer_name required' });

    // If Razorpay not configured, return a UPI deep link fallback
    if (!razorpay) {
      const upiId = process.env.BUSINESS_UPI_ID || 'vantro@upi';
      const upiLink = `upi://pay?pa=${upiId}&pn=${encodeURIComponent(customer_name)}&am=${amount}&tn=${encodeURIComponent(description || 'Invoice Payment')}&cu=INR`;
      return res.json({
        success: true,
        type: 'upi_deeplink',
        link: upiLink,
        whatsapp_text: `${customer_name} ji, aapka ₹${Number(amount).toLocaleString('en-IN')} payment aap is link se kar sakte hain:\n${upiLink}\n\nUPI se direct pay karein. Koi bhi issue ho toh batayein.`,
      });
    }

    // Create Razorpay Payment Link
    const paymentLink = await razorpay.paymentLink.create({
      amount: Math.round(parseFloat(amount) * 100), // in paise
      currency: 'INR',
      description: description || `Invoice payment from ${customer_name}`,
      customer: { name: customer_name },
      notify: { sms: false, email: false },
      reminder_enable: false,
      notes: { invoice_id: invoice_id || '', customer_name },
      callback_url: `${process.env.FRONTEND_URL || 'https://vantro-flow.vercel.app'}/collections`,
      callback_method: 'get',
    });

    // Mark invoice as payment link sent — save link_id for webhook matching
    if (invoice_id) {
      await supabase.from('invoices').update({
        payment_link: paymentLink.short_url,
        payment_link_id: paymentLink.id,
        payment_link_sent_at: new Date()
      }).eq('id', invoice_id);
    }

    res.json({
      success: true,
      type: 'razorpay',
      link: paymentLink.short_url,
      link_id: paymentLink.id,
      whatsapp_text: `${customer_name} ji, aapka ₹${Number(amount).toLocaleString('en-IN')} invoice pending hai. Is link pe click karke abhi pay karein:\n\n${paymentLink.short_url}\n\nUPI, card, netbanking — sab accept hota hai. Koi problem ho toh call karein.`,
    });
  } catch (err) {
    console.error('Payment link error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// ONE-CLICK REMINDER — create link + auto-send WhatsApp
// ============================================

// Single invoice reminder: creates Razorpay/UPI link + sends WhatsApp in one call
app.post('/api/collections/send-reminder', authMiddleware, async (req, res) => {
  try {
    const { invoice_id } = req.body;
    if (!invoice_id) return res.status(400).json({ error: 'invoice_id required' });

    // Get invoice (ownership enforced via user_id filter)
    const { data: inv, error: invErr } = await supabase
      .from('invoices')
      .select('id, customer_name, customer_phone, invoice_amount, payment_status, payment_link, payment_link_id, reminder_count')
      .eq('id', invoice_id)
      .eq('user_id', req.user.userId)
      .single();

    if (invErr || !inv) return res.status(404).json({ error: 'Invoice not found' });
    if (inv.payment_status === 'Paid') return res.status(400).json({ error: 'Invoice already paid' });

    // Get owner info + per-user WhatsApp credentials
    const { data: owner } = await supabase
      .from('users')
      .select('business_name, upi_id, interakt_api_key, wati_api_url, wati_token')
      .eq('id', req.user.userId)
      .single();

    const waCreds = {
      interakt_api_key: owner?.interakt_api_key,
      wati_api_url:     owner?.wati_api_url,
      wati_token:       owner?.wati_token,
    };

    const bizName = owner?.business_name || 'Vantro';

    // Reuse existing payment link or create a new one
    let payLink = inv.payment_link;
    let payLinkId = inv.payment_link_id;

    if (!payLink) {
      if (razorpay) {
        try {
          const pl = await razorpay.paymentLink.create({
            amount: Math.round(parseFloat(inv.invoice_amount) * 100),
            currency: 'INR',
            description: `Invoice payment — ${inv.customer_name}`,
            customer: { name: inv.customer_name },
            notify: { sms: false, email: false },
            reminder_enable: false,
            notes: { invoice_id, customer_name: inv.customer_name },
            callback_url: `${process.env.FRONTEND_URL || 'https://vantro-flow.vercel.app'}/collections`,
            callback_method: 'get',
          });
          payLink = pl.short_url;
          payLinkId = pl.id;
        } catch (plErr) {
          console.error('[send-reminder] Razorpay link error:', plErr.message);
        }
      }
      // UPI deeplink fallback
      if (!payLink) {
        const upiId = owner?.upi_id || process.env.BUSINESS_UPI_ID || '';
        if (upiId) {
          payLink = `upi://pay?pa=${upiId}&pn=${encodeURIComponent(bizName)}&am=${inv.invoice_amount}&tn=${encodeURIComponent('Invoice Payment')}&cu=INR`;
        }
      }
      if (payLink) {
        await supabase.from('invoices').update({
          payment_link: payLink,
          payment_link_id: payLinkId || null,
        }).eq('id', invoice_id);
      }
    }

    // Build WhatsApp message
    const firstName = (inv.customer_name || '').split(' ')[0];
    const amtFormatted = Number(inv.invoice_amount).toLocaleString('en-IN');
    const msg = payLink
      ? `${firstName} ji 🙏\n\nAapka ₹${amtFormatted} ka payment pending hai.\n\nIs link se abhi pay karein:\n${payLink}\n\nUPI, Card, NetBanking — sab accept hota hai.\n\n— ${bizName}`
      : `${firstName} ji 🙏\n\nAapka ₹${amtFormatted} ka payment pending hai. Kripya jaldi settle karein.\n\n— ${bizName}`;

    // Auto-send WhatsApp using per-user credentials → env fallback → mock
    let waResult = { success: false, reason: 'no_phone' };
    if (inv.customer_phone) {
      waResult = await sendWhatsAppMessage(inv.customer_phone, msg, waCreds);
    }

    // Update reminder tracking regardless of send status
    await supabase.from('invoices').update({
      last_reminder_sent: new Date().toISOString(),
      reminder_count: (inv.reminder_count || 0) + 1,
    }).eq('id', invoice_id);

    res.json({
      success: true,
      auto_sent: waResult.success,
      provider: waResult.provider || null,
      payment_link: payLink,
      whatsapp_text: msg,
      phone: inv.customer_phone,
    });
  } catch (err) {
    console.error('Send reminder error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Bulk reminder: send to all overdue invoices (respects min_days filter)
app.post('/api/collections/bulk-remind', authMiddleware, async (req, res) => {
  try {
    const { min_days = 1, tone = 'friendly' } = req.body;

    const { data: invoices } = await supabase
      .from('invoices')
      .select('id, customer_name, customer_phone, invoice_amount, days_overdue, payment_link, reminder_count')
      .eq('user_id', req.user.userId)
      .eq('payment_status', 'Pending')
      .gte('days_overdue', Number(min_days))
      .not('customer_phone', 'is', null);

    const { data: owner } = await supabase
      .from('users')
      .select('business_name, upi_id')
      .eq('id', req.user.userId)
      .single();

    const bizName = owner?.business_name || 'Vantro';
    let sent = 0;
    const results = [];

    for (const inv of (invoices || [])) {
      try {
        const firstName = inv.customer_name.split(' ')[0];
        const amtFmt = Number(inv.invoice_amount).toLocaleString('en-IN');
        let msg;
        if (tone === 'firm') {
          msg = `Dear ${firstName},\n\n₹${amtFmt} payment is ${inv.days_overdue} days overdue. Please settle immediately.\n\n— ${bizName}`;
        } else if (tone === 'urgent') {
          msg = `${firstName} — ₹${amtFmt} overdue ${inv.days_overdue} din. Aaj hi payment karein. Urgent hai.\n\n— ${bizName}`;
        } else {
          msg = `${firstName} ji 🙏\n\n₹${amtFmt} ka payment ${inv.days_overdue} din se pending hai.${inv.payment_link ? `\n\nLink se pay karein:\n${inv.payment_link}` : ''}\n\nKripya jaldi settle karein.\n\n— ${bizName}`;
        }

        const waResult = await sendWhatsAppMessage(inv.customer_phone, msg);

        await supabase.from('invoices').update({
          last_reminder_sent: new Date().toISOString(),
          reminder_count: (inv.reminder_count || 0) + 1,
        }).eq('id', inv.id);

        if (waResult.success) sent++;
        results.push({ id: inv.id, name: inv.customer_name, sent: waResult.success });
      } catch (e) {
        results.push({ id: inv.id, name: inv.customer_name, sent: false });
      }
    }

    res.json({ success: true, total: (invoices || []).length, sent, results });
  } catch (err) {
    console.error('Bulk remind error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Collections Summary Engine
app.get('/api/collections/summary/:userId', requireOwner, async (req, res) => {
  try {
    const { userId } = req.params;
    await ensureConnectedBusinessData(userId);
    const summary = await calculateCollectionsSummary(userId);
    res.json({ success: true, summary });
  } catch (error) {
    console.error('[collections summary endpoint]', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Collections Chronological Activity Timeline
app.get('/api/collections/timeline/:userId', requireOwner, async (req, res) => {
  try {
    const { userId } = req.params;
    
    // Fetch calls, invoices, and activity logs
    const [callsRes, invoicesRes, logsRes] = await Promise.all([
      supabase.from('call_logs').select('*').eq('user_id', userId).order('called_at', { ascending: false }),
      supabase.from('invoices').select('*').eq('user_id', userId).order('invoice_date', { ascending: false }),
      supabase.from('activity_logs').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(50),
    ]);

    const calls = callsRes.data || [];
    const invoices = invoicesRes.data || [];
    const logs = logsRes.data || [];

    const timeline = [];

    // Map calls to timeline entries
    calls.forEach(c => {
      timeline.push({
        id: `call_${c.id}`,
        type: 'call',
        title: `Call with ${c.customer_name}`,
        description: c.notes || (c.did_pick_up ? 'Called, customer picked up.' : 'Called, no answer.'),
        date: c.called_at,
        metadata: {
          did_pick_up: c.did_pick_up,
          promised_payment_date: c.promised_payment_date,
          promised_amount: c.promised_amount,
          amount: c.amount,
          phone: c.customer_phone
        }
      });
    });

    // Map invoices (creation and paid state) to timeline entries
    invoices.forEach(inv => {
      // Creation
      timeline.push({
        id: `inv_create_${inv.id}`,
        type: 'invoice_created',
        title: `Invoice #${inv.invoice_number || 'INV'} Created`,
        description: `Created invoice for ${inv.customer_name} of ₹${Number(inv.invoice_amount).toLocaleString('en-IN')}`,
        date: inv.invoice_date,
        metadata: {
          customer_name: inv.customer_name,
          invoice_amount: inv.invoice_amount,
          due_date: inv.due_date
        }
      });

      // Payments
      if (inv.payment_status === 'Paid' && inv.payment_date) {
        timeline.push({
          id: `inv_pay_${inv.id}`,
          type: 'payment_received',
          title: `Payment Received from ${inv.customer_name}`,
          description: `Received ₹${Number(inv.invoice_amount).toLocaleString('en-IN')} for invoice #${inv.invoice_number || 'INV'}`,
          date: inv.payment_date,
          metadata: {
            customer_name: inv.customer_name,
            amount: inv.invoice_amount,
            method: inv.payment_method
          }
        });
      }
    });

    // Map collections activity logs
    logs.forEach(l => {
      if (['reminder_sent', 'dunning_triggered', 'whatsapp_sent'].includes(l.action)) {
        timeline.push({
          id: `log_${l.id}`,
          type: 'reminder_sent',
          title: `WhatsApp Reminder Sent`,
          description: l.metadata?.message || `Sent reminder message to customer.`,
          date: l.created_at,
          metadata: l.metadata
        });
      }
    });

    // Sort all events by date descending
    timeline.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    res.json({ success: true, timeline: timeline.slice(0, 100) });
  } catch (error) {
    console.error('[collections timeline endpoint]', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// RAZORPAY BILLING
// ============================================

const PLANS = {
  starter: { name: 'Vantro Starter', amount_monthly: 99900,  amount_annual: 95904  },
  growth:  { name: 'Vantro Growth',  amount_monthly: 249900, amount_annual: 239904 },
  pro:     { name: 'Vantro Pro',     amount_monthly: 499900, amount_annual: 479904 },
};

app.post('/api/billing/create-order', authMiddleware, async (req, res) => {
  try {
    if (!razorpay) return res.status(503).json({ error: 'Payment gateway not configured' });
    const { plan, period } = req.body;
    if (!PLANS[plan]) return res.status(400).json({ error: 'Invalid plan' });

    const amount = period === 'annual' ? PLANS[plan].amount_annual : PLANS[plan].amount_monthly;
    const order = await razorpay.orders.create({
      amount,
      currency: 'INR',
      receipt: `vantro_${req.user.userId}_${Date.now()}`,
      notes: { userId: req.user.userId, plan, period },
    });
    res.json({ success: true, order, key: process.env.RAZORPAY_KEY_ID });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/billing/verify', authMiddleware, async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, plan } = req.body;
    const body = razorpay_order_id + '|' + razorpay_payment_id;
    const expectedSig = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || '').update(body).digest('hex');

    if (expectedSig !== razorpay_signature) return res.status(400).json({ error: 'Payment verification failed' });

    // Upgrade plan + auto-enable Vantro AutoPilot for all paid subscribers
    await supabase.from('users').update({
      plan,
      plan_updated_at: new Date(),
      automation_enabled: true, // Vantro manages everything — no manual toggle needed
    }).eq('id', req.user.userId);
    await supabase.from('billing_history').insert([{
      user_id: req.user.userId, plan, payment_id: razorpay_payment_id,
      order_id: razorpay_order_id, status: 'paid', created_at: new Date(),
    }]);
    res.json({ success: true, message: 'Payment verified, plan upgraded' });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/billing/history', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase.from('billing_history')
      .select('*').eq('user_id', req.user.userId).order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ success: true, history: data || [] });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// SETTINGS
// ============================================

app.get('/api/settings', authMiddleware, async (req, res) => {
  try {
    const fullColumns = 'id, email, phone, business_name, gstin, plan, whatsapp_phone, whatsapp_token, logo_url, address, business_address, created_at, owner_name, city, voice_style, ai_persona, upi_id, invoice_prefix, industry, interakt_api_key, wati_api_url, wati_token, wa_provider, razorpay_key_id, automation_enabled';
    const coreColumns = 'id, email, phone, business_name, plan, created_at';
    let { data, error } = await supabase.from('users')
      .select(fullColumns)
      .eq('id', req.user.userId).maybeSingle();

    if (error && isMissingSchemaError(error)) {
      console.warn('[settings] optional columns unavailable, falling back to core columns:', error.message);
      ({ data, error } = await supabase.from('users')
        .select(coreColumns)
        .eq('id', req.user.userId).maybeSingle());
    }

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'User not found' });
    // Mask secrets — only return whether they are set, not the actual values
    const settings = { ...data };
    if (settings.interakt_api_key) settings.interakt_api_key = '••••••••';
    if (settings.wati_token)       settings.wati_token       = '••••••••';
    // razorpay_key_id is safe to return (public key), razorpay_key_secret never stored per-user
    res.json({ success: true, settings });
  } catch (error) {
    console.error('[settings get]', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.patch('/api/settings', authMiddleware, async (req, res) => {
  try {
    const allowed = ['business_name', 'phone', 'gstin', 'address', 'business_address', 'logo_url', 'whatsapp_phone', 'whatsapp_token', 'industry', 'language', 'contact_time', 'owner_name', 'city', 'voice_style', 'ai_persona', 'upi_id', 'invoice_prefix', 'wa_provider', 'wati_api_url', 'razorpay_key_id', 'automation_enabled'];
    const updates = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
    updates.updated_at = new Date();
    const { data, error } = await supabase.from('users').update(updates).eq('id', req.user.userId).select('id, email, phone, business_name, gstin, plan');
    if (error) throw error;
    res.json({ success: true, settings: data[0] });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Save Twilio credentials (stored per-user in DB, used instead of env vars)
app.post('/api/settings/twilio', authMiddleware, async (req, res) => {
  try {
    const { account_sid, auth_token, phone_number } = req.body;
    if (!account_sid || !auth_token || !phone_number) {
      return res.status(400).json({ error: 'account_sid, auth_token, and phone_number required' });
    }
    const { error } = await supabase.from('users').update({
      twilio_account_sid: account_sid.trim(),
      twilio_auth_token: auth_token.trim(),
      twilio_phone_number: phone_number.trim(),
      updated_at: new Date(),
    }).eq('id', req.user.userId);
    if (error) throw error;
    res.json({ success: true, message: 'Twilio credentials saved' });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// DUNNING RULES
// ============================================

app.get('/api/dunning/:userId', requireOwner, async (req, res) => {
  try {
    const { data, error } = await supabase.from('dunning_rules')
      .select('*').eq('user_id', req.params.userId).order('trigger_day');
    if (error) throw error;
    res.json({ success: true, rules: data || [] });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/dunning/logs/:userId', requireOwner, async (req, res) => {
  try {
    const { userId } = req.params;
    const { data, error } = await supabase
      .from('activity_logs')
      .select('*')
      .eq('user_id', userId)
      .in('action', ['reminder_sent', 'dunning_triggered', 'whatsapp_sent'])
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ success: true, logs: data || [] });
  } catch (error) {
    console.error('[dunning logs endpoint]', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/dunning', authMiddleware, async (req, res) => {
  try {
    const user_id = req.user.userId;
    const { name, trigger_day, action, tone, enabled } = req.body;
    if (!trigger_day || !action) return res.status(400).json({ error: 'Missing required fields' });
    const { data, error } = await supabase.from('dunning_rules')
      .insert([{ user_id, name: name || `Day ${trigger_day} Follow-Up`, trigger_day, action, tone: tone || 'gentle', enabled: enabled !== false }])
      .select();
    if (error) throw error;
    res.json({ success: true, rule: data[0] });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.patch('/api/dunning/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const updates = { ...pickAllowed(req.body, ['name', 'trigger_day', 'action', 'tone', 'enabled']), updated_at: new Date() };
    const { data, error } = await supabase.from('dunning_rules').update(updates).eq('id', id).eq('user_id', req.user.userId).select();
    if (error) throw error;
    if (!data?.length) return res.status(404).json({ error: 'Rule not found' });
    res.json({ success: true, rule: data[0] });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/dunning/:id', authMiddleware, async (req, res) => {
  try {
    const { error } = await supabase.from('dunning_rules').delete().eq('id', req.params.id).eq('user_id', req.user.userId);
    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// INTEGRATION SETTINGS — WhatsApp, Razorpay per-user
// ============================================

// Save WhatsApp credentials (Interakt or WATI)
app.post('/api/settings/whatsapp', authMiddleware, async (req, res) => {
  try {
    const { provider, interakt_api_key, wati_api_url, wati_token } = req.body;
    if (!provider) return res.status(400).json({ error: 'provider required (interakt or wati)' });

    const updates = { wa_provider: provider, updated_at: new Date() };
    if (provider === 'interakt') {
      if (!interakt_api_key) return res.status(400).json({ error: 'interakt_api_key required' });
      updates.interakt_api_key = interakt_api_key.trim();
    } else if (provider === 'wati') {
      if (!wati_api_url || !wati_token) return res.status(400).json({ error: 'wati_api_url and wati_token required' });
      updates.wati_api_url = wati_api_url.trim();
      updates.wati_token   = wati_token.trim();
    } else {
      return res.status(400).json({ error: 'provider must be interakt or wati' });
    }

    const { error } = await supabase.from('users').update(updates).eq('id', req.user.userId);
    if (error) throw error;
    res.json({ success: true, message: 'WhatsApp credentials saved' });
  } catch (err) {
    console.error('Save WA creds error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Test WhatsApp — sends a test message to the owner's own phone
app.post('/api/settings/whatsapp/test', authMiddleware, async (req, res) => {
  try {
    const { data: user } = await supabase.from('users')
      .select('phone, business_name, interakt_api_key, wati_api_url, wati_token, wa_provider')
      .eq('id', req.user.userId).single();

    if (!user?.phone) return res.status(400).json({ error: 'No phone number on your profile. Add your phone number in Settings → Profile first.' });

    const creds = {
      interakt_api_key: user.interakt_api_key,
      wati_api_url:     user.wati_api_url,
      wati_token:       user.wati_token,
    };

    const bizName = user.business_name || 'your business';
    const msg = `✅ Vantro Flow se test message!\n\nYeh confirm karta hai ki WhatsApp automation ${bizName} ke liye ready hai. Ab se reminders, payment links, aur follow-ups automatically jayenge!\n\n— Vantro Flow`;

    const result = await sendWhatsAppMessage(user.phone, msg, creds);

    if (result.success) {
      res.json({ success: true, provider: result.provider, message: `Test message sent to ${user.phone} via ${result.provider}` });
    } else {
      res.status(400).json({ success: false, error: 'Could not send test message', detail: result.reason || result.error || 'Check your API key and try again' });
    }
  } catch (err) {
    console.error('WA test error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Save Razorpay credentials per-user
app.post('/api/settings/razorpay', authMiddleware, async (req, res) => {
  try {
    const { key_id, key_secret } = req.body;
    if (!key_id || !key_secret) return res.status(400).json({ error: 'key_id and key_secret required' });

    // Validate by trying to fetch account details
    let valid = false;
    try {
      const creds = Buffer.from(`${key_id.trim()}:${key_secret.trim()}`).toString('base64');
      const r = await fetch('https://api.razorpay.com/v1/accounts/me', {
        headers: { 'Authorization': `Basic ${creds}` },
      });
      valid = r.ok || r.status === 401; // 401 means keys parsed but invalid, 200 = valid
      valid = r.ok;
    } catch { valid = false; }

    const { error } = await supabase.from('users').update({
      razorpay_key_id:     key_id.trim(),
      razorpay_key_secret: key_secret.trim(),
      updated_at: new Date(),
    }).eq('id', req.user.userId);
    if (error) throw error;

    res.json({ success: true, valid, message: valid ? 'Razorpay connected ✅' : 'Keys saved — could not verify automatically. They will be validated on first use.' });
  } catch (err) {
    console.error('Save Razorpay creds error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Toggle global automation on/off
app.post('/api/settings/automation/toggle', authMiddleware, async (req, res) => {
  try {
    const { enabled } = req.body;
    const { error } = await supabase.from('users').update({
      automation_enabled: !!enabled,
      updated_at: new Date(),
    }).eq('id', req.user.userId);
    if (error) throw error;
    res.json({ success: true, automation_enabled: !!enabled });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// DUNNING CRON — runs every day at 9:00 AM IST
// ============================================

// Helper: trigger an auto-call via Twilio for a dunning action
async function makeAutoCall(userId, invoice) {
  try {
    const twilioClient = getTwilio();
    if (!twilioClient) {
      console.log(`[Dunning/call] Twilio not configured — skipping call for invoice ${maskId(invoice.id)}`);
      return false;
    }
    // Phase 2C.35-P1: external-send kill switch — no auto voice call unless enabled.
    if (guardExternalSend('voice')) {
      console.log('[Dunning/call] external sending disabled (flag off) — call skipped');
      return false;
    }

    const { data: profile } = await supabase
      .from('users')
      .select('business_name, owner_name, ai_persona')
      .eq('id', userId)
      .single();

    const bizName = profile?.business_name || 'Vantro';

    // AI-generated opening script (Groq) with Hinglish fallback
    let openingScript = `Namaste ${invoice.customer_name} ji, main ${bizName} se bol raha hoon. Aapka ₹${Number(invoice.invoice_amount).toLocaleString('en-IN')} payment ${invoice.days_overdue} din se pending hai. Kya aaj payment ho sakti hai?`;
    try {
      const gr = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [{ role: 'user', content: `Write a 25-word Hinglish phone call opening for collecting ₹${invoice.invoice_amount} from ${invoice.customer_name}, ${invoice.days_overdue} days overdue. Business: ${bizName}. Output only the script text, no quotes.` }],
          temperature: 0.3, max_tokens: 80,
        }),
      });
      const gd = await gr.json();
      const s = gd.choices?.[0]?.message?.content?.trim();
      if (s && s.length > 10) openingScript = s;
    } catch (_) {}

    const phone = String(invoice.customer_phone).replace(/\D/g, '');
    const toPhone = phone.length === 10 ? `+91${phone}` : `+${phone}`;
    const safeScript = openingScript.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const payLink = invoice.payment_link;
    const payPrompt = payLink
      ? `<Say voice="Polly.Aditi" language="hi-IN">Is link pe click kar ke abhi pay karein: ${payLink.replace(/https?:\/\//, '')}</Say><Pause length="1"/>`
      : '';

    await twilioClient.calls.create({
      to: toPhone,
      from: process.env.TWILIO_PHONE_NUMBER,
      twiml: `<Response><Say voice="Polly.Aditi" language="hi-IN">${safeScript}</Say><Pause length="2"/>${payPrompt}<Say voice="Polly.Aditi" language="hi-IN">Payment ke liye please call wapas karein ya WhatsApp karein. Dhanyavaad.</Say></Response>`,
      statusCallback: `${process.env.RAILWAY_PUBLIC_URL || 'https://vantro-flow-backend-production.up.railway.app'}/api/voice/status?uid=${encodeURIComponent(userId)}`,
      statusCallbackEvent: ['completed'],
      timeout: 30,
    });

    // Log the auto-call
    await supabase.from('call_logs').insert([{
      user_id: userId, invoice_id: invoice.id,
      customer_name: invoice.customer_name, customer_phone: invoice.customer_phone,
      amount: invoice.invoice_amount, did_pick_up: false,
      notes: `[Auto-call by dunning cron, day ${invoice.days_overdue}] Script: "${openingScript}"`,
      created_at: new Date(),
    }]).catch(() => {});

    return true;
  } catch (err) {
    console.error(`[Dunning/call] Call failed for invoice ${maskId(invoice.id)}:`, err.message);
    return false;
  }
}

async function runDunningCycle() {
  console.log('🔔 Dunning cron started:', new Date().toISOString());
  try {
    // Get all active dunning rules
    const { data: allRules } = await supabase.from('dunning_rules').select('*').eq('enabled', true);
    if (!allRules?.length) return;

    // Get all pending invoices (exclude snoozed ones)
    // Also fetch invoice_date so we can compute days_overdue dynamically
    const { data: invoices } = await supabase
      .from('invoices')
      .select('id, user_id, customer_name, customer_phone, invoice_amount, invoice_date, due_date, days_overdue, payment_link, payment_link_id, reminder_count, snooze_until')
      .eq('payment_status', 'Pending')
      .or(`snooze_until.is.null,snooze_until.lt.${new Date().toISOString()}`);
    if (!invoices?.length) return;

    // Compute actual days overdue from invoice_date (not stored static field)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    invoices.forEach(inv => {
      if (inv.invoice_date) {
        const issueDate = new Date(inv.invoice_date);
        issueDate.setHours(0, 0, 0, 0);
        inv._computed_days = Math.floor((today - issueDate) / (1000 * 60 * 60 * 24));
      } else {
        inv._computed_days = inv.days_overdue || 0;
      }
    });

    // Get user settings (business name, plan, automation toggle, WA creds)
    const userIds = [...new Set(invoices.map(i => i.user_id))];
    const { data: users } = await supabase
      .from('users')
      .select('id, business_name, plan, automation_enabled, interakt_api_key, wati_api_url, wati_token')
      .in('id', userIds);
    const userMap = {};
    (users || []).forEach(u => { userMap[u.id] = u; });

    let sent = 0;
    for (const invoice of invoices) {
      const user = userMap[invoice.user_id];
      // Run for: (a) any paid plan user, OR (b) free users who manually enabled automation
      const isPaidPlan = user?.plan && user.plan !== 'free';
      if (!isPaidPlan && !user?.automation_enabled) continue; // skip free users with automation off

      // Match rules using dynamically computed days since invoice_date
      const rules = allRules.filter(r => r.user_id === invoice.user_id && r.trigger_day === invoice._computed_days);
      for (const rule of rules) {
        if (!invoice.customer_phone) continue;
        const biz = user?.business_name || 'Collections Team';
        const waCreds = {
          interakt_api_key: user?.interakt_api_key,
          wati_api_url:     user?.wati_api_url,
          wati_token:       user?.wati_token,
        };
        const phone = String(invoice.customer_phone).replace(/\D/g, '');
        const amtFmt = Number(invoice.invoice_amount).toLocaleString('en-IN');
        const firstName = (invoice.customer_name || '').split(' ')[0];

        // Reuse existing payment link or create one
        let payLink = invoice.payment_link || null;
        if (!payLink && razorpay) {
          try {
            const pl = await razorpay.paymentLink.create({
              amount: Math.round(parseFloat(invoice.invoice_amount) * 100),
              currency: 'INR',
              description: `Invoice — ${invoice.customer_name}`,
              customer: { name: invoice.customer_name },
              notify: { sms: false, email: false },
              reminder_enable: false,
              notes: { invoice_id: invoice.id },
            });
            payLink = pl.short_url;
            await supabase.from('invoices').update({ payment_link: payLink, payment_link_id: pl.id }).eq('id', invoice.id);
          } catch (e) { console.error('[Dunning] Razorpay link error:', e.message); }
        }

        let msg = '';
        if (rule.tone === 'gentle') {
          msg = payLink
            ? `Namaste ${firstName} ji 🙏\n\n₹${amtFmt} ka payment ${invoice.days_overdue} din se pending hai.\n\nIs link se abhi pay karein:\n${payLink}\n\n— ${biz}`
            : `Namaste ${firstName} ji 🙏\n\n₹${amtFmt} ka payment ${invoice.days_overdue} din se pending hai. Kripya is hafte payment karein.\n— ${biz}`;
        } else if (rule.tone === 'firm') {
          msg = payLink
            ? `Dear ${invoice.customer_name},\n\n₹${amtFmt} payment is ${invoice.days_overdue} days overdue. Pay now:\n${payLink}\n\nPlease pay within 3 days.\n— ${biz}`
            : `Dear ${invoice.customer_name},\n\n₹${amtFmt} payment is ${invoice.days_overdue} days overdue. Please pay within 3 days.\n— ${biz}`;
        } else {
          msg = payLink
            ? `URGENT: ${invoice.customer_name} — ₹${amtFmt} overdue ${invoice.days_overdue} days.\n\nPay NOW:\n${payLink}\n— ${biz}`
            : `URGENT: ${invoice.customer_name} — ₹${amtFmt} overdue ${invoice.days_overdue} days. Immediate action required.\n— ${biz}`;
        }

        // Log the dunning action
        await supabase.from('dunning_logs').insert([{
          user_id: invoice.user_id, rule_id: rule.id, invoice_id: invoice.id,
          customer_name: invoice.customer_name, action: rule.action,
          message: msg, whatsapp_url: `https://wa.me/91${phone}?text=${encodeURIComponent(msg)}`,
          sent_at: new Date(),
        }]).catch(() => {});

        // Execute the dunning action: call or whatsapp
        if (invoice.customer_phone) {
          if (rule.action === 'call') {
            // Auto-call via Twilio (AI script, Polly voice)
            await makeAutoCall(invoice.user_id, invoice);
          } else {
            // WhatsApp (per-user creds → env fallback → mock)
            await sendWhatsAppMessage(invoice.customer_phone, msg, waCreds).catch(e =>
              console.error(`[Dunning] WA send failed for invoice ${maskId(invoice.id)}:`, e.message)
            );
          }
          // Track reminder timestamp for frontend display
          await supabase.from('invoices').update({
            last_reminder_sent: new Date().toISOString(),
            reminder_count: (invoice.reminder_count || 0) + 1,
          }).eq('id', invoice.id).catch(() => {});
        }

        sent++;
      }
    }
    console.log(`✅ Dunning cycle done — ${sent} actions logged`);
  } catch (err) {
    console.error('Dunning cron error:', err.message);
  }
}

// Run daily at 9 AM IST (UTC+5:30 = 3:30 AM UTC)
cron.schedule('30 3 * * *', runDunningCycle, { timezone: 'UTC' });

// ============================================
// VANTRO NETWORK — Business Discovery
// ============================================

app.get('/api/network/search', authMiddleware, async (req, res) => {
  try {
    const { q = '', type = 'all', limit = 20 } = req.query;

    let query = supabase
      .from('users')
      .select('id, business_name, plan, created_at, gstin')
      .limit(Number(limit));

    if (q) query = query.ilike('business_name', `%${q}%`);

    const { data: users, error } = await query.order('created_at', { ascending: false });
    if (error) throw error;

    if (!users || users.length === 0) return res.json({ success: true, businesses: [] });

    // Enrich each user with their profile data
    const enriched = await Promise.all(users.map(async (user) => {
      const [{ data: invoices }, { data: callLogs }] = await Promise.all([
        supabase.from('invoices').select('invoice_amount, payment_status').eq('user_id', user.id),
        supabase.from('call_logs').select('id').eq('user_id', user.id),
      ]);

      const inv = invoices || [];
      const paid = inv.filter(i => i.payment_status === 'Paid');
      const totalManaged = inv.reduce((s, i) => s + Number(i.invoice_amount), 0);
      const recoveryRate = inv.length ? Math.round((paid.length / inv.length) * 100) : 0;
      const memberDays = Math.floor((Date.now() - new Date(user.created_at).getTime()) / 86400000);
      const uniqueCustomers = new Set(inv.map(i => i.customer_name)).size;

      // Trust score
      const recScore = recoveryRate * 0.40;
      const volScore = Math.min(20, inv.length * 0.5) * 0.20;
      const ageScore = Math.min(20, memberDays * 0.1) * 0.20;
      const callScore = Math.min(20, (callLogs || []).length * 0.5) * 0.20;
      const trustScore = Math.min(100, Math.round(recScore + volScore + ageScore + callScore));

      const badges = [];
      if (inv.length >= 5) badges.push('Active Business');
      if (recoveryRate >= 70) badges.push('Strong Collector');
      if (memberDays >= 30) badges.push('Verified Member');
      if (user.gstin) badges.push('GST Registered');

      const vantroId = 'VAN-' + user.id.replace(/-/g, '').slice(0, 8).toUpperCase();

      return {
        user_id: user.id,
        vantro_id: vantroId,
        business_name: user.business_name,
        plan: user.plan,
        trust_score: trustScore,
        recovery_rate: recoveryRate,
        total_customers: uniqueCustomers,
        total_managed: totalManaged,
        total_invoices: inv.length,
        member_days: memberDays,
        badges,
      };
    }));

    // Filter out users with no activity if not searching
    const result = q ? enriched : enriched.filter(b => b.total_invoices > 0 || b.member_days > 1);
    res.json({ success: true, businesses: result });
  } catch (error) {
    console.error('Network search error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// ML SCORING ENGINE + AI FOUNDER BRIEFING
// ============================================

// Feature engineering — mimics gradient boosting (XGBoost-style weighted scoring)
function computeMLScore(invoice, callsForCustomer) {
  const days = Number(invoice.days_overdue) || 0;
  const amount = Number(invoice.invoice_amount) || 0;

  // Feature 1: Days overdue decay (exponential — most important feature, 35% weight)
  // Logic: payment probability drops ~2% per day overdue (calibrated on MSME data)
  const f1_recency = Math.exp(-0.022 * days);

  // Feature 2: Amount signal (log-normalized, 20% weight)
  // Higher amounts = harder to collect BUT higher priority to try
  const f2_amount = Math.min(1, Math.log1p(amount) / Math.log1p(5000000));

  // Feature 3: Engagement signal (25% weight)
  // Customers who have been contacted and responded are more likely to pay
  const callCount = callsForCustomer.length;
  const pickedUp = callsForCustomer.filter(c => c.did_pick_up).length;
  const hasPromise = callsForCustomer.some(c => c.promised_payment_date);
  const f3_engagement = Math.min(1,
    (callCount > 0 ? 0.3 : 0) +
    (pickedUp > 0 ? 0.4 : 0) +
    (hasPromise ? 0.3 : 0)
  );

  // Feature 4: Relationship depth (10% weight)
  // More call history = longer relationship = more leverage
  const f4_relationship = Math.min(1, callCount / 8);

  // Feature 5: Urgency signal — not contacted recently (10% weight)
  // If no calls in 7 days, they need outreach
  const lastCall = callsForCustomer.length > 0
    ? new Date(callsForCustomer.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0].created_at)
    : null;
  const daysSinceContact = lastCall ? (Date.now() - lastCall) / 86400000 : 999;
  const f5_needsContact = daysSinceContact > 7 ? 0.8 : 0.2;

  // Weighted combination (gradient boosting-style ensemble)
  const rawScore =
    f1_recency    * 0.35 +
    f2_amount     * 0.20 +
    f3_engagement * 0.25 +
    f4_relationship * 0.10 +
    f5_needsContact * 0.10;

  // Convert to 0-100 score
  const score = Math.round(rawScore * 100);

  // Payment probability: engagement drives up, high overdue drives down
  const paymentProb = Math.round(
    Math.min(92, Math.max(5,
      (f3_engagement * 55) + (f1_recency * 35) + (f4_relationship * 10)
    ))
  );

  // Priority tier
  const tier = score >= 65 ? 'high' : score >= 40 ? 'medium' : 'low';
  const action = hasPromise ? 'Follow up on promise' :
    pickedUp > 0 ? 'Send payment reminder' :
    callCount === 0 ? 'First contact — call now' : 'Try again — not reachable';

  return { score, paymentProb, tier, action, callCount, hasPromise, daysSinceContact: Math.round(daysSinceContact) };
}

app.post('/api/ml/briefing', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;

    // Fetch data in parallel
    const [
      { data: invoicesRaw },
      { data: callsRaw },
      { data: userData },
    ] = await Promise.all([
      supabase.from('invoices').select('id,customer_name,customer_phone,invoice_amount,payment_status,days_overdue,invoice_date').eq('user_id', userId).eq('payment_status', 'Pending').order('invoice_amount', { ascending: false }),
      supabase.from('call_logs').select('customer_name,did_pick_up,promised_payment_date,created_at').eq('user_id', userId).order('created_at', { ascending: false }),
      supabase.from('users').select('business_name,plan').eq('id', userId).single(),
    ]);

    // Hide synthetic cortex-lab seed rows so AI Founder / Neural Engine never
    // surface "Cortex Test Customer" debtors in a real tenant's briefing.
    const invoices = stripCortexTestRows(invoicesRaw || []);
    const calls = stripCortexTestRows(callsRaw || []);
    const businessName = userData?.business_name || 'Your Business';

    // Group calls by customer
    const callsByCustomer = {};
    calls.forEach(c => {
      const key = (c.customer_name || '').toLowerCase();
      if (!callsByCustomer[key]) callsByCustomer[key] = [];
      callsByCustomer[key].push(c);
    });

    // Run ML scoring on each debtor
    const scored = invoices.map(inv => {
      const customerCalls = callsByCustomer[(inv.customer_name || '').toLowerCase()] || [];
      const ml = computeMLScore(inv, customerCalls);
      return {
        customer_name: inv.customer_name,
        customer_phone: inv.customer_phone,
        invoice_amount: Number(inv.invoice_amount),
        days_overdue: Number(inv.days_overdue),
        ...ml,
      };
    });

    // Sort by score desc
    scored.sort((a, b) => b.score - a.score);

    // Business health metrics
    const totalOutstanding = invoices.reduce((s, i) => s + Number(i.invoice_amount), 0);
    const highPriority = scored.filter(s => s.tier === 'high');
    const expectedInflow7d = highPriority.reduce((s, c) => s + c.invoice_amount * (c.paymentProb / 100), 0);
    const avgPaymentProb = scored.length ? Math.round(scored.reduce((s, c) => s + c.paymentProb, 0) / scored.length) : 0;

    // Business health score (0-100)
    const healthScore = Math.round(
      (avgPaymentProb * 0.4) +
      (Math.min(100, (highPriority.length / Math.max(1, scored.length)) * 100) * 0.3) +
      (Math.min(100, (calls.filter(c => c.did_pick_up).length / Math.max(1, calls.length)) * 100) * 0.3)
    );

    // Generate AI morning briefing via Groq (LLaMA 70B neural network)
    let briefing = '';
    try {
      const briefingPrompt = `You are an AI CFO and business advisor for ${businessName}, an Indian MSME.

Business data:
- Total outstanding receivables: ₹${totalOutstanding.toLocaleString('en-IN')}
- Total debtors: ${scored.length}
- High-priority debtors (likely to pay): ${highPriority.length}
- Expected inflow this week: ₹${Math.round(expectedInflow7d).toLocaleString('en-IN')}
- Business health score: ${healthScore}/100
- Top debtor: ${scored[0]?.customer_name || 'N/A'} — ₹${scored[0]?.invoice_amount?.toLocaleString('en-IN') || 0} (${scored[0]?.days_overdue || 0} days overdue)

Write a crisp 3-sentence morning briefing for the business owner. Be specific, use rupee amounts, and give one sharp action they should take first. Speak like a sharp co-founder, not a bot. Hinglish is fine.`;

      const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          max_tokens: 200,
          temperature: 0.4,
          messages: [{ role: 'user', content: briefingPrompt }],
        }),
      });
      const groqData = await groqRes.json();
      briefing = groqData.choices?.[0]?.message?.content?.trim() || '';
    } catch (_) {
      briefing = `Aaj ${scored.length} customers se ₹${totalOutstanding.toLocaleString('en-IN')} outstanding hai. Sabse pehle ${scored[0]?.customer_name || 'top debtor'} ko call karein — unka payment probability ${scored[0]?.paymentProb || 0}% hai.`;
    }

    res.json({
      success: true,
      briefing,
      health_score: healthScore,
      total_outstanding: totalOutstanding,
      expected_inflow_7d: Math.round(expectedInflow7d),
      avg_payment_probability: avgPaymentProb,
      debtors: scored.slice(0, 15),
      stats: {
        total: scored.length,
        high_priority: highPriority.length,
        medium_priority: scored.filter(s => s.tier === 'medium').length,
        low_priority: scored.filter(s => s.tier === 'low').length,
      },
    });
  } catch (err) {
    console.error('ML briefing error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// ADMIN ANALYTICS (founder-only)
// ============================================

function adminOnly(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing token' });
  try {
    const decoded = verifyJWT(header.slice(7));
    // Phase 2C.35-P1: pre-OTP "preVerify" tokens are NOT full sessions.
    if (decoded && decoded.preVerify) return res.status(401).json({ error: 'Verification incomplete' });
    const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim());
    if (!ADMIN_EMAILS.includes(decoded.email)) return res.status(403).json({ error: 'Forbidden' });
    req.user = decoded;

    // --- SECURITY: Force identity fields to safe values ---
    if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
      const safeId = req.user.userId || req.user.id;
      req.body.user_id = safeId;
      req.body.userId = safeId;
      if (req.user.businessId) req.body.business_id = req.user.businessId;
      delete req.body.role;
      delete req.body.plan;
      delete req.body.subscription;
    }
    // ------------------------------------------------------
    
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}


app.get('/api/admin/stats', adminOnly, async (req, res) => {
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    const oneDayAgo    = new Date(Date.now() - 86400000).toISOString();

    const [
      { data: allUsers },
      { data: recentSignups },
      { data: todaySignups },
      { data: allInvoices },
      { data: paidBilling },
    ] = await Promise.all([
      supabase.from('users').select('id, email, business_name, plan, created_at'),
      supabase.from('users').select('id').gte('created_at', sevenDaysAgo),
      supabase.from('users').select('id').gte('created_at', oneDayAgo),
      supabase.from('invoices').select('id, user_id, created_at'),
      supabase.from('billing_history').select('amount').eq('status', 'paid'),
    ]);

    const safe = (d) => d || [];
    const mrr = safe(paidBilling).reduce((s, b) => s + Number(b.amount || 0), 0) / 100;
    const paidUsers = safe(allUsers).filter(u => u.plan && u.plan !== 'free').length;
    const usersWithInvoices = new Set(safe(allInvoices).map(i => i.user_id)).size;

    res.json({
      success: true,
      stats: {
        total_users: safe(allUsers).length,
        signups_last_7d: safe(recentSignups).length,
        signups_today: safe(todaySignups).length,
        paid_users: paidUsers,
        free_users: safe(allUsers).length - paidUsers,
        users_with_data: usersWithInvoices,
        total_invoices: safe(allInvoices).length,
        mrr_inr: mrr,
        recent_signups: safe(allUsers)
          .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
          .slice(0, 10)
          .map(u => ({ email: u.email, business: u.business_name, plan: u.plan, joined: u.created_at })),
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// PUBLIC BUSINESS PROFILE — no auth required
// ============================================

app.get('/api/public/profile/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    const [{ data: user }, { data: invoices }, { data: callLogs }] = await Promise.all([
      supabase.from('users').select('id, business_name, plan, created_at, gstin').eq('id', userId).single(),
      supabase.from('invoices').select('invoice_amount, payment_status, days_overdue, customer_name').eq('user_id', userId),
      supabase.from('call_logs').select('id').eq('user_id', userId),
    ]);

    if (!user) return res.status(404).json({ error: 'Business not found' });

    const safe = invoices || [];
    const totalInvoices   = safe.length;
    const paidInvoices    = safe.filter(i => i.payment_status === 'Paid').length;
    const totalManaged    = safe.reduce((s, i) => s + i.invoice_amount, 0);
    const recoveryRate    = totalInvoices > 0 ? Math.round((paidInvoices / totalInvoices) * 100) : 0;
    const totalCustomers  = new Set(safe.map(i => i.customer_name)).size;
    const memberDays      = Math.floor((Date.now() - new Date(user.created_at)) / 86400000);

    // Trust Score: weighted formula (max 100)
    const recScore   = recoveryRate * 0.40;
    const volScore   = Math.min(totalInvoices, 100) / 100 * 100 * 0.20;
    const ageScore   = Math.min(memberDays, 365) / 365 * 100 * 0.20;
    const callScore  = Math.min((callLogs || []).length, 50) / 50 * 100 * 0.20;
    const trustScore = Math.round(recScore + volScore + ageScore + callScore);

    // Vantro ID: VAN- + first 8 chars of userId
    const vantroId = 'VAN-' + userId.replace(/-/g, '').slice(0, 8).toUpperCase();

    // Badges
    const badges = [];
    if (totalInvoices >= 10) badges.push('Active Business');
    if (recoveryRate >= 60)  badges.push('Strong Collector');
    if (memberDays  >= 30)   badges.push('Verified Member');
    if (user.gstin)          badges.push('GST Registered');
    if (trustScore  >= 70)   badges.push('Trusted Partner');

    res.json({
      success: true,
      profile: {
        vantro_id:       vantroId,
        business_name:   user.business_name,
        member_since:    user.created_at,
        plan:            user.plan,
        trust_score:     trustScore,
        recovery_rate:   recoveryRate,
        total_customers: totalCustomers,
        total_managed:   totalManaged,
        total_invoices:  totalInvoices,
        member_days:     memberDays,
        badges,
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// AI CALL SCRIPT GENERATOR
// ============================================

app.post('/api/ai/call-script', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { customer_name, invoice_amount, days_overdue, call_count = 0, has_promise = false, tone = 'soft' } = req.body;

    if (!customer_name || !invoice_amount) {
      return res.status(400).json({ error: 'customer_name and invoice_amount required' });
    }

    const toneGuide = {
      soft: 'polite aur friendly — pehli baar call kar rahe hain',
      firm: 'professional aur direct — 2-3 baar try kar chuke hain',
      urgent: 'serious aur urgent — bahut zyada overdue hai, strong follow-up chahiye',
    };

    // Fetch owner voice profile for personalization
    let ownerVoiceContext = '';
    try {
      const { data: profile } = await supabase.from('users')
        .select('owner_name, city, voice_style, ai_persona').eq('id', userId).single();
      if (profile?.owner_name || profile?.ai_persona) {
        const styleMap = {
          casual_hinglish: 'casual Hinglish, uses bhai/yaar, short and direct',
          formal_hindi: 'formal respectful Hindi, uses aap, full sentences',
          direct_english: 'direct professional English, concise',
          friendly_urdu: 'friendly Urdu-Hindi mix, warm tone',
          regional_hindi: 'regional Hinglish dialect',
        };
        ownerVoiceContext = `\nThe script is being generated FOR ${profile.owner_name || 'the business owner'} from ${profile.city || 'India'}. Their communication style is: ${styleMap[profile.voice_style] || 'natural Hinglish'}. ${profile.ai_persona ? 'How they talk: ' + profile.ai_persona : ''} Make the script sound EXACTLY like them — not a generic bot.`;
      }
    } catch (_) {}

    const prompt = `You are Vantro AI, an expert Hinglish debt collection assistant for Indian MSMEs.
${ownerVoiceContext}
Generate a COMPLETE phone call script for collecting payment. The script must be in Hinglish (natural mix of Hindi and English as spoken in India).

Debtor: ${customer_name}
Amount: ₹${invoice_amount.toLocaleString('en-IN')}
Days overdue: ${days_overdue || 0} days
Previous call attempts: ${call_count}
Has made a payment promise before: ${has_promise ? 'Yes' : 'No'}
Tone required: ${toneGuide[tone] || toneGuide.soft}

Generate a JSON response with this exact structure:
{
  "opening": "The first 2-3 sentences to say when they pick up. Max 30 words. Include greeting and reason for call.",
  "main_ask": "The core ask — what you want them to do. 1 clear sentence.",
  "objection_handler": "What to say if they say 'baad mein karenge' or 'paise nahi hain'. 2-3 sentences.",
  "closing": "How to end the call politely regardless of outcome. 1-2 sentences.",
  "whatsapp_followup": "A WhatsApp message to send after the call. Max 40 words. Include payment reminder.",
  "key_phrases": ["3-4 short Hinglish phrases to use naturally during the call"],
  "tone_rating": "${tone}"
}

Use natural Hinglish like "bhai", "aap", "theek hai", "koi baat nahi", "kal tak", etc. Sound human, not robotic.`;

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.4,
        response_format: { type: 'json_object' },
      }),
    });

    const groqData = await response.json();
    const scriptRaw = groqData.choices?.[0]?.message?.content;

    if (!scriptRaw) throw new Error('Groq returned no content');
    const script = JSON.parse(scriptRaw);

    res.json({ success: true, script, debtor: customer_name, amount: invoice_amount });
  } catch (err) {
    console.error('Call script error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// AI BULK WHATSAPP GENERATOR
// ============================================

app.post('/api/ai/bulk-whatsapp', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;

    // Get all high-priority overdue invoices
    const { data: invoices } = await supabase
      .from('invoices')
      .select('customer_name, customer_phone, invoice_amount, days_overdue')
      .eq('user_id', userId)
      .neq('payment_status', 'Paid')
      .gt('days_overdue', 0)
      .order('days_overdue', { ascending: false })
      .limit(20);

    if (!invoices?.length) return res.json({ success: true, messages: [] });

    // Generate messages for top 10 overdue
    const top = invoices.slice(0, 10);

    // Fetch owner voice for personalized messages
    let bulkVoiceCtx = '';
    try {
      const { data: profile } = await supabase.from('users')
        .select('owner_name, city, voice_style, ai_persona').eq('id', userId).single();
      if (profile?.owner_name || profile?.ai_persona) {
        bulkVoiceCtx = `\nGenerate these messages as if written by ${profile.owner_name || 'the business owner'} personally. Style: ${profile.voice_style || 'casual_hinglish'}. ${profile.ai_persona ? profile.ai_persona : ''} Sound like a real person they know, not a robot.`;
      }
    } catch (_) {}

    const prompt = `You are Vantro AI. Generate WhatsApp payment reminder messages in Hinglish for multiple debtors.${bulkVoiceCtx}

Debtors list:
${top.map((d, i) => `${i + 1}. ${d.customer_name} — ₹${d.invoice_amount?.toLocaleString('en-IN')} — ${d.days_overdue} days overdue`).join('\n')}

For each debtor, generate a short WhatsApp message (max 35 words) that is:
- Personal (uses their name)
- States the amount clearly
- Has a clear ask (pay today / share timeline)
- Ends with a question or CTA

Return JSON array: [{"name": "customer name", "message": "the message", "urgency": "high|medium|low"}]
Sort by urgency (most overdue first). Use natural Hinglish.`;

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        response_format: { type: 'json_object' },
      }),
    });

    const groqData = await response.json();
    const raw = groqData.choices?.[0]?.message?.content;
    let messages = [];

    try {
      const parsed = JSON.parse(raw);
      messages = Array.isArray(parsed) ? parsed : parsed.messages || parsed.data || [];
    } catch {
      messages = [];
    }

    // Merge phone numbers
    const result = messages.map(m => {
      const inv = top.find(i => i.customer_name === m.name);
      return { ...m, phone: inv?.customer_phone || null };
    });

    res.json({ success: true, messages: result, count: result.length });
  } catch (err) {
    console.error('Bulk WhatsApp error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// AI VOICE EXTRACTOR — learn owner's writing style
// ============================================

app.post('/api/ai/extract-voice', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { samples } = req.body; // array of 2-5 sample messages the owner has written

    if (!samples || !Array.isArray(samples) || samples.length < 1) {
      return res.status(400).json({ error: 'Provide at least 1 sample message' });
    }

    const prompt = `Analyze these WhatsApp/text messages written by an Indian business owner and extract their writing style in 2-3 sentences.

Messages:
${samples.map((s, i) => `${i + 1}. "${s}"`).join('\n')}

Write a style description that captures:
- Language mix (Hindi/English/Hinglish ratio)
- Tone (casual/formal/direct/friendly)
- Typical phrases or words they use
- Message length preference
- How they address people

Output JSON: { "style_description": "2-3 sentences describing exact style", "detected_style": "casual_hinglish|formal_hindi|direct_english|friendly_urdu|regional_hindi", "sample_phrase": "a short example phrase in their style" }`;

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        response_format: { type: 'json_object' },
      }),
    });

    const groqData = await response.json();
    const result = JSON.parse(groqData.choices?.[0]?.message?.content || '{}');

    // Auto-save the detected style to user profile
    await supabase.from('users').update({
      ai_persona: result.style_description,
      voice_style: result.detected_style || 'casual_hinglish',
      updated_at: new Date(),
    }).eq('id', userId);

    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Extract voice error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// TWILIO VOICE CALLING — AI calls debtors
// ============================================

const getTwilio = (sid, token) => {
  const s = sid || process.env.TWILIO_ACCOUNT_SID;
  const t = token || process.env.TWILIO_AUTH_TOKEN;
  if (!s || !t) return null;
  try { const twilio = require('twilio'); return twilio(s, t); }
  catch { return null; }
};

// Helper: get Twilio credentials for a user (DB first, then env vars)
async function getUserTwilioCreds(userId) {
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
    return { sid: process.env.TWILIO_ACCOUNT_SID, token: process.env.TWILIO_AUTH_TOKEN, phone: process.env.TWILIO_PHONE_NUMBER };
  }
  if (!userId) return null;
  const { data } = await supabase.from('users').select('twilio_account_sid, twilio_auth_token, twilio_phone_number').eq('id', userId).single();
  if (data?.twilio_account_sid && data?.twilio_auth_token) {
    return { sid: data.twilio_account_sid, token: data.twilio_auth_token, phone: data.twilio_phone_number };
  }
  return null;
}

// Check Twilio config
app.get('/api/voice/config', authMiddleware, async (req, res) => {
  const configured = !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER);
  res.json({
    configured,
    missing: ['TWILIO_ACCOUNT_SID','TWILIO_AUTH_TOKEN','TWILIO_PHONE_NUMBER'].filter(k => !process.env[k]),
    setup_url: 'https://console.twilio.com',
    instructions: 'Sign up at twilio.com → buy a +91 Indian number → add 3 env vars to Railway → AI calling activates instantly',
  });
});

// Initiate outbound AI call
app.post('/api/voice/call', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { customer_name, customer_phone, invoice_amount, days_overdue, invoice_id, tone = 'soft' } = req.body;
    if (!customer_phone) return res.status(400).json({ error: 'customer_phone required' });

    const twilioClient = getTwilio();
    if (!twilioClient) {
      return res.status(503).json({
        error: 'Twilio not configured yet',
        action: 'Go to Railway → Variables → add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER',
        setup_url: 'https://console.twilio.com',
      });
    }
    // Phase 2C.35-P1: external-send kill switch — no outbound voice call unless enabled.
    const _voiceBlock = guardExternalSend('voice');
    if (_voiceBlock) return res.status(503).json({ error: 'External sending is disabled', reason: _voiceBlock.reason });

    // Fetch owner voice profile
    const { data: profile } = await supabase.from('users')
      .select('business_name, owner_name, ai_persona').eq('id', userId).single();

    // Generate opening script via Groq
    let openingScript = `Namaste ${customer_name} ji, main ${profile?.business_name || 'Vantro'} se bol raha hoon. Aapka rupaye ${invoice_amount} pending hai. Kya aaj payment ho sakti hai?`;
    try {
      const gr = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [{ role: 'user', content: `Write a 20-word Hinglish phone call opening for collecting ₹${invoice_amount} from ${customer_name}, ${days_overdue} days overdue. Tone: ${tone}. Business: ${profile?.business_name}. ${profile?.ai_persona || ''}. Output only the script text.` }],
          temperature: 0.3,
        }),
      });
      const gd = await gr.json();
      const s = gd.choices?.[0]?.message?.content?.trim();
      if (s && s.length > 10) openingScript = s;
    } catch (_) {}

    // Log the call
    await supabase.from('call_logs').insert([{
      user_id: userId, invoice_id: invoice_id || null,
      customer_name, customer_phone, amount: invoice_amount,
      did_pick_up: false, notes: `AI call initiated. Script: "${openingScript}"`, created_at: new Date(),
    }]);

    const phone = String(customer_phone).replace(/\D/g, '');
    const toPhone = phone.length === 10 ? `+91${phone}` : `+${phone}`;
    const safeScript = openingScript.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

    const call = await twilioClient.calls.create({
      to: toPhone,
      from: process.env.TWILIO_PHONE_NUMBER,
      twiml: `<Response><Say voice="Polly.Aditi" language="hi-IN">${safeScript}</Say><Pause length="2"/><Say voice="Polly.Aditi" language="hi-IN">Payment ke liye please call wapas karein ya WhatsApp karein. Dhanyavaad.</Say></Response>`,
      statusCallback: `${process.env.RAILWAY_PUBLIC_URL || 'https://vantro-flow-backend-production.up.railway.app'}/api/voice/status?uid=${encodeURIComponent(userId)}`,
      statusCallbackEvent: ['completed'],
      timeout: 30,
    });

    res.json({ success: true, call_sid: call.sid, status: call.status, script: openingScript });
  } catch (err) {
    console.error('Twilio error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Twilio status webhook
app.post('/api/voice/status', async (req, res) => {
  try {
    const voiceSecret = getSecret('VOICE_WEBHOOK_SECRET');
    const provided = req.headers['x-vantro-webhook-secret'] || req.query.secret;
    if (!voiceSecret) return res.sendStatus(403);
    if (voiceSecret && !timingSafeEqualString(provided, voiceSecret)) return res.sendStatus(403);
    const userId = req.query.uid;
    const { CallStatus, CallDuration, To } = req.body;
    const phone = (To || '').replace(/^\+91/, '').replace(/\D/g, '');
    if (phone && userId) {
      await supabase.from('call_logs')
        .update({ did_pick_up: CallStatus === 'completed', call_duration_minutes: Math.ceil(parseInt(CallDuration || '0') / 60) })
        .eq('user_id', userId)
        .eq('customer_phone', phone)
        .order('created_at', { ascending: false })
        .limit(1);
    }
  } catch (_) {}
  res.sendStatus(200);
});

// ============================================
// PUSH NOTIFICATIONS
// ============================================

// Get VAPID public key (needed by frontend to subscribe)
app.get('/api/notifications/vapid-key', (req, res) => {
  const key = process.env.VAPID_PUBLIC_KEY;
  if (!key) return res.json({ success: false, message: 'Push notifications not configured' });
  res.json({ success: true, publicKey: key });
});

// Save push subscription to user's row
app.post('/api/notifications/subscribe', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { subscription } = req.body; // PushSubscription object from browser
    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ error: 'Invalid subscription object' });
    }
    await supabase.from('users')
      .update({ push_subscription: subscription })
      .eq('id', userId);
    res.json({ success: true, message: 'Push subscription saved' });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Internal helper: send push to a user
async function sendPushToUser(userId, title, body, data = {}) {
  if (!process.env.VAPID_PUBLIC_KEY) return; // not configured
  // Phase 2C.35-P2: web-push is fail-closed for launch (FEATURE_PUSH_NOTIFICATIONS_ENABLED).
  if (guardPush()) return;
  try {
    const { data: user } = await supabase
      .from('users').select('push_subscription').eq('id', userId).single();
    if (!user?.push_subscription) return;

    const payload = JSON.stringify({ title, body, data, icon: '/icon-192.png', badge: '/icon-192.png' });
    await webpush.sendNotification(user.push_subscription, payload);
  } catch (err) {
    // Subscription expired or invalid — clear it
    if (err.statusCode === 410 || err.statusCode === 404) {
      await supabase.from('users').update({ push_subscription: null }).eq('id', userId);
    }
    console.error('Push notification error:', err.message);
  }
}

// ============================================
// RAZORPAY WEBHOOK — auto-mark invoice paid
// ============================================

// IMPORTANT: Raw body captured by middleware above for HMAC verification
app.post('/api/payments/webhook', async (req, res) => {
    try {
      const signature = req.headers['x-razorpay-signature'];
      if (!signature) return res.status(400).json({ error: 'Invalid signature' });

      const secret = getSecret('RAZORPAY_WEBHOOK_SECRET');
      const prevSecret = getPreviousSecret('RAZORPAY_WEBHOOK_SECRET');
      if (!secret) {
        return res.status(503).json({ error: 'Webhook verification is not configured' });
      }

      // Verify signature using raw body
      const rawBody = req.rawBody !== undefined ? req.rawBody : JSON.stringify(req.body || {});
      const expectedSig = crypto
        .createHmac('sha256', secret)
        .update(rawBody)
        .digest('hex');

      let isValid = timingSafeEqualString(signature, expectedSig);
      if (!isValid && prevSecret) {
        const expectedSigPrev = crypto
          .createHmac('sha256', prevSecret)
          .update(rawBody)
          .digest('hex');
        isValid = timingSafeEqualString(signature, expectedSigPrev);
      }

      if (!isValid) {
        console.warn('Razorpay webhook: invalid signature');
        logSecurityEvent(req, SecurityEventTaxonomy.WEBHOOK_SIGNATURE_FAILED, { provider: 'razorpay' });
        return res.status(400).json({ error: 'Invalid signature' });
      }

      const event = typeof req.body === 'object' ? req.body : JSON.parse(rawBody);

      // We care about payment_link.paid (payment link fully paid)
      if (event.event === 'payment_link.paid') {
        const pl = event.payload?.payment_link?.entity;
        const payment = event.payload?.payment?.entity;

        if (!pl) return res.sendStatus(200);

        const paymentLinkId = pl.id;
        const amountPaid = (payment?.amount || pl.amount_paid || 0) / 100; // paise → ₹
        const payerName = payment?.notes?.contact || pl.customer?.name || '';
        const paymentId  = payment?.id || '';

        // Find the invoice that has this payment_link_id (use payment_status, not status)
        const { data: invoices } = await supabase
          .from('invoices')
          .select('id, user_id, customer_name, customer_phone, invoice_amount, invoice_number, payment_status')
          .eq('payment_status', 'Pending')
          .eq('payment_link_id', paymentLinkId)
          .limit(1);

        if (invoices && invoices.length > 0) {
          const inv = invoices[0];

    // Mark as paid
    await supabase.from('invoices')
      .update({
        payment_status: 'Paid',
        payment_date: new Date().toISOString().split('T')[0],
        payment_amount: amountPaid,
        payment_id: paymentId,
      })
      .eq('id', inv.id)
      .eq('user_id', inv.user_id)
      .eq('payment_status', 'Pending');

    // Add to transactions table for unified ledger
    const { data: existingTxn } = await supabase
      .from('bank_transactions')
      .select('id')
      .eq('user_id', inv.user_id)
      .eq('matched_type', 'invoice')
      .eq('matched_id', String(inv.id))
      .maybeSingle();
    if (!existingTxn) {
      await supabase.from('bank_transactions').insert([{
        user_id: inv.user_id,
        txn_date: new Date().toISOString().split('T')[0],
        description: `Payment received from ${inv.customer_name} for invoice ${inv.invoice_number || inv.id}`.trim(),
        amount: amountPaid,
        type: 'credit',
        status: 'matched',
        matched_type: 'invoice',
        matched_id: String(inv.id),
      }]);
    }
    await createActivityLog(inv.user_id, 'payment_webhook_processed', {
      entityType: 'invoice',
      entityId: inv.id,
      source: 'razorpay_webhook',
      paymentLinkId,
      paymentId,
      amount: amountPaid,
    });

    // Send push notification to the business owner
          await sendPushToUser(
            inv.user_id,
            `💰 Payment Received!`,
            `${inv.customer_name} ne ₹${Number(inv.invoice_amount).toLocaleString('en-IN')} bheja! Invoice auto-closed. 🎉`,
            { type: 'payment_received', invoice_id: inv.id, amount: inv.invoice_amount }
          );

          // Send thank-you WhatsApp to customer
          if (inv.customer_phone) {
            const firstName = (inv.customer_name || '').split(' ')[0];
            const amtFmt = Number(inv.invoice_amount).toLocaleString('en-IN');
            const thankYouMsg = `${firstName} ji 🙏\n\nAapka ₹${amtFmt} payment mil gaya. Bahut shukriya!\n\nReceipt ke liye app dekh sakte hain. Aage bhi aate rehna. 😊`;
            sendWhatsAppMessage(inv.customer_phone, thankYouMsg).catch(e =>
              console.error('[Webhook] Thank-you WA failed:', e.message)
            );
          }

          console.log(`✅ Webhook: Invoice ${inv.id} marked Paid via Razorpay (${paymentLinkId})`);
        } else {
          // Fallback: try matching by amount if no payment_link_id stored
          console.log(`Webhook: No invoice found for payment_link ${paymentLinkId}`);
        }
      }

      res.sendStatus(200);
    } catch (err) {
      console.error('Razorpay webhook error:', err.message);
      res.sendStatus(500);
    }
});

// ============================================
// WHATSAPP INBOUND WEBHOOK — reply-pause automation
// ============================================
// Register this URL in Interakt: Settings → Developer → Webhook URL
// Register in WATI: Configuration → Webhook → add this URL
// POST /api/webhooks/whatsapp-inbound

function parseSnoozeIntent(text) {
  // Returns { snoozeHours: number } if message contains a promise/snooze signal, else null
  const t = (text || '').toLowerCase().trim();

  // Hindi / Hinglish patterns
  if (/\b(aaj|today)\b/.test(t)) return { snoozeHours: 6 };
  if (/kal\s*(tak|dunga|de|deta|deti|payment|pay|kar|karunga|karugi)?/.test(t)) return { snoozeHours: 30 };
  if (/\bparso\b/.test(t)) return { snoozeHours: 54 };
  if (/(\d+)\s*din/.test(t)) {
    const days = parseInt(t.match(/(\d+)\s*din/)[1]);
    return { snoozeHours: Math.min(days, 30) * 24 };
  }
  if (/(\d+)\s*hafte/.test(t)) {
    const weeks = parseInt(t.match(/(\d+)\s*hafte/)[1]);
    return { snoozeHours: Math.min(weeks, 4) * 7 * 24 };
  }
  if (/\b(ek\s*hafte|next\s*week|1\s*week|one\s*week)\b/.test(t)) return { snoozeHours: 7 * 24 };
  if (/\b(2\s*week|do\s*hafte|two\s*week)\b/.test(t)) return { snoozeHours: 14 * 24 };
  if (/\b(mahine|mahina|month|1\s*month|ek\s*mahina)\b/.test(t)) return { snoozeHours: 30 * 24 };

  // English patterns
  if (/\btomorrow\b/.test(t)) return { snoozeHours: 30 };
  if (/\bday after tomorrow\b/.test(t)) return { snoozeHours: 54 };
  if (/(\d+)\s*days?/.test(t)) {
    const days = parseInt(t.match(/(\d+)\s*days?/)[1]);
    return { snoozeHours: Math.min(days, 30) * 24 };
  }

  // Generic payment promises
  if (/\b(pay|payment|bhejta|bhejtа|dunga|de raha|karunga|transfer)\b/.test(t)) return { snoozeHours: 48 };

  return null;
}

app.post('/api/webhooks/whatsapp-inbound', async (req, res) => {
  try {
    res.sendStatus(200); // Acknowledge immediately (Interakt/WATI require fast 200)

    const webhookSecret = getSecret('WHATSAPP_WEBHOOK_SECRET');
    const provided = req.headers['x-vantro-webhook-secret'] || req.query.secret;
    if (!webhookSecret) return;
    if (webhookSecret && !timingSafeEqualString(provided, webhookSecret)) return;

    const body = req.body;

    // ── Normalise across Interakt & WATI formats ──────────────────
    let senderPhone = null;
    let messageText = null;

    // Interakt format
    if (body?.data?.message?.message?.text) {
      messageText = body.data.message.message.text;
      senderPhone = body.data.message.customer?.phone_number || body.data.customer?.phone_number;
    }
    // WATI format
    if (body?.waId && body?.text?.body) {
      senderPhone = body.waId;
      messageText = body.text.body;
    }
    // Generic fallback
    if (!messageText && body?.message) messageText = body.message;
    if (!senderPhone && body?.phone) senderPhone = body.phone;

    if (!senderPhone || !messageText) return;

    const snooze = parseSnoozeIntent(messageText);
    if (!snooze) return; // not a payment promise — ignore

    // Normalise phone (digits only, strip leading 91/+91)
    const normPhone = String(senderPhone).replace(/\D/g, '').replace(/^91/, '');

    // Find the most recent pending invoice for this phone
    const { data: invoices } = await supabase
      .from('invoices')
      .select('id, user_id, customer_name, invoice_amount')
      .eq('payment_status', 'Pending')
      .or(`customer_phone.eq.${normPhone},customer_phone.eq.91${normPhone},customer_phone.eq.+91${normPhone}`)
      .order('days_overdue', { ascending: false })
      .limit(1);

    if (!invoices?.length) return;
    const inv = invoices[0];

    const snoozeUntil = new Date(Date.now() + snooze.snoozeHours * 3600000).toISOString();

    await supabase
      .from('invoices')
      .update({ snooze_until: snoozeUntil })
      .eq('id', inv.id)
      .eq('user_id', inv.user_id);

    console.log(`[WA-inbound] Snoozed invoice ${inv.id} until ${snoozeUntil} (customer name + reply body suppressed from logs)`);
  } catch (err) {
    console.error('[WA-inbound] Error:', err.message);
  }
});

// ============================================
// MORNING BRIEFING CRON — 8:00 AM IST daily
// ============================================
// IST = UTC+5:30 → 8am IST = 2:30 UTC
cron.schedule('30 2 * * *', async () => {
  console.log('⏰ Morning briefing cron running — 8am IST');
  try {
    // Get all users who have a phone number (for WA brief) OR push subscription
    const { data: users } = await supabase
      .from('users')
      .select('id, business_name, phone, push_subscription')
      .or('phone.not.is.null,push_subscription.not.is.null');

    if (!users || users.length === 0) return;

    for (const user of users) {
      try {
        // Get their overdue invoices (payment_status = 'Pending' and days_overdue > 0)
        const { data: overdue } = await supabase
          .from('invoices')
          .select('id, customer_name, invoice_amount, days_overdue')
          .eq('user_id', user.id)
          .eq('payment_status', 'Pending')
          .gt('days_overdue', 0)
          .order('invoice_amount', { ascending: false })
          .limit(3);

        if (!overdue || overdue.length === 0) continue;

        const topDebtor = overdue[0];
        const totalOverdue = overdue.reduce((s, i) => s + Number(i.invoice_amount), 0);

        // Push notification
        await sendPushToUser(
          user.id,
          `Subah ka briefing - Vantro Flow`,
          `${overdue.length} overdue invoices. Top: ${topDebtor.customer_name} (Rs.${Number(topDebtor.invoice_amount).toLocaleString('en-IN')}). Total pending: Rs.${totalOverdue.toLocaleString('en-IN')}`,
          { type: 'morning_briefing', count: overdue.length, total: totalOverdue }
        );

        // WhatsApp Morning Brief - the addiction trigger
        if (user.phone) {
          const top3 = (overdue || []).slice(0, 3).map((inv, i) => {
            const days = inv.days_overdue || 0;
            const amt = Number(inv.invoice_amount).toLocaleString('en-IN');
            const tag = days > 30 ? '(urgent)' : days > 15 ? '(follow up)' : '(due)';
            return `${i+1}. ${inv.customer_name} - Rs.${amt} ${tag}`;
          }).join('\n');
          const waMsg = `Subah ka update - Vantro Flow

Aaj collect karna hai: Rs.${totalOverdue.toLocaleString('en-IN')}

${top3}

Vantro ne aapke liye auto-reminders queue kar diye hain. App kholein aur ek click mein sab bhejein.`;
          await sendWhatsAppMessage(user.phone, waMsg);
        }
      } catch (userErr) {
        console.error(`Morning briefing error for user ${user.id}:`, userErr.message);
      }
    }
    console.log(`✅ Morning briefing sent to ${users.length} users`);
  } catch (err) {
    console.error('Morning briefing cron error:', err.message);
  }
}, { timezone: 'UTC' });

// ============================================
// BANK LEDGER — TRANSACTIONS
// ============================================

// Create transactions table
// Add snooze_until + reminder tracking columns to invoices
// ============================================
// RECONCILIATION & BACKFILL
// ============================================

app.post('/api/reconcile/backfill', requireAdmin, async (req, res) => {
  const { dryRun = 'true' } = req.query;
  const isDryRun = dryRun === 'true';
  const userId = req.user.userId;

  try {
    const report = {
      purchasesBackfilled: [],
      salesBackfilled: [],
      paymentsBackfilled: [],
      productsRecalculated: [],
      skippedDuplicates: 0,
      counts: {
        purchases: 0,
        sales: 0,
        payments: 0,
      },
      isDryRun
    };

    // 1. BACKFILL PURCHASES -> INVENTORY
    const { data: purchases } = await supabase.from('purchases').select('*').eq('user_id', userId);
    const { data: pMovements } = await supabase.from('stock_movements').select('reference').eq('user_id', userId).not('reference', 'is', null);
    const movementRefs = new Set((pMovements || []).map(m => m.reference));

    for (const p of (purchases || [])) {
      const ref = p.bill_number || String(p.id);
      if (movementRefs.has(ref)) {
        report.skippedDuplicates++;
        continue;
      }

      const items = getPurchaseItems(p);
      if (!items.length) continue;

      if (!isDryRun) {
        // Find or create products and add movements
        for (const item of items) {
          const qty = toMoney(item.qty);
          if (qty <= 0) continue;
          
          let { data: product } = await supabase.from('products').select('id').eq('user_id', userId).ilike('name', item.description).maybeSingle();
          if (!product) {
             const { data: newProd } = await supabase.from('products').insert([{ user_id: userId, name: item.description, current_stock: 0 }]).select().single();
             product = newProd;
          }

          await supabase.from('stock_movements').insert([{
            user_id: userId,
            product_id: product.id,
            movement_type: 'in',
            quantity: qty,
            unit_cost: toMoney(item.unit_price) || null,
            reference: ref,
            notes: `Backfilled from purchase ${ref}`.trim(),
          }]);
        }
      }
      report.purchasesBackfilled.push({ id: p.id, ref });
      report.counts.purchases++;
    }

    // 2. BACKFILL SALES -> INVENTORY
    const { data: sales } = await supabase.from('sales').select('*').eq('user_id', userId);
    for (const s of (sales || [])) {
      const ref = s.invoice_number || String(s.id);
      if (movementRefs.has(ref)) {
        report.skippedDuplicates++;
        continue;
      }

      const items = getPurchaseItems(s);
      if (!items.length) continue;

      if (!isDryRun) {
        for (const item of items) {
          const qty = toMoney(item.qty);
          if (qty <= 0) continue;

          let { data: product } = await supabase.from('products').select('id').eq('user_id', userId).ilike('name', item.description).maybeSingle();
          if (product) {
            await supabase.from('stock_movements').insert([{
              user_id: userId,
              product_id: product.id,
              movement_type: 'out',
              quantity: qty,
              reference: ref,
              notes: `Backfilled from sale ${ref}`.trim(),
            }]);
          }
        }
      }
      report.salesBackfilled.push({ id: s.id, ref });
      report.counts.sales++;
    }

    // 3. BACKFILL PAID INVOICES -> LEDGER
    const { data: invoices } = await supabase.from('invoices').select('*').eq('user_id', userId).eq('payment_status', 'Paid');
    const { data: bTxns } = await supabase.from('bank_transactions').select('matched_id').eq('user_id', userId).eq('matched_type', 'invoice');
    const matchedIds = new Set((bTxns || []).map(t => String(t.matched_id)));

    for (const inv of (invoices || [])) {
      if (matchedIds.has(String(inv.id))) {
        report.skippedDuplicates++;
        continue;
      }

      if (!isDryRun) {
        await supabase.from('bank_transactions').insert([{
          user_id: userId,
          txn_date: inv.payment_date || inv.invoice_date || new Date().toISOString().split('T')[0],
          description: `Backfill: Payment from ${inv.customer_name} for inv ${inv.invoice_number || inv.id}`.trim(),
          amount: toMoney(inv.payment_amount || inv.invoice_amount),
          type: 'credit',
          status: 'matched',
          matched_type: 'invoice',
          matched_id: String(inv.id),
        }]);
      }
      report.paymentsBackfilled.push({ id: inv.id, inv: inv.invoice_number });
      report.counts.payments++;
    }

    // 4. RECALCULATE PRODUCT STOCK
    if (!isDryRun) {
      const { data: products } = await supabase.from('products').select('id, name').eq('user_id', userId);
      for (const prod of (products || [])) {
        const { data: movements } = await supabase.from('stock_movements').select('movement_type, quantity').eq('product_id', prod.id);
        let stock = 0;
        (movements || []).forEach(m => {
          if (m.movement_type === 'in') stock += toMoney(m.quantity);
          else stock -= toMoney(m.quantity);
        });
        await supabase.from('products').update({ current_stock: stock, updated_at: new Date() }).eq('id', prod.id);
        report.productsRecalculated.push({ name: prod.name, new_stock: stock });
      }
    }

    res.json({ success: true, report });
  } catch (err) {
    console.error('[reconcile/backfill]', err);
    res.status(500).json({ error: 'Internal server error', detail: err.message });
  }
});

app.post('/api/invoices/migrate', requireAdmin, async (req, res) => {
  try {
    const pool2 = getPool();
    await pool2.query(`
      ALTER TABLE invoices ADD COLUMN IF NOT EXISTS snooze_until TIMESTAMPTZ;
      ALTER TABLE invoices ADD COLUMN IF NOT EXISTS last_reminder_sent TIMESTAMPTZ;
      ALTER TABLE invoices ADD COLUMN IF NOT EXISTS reminder_count INTEGER DEFAULT 0;
      ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_link TEXT;
      ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_link_id TEXT;
      CREATE INDEX IF NOT EXISTS idx_inv_snooze ON invoices(snooze_until) WHERE snooze_until IS NOT NULL;
    `);
    res.json({ success: true, message: 'Invoice columns migrated (snooze_until, last_reminder_sent, reminder_count, payment_link, payment_link_id)' });
  } catch (err) {
    console.error('[invoices/migrate]', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/transactions/migrate', requireAdmin, async (req, res) => {
  try {
    await ensureTransactionsTable();
    res.json({ success: true, storage: 'transactions+bank_transactions' });
  } catch (err) {
    console.error('[transactions migrate]', err);
    res.status(503).json({
      success: false,
      error: err.message || 'Ledger database migration failed',
      instructions: 'Set DATABASE_URL in Railway to the Supabase Postgres URI so Vantro can create ledger tables automatically.',
    });
  }
});

// GET all transactions for a user
app.get('/api/transactions/:userId', requireOwner, async (req, res) => {
  const { userId } = req.params;
  const { type, category, limit = 200 } = req.query;
  try {
    await ensureConnectedBusinessData(userId);
    let q = supabase
      .from('bank_transactions')
      .select('*')
      .eq('user_id', userId)
      .order('txn_date', { ascending: false })
      .limit(parseInt(limit));

    if (type && type !== 'all') q = q.eq('type', ledgerTypeToBankType(type));

    const { data, error } = await q;
    if (error) throw error;

    let transactions = (data || []).map(mapBankTransactionToLedger);
    if (category && category !== 'all') transactions = transactions.filter(txn => txn.category === category);

    res.json({ transactions, summary: buildLedgerSummary(transactions) });
  } catch (err) {
    console.error('[transactions GET]', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

// POST add a transaction
app.post('/api/transactions', authMiddleware, async (req, res) => {
  const { type, category, amount, description, party_name, transaction_date, payment_method, reference, notes } = req.body;
  const user_id = req.user.userId;
  try {
    const normalizedType = type === 'in' ? 'in' : type === 'out' ? 'out' : null;
    const numericAmount = Number.parseFloat(String(amount ?? '').replace(/[₹,\s]/g, ''));
    if (!normalizedType) return res.status(400).json({ success: false, error: 'type must be in or out' });
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({ success: false, error: 'amount must be greater than zero' });
    }

    const payload = {
      user_id,
      txn_date: transaction_date || new Date().toISOString().split('T')[0],
      description: composeLedgerDescription({ party_name, reference, description: notes || description, category }),
      amount: numericAmount,
      type: ledgerTypeToBankType(normalizedType),
      status: 'unmatched',
    };

    const { data, error } = await supabase
      .from('bank_transactions')
      .insert([payload])
      .select()
      .single();
    if (error) throw error;
    await createActivityLog(user_id, 'ledger_transaction_created', {
      entityType: 'bank_transaction',
      entityId: data.id,
      source: 'api',
      amount: numericAmount,
      type: normalizedType,
    });

    res.json({ success: true, transaction: mapBankTransactionToLedger(data) });
  } catch (err) {
    console.error('[transactions POST]', err);
    res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
});

app.post('/api/transactions/scan', authMiddleware, async (req, res) => {
  try {
    const { image, image_base64, file, mimeType = 'image/jpeg' } = req.body;
    const payload = image || image_base64 || file;
    if (!payload) return res.status(400).json({ success: false, error: 'image or file is required' });
    const validation = validateScanImagePayload(payload, mimeType);
    if (!validation.valid) return res.status(400).json({ success: false, error: validation.error });

    const prompt = `You are a finance OCR assistant for Indian MSME bank ledgers.

Read this receipt, payment screenshot, bank statement page, cash memo, cheque, UPI proof, invoice, or PDF page.
Decide whether money entered the business or left the business.

Return ONLY valid JSON:
{
  "type": "in or out",
  "amount": number,
  "party_name": "person/company paid by or received from",
  "category": "Customer Payment, Supplier Payment, Worker Salary, Rent, Utilities, Raw Materials, Logistics / Transport, Maintenance, Marketing, Tax / GST, Loan / Credit, Refund Received, Other Income, Other Expense",
  "transaction_date": "YYYY-MM-DD or null",
  "payment_method": "UPI, Cash, Bank Transfer, Cheque, NEFT/RTGS, Card or Other",
  "reference": "UTR, cheque no, invoice no, bill no, transaction id or null",
  "description": "short human readable summary",
  "confidence": number_between_0_and_1
}

Rules:
- If this is a purchase bill, supplier invoice, outgoing payment proof, or expense receipt, type is "out".
- If this is a customer payment receipt, sale invoice payment proof, deposit, or credit received, type is "in".
- Amount must be the final transaction/grand total amount, without commas or currency symbols.
- If unsure, choose the most likely direction and set confidence below 0.7.`;

    const { parsed, rawText, provider, model, providersTried } = await runVisionExtraction({
      prompt,
      image: payload,
      mimeType,
      maxTokens: 900,
    });

    const typeRaw = cleanScanString(pickScanValue(parsed, ['type', 'direction', 'money_flow'])) || 'out';
    const type = /in|receive|credit|deposit/i.test(typeRaw) && !/out|debit|paid|expense/i.test(typeRaw) ? 'in' : 'out';
    const amount = parseScanNumber(pickScanValue(parsed, ['amount', 'total_amount', 'grand_total', 'paid_amount', 'transaction_amount'])) || 0;
    const fallbackCategory = type === 'in' ? 'Customer Payment' : 'Supplier Payment';
    const data = {
      type,
      category: cleanScanString(pickScanValue(parsed, ['category'])) || fallbackCategory,
      amount,
      party_name: cleanScanString(pickScanValue(parsed, ['party_name', 'paid_to', 'paid_by', 'supplier_name', 'customer_name', 'merchant_name'])),
      transaction_date: parseScanDate(pickScanValue(parsed, ['transaction_date', 'date', 'payment_date', 'bill_date'])) || new Date().toISOString().split('T')[0],
      payment_method: cleanScanString(pickScanValue(parsed, ['payment_method', 'method', 'mode'])) || 'UPI',
      reference: cleanScanString(pickScanValue(parsed, ['reference', 'utr', 'transaction_id', 'invoice_no', 'bill_number', 'cheque_no'])),
      description: cleanScanString(pickScanValue(parsed, ['description', 'summary', 'notes'])) || (type === 'in' ? 'Money received' : 'Money paid'),
      confidence: parseScanNumber(pickScanValue(parsed, ['confidence'])) || 0.65,
    };

    if (!data.amount) return res.status(422).json({ success: false, error: 'Could not identify transaction amount', _debug: IS_PRODUCTION ? undefined : rawText?.substring(0, 300), _provider: provider });
    res.json({ success: true, data, _provider: provider, _model: model, _providers_tried: providersTried });
  } catch (err) {
    sendVisionError(res, err, 'Transaction');
  }
});

// GET financial summary with category breakdown
app.get('/api/financial-summary/:userId', requireOwner, async (req, res) => {
  const { userId } = req.params;
  try {
    const pool2 = getPool();
    await syncExistingSalesReceivables(userId);

    const [totals, monthly, catBreakdown, recent, receivables, payables] = await Promise.all([
      pool2.query(`SELECT type, SUM(amount) as total, COUNT(*) as count FROM transactions WHERE user_id=$1 GROUP BY type`, [userId]),
      pool2.query(`SELECT TO_CHAR(transaction_date,'YYYY-MM') as month, type, SUM(amount) as total FROM transactions WHERE user_id=$1 AND transaction_date >= NOW()-INTERVAL '6 months' GROUP BY month,type ORDER BY month DESC`, [userId]),
      pool2.query(`SELECT category, type, SUM(amount) as total, COUNT(*) as count FROM transactions WHERE user_id=$1 GROUP BY category,type ORDER BY total DESC`, [userId]),
      pool2.query(`SELECT * FROM transactions WHERE user_id=$1 ORDER BY transaction_date DESC, created_at DESC LIMIT 5`, [userId]),
      getReceivableRows(userId),
      getPayableRows(userId),
    ]);

    const totalIn  = parseFloat(totals.rows.find(r => r.type === 'in')?.total  || 0);
    const totalOut = parseFloat(totals.rows.find(r => r.type === 'out')?.total || 0);
    const receivableOutstanding = receivables.reduce((sum, row) => sum + row.outstanding_amount, 0);
    const payableOutstanding = payables.reduce((sum, row) => sum + row.outstanding_amount, 0);
    const salesBooked = receivables.reduce((sum, row) => sum + row.amount, 0);
    const purchasesBooked = payables.reduce((sum, row) => sum + row.amount, 0);
    const collectedFromSales = receivables.reduce((sum, row) => sum + row.paid_amount, 0);
    const paidToSuppliers = payables.reduce((sum, row) => sum + row.paid_amount, 0);
    const cashPosition = totalIn - totalOut;
    const netPosition = cashPosition + receivableOutstanding - payableOutstanding;

    res.json({
      summary: {
        totalIn,
        totalOut,
        balance: cashPosition,
        cashPosition,
        netPosition,
        receivableOutstanding,
        payableOutstanding,
        salesBooked,
        purchasesBooked,
        collectedFromSales,
        paidToSuppliers,
        receivablesCount: receivables.filter(row => row.outstanding_amount > 0).length,
        payablesCount: payables.filter(row => row.outstanding_amount > 0).length,
      },
      monthly: monthly.rows,
      categories: catBreakdown.rows,
      recentTransactions: recent.rows,
    });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

// AI Financial Monitor
app.get('/api/ai-financial-monitor/:userId', requireOwner, async (req, res) => {
  const { userId } = req.params;
  try {
    const pool2 = getPool();
    await syncExistingSalesReceivables(userId);

    const [totals, last30, receivables, payables] = await Promise.all([
      pool2.query(`SELECT type, SUM(amount) as total FROM transactions WHERE user_id=$1 GROUP BY type`, [userId]),
      pool2.query(`SELECT category, type, SUM(amount) as total FROM transactions WHERE user_id=$1 AND transaction_date >= NOW()-INTERVAL '30 days' GROUP BY category,type ORDER BY total DESC`, [userId]),
      getReceivableRows(userId),
      getPayableRows(userId),
    ]);

    const totalIn  = parseFloat(totals.rows.find(r => r.type === 'in')?.total  || 0);
    const totalOut = parseFloat(totals.rows.find(r => r.type === 'out')?.total || 0);
    const outstanding = receivables.reduce((sum, row) => sum + row.outstanding_amount, 0);
    const payable = payables.reduce((sum, row) => sum + row.outstanding_amount, 0);
    const salesBooked = receivables.reduce((sum, row) => sum + row.amount, 0);
    const purchasesBooked = payables.reduce((sum, row) => sum + row.amount, 0);

    const expenseLines = last30.rows.filter(r => r.type === 'out').map(r => `  - ${r.category}: ₹${parseFloat(r.total).toLocaleString('en-IN')}`).join('\n');
    const incomeLines  = last30.rows.filter(r => r.type === 'in').map(r => `  - ${r.category}: ₹${parseFloat(r.total).toLocaleString('en-IN')}`).join('\n');

    const prompt = `You are a financial AI for an Indian MSME. Analyze this data:
TOTAL: In ₹${totalIn.toLocaleString('en-IN')}, Out ₹${totalOut.toLocaleString('en-IN')}, Balance ₹${(totalIn-totalOut).toLocaleString('en-IN')}
SALES BOOKED: ₹${salesBooked.toLocaleString('en-IN')}
PURCHASES BOOKED: ₹${purchasesBooked.toLocaleString('en-IN')}
CUSTOMER RECEIVABLES: ₹${outstanding.toLocaleString('en-IN')}
SUPPLIER PAYABLES: ₹${payable.toLocaleString('en-IN')}
LAST 30 DAYS EXPENSES:\n${expenseLines || '  (none)'}
LAST 30 DAYS INCOME:\n${incomeLines || '  (none)'}

Return JSON only:
{"health_score":0-100,"status":"healthy|warning|critical","summary":"2-3 sentences","alerts":[{"type":"warning|danger|info","message":"..."}],"insights":[{"title":"...","description":"...","action":"..."}],"top_expenses":[{"category":"...","amount":0,"pct":0}]}`;

    const aiRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: prompt }], temperature: 0.2, max_tokens: 1200 })
    });
    const aiData = await aiRes.json();
    const text = aiData.choices?.[0]?.message?.content || '{}';
    const match = text.match(/\{[\s\S]*\}/);
    const analysis = match ? JSON.parse(match[0]) : { health_score: 50, status: 'warning', summary: 'Insufficient data.', alerts: [], insights: [], top_expenses: [] };
    res.json({ success: true, analysis });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

// ============================================
// ORDERS — AI voice order management
// ============================================

app.get('/api/orders', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { date, from, to, status } = req.query;
    let query = supabase.from('orders').select('*, workers(name, phone)')
      .eq('user_id', userId).order('created_at', { ascending: false });
    if (status) query = query.eq('status', status);
    if (from && to) {
      query = query.gte('order_date', from).lte('order_date', to);
    } else {
      const today = new Date().toISOString().split('T')[0];
      query = query.eq('order_date', date || today);
    }
    const { data, error } = await query;
    if (error) throw error;
    res.json({ success: true, orders: data || [] });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/orders', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { customer_name, customer_phone, delivery_address, items, total_amount, delivery_time, special_instructions, worker_id } = req.body;
    const { data, error } = await supabase.from('orders').insert([{
      user_id: userId, customer_name, customer_phone,
      delivery_address, items: items || [], total_amount: total_amount || null,
      delivery_time, special_instructions, worker_id: worker_id || null,
      source: 'manual', status: 'new',
      order_date: new Date().toISOString().split('T')[0], created_at: new Date(),
    }]).select().single();
    if (error) throw error;
    res.json({ success: true, order: data });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

app.patch('/api/orders/:id', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const updates = pickAllowed(req.body, ['customer_name', 'customer_phone', 'delivery_address', 'items', 'total_amount', 'delivery_time', 'special_instructions', 'worker_id', 'status']);
    updates.updated_at = new Date();
    const { data, error } = await supabase.from('orders')
      .update(updates)
      .eq('id', req.params.id).eq('user_id', userId).select().single();
    if (error) throw error;
    res.json({ success: true, order: data });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

app.delete('/api/orders/:id', authMiddleware, async (req, res) => {
  try {
    await supabase.from('orders').delete().eq('id', req.params.id).eq('user_id', req.user.userId);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

// ============================================
// WORKERS — team management
// ============================================

app.get('/api/workers', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase.from('workers')
      .select('*').eq('user_id', req.user.userId).order('name');
    if (error) throw error;
    res.json({ success: true, workers: data || [] });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/workers', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { name, phone, role } = req.body;
    if (!name) return res.status(400).json({ error: 'Worker name required' });
    const { data, error } = await supabase.from('workers').insert([{
      user_id: userId, name, phone, role: role || 'delivery', is_active: true, created_at: new Date()
    }]).select().single();
    if (error) throw error;
    res.json({ success: true, worker: data });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

app.patch('/api/workers/:id', authMiddleware, async (req, res) => {
  try {
    const updates = pickAllowed(req.body, ['name', 'phone', 'role', 'is_active']);
    const { data, error } = await supabase.from('workers')
      .update(updates).eq('id', req.params.id).eq('user_id', req.user.userId).select().single();
    if (error) throw error;
    res.json({ success: true, worker: data });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

app.delete('/api/workers/:id', authMiddleware, async (req, res) => {
  try {
    await supabase.from('workers').delete().eq('id', req.params.id).eq('user_id', req.user.userId);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

// ============================================
// BUSINESS VOCABULARY — AI Training
// ============================================

app.get('/api/vocabulary', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase.from('business_vocabulary')
      .select('*').eq('user_id', req.user.userId).order('category').order('term');
    if (error) throw error;
    res.json({ success: true, vocabulary: data || [] });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/vocabulary', authMiddleware, async (req, res) => {
  try {
    const { term, meaning, category, aliases } = req.body;
    if (!term || !meaning) return res.status(400).json({ error: 'term and meaning required' });
    const { data, error } = await supabase.from('business_vocabulary').insert([{
      user_id: req.user.userId, term, meaning,
      category: category || 'product', aliases: aliases || [], created_at: new Date()
    }]).select().single();
    if (error) throw error;
    res.json({ success: true, item: data });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

app.delete('/api/vocabulary/:id', authMiddleware, async (req, res) => {
  try {
    await supabase.from('business_vocabulary').delete().eq('id', req.params.id).eq('user_id', req.user.userId);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

// Seed starter vocabulary by industry
app.post('/api/vocabulary/seed', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { industry } = req.body;
    const SEEDS = {
      construction: [
        { term: 'Bajri',   meaning: 'Fine river sand for plastering/concrete', aliases: ['bairi','najri','rait'] },
        { term: 'Gitti',   meaning: 'Crushed stone aggregate (10mm/20mm/40mm)', aliases: ['roori','stone chips','gravel'] },
        { term: 'Sariya',  meaning: 'Iron/TMT steel reinforcement rods', aliases: ['rod','lohiya','tmt','steel'] },
        { term: 'Cement',  meaning: 'Portland cement 50kg bags', aliases: ['siement','grey powder'] },
        { term: 'Rait',    meaning: 'General purpose sand', aliases: ['sand','balu'] },
        { term: 'Surkhi',  meaning: 'Brick powder for mortar', aliases: ['brick dust'] },
        { term: 'Eent',    meaning: 'Red clay fired bricks', aliases: ['int','bricks','lakhori'] },
        { term: 'Chuna',   meaning: 'White lime for whitewash or mortar', aliases: ['lime','choona'] },
        { term: 'Khamba',  meaning: 'RCC concrete pillar or post', aliases: ['pillar','column'] },
        { term: 'Brass',   meaning: '100 cubic feet — bulk unit for sand/stone', aliases: ['bras','100 cft'] },
        { term: 'CFT',     meaning: 'Cubic feet — measurement unit for aggregates', category: 'unit', aliases: ['ghanafit'] },
        { term: 'Truck',   meaning: 'Full truck load delivery (~8–10 tonnes)', category: 'unit', aliases: ['truck bhar','gadi bhar'] },
      ],
      textile: [
        { term: 'Thaan',   meaning: 'Full bolt/roll of fabric (~30m or 100m)', category: 'unit', aliases: ['bolt','roll'] },
        { term: 'Gaj',     meaning: 'Yard (≈0.9 metres) for fabric', category: 'unit', aliases: ['yard','gaz'] },
        { term: 'Malmal',  meaning: 'Fine muslin/cotton fabric', aliases: ['muslin','cotton fine'] },
        { term: 'Resham',  meaning: 'Silk fabric', aliases: ['silk'] },
        { term: 'Jeans',   meaning: 'Denim fabric or readymade jeans', aliases: ['denim'] },
      ],
      grocery: [
        { term: 'Bora',    meaning: 'Large 50kg gunny sack', category: 'unit', aliases: ['bori','sack','bag'] },
        { term: 'Peti',    meaning: 'Crate/carton for fruits or goods', category: 'unit', aliases: ['box','carton'] },
        { term: 'Katta',   meaning: '50kg grain sack', category: 'unit', aliases: ['bag','sack'] },
        { term: 'Quintal', meaning: '100 kilograms', category: 'unit', aliases: ['kwintal'] },
        { term: 'Tray',    meaning: 'Tray of eggs (30 pieces)', category: 'unit', aliases: ['egg tray'] },
      ],
      pharma: [
        { term: 'Strip',   meaning: 'Strip of tablets/capsules (typically 10)', category: 'unit', aliases: ['patti'] },
        { term: 'Vial',    meaning: 'Glass vial for injectable medicines', category: 'product', aliases: ['bottle'] },
        { term: 'Expiry',  meaning: 'Expiry date on medicines', category: 'process', aliases: ['exp','mfg'] },
      ],
    };
    const items = (SEEDS[industry] || []).map(s => ({
      user_id: userId, term: s.term, meaning: s.meaning,
      category: s.category || 'product', aliases: s.aliases || [], created_at: new Date()
    }));
    if (items.length === 0) return res.json({ success: true, seeded: 0 });
    const { error } = await supabase.from('business_vocabulary').insert(items);
    if (error) throw error;
    res.json({ success: true, seeded: items.length, industry });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

// ============================================
// AI INBOUND CALL — Voice Order Extraction
// ============================================

// STEP 1 — Owner sets Twilio webhook URL to:
//   https://vantro-flow-backend-production.up.railway.app/api/voice/inbound?uid=USER_ID
app.post('/api/voice/inbound', async (req, res) => {
  try {
    const voiceSecret = getSecret('VOICE_WEBHOOK_SECRET');
    const provided = req.headers['x-vantro-webhook-secret'] || req.query.secret;
    if (!voiceSecret) return res.sendStatus(403);
    if (voiceSecret && !timingSafeEqualString(provided, voiceSecret)) return res.sendStatus(403);
    const userId = req.query.uid;
    let greeting = 'Vantro Business';
    if (userId) {
      const { data: u } = await supabase.from('users')
        .select('business_name, owner_name').eq('id', userId).single();
      if (u?.business_name) greeting = u.business_name;
    }
    const cbUrl = `${process.env.RAILWAY_PUBLIC_URL || 'https://vantro-flow-backend-production.up.railway.app'}/api/voice/recording?uid=${userId || ''}`;
    res.set('Content-Type', 'text/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Aditi" language="hi-IN">Namaste! ${greeting.replace(/&/g,'and')} mein aapka swagat hai. Beep ke baad apna order boliye — apna naam, kya chahiye, kitna chahiye, aur address batayein.</Say>
  <Record maxLength="180" action="${cbUrl}" transcribe="false" playBeep="true" finishOnKey="*"/>
  <Say voice="Polly.Aditi" language="hi-IN">Dhanyavaad! Aapka order note ho gaya. Hum jald sampark karenge.</Say>
</Response>`);
  } catch (err) {
    res.set('Content-Type', 'text/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>System busy, please try again.</Say></Response>`);
  }
});

// STEP 2 — Twilio POSTs here when recording is ready
app.post('/api/voice/recording', async (req, res) => {
  res.sendStatus(200); // Respond immediately — process async

  const voiceSecret = getSecret('VOICE_WEBHOOK_SECRET');
  const prevVoiceSecret = getPreviousSecret('VOICE_WEBHOOK_SECRET');
  const provided = req.headers['x-vantro-webhook-secret'] || req.query.secret;
  if (!voiceSecret) return;
  
  let isValid = timingSafeEqualString(provided, voiceSecret);
  if (!isValid && prevVoiceSecret) {
    isValid = timingSafeEqualString(provided, prevVoiceSecret);
  }
  
  if (!isValid) return;

  const userId = req.query.uid;
  const { RecordingUrl, RecordingSid, From: callerPhone } = req.body;
  if (!RecordingUrl || !userId) return;

  try {
    // 1. Download MP3 from Twilio — use per-user credentials if env vars not set
    const creds = await getUserTwilioCreds(userId);
    const twilioSid   = creds?.sid   || process.env.TWILIO_ACCOUNT_SID;
    const twilioToken = creds?.token || process.env.TWILIO_AUTH_TOKEN;
    const twilioClient = creds ? getTwilio(creds.sid, creds.token) : getTwilio();
    const auth = Buffer.from(`${twilioSid}:${twilioToken}`).toString('base64');
    const recRes = await fetch(`${RecordingUrl}.mp3`, { headers: { Authorization: `Basic ${auth}` } });
    if (!recRes.ok) throw new Error(`Recording download failed: ${recRes.status}`);
    const audioBuf = Buffer.from(await recRes.arrayBuffer());

    // 2. Transcribe with Groq Whisper (hi = Hindi/Hinglish)
    const fd = new FormData();
    fd.append('file', new Blob([audioBuf], { type: 'audio/mpeg' }), 'order.mp3');
    fd.append('model', 'whisper-large-v3');
    fd.append('language', 'hi');
    fd.append('response_format', 'text');

    const trRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST', headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` }, body: fd,
    });
    const transcript = trRes.ok ? (await trRes.text()).trim() : '';
    if (!transcript || transcript.length < 5) {
      console.log(`⚠️ Empty transcript for ${RecordingSid}`);
      return;
    }
    console.log(`📞 Call transcript received (user ${maskId(userId)}, ${transcript.length} chars)`);

    // 3. Load vocabulary + user profile for context
    const [{ data: vocab }, { data: profile }] = await Promise.all([
      supabase.from('business_vocabulary').select('term,meaning,aliases').eq('user_id', userId),
      supabase.from('users').select('business_name,city,business_type,owner_name,ai_persona').eq('id', userId).single(),
    ]);

    const vocabLines = (vocab || []).map(v =>
      `• ${v.term} = ${v.meaning}${v.aliases?.length ? ` (also called: ${v.aliases.join(', ')})` : ''}`
    ).join('\n');

    // 4. Extract order with Groq LLaMA + vocabulary context
    const systemPrompt = `You are an AI order extraction assistant for an Indian MSME.
Business: ${profile?.business_name || 'Business'}, Location: ${profile?.city || 'India'}
Caller phone: ${callerPhone || 'unknown'}
${vocabLines ? `\nBUSINESS VOCABULARY (map caller's local terms to these):\n${vocabLines}` : ''}
Extract order from Hindi/Hinglish transcript. Return ONLY valid JSON, no commentary.`;

    const userPrompt = `Transcript: "${transcript}"\n\nReturn JSON:\n{"customer_name":null,"customer_phone":null,"delivery_address":null,"items":[{"name":"standard name","local_name":"as said","quantity":1,"unit":"piece"}],"delivery_time":null,"special_instructions":null,"confidence":80,"summary":"one line in Hinglish"}`;

    const aiRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile', temperature: 0.1, max_tokens: 500,
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      }),
    });
    const aiJson = await aiRes.json();
    const raw = aiJson.choices?.[0]?.message?.content || '{}';
    let extracted = {};
    try { const m = raw.match(/\{[\s\S]*\}/); extracted = m ? JSON.parse(m[0]) : {}; } catch (_) {}

    // 5. Save order to DB
    const orderPayload = {
      user_id: userId,
      customer_name: extracted.customer_name || callerPhone || 'Unknown',
      customer_phone: extracted.customer_phone || (callerPhone ? callerPhone.replace('+91', '').replace(/\D/g, '') : null),
      delivery_address: extracted.delivery_address || null,
      items: extracted.items || [],
      delivery_time: extracted.delivery_time || null,
      special_instructions: extracted.special_instructions || null,
      call_recording_url: RecordingUrl,
      call_transcript: transcript,
      source: 'ai_call',
      status: 'new',
      order_date: new Date().toISOString().split('T')[0],
      created_at: new Date(),
    };
    const { data: savedOrder } = await supabase.from('orders').insert([orderPayload]).select().single();

    // 6. Push notification to owner
    if (savedOrder) {
      await sendPushToUser(userId,
        '📞 Naya Order Aaya — Call Se!',
        `${extracted.customer_name || callerPhone}: ${extracted.summary || (extracted.items?.[0] ? `${extracted.items[0].quantity} ${extracted.items[0].unit} ${extracted.items[0].name}` : 'Order received')}`,
        { type: 'new_order', order_id: savedOrder.id }
      );
    }

    // 7. Auto-call first active worker (if Twilio configured + external-send enabled)
    if (twilioClient && savedOrder && !guardExternalSend('voice')) {
      const { data: workers } = await supabase.from('workers')
        .select('name, phone').eq('user_id', userId).eq('is_active', true).limit(1);

      if (workers?.[0]?.phone) {
        const w = workers[0];
        const wPhone = String(w.phone).replace(/\D/g, '');
        const toPhone = wPhone.length === 10 ? `+91${wPhone}` : `+${wPhone}`;
        const itemsDesc = (extracted.items || []).map(i => `${i.quantity} ${i.unit} ${i.local_name || i.name}`).join(', ');
        const script = `${w.name} ji, naya order aaya hai. Customer: ${extracted.customer_name || 'customer'}. Maal: ${itemsDesc || 'details app mein hain'}. Address: ${extracted.delivery_address || 'confirm karo'}. Delivery: ${extracted.delivery_time || 'jaldi se'}. Vantro app check karo.`;
        const safe = script.replace(/&/g,'and').replace(/</g,'').replace(/>/g,'');
        try {
          await twilioClient.calls.create({
            to: toPhone, from: process.env.TWILIO_PHONE_NUMBER,
            twiml: `<Response><Say voice="Polly.Aditi" language="hi-IN">${safe}</Say></Response>`,
            timeout: 20,
          });
        } catch (ce) { console.error('Worker auto-call error:', ce.message); }
      }
    }
    console.log(`✅ Order from call saved — user ${maskId(userId)}`);
  } catch (err) {
    console.error('Recording processing error:', err.message);
  }
});

// Get inbound call webhook URL for this user
app.get('/api/voice/webhook-url', authMiddleware, async (req, res) => {
  try {
    const base = process.env.RAILWAY_PUBLIC_URL || 'https://vantro-flow-backend-production.up.railway.app';
    const url = `${base}/api/voice/inbound?uid=${req.user.userId}`;
    // Check both env vars AND per-user DB credentials
    const envConfigured = !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER);
    let dbSid = null, dbPhone = null;
    if (!envConfigured) {
      const { data } = await supabase.from('users').select('twilio_account_sid, twilio_phone_number').eq('id', req.user.userId).single();
      dbSid   = data?.twilio_account_sid;
      dbPhone = data?.twilio_phone_number;
    }
    const twilioConfigured = envConfigured || !!(dbSid);
    res.json({ success: true, webhook_url: url, twilio_configured: twilioConfigured, twilio_account_sid: dbSid, twilio_phone_number: dbPhone });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// EXPENSES — daily tracking
// ============================================

const EXPENSE_CATEGORIES = ['transport','fuel','salary','material','rent','electricity','maintenance','marketing','misc'];

app.get('/api/expenses', authMiddleware, async (req, res) => {
  try {
    const { date, from, to } = req.query;
    let q = supabase.from('expenses').select('*').eq('user_id', req.user.userId).order('created_at', { ascending: false });
    if (from && to) q = q.gte('expense_date', from).lte('expense_date', to);
    else q = q.eq('expense_date', date || new Date().toISOString().split('T')[0]);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ success: true, expenses: data || [] });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/expenses', authMiddleware, async (req, res) => {
  try {
    const { description, amount, category, notes } = req.body;
    if (!description || !amount) return res.status(400).json({ error: 'description and amount required' });
    const { data, error } = await supabase.from('expenses').insert([{
      user_id: req.user.userId, description, amount: parseFloat(amount),
      category: category || 'misc', notes: notes || null,
      expense_date: new Date().toISOString().split('T')[0], created_at: new Date(),
    }]).select().single();
    if (error) throw error;
    res.json({ success: true, expense: data });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

app.patch('/api/expenses/:id', authMiddleware, async (req, res) => {
  try {
    const updates = pickAllowed(req.body, ['description', 'amount', 'category', 'notes', 'expense_date']);
    if (updates.amount !== undefined) updates.amount = parseFloat(updates.amount);
    const { data, error } = await supabase.from('expenses')
      .update(updates).eq('id', req.params.id).eq('user_id', req.user.userId).select().single();
    if (error) throw error;
    res.json({ success: true, expense: data });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

app.delete('/api/expenses/:id', authMiddleware, async (req, res) => {
  try {
    await supabase.from('expenses').delete().eq('id', req.params.id).eq('user_id', req.user.userId);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

// ============================================
// TODAY SUMMARY — P&L aggregator
// ============================================

app.get('/api/today/summary', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const date = req.query.date || new Date().toISOString().split('T')[0];

    const [
      { data: orders },
      { data: expenses },
      { data: sales },
      { data: purchases },
      { data: paidInvoices },
      { data: callLogs },
    ] = await Promise.all([
      supabase.from('orders').select('*').eq('user_id', userId).eq('order_date', date),
      supabase.from('expenses').select('*').eq('user_id', userId).eq('expense_date', date),
      supabase.from('sales').select('*').eq('user_id', userId).eq('sale_date', date),
      supabase.from('purchases').select('*').eq('user_id', userId).eq('purchase_date', date),
      supabase.from('invoices').select('*').eq('user_id', userId).eq('payment_status', 'Paid').eq('payment_date', date),
      supabase.from('call_logs').select('*').eq('user_id', userId).gte('created_at', date + 'T00:00:00').lte('created_at', date + 'T23:59:59'),
    ]);

    const orderIncome = (orders || [])
      .filter(o => !['cancelled'].includes(o.status))
      .reduce((s, o) => s + (Number(o.total_amount) || 0), 0);

    const invoiceIncome = (paidInvoices || [])
      .reduce((s, i) => s + Number(i.payment_amount || i.invoice_amount || 0), 0);

    const salesIncome = (sales || [])
      .filter(sale => sale.status !== 'cancelled')
      .reduce((s, sale) => s + Number(sale.amount || 0), 0);

    const purchaseExpense = (purchases || [])
      .reduce((s, purchase) => s + Number(purchase.amount || 0), 0);

    const totalIncome = orderIncome + salesIncome + invoiceIncome;
    const totalExpenses = (expenses || []).reduce((s, e) => s + Number(e.amount || 0), 0) + purchaseExpense;
    const netProfit = totalIncome - totalExpenses;

    // Top selling items from orders
    const itemMap = {};
    (orders || []).forEach(o => {
      (o.items || []).forEach((item) => {
        const key = item.name || item.local_name || 'Unknown';
        itemMap[key] = (itemMap[key] || 0) + (item.quantity || 0);
      });
    });
    (sales || []).forEach(sale => {
      const items = parseJsonArray(sale.items);
      items.forEach((item) => {
        const key = item.description || item.name || 'Sale';
        itemMap[key] = (itemMap[key] || 0) + Number(item.qty || item.quantity || 1);
      });
    });
    const topItems = Object.entries(itemMap)
      .sort(([,a],[,b]) => b - a).slice(0, 5)
      .map(([name, qty]) => ({ name, qty }));

    // Expense breakdown by category
    const expenseByCategory = {};
    (expenses || []).forEach(e => {
      expenseByCategory[e.category] = (expenseByCategory[e.category] || 0) + Number(e.amount || 0);
    });

    res.json({
      success: true,
      date,
      summary: {
        income: { orders: orderIncome, invoices: invoiceIncome, total: totalIncome },
        expenses: { total: totalExpenses, purchases: purchaseExpense, by_category: expenseByCategory },
        sales_total: salesIncome,
        purchases_total: purchaseExpense,
        net_profit: netProfit,
        order_count: (orders || []).length,
        sales_count: (sales || []).length,
        purchase_count: (purchases || []).length,
        orders_by_status: {
          new: (orders || []).filter(o => o.status === 'new').length,
          confirmed: (orders || []).filter(o => o.status === 'confirmed').length,
          dispatched: (orders || []).filter(o => o.status === 'dispatched').length,
          delivered: (orders || []).filter(o => o.status === 'delivered').length,
          cancelled: (orders || []).filter(o => o.status === 'cancelled').length,
        },
        invoices_collected: (paidInvoices || []).length,
        calls_made: (callLogs || []).length,
        top_items: topItems,
      },
      orders: orders || [],
      expenses: expenses || [],
      sales: sales || [],
      purchases: purchases || [],
      paid_invoices: paidInvoices || [],
    });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

// ============================================
// VANTRO BRAIN — Specialized Business AI
// ============================================

// Brain rules — business-specific knowledge owner teaches AI
app.get('/api/ai/brain/rules', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase.from('brain_rules').select('*').eq('user_id', req.user.userId).order('created_at');
    if (error) throw error;
    res.json({ success: true, rules: data || [] });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/ai/brain/rules', authMiddleware, async (req, res) => {
  try {
    const { rule, category } = req.body;
    if (!rule) return res.status(400).json({ error: 'rule required' });
    const { data, error } = await supabase.from('brain_rules').insert([{
      user_id: req.user.userId, rule, category: category || 'general', created_at: new Date()
    }]).select().single();
    if (error) throw error;
    res.json({ success: true, rule: data });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

app.delete('/api/ai/brain/rules/:id', authMiddleware, async (req, res) => {
  try {
    await supabase.from('brain_rules').delete().eq('id', req.params.id).eq('user_id', req.user.userId);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

// Main Vantro Brain endpoint — full context AI with live tool use
app.post('/api/ai/brain', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { message, history = [] } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });

    // Load all business context in parallel
    const today = new Date().toISOString().split('T')[0];
    const [
      { data: profile },
      { data: vocab },
      { data: rules },
      { data: workers },
      { data: topInvoices },
      { data: todayOrders },
      { data: todayExpenses },
    ] = await Promise.all([
      supabase.from('users').select('business_name,city,business_type,owner_name,voice_style,ai_persona').eq('id', userId).single(),
      supabase.from('business_vocabulary').select('term,meaning,aliases').eq('user_id', userId).limit(50),
      supabase.from('brain_rules').select('rule,category').eq('user_id', userId).limit(30),
      supabase.from('workers').select('name,role,is_active').eq('user_id', userId),
      supabase.from('invoices').select('customer_name,invoice_amount,due_date,payment_status').eq('user_id', userId).eq('payment_status','Pending').order('invoice_amount', { ascending: false }).limit(10),
      supabase.from('orders').select('customer_name,items,status,total_amount,delivery_time').eq('user_id', userId).eq('order_date', today),
      supabase.from('expenses').select('description,amount,category').eq('user_id', userId).eq('expense_date', today),
    ]);

    // Build today's numbers for context
    const todayIncome = (todayOrders || []).filter(o => o.status !== 'cancelled').reduce((s, o) => s + Number(o.total_amount || 0), 0);
    const todaySpend = (todayExpenses || []).reduce((s, e) => s + Number(e.amount || 0), 0);
    const pendingAmount = (topInvoices || []).reduce((s, i) => s + Number(i.invoice_amount || 0), 0);

    // Vocabulary context
    const vocabText = (vocab || []).length > 0
      ? '\n\nBUSINESS VOCABULARY:\n' + (vocab || []).map(v => `• ${v.term} = ${v.meaning}${v.aliases?.length ? ` (also: ${v.aliases.join(', ')})` : ''}`).join('\n')
      : '';

    // Owner-taught business rules
    const rulesText = (rules || []).length > 0
      ? '\n\nOWNER\'S BUSINESS RULES (always follow these):\n' + (rules || []).map(r => `• [${r.category}] ${r.rule}`).join('\n')
      : '';

    // Live business snapshot
    const snapshot = `
LIVE BUSINESS SNAPSHOT (right now):
• Business: ${profile?.business_name || 'Business'}, ${profile?.city || 'India'}
• Today ${today}:
  - Orders today: ${(todayOrders || []).length} (income: ₹${todayIncome.toLocaleString('en-IN')})
  - Expenses today: ₹${todaySpend.toLocaleString('en-IN')}
  - Net today: ₹${(todayIncome - todaySpend).toLocaleString('en-IN')}
• Outstanding receivables: ₹${pendingAmount.toLocaleString('en-IN')} from ${(topInvoices || []).length} parties
• Top pending: ${(topInvoices || []).slice(0, 3).map(i => `${i.customer_name} ₹${Number(i.invoice_amount).toLocaleString('en-IN')}`).join(', ') || 'none'}
• Today's orders: ${(todayOrders || []).map(o => `${o.customer_name}(${o.status})`).join(', ') || 'none'}
• Team: ${(workers || []).filter(w => w.is_active).map(w => w.name).join(', ') || 'no workers yet'}`;

    // Voice/persona context
    const styleDesc = { casual_hinglish:'Mix of Hindi + English (Hinglish)', formal_hindi:'Formal Hindi', direct_english:'Direct English', friendly_urdu:'Friendly Urdu-influenced', regional_hindi:'Regional Hindi dialect' }[profile?.voice_style || ''] || 'Hinglish';
    const voiceCtx = profile?.owner_name ? `\nSPEAK TO OWNER AS: ${profile.owner_name} ji. Style: ${styleDesc}. ${profile?.ai_persona ? 'Their style: ' + profile.ai_persona : ''}` : '';

    const systemPrompt = `You are Vantro Brain — a specialized AI built exclusively for this Indian MSME business.
You are NOT a generic AI. You know this business inside-out: every customer, every product, every rule.
You speak in Hinglish (mix of Hindi + English) naturally, like a knowledgeable business partner.
${voiceCtx}
${snapshot}
${vocabText}
${rulesText}

WHAT YOU CAN DO:
- Answer any business question using the live data above
- Calculate P&L, outstanding, recovery rates on the fly
- Suggest which customer to call first, what to do next
- Track and reason about orders, expenses, invoices
- Give brutally honest business advice

RULES:
- Always use ₹ for amounts, Indian number format (lakhs/crores)
- Be direct and action-oriented — no fluff
- If you don't know something specific, say so and suggest how to find it
- Keep answers concise unless asked for detail
- End responses with a clear next action when relevant`;

    // Tool definitions for live DB queries
    const tools = [
      {
        type: 'function',
        function: {
          name: 'get_invoices',
          description: 'Fetch unpaid invoices with filtering',
          parameters: {
            type: 'object',
            properties: {
              sort_by: { type: 'string', enum: ['amount', 'days_overdue'], default: 'amount' },
              limit: { type: 'integer', default: 10 },
              min_amount: { type: 'number', description: 'Minimum invoice amount filter' },
            }
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_orders_by_date',
          description: 'Get orders for a specific date',
          parameters: {
            type: 'object',
            properties: {
              date: { type: 'string', description: 'YYYY-MM-DD, default today' },
              status: { type: 'string', enum: ['new','confirmed','dispatched','delivered','cancelled'] },
            }
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_expenses_summary',
          description: 'Get expense breakdown for a date range',
          parameters: {
            type: 'object',
            properties: {
              from_date: { type: 'string', description: 'YYYY-MM-DD start' },
              to_date: { type: 'string', description: 'YYYY-MM-DD end' },
            }
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'search_customer',
          description: 'Search for a specific customer across invoices and orders',
          parameters: {
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'add_expense',
          description: 'Add a new expense entry for today',
          parameters: {
            type: 'object',
            properties: {
              description: { type: 'string' },
              amount: { type: 'number' },
              category: { type: 'string', enum: EXPENSE_CATEGORIES },
            },
            required: ['description', 'amount']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_top_customers',
          description: 'Get customers ranked by outstanding amount or order history',
          parameters: {
            type: 'object',
            properties: {
              ranked_by: { type: 'string', enum: ['outstanding', 'orders'], default: 'outstanding' },
              limit: { type: 'integer', default: 5 }
            }
          }
        }
      }
    ];

    // Tool execution handlers
    const execTool = async (name, args) => {
      switch (name) {
        case 'get_invoices': {
          const order = args.sort_by === 'days_overdue' ? 'due_date' : 'invoice_amount';
          let q = supabase.from('invoices').select('customer_name,invoice_amount,due_date,payment_status')
            .eq('user_id', userId).eq('payment_status', 'Pending').order(order, { ascending: false }).limit(args.limit || 10);
          if (args.min_amount) q = q.gte('invoice_amount', args.min_amount);
          const { data } = await q;
          return (data || []).map(i => ({
            customer: i.customer_name,
            amount: `₹${Number(i.invoice_amount).toLocaleString('en-IN')}`,
            due: i.due_date,
            overdue_days: i.due_date ? Math.max(0, Math.floor((Date.now() - new Date(i.due_date).getTime()) / 86400000)) : null
          }));
        }
        case 'get_orders_by_date': {
          const d = args.date || today;
          let q = supabase.from('orders').select('customer_name,items,status,total_amount,delivery_time,created_at')
            .eq('user_id', userId).eq('order_date', d);
          if (args.status) q = q.eq('status', args.status);
          const { data } = await q.order('created_at', { ascending: false });
          return data || [];
        }
        case 'get_expenses_summary': {
          const from = args.from_date || today;
          const to = args.to_date || today;
          const { data } = await supabase.from('expenses').select('description,amount,category,expense_date')
            .eq('user_id', userId).gte('expense_date', from).lte('expense_date', to);
          const total = (data || []).reduce((s, e) => s + Number(e.amount || 0), 0);
          const byCategory = {};
          (data || []).forEach(e => { byCategory[e.category] = (byCategory[e.category] || 0) + Number(e.amount); });
          return { total: `₹${total.toLocaleString('en-IN')}`, by_category: byCategory, items: data || [] };
        }
        case 'search_customer': {
          const term = `%${args.name}%`;
          const [invRes, ordRes] = await Promise.all([
            supabase.from('invoices').select('customer_name,invoice_amount,status,due_date').eq('user_id', userId).ilike('customer_name', term).limit(5),
            supabase.from('orders').select('customer_name,items,status,total_amount,order_date').eq('user_id', userId).ilike('customer_name', term).limit(5),
          ]);
          return { invoices: invRes.data || [], orders: ordRes.data || [] };
        }
        case 'add_expense': {
          const { data } = await supabase.from('expenses').insert([{
            user_id: userId, description: args.description, amount: args.amount,
            category: args.category || 'misc', expense_date: today, created_at: new Date()
          }]).select().single();
          return { added: true, expense: data };
        }
        case 'get_top_customers': {
          if (args.ranked_by === 'orders') {
            const { data } = await supabase.from('orders').select('customer_name,total_amount').eq('user_id', userId).not('status', 'eq', 'cancelled');
            const map = {};
            (data || []).forEach(o => { map[o.customer_name] = (map[o.customer_name] || 0) + Number(o.total_amount || 0); });
            return Object.entries(map).sort(([,a],[,b]) => b-a).slice(0, args.limit || 5).map(([name, total]) => ({ name, total: `₹${total.toLocaleString('en-IN')}` }));
          } else {
            const { data } = await supabase.from('invoices').select('customer_name,invoice_amount').eq('user_id', userId).eq('payment_status','Pending').order('invoice_amount', { ascending: false }).limit(args.limit || 5);
            return data || [];
          }
        }
        default: return { error: 'Unknown tool' };
      }
    };

    // Agentic loop — up to 4 tool call rounds
    const messages = [
      { role: 'system', content: systemPrompt },
      ...(history || []).slice(-20),
      { role: 'user', content: message },
    ];

    let finalResponse = '';
    const toolsUsed = [];

    for (let round = 0; round < 4; round++) {
      const aiRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages,
          tools,
          tool_choice: 'auto',
          temperature: 0.3,
          max_tokens: 1000,
        }),
      });
      const aiData = await aiRes.json();
      const choice = aiData.choices?.[0];
      if (!choice) break;

      if (choice.finish_reason === 'tool_calls' && choice.message?.tool_calls) {
        messages.push(choice.message);
        for (const tc of choice.message.tool_calls) {
          let args = {};
          try { args = JSON.parse(tc.function.arguments); } catch (_) {}
          const result = await execTool(tc.function.name, args);
          toolsUsed.push(tc.function.name);
          messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
        }
      } else {
        finalResponse = choice.message?.content || '';
        break;
      }
    }

    if (!finalResponse) finalResponse = 'Kuch technical issue aa gaya, please dobara try karo.';

    // Return new history (user+assistant pair only, no system/tools)
    const newHistory = [
      ...(history || []).slice(-18),
      { role: 'user', content: message },
      { role: 'assistant', content: finalResponse },
    ];

    res.json({ success: true, response: finalResponse, history: newHistory, tools_used: toolsUsed });
  } catch (err) {
    console.error('Brain error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// FEATURE FLAGS — industry-based smart setup
// ============================================

function buildFeatureFlags({ industry, business_size, gst_registered, sells_on_credit, has_workers, primary_pain }) {
  const isProduct = ['construction','textile','grocery','pharma','electronics','manufacturing','trading','hardware','auto_parts','furniture'].includes(industry);
  const isService = ['services','consulting','salon','clinic','coaching','agency'].includes(industry);
  return {
    dashboard: true, collections: true, whatsapp: true, ai_chat: true,
    today_pl: true, brain: true, analytics: true, forecast: true,
    reports: true, network: true, crm: true, ledger: true,
    gst_invoices: gst_registered || true,           // most MSMEs need bills
    khata: sells_on_credit || true,                 // credit is universal
    purchases: isProduct,                           // buying stock
    attendance: has_workers,                        // only if they have staff
    orders: isProduct,                              // order management
    ai_calling: isProduct,                          // voice orders
    inventory: isProduct,                           // stock tracking
    scanner: gst_registered,                        // invoice scanner
    dunning: sells_on_credit,                       // auto follow-up
    gstr_export: gst_registered,                    // GSTR-1 export
    neural_engine: sells_on_credit,                 // ML prioritization
    billing_feature: true,
  };
}

app.post('/api/onboarding/setup', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { industry, business_size, gst_registered, sells_on_credit, has_workers, primary_pain, gstin, business_address, owner_name, city } = req.body;
    const feature_flags = buildFeatureFlags({ industry, business_size, gst_registered, sells_on_credit, has_workers, primary_pain });
    await supabase.from('users').update({
      industry, business_size, gst_registered, gstin: gstin || null,
      business_address: business_address || null, feature_flags,
      owner_name: owner_name || null, city: city || null,
      has_workers: has_workers ?? null,
      onboarding_done: true,
    }).eq('id', userId);
    await supabase.from('business_vocabulary').upsert(
      [{user_id: userId, term: 'Industry', meaning: industry, category: 'process', aliases: [], created_at: new Date()}],
      { onConflict: 'user_id,term' }
    );
    res.json({ success: true, feature_flags });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

app.get('/api/user/features', authMiddleware, async (req, res) => {
  try {
    const { data } = await supabase.from('users').select('feature_flags, industry, business_size, gst_registered, owner_name, city, gstin, business_name, business_address').eq('id', req.user.userId).single();
    res.json({ success: true, ...(data || {}), feature_flags: data?.feature_flags || {} });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

// ============================================
// GST BILLS / INVOICES
// ============================================

// Public endpoint for invoice sharing. Signed links are supported with ?token=...
// Legacy unsigned links remain allowed unless REQUIRE_SIGNED_PUBLIC_BILLS=true.
app.get('/api/bills/public/:id', async (req, res) => {
  try {
    const token = req.query.token;
    // Phase 2C.35-P1: fail-closed by default — a valid signed token bound to this
    // bill id is REQUIRED unless REQUIRE_SIGNED_PUBLIC_BILLS is explicitly 'false'.
    // This blocks UUID-enumeration cross-tenant PII disclosure (was default-open).
    const requireSigned = process.env.REQUIRE_SIGNED_PUBLIC_BILLS !== 'false';
    if (requireSigned) {
      if (!token) return res.status(403).json({ error: 'Signed link required' });
      if (!verifyPublicBillToken(token, req.params.id)) return res.status(403).json({ error: 'Invalid or expired link' });
    } else if (token && !verifyPublicBillToken(token, req.params.id)) {
      return res.status(403).json({ error: 'Invalid or expired link' });
    }

    // Phase 2C.35-P1: minimise PII on the public payload — do NOT expose customer
    // phone/email/GSTIN or the owner's personal name. Bill content + seller
    // business header (needed for a valid GST invoice) only.
    // Phase 2C.35-P2: minimal external-safe payload. Seller tax-id and full
    // address fields are removed by default (re-add only behind an explicit,
    // documented full-invoice path). No customer contact PII, no owner name, no raw tenant IDs.
    const { data, error } = await supabase
      .from('bills')
      .select('id, user_id, bill_number, customer_name, invoice_date, due_date, items, subtotal, tax_amount, total_amount, status, notes, paid_at, created_at, users(business_name, city)')
      .eq('id', req.params.id)
      .single();
    if (error || !data) return res.status(404).json({ error: 'Invoice not found' });
    const { user_id, ...publicBill } = data;
    await createActivityLog(user_id, 'public_bill_accessed', {
      entityType: 'bill',
      entityId: req.params.id,
      source: token ? 'signed_public_link' : 'legacy_public_link',
    });
    res.json({ success: true, bill: publicBill });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

app.get('/api/bills', authMiddleware, async (req, res) => {
  try {
    const { status, from, to, limit = 50 } = req.query;
    let q = supabase.from('bills').select('*').eq('user_id', req.user.userId).order('created_at', { ascending: false }).limit(Number(limit));
    if (status) q = q.eq('status', status);
    if (from) q = q.gte('bill_date', from);
    if (to) q = q.lte('bill_date', to);
    const { data, error } = await q;
    if (error) {
      if (isMissingSchemaError(error)) {
        console.warn('[bills list] table/columns unavailable, returning empty list:', error.message);
        return res.json({ success: true, bills: [] });
      }
      throw error;
    }
    res.json({ success: true, bills: data || [] });
  } catch (err) {
    console.error('[bills list]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/bills', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { customer_name, customer_gstin, customer_address, customer_phone, items, is_interstate, due_date, notes } = req.body;
    if (!customer_name || !items?.length) return res.status(400).json({ error: 'customer_name and items required' });

    // Auto-generate bill number
    const { data: lastBill } = await supabase.from('bills').select('bill_number').eq('user_id', userId).order('created_at', { ascending: false }).limit(1).single();
    let nextNum = 1;
    if (lastBill?.bill_number) { const m = lastBill.bill_number.match(/(\d+)$/); if (m) nextNum = parseInt(m[1]) + 1; }
    const y = new Date().getFullYear();
    const bill_number = `INV-${y}-${String(nextNum).padStart(4, '0')}`;

    // Calculate totals
    let subtotal = 0;
    const enrichedItems = items.map(item => {
      const amount = parseFloat(item.quantity || 1) * parseFloat(item.rate || 0);
      subtotal += amount;
      return { ...item, amount: Math.round(amount * 100) / 100 };
    });

    const gstRate = parseFloat(req.body.gst_rate || 18);
    const gstAmt = (subtotal * gstRate) / 100;
    const cgst = is_interstate ? 0 : gstAmt / 2;
    const sgst = is_interstate ? 0 : gstAmt / 2;
    const igst = is_interstate ? gstAmt : 0;
    const total = subtotal + gstAmt;

    const { data, error } = await supabase.from('bills').insert([{
      user_id: userId, bill_number, customer_name, customer_gstin: customer_gstin || null,
      customer_address: customer_address || null, customer_phone: customer_phone || null,
      items: enrichedItems, gst_rate: gstRate, subtotal: Math.round(subtotal * 100) / 100,
      cgst: Math.round(cgst * 100) / 100, sgst: Math.round(sgst * 100) / 100,
      igst: Math.round(igst * 100) / 100, total: Math.round(total * 100) / 100,
      is_interstate: !!is_interstate, due_date: due_date || null,
      notes: notes || null, status: 'unpaid', bill_date: new Date().toISOString().split('T')[0],
      created_at: new Date(),
    }]).select().single();
    if (error) throw error;

    // Also create a receivable invoice for collections tracking.
    await safeInvoiceInsert({
      user_id: userId,
      customer_name,
      customer_phone: customer_phone || null,
      customer_gstin: customer_gstin || null,
      invoice_amount: Math.round(total * 100) / 100,
      invoice_number: bill_number,
      invoice_date: new Date().toISOString().split('T')[0],
      due_date: due_date || null,
      items: enrichedItems,
      notes: `Bill ${bill_number}`,
      payment_status: 'Pending',
      days_overdue: calculateDaysOverdue(due_date || new Date().toISOString().split('T')[0]),
      source_type: 'bills',
      source_id: String(data.id),
      created_at: new Date(),
    });

    res.json({ success: true, bill: data });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

app.patch('/api/bills/:id', authMiddleware, async (req, res) => {
  try {
    const updates = pickAllowed(req.body, [
      'customer_name', 'customer_phone', 'customer_email', 'customer_gstin',
      'invoice_date', 'due_date', 'items', 'subtotal', 'tax_amount',
      'total_amount', 'status', 'notes', 'paid_at'
    ]);
    const { data, error } = await supabase.from('bills').update(updates).eq('id', req.params.id).eq('user_id', req.user.userId).select().single();
    if (error) throw error;
    res.json({ success: true, bill: data });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

app.delete('/api/bills/:id', authMiddleware, async (req, res) => {
  try {
    const { data: bill } = await supabase
      .from('bills')
      .select('id, bill_number')
      .eq('id', req.params.id)
      .eq('user_id', req.user.userId)
      .single();
    await supabase.from('bills').delete().eq('id', req.params.id).eq('user_id', req.user.userId);
    let invoiceDelete = await supabase
      .from('invoices')
      .delete()
      .eq('user_id', req.user.userId)
      .eq('source_type', 'bills')
      .eq('source_id', String(req.params.id));
    if (invoiceDelete.error && bill?.bill_number) {
      invoiceDelete = await supabase
        .from('invoices')
        .delete()
        .eq('user_id', req.user.userId)
        .eq('invoice_number', bill.bill_number);
    }
    if (invoiceDelete.error) console.warn('Bill receivable delete sync failed:', invoiceDelete.error.message);
    await createActivityLog(req.user.userId, 'bill_deleted', {
      entityType: 'bill',
      entityId: req.params.id,
      source: 'api',
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GSTR-1 export data
app.get('/api/bills/gstr1', authMiddleware, async (req, res) => {
  try {
    const { month, year } = req.query;
    const m = String(month || new Date().getMonth() + 1).padStart(2, '0');
    const y = year || new Date().getFullYear();
    const from = `${y}-${m}-01`;
    const to = `${y}-${m}-31`;
    const { data: bills } = await supabase.from('bills').select('*').eq('user_id', req.user.userId).gte('bill_date', from).lte('bill_date', to).eq('status', 'unpaid').neq('status', 'cancelled');
    const b2b = (bills || []).filter(b => b.customer_gstin).map(b => ({
      'GSTIN of Recipient': b.customer_gstin, 'Receiver Name': b.customer_name,
      'Invoice Number': b.bill_number, 'Invoice Date': b.bill_date,
      'Invoice Value': b.total, 'Taxable Value': b.subtotal,
      'CGST': b.cgst, 'SGST': b.sgst, 'IGST': b.igst, 'GST Rate': b.gst_rate + '%',
    }));
    const b2c = (bills || []).filter(b => !b.customer_gstin).map(b => ({
      'Customer Name': b.customer_name, 'Invoice Number': b.bill_number,
      'Invoice Date': b.bill_date, 'Invoice Value': b.total,
      'Taxable Value': b.subtotal, 'CGST': b.cgst, 'SGST': b.sgst, 'IGST': b.igst,
    }));
    const totalTax = (bills || []).reduce((s, b) => s + Number(b.cgst || 0) + Number(b.sgst || 0) + Number(b.igst || 0), 0);
    const totalSales = (bills || []).reduce((s, b) => s + Number(b.total || 0), 0);
    res.json({ success: true, month: `${m}/${y}`, b2b, b2c, summary: { total_invoices: (bills||[]).length, total_sales: totalSales, total_tax: totalTax } });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

// ============================================
// KHATA — Customer Udhaar / Credit Ledger
// ============================================

app.get('/api/khata', authMiddleware, async (req, res) => {
  try {
    const entries = await buildKhataEntries(req.user.userId);
    res.json({ success: true, customers: summarizeKhataEntries(entries) });
  } catch (err) {
    console.error('[khata list]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/khata/:customer', authMiddleware, async (req, res) => {
  try {
    const data = await buildKhataEntries(req.user.userId, decodeURIComponent(req.params.customer));
    let balance = 0;
    const entries = (data || []).map(e => {
      balance += e.type === 'debit' ? Number(e.amount) : -Number(e.amount);
      return { ...e, running_balance: balance };
    });
    res.json({ success: true, entries, balance });
  } catch (err) {
    console.error('[khata detail]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/khata/entry', authMiddleware, async (req, res) => {
  try {
    const { customer_name, customer_phone, type, amount, payment_mode, note, notes, entry_date } = req.body;
    if (!customer_name || !type || !amount) return res.status(400).json({ error: 'customer_name, type, amount required' });
    const { data, error } = await supabase.from('khata_entries').insert([{
      user_id: req.user.userId, customer_name, type, amount: parseFloat(amount),
      customer_phone: customer_phone || null,
      payment_mode: payment_mode || 'cash', notes: notes || note || null,
      entry_date: entry_date || new Date().toISOString().split('T')[0], created_at: new Date(),
    }]).select().single();
    if (error) throw error;
    res.json({ success: true, entry: data });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

app.delete('/api/khata/entry/:id', authMiddleware, async (req, res) => {
  try {
    await supabase.from('khata_entries').delete().eq('id', req.params.id).eq('user_id', req.user.userId);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

// ============================================
// PURCHASES — Payables / Supplier dues
// ============================================

app.get('/api/purchases', authMiddleware, async (req, res) => {
  try {
    const { userId, businessId } = getBusinessContext(req);
    await ensureConnectedBusinessData(userId);
    const { status } = req.query;
    
    const purchases = await purchaseService.getPurchases(userId, businessId, { status });
    res.json({ success: true, purchases });
  } catch (err) {
    console.error('GET purchases error:', err.message);
    res.status(500).json({ error: 'Internal server error', detail: err.message });
  }
});

app.post('/api/purchases', authMiddleware, async (req, res) => {
  try {
    const {
      supplier_name, total_amount, amount,
      supplier_phone, bill_number, supplier_gstin,
      purchase_date, due_date, paid_amount, notes,
      items, gst_type, gst_rate, gst_amount,
      cgst_amount, sgst_amount, igst_amount, subtotal,
    } = req.body;

    const finalAmount = parseFloat(total_amount || amount || 0);
    if (!supplier_name || !finalAmount) {
      return res.status(400).json({ error: 'supplier_name and total_amount are required' });
    }
    // ── Cortex: Idempotency check ─────────────────────────────────────────────
    if (isFeatureEnabled('cortex_enabled')) {
      const _idemKey = req.headers['idempotency-key'];
      if (_idemKey) {
        const _cached = await require('./lib/services/orchestrator/idempotency.service').check(req.user.userId, _idemKey);
        if (_cached) return res.json(_cached);
      }
    }
    // ─────────────────────────────────────────────────────────────────────────
    const finalPaid  = parseFloat(paid_amount || 0);
    const autoStatus = finalPaid >= finalAmount ? 'paid' : finalPaid > 0 ? 'partial' : 'unpaid';

    const { data, error } = await supabase.from('purchases').insert([{
      user_id:        req.user.userId,
      supplier_name,
      amount:         finalAmount,
      paid_amount:    finalPaid,
      status:         autoStatus,
      purchase_date:  purchase_date  || new Date().toISOString().split('T')[0],
      due_date:       due_date       || null,
      bill_number:    bill_number    || null,
      supplier_phone: supplier_phone || null,
      supplier_gstin: supplier_gstin || null,
      notes:          notes          || null,
      category:       'material',
      items:          items ? JSON.stringify(items) : null,
      gst_type:       gst_type || null,
      gst_rate:       gst_rate || null,
      gst_amount:     gst_amount || null,
      cgst_amount:    cgst_amount || null,
      sgst_amount:    sgst_amount || null,
      igst_amount:    igst_amount || null,
      subtotal:       subtotal || null,
    }]).select().single();

    if (error) throw error;
    const [supplier, inventory] = await Promise.all([
      ensureSupplierFromPurchase(req.user.userId, data),
      items !== undefined ? syncInventoryFromPurchase(req.user.userId, data) : Promise.resolve([]),
    ]);
    await emitBusinessEvent(req.user.userId, 'purchase.created', {
      purchase: data,
      amount: finalAmount,
      supplier_name,
    });
    // ── Cortex: Cashflow event + idempotency store ────────────────────────────
    if (isFeatureEnabled('cortex_enabled')) {
      require('./lib/services/orchestrator/cashflow.service')
        .createFromPurchase(req.user.userId, data, finalAmount, finalPaid)
        .catch(err => console.warn('[Cortex] purchase cashflow failed:', err.message));
      const _idemKey = req.headers['idempotency-key'];
      if (_idemKey) {
        const _resp = { success: true, purchase: { ...data, total_amount: parseFloat(data.amount) }, supplier, inventory };
        require('./lib/services/orchestrator/idempotency.service')
          .set(req.user.userId, _idemKey, _resp)
          .catch(() => {});
      }
    }
    // ─────────────────────────────────────────────────────────────────────────
    res.json({ success: true, purchase: { ...data, total_amount: parseFloat(data.amount) }, supplier, inventory });
  } catch (err) {
    console.error('Purchase create error:', err.message);
    res.status(500).json({ error: 'Internal server error', detail: err.message });
  }
});

app.patch('/api/purchases/:id', authMiddleware, async (req, res) => {
  try {
    const { total_amount, amount, paid_amount, supplier_name, purchase_date, due_date, notes, bill_number, supplier_phone, supplier_gstin,
            items, gst_type, gst_rate, gst_amount, cgst_amount, sgst_amount, igst_amount, subtotal } = req.body;

    const finalAmount = total_amount !== undefined ? parseFloat(total_amount) : amount !== undefined ? parseFloat(amount) : null;
    const finalPaid   = paid_amount  !== undefined ? parseFloat(paid_amount)  : null;

    // Get current record to compute status
    const { data: current } = await supabase.from('purchases').select('amount, paid_amount').eq('id', req.params.id).eq('user_id', req.user.userId).single();
    if (!current) return res.status(404).json({ error: 'Purchase not found' });

    const newAmount = finalAmount ?? parseFloat(current.amount);
    const newPaid   = finalPaid   ?? parseFloat(current.paid_amount);
    const newStatus = newPaid >= newAmount ? 'paid' : newPaid > 0 ? 'partial' : 'unpaid';

    const updates = { amount: newAmount, paid_amount: newPaid, status: newStatus };
    if (supplier_name  !== undefined) updates.supplier_name  = supplier_name;
    if (purchase_date  !== undefined) updates.purchase_date  = purchase_date  || null;
    if (due_date       !== undefined) updates.due_date       = due_date       || null;
    if (notes          !== undefined) updates.notes          = notes          || null;
    if (bill_number    !== undefined) updates.bill_number    = bill_number    || null;
    if (supplier_phone !== undefined) updates.supplier_phone = supplier_phone || null;
    if (supplier_gstin !== undefined) updates.supplier_gstin = supplier_gstin || null;
    if (items          !== undefined) updates.items          = items ? JSON.stringify(items) : null;
    if (gst_type       !== undefined) updates.gst_type       = gst_type || null;
    if (gst_rate       !== undefined) updates.gst_rate       = gst_rate || null;
    if (gst_amount     !== undefined) updates.gst_amount     = gst_amount || null;
    if (cgst_amount    !== undefined) updates.cgst_amount    = cgst_amount || null;
    if (sgst_amount    !== undefined) updates.sgst_amount    = sgst_amount || null;
    if (igst_amount    !== undefined) updates.igst_amount    = igst_amount || null;
    if (subtotal       !== undefined) updates.subtotal       = subtotal || null;

    const { data, error } = await supabase.from('purchases').update(updates).eq('id', req.params.id).eq('user_id', req.user.userId).select().single();
    if (error) throw error;
    const [supplier, inventory] = await Promise.all([
      ensureSupplierFromPurchase(req.user.userId, data),
      items !== undefined ? syncInventoryFromPurchase(req.user.userId, data) : Promise.resolve([]),
    ]);
    await emitBusinessEvent(req.user.userId, 'purchase.updated', {
      purchase: data,
      amount: newAmount,
    });
    res.json({ success: true, purchase: { ...data, total_amount: parseFloat(data.amount) }, supplier, inventory });
  } catch (err) {
    console.error('Purchase patch error:', err.message);
    res.status(500).json({ error: 'Internal server error', detail: err.message });
  }
});

app.delete('/api/purchases/:id', authMiddleware, async (req, res) => {
  try {
    await supabase.from('purchases').delete().eq('id', req.params.id).eq('user_id', req.user.userId);
    await emitBusinessEvent(req.user.userId, 'purchase.deleted', {
      purchaseId: req.params.id,
    });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

// Bill Scanner — AI extracts purchase data from photo using vision provider fallback
app.post('/api/purchases/scan', authMiddleware, async (req, res) => {
  try {
    const { image, mimeType = 'image/jpeg' } = req.body;
    if (!image) return res.status(400).json({ error: 'image is required' });
    const validation = validateScanImagePayload(image, mimeType);
    if (!validation.valid) return res.status(400).json({ error: validation.error });

    const prompt = `You are an expert OCR system for Indian purchase bills, tax invoices, and challans.

Read the ENTIRE invoice image carefully: seller header at top, buyer/party block, invoice number + date, items table with ALL rows, totals at bottom.

Return ONLY a valid JSON object — no explanation, no markdown, no text before or after.

{
  "supplier_name": "SELLER company name at the very TOP of the invoice",
  "supplier_gstin": "SELLER GSTIN — 15-char alphanumeric code near seller name (or null)",
  "party_name": "BUYER/PARTY/CONSIGNEE name in buyer block (or null for cash bills)",
  "bill_number": "Invoice No / Bill No / Challan No exact value (or null)",
  "purchase_date": "invoice date as YYYY-MM-DD (or null)",
  "due_date": "payment due date as YYYY-MM-DD if shown (or null)",
  "items": [{ "description": "item name", "hsn_sac": "HSN code or null", "qty": number, "unit": "PCS/KG/SET/etc", "price": unit_rate_number, "amount": line_total_number }],
  "subtotal": taxable_amount_before_gst_or_null,
  "gst_rate": gst_percent_number_or_null,
  "gst_amount": total_tax_amount_number_or_null,
  "igst_amount": igst_amount_or_null,
  "cgst_amount": cgst_amount_or_null,
  "sgst_amount": sgst_amount_or_null,
  "igst_rate": igst_rate_percent_or_null,
  "cgst_rate": cgst_rate_percent_or_null,
  "sgst_rate": sgst_rate_percent_or_null,
  "total_amount": GRAND_TOTAL_including_all_taxes,
  "notes": "brief summary e.g. '5 items, cotton fabric' or null"
}

Rules: numbers without rupee symbol or commas (147630 not 1,47,630). Dates as YYYY-MM-DD. Read every item row. total_amount must not be null if any amount is visible.`;

    const { rawText, parsed, provider, model, providersTried } = await runVisionExtraction({ prompt, image, mimeType, maxTokens: 1600 });
    const extracted = normalizeScanExtraction(parsed, 'purchase');
    if (!IS_PRODUCTION) console.log('=== PURCHASES SCAN RAW ===', JSON.stringify({ provider, model, raw: rawText.substring(0, 120), extracted_keys: Object.keys(extracted) }));

    res.json({ success: true, data: extracted, _debug: IS_PRODUCTION ? undefined : rawText.substring(0, 300), _provider: provider, _providers_tried: providersTried });
  } catch (err) {
    sendVisionError(res, err, 'Purchase bill');
  }
});

// ============================================
// SALES / RECEIVABLES
// ============================================

app.get('/api/sales', authMiddleware, async (req, res) => {
  try {
    const { userId, businessId } = getBusinessContext(req);
    await ensureConnectedBusinessData(userId);
    const { status } = req.query;
    
    const sales = await salesService.getSales(userId, businessId, { status });
    res.json({ success: true, sales });
  } catch (err) { res.status(500).json({ error: err.message || 'Internal server error' }); }
});

app.post('/api/sales', authMiddleware, async (req, res) => {
  try {
    const { customer_name, total_amount, amount, customer_phone, customer_gstin, invoice_number,
            sale_date, due_date, paid_amount, notes, items, gst_type, gst_rate, gst_amount,
            cgst_amount, sgst_amount, igst_amount, subtotal } = req.body;
    const finalAmount = parseFloat(total_amount || amount || 0);
    if (!customer_name || !finalAmount) return res.status(400).json({ error: 'customer_name and total_amount are required' });
    // ── Cortex: Idempotency check ─────────────────────────────────────────────
    if (isFeatureEnabled('cortex_enabled')) {
      const _idemKey = req.headers['idempotency-key'];
      if (_idemKey) {
        const _cached = await require('./lib/services/orchestrator/idempotency.service').check(req.user.userId, _idemKey);
        if (_cached) return res.json(_cached);
      }
    }
    // ─────────────────────────────────────────────────────────────────────────
    const finalPaid = parseFloat(paid_amount || 0);
    const autoStatus = finalPaid >= finalAmount ? 'paid' : finalPaid > 0 ? 'partial' : 'unpaid';
    const { data, error } = await supabase.from('sales').insert([{
      user_id: req.user.userId, customer_name, amount: finalAmount, paid_amount: finalPaid,
      status: autoStatus, sale_date: sale_date || new Date().toISOString().split('T')[0],
      due_date: due_date || null, invoice_number: invoice_number || null,
      customer_phone: customer_phone || null, customer_gstin: customer_gstin || null,
      notes: notes || null,
      items: items ? JSON.stringify(items) : null,
      gst_type: gst_type || null, gst_rate: gst_rate || null, gst_amount: gst_amount || null,
      cgst_amount: cgst_amount || null, sgst_amount: sgst_amount || null, igst_amount: igst_amount || null,
      subtotal: subtotal || null,
    }]).select().single();
    if (error) throw error;
    
    // Trigger inventory sync
    await syncInventoryFromSale(req.user.userId, data);
    
    const receivable = await syncReceivableFromSale(req.user.userId, data);
    let sale = data;
    if (!sale.invoice_number && receivable?.invoice_number) {
      const updatedSale = await supabase
        .from('sales')
        .update({ invoice_number: receivable.invoice_number })
        .eq('id', sale.id)
        .eq('user_id', req.user.userId)
        .select()
        .single();
      if (!updatedSale.error && updatedSale.data) sale = updatedSale.data;
    }
    await emitBusinessEvent(req.user.userId, 'sale.created', {
      sale: sale,
      amount: finalAmount,
      customer_name,
    });
    // ── Cortex: Cashflow event + idempotency store ────────────────────────────
    if (isFeatureEnabled('cortex_enabled')) {
      require('./lib/services/orchestrator/cashflow.service')
        .createFromSale(req.user.userId, sale, finalAmount, finalPaid)
        .catch(err => console.warn('[Cortex] sale cashflow failed:', err.message));
      const _idemKey = req.headers['idempotency-key'];
      if (_idemKey) {
        const _resp = { success: true, sale: { ...sale, total_amount: parseFloat(sale.amount) }, receivable };
        require('./lib/services/orchestrator/idempotency.service')
          .set(req.user.userId, _idemKey, _resp)
          .catch(() => {});
      }
    }
    // ─────────────────────────────────────────────────────────────────────────
    res.json({ success: true, sale: { ...sale, total_amount: parseFloat(sale.amount) }, receivable });
  } catch (err) { res.status(500).json({ error: err.message || 'Internal server error' }); }
});

app.patch('/api/sales/:id', authMiddleware, async (req, res) => {
  try {
    const { total_amount, amount, paid_amount, customer_name, sale_date, due_date, notes, invoice_number, customer_phone, customer_gstin,
            items, gst_type, gst_rate, gst_amount, cgst_amount, sgst_amount, igst_amount, subtotal } = req.body;
    const { data: current, error: currentError } = await supabase
      .from('sales')
      .select('*')
      .eq('id', req.params.id)
      .eq('user_id', req.user.userId)
      .single();
    if (currentError || !current) return res.status(404).json({ error: 'Sale not found' });

    const updates = {};
    if (customer_name  !== undefined) updates.customer_name  = customer_name;
    if (sale_date      !== undefined) updates.sale_date      = sale_date || null;
    if (due_date       !== undefined) updates.due_date       = due_date || null;
    if (notes          !== undefined) updates.notes          = notes || null;
    if (invoice_number !== undefined) updates.invoice_number = invoice_number || null;
    if (customer_phone !== undefined) updates.customer_phone = customer_phone || null;
    if (customer_gstin !== undefined) updates.customer_gstin = customer_gstin || null;
    if (items          !== undefined) updates.items          = items ? JSON.stringify(items) : null;
    if (gst_type       !== undefined) updates.gst_type       = gst_type || null;
    if (gst_rate       !== undefined) updates.gst_rate       = gst_rate || null;
    if (gst_amount     !== undefined) updates.gst_amount     = gst_amount || null;
    if (cgst_amount    !== undefined) updates.cgst_amount    = cgst_amount || null;
    if (sgst_amount    !== undefined) updates.sgst_amount    = sgst_amount || null;
    if (igst_amount    !== undefined) updates.igst_amount    = igst_amount || null;
    if (subtotal       !== undefined) updates.subtotal       = subtotal || null;

    const newAmount = total_amount !== undefined ? parseFloat(total_amount) : amount !== undefined ? parseFloat(amount) : null;
    const finalAmount = newAmount !== null && Number.isFinite(newAmount) ? newAmount : parseFloat(current.amount || 0);
    const finalPaid = paid_amount !== undefined ? parseFloat(paid_amount || 0) : parseFloat(current.paid_amount || 0);
    updates.amount = finalAmount;
    updates.paid_amount = finalPaid;
    updates.status = finalPaid >= finalAmount ? 'paid' : finalPaid > 0 ? 'partial' : 'unpaid';
    if (paid_amount !== undefined) {
      updates.paid_amount = finalPaid;
    }
    const { data, error } = await supabase.from('sales').update(updates).eq('id', req.params.id).eq('user_id', req.user.userId).select().single();
    if (error) throw error;
    const receivable = await syncReceivableFromSale(req.user.userId, data);
    let sale = data;
    if (!sale.invoice_number && receivable?.invoice_number) {
      const updatedSale = await supabase
        .from('sales')
        .update({ invoice_number: receivable.invoice_number })
        .eq('id', sale.id)
        .eq('user_id', req.user.userId)
        .select()
        .single();
      if (!updatedSale.error && updatedSale.data) sale = updatedSale.data;
    }
    await emitBusinessEvent(req.user.userId, 'sale.updated', {
      sale: sale,
      amount: finalAmount,
    });
    res.json({ success: true, sale: { ...sale, total_amount: parseFloat(sale.amount) }, receivable });
  } catch (err) { res.status(500).json({ error: err.message || 'Internal server error' }); }
});

app.delete('/api/sales/:id', authMiddleware, async (req, res) => {
  try {
    const { data: sale } = await supabase
      .from('sales')
      .select('id, invoice_number')
      .eq('id', req.params.id)
      .eq('user_id', req.user.userId)
      .single();
    await supabase.from('sales').delete().eq('id', req.params.id).eq('user_id', req.user.userId);
    if (sale) await deleteReceivableForSale(req.user.userId, sale.id, sale.invoice_number);
    await emitBusinessEvent(req.user.userId, 'sale.deleted', {
      saleId: req.params.id,
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Sales Bill Scanner — AI extracts sale/invoice data from photo using vision provider fallback
app.post('/api/sales/scan', authMiddleware, async (req, res) => {
  try {
    const { image, mimeType = 'image/jpeg' } = req.body;
    if (!image) return res.status(400).json({ error: 'image is required' });
    const validation = validateScanImagePayload(image, mimeType);
    if (!validation.valid) return res.status(400).json({ error: validation.error });

    const prompt = `You are an expert OCR system for Indian tax invoices and GST bills.

Read the ENTIRE invoice image carefully: seller header at top, buyer block, invoice number + date, items table with ALL rows, totals at bottom.

Return ONLY a valid JSON object — no explanation, no markdown, no text before or after.

{
  "customer_name": "BUYER company/person name from Buyer/Bill To/Party section. If no buyer visible use 'Cash Sale'",
  "customer_gstin": "BUYER GSTIN — 15-char code in buyer block (or null)",
  "seller_gstin": "SELLER GSTIN — 15-char code near seller name at TOP (or null)",
  "supplier_name": "SELLER business name at very top of invoice",
  "invoice_number": "Invoice No / Bill No / Tax Invoice No exact value (or null)",
  "sale_date": "invoice date as YYYY-MM-DD (or null)",
  "due_date": "payment due date as YYYY-MM-DD if shown (or null)",
  "items": [{ "description": "item name", "hsn_sac": "HSN code or null", "qty": number, "unit": "PCS/KG/SET/etc", "price": unit_rate_number, "amount": line_total_number }],
  "subtotal": taxable_amount_before_gst_or_null,
  "gst_rate": gst_percent_number_or_null,
  "gst_amount": total_tax_number_or_null,
  "igst_amount": igst_amount_or_null,
  "cgst_amount": cgst_amount_or_null,
  "sgst_amount": sgst_amount_or_null,
  "igst_rate": igst_rate_or_null,
  "cgst_rate": cgst_rate_or_null,
  "sgst_rate": sgst_rate_or_null,
  "total_amount": GRAND_TOTAL_including_all_taxes,
  "notes": "brief summary e.g. '19 sewing machines, JK brand' or null"
}

Rules: numbers without rupee symbol or commas (147630 not 1,47,630). Dates as YYYY-MM-DD. Read ALL item rows. total_amount must never be null if any amount visible.`;

    const { rawText, parsed, provider, model, providersTried } = await runVisionExtraction({ prompt, image, mimeType, maxTokens: 1600 });
    const extracted = normalizeScanExtraction(parsed, 'sale');
    if (!IS_PRODUCTION) console.log('=== SALES SCAN RAW ===', JSON.stringify({ provider, model, raw: rawText.substring(0, 120), extracted_keys: Object.keys(extracted) }));
    res.json({ success: true, data: extracted, _debug: IS_PRODUCTION ? undefined : rawText.substring(0, 300), _provider: provider, _providers_tried: providersTried });
  } catch (err) {
    sendVisionError(res, err, 'Sales bill');
  }
});

// ============================================
// ATTENDANCE + SALARY
// ============================================

app.get('/api/attendance', authMiddleware, async (req, res) => {
  try {
    const month = req.query.month || String(new Date().getMonth() + 1).padStart(2, '0');
    const year = req.query.year || new Date().getFullYear();
    const from = `${year}-${String(month).padStart(2, '0')}-01`;
    const to = `${year}-${String(month).padStart(2, '0')}-31`;
    const [{ data: workers }, { data: attendance }] = await Promise.all([
      supabase.from('workers').select('*').eq('user_id', req.user.userId).eq('is_active', true),
      supabase.from('attendance').select('*').eq('user_id', req.user.userId).gte('attendance_date', from).lte('attendance_date', to),
    ]);
    res.json({ success: true, workers: workers || [], attendance: attendance || [], month, year });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/attendance', authMiddleware, async (req, res) => {
  try {
    const { worker_id, attendance_date, status } = req.body;
    if (!worker_id || !attendance_date) return res.status(400).json({ error: 'worker_id and date required' });
    const { data, error } = await supabase.from('attendance').upsert([{
      user_id: req.user.userId, worker_id, attendance_date, status: status || 'present', created_at: new Date(),
    }], { onConflict: 'worker_id,attendance_date' }).select().single();
    if (error) throw error;
    res.json({ success: true, attendance: data });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

app.get('/api/attendance/salary', authMiddleware, async (req, res) => {
  try {
    const month = req.query.month || String(new Date().getMonth() + 1).padStart(2, '0');
    const year = req.query.year || new Date().getFullYear();
    const from = `${year}-${String(month).padStart(2, '0')}-01`;
    const to = `${year}-${String(month).padStart(2, '0')}-31`;
    const [{ data: workers }, { data: attendance }] = await Promise.all([
      supabase.from('workers').select('*').eq('user_id', req.user.userId).eq('is_active', true),
      supabase.from('attendance').select('*').eq('user_id', req.user.userId).gte('attendance_date', from).lte('attendance_date', to),
    ]);
    // Count working days in month
    const daysInMonth = new Date(Number(year), Number(month), 0).getDate();
    const salaries = (workers || []).map(w => {
      const wAttendance = (attendance || []).filter(a => a.worker_id === w.id);
      const present = wAttendance.filter(a => a.status === 'present').length;
      const half = wAttendance.filter(a => a.status === 'half_day').length;
      const effectiveDays = present + (half * 0.5);
      const baseSalary = parseFloat(w.monthly_salary || 0);
      const earned = daysInMonth > 0 ? (effectiveDays / daysInMonth) * baseSalary : 0;
      const advance = parseFloat(w.advance_balance || 0);
      const net = Math.max(0, earned - advance);
      return { ...w, present_days: present, half_days: half, effective_days: effectiveDays, total_days: daysInMonth, earned_salary: Math.round(earned), advance_deducted: advance, net_salary: Math.round(net) };
    });
    res.json({ success: true, salaries, month, year });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

app.patch('/api/workers/:id/salary', authMiddleware, async (req, res) => {
  try {
    const { monthly_salary, advance_balance } = req.body;
    const updates = {};
    if (monthly_salary !== undefined) updates.monthly_salary = parseFloat(monthly_salary);
    if (advance_balance !== undefined) updates.advance_balance = parseFloat(advance_balance);
    const { data, error } = await supabase.from('workers').update(updates).eq('id', req.params.id).eq('user_id', req.user.userId).select().single();
    if (error) throw error;
    res.json({ success: true, worker: data });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

// ============================================
// BANK ACCOUNTS ENDPOINTS
// ============================================

app.get('/api/bank/accounts', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('bank_accounts')
      .select('*')
      .eq('user_id', req.user.userId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ success: true, accounts: data || [] });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/bank/accounts', authMiddleware, async (req, res) => {
  try {
    const { bank_name, account_last4, account_type, nickname, ifsc } = req.body;
    if (!bank_name) return res.status(400).json({ error: 'bank_name required' });
    const { data, error } = await supabase
      .from('bank_accounts')
      .insert([{
        user_id: req.user.userId,
        bank_name,
        account_last4: account_last4 || '',
        account_type: account_type || 'current',
        nickname: nickname || '',
        ifsc: ifsc || '',
        is_active: true,
      }])
      .select()
      .single();
    if (error) throw error;
    res.json({ success: true, account: data });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

app.delete('/api/bank/accounts/:id', authMiddleware, async (req, res) => {
  try {
    const { error } = await supabase
      .from('bank_accounts')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.user.userId);
    if (error) throw error;
    await createActivityLog(req.user.userId, 'bank_account_deleted', {
      entityType: 'bank_account',
      entityId: req.params.id,
      source: 'api',
    });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

// ============================================
// BANK MONITOR ENDPOINTS
// ============================================

app.get('/api/bank/transactions', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('bank_transactions')
      .select('*')
      .eq('user_id', req.user.userId)
      .order('txn_date', { ascending: false });
    if (error) throw error;
    res.json({ success: true, transactions: data || [] });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/bank/transactions', authMiddleware, async (req, res) => {
  try {
    const { txn_date, description, amount, type } = req.body;
    if (!amount || !type) return res.status(400).json({ error: 'amount and type required' });
    const { data, error } = await supabase
      .from('bank_transactions')
      .insert([{
        user_id: req.user.userId,
        txn_date: txn_date || new Date().toISOString().split('T')[0],
        description: description || '',
        amount: parseFloat(amount),
        type: type,
        status: 'unmatched',
      }])
      .select()
      .single();
    if (error) throw error;
    await createActivityLog(req.user.userId, 'bank_transaction_created', {
      entityType: 'bank_transaction',
      entityId: data.id,
      source: 'api',
      amount: parseFloat(amount),
      type,
    });
    res.json({ success: true, transaction: data });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/bank/match', authMiddleware, async (req, res) => {
  try {
    const { transaction_id, match_type, match_id } = req.body;
    if (!transaction_id || !match_type || !match_id) {
      return res.status(400).json({ error: 'transaction_id, match_type, match_id required' });
    }
    const { error: txnErr } = await supabase
      .from('bank_transactions')
      .update({ status: 'matched', matched_type: match_type, matched_id: String(match_id) })
      .eq('id', transaction_id)
      .eq('user_id', req.user.userId);
    if (txnErr) throw txnErr;

    if (match_type === 'invoice') {
      const { error: invErr } = await supabase
        .from('bills')
        .update({ status: 'paid', paid_at: new Date().toISOString() })
        .eq('id', match_id)
        .eq('user_id', req.user.userId);
      if (invErr) throw invErr;
    } else if (match_type === 'khata') {
      const { data: khata } = await supabase
        .from('khata_entries')
        .select('*')
        .eq('id', match_id)
        .eq('user_id', req.user.userId)
        .single();
      if (khata) {
        await supabase.from('khata_entries').insert([{
          user_id: req.user.userId,
          customer_id: khata.customer_id,
          customer_name: khata.customer_name,
          type: 'payment',
          amount: Math.abs(khata.balance || khata.amount),
          notes: 'Auto-matched from bank transaction',
          entry_date: new Date().toISOString().split('T')[0],
        }]);
      }
    }
    await createActivityLog(req.user.userId, 'bank_transaction_matched', {
      entityType: 'bank_transaction',
      entityId: transaction_id,
      source: 'api',
      matchType: match_type,
      matchId: String(match_id),
    });
    res.json({ success: true, message: 'Matched and marked as paid' });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

app.patch('/api/bank/transactions/:id/ignore', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('bank_transactions')
      .update({ status: 'ignored' })
      .eq('id', req.params.id)
      .eq('user_id', req.user.userId)
      .select()
      .single();
    if (error) throw error;
    res.json({ success: true, transaction: data });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

app.delete('/api/bank/transactions/:id', authMiddleware, async (req, res) => {
  try {
    const { error } = await supabase
      .from('bank_transactions')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.user.userId);
    if (error) throw error;
    await createActivityLog(req.user.userId, 'bank_transaction_deleted', {
      entityType: 'bank_transaction',
      entityId: req.params.id,
      source: 'api',
    });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});



// ============================================
// WEEKLY SCORECARD CRON -- Sunday 6pm IST (12:30 UTC)
// ============================================
cron.schedule('30 12 * * 0', async () => {
  console.log('Weekly scorecard cron running...');
  try {
    const { data: users } = await supabase.from('users').select('id, phone, business_name, owner_name').not('phone', 'is', null);
    if (!users?.length) return;
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    for (const user of users) {
      try {
        const [{ data: collected }, { data: pending }, { data: calls }] = await Promise.all([
          supabase.from('invoices').select('payment_amount, invoice_amount').eq('user_id', user.id).eq('payment_status', 'Paid').gte('payment_date', weekAgo),
          supabase.from('invoices').select('invoice_amount, customer_name, days_overdue').eq('user_id', user.id).eq('payment_status', 'Pending').order('days_overdue', { ascending: false }).limit(1),
          supabase.from('call_logs').select('id').eq('user_id', user.id).gte('called_at', weekAgo),
        ]);
        const collectedAmt = (collected || []).reduce((s, i) => s + Number(i.payment_amount || i.invoice_amount), 0);
        const riskParty = pending?.[0]?.customer_name || null;
        const riskDays = pending?.[0]?.days_overdue || 0;
        const callCount = calls?.length || 0;
        if (collectedAmt === 0 && callCount === 0) continue;
        const parts = [
          'Is Hafte ka Report - Vantro Flow',
          '',
          'Collections: Rs.' + collectedAmt.toLocaleString('en-IN'),
          'Calls made: ' + callCount,
          riskParty ? 'Risky account: ' + riskParty + ' (' + riskDays + ' din overdue - personally call karein)' : 'Koi risky account nahi!',
          '',
          'Vantro ne is hafte aapke liye kaam kiya. Agli hafte aur zyada collect karein!',
        ];
        await sendWhatsAppMessage(user.phone, parts.join('\n'));
      } catch (e) { console.error('Scorecard error user', user.id, e.message); }
    }
    console.log('Weekly scorecards sent');
  } catch (err) { console.error('Weekly scorecard cron error:', err.message); }
}, { timezone: 'UTC' });

// ============================================
// PAYMENT PLANS / EMI SPLITS
// ============================================

app.get('/api/payment-plans', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase.from('payment_plans').select('*').eq('user_id', req.user.userId).order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ success: true, plans: data || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/payment-plans', authMiddleware, async (req, res) => {
  try {
    const { invoice_id, customer_name, customer_phone, total_amount, installments, notes } = req.body;
    if (!customer_name || !total_amount || !installments?.length) return res.status(400).json({ error: 'customer_name, total_amount, installments required' });
    const { data, error } = await supabase.from('payment_plans').insert([{
      user_id: req.user.userId, invoice_id: invoice_id || null, customer_name,
      customer_phone: customer_phone || null, total_amount: parseFloat(total_amount),
      installments, status: 'active', notes: notes || null, created_at: new Date(),
    }]).select().single();
    if (error) throw error;
    if (customer_phone && installments[0]) {
      const msg = customer_name + ' ji, payment plan set ho gaya. Pehli installment: Rs.' + Number(installments[0].amount).toLocaleString('en-IN') + ' - due: ' + installments[0].due_date;
      await sendWhatsAppMessage(customer_phone, msg);
    }
    res.json({ success: true, plan: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/payment-plans/:id/installment', authMiddleware, async (req, res) => {
  try {
    const { installment_index, paid_at } = req.body;
    const { data: plan } = await supabase.from('payment_plans').select('*').eq('id', req.params.id).eq('user_id', req.user.userId).single();
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    const installments = plan.installments || [];
    if (installment_index >= installments.length) return res.status(400).json({ error: 'Invalid installment index' });
    installments[installment_index].paid = true;
    installments[installment_index].paid_at = paid_at || new Date().toISOString();
    const allPaid = installments.every(i => i.paid);
    const { data, error } = await supabase.from('payment_plans').update({ installments, status: allPaid ? 'completed' : 'active', updated_at: new Date() }).eq('id', req.params.id).eq('user_id', req.user.userId).select().single();
    if (error) throw error;
    res.json({ success: true, plan: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/payment-plans/:id', authMiddleware, async (req, res) => {
  try {
    await supabase.from('payment_plans').delete().eq('id', req.params.id).eq('user_id', req.user.userId);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================
// DISPUTE MANAGEMENT
// ============================================

app.get('/api/disputes', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase.from('disputes').select('*').eq('user_id', req.user.userId).order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ success: true, disputes: data || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/disputes', authMiddleware, async (req, res) => {
  try {
    const { invoice_id, customer_name, customer_phone, disputed_amount, reason, notes } = req.body;
    if (!customer_name || !disputed_amount || !reason) return res.status(400).json({ error: 'customer_name, disputed_amount, reason required' });
    const { data, error } = await supabase.from('disputes').insert([{
      user_id: req.user.userId, invoice_id: invoice_id || null, customer_name,
      customer_phone: customer_phone || null, disputed_amount: parseFloat(disputed_amount),
      reason, notes: notes || null, status: 'open', created_at: new Date(),
    }]).select().single();
    if (error) throw error;
    if (invoice_id) await supabase.from('invoices').update({ dunning_paused: true }).eq('id', invoice_id).eq('user_id', req.user.userId);
    res.json({ success: true, dispute: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/disputes/:id', authMiddleware, async (req, res) => {
  try {
    const updates = {};
    ['status', 'resolution', 'resolved_amount', 'notes'].forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
    updates.updated_at = new Date();
    if (updates.status === 'resolved') {
      updates.resolved_at = new Date();
      const { data: dispute } = await supabase.from('disputes').select('invoice_id').eq('id', req.params.id).eq('user_id', req.user.userId).single();
      if (dispute?.invoice_id) await supabase.from('invoices').update({ dunning_paused: false }).eq('id', dispute.invoice_id).eq('user_id', req.user.userId);
    }
    const { data, error } = await supabase.from('disputes').update(updates).eq('id', req.params.id).eq('user_id', req.user.userId).select().single();
    if (error) throw error;
    res.json({ success: true, dispute: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/disputes/:id', authMiddleware, async (req, res) => {
  try {
    await supabase.from('disputes').delete().eq('id', req.params.id).eq('user_id', req.user.userId);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================
// CA PARTNER PORTAL
// ============================================

app.post('/api/ca-partners/register', authMiddleware, async (req, res) => {
  try {
    const { firm_name, license_no, city, specialization } = req.body;
    if (!firm_name) return res.status(400).json({ error: 'firm_name required' });
    const referral_code = 'CA' + req.user.userId.replace(/-/g, '').substring(0, 8).toUpperCase();
    const { data, error } = await supabase.from('ca_partners').upsert([{
      ca_user_id: req.user.userId, firm_name, license_no: license_no || null,
      city: city || null, specialization: specialization || null,
      referral_code, status: 'active', created_at: new Date(),
    }], { onConflict: 'ca_user_id' }).select().single();
    if (error) throw error;
    res.json({ success: true, partner: data, referral_code });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/ca-partners/dashboard', authMiddleware, async (req, res) => {
  try {
    const { data: caData } = await supabase.from('ca_partners').select('*').eq('ca_user_id', req.user.userId).single();
    if (!caData) return res.status(404).json({ error: 'Not a CA partner. Register first.' });
    const { count: clientCount } = await supabase.from('users').select('id', { count: 'exact', head: true }).eq('referred_by', req.user.userId);
    const { count: paidCount } = await supabase.from('users').select('id', { count: 'exact', head: true }).eq('referred_by', req.user.userId).neq('plan', 'free');
    const monthlyCommission = (paidCount || 0) * 300;
    res.json({ success: true, ca: caData, stats: { total_clients: clientCount || 0, paid_clients: paidCount || 0, monthly_commission: monthlyCommission, referral_code: caData.referral_code } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/ca-partners/clients', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase.from('users').select('id, business_name, phone, plan, industry, created_at').eq('referred_by', req.user.userId).order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ success: true, clients: data || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================
// REFERRAL REWARD SYSTEM
// ============================================

app.get('/api/referrals/my-stats', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { count: totalReferrals } = await supabase.from('users').select('id', { count: 'exact', head: true }).eq('referred_by', userId);
    const { count: paidReferrals } = await supabase.from('users').select('id', { count: 'exact', head: true }).eq('referred_by', userId).neq('plan', 'free');
    const { data: rewards } = await supabase.from('referral_rewards').select('*').eq('referrer_id', userId).order('created_at', { ascending: false });
    const freeMonthsEarned = (rewards || []).filter(r => r.type === 'free_month').length;
    const referralCode = 'VF' + userId.replace(/-/g, '').substring(0, 8).toUpperCase();
    res.json({ success: true, stats: { total_referrals: totalReferrals || 0, paid_referrals: paidReferrals || 0, free_months_earned: freeMonthsEarned, referral_code: referralCode, referral_link: 'https://vantroflow.app/signup?ref=' + referralCode, rewards: rewards || [] } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/referrals/claim-reward', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { count: paidReferrals } = await supabase.from('users').select('id', { count: 'exact', head: true }).eq('referred_by', userId).neq('plan', 'free');
    const { count: claimedRewards } = await supabase.from('referral_rewards').select('id', { count: 'exact', head: true }).eq('referrer_id', userId).eq('type', 'free_month');
    const newRewards = (paidReferrals || 0) - (claimedRewards || 0);
    if (newRewards <= 0) return res.json({ success: false, message: 'No new rewards. Refer more paying customers!' });
    const rewardRows = Array.from({ length: newRewards }, () => ({ referrer_id: userId, type: 'free_month', value: 1, status: 'granted', created_at: new Date() }));
    await supabase.from('referral_rewards').insert(rewardRows);
    res.json({ success: true, rewards_granted: newRewards, message: newRewards + ' free month(s) added!' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================
// BAD DEBT FLAGGING
// ============================================

app.get('/api/bad-debt-flags/:userId', requireOwner, async (req, res) => {
  try {
    const { data: invoices } = await supabase.from('invoices').select('id, customer_name, invoice_amount, days_overdue, customer_phone').eq('user_id', req.params.userId).eq('payment_status', 'Pending').gte('days_overdue', 60).order('days_overdue', { ascending: false });
    if (!invoices?.length) return res.json({ success: true, flagged: [] });
    const flagged = (invoices || []).map(inv => {
      const risk = inv.days_overdue >= 120 ? 'critical' : inv.days_overdue >= 90 ? 'high' : 'medium';
      const recommendation = inv.days_overdue >= 120 ? 'Legal notice bhejein' : inv.days_overdue >= 90 ? 'Personal call karein' : 'Escalate karein';
      return { ...inv, risk_level: risk, recommendation };
    });
    res.json({ success: true, flagged });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================
// MULTI-USER TEAM ROLES & PERMISSIONS
// ============================================

app.get('/api/team/members', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase.from('team_members').select('*').eq('owner_id', req.user.userId).order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ success: true, members: data || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/team/members', authMiddleware, async (req, res) => {
  try {
    const { name, phone, email, role } = req.body;
    const validRoles = ['accountant', 'salesman', 'collections_agent', 'viewer'];
    if (!name || !role || !validRoles.includes(role)) return res.status(400).json({ error: 'name and valid role required. Roles: ' + validRoles.join(', ') });
    const permissions = {
      accountant:        ['dashboard', 'collections', 'khata', 'ledger', 'reports', 'invoices', 'bills'],
      salesman:          ['dashboard', 'orders', 'customers', 'collections'],
      collections_agent: ['dashboard', 'collections', 'khata', 'whatsapp', 'calls'],
      viewer:            ['dashboard', 'reports', 'analytics'],
    };
    const { data, error } = await supabase.from('team_members').insert([{
      owner_id: req.user.userId, name, phone: phone || null, email: email || null,
      role, permissions: permissions[role], is_active: true, created_at: new Date(),
    }]).select().single();
    if (error) throw error;
    res.json({ success: true, member: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/team/members/:id', authMiddleware, async (req, res) => {
  try {
    const updates = {};
    ['name', 'phone', 'email', 'role', 'permissions', 'is_active'].forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
    updates.updated_at = new Date();
    const { data, error } = await supabase.from('team_members').update(updates).eq('id', req.params.id).eq('owner_id', req.user.userId).select().single();
    if (error) throw error;
    res.json({ success: true, member: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/team/members/:id', authMiddleware, async (req, res) => {
  try {
    await supabase.from('team_members').delete().eq('id', req.params.id).eq('owner_id', req.user.userId);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================
// WHATSAPP MANUAL SEND & PROVIDER STATUS
// ============================================

app.post('/api/whatsapp/send', authMiddleware, async (req, res) => {
  try {
    const { phone, message } = req.body;
    if (!phone || !message) return res.status(400).json({ error: 'phone and message required' });
    const result = await sendWhatsAppMessage(phone, message);
    res.json({ success: true, result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/whatsapp/status', authMiddleware, (req, res) => {
  const provider = process.env.INTERAKT_API_KEY ? 'interakt' : (process.env.WATI_API_URL ? 'wati' : 'mock');
  res.json({ success: true, provider, configured: provider !== 'mock', message: provider === 'mock' ? 'Set INTERAKT_API_KEY or WATI_API_URL+WATI_TOKEN to enable real WhatsApp.' : 'Using ' + provider });
});


// ============================================
// REPORTS EXPORT — Excel / CSV download
// ============================================

app.get('/api/reports/export', authMiddleware, async (req, res) => {
  try {
    const XLSX = require('xlsx');
    const userId = req.user.userId;
    const { report = 'outstanding', format = 'xlsx', from, to } = req.query;

    // Build date filter
    const fromDate = from || new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
    const toDate   = to   || new Date().toISOString().split('T')[0];

    let wb;

    // ── 1. Outstanding Receivables ──────────────────────────────────────────
    if (report === 'outstanding') {
      const { data: invoices, error } = await supabase
        .from('invoices')
        .select('customer_name, customer_phone, invoice_amount, invoice_date, days_overdue, payment_status, due_date')
        .eq('user_id', userId)
        .eq('payment_status', 'Pending')
        .order('days_overdue', { ascending: false });
      if (error) throw error;

      const rows = (invoices || []).map(inv => ({
        'Customer Name':   inv.customer_name || '',
        'Phone':           inv.customer_phone || '',
        'Amount (₹)':      Number(inv.invoice_amount || 0),
        'Invoice Date':    inv.invoice_date || '',
        'Due Date':        inv.due_date || '',
        'Days Overdue':    Number(inv.days_overdue || 0),
        'Status':          inv.payment_status || 'Pending',
      }));

      const totalRow = {
        'Customer Name': 'TOTAL',
        'Phone': '',
        'Amount (₹)': rows.reduce((s, r) => s + r['Amount (₹)'], 0),
        'Invoice Date': '',
        'Due Date': '',
        'Days Overdue': '',
        'Status': `${rows.length} invoices`,
      };

      const ws = XLSX.utils.json_to_sheet([...rows, totalRow]);
      ws['!cols'] = [{ wch: 28 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 12 }];
      wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Outstanding Receivables');
    }

    // ── 2. Collection Performance (Paid in date range) ──────────────────────
    else if (report === 'collection') {
      const { data: paid } = await supabase
        .from('invoices')
        .select('customer_name, payment_amount, invoice_amount, payment_date, payment_method, days_overdue')
        .eq('user_id', userId)
        .eq('payment_status', 'Paid')
        .gte('payment_date', fromDate)
        .lte('payment_date', toDate)
        .order('payment_date', { ascending: false });

      const { data: calls } = await supabase
        .from('call_logs')
        .select('customer_name, did_pick_up, promised_payment_date, notes, called_at')
        .eq('user_id', userId)
        .gte('called_at', fromDate)
        .lte('called_at', toDate)
        .order('called_at', { ascending: false });

      wb = XLSX.utils.book_new();

      const payRows = (paid || []).map(p => ({
        'Customer':       p.customer_name || '',
        'Collected (₹)':  Number(p.payment_amount || p.invoice_amount || 0),
        'Invoice (₹)':    Number(p.invoice_amount || 0),
        'Paid On':        p.payment_date || '',
        'Method':         p.payment_method || 'N/A',
        'Was Overdue (d)': Number(p.days_overdue || 0),
      }));
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(payRows.length ? payRows : [{ 'Info': 'No payments in range' }]), 'Payments');

      const callRows = (calls || []).map(c => ({
        'Customer':         c.customer_name || '',
        'Date':             (c.called_at || '').split('T')[0],
        'Picked Up':        c.did_pick_up ? 'Yes' : 'No',
        'Promised Date':    c.promised_payment_date || '',
        'Notes':            c.notes || '',
      }));
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(callRows.length ? callRows : [{ 'Info': 'No calls in range' }]), 'Call Logs');
    }

    // ── 3. GST Summary ──────────────────────────────────────────────────────
    else if (report === 'gst') {
      const { data: bills } = await supabase
        .from('bills')
        .select('bill_number, customer_name, customer_gstin, invoice_date, subtotal, tax_amount, total_amount, status')
        .eq('user_id', userId)
        .gte('invoice_date', fromDate)
        .lte('invoice_date', toDate)
        .order('invoice_date', { ascending: false });

      const rows = (bills || []).map(b => ({
        'Bill No.':         b.bill_number || '',
        'Customer':         b.customer_name || '',
        'GSTIN':            b.customer_gstin || '',
        'Date':             b.invoice_date || '',
        'Subtotal (₹)':     Number(b.subtotal || 0),
        'GST (₹)':          Number(b.tax_amount || 0),
        'Total (₹)':        Number(b.total_amount || 0),
        'Status':           b.status || '',
      }));
      wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows.length ? rows : [{ 'Info': 'No bills in range' }]), 'GST Bills');
    }

    // ── 4. Cash Flow Forecast (simple 30d projection) ───────────────────────
    else if (report === 'cashflow') {
      const { data: pending } = await supabase
        .from('invoices')
        .select('customer_name, invoice_amount, days_overdue, due_date')
        .eq('user_id', userId)
        .eq('payment_status', 'Pending')
        .order('due_date', { ascending: true });

      const rows = (pending || []).map(inv => {
        const overdue = Number(inv.days_overdue || 0);
        const prob = overdue <= 7 ? 90 : overdue <= 30 ? 65 : overdue <= 60 ? 35 : 15;
        return {
          'Customer':      inv.customer_name || '',
          'Amount (₹)':    Number(inv.invoice_amount || 0),
          'Due Date':      inv.due_date || '',
          'Days Overdue':  overdue,
          'Pay Probability %': prob,
          'Expected (₹)':  Math.round(Number(inv.invoice_amount || 0) * prob / 100),
        };
      });
      wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows.length ? rows : [{ 'Info': 'No pending invoices' }]), 'Cash Flow Forecast');
    }

    // ── 5. Calls Log ────────────────────────────────────────────────────────
    else if (report === 'calls') {
      const { data: calls } = await supabase
        .from('call_logs')
        .select('customer_name, customer_phone, amount, did_pick_up, promised_payment_date, promised_amount, notes, called_at')
        .eq('user_id', userId)
        .gte('called_at', fromDate)
        .lte('called_at', toDate)
        .order('called_at', { ascending: false });

      const rows = (calls || []).map(c => ({
        'Customer':        c.customer_name || '',
        'Phone':           c.customer_phone || '',
        'Amount (₹)':      Number(c.amount || 0),
        'Date':            (c.called_at || '').split('T')[0],
        'Picked Up':       c.did_pick_up ? 'Yes' : 'No',
        'Promised Date':   c.promised_payment_date || '',
        'Promised (₹)':    Number(c.promised_amount || 0),
        'Notes':           c.notes || '',
      }));
      wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows.length ? rows : [{ 'Info': 'No calls in range' }]), 'Call Activity');
    }

    // ── 6. Customer Statement (all invoices per customer) ───────────────────
    else if (report === 'customer') {
      const { data: invoices } = await supabase
        .from('invoices')
        .select('customer_name, invoice_amount, payment_amount, payment_status, invoice_date, payment_date, days_overdue')
        .eq('user_id', userId)
        .order('customer_name', { ascending: true })
        .order('invoice_date', { ascending: false });

      wb = XLSX.utils.book_new();
      // Group by customer
      const byCustomer = {};
      (invoices || []).forEach(inv => {
        const key = inv.customer_name || 'Unknown';
        if (!byCustomer[key]) byCustomer[key] = [];
        byCustomer[key].push(inv);
      });
      const rows = (invoices || []).map(inv => ({
        'Customer':       inv.customer_name || '',
        'Invoice (₹)':    Number(inv.invoice_amount || 0),
        'Paid (₹)':       inv.payment_status === 'Paid' ? Number(inv.payment_amount || inv.invoice_amount || 0) : 0,
        'Outstanding (₹)':inv.payment_status === 'Pending' ? Number(inv.invoice_amount || 0) : 0,
        'Invoice Date':   inv.invoice_date || '',
        'Payment Date':   inv.payment_date || '',
        'Status':         inv.payment_status || '',
        'Days Overdue':   Number(inv.days_overdue || 0),
      }));
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows.length ? rows : [{ 'Info': 'No invoices found' }]), 'Customer Statements');
    }

    // Fallback
    else {
      return res.status(400).json({ error: 'Unknown report type. Use: outstanding, collection, gst, cashflow, calls, customer' });
    }

    // Send file
    if (!wb) return res.status(500).json({ error: 'Failed to build workbook' });

    // ── PDF / Print-friendly HTML ───────────────────────────────────────────
    if (format === 'pdf' || format === 'html') {
      const REPORT_NAMES = {
        outstanding: 'Outstanding Receivables', collection: 'Collection Performance',
        gst: 'GST Summary', cashflow: 'Cash Flow Forecast',
        calls: 'Call Activity Log', customer: 'Customer Statement',
      };
      // Flatten all sheets into one HTML table per sheet
      const sheetsHtml = wb.SheetNames.map(sheetName => {
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName]);
        if (!rows.length) return `<h3>${sheetName}</h3><p style="color:#888">No data</p>`;
        const headers = Object.keys(rows[0]);
        return `
          <h3 style="margin:24px 0 8px;font-size:14px;color:#0066FF">${sheetName}</h3>
          <table>
            <thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead>
            <tbody>${rows.map(row => `<tr>${headers.map(h => `<td>${row[h] ?? ''}</td>`).join('')}</tr>`).join('')}</tbody>
          </table>`;
      }).join('');

      const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<title>Vantro — ${REPORT_NAMES[report] || report}</title>
<style>
  body{font-family:system-ui,sans-serif;padding:32px;color:#111;max-width:960px;margin:0 auto}
  h1{font-size:20px;font-weight:800;margin-bottom:2px}
  .meta{font-size:12px;color:#666;margin-bottom:24px}
  table{width:100%;border-collapse:collapse;font-size:12px;margin-bottom:16px}
  th{background:#0066FF;color:#fff;padding:8px 10px;text-align:left;font-weight:600}
  td{padding:6px 10px;border-bottom:1px solid #e2e8f0}
  tr:nth-child(even) td{background:#f8fafc}
  @media print{body{padding:0} button{display:none}}
</style></head><body>
<button onclick="window.print()" style="float:right;padding:8px 16px;background:#0066FF;color:#fff;border:none;border-radius:8px;font-weight:600;cursor:pointer;font-size:13px">🖨 Print / Save PDF</button>
<h1>Vantro Flow — ${REPORT_NAMES[report] || report}</h1>
<p class="meta">Period: ${fromDate} to ${toDate} &nbsp;·&nbsp; Generated: ${new Date().toLocaleDateString('en-IN', { day:'numeric',month:'long',year:'numeric' })}</p>
${sheetsHtml}
</body></html>`;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(html);
    }

    if (format === 'csv') {
      const firstSheet = wb.Sheets[wb.SheetNames[0]];
      const csv = XLSX.utils.sheet_to_csv(firstSheet);
      const filename = `vantro-${report}-${fromDate}.csv`;
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Type', 'text/csv');
      return res.send(csv);
    }

    const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });
    const filename = `vantro-${report}-${fromDate}-to-${toDate}.xlsx`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);

  } catch (err) {
    console.error('Report export error:', err);
    res.status(500).json({ error: 'Export failed: ' + err.message });
  }
});

// ============================================
// VANTRO CORTEX — MILESTONE C
// Promises API + AI Actions API + Crons
// ============================================

// ── PROMISES ─────────────────────────────────────────────────────────────────

app.get('/api/promises', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { status, customer_id, limit: lim = 50 } = req.query;
    let query = supabase
      .from('promises')
      .select('*, customers(name, phone)')
      .eq('user_id', userId)
      .order('promised_date', { ascending: true })
      .limit(Number(lim));
    if (status) query = query.eq('status', status);
    if (customer_id) query = query.eq('customer_id', customer_id);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ success: true, promises: data || [] });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/promises', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { customer_id, receivable_id, promised_amount, promised_date, promise_note } = req.body;
    if (!customer_id || !promised_date) return res.status(400).json({ error: 'customer_id and promised_date are required' });
    const { data, error } = await supabase.from('promises').insert([{
      user_id: userId,
      customer_id,
      receivable_id: receivable_id || null,
      promised_amount: promised_amount != null ? parseFloat(promised_amount) : null,
      promised_date,
      promise_note: promise_note || null,
      status: 'active',
      created_by: userId,
    }]).select().single();
    if (error) throw error;
    if (isFeatureEnabled('cortex_enabled')) {
      const { emitBusinessEvent } = require('./lib/events/EventEngine');
      emitBusinessEvent(userId, 'PROMISE_CREATED', { promiseId: data.id, promised_date, promised_amount, customer_id });
    }
    res.status(201).json({ success: true, promise: data });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

app.patch('/api/promises/:id', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;
    const { status, promise_note, promised_date } = req.body;
    const allowedStatuses = ['kept', 'broken', 'rescheduled', 'active'];
    if (status && !allowedStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const updates = {};
    if (status) {
      updates.status = status;
      updates.resolved_at = ['kept', 'broken'].includes(status) ? new Date().toISOString() : null;
    }
    if (promise_note !== undefined) updates.promise_note = promise_note;
    if (promised_date) updates.promised_date = promised_date;
    const { data, error } = await supabase
      .from('promises').update(updates).eq('id', id).eq('user_id', userId).select().single();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Promise not found' });
    if (status && isFeatureEnabled('cortex_enabled')) {
      const { emitBusinessEvent } = require('./lib/events/EventEngine');
      emitBusinessEvent(userId, status === 'kept' ? 'PROMISE_KEPT' : status === 'broken' ? 'PROMISE_BROKEN' : 'PROMISE_RESCHEDULED',
        { promiseId: id, customer_id: data.customer_id });
    }
    res.json({ success: true, promise: data });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

// ── AI ACTIONS ───────────────────────────────────────────────────────────────

app.get('/api/ai-actions', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { status = 'pending', priority, limit: lim = 50, offset: off = 0 } = req.query;
    let query = supabase
      .from('ai_actions')
      .select('*, customers(name, phone)')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(Number(off), Number(off) + Number(lim) - 1);
    if (status !== 'all') query = query.eq('status', status);
    if (priority) query = query.eq('priority', priority);
    const { data, error } = await query;
    if (error) throw error;
    // Priority counts for badge display
    const { data: summary } = await supabase
      .from('ai_actions').select('priority').eq('user_id', userId).eq('status', 'pending');
    const counts = {};
    (summary || []).forEach(r => { counts[r.priority] = (counts[r.priority] || 0) + 1; });
    res.json({ success: true, actions: data || [], counts, total: (data || []).length });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

app.patch('/api/ai-actions/:id', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;
    const { status } = req.body;
    const allowed = ['approved', 'rejected', 'done'];
    if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status. Must be: approved, rejected, done' });
    const updates = { status, updated_at: new Date().toISOString() };
    if (status === 'approved') { updates.approved_by = userId; updates.approved_at = new Date().toISOString(); }
    if (status === 'done') updates.completed_at = new Date().toISOString();
    const { data, error } = await supabase
      .from('ai_actions').update(updates).eq('id', id).eq('user_id', userId).select().single();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Action not found' });
    res.json({ success: true, action: data });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

// ── CUSTOMER INTELLIGENCE (behavioral profile for customers page) ────────────
// GET /api/customers/intelligence?name=X&phone=Y
// Returns aggregated Cortex intelligence for a customer by name.
// Used by the customer detail panel in the Customers page.
app.get('/api/customers/intelligence', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { name, phone } = req.query;
    if (!name) return res.status(400).json({ error: 'name is required' });

    // Resolve customer UUID from Cortex customers table
    const { recalculate, resolveCustomerId } = require('./lib/services/orchestrator/scoring.service');
    const customerId = await resolveCustomerId(userId, name, phone || null);

    // Parallel fetch all intelligence
    const [scoreRes, promisesRes, actionsRes, invoicesRes, memoryRes] = await Promise.all([
      // Score
      customerId
        ? supabase.from('customer_scores').select('*').eq('user_id', userId).eq('customer_id', customerId).maybeSingle()
        : { data: null },

      // Active promises
      customerId
        ? supabase.from('promises').select('promised_amount, promised_date, status, created_at').eq('user_id', userId).eq('customer_id', customerId).order('created_at', { ascending: false }).limit(10)
        : { data: [] },

      // Pending AI actions for this customer
      customerId
        ? supabase.from('ai_actions').select('action_type, title, priority, status, created_at').eq('user_id', userId).eq('customer_id', customerId).neq('status', 'expired').order('created_at', { ascending: false }).limit(10)
        : supabase.from('ai_actions').select('action_type, title, priority, status, created_at').eq('user_id', userId).ilike('title', `%${name.split(' ')[0]}%`).neq('status', 'expired').limit(5),

      // Recent invoices
      supabase.from('invoices').select('id, invoice_amount, payment_status, due_date, days_overdue, created_at').eq('user_id', userId).ilike('customer_name', `%${name}%`).order('created_at', { ascending: false }).limit(10),

      // Business memory
      customerId
        ? supabase.from('business_memory').select('memory_key, memory_value, updated_at').eq('user_id', userId).eq('entity_type', 'customer').eq('entity_id', customerId).order('updated_at', { ascending: false }).limit(20)
        : { data: [] },
    ]);

    const score = scoreRes.data;
    const promises = promisesRes.data || [];
    const actions  = actionsRes.data  || [];
    const invoices = invoicesRes.data  || [];
    const memories = memoryRes.data   || [];

    // Derive tier from score
    const creditRiskScore = parseFloat(score?.credit_risk_score || 0);
    const tier = creditRiskScore >= 70 ? 'HIGH_RISK' : creditRiskScore >= 40 ? 'MEDIUM' : 'LOW';

    // Compute behavioral summary
    const totalOutstanding = invoices.filter(i => i.payment_status === 'Pending').reduce((s, i) => s + parseFloat(i.invoice_amount || 0), 0);
    const overdueCount = invoices.filter(i => i.payment_status === 'Pending' && i.days_overdue > 0).length;
    const activePromises = promises.filter(p => p.status === 'active');
    const brokenPromises = promises.filter(p => p.status === 'broken').length;
    const pendingActions = actions.filter(a => a.status === 'pending' || a.status === 'approved');

    // Credit recommendation
    let creditRecommendation = 'OK to extend credit';
    if (creditRiskScore >= 70) creditRecommendation = '⚠️ High risk — request advance payment';
    else if (creditRiskScore >= 50) creditRecommendation = '⚡ Medium risk — reduce credit limit';
    else if (brokenPromises >= 2) creditRecommendation = '⚠️ Broken promises — owner approval required';

    res.json({
      success:        true,
      customer_id:    customerId,
      name,
      score: {
        credit_risk_score:        Math.round(creditRiskScore),
        collection_priority_score: Math.round(parseFloat(score?.collection_priority_score || 0)),
        promise_reliability_score: Math.round(parseFloat(score?.promise_reliability_score || 100)),
        average_delay_days:        Math.round(parseFloat(score?.average_delay_days || 0)),
        max_delay_days:            score?.max_delay_days || 0,
        broken_promise_count:      score?.broken_promise_count || 0,
        tier,
        credit_recommendation:     creditRecommendation,
        last_calculated_at:        score?.last_calculated_at || null,
      },
      summary: {
        total_outstanding: Math.round(totalOutstanding),
        overdue_count:     overdueCount,
        active_promises:   activePromises.length,
        broken_promises:   brokenPromises,
        pending_actions:   pendingActions.length,
      },
      promises: promises.slice(0, 5),
      actions:  pendingActions.slice(0, 5),
      invoices: invoices.slice(0, 5),
      memories: memories.slice(0, 10),
    });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── AI ACTIONS — COUNTS (for dashboard urgency strip) ────────────────────────
app.get('/api/ai-actions/counts', authMiddleware, async (req, res) => {
  try {
    const { isEnabled: _isFE } = require('./lib/featureFlags');
    if (!_isFE('ai_action_center')) return res.json({ urgent: 0, high: 0, total: 0 });
    const userId = req.user.userId;
    const { data, error } = await supabase
      .from('ai_actions')
      .select('priority')
      .eq('user_id', userId)
      .eq('status', 'pending');
    if (error) throw error;
    const rows = data || [];
    const urgent = rows.filter(r => r.priority === 'urgent').length;
    const high   = rows.filter(r => r.priority === 'high').length;

    // Auto-seed: if no actions exist yet, create today's briefing in background
    if (rows.length === 0 && _isFE('cortex_enabled')) {
      setImmediate(async () => {
        try {
          const today = new Date().toISOString().split('T')[0];
          const { data: existing } = await supabase
            .from('ai_actions').select('id').eq('user_id', userId)
            .eq('action_type', 'DAILY_OWNER_BRIEFING').gte('created_at', today).maybeSingle();
          if (!existing) {
            const { create: _createAction } = require('./lib/services/orchestrator/action.service');
            const { data: overdue } = await supabase
              .from('invoices').select('customer_name, invoice_amount, days_overdue')
              .eq('user_id', userId).eq('payment_status', 'Pending')
              .order('days_overdue', { ascending: false }).limit(3);
            const overdueList = overdue || [];
            const descParts = overdueList.length
              ? [`${overdueList.length} overdue invoice${overdueList.length > 1 ? 's' : ''}`,
                 `Top: ${overdueList[0].customer_name} (₹${Number(overdueList[0].invoice_amount).toLocaleString('en-IN')}, ${overdueList[0].days_overdue}d)`]
              : ['No overdue invoices'];
            await _createAction(userId, {
              action_type:       'DAILY_OWNER_BRIEFING',
              title:             overdueList.length ? `${overdueList.length} overdue invoice${overdueList.length > 1 ? 's' : ''} need attention` : 'Daily Briefing — all clear',
              description:       descParts.join(' · '),
              priority:          overdueList.some(i => i.days_overdue > 45) ? 'high' : 'medium',
              suggested_by:      'system',
              requires_approval: false,
              risk_level:        'low',
            });
          }
        } catch {}
      });
    }

    res.json({ urgent, high, total: rows.length });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

// ── CUSTOMER SCORES (for collections + customers pages) ──────────────────────
app.get('/api/customer-scores', authMiddleware, async (req, res) => {
  try {
    const { isEnabled: _isFE } = require('./lib/featureFlags');
    if (!_isFE('customer_scoring')) return res.json({ scores: [] });
    const userId = req.user.userId;

    const fetchScores = async () => {
      const { data, error } = await supabase
        .from('customer_scores')
        .select('customer_id, credit_risk_score, collection_priority_score, max_delay_days, score_reason_json, customers(name)')
        .eq('user_id', userId)
        .order('credit_risk_score', { ascending: false });
      if (error) throw error;
      return (data || []).map(r => {
        const raw = parseFloat(r.credit_risk_score || 0);
        const tier = raw >= 70 ? 'HIGH_RISK' : raw >= 40 ? 'MEDIUM' : 'LOW';
        const overdue = r.score_reason_json?.inputs?.totalOverdue || 0;
        return {
          customer_id:    r.customer_id,
          customer_name:  r.customers?.name || 'Unknown',
          score:          Math.round(raw),
          tier,
          overdue_amount: Math.round(overdue),
          max_delay_days: r.max_delay_days || 0,
        };
      });
    };

    let scores = await fetchScores();

    // Auto-backfill: if no scores yet, run scoring for all customers then return
    if (scores.length === 0) {
      try {
        const { data: customers } = await supabase
          .from('customers').select('id').eq('user_id', userId).eq('is_active', true).limit(100);
        if (customers?.length) {
          const { recalculate } = require('./lib/services/orchestrator/scoring.service');
          await Promise.allSettled(customers.map(c => recalculate(userId, c.id)));
          scores = await fetchScores();
        }
      } catch (backfillErr) {
        const { safeLog } = require('./lib/observability/logger');
        safeLog('warn', '[CustomerScores] Auto-backfill failed', { error: backfillErr.message });
      }
    }

    res.json({ scores: stripCortexTestRows(scores) });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

// ── SCORE ALL CUSTOMERS (one-time backfill / manual re-score) ─────────────────
app.post('/api/cortex/score-all', authMiddleware, async (req, res) => {
  try {
    const { isEnabled: _isFE } = require('./lib/featureFlags');
    if (!_isFE('customer_scoring')) return res.json({ scored: 0, message: 'customer_scoring flag off' });
    const userId = req.user.userId;
    const { data: customers, error: cErr } = await supabase
      .from('customers').select('id, name').eq('user_id', userId).eq('is_active', true).limit(200);
    if (cErr) throw cErr;
    const list = customers || [];
    if (!list.length) return res.json({ scored: 0, message: 'No customers found' });
    const { recalculate } = require('./lib/services/orchestrator/scoring.service');
    let scored = 0;
    for (const c of list) {
      try { await recalculate(userId, c.id); scored++; } catch {}
    }
    res.json({ success: true, scored, total: list.length });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

// ── SEND WHATSAPP FOR AI ACTION ───────────────────────────────────────────────
app.post('/api/ai-actions/:id/send-whatsapp', authMiddleware, async (req, res) => {
  try {
    const { isEnabled: _isFE } = require('./lib/featureFlags');
    if (!_isFE('ai_message_drafts')) return res.status(403).json({ error: 'Feature not enabled' });
    const userId = req.user.userId;
    const { id } = req.params;

    const { data: action, error: fetchErr } = await supabase
      .from('ai_actions')
      .select('*, customers(name, phone)')
      .eq('id', id)
      .eq('user_id', userId)
      .single();
    if (fetchErr || !action) return res.status(404).json({ error: 'Action not found' });

    // Phase 2C.35-P1: human-in-the-loop — an AI action must be explicitly approved
    // by the owner before it can send externally. (External-send flag is enforced
    // at the sendWhatsAppMessage choke point.)
    if (action.status !== 'approved') {
      return res.status(409).json({ error: 'Action must be approved before sending', status: action.status || null });
    }

    const phone   = action.customers?.phone || null;
    const message = action.recommended_message || action.description || action.title;

    if (!phone)   return res.status(422).json({ error: 'No customer phone on record' });
    if (!message) return res.status(422).json({ error: 'No message content to send' });
    if (!process.env.TWILIO_WHATSAPP_NUMBER) {
      return res.status(503).json({ error: 'WhatsApp not configured — set TWILIO_WHATSAPP_NUMBER in Railway' });
    }

    const sendResult = await sendWhatsAppMessage(phone, message);
    if (!sendResult?.success) {
      return res.status(502).json({ error: 'WhatsApp send failed', detail: sendResult });
    }

    await supabase
      .from('ai_actions')
      .update({ status: 'done', completed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', userId);

    res.json({ success: true, sid: sendResult.sid || null, provider: sendResult.provider });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

// ── MANUAL BRIEFING TRIGGER (runs daily briefing logic now for the calling user) ─
app.post('/api/cortex/run-briefing', authMiddleware, async (req, res) => {
  try {
    const { isEnabled: _isFE } = require('./lib/featureFlags');
    if (!_isFE('cortex_enabled')) return res.json({ created: 0, message: 'cortex_enabled flag off' });
    const { safeLog } = require('./lib/observability/logger');
    const userId = req.user.userId;

    const [
      overdueResult,
      brokenResult,
      pendingResult,
    ] = await Promise.all([
      supabase.from('invoices').select('customer_name, invoice_amount, days_overdue').eq('user_id', userId).eq('payment_status', 'Pending').order('days_overdue', { ascending: false }).limit(1),
      supabase.from('promises').select('id').eq('user_id', userId).eq('status', 'broken').gte('resolved_at', new Date(Date.now() - 86400000).toISOString()),
      supabase.from('ai_actions').select('id').eq('user_id', userId).eq('status', 'pending'),
    ]);

    const overdue       = overdueResult.data || [];
    const brokenToday   = brokenResult.data || [];
    const pendingCount  = pendingResult.data?.length || 0;
    const descParts = [
      overdue[0] ? `Top overdue: ${overdue[0].customer_name} (₹${Number(overdue[0].invoice_amount).toLocaleString('en-IN')}, ${overdue[0].days_overdue}d)` : null,
      brokenToday.length ? `${brokenToday.length} promise(s) broken recently` : null,
      pendingCount ? `${pendingCount} action(s) awaiting review` : null,
    ].filter(Boolean);

    const { create: createAction } = require('./lib/services/orchestrator/action.service');
    const action = await createAction(userId, {
      action_type:       'DAILY_OWNER_BRIEFING',
      title:             `Daily Briefing — ${pendingCount} pending action${pendingCount !== 1 ? 's' : ''}`,
      description:       descParts.join(' · ') || 'Your business is on track.',
      priority:          pendingCount >= 5 ? 'high' : pendingCount >= 2 ? 'medium' : 'low',
      suggested_by:      'system',
      requires_approval: false,
      risk_level:        'low',
    });

    safeLog('info', '[ManualBriefing] Created via API', { userId, actionId: action?.id });
    res.json({ success: true, created: 1, action });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

// ── CORTEX: CASHFLOW WEEK PREVIEW ────────────────────────────────────────────
app.get('/api/cortex/cashflow-week', authMiddleware, async (req, res) => {
  try {
    const { isEnabled: _isFE } = require('./lib/featureFlags');
    const userId = req.user.userId;
    const { getWeekForecast } = require('./lib/services/orchestrator/cashflow.service');
    const forecast = await getWeekForecast(userId);

    // Also fetch overdue payables total
    const today = new Date().toISOString().split('T')[0];
    const { data: payables } = await supabase
      .from('purchases').select('total_amount, paid_amount')
      .eq('user_id', userId).neq('status', 'paid').lt('due_date', today);

    const overduePayables = (payables || []).reduce((s, p) => {
      return s + Math.max(0, Number(p.total_amount || 0) - Number(p.paid_amount || 0));
    }, 0);

    res.json({
      success:          true,
      expected_inflow:  Math.round(forecast.expected_inflow),
      expected_outflow: Math.round(forecast.expected_outflow),
      net_gap:          Math.round(forecast.expected_inflow - forecast.expected_outflow),
      overdue_payables: Math.round(overduePayables),
    });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

// ── CORTEX: SIMULATE (dry-run rule engine) ───────────────────────────────────
app.post('/api/cortex/simulate', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { eventType, payload = {} } = req.body;
    if (!eventType) return res.status(400).json({ error: 'eventType required' });
    const { simulate } = require('./lib/services/orchestrator/simulationEngine.service');
    const result = await simulate(userId, eventType, payload);
    res.json({ success: true, ...result });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

// ── CORTEX: LIST AVAILABLE TOOLS ─────────────────────────────────────────────
app.get('/api/cortex/tools', authMiddleware, async (req, res) => {
  try {
    const { FLAGS } = require('./lib/featureFlags');
    const { getAvailable } = require('./lib/services/orchestrator/toolRegistry.service');
    const tools = getAvailable(FLAGS);
    res.json({ success: true, tools });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

// ── CORTEX: MEMORY READ ───────────────────────────────────────────────────────
app.get('/api/cortex/memory', authMiddleware, async (req, res) => {
  try {
    const { isEnabled: _isFE } = require('./lib/featureFlags');
    if (!_isFE('memory_enabled')) return res.json({ memories: [] });
    const userId = req.user.userId;
    const { entityType, entityId, key } = req.query;
    let q = supabase.from('business_memory')
      .select('id, entity_type, entity_id, memory_key, memory_value, confidence, source, updated_at')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false })
      .limit(100);
    if (entityType) q = q.eq('entity_type', entityType);
    if (entityId)   q = q.eq('entity_id', entityId);
    if (key)        q = q.eq('memory_key', key);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ success: true, memories: data || [] });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

// ── CORTEX: MEMORY WRITE ──────────────────────────────────────────────────────
app.post('/api/cortex/memory', authMiddleware, async (req, res) => {
  try {
    const { isEnabled: _isFE } = require('./lib/featureFlags');
    if (!_isFE('memory_enabled')) return res.status(403).json({ error: 'memory_enabled flag off' });
    const userId = req.user.userId;
    const { entityType = 'global', entityId = null, key, value, source = 'user_confirmed' } = req.body;
    if (!key || value === undefined) return res.status(400).json({ error: 'key and value required' });
    const { error } = await supabase.from('business_memory').upsert([{
      user_id:      userId,
      entity_type:  entityType,
      entity_id:    entityId,
      memory_key:   key,
      memory_value: typeof value === 'object' ? value : { v: value },
      source,
      updated_at:   new Date().toISOString(),
    }], { onConflict: 'user_id,entity_type,entity_id,memory_key' });
    if (error) throw error;
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

// ── CORTEX: RUN ALL AGENTS (manual trigger / admin) ──────────────────────────
app.post('/api/cortex/run-agents', authMiddleware, async (req, res) => {
  try {
    const { isEnabled: _isFE } = require('./lib/featureFlags');
    if (!_isFE('cortex_enabled')) return res.json({ ran: [], created: 0, message: 'cortex_enabled flag off' });
    const userId = req.user.userId;
    const { agents } = req.body; // optional array of agent names to run
    const { runAllAgents } = require('./lib/services/orchestrator/orchestrator.service');
    const result = await runAllAgents(userId, agents || null);
    res.json({ success: true, ...result });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

// ── CORTEX: HEALTH ────────────────────────────────────────────────────────────
app.get('/api/cortex/health', authMiddleware, async (req, res) => {
  try {
    const { FLAGS } = require('./lib/featureFlags');
    const userId = req.user.userId;

    const [actionsRes, scoresRes, plansRes, evalRes, memRes] = await Promise.all([
      supabase.from('ai_actions').select('priority, status').eq('user_id', userId).in('status', ['pending', 'done']).limit(200),
      supabase.from('customer_scores').select('id', { count: 'exact', head: true }).eq('user_id', userId),
      supabase.from('ai_plans').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('status', 'active'),
      supabase.from('ai_actions').select('outcome').eq('user_id', userId).not('outcome', 'is', null).limit(100),
      supabase.from('business_memory').select('id', { count: 'exact', head: true }).eq('user_id', userId),
    ]);

    const actions     = actionsRes.data  || [];
    const evalActions = evalRes.data     || [];

    const pendingByPriority = { urgent: 0, high: 0, medium: 0, low: 0 };
    actions.filter(a => a.status === 'pending').forEach(a => { pendingByPriority[a.priority] = (pendingByPriority[a.priority] || 0) + 1; });

    const effectiveCount   = evalActions.filter(a => a.outcome === 'effective').length;
    const ineffectiveCount = evalActions.filter(a => a.outcome === 'ineffective').length;
    const effectivenessRate = evalActions.length > 0
      ? Math.round((effectiveCount / evalActions.length) * 100)
      : null;

    res.json({
      success: true,
      flags: FLAGS,
      stats: {
        pending_actions:     actions.filter(a => a.status === 'pending').length,
        pending_by_priority: pendingByPriority,
        customer_scores:     scoresRes.count  || 0,
        active_plans:        plansRes.count   || 0,
        memory_entries:      memRes.count     || 0,
        evaluated_actions:   evalActions.length,
        effectiveness_rate:  effectivenessRate, // null if not enough data
        effective_count:     effectiveCount,
        ineffective_count:   ineffectiveCount,
      },
    });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

// ── BROKEN PROMISE DETECTION CRON — daily 9am IST (3:30 UTC) ────────────────
cron.schedule('30 3 * * *', async () => {
  const { isEnabled: _isFE } = require('./lib/featureFlags');
  if (!_isFE('promise_checker')) return;
  const { safeLog } = require('./lib/observability/logger');
  safeLog('info', '[PromiseCron] Running broken promise detection');
  try {
    const today = new Date().toISOString().split('T')[0];
    const { data: broken, error } = await supabase
      .from('promises')
      .update({ status: 'broken', resolved_at: new Date().toISOString() })
      .eq('status', 'active')
      .lt('promised_date', today)
      .select('id, user_id, customer_id, promised_amount, promised_date');
    if (error) { safeLog('error', '[PromiseCron] Update failed', { error: error.message }); return; }
    if (!broken?.length) { safeLog('info', '[PromiseCron] No broken promises today'); return; }
    safeLog('info', '[PromiseCron] Marked broken', { count: broken.length });
    const { emitBusinessEvent } = require('./lib/events/EventEngine');
    const { recalculate } = require('./lib/services/orchestrator/scoring.service');
    for (const p of broken) {
      try {
        emitBusinessEvent(p.user_id, 'PROMISE_BROKEN', { promiseId: p.id, customer_id: p.customer_id, promised_date: p.promised_date });
        if (_isFE('customer_scoring') && p.customer_id) await recalculate(p.user_id, p.customer_id).catch(() => {});
      } catch (e) { safeLog('error', '[PromiseCron] Per-promise error', { error: e.message, promiseId: p.id }); }
    }
  } catch (err) { safeLog('error', '[PromiseCron] Fatal', { error: err.message }); }
}, { timezone: 'UTC' });

// ── DAILY OWNER BRIEFING CRON — 7am IST (1:30 UTC) ──────────────────────────
cron.schedule('30 1 * * *', async () => {
  const { isEnabled: _isFE } = require('./lib/featureFlags');
  if (!_isFE('cortex_enabled')) return;
  const { safeLog } = require('./lib/observability/logger');
  safeLog('info', '[BriefingCron] Running daily owner briefing');
  try {
    const { data: users } = await supabase.from('users').select('id').limit(500);
    if (!users?.length) return;
    const today = new Date().toISOString().split('T')[0];
    const { create: createAction } = require('./lib/services/orchestrator/action.service');
    for (const user of users) {
      try {
        const [{ data: overdue }, { data: pendingActions }, { data: brokenToday }] = await Promise.all([
          supabase.from('invoices').select('customer_name, invoice_amount, days_overdue').eq('user_id', user.id).eq('payment_status', 'Pending').order('days_overdue', { ascending: false }).limit(3),
          supabase.from('ai_actions').select('id').eq('user_id', user.id).eq('status', 'pending'),
          supabase.from('promises').select('id').eq('user_id', user.id).eq('status', 'broken').gte('resolved_at', today),
        ]);
        const pendingCount = pendingActions?.length || 0;
        if (pendingCount === 0 && !overdue?.length) continue;
        const descParts = [
          overdue?.length ? `Top overdue: ${overdue[0].customer_name} (₹${Number(overdue[0].invoice_amount).toLocaleString('en-IN')}, ${overdue[0].days_overdue}d)` : null,
          brokenToday?.length ? `${brokenToday.length} promise(s) broken today` : null,
          pendingCount ? `${pendingCount} action(s) awaiting review` : null,
        ].filter(Boolean);
        await createAction(user.id, {
          action_type:       'DAILY_OWNER_BRIEFING',
          title:             `Daily Briefing — ${pendingCount} pending action${pendingCount !== 1 ? 's' : ''}`,
          description:       descParts.join(' · '),
          priority:          pendingCount >= 5 ? 'high' : 'medium',
          suggested_by:      'system',
          requires_approval: false,
          risk_level:        'low',
        });
      } catch (e) { safeLog('error', '[BriefingCron] Per-user error', { error: e.message, userId: user.id }); }
    }
    safeLog('info', '[BriefingCron] Done');
  } catch (err) { safeLog('error', '[BriefingCron] Fatal', { error: err.message }); }
}, { timezone: 'UTC' });

// ── AGENTS CRON — daily 7:15am IST (1:45 UTC) — runs after briefing ──────────
cron.schedule('45 1 * * *', async () => {
  const { isEnabled: _isFE } = require('./lib/featureFlags');
  if (!_isFE('cortex_enabled')) return;
  const { safeLog: _log } = require('./lib/observability/logger');
  _log('info', '[AgentsCron] Running all agents');
  try {
    const { runAllAgents } = require('./lib/services/orchestrator/orchestrator.service');
    const { data: users } = await supabase.from('users').select('id').limit(500);
    for (const user of (users || [])) {
      try {
        // Skip briefing (already ran at 7am) and data_quality (weekly)
        await runAllAgents(user.id, ['collections', 'credit_risk', 'cashflow', 'inventory']);
      } catch (e) { _log('error', '[AgentsCron] Per-user error', { error: e.message, userId: user.id }); }
    }
    _log('info', '[AgentsCron] Done');
  } catch (err) { _log('error', '[AgentsCron] Fatal', { error: err.message }); }
}, { timezone: 'UTC' });

// ── EVALUATION CRON — daily 10am IST (4:30 UTC) ─────────────────────────────
cron.schedule('30 4 * * *', async () => {
  const { isEnabled: _isFE } = require('./lib/featureFlags');
  if (!_isFE('cortex_enabled')) return;
  const { safeLog: _log } = require('./lib/observability/logger');
  _log('info', '[EvalCron] Running action effectiveness evaluation');
  try {
    const { run: evalRun } = require('./lib/services/agents/evaluationAgent');
    const { data: users } = await supabase.from('users').select('id').limit(500);
    let totalEvaluated = 0;
    for (const user of (users || [])) {
      try {
        const r = await evalRun(user.id);
        totalEvaluated += r.evaluated || 0;
      } catch {}
    }
    _log('info', '[EvalCron] Done', { totalEvaluated });
  } catch (err) { _log('error', '[EvalCron] Fatal', { error: err.message }); }
}, { timezone: 'UTC' });

// ── DATA QUALITY CRON — weekly Sundays 8am IST (2:30 UTC) ───────────────────
cron.schedule('30 2 * * 0', async () => {
  const { isEnabled: _isFE } = require('./lib/featureFlags');
  if (!_isFE('cortex_enabled')) return;
  const { safeLog: _log } = require('./lib/observability/logger');
  _log('info', '[DataQualityCron] Running weekly data quality scan');
  try {
    const { runAllAgents } = require('./lib/services/orchestrator/orchestrator.service');
    const { data: users } = await supabase.from('users').select('id').limit(500);
    for (const user of (users || [])) {
      try { await runAllAgents(user.id, ['data_quality']); } catch {}
    }
    _log('info', '[DataQualityCron] Done');
  } catch (err) { _log('error', '[DataQualityCron] Fatal', { error: err.message }); }
}, { timezone: 'UTC' });

// ============================================
// START SERVER
// ============================================

// ── Auto-migration on startup ─────────────────────────────────────────────────
async function runAutoMigrations() {
  if (!pgPool) {
    console.log('[migrate] No DATABASE_URL — skipping auto-migration');
    return;
  }
  let client;
  try {
    client = await pgPool.connect();
    await client.query(`
      -- suppliers table (create if missing)
      CREATE TABLE IF NOT EXISTS public.suppliers (
        id            BIGSERIAL PRIMARY KEY,
        user_id       UUID NOT NULL,
        name          TEXT NOT NULL,
        phone         TEXT,
        email         TEXT,
        address       TEXT,
        payment_terms INTEGER DEFAULT 30,
        gstin         TEXT,
        created_at    TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_suppliers_user ON public.suppliers(user_id);
      CREATE INDEX IF NOT EXISTS idx_suppliers_name ON public.suppliers(user_id, name);

      -- khata table (create if missing)
      CREATE TABLE IF NOT EXISTS public.khata_entries (
        id             BIGSERIAL PRIMARY KEY,
        user_id        UUID NOT NULL,
        customer_name  TEXT NOT NULL,
        customer_phone TEXT,
        type           TEXT NOT NULL,
        amount         NUMERIC(14,2) NOT NULL DEFAULT 0,
        payment_mode   TEXT DEFAULT 'cash',
        notes          TEXT,
        entry_date     DATE DEFAULT CURRENT_DATE,
        created_at     TIMESTAMPTZ DEFAULT NOW()
      );
      ALTER TABLE public.khata_entries ADD COLUMN IF NOT EXISTS customer_phone TEXT;
      ALTER TABLE public.khata_entries ADD COLUMN IF NOT EXISTS notes TEXT;
      ALTER TABLE public.khata_entries ADD COLUMN IF NOT EXISTS entry_date DATE DEFAULT CURRENT_DATE;
      CREATE INDEX IF NOT EXISTS idx_khata_user ON public.khata_entries(user_id);
      CREATE INDEX IF NOT EXISTS idx_khata_customer ON public.khata_entries(user_id, customer_name);

      -- ── purchases table (create if missing) ──────────────────────────────
      CREATE TABLE IF NOT EXISTS public.purchases (
        id             BIGSERIAL PRIMARY KEY,
        user_id        UUID        NOT NULL,
        supplier_name  TEXT        NOT NULL,
        amount         NUMERIC(14,2) NOT NULL DEFAULT 0,
        paid_amount    NUMERIC(14,2) NOT NULL DEFAULT 0,
        status         TEXT        NOT NULL DEFAULT 'unpaid',
        purchase_date  DATE        NOT NULL DEFAULT CURRENT_DATE,
        due_date       DATE,
        notes          TEXT,
        description    TEXT,
        category       TEXT        DEFAULT 'material',
        supplier_gstin TEXT,
        bill_number    TEXT,
        supplier_phone TEXT,
        items          JSONB,
        gst_type       TEXT,
        gst_rate       NUMERIC(6,2),
        gst_amount     NUMERIC(14,2),
        cgst_amount    NUMERIC(14,2),
        sgst_amount    NUMERIC(14,2),
        igst_amount    NUMERIC(14,2),
        subtotal       NUMERIC(14,2),
        created_at     TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_purchases_user ON public.purchases(user_id);
      CREATE INDEX IF NOT EXISTS idx_purchases_status ON public.purchases(user_id, status);

      -- sales table (create if missing)
      CREATE TABLE IF NOT EXISTS public.sales (
        id              BIGSERIAL PRIMARY KEY,
        user_id         UUID NOT NULL,
        customer_name   TEXT NOT NULL,
        amount          NUMERIC(14,2) NOT NULL DEFAULT 0,
        paid_amount     NUMERIC(14,2) NOT NULL DEFAULT 0,
        status          TEXT NOT NULL DEFAULT 'unpaid',
        sale_date       DATE NOT NULL DEFAULT CURRENT_DATE,
        due_date        DATE,
        notes           TEXT,
        customer_phone  TEXT,
        customer_gstin  TEXT,
        invoice_number  TEXT,
        items           JSONB,
        gst_type        TEXT,
        gst_rate        NUMERIC(6,2),
        gst_amount      NUMERIC(14,2),
        cgst_amount     NUMERIC(14,2),
        sgst_amount     NUMERIC(14,2),
        igst_amount     NUMERIC(14,2),
        subtotal        NUMERIC(14,2),
        created_at      TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_sales_user ON public.sales(user_id);
      CREATE INDEX IF NOT EXISTS idx_sales_status ON public.sales(user_id, status);

      -- ── purchases: add any missing columns to existing table ─────────────
      ALTER TABLE public.purchases ADD COLUMN IF NOT EXISTS bill_number    TEXT;
      ALTER TABLE public.purchases ADD COLUMN IF NOT EXISTS supplier_phone TEXT;
      ALTER TABLE public.purchases ADD COLUMN IF NOT EXISTS description    TEXT;
      ALTER TABLE public.purchases ADD COLUMN IF NOT EXISTS supplier_gstin TEXT;
      ALTER TABLE public.purchases ADD COLUMN IF NOT EXISTS items          JSONB;
      ALTER TABLE public.purchases ADD COLUMN IF NOT EXISTS gst_type       TEXT;
      ALTER TABLE public.purchases ADD COLUMN IF NOT EXISTS gst_rate       NUMERIC(6,2);
      ALTER TABLE public.purchases ADD COLUMN IF NOT EXISTS gst_amount     NUMERIC(14,2);
      ALTER TABLE public.purchases ADD COLUMN IF NOT EXISTS cgst_amount    NUMERIC(14,2);
      ALTER TABLE public.purchases ADD COLUMN IF NOT EXISTS sgst_amount    NUMERIC(14,2);
      ALTER TABLE public.purchases ADD COLUMN IF NOT EXISTS igst_amount    NUMERIC(14,2);
      ALTER TABLE public.purchases ADD COLUMN IF NOT EXISTS subtotal       NUMERIC(14,2);

      -- sales: add any missing columns to existing table
      ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS customer_phone TEXT;
      ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS customer_gstin TEXT;
      ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS invoice_number TEXT;
      ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS items          JSONB;
      ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS gst_type       TEXT;
      ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS gst_rate       NUMERIC(6,2);
      ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS gst_amount     NUMERIC(14,2);
      ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS cgst_amount    NUMERIC(14,2);
      ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS sgst_amount    NUMERIC(14,2);
      ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS igst_amount    NUMERIC(14,2);
      ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS subtotal       NUMERIC(14,2);

      -- invoices: automation tracking columns
      ALTER TABLE invoices ADD COLUMN IF NOT EXISTS snooze_until       TIMESTAMPTZ;
      ALTER TABLE invoices ADD COLUMN IF NOT EXISTS last_reminder_sent TIMESTAMPTZ;
      ALTER TABLE invoices ADD COLUMN IF NOT EXISTS reminder_count     INTEGER DEFAULT 0;
      ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_link       TEXT;
      ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_link_id    TEXT;

      -- users: verification flags
      ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified  BOOLEAN DEFAULT FALSE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified  BOOLEAN DEFAULT FALSE;

      -- invoices: invoice creation fields
      ALTER TABLE invoices ADD COLUMN IF NOT EXISTS invoice_number TEXT;
      ALTER TABLE invoices ADD COLUMN IF NOT EXISTS due_date       DATE;
      ALTER TABLE invoices ADD COLUMN IF NOT EXISTS items          JSONB;
      ALTER TABLE invoices ADD COLUMN IF NOT EXISTS notes          TEXT;
      ALTER TABLE invoices ADD COLUMN IF NOT EXISTS customer_email TEXT;
      ALTER TABLE invoices ADD COLUMN IF NOT EXISTS customer_gstin TEXT;
      ALTER TABLE invoices ADD COLUMN IF NOT EXISTS source_type    TEXT;
      ALTER TABLE invoices ADD COLUMN IF NOT EXISTS source_id      TEXT;

      -- suppliers: purchase sync fields
      ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS gstin TEXT;

      -- indexes (safe — IF NOT EXISTS)
      CREATE INDEX IF NOT EXISTS idx_inv_snooze        ON invoices(snooze_until)        WHERE snooze_until IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_inv_user_status   ON invoices(user_id, payment_status);
      CREATE INDEX IF NOT EXISTS idx_inv_phone         ON invoices(customer_phone)      WHERE customer_phone IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_inv_source        ON invoices(user_id, source_type, source_id) WHERE source_type IS NOT NULL;

      -- ── activity_logs table (create if missing) ──────────────────────────
      CREATE TABLE IF NOT EXISTS public.activity_logs (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id     UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
        action      TEXT NOT NULL,
        metadata    JSONB DEFAULT '{}',
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_activity_logs_user ON public.activity_logs(user_id);
      CREATE INDEX IF NOT EXISTS idx_activity_logs_created ON public.activity_logs(user_id, created_at DESC);

      -- ── notifications table (create if missing) ─────────────────────────
      CREATE TABLE IF NOT EXISTS public.notifications (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id     UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
        type        TEXT NOT NULL,
        message     TEXT NOT NULL,
        read        BOOLEAN DEFAULT FALSE,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_notifications_user ON public.notifications(user_id);
      CREATE INDEX IF NOT EXISTS idx_notifications_created ON public.notifications(user_id, created_at DESC);
    `);
    await ensureTransactionsTable();
    console.log('[migrate] Auto-migration completed successfully');
  } catch (err) {
    console.error('[migrate] Auto-migration error (non-fatal):', err.message);
  } finally {
    if (client) client.release();
  }
}

// ── PERFORMANCE BOOTSTRAP ROUTES ─────────────────────────────────────────────
app.get('/api/v1/dashboard/bootstrap', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const cacheKey = `user:${userId}:dashboard_bootstrap`;
    
    // Return cached summary if available (30s TTL)
    const cached = CacheService.get(cacheKey);
    if (cached) return res.json(cached);

    // Parallel minimal DB queries for critical summary
    const [
      { count: salesCount, data: salesTotal },
      { count: purchasesCount },
      { count: overdueCount },
      { count: lowStockCount },
      { data: topActions }
    ] = await Promise.all([
      supabase.from('invoices').select('invoice_amount', { count: 'exact' }).eq('user_id', userId).gte('created_at', new Date(new Date().setHours(0,0,0,0)).toISOString()),
      supabase.from('purchases').select('*', { count: 'exact', head: true }).eq('user_id', userId).gte('created_at', new Date(new Date().setHours(0,0,0,0)).toISOString()),
      // Phase 2C.35-P1: canonical overdue predicate — no row is ever stored as 'Overdue'.
      supabase.from('invoices').select('*', { count: 'exact', head: true }).eq('user_id', userId).eq('payment_status', 'Pending').gt('days_overdue', 0),
      supabase.from('products').select('*', { count: 'exact', head: true }).eq('user_id', userId).lt('current_stock', 5), // Simplified low stock query
      supabase.from('ai_actions').select('id, title, priority').eq('user_id', userId).eq('status', 'pending').order('created_at', { ascending: false }).limit(3)
    ]);

    const payload = {
      kpis: {
        todaySales: salesTotal?.reduce((sum, s) => sum + (s.invoice_amount || 0), 0) || 0,
        todayPurchasesCount: purchasesCount || 0,
        overdueInvoicesCount: overdueCount || 0,
        lowStockCount: lowStockCount || 0
      },
      topActions: topActions || [],
      lastUpdated: new Date().toISOString()
    };

    CacheService.set(cacheKey, payload, 30); // 30 second cache
    res.json(payload);
  } catch (err) {
    console.error('[BOOTSTRAP_ERROR]', err);
    res.status(500).json({ error: 'Failed to bootstrap dashboard' });
  }
});

app.get('/api/v1/collections/bootstrap', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const cacheKey = `user:${userId}:collections_bootstrap`;
    const cached = CacheService.get(cacheKey);
    if (cached) return res.json(cached);

    const [
      { data: invoices },
      { data: promises }
    ] = await Promise.all([
      supabase.from('invoices').select('invoice_amount, payment_amount, payment_status, days_overdue, due_date').eq('user_id', userId).not('payment_status', 'eq', 'Paid'),
      supabase.from('promises').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('status', 'broken')
    ]);

    let totalReceivables = 0;
    let overdueAmount = 0;
    let dueToday = 0;
    
    const today = new Date().toISOString().split('T')[0];

    (invoices || []).forEach(inv => {
      // Phase 2C.35-P1: canonical columns (invoice_amount/payment_amount) and the
      // real overdue rule (Pending + days_overdue>0); 'Overdue' is never stored.
      const remaining = (inv.invoice_amount || 0) - (inv.payment_amount || 0);
      totalReceivables += remaining;
      if (inv.payment_status === 'Pending' && Number(inv.days_overdue) > 0) overdueAmount += remaining;
      if (inv.due_date && String(inv.due_date).startsWith(today)) dueToday += remaining;
    });

    const payload = {
      summary: {
        totalReceivables,
        overdueAmount,
        dueToday,
        brokenPromisesCount: promises?.length || 0
      },
      lastUpdated: new Date().toISOString()
    };

    CacheService.set(cacheKey, payload, 45); // 45 second cache
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: 'Failed to bootstrap collections' });
  }
});


// ── CORTEX ASYNC BACKGROUND ──────────────────────────────────────────────────
app.post('/api/v1/cortex/refresh', authMiddleware, async (req, res) => {
  try {
    const { startCortexBackgroundRefresh } = require('./lib/cortex/backgroundJob');
    const userId = req.user.userId;
    const result = await startCortexBackgroundRefresh(userId);
    
    // Invalidate caches immediately so the next request pulls fresh or processing state
    const CacheService = require('./lib/cache/cache.service');
    CacheService.delByPrefix(`user:${userId}:`);
    
    res.status(202).json({ 
      accepted: true, 
      jobId: result.jobId, 
      status: result.status,
      message: "Cortex refresh started in background" 
    });
  } catch (err) {
    console.error('[CORTEX_REFRESH_ERROR]', err);
    res.status(500).json({ error: 'Failed to start Cortex refresh' });
  }
});

app.use(async (err, req, res, next) => {
  if (!err) return next();
  
  if (err instanceof multer.MulterError || err.code === 'UNSUPPORTED_FILE_TYPE') {
    const event = createErrorEvent({
      req, err,
      type: ErrorTaxonomy.FILE_UPLOAD_ERROR,
      severity: 'warn',
      safeMessage: err.code === 'LIMIT_FILE_SIZE' ? 'File is too large' : err.message || 'Invalid upload'
    });
    await logErrorEvent(event, supabase);
    logSecurityEvent(req, SecurityEventTaxonomy.FILE_UPLOAD_REJECTED, { code: err.code });
    return safeErrorResponse(res, event);
  }

  const event = createErrorEvent({
    req, err,
    type: ErrorTaxonomy.SERVER_ERROR,
    severity: 'error',
    safeMessage: 'Internal server error'
  });
  
  await logErrorEvent(event, supabase);
  safeErrorResponse(res, event);
});

// ── ATLAS AGENT REGISTRY — Read-only API (Phase 1) ───────────────────────────
// GET /api/agents/registry        — list core_public agents from registry table
// GET /api/agents/registry/:id    — single agent definition
// Feature-gated: FEATURE_AGENT_REGISTRY_API_ENABLED must be true
// No write endpoints. No agent execution. Registry metadata only.

app.get('/api/agents/registry', authMiddleware, async (req, res) => {
  try {
    const { isEnabled: _fe } = require('./lib/featureFlags');
    if (!_fe('agent_registry_api_enabled')) return res.status(404).json({ error: 'Not found' });
    const pool = getPool();
    const result = await pool.query(
      `SELECT agent_id, name, layer, squad, mission, business_function,
              risk_level, approval_required, status, public_claim_status,
              feature_flag, is_active, success_metric, tools_required,
              audit_events, harness_scenarios, created_at
       FROM agent_registry
       WHERE public_claim_status = 'core_public'
       ORDER BY layer ASC, name ASC`
    );
    res.json({
      success: true,
      count: result.rows.length,
      agents: result.rows,
      public_claim: '12 core specialized agents with an expandable Agent Mesh architecture.',
    });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

app.get('/api/agents/registry/:agentId', authMiddleware, async (req, res) => {
  try {
    const { isEnabled: _fe } = require('./lib/featureFlags');
    if (!_fe('agent_registry_api_enabled')) return res.status(404).json({ error: 'Not found' });
    const { agentId } = req.params;
    if (!/^[a-z_]+\.[a-z_]+$/.test(agentId)) {
      return res.status(400).json({ error: 'Invalid agent ID format' });
    }
    const pool = getPool();
    const result = await pool.query(
      `SELECT agent_id, name, layer, squad, mission, business_function,
              trigger_events, input_schema, tools_required, output_schema,
              risk_level, policy_rules, approval_required, audit_events,
              success_metric, cost_budget, harness_scenarios,
              feature_flag, status, fallback_behavior, public_claim_status,
              is_active, created_at, updated_at
       FROM agent_registry
       WHERE agent_id = $1 AND public_claim_status = 'core_public'`,
      [agentId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Agent not found' });
    res.json({ success: true, agent: result.rows[0] });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

// ── DATA QUALITY AGENT PREVIEW — Phase 2A ────────────────────────────────────
// GET /api/agents/core.data_quality/preview
// Read-only preview of data quality findings for the authenticated owner.
// No mutations. Rust sidecar required; falls back to safe empty response.
// Feature-gated: FEATURE_DATA_QUALITY_AGENT_ENABLED must be true.
// DO NOT call the existing cron dataQualityAgent.js here — it mutates DB.

app.get('/api/agents/core.data_quality/preview', authMiddleware, async (req, res) => {
  try {
    const { isEnabled: _fe } = require('./lib/featureFlags');
    if (!_fe('data_quality_agent_enabled')) return res.status(404).json({ error: 'Not found' });

    const { evaluateDataQualityRust } = require('./lib/services/rustAutomation/dataQualityAgentClient');
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const result = await evaluateDataQualityRust(token);

    if (result) return res.json(result);

    // Rust sidecar unavailable — safe empty response (no mutations)
    return res.json({
      success: true,
      agent_id: 'core.data_quality',
      status: 'preview_unavailable',
      message: 'Data quality preview requires the Rust automation service. ' +
               'Ensure RUST_AUTOMATION_BASE_URL is set and the sidecar is running.',
      findings: [],
      total_findings: 0,
      checks_run: [],
      warnings: ['Rust sidecar unavailable'],
    });
  } catch (err) {
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── COST ROUTER AGENT — Phase 2C ─────────────────────────────────────────────
// POST /api/agents/core.cost_router/evaluate
// Read-only routing decision. No DB queries. No mutations. No LLM calls.
// Conservative fallback: Rust unavailable → require_approval (not hard block).
// Feature-gated: FEATURE_COST_ROUTER_AGENT_ENABLED must be true.

app.post('/api/agents/core.cost_router/evaluate', authMiddleware, async (req, res) => {
  try {
    const { isEnabled: _fe } = require('./lib/featureFlags');
    if (!_fe('cost_router_agent_enabled')) return res.status(404).json({ error: 'Not found' });

    const { evaluateCostRouterRust } = require('./lib/services/rustAutomation/costRouterAgentClient');
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const body  = req.body || {};
    const result = await evaluateCostRouterRust(body, token);

    // result is always an object (conservative fallback — never null)
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POLICY GUARD AGENT — Phase 2B ────────────────────────────────────────────
// POST /api/agents/core.policy_guard/evaluate
// Read-only policy evaluation. No DB queries. No mutations. No LLM calls.
// Fail-closed: if Rust sidecar unavailable, returns blocked=true (POLICY_GUARD_UNAVAILABLE).
// Feature-gated: FEATURE_POLICY_GUARD_AGENT_ENABLED must be true.

app.post('/api/agents/core.policy_guard/evaluate', authMiddleware, async (req, res) => {
  try {
    const { isEnabled: _fe } = require('./lib/featureFlags');
    if (!_fe('policy_guard_agent_enabled')) return res.status(404).json({ error: 'Not found' });

    const { evaluatePolicyGuardRust } = require('./lib/services/rustAutomation/policyGuardAgentClient');
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const body  = req.body || {};
    const result = await evaluatePolicyGuardRust(body, token);

    // result is always an object (fail-closed — never null)
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// -------------------------------------------------------------------------
// 🤖 OWNER BRIEFING AGENT PREVIEW — Phase 2C.6
// -------------------------------------------------------------------------
// GET /api/agents/core.owner_briefing/preview
// Read-only aggregation of business signals for the authenticated owner.
// No mutations. No LLM calls. Rust sidecar required; falls back to safe empty response.
// Feature-gated: FEATURE_OWNER_BRIEFING_AGENT_ENABLED must be true.

app.get('/api/agents/core.owner_briefing/preview', authMiddleware, async (req, res) => {
  try {
    const { isEnabled: _fe } = require('./lib/featureFlags');
    if (!_fe('owner_briefing_agent_enabled')) return res.status(404).json({ error: 'Not found' });

    const { evaluateOwnerBriefingRust } = require('./lib/services/rustAutomation/ownerBriefingAgentClient');
    const auditService = require('./lib/services/orchestrator/audit.service');
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    // Phase 2C.35-P1: JWT signs { userId }; the bare .id claim is undefined.
    // Use the canonical helper and fail closed so the briefing is attributed and audited.
    const userId = authenticatedUserId(req);
    if (!userId) return res.status(401).json({ error: 'Invalid token payload' });

    const input = {
      briefing_date: new Date().toISOString(),
      max_items_per_section: 5
    };

    const result = await evaluateOwnerBriefingRust(input, token, userId);
    const isFallback = result.audit_context === 'fallback_empty_briefing';
    const ec = result.evidence_contract;

    // Fire-and-forget audit log — never block the response
    auditService.log(userId, {
      action: 'AGENT_PREVIEW',
      entityType: 'agent',
      entityId: 'core.owner_briefing',
      newValue: {
        endpoint:             '/api/agents/core.owner_briefing/preview',
        agent_name:           'core.owner_briefing',
        briefing_id:          ec?.briefing_id || null,
        timestamp:            new Date().toISOString(),
        result_status:        result.status || 'unknown',
        path:                 isFallback ? 'fallback' : 'rust',
        // Evidence contract audit fields
        claim_count:          ec?.claims?.length ?? 0,
        safe_claim_count:     ec?.claims?.filter(c => c.safe_to_show_claim)?.length ?? 0,
        blocked_claim_count:  ec?.blocked_claim_count ?? 0,
        evidence_count:       ec?.evidence?.length ?? 0,
        evidence_source_ids:  ec?.evidence_source_ids ?? [],
        confidence:           ec?.confidence ?? 0,
        safe_to_show:         ec?.safe_to_show ?? false,
        fallback_reason:      ec?.fallback_reason ?? null,
        blocked_reasons:      ec?.claims?.filter(c => c.blocked_reason).map(c => c.blocked_reason) ?? [],
        contract_version:     ec?.contract_version ?? null,
      },
      ...auditService.fromRequest(req),
    }).catch(() => {});

    res.json(result);
  } catch (error) {
    console.error('Owner Briefing Agent preview error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// -------------------------------------------------------------------------
// 🛰️ ATLAS RUNTIME TRUTH — Read-only honest capability snapshot — Phase 2C.21
// -------------------------------------------------------------------------
// GET /api/atlas/runtime-truth
// Tells frontend/agents EXACTLY what is real, proven, limited, planned, or
// blocked. Built from a static registry + safety-flag booleans.
// No DB. No mutations. No LLM calls. No secrets/PII/env values.
// Counts / booleans / status only. Atlas must never fake live capability.
// Feature-gated: FEATURE_RUNTIME_TRUTH_API_ENABLED must be true.

app.get('/api/atlas/runtime-truth', authMiddleware, async (req, res) => {
  try {
    const { isEnabled: _fe } = require('./lib/featureFlags');
    if (!_fe('runtime_truth_api_enabled')) return res.status(404).json({ error: 'Not found' });

    const { buildRuntimeTruth } = require('./lib/services/runtimeTruth.service');
    const truth = buildRuntimeTruth({ generatedAt: new Date().toISOString() });

    return res.json(truth);
  } catch (err) {
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// -------------------------------------------------------------------------
// ATLAS PACK REGISTRY — Read-only Atlas Pack Civilization Layer truth — Phase 2C.26
// -------------------------------------------------------------------------
// GET /api/atlas/packs        — full read-only pack-registry truth (counts + packs)
// GET /api/atlas/packs/:id    — single pack truth
// READ-ONLY: no execution, no activation, no production sync, no external send.
// No DB. No mutations. No LLM calls. No secrets/PII/env values.
// Counts / booleans / status / labels only. Atlas must never fake live capability.
// No POST/PATCH/DELETE. Feature-gated: FEATURE_ATLAS_PACK_REGISTRY_API_ENABLED (default OFF).

app.get('/api/atlas/packs', authMiddleware, async (req, res) => {
  try {
    const { isEnabled: _fe } = require('./lib/featureFlags');
    if (!_fe('atlas_pack_registry_api_enabled')) return res.status(404).json({ error: 'Not found' });

    const { buildAtlasPackRegistryTruth } = require('./lib/services/atlasPackRegistry.service');
    const truth = buildAtlasPackRegistryTruth({ generatedAt: new Date().toISOString() });

    return res.json(truth);
  } catch (err) {
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/atlas/packs/:id', authMiddleware, async (req, res) => {
  try {
    const { isEnabled: _fe } = require('./lib/featureFlags');
    if (!_fe('atlas_pack_registry_api_enabled')) return res.status(404).json({ error: 'Not found' });

    const { id } = req.params;
    if (!/^[a-z0-9_]+$/.test(id)) return res.status(400).json({ error: 'Invalid pack ID format' });

    const { getAtlasPackById } = require('./lib/services/atlasPackRegistry.service');
    const pack = getAtlasPackById(id);
    if (!pack) return res.status(404).json({ error: 'Pack not found' });

    return res.json({ success: true, pack });
  } catch (err) {
    return res.status(500).json({ error: 'Internal server error' });
  }
});
// END ATLAS PACK REGISTRY (Phase 2C.26)

// -------------------------------------------------------------------------
// ATLAS WORKFLOW REGISTRY — Read-only Atlas business-process layer — Phase 2C.27
// -------------------------------------------------------------------------
// GET /api/atlas/workflows        — full read-only workflow-registry truth (counts + workflows)
// GET /api/atlas/workflows/:id     — single workflow truth
// READ-ONLY: no execution, no activation, no production sync, no external send, no DB write.
// No DB. No mutations. No LLM calls. No secrets/PII/env values.
// Counts / booleans / status / labels only. Atlas must never fake live capability.
// No POST/PATCH/DELETE. Feature-gated: FEATURE_ATLAS_WORKFLOW_REGISTRY_API_ENABLED (default OFF).

app.get('/api/atlas/workflows', authMiddleware, async (req, res) => {
  try {
    const { isEnabled: _fe } = require('./lib/featureFlags');
    if (!_fe('atlas_workflow_registry_api_enabled')) return res.status(404).json({ error: 'Not found' });

    const { buildAtlasWorkflowRegistryTruth } = require('./lib/services/atlasWorkflowRegistry.service');
    const truth = buildAtlasWorkflowRegistryTruth({ generatedAt: new Date().toISOString() });

    return res.json(truth);
  } catch (err) {
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/atlas/workflows/:id', authMiddleware, async (req, res) => {
  try {
    const { isEnabled: _fe } = require('./lib/featureFlags');
    if (!_fe('atlas_workflow_registry_api_enabled')) return res.status(404).json({ error: 'Not found' });

    const { id } = req.params;
    if (!/^[a-z0-9_]+$/.test(id)) return res.status(400).json({ error: 'Invalid workflow ID format' });

    const { getAtlasWorkflowById } = require('./lib/services/atlasWorkflowRegistry.service');
    const workflow = getAtlasWorkflowById(id);
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' });

    return res.json({ success: true, workflow });
  } catch (err) {
    return res.status(500).json({ error: 'Internal server error' });
  }
});
// END ATLAS WORKFLOW REGISTRY (Phase 2C.27)

// -------------------------------------------------------------------------
// BEGIN ATLAS AGENT UNIVERSE (Phase 2C.28) — Read-only Atlas Agent Universe truth
// -------------------------------------------------------------------------
// GET /api/atlas/agents        — full read-only agent-registry truth (counts + agents)
// GET /api/atlas/agents/:id    — single agent truth
// READ-ONLY: no execution, no activation, no production enablement, no external send,
// no production sync, no DB write. is_implemented/harness_verified are facts only.
// No DB. No mutations. No LLM calls. No secrets/PII/env values.
// Counts / booleans / status / labels only. Atlas must never fake live capability or
// claim that hundreds of agents are live. Canonical Atlas-truth agents route (sibling of
// /api/atlas/packs and /api/atlas/workflows); distinct from the DB-backed
// /api/agents/registry operational route, which it does not modify or replace.
// No POST/PATCH/DELETE. Feature-gated: FEATURE_ATLAS_AGENT_REGISTRY_API_ENABLED (default OFF).

app.get('/api/atlas/agents', authMiddleware, async (req, res) => {
  try {
    const { isEnabled: _fe } = require('./lib/featureFlags');
    if (!_fe('atlas_agent_registry_api_enabled')) return res.status(404).json({ error: 'Not found' });

    const { buildAtlasAgentRegistryTruth } = require('./lib/services/atlasAgentRegistry.service');
    const truth = buildAtlasAgentRegistryTruth({ generatedAt: new Date().toISOString() });

    return res.json(truth);
  } catch (err) {
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/atlas/agents/:id', authMiddleware, async (req, res) => {
  try {
    const { isEnabled: _fe } = require('./lib/featureFlags');
    if (!_fe('atlas_agent_registry_api_enabled')) return res.status(404).json({ error: 'Not found' });

    const { id } = req.params;
    if (!/^[a-z0-9_.]+$/.test(id)) return res.status(400).json({ error: 'Invalid agent ID format' });

    const { getAtlasAgentById } = require('./lib/services/atlasAgentRegistry.service');
    const agent = getAtlasAgentById(id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    return res.json({ success: true, agent });
  } catch (err) {
    return res.status(500).json({ error: 'Internal server error' });
  }
});
// END ATLAS AGENT UNIVERSE (Phase 2C.28)

// -------------------------------------------------------------------------
// BEGIN ATLAS RELATIONSHIP GRAPH (Phase 2C.29) — Read-only Pack/Agent/Workflow topology
// -------------------------------------------------------------------------
// GET /api/atlas/relationship-graph            — full read-only graph truth (nodes + edges + counts)
// GET /api/atlas/relationship-graph/nodes/:id  — single node + FIRST-DEGREE adjacency only
// READ-ONLY: no execution, no activation, no production access, no external send, no
// production sync, no DB write, no recursion, no pathfinding, no /paths, no caller-
// controlled depth. Counts are registry TOPOLOGY counts, not live-capability metrics.
// No DB. No mutations. No LLM calls. No secrets/PII/env values. No POST/PATCH/PUT/DELETE.
// Feature-gated: FEATURE_ATLAS_RELATIONSHIP_GRAPH_API_ENABLED (default OFF).

app.get('/api/atlas/relationship-graph', authMiddleware, async (req, res) => {
  try {
    const { isEnabled: _fe } = require('./lib/featureFlags');
    if (!_fe('atlas_relationship_graph_api_enabled')) return res.status(404).json({ error: 'Not found' });

    const { buildAtlasRelationshipGraphTruth } = require('./lib/services/atlasRelationshipGraph.service');
    const truth = buildAtlasRelationshipGraphTruth({ generatedAt: new Date().toISOString() });

    return res.json(truth);
  } catch (err) {
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/atlas/relationship-graph/nodes/:id', authMiddleware, async (req, res) => {
  try {
    const { isEnabled: _fe } = require('./lib/featureFlags');
    if (!_fe('atlas_relationship_graph_api_enabled')) return res.status(404).json({ error: 'Not found' });

    const { id } = req.params;
    if (!/^[a-z]+:[a-z0-9_.]+$/.test(id)) return res.status(400).json({ error: 'Invalid node ID format' });

    const { getAtlasRelationshipGraphNodeById } = require('./lib/services/atlasRelationshipGraph.service');
    const node = getAtlasRelationshipGraphNodeById(id);
    if (!node) return res.status(404).json({ error: 'Node not found' });

    return res.json({ success: true, ...node });
  } catch (err) {
    return res.status(500).json({ error: 'Internal server error' });
  }
});
// END ATLAS RELATIONSHIP GRAPH (Phase 2C.29)

// -------------------------------------------------------------------------
// BEGIN ATLAS ACTION APPROVAL (Phase 2C.30) — Read-only approval-requirement contract
// -------------------------------------------------------------------------
// GET /api/atlas/action-approvals       — full read-only approval-requirement truth
// GET /api/atlas/action-approvals/:id    — single approval contract
// READ-ONLY: describes what approval WOULD be required. It does NOT request, grant,
// deny, record, queue, or execute approvals. No approve/reject/request/decide/execute/
// activate/send/sync/deploy. No DB write, no mutation, no external send, no auto-approve.
// Counts are approval REQUIREMENTS, not an operational queue or granted approvals.
// No POST/PATCH/PUT/DELETE. Distinct from the operational AI Action Center
// (/api/ai-actions/*), which this phase does not modify. No secrets/PII/approver ids.
// Feature-gated: FEATURE_ATLAS_ACTION_APPROVAL_API_ENABLED (default OFF).

app.get('/api/atlas/action-approvals', authMiddleware, async (req, res) => {
  try {
    const { isEnabled: _fe } = require('./lib/featureFlags');
    if (!_fe('atlas_action_approval_api_enabled')) return res.status(404).json({ error: 'Not found' });

    const { buildAtlasActionApprovalTruth } = require('./lib/services/atlasActionApprovalRegistry.service');
    const truth = buildAtlasActionApprovalTruth({ generatedAt: new Date().toISOString() });

    return res.json(truth);
  } catch (err) {
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/atlas/action-approvals/:id', authMiddleware, async (req, res) => {
  try {
    const { isEnabled: _fe } = require('./lib/featureFlags');
    if (!_fe('atlas_action_approval_api_enabled')) return res.status(404).json({ error: 'Not found' });

    const { id } = req.params;
    if (!/^[a-z0-9_.]+$/.test(id)) return res.status(400).json({ error: 'Invalid contract ID format' });

    const { getAtlasActionApprovalContractById } = require('./lib/services/atlasActionApprovalRegistry.service');
    const contract = getAtlasActionApprovalContractById(id);
    if (!contract) return res.status(404).json({ error: 'Contract not found' });

    return res.json({ success: true, contract });
  } catch (err) {
    return res.status(500).json({ error: 'Internal server error' });
  }
});
// END ATLAS ACTION APPROVAL (Phase 2C.30)

app.listen(PORT, () => {
  console.log(`✅ Vantro Flow Backend running on port ${PORT}`);
  console.log(`📝 API Base URL: http://localhost:${PORT}`);
  runAutoMigrations();
});
