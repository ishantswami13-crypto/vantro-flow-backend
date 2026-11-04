'use strict';
// lib/domain/outbound/campaigns.js
// Targets, campaigns, enrollment, experiments, drafts and review.
//
// Discovery -> verification -> eligibility -> campaign -> content -> review.
// Nothing here sends; approved messages are picked up by the scheduler.
//
// Emails are never guessed. A contact's address is taken only from the
// imported record, and it counts as verified only when the record says who
// verified it, how and when (VERIFIED_METHODS) AND the domain accepts mail.
// A DNS/MX pass alone means "the domain accepts mail", not "this person
// reads this inbox", so it never sets email_verified by itself.

const crypto = require('crypto');
const { normalizeEmail, emailDomain, normalizeDomain, normalizeCompany, normalizePerson } = require('./normalize');
const { checkSyntax, isGenericLocal, validateAddress } = require('./emailValidation');
const { resolveTimeZone, normalizeWindow, isValidTimeZone } = require('./localTime');
const { buildInitial, buildFollowup, validateMessage } = require('./content');
const { checkEligibility } = require('./eligibility');
const { acquireService } = require('./rateLimiter');
const { audit, setContactState, suppress, recordCost, tx } = require('./store');

const VERIFIED_METHODS = ['published_by_person', 'verification_service', 'prior_correspondence', 'manual_confirmed', 'provider_directory'];
const bad = (m) => Object.assign(new Error(m), { status: 400 });

// ------------------------------------------------------------------ fit score
// Dimension points, not a probability. Each dimension is 0..max and the
// explanation says which evidence set it. Unknown = 0 points, not a guess.
const FIT_DIMENSIONS = {
  industry: { max: 25, test: (c, p) => { const ind = String(c.industry || '').toLowerCase(); if (!ind) return null; const want = (p.industries || ['manufacturing', 'industrial distribution', 'machinery', 'equipment', 'logistics', 'supply chain', 'distribution']).map((x) => x.toLowerCase()); return want.some((w) => ind.includes(w) || w.includes(ind)) ? 25 : 5; } },
  size: { max: 20, test: (c) => ({ enterprise: 20, large: 20, medium: 16, small: 6, micro: 0 }[String(c.size_band || '').toLowerCase()] ?? null) },
  erp: { max: 15, test: (c) => (c.erp ? 15 : null) },
  locations: { max: 15, test: (c) => (c.locations == null ? null : c.locations >= 5 ? 15 : c.locations >= 2 ? 10 : 3) },
  inventory: { max: 15, test: (c) => (c.fit_dimensions?.inventoryExposure == null ? null : c.fit_dimensions.inventoryExposure ? 15 : 0) },
  role: { max: 10, test: (c, p, contact) => { const r = String(contact?.role_title || '').toLowerCase(); if (!r) return null; return /(operations|supply|coo|cfo|finance|plant|procurement|logistics|managing director|founder|ceo|owner)/.test(r) ? 10 : 3; } },
};

function fitScore(company, profile = {}, contact = null) {
  let score = 0; const dims = {}; let known = 0;
  for (const [k, d] of Object.entries(FIT_DIMENSIONS)) {
    const v = d.test(company, profile, contact);
    dims[k] = v == null ? { points: 0, known: false } : { points: v, known: true };
    if (v != null) { score += v; known += 1; }
  }
  return { score: Math.min(100, score), dimensions: dims, knownDimensions: known, note: 'Points from known evidence only; unknown dimensions score 0. Not a probability.' };
}

