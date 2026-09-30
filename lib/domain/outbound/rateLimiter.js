'use strict';
// lib/domain/outbound/rateLimiter.js
// Distributed, hierarchical rate limiting in Postgres.
//
// A send is allowed only when EVERY applicable limit allows it:
//   GLOBAL ∩ PROVIDER ∩ ACCOUNT ∩ TENANT ∩ CAMPAIGN ∩ RECIPIENT DOMAIN
// Each limit is three things, all optional:
//   - a token bucket (capacity = burst, refill = per_minute/60, or
//     per_hour/3600 when no per-minute rate is set) for smooth spacing;
//   - an hourly fixed-window ceiling;
//   - a daily fixed-window ceiling (UTC day).
// Account limits also carry a concurrency cap (jobs in SENDING with a live
// lease) and the account's warm-up schedule and adaptive throttle factor.
//
// State lives in outbound_rate_buckets / outbound_rate_windows and is
// changed only inside the caller's transaction with row locks taken in a
// fixed order, so several workers on several instances share one budget and
// cannot deadlock. Either every limit is consumed or none is.
//
// Configuration precedence (first match wins, no deploy needed):
//   tenant row (exact key) > tenant row ('*') > global row (exact key)
//   > global row ('*') > OUTBOUND_RATE_DEFAULTS env JSON > code defaults.
// Unknown services get the most conservative default.

const SCOPES = ['GLOBAL', 'PROVIDER', 'ACCOUNT', 'TENANT', 'CAMPAIGN', 'DOMAIN'];

const CODE_DEFAULTS = {
  email: {
    GLOBAL: { perMinute: 20, perHour: 600, perDay: 5000, burst: 5 },
    PROVIDER: { perMinute: 10, perHour: 300, perDay: 1500, burst: 3 },
    ACCOUNT: { perMinute: 1, perHour: 20, perDay: 40, burst: 1, concurrency: 1 },
    TENANT: { perMinute: 2, perHour: 40, perDay: 200, burst: 2 },
    CAMPAIGN: { perMinute: 1, perHour: 20, perDay: 20, burst: 1 },
    DOMAIN: { perMinute: null, perHour: 2, perDay: 3, burst: 1 },
  },
  verification: { GLOBAL: { perMinute: 30, perHour: 600, perDay: 5000, burst: 5 }, TENANT: { perMinute: 10, perHour: 200, perDay: 1000, burst: 3 } },
  research: { GLOBAL: { perMinute: 10, perHour: 200, perDay: 1000, burst: 2 }, TENANT: { perMinute: 5, perHour: 100, perDay: 400, burst: 2 } },
  model: { GLOBAL: { perMinute: 20, perHour: 400, perDay: 3000, burst: 3 }, TENANT: { perMinute: 5, perHour: 100, perDay: 600, burst: 2 } },
};
const UNKNOWN_DEFAULT = { perMinute: 1, perHour: 20, perDay: 100, burst: 1, concurrency: 1 };

function envDefaults() {
  try { return process.env.OUTBOUND_RATE_DEFAULTS ? JSON.parse(process.env.OUTBOUND_RATE_DEFAULTS) : {}; } catch { return {}; }
}

function rowToPolicy(r) {
  return {
    perMinute: r.per_minute == null ? null : Number(r.per_minute),
    perHour: r.per_hour == null ? null : Number(r.per_hour),
    perDay: r.per_day == null ? null : Number(r.per_day),
    burst: r.burst == null ? null : Number(r.burst),
    concurrency: r.concurrency == null ? null : Number(r.concurrency),
    source: r.user_id ? 'tenant' : 'global',
  };
}

/**
 * Resolves the effective policy for each (scope, key). `targets` is a list of
 * { scope, key }. Returns a map "SCOPE:key" -> policy with `source`.
 */
