// FILE: tests/helpers/outboundHarness.js
// Fixture setup for the outbound engine tests and the readiness exercise.
// Tenants live on the reserved .invalid domain and every prospect address
// is *.invalid, so nothing here could be delivered even by a real provider;
// the provider is the sink (or a counting double) in every test anyway.

process.env.OUTBOUND_FIXTURE_MODE = 'true';
const crypto = require('crypto');
const { createTenant } = require('./decisionHarness');
const campaigns = require('../../lib/domain/outbound/campaigns');
const { sinkAdapter } = require('../../lib/domain/outbound/providers');

async function outboundReady(pool) {
  const r = await pool.query(`SELECT to_regclass('public.outbound_send_jobs') AS t`);
  return !!r.rows[0].t;
}

// Global and provider buckets are shared by every tenant; tests start them fresh.
async function resetSharedBuckets(pool) {
  await pool.query(`DELETE FROM outbound_rate_buckets WHERE bucket_key LIKE 'email:GLOBAL:%' OR bucket_key LIKE 'email:PROVIDER:%'`);
  await pool.query(`DELETE FROM outbound_rate_windows WHERE bucket_key LIKE 'email:GLOBAL:%' OR bucket_key LIKE 'email:PROVIDER:%'`);
  await pool.query(`DELETE FROM outbound_system_controls WHERE key='global_stop'`);
  await pool.query(`DELETE FROM outbound_locks`);
}

async function setupTenant(pool, label, { dailyMax = 40, warmup = false } = {}) {
  const user = await createTenant(pool, `outbound-${label}`);
  const a = await pool.query(
    `INSERT INTO outbound_provider_accounts (user_id, provider, from_address, status, daily_max, warmup_started_on, created_by)
     VALUES ($1,'sink',$2,'HEALTHY',$3,$4,$1) RETURNING *`,
    [user.id, `sender@${label}-fixture.invalid`, dailyMax, warmup ? new Date().toISOString().slice(0, 10) : null]
  );
  // Generous tenant-level limits so a test exercises exactly the limit it names.
  for (const scope of ['ACCOUNT', 'TENANT', 'CAMPAIGN']) {
    await pool.query(
      `INSERT INTO outbound_rate_policies (user_id, service, scope, scope_key, per_minute, per_hour, per_day, burst, concurrency) VALUES ($1,'email',$2,'*',60,1000,1000,50,$3)`,
      [user.id, scope, scope === 'ACCOUNT' ? 4 : null]
    );
  }
  await pool.query(
    `INSERT INTO outbound_rate_policies (user_id, service, scope, scope_key, per_minute, per_hour, per_day, burst) VALUES ($1,'email','DOMAIN','*',60,1000,1000,50)`,
    [user.id]
  );
  return { user, account: a.rows[0] };
}

let seq = 0;
function targetRow({ domain, first, last = 'Fixture', role = 'Head of Operations', country = 'IN', timezone = null, verified = true, industry = 'Industrial distribution', facts = null, company = null, email = null }) {
  seq += 1;
  // Person names are compared without digits (normalizePerson), so fixture
  // names spell digits as letters to stay distinct people.
  const f = String(first || `Person${seq}`).replace(/\d/g, (d) => 'abcdefghij'[Number(d)]);
  return {
    company: {
      name: company || `${domain.split('.')[0].replace(/-/g, ' ')} Fixture Pvt Ltd`, domain, industry, country, sizeBand: 'large', erp: 'SAP', locations: 4,
      facts: facts === null ? [{ fact: 'Operates four distribution centres across western India', source: 'https://fixture.invalid/about', retrievedAt: '2026-09-20' }] : facts,
    },
    contact: {
      fullName: `${f} ${last}`, roleTitle: role, email: email || `${f.toLowerCase()}.${last.toLowerCase()}@${domain}`, country, timezone,
      verification: verified ? { source: 'fixture directory', method: 'published_by_person', verifiedAt: '2026-09-25', confidence: 'HIGH' } : undefined,
      roleVerifiedAt: '2026-09-25', roleSource: 'fixture directory',
    },
  };
}

async function readyCampaign(pool, { user, account }, rows, overrides = {}) {
  const c = await campaigns.createCampaign(pool, user.id, {
    name: 'Fixture pilot outreach', goal: 'Book qualified pilot conversations', goalTarget: 5, cta: 'Would a 15-minute working session be useful?',
    allowedCountries: ['IN', 'GB', 'US', 'DE', 'AE'], dailyBudget: 50, followupPolicy: { max: 2, afterDays: [3, 7] }, providerAccountId: account.id,
    messageStrategy: { topic: 'inventory and working capital' }, cooldownDays: 90, companyCooldownDays: 14, maxPerCompany: 1, ...overrides,
  }, user.id);
  const imp = await campaigns.importTargets(pool, user.id, rows);
  const ids = imp.results.filter((r) => r.contactId).map((r) => r.contactId);
  await campaigns.enroll(pool, user.id, c.id, ids);
  const drafts = await campaigns.generateDrafts(pool, user.id, c.id, { limit: 500 });
  const pending = await pool.query(`SELECT id FROM outbound_messages WHERE user_id=$1 AND campaign_id=$2 AND review_status='PENDING_REVIEW'`, [user.id, c.id]);
  for (const m of pending.rows) await campaigns.reviewMessage(pool, user.id, m.id, { decision: 'APPROVE' }, user.id);
  await campaigns.setCampaignStatus(pool, user.id, c.id, 'START', user.id);
  await pool.query(
    `INSERT INTO outbound_tenant_state (user_id, engine_status, mode, started_at) VALUES ($1,'RUNNING','SHADOW',NOW())
     ON CONFLICT (user_id) DO UPDATE SET engine_status='RUNNING', mode='SHADOW'`, [user.id]
  );
  return { campaign: c, imported: imp, drafts, contactIds: ids };
}

// A sink that counts provider calls and can inject faults per call.
function countingProvider({ faults = [] } = {}) {
  const calls = [];
  const base = sinkAdapter({ id: 'counting' }, { faults: {} });
  let n = 0;
  const provider = {
    ...base,
    name: 'counting-sink',
    async sendEmail(m) {
      n += 1;
      calls.push({ to: m.to, key: m.idempotencyKey, threadId: m.threadId, inReplyTo: m.inReplyTo });
      const f = faults[n - 1];
      if (f) throw f();
      return base.sendEmail(m);
    },
  };
  return { providerFor: () => provider, calls };
}

async function cleanupTenants(pool, users) {
  for (const u of users) {
    await pool.query(`DELETE FROM outbound_rate_buckets WHERE bucket_key LIKE $1`, [`%${u.id}%`]).catch(() => {});
    await pool.query(`DELETE FROM outbound_rate_windows WHERE bucket_key LIKE $1`, [`%${u.id}%`]).catch(() => {});
    await pool.query(`DELETE FROM outbound_audit WHERE user_id=$1`, [u.id]).catch(() => {});
    await pool.query('DELETE FROM users WHERE id=$1', [u.id]).catch(() => {});
  }
}

const uuid = () => crypto.randomUUID();

module.exports = { outboundReady, resetSharedBuckets, setupTenant, targetRow, readyCampaign, countingProvider, cleanupTenants, uuid };