// ------------------------------------------------------------------ campaigns
function validateCampaignInput(input, { partial = false } = {}) {
  const out = {};
  const req = (k) => { if (!partial && (input[k] === undefined || input[k] === null || input[k] === '')) throw bad(`${k} is required`); };
  ['name', 'goal', 'cta'].forEach(req);
  for (const k of ['name', 'goal', 'cta']) if (input[k] !== undefined) { const v = String(input[k]).trim(); if (!v || v.length > 500) throw bad(`${k} must be 1-500 characters`); out[k] = v; }
  if (input.goalTarget !== undefined) out.goal_target = input.goalTarget == null ? null : Math.max(1, Math.min(10000, Number(input.goalTarget) | 0));
  if (input.targetProfile !== undefined) out.target_profile = input.targetProfile || {};
  if (input.allowedCountries !== undefined) {
    if (!Array.isArray(input.allowedCountries) || input.allowedCountries.some((c) => !/^[A-Za-z]{2}$/.test(c))) throw bad('allowedCountries must be ISO-3166 alpha-2 codes');
    out.allowed_countries = input.allowedCountries.map((c) => c.toUpperCase());
  } else if (!partial) throw bad('allowedCountries is required (use ISO codes, e.g. ["IN","GB"])');
  if (input.sendWindow !== undefined) { normalizeWindow(input.sendWindow); out.send_window = input.sendWindow; }
  if (input.messageStrategy !== undefined) out.message_strategy = input.messageStrategy || {};
  if (input.dailyBudget !== undefined) { const n = Number(input.dailyBudget); if (!Number.isInteger(n) || n < 0 || n > 500) throw bad('dailyBudget must be 0-500'); out.daily_budget = n; }
  if (input.limits !== undefined) out.limits = input.limits || {};
  if (input.followupPolicy !== undefined) {
    const f = input.followupPolicy || {};
    const max = Number(f.max ?? 0);
    if (!Number.isInteger(max) || max < 0 || max > 3) throw bad('followupPolicy.max must be 0-3 (no endless sequences)');
    const after = (f.afterDays || []).map(Number);
    if (after.some((d) => !Number.isFinite(d) || d < 1 || d > 60)) throw bad('followupPolicy.afterDays values must be 1-60');
    out.followup_policy = { max, afterDays: after.length ? after : [3, 7].slice(0, Math.max(1, max)) };
  }
  for (const [k, col, lo, hi] of [['cooldownDays', 'cooldown_days', 0, 3650], ['companyCooldownDays', 'company_cooldown_days', 0, 3650], ['maxPerCompany', 'max_per_company', 1, 50]]) {
    if (input[k] !== undefined) { const n = Number(input[k]); if (!Number.isInteger(n) || n < lo || n > hi) throw bad(`${k} must be ${lo}-${hi}`); out[col] = n; }
  }
  if (input.requireReview !== undefined) out.require_review = !!input.requireReview;
  if (input.allowUnverified !== undefined) out.allow_unverified = !!input.allowUnverified;
  if (input.providerAccountId !== undefined) out.provider_account_id = input.providerAccountId || null;
  return out;
}

async function assertAccount(db, userId, accountId) {
  if (!accountId) return;
  const r = await db.query('SELECT id FROM outbound_provider_accounts WHERE id=$1 AND user_id=$2', [accountId, userId]);
  if (!r.rowCount) throw Object.assign(new Error('provider account not found'), { status: 404 });
}

async function createCampaign(pool, userId, input, actorId) {
  const v = validateCampaignInput(input);
  await assertAccount(pool, userId, v.provider_account_id);
  const cols = Object.keys(v);
  const r = await pool.query(
    `INSERT INTO outbound_campaigns (user_id, created_by, ${cols.join(', ')}) VALUES ($1, $2, ${cols.map((_, i) => `$${i + 3}`).join(', ')}) RETURNING *`,
    [userId, actorId, ...cols.map((c) => (typeof v[c] === 'object' && v[c] !== null && !Array.isArray(v[c]) ? JSON.stringify(v[c]) : v[c]))]
  );
  await audit(pool, { userId, actor: `user:${actorId}`, action: 'CAMPAIGN_CREATED', campaignId: r.rows[0].id, detail: { name: v.name } });
  return r.rows[0];
}