async function resolvePolicies(db, userId, service, targets) {
  const res = await db.query(
    `SELECT * FROM outbound_rate_policies
      WHERE enabled AND service = $1 AND (user_id IS NULL OR user_id = $2)`,
    [service, userId]
  );
  const env = envDefaults()[service] || {};
  const code = CODE_DEFAULTS[service] || {};
  const out = {};
  for (const t of targets) {
    const rows = res.rows.filter((r) => r.scope === t.scope);
    const pick = rows.find((r) => r.user_id === userId && r.scope_key === t.key)
      || rows.find((r) => r.user_id === userId && r.scope_key === '*')
      || rows.find((r) => !r.user_id && r.scope_key === t.key)
      || rows.find((r) => !r.user_id && r.scope_key === '*');
    let policy;
    if (pick) policy = rowToPolicy(pick);
    else if (env[t.scope]) policy = { ...UNKNOWN_DEFAULT, ...env[t.scope], source: 'env' };
    else if (code[t.scope]) policy = { concurrency: null, ...code[t.scope], source: 'default' };
    else policy = { ...UNKNOWN_DEFAULT, source: 'conservative-unknown' };
    out[`${t.scope}:${t.key}`] = policy;
  }
  return out;
}

function warmupCap(account, now) {
  const schedule = Array.isArray(account.warmup_schedule) ? account.warmup_schedule.map(Number).filter((n) => n >= 0) : [];
  if (!account.warmup_started_on || !schedule.length) return Number(account.daily_max);
  const w = account.warmup_started_on;
  // pg returns DATE as a local-midnight Date; read its calendar day.
  const ymd = w instanceof Date ? `${w.getFullYear()}-${String(w.getMonth() + 1).padStart(2, '0')}-${String(w.getDate()).padStart(2, '0')}` : String(w).slice(0, 10);
  const start = Date.parse(`${ymd}T00:00:00Z`);
  const day = Math.max(0, Math.floor((now.getTime() - start) / 86400000));
  const cap = day < schedule.length ? schedule[day] : Infinity;
  return Math.min(Number(account.daily_max), cap);
}

/**
 * The full limit set for one email send. The account's daily cap is the
 * smaller of its policy, daily_max and today's warm-up step; the campaign's
 * daily cap is its daily_budget; the account's throttle_factor (lowered by
 * adaptive throttling) scales the account's rates down.
 */
async function emailLimits(db, { userId, account, campaign, domain, now = new Date() }) {
  const targets = [
    { scope: 'GLOBAL', key: '*' },
    { scope: 'PROVIDER', key: account.provider },
    { scope: 'ACCOUNT', key: account.id },
    { scope: 'TENANT', key: userId },
    { scope: 'CAMPAIGN', key: campaign ? campaign.id : 'none' },
    { scope: 'DOMAIN', key: domain },
  ];
  const pol = await resolvePolicies(db, userId, 'email', targets);
  const f = Math.min(1, Math.max(0.05, Number(account.throttle_factor || 1)));
  const specs = [];
  for (const t of targets) {
    const p = { ...pol[`${t.scope}:${t.key}`] };
    if (t.scope === 'ACCOUNT') {
      const cap = warmupCap(account, now);
      p.perDay = p.perDay == null ? cap : Math.min(p.perDay, cap);
      if (f < 1) {
        if (p.perMinute != null) p.perMinute *= f;
        if (p.perHour != null) p.perHour = Math.floor(p.perHour * f);
        p.perDay = Math.floor(p.perDay * f);
      }
    }
    if (t.scope === 'CAMPAIGN' && campaign) p.perDay = p.perDay == null ? Number(campaign.daily_budget) : Math.min(p.perDay, Number(campaign.daily_budget));
    // Global and provider rows are shared by every tenant; the rest are
    // namespaced by tenant so one tenant can never spend another's budget.
    const ns = ['GLOBAL', 'PROVIDER'].includes(t.scope) ? '' : `${userId}:`;
    specs.push({ scope: t.scope, key: t.key, bucketKey: `email:${t.scope}:${ns}${t.key}`, ...p });
  }
  return specs;
}