async function getCampaign(db, userId, id) {
  const r = await db.query('SELECT * FROM outbound_campaigns WHERE id=$1 AND user_id=$2', [id, userId]);
  if (!r.rows[0]) throw Object.assign(new Error('campaign not found'), { status: 404 });
  const exp = await db.query(`SELECT * FROM outbound_experiments WHERE campaign_id=$1 AND user_id=$2 AND status='ACTIVE'`, [id, userId]);
  return { ...r.rows[0], experiment: exp.rows[0] || null };
}

async function updateCampaign(pool, userId, id, input, actorId) {
  const cur = await getCampaign(pool, userId, id);
  if (['STOPPED', 'COMPLETED'].includes(cur.status)) throw bad(`a ${cur.status.toLowerCase()} campaign cannot be edited`);
  const v = validateCampaignInput(input, { partial: true });
  await assertAccount(pool, userId, v.provider_account_id);
  const cols = Object.keys(v);
  if (!cols.length) return cur;
  const r = await pool.query(
    `UPDATE outbound_campaigns SET ${cols.map((c, i) => `${c} = $${i + 3}`).join(', ')}, updated_at = NOW() WHERE id=$1 AND user_id=$2 RETURNING *`,
    [id, userId, ...cols.map((c) => (typeof v[c] === 'object' && v[c] !== null && !Array.isArray(v[c]) ? JSON.stringify(v[c]) : v[c]))]
  );
  await audit(pool, { userId, actor: `user:${actorId}`, action: 'CAMPAIGN_UPDATED', campaignId: id, detail: { fields: cols } });
  return r.rows[0];
}

/**
 * START / PAUSE / RESUME / STOP. STOP is final: every job not yet handed to
 * the provider is cancelled in the same transaction and no new job is
 * created. A job already SENDING finishes (it cannot be recalled).
 */
async function setCampaignStatus(pool, userId, id, action, actorId) {
  return tx(pool, async (c) => {
    const r = await c.query('SELECT * FROM outbound_campaigns WHERE id=$1 AND user_id=$2 FOR UPDATE', [id, userId]);
    const cur = r.rows[0];
    if (!cur) throw Object.assign(new Error('campaign not found'), { status: 404 });
    const allowed = {
      START: ['DRAFT'], PAUSE: ['ACTIVE'], RESUME: ['PAUSED', 'PAUSED_AUTOMATICALLY'], STOP: ['DRAFT', 'ACTIVE', 'PAUSED', 'PAUSED_AUTOMATICALLY'],
    }[action];
    if (!allowed) throw bad('action must be START, PAUSE, RESUME or STOP');
    if (!allowed.includes(cur.status)) throw Object.assign(new Error(`cannot ${action.toLowerCase()} a campaign that is ${cur.status}`), { status: 409 });
    if (['START', 'RESUME'].includes(action)) {
      if (!cur.provider_account_id) throw bad('choose a sending account before starting the campaign');
      const a = await c.query('SELECT status FROM outbound_provider_accounts WHERE id=$1 AND user_id=$2', [cur.provider_account_id, userId]);
      if (!a.rows[0] || !['HEALTHY', 'THROTTLED'].includes(a.rows[0].status)) throw Object.assign(new Error(`the sending account is ${a.rows[0]?.status || 'missing'}`), { status: 409 });
    }
    const next = { START: 'ACTIVE', PAUSE: 'PAUSED', RESUME: 'ACTIVE', STOP: 'STOPPED' }[action];
    await c.query(`UPDATE outbound_campaigns SET status=$3, status_reason=$4, updated_at=NOW() WHERE id=$1 AND user_id=$2`, [id, userId, next, `${action.toLowerCase()} by owner`]);
    let cancelled = 0;
    if (action === 'STOP') {
      const j = await c.query(
        `UPDATE outbound_send_jobs SET status='CANCELLED', cancelled_reason='campaign stopped', lease_owner=NULL, lease_expires_at=NULL, updated_at=NOW()
          WHERE user_id=$1 AND campaign_id=$2 AND status IN ('QUEUED','RETRY_WAIT','RESERVED') RETURNING id`,
        [userId, id]
      );
      cancelled = j.rowCount;
      await c.query(`UPDATE outbound_enrollments SET status='CANCELLED', status_reason='campaign stopped', next_followup_at=NULL, updated_at=NOW() WHERE user_id=$1 AND campaign_id=$2 AND status NOT IN ('FINISHED','EXCLUDED','REPLIED')`, [userId, id]);
    }
    await audit(c, { userId, actor: `user:${actorId}`, action: `CAMPAIGN_${action}`, campaignId: id, detail: { from: cur.status, to: next, jobsCancelled: cancelled } });
    return { id, status: next, jobsCancelled: cancelled };
  });
}

// ------------------------------------------------------------------ targets
/**
 * Imports companies and contacts. Each row: { company: {...}, contact: {...} }.
 * Returns per-row outcomes; nothing is silently dropped.
 */
async function importTargets(pool, userId, rows, { source = 'import', profile = {} } = {}) {
  if (!Array.isArray(rows) || !rows.length) throw bad('rows must be a non-empty array');
  if (rows.length > 2000) throw bad('import at most 2000 rows at a time');
  const results = [];
  for (const [i, row] of rows.entries()) {
    const co = row.company || {};
    const ct = row.contact || {};
    try {
      if (!co.name) throw bad('company.name is required');
      if (!ct.fullName) throw bad('contact.fullName is required');
      if (!ct.email) throw bad('contact.email is required (emails are never guessed)');
      const syn = checkSyntax(ct.email);
      if (!syn.ok) throw bad(`contact.email is invalid (${syn.reason})`);
      if (isGenericLocal(syn.local)) throw bad('contact.email is a generic inbox (info@, sales@, ...); cold outreach needs a named person');
      if (ct.timezone && !isValidTimeZone(ct.timezone)) throw bad('contact.timezone is not a valid IANA timezone');
      const domain = normalizeDomain(co.domain) || emailDomain(ct.email);
      const facts = (Array.isArray(co.facts) ? co.facts : []).slice(0, 5).map((f) => ({ fact: String(f.fact || '').slice(0, 300), source: f.source ? String(f.source).slice(0, 500) : null, retrievedAt: f.retrievedAt || null }));
      const coRow = await pool.query(
        `INSERT INTO outbound_companies (user_id, name, normalized_name, domain, industry, country, size_band, erp, locations, fit_dimensions, facts)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (user_id, domain) WHERE domain IS NOT NULL DO UPDATE SET
           name=EXCLUDED.name, industry=COALESCE(EXCLUDED.industry, outbound_companies.industry), country=COALESCE(EXCLUDED.country, outbound_companies.country),
           size_band=COALESCE(EXCLUDED.size_band, outbound_companies.size_band), erp=COALESCE(EXCLUDED.erp, outbound_companies.erp),
           locations=COALESCE(EXCLUDED.locations, outbound_companies.locations),
           fit_dimensions=outbound_companies.fit_dimensions || EXCLUDED.fit_dimensions,
           facts=CASE WHEN jsonb_array_length(EXCLUDED.facts) > 0 THEN EXCLUDED.facts ELSE outbound_companies.facts END, updated_at=NOW()
         RETURNING *`,
        [userId, String(co.name).trim(), normalizeCompany(co.name), domain, co.industry || null, co.country ? String(co.country).toUpperCase() : null, co.sizeBand || null, co.erp || null,
          co.locations == null ? null : Number(co.locations), JSON.stringify(co.fitDimensions || {}), JSON.stringify(facts)]
      );
      const company = coRow.rows[0];
      const fit = fitScore(company, profile, { role_title: ct.roleTitle });
      await pool.query('UPDATE outbound_companies SET fit_score=$3 WHERE id=$1 AND user_id=$2', [company.id, userId, fit.score]);
      const v = ct.verification || {};
      const verified = !!(v.method && VERIFIED_METHODS.includes(v.method) && v.source && v.verifiedAt);
      const en = normalizeEmail(ct.email);
      const existing = await pool.query('SELECT id, state FROM outbound_contacts WHERE user_id=$1 AND email_normalized=$2', [userId, en]);
      if (existing.rows[0]) {
        await pool.query(
          `UPDATE outbound_contacts SET role_title=COALESCE($3, role_title), timezone=COALESCE($4, timezone), country=COALESCE($5, country),
                  role_verified_at=COALESCE($6, role_verified_at), role_source=COALESCE($7, role_source), updated_at=NOW()
            WHERE id=$1 AND user_id=$2`,
          [existing.rows[0].id, userId, ct.roleTitle || null, ct.timezone || null, ct.country ? String(ct.country).toUpperCase() : null, ct.roleVerifiedAt || null, ct.roleSource || null]
        );
        results.push({ row: i, status: 'DUPLICATE_MERGED', contactId: existing.rows[0].id, state: existing.rows[0].state });
        continue;
      }
      const state = verified ? 'VERIFIED' : facts.length ? 'RESEARCHED' : 'NEW';
      const ins = await pool.query(
        `INSERT INTO outbound_contacts (user_id, company_id, full_name, normalized_name, role_title, email, email_normalized, email_domain, country, timezone, state,
            email_verified, verification_source, verification_method, verified_at, confidence, role_verified_at, role_source, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id`,
        [userId, company.id, String(ct.fullName).trim(), normalizePerson(ct.fullName), ct.roleTitle || null, String(ct.email).trim(), en, emailDomain(ct.email),
          ct.country ? String(ct.country).toUpperCase() : company.country, ct.timezone || null, state, verified, v.source || null, v.method || null,
          v.verifiedAt || null, ['HIGH', 'MEDIUM', 'LOW'].includes(v.confidence) ? v.confidence : null, ct.roleVerifiedAt || null, ct.roleSource || null, source]
      );
      const tzInfo = resolveTimeZone({ timezone: ct.timezone, country: ct.country || company.country });
      results.push({ row: i, status: 'CREATED', contactId: ins.rows[0].id, state, emailVerified: verified, timezone: tzInfo.tz, fitScore: fit.score });
    } catch (err) {
      if (!err.status) throw err;
      results.push({ row: i, status: 'REJECTED', error: err.message });
    }
  }
  return { results, created: results.filter((r) => r.status === 'CREATED').length, merged: results.filter((r) => r.status === 'DUPLICATE_MERGED').length, rejected: results.filter((r) => r.status === 'REJECTED').length };
}