function hourStart(now) { const d = new Date(now); d.setUTCMinutes(0, 0, 0); return d; }
function dayStart(now) { const d = new Date(now); d.setUTCHours(0, 0, 0, 0); return d; }

/**
 * Atomically checks and (if every limit allows) consumes one unit from each
 * spec. MUST run inside a transaction on `client`. Returns
 * { ok: true } or { ok: false, waitMs, blockedBy: [{scope, key, limit}] }.
 * `concurrencyCheck(spec)` is called with the row locks held.
 */
async function acquire(client, specs, { now = new Date(), concurrencyCheck = null, consume = true } = {}) {
  const ordered = [...specs].sort((a, b) => (a.bucketKey < b.bucketKey ? -1 : a.bucketKey > b.bucketKey ? 1 : 0));
  const blocked = [];
  const plan = [];
  for (const s of ordered) {
    // Token bucket.
    const rate = s.perMinute != null ? s.perMinute / 60 : s.perHour != null ? s.perHour / 3600 : null;
    if (rate != null) {
      const capacity = Math.max(1, Number(s.burst || 1));
      if (rate <= 0) { blocked.push({ scope: s.scope, key: s.key, limit: 'rate_zero', waitMs: 3600000 }); continue; }
      await client.query(
        `INSERT INTO outbound_rate_buckets (bucket_key, tokens, capacity, refill_per_sec, updated_at) VALUES ($1,$2,$2,$3,$4)
         ON CONFLICT (bucket_key) DO NOTHING`,
        [s.bucketKey, capacity, rate, now]
      );
      const r = await client.query('SELECT tokens, updated_at FROM outbound_rate_buckets WHERE bucket_key = $1 FOR UPDATE', [s.bucketKey]);
      const elapsed = Math.max(0, (now.getTime() - new Date(r.rows[0].updated_at).getTime()) / 1000);
      const tokens = Math.min(capacity, Number(r.rows[0].tokens) + elapsed * rate);
      if (tokens < 1) blocked.push({ scope: s.scope, key: s.key, limit: 'bucket', waitMs: Math.ceil(((1 - tokens) / rate) * 1000) });
      plan.push({ kind: 'bucket', key: s.bucketKey, tokens, capacity, rate });
    }
    for (const [gran, max, start, next] of [
      ['HOUR', s.perHour, hourStart(now), 3600000],
      ['DAY', s.perDay, dayStart(now), 86400000],
    ]) {
      if (max == null) continue;
      await client.query(
        `INSERT INTO outbound_rate_windows (bucket_key, granularity, window_start, used) VALUES ($1,$2,$3,0)
         ON CONFLICT DO NOTHING`,
        [s.bucketKey, gran, start]
      );
      const w = await client.query('SELECT used FROM outbound_rate_windows WHERE bucket_key=$1 AND granularity=$2 AND window_start=$3 FOR UPDATE', [s.bucketKey, gran, start]);
      if (Number(w.rows[0].used) >= Number(max)) {
        blocked.push({ scope: s.scope, key: s.key, limit: gran === 'HOUR' ? 'per_hour' : 'per_day', waitMs: start.getTime() + next - now.getTime() });
      }
      plan.push({ kind: 'window', key: s.bucketKey, gran, start });
    }
    if (s.concurrency != null && concurrencyCheck) {
      const inFlight = await concurrencyCheck(s);
      if (inFlight >= s.concurrency) blocked.push({ scope: s.scope, key: s.key, limit: 'concurrency', waitMs: 15000 });
    }
  }
  if (blocked.length) {
    return { ok: false, waitMs: Math.max(...blocked.map((b) => b.waitMs)), blockedBy: blocked };
  }
  if (consume) {
    for (const p of plan) {
      if (p.kind === 'bucket') {
        await client.query('UPDATE outbound_rate_buckets SET tokens = $2, capacity = $3, refill_per_sec = $4, updated_at = $5 WHERE bucket_key = $1', [p.key, p.tokens - 1, p.capacity, p.rate, now]);
      } else {
        await client.query('UPDATE outbound_rate_windows SET used = used + 1 WHERE bucket_key=$1 AND granularity=$2 AND window_start=$3', [p.key, p.gran, p.start]);
      }
    }
  }
  return { ok: true };
}