/**
 * DNS-level check for contacts (rate-limited as the 'verification'
 * service). A failing domain suppresses the address as INVALID_ADDRESS.
 */
async function verifyContacts(pool, userId, contactIds, { resolver } = {}) {
  const out = [];
  for (const id of contactIds.slice(0, 200)) {
    const c = (await pool.query('SELECT * FROM outbound_contacts WHERE id=$1 AND user_id=$2', [id, userId])).rows[0];
    if (!c) { out.push({ id, status: 'NOT_FOUND' }); continue; }
    const rl = await acquireService(pool, userId, 'verification');
    if (!rl.ok) { out.push({ id, status: 'RATE_LIMITED', retryInMs: rl.waitMs }); continue; }
    const v = await validateAddress(c.email, resolver ? { resolver } : {});
    await recordCost(pool, { userId, kind: 'verification', units: 1, amountUsd: 0 });
    if (v.status === 'INVALID') {
      await suppress(pool, userId, { email: c.email, reason: 'INVALID_ADDRESS', source: 'verification', note: v.reason });
    } else if (v.ok && c.email_verified && ['NEW', 'RESEARCHED'].includes(c.state)) {
      await setContactState(pool, userId, c.id, 'VERIFIED', 'domain accepts mail and address verified at source');
    }
    out.push({ id, status: v.status, reason: v.reason, emailVerified: c.email_verified });
  }
  return out;
}

async function approveUnverified(pool, userId, contactId, actorId) {
  const r = await pool.query(`UPDATE outbound_contacts SET unverified_approved_by=$3, updated_at=NOW() WHERE id=$1 AND user_id=$2 RETURNING id`, [contactId, userId, actorId]);
  if (!r.rowCount) throw Object.assign(new Error('contact not found'), { status: 404 });
  await audit(pool, { userId, actor: `user:${actorId}`, action: 'UNVERIFIED_CONTACT_APPROVED', contactId });
  return { id: contactId, approved: true };
}

// ------------------------------------------------------------------ experiments
async function createExperiment(pool, userId, campaignId, { variable, variants }) {
  await getCampaign(pool, userId, campaignId);
  if (!['subject', 'opening', 'cta', 'angle'].includes(variable)) throw bad('variable must be subject, opening, cta or angle (one variable per experiment)');
  if (!Array.isArray(variants) || variants.length < 2 || variants.length > 4) throw bad('an experiment needs 2-4 variants');
  const clean = variants.map((v, i) => ({ key: String(v.key || String.fromCharCode(65 + i)).slice(0, 20), value: String(v.value || '').slice(0, 400) }));
  if (clean.some((v) => !v.value)) throw bad('every variant needs a value');
  const r = await pool.query(`INSERT INTO outbound_experiments (user_id, campaign_id, variable, variants) VALUES ($1,$2,$3,$4) RETURNING *`, [userId, campaignId, variable, JSON.stringify(clean)]);
  return r.rows[0];
}

// Deterministic, uniform assignment: the same contact always gets the same
// variant in the same experiment, and the assignment is stored.
function assignVariant(experiment, contactId) {
  if (!experiment) return null;
  const h = crypto.createHash('sha256').update(`${experiment.id}:${contactId}`).digest();
  return experiment.variants[h.readUInt32BE(0) % experiment.variants.length].key;
}

async function enroll(pool, userId, campaignId, contactIds) {
  const campaign = await getCampaign(pool, userId, campaignId);
  if (['STOPPED', 'COMPLETED'].includes(campaign.status)) throw bad('campaign is not accepting contacts');
  const out = { enrolled: 0, skipped: [] };
  for (const id of contactIds.slice(0, 2000)) {
    const c = (await pool.query('SELECT id FROM outbound_contacts WHERE id=$1 AND user_id=$2', [id, userId])).rows[0];
    if (!c) { out.skipped.push({ id, reason: 'NOT_FOUND' }); continue; }
    const variant = assignVariant(campaign.experiment, id);
    const r = await pool.query(
      `INSERT INTO outbound_enrollments (user_id, campaign_id, contact_id, experiment_id, variant_key) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (campaign_id, contact_id) DO NOTHING RETURNING id`,
      [userId, campaignId, id, campaign.experiment?.id || null, variant]
    );
    if (r.rowCount) out.enrolled += 1; else out.skipped.push({ id, reason: 'ALREADY_ENROLLED' });
  }
  return out;
}

async function loadContactCompany(db, userId, contactId) {
  const r = await db.query(
    `SELECT row_to_json(c) AS contact, row_to_json(co) AS company FROM outbound_contacts c LEFT JOIN outbound_companies co ON co.id = c.company_id AND co.user_id = c.user_id
      WHERE c.id=$1 AND c.user_id=$2`,
    [contactId, userId]
  );
  return r.rows[0] || { contact: null, company: null };
}