/**
 * Limiter for non-email external calls (verification, research, model).
 * Runs its own short transaction. Returns the same shape as acquire().
 */
async function acquireService(pool, userId, service, { now = new Date() } = {}) {
  const pol = await resolvePolicies(pool, userId, service, [{ scope: 'GLOBAL', key: '*' }, { scope: 'TENANT', key: userId }]);
  const specs = [
    { scope: 'GLOBAL', key: '*', bucketKey: `${service}:GLOBAL:*`, ...pol['GLOBAL:*'] },
    { scope: 'TENANT', key: userId, bucketKey: `${service}:TENANT:${userId}`, ...pol[`TENANT:${userId}`] },
  ];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await acquire(client, specs, { now });
    await client.query('COMMIT');
    return r;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Read-only view of remaining budget per limit (for the dashboard).
 */
async function budgetView(db, specs, now = new Date()) {
  const out = [];
  for (const s of specs) {
    const row = { scope: s.scope, key: s.key, perMinute: s.perMinute, perHour: s.perHour, perDay: s.perDay, burst: s.burst, concurrency: s.concurrency ?? null, source: s.source };
    if (s.perDay != null) {
      const r = await db.query("SELECT used FROM outbound_rate_windows WHERE bucket_key=$1 AND granularity='DAY' AND window_start=$2", [s.bucketKey, dayStart(now)]);
      row.usedToday = Number(r.rows[0]?.used || 0);
      row.remainingToday = Math.max(0, s.perDay - row.usedToday);
    }
    if (s.perHour != null) {
      const r = await db.query("SELECT used FROM outbound_rate_windows WHERE bucket_key=$1 AND granularity='HOUR' AND window_start=$2", [s.bucketKey, hourStart(now)]);
      row.usedThisHour = Number(r.rows[0]?.used || 0);
    }
    out.push(row);
  }
  return out;
}

async function setTenantPolicy(pool, userId, input, actorId) {
  const service = String(input.service || 'email');
  const scope = String(input.scope || '');
  if (!['ACCOUNT', 'TENANT', 'CAMPAIGN', 'DOMAIN'].includes(scope)) throw Object.assign(new Error('tenant policies can set ACCOUNT, TENANT, CAMPAIGN or DOMAIN scope; GLOBAL and PROVIDER are operator settings'), { status: 400 });
  const num = (v, max) => {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > max) throw Object.assign(new Error(`limit out of range (0..${max})`), { status: 400 });
    return n;
  };
  const key = scope === 'TENANT' ? userId : String(input.scopeKey || '*').slice(0, 200);
  const vals = [num(input.perMinute, 60), num(input.perHour, 2000), num(input.perDay, 10000), num(input.burst, 20), num(input.concurrency, 10)];
  const r = await pool.query(
    `INSERT INTO outbound_rate_policies (user_id, service, scope, scope_key, per_minute, per_hour, per_day, burst, concurrency, enabled, updated_by, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,TRUE,$10,NOW())
     ON CONFLICT (COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid), service, scope, scope_key)
     DO UPDATE SET per_minute=EXCLUDED.per_minute, per_hour=EXCLUDED.per_hour, per_day=EXCLUDED.per_day, burst=EXCLUDED.burst,
                   concurrency=EXCLUDED.concurrency, enabled=TRUE, updated_by=EXCLUDED.updated_by, updated_at=NOW()
     RETURNING *`,
    [userId, service, scope, key, ...vals, actorId]
  );
  return r.rows[0];
}

module.exports = { SCOPES, CODE_DEFAULTS, UNKNOWN_DEFAULT, resolvePolicies, emailLimits, acquire, acquireService, budgetView, warmupCap, setTenantPolicy, dayStart, hourStart };