async function insertMessage(db, userId, { campaign, enrollment, contact, company, built, step }) {
  const validation = validateMessage(built, { contact, company, campaign, isFollowup: step > 0 });
  const autoApprove = validation.ok && !validation.warnings.length && !campaign.require_review && (step === 0 || campaign.limits?.autoApproveFollowups !== false);
  const status = !validation.ok ? 'BLOCKED_BY_VALIDATION' : autoApprove ? 'APPROVED' : 'PENDING_REVIEW';
  const ver = await db.query('SELECT COALESCE(MAX(version),0)+1 AS v FROM outbound_messages WHERE enrollment_id=$1 AND step=$2', [enrollment.id, step]);
  await db.query(`UPDATE outbound_messages SET review_status='SUPERSEDED' WHERE enrollment_id=$1 AND step=$2 AND review_status IN ('PENDING_REVIEW','BLOCKED_BY_VALIDATION')`, [enrollment.id, step]);
  const r = await db.query(
    `INSERT INTO outbound_messages (user_id, campaign_id, contact_id, enrollment_id, step, version, subject, subject_pattern, body, template_version, prompt_version, model,
        personalization_inputs, evidence, validation, variant_key, review_status, reviewed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, CASE WHEN $17='APPROVED' THEN NOW() ELSE NULL END) RETURNING *`,
    [userId, campaign.id, contact.id, enrollment.id, step, ver.rows[0].v, built.subject, built.subjectPattern, built.body, built.templateVersion, built.promptVersion, built.model,
      JSON.stringify(built.personalizationInputs), JSON.stringify(built.evidence), JSON.stringify(validation), enrollment.variant_key, status]
  );
  // Follow-ups leave the enrollment in SENT; the scheduler finds them by step.
  if (step === 0) {
    await db.query(`UPDATE outbound_enrollments SET status=$3, updated_at=NOW() WHERE id=$1 AND user_id=$2 AND status IN ('ENROLLED','DRAFTED','APPROVED')`,
      [enrollment.id, userId, status === 'APPROVED' ? 'APPROVED' : 'DRAFTED']);
  }
  await recordCost(db, { userId, campaignId: campaign.id, kind: 'generation', units: 1, amountUsd: 0, model: built.model });
  return r.rows[0];
}

/**
 * Drafts first-touch messages for enrolled, eligible contacts. Ineligible
 * contacts are excluded with the reason (never drafted "just in case").
 */
async function generateDrafts(pool, userId, campaignId, { limit = 50, now = new Date() } = {}) {
  const campaign = await getCampaign(pool, userId, campaignId);
  const en = await pool.query(`SELECT * FROM outbound_enrollments WHERE user_id=$1 AND campaign_id=$2 AND status='ENROLLED' ORDER BY created_at LIMIT $3`, [userId, campaignId, Math.min(200, limit)]);
  const out = { drafted: 0, blockedByValidation: 0, approved: 0, excluded: [] };
  for (const e of en.rows) {
    const { contact, company } = await loadContactCompany(pool, userId, e.contact_id);
    const elig = await checkEligibility(pool, userId, { contact, campaign, now, kind: 'COLD' });
    if (!elig.eligible) {
      await pool.query(`UPDATE outbound_enrollments SET status='EXCLUDED', status_reason=$3, updated_at=NOW() WHERE id=$1 AND user_id=$2`, [e.id, userId, elig.reasons.join(', ')]);
      out.excluded.push({ contactId: contact.id, reasons: elig.reasons });
      continue;
    }
    const built = buildInitial({ contact, company, campaign, variantKey: e.variant_key });
    const m = await insertMessage(pool, userId, { campaign, enrollment: e, contact, company, built, step: 0 });
    if (m.review_status === 'BLOCKED_BY_VALIDATION') out.blockedByValidation += 1;
    else if (m.review_status === 'APPROVED') out.approved += 1;
    else out.drafted += 1;
  }
  await audit(pool, { userId, actor: 'system:content', action: 'DRAFTS_GENERATED', campaignId, detail: out });
  return out;
}

async function buildFollowupMessage(db, userId, campaign, enrollment) {
  const { contact, company } = await loadContactCompany(db, userId, enrollment.contact_id);
  const prev = await db.query(`SELECT subject FROM outbound_messages WHERE enrollment_id=$1 AND user_id=$2 AND step=0 AND review_status='APPROVED' ORDER BY version DESC LIMIT 1`, [enrollment.id, userId]);
  const built = buildFollowup({ contact, company, campaign, step: enrollment.step + 1, previousSubject: prev.rows[0]?.subject });
  return insertMessage(db, userId, { campaign, enrollment, contact, company, built, step: enrollment.step + 1 });
}

/**
 * Human review. Approve may carry edits; edits are re-validated and a
 * message that fails validation cannot be approved.
 */
async function reviewMessage(pool, userId, messageId, { decision, subject, body }, actorId) {
  return tx(pool, async (c) => {
    const r = await c.query('SELECT * FROM outbound_messages WHERE id=$1 AND user_id=$2 FOR UPDATE', [messageId, userId]);
    const m = r.rows[0];
    if (!m) throw Object.assign(new Error('message not found'), { status: 404 });
    if (!['PENDING_REVIEW', 'BLOCKED_BY_VALIDATION'].includes(m.review_status)) throw Object.assign(new Error(`message is ${m.review_status}`), { status: 409 });
    if (decision === 'REJECT') {
      await c.query(`UPDATE outbound_messages SET review_status='REJECTED', reviewed_by=$3, reviewed_at=NOW() WHERE id=$1 AND user_id=$2`, [messageId, userId, actorId]);
      await c.query(`UPDATE outbound_enrollments SET status='EXCLUDED', status_reason='message rejected in review', updated_at=NOW() WHERE id=$1 AND user_id=$2 AND status IN ('DRAFTED','ENROLLED')`, [m.enrollment_id, userId]);
      await audit(c, { userId, actor: `user:${actorId}`, action: 'MESSAGE_REJECTED', campaignId: m.campaign_id, contactId: m.contact_id, messageId });
      return { id: messageId, review_status: 'REJECTED' };
    }
    if (decision !== 'APPROVE') throw bad('decision must be APPROVE or REJECT');
    const campaign = await getCampaign(c, userId, m.campaign_id);
    const { contact, company } = await loadContactCompany(c, userId, m.contact_id);
    const next = { ...m, subject: subject != null ? String(subject) : m.subject, body: body != null ? String(body) : m.body };
    const validation = validateMessage({ subject: next.subject, body: next.body, evidence: m.evidence }, { contact, company, campaign, isFollowup: m.step > 0 });
    if (!validation.ok) {
      await c.query(`UPDATE outbound_messages SET subject=$3, body=$4, validation=$5, review_status='BLOCKED_BY_VALIDATION' WHERE id=$1 AND user_id=$2`, [messageId, userId, next.subject, next.body, JSON.stringify(validation)]);
      throw Object.assign(new Error(`cannot approve: ${validation.errors.join('; ')}`), { status: 422 });
    }
    await c.query(`UPDATE outbound_messages SET subject=$3, body=$4, validation=$5, review_status='APPROVED', reviewed_by=$6, reviewed_at=NOW() WHERE id=$1 AND user_id=$2`,
      [messageId, userId, next.subject, next.body, JSON.stringify(validation), actorId]);
    await c.query(`UPDATE outbound_enrollments SET status=CASE WHEN step = 0 AND status IN ('DRAFTED','ENROLLED') THEN 'APPROVED' ELSE status END, updated_at=NOW() WHERE id=$1 AND user_id=$2`, [m.enrollment_id, userId]);
    await audit(c, { userId, actor: `user:${actorId}`, action: 'MESSAGE_APPROVED', campaignId: m.campaign_id, contactId: m.contact_id, messageId, detail: { edited: subject != null || body != null } });
    return { id: messageId, review_status: 'APPROVED', validation };
  });
}

module.exports = {
  VERIFIED_METHODS, FIT_DIMENSIONS, fitScore, validateCampaignInput, createCampaign, getCampaign, updateCampaign, setCampaignStatus,
  importTargets, verifyContacts, approveUnverified, createExperiment, assignVariant, enroll, generateDrafts, buildFollowupMessage, reviewMessage, loadContactCompany,
};
