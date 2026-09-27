// FILE: lib/access/service.js
// Access application lifecycle: submit -> (review) -> approve/waitlist/reject,
// entitlements for approved applicants, and download recording.
//
// Tokens (status tokens, entitlement tokens) are 32 random bytes, returned to
// their holder exactly once and stored only as SHA-256 hashes.

const crypto = require('crypto');
const { assessEligibility } = require('./eligibility');

const ENTITLEMENT_TTL_DAYS = Number(process.env.ACCESS_ENTITLEMENT_TTL_DAYS || 14);

// Allowed admin transitions. 'submitted' is only ever set by the applicant.
const TRANSITIONS = {
  submitted: ['reviewing', 'approved', 'waitlisted', 'rejected'],
  reviewing: ['approved', 'waitlisted', 'rejected'],
  waitlisted: ['reviewing', 'approved', 'rejected'],
  rejected: ['reviewing'],
  approved: ['expired'],
  expired: ['reviewing', 'approved'],
};

const newToken = () => crypto.randomBytes(32).toString('base64url');
const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');

function hashIp(ip) {
  if (!ip) return null;
  const salt = process.env.ACCESS_IP_SALT || process.env.JWT_SECRET || '';
  return sha256(`${salt}:${ip}`).slice(0, 32);
}

class AccessError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function inTx(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function issueEntitlement(client, applicationId, createdBy) {
  const token = newToken();
  const expiresAt = new Date(Date.now() + ENTITLEMENT_TTL_DAYS * 86400000);
  // One live entitlement per application: re-issuing revokes the old link.
  await client.query('UPDATE access_entitlements SET revoked_at = now() WHERE application_id = $1 AND revoked_at IS NULL', [applicationId]);
  await client.query(
    'INSERT INTO access_entitlements (application_id, token_hash, expires_at, created_by) VALUES ($1, $2, $3, $4)',
    [applicationId, sha256(token), expiresAt.toISOString(), createdBy],
  );
  return { token, expiresAt: expiresAt.toISOString() };
}

/**
 * Store a validated application. Returns { duplicate: true } without a token
 * when the email already applied — the response is the same shape either
 * way, so the endpoint does not reveal who has applied.
 */
async function submitApplication(pool, v, { ip, autoApprove = false } = {}) {
  const eligibility = assessEligibility({
    systems: v.systems, companySize: v.companySize, country: v.country, willConnectSystems: v.willConnectSystems,
  });
  const statusToken = newToken();
  const approveNow = autoApprove && eligibility.tier === 'ready';

  return inTx(pool, async (client) => {
    const ins = await client.query(
      `INSERT INTO access_applications
         (email, name, company, website, role, company_size, industry, country, systems, other_systems,
          problem, desired_outcome, will_connect_systems, notes, status, eligibility, status_token_hash, source_ip_hash,
          reviewed_by, reviewed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       ON CONFLICT ((lower(email))) DO NOTHING
       RETURNING id, status, created_at`,
      [v.email, v.name, v.company, v.website || null, v.role, v.companySize, v.industry, v.country, v.systems,
        v.otherSystems || null, v.problem, v.desiredOutcome, v.willConnectSystems, v.notes || null,
        approveNow ? 'approved' : 'submitted', JSON.stringify(eligibility), sha256(statusToken), hashIp(ip),
        approveNow ? 'system:auto-approve' : null, approveNow ? new Date().toISOString() : null],
    );
    if (!ins.rows.length) return { duplicate: true, eligibility };
    const app = ins.rows[0];
    await client.query(
      'INSERT INTO access_application_events (application_id, from_status, to_status, actor, note) VALUES ($1, NULL, $2, $3, $4)',
      [app.id, 'submitted', 'applicant', `eligibility ${eligibility.tier} (${eligibility.rules_version})`],
    );
    let entitlement = null;
    if (approveNow) {
      await client.query(
        'INSERT INTO access_application_events (application_id, from_status, to_status, actor, note) VALUES ($1, $2, $3, $4, $5)',
        [app.id, 'submitted', 'approved', 'system', `auto-approved: tier ready under ${eligibility.rules_version}`],
      );
      entitlement = await issueEntitlement(client, app.id, 'system:auto-approve');
    }
    return { duplicate: false, id: app.id, status: app.status, eligibility, statusToken, entitlement };
  });
}

async function getStatusByToken(pool, token) {
  if (!token) return null;
  const { rows } = await pool.query(
    `SELECT a.id, a.company, a.email, a.status, a.eligibility, a.review_note, a.created_at, a.updated_at,
            EXISTS (SELECT 1 FROM access_entitlements e WHERE e.application_id = a.id
                     AND e.revoked_at IS NULL AND e.expires_at > now()) AS has_live_entitlement
       FROM access_applications a WHERE a.status_token_hash = $1`, [sha256(token)]);
  const a = rows[0];
  if (!a) return null;
  const [local, domain] = a.email.split('@');
  return {
    company: a.company,
    email: `${local.slice(0, 2)}•••@${domain}`,
    status: a.status,
    eligibility: a.eligibility,
    reviewNote: a.review_note,
    submittedAt: a.created_at,
    updatedAt: a.updated_at,
    downloadReady: a.status === 'approved' && a.has_live_entitlement,
  };
}

async function listApplications(pool, { status, limit = 50, before } = {}) {
  const params = [];
  const where = [];
  if (status) { params.push(status); where.push(`status = $${params.length}`); }
  if (before) { params.push(before); where.push(`created_at < $${params.length}`); }
  params.push(Math.min(Math.max(Number(limit) || 50, 1), 200));
  const { rows } = await pool.query(
    `SELECT id, name, email, company, website, role, company_size, industry, country, systems, other_systems,
            will_connect_systems, status, eligibility, review_note, reviewed_by, reviewed_at, created_at
       FROM access_applications ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at DESC LIMIT $${params.length}`, params);
  const counts = await pool.query('SELECT status, COUNT(*)::int AS n FROM access_applications GROUP BY status');
  return { applications: rows, counts: Object.fromEntries(counts.rows.map((r) => [r.status, r.n])) };
}

async function getApplication(pool, id) {
  const { rows } = await pool.query('SELECT * FROM access_applications WHERE id = $1', [id]);
  if (!rows[0]) return null;
  const { status_token_hash: _s, source_ip_hash: _i, ...app } = rows[0];
  const events = await pool.query('SELECT from_status, to_status, actor, note, created_at FROM access_application_events WHERE application_id = $1 ORDER BY created_at', [id]);
  const ents = await pool.query(
    `SELECT e.id, e.expires_at, e.revoked_at, e.created_by, e.created_at,
            (SELECT COUNT(*)::int FROM access_download_events d WHERE d.entitlement_id = e.id) AS downloads,
            (SELECT MAX(created_at) FROM access_download_events d WHERE d.entitlement_id = e.id) AS last_download_at
       FROM access_entitlements e WHERE e.application_id = $1 ORDER BY e.created_at DESC`, [id]);
  return { ...app, events: events.rows, entitlements: ents.rows };
}

/** Admin decision. Returns { application, entitlement? } — the entitlement token is shown once. */
async function decide(pool, id, { status, reviewNote }, adminEmail) {
  return inTx(pool, async (client) => {
    const cur = await client.query('SELECT id, status FROM access_applications WHERE id = $1 FOR UPDATE', [id]);
    if (!cur.rows[0]) throw new AccessError(404, 'Application not found');
    const from = cur.rows[0].status;
    if (!(TRANSITIONS[from] || []).includes(status)) {
      throw new AccessError(409, `Cannot move an application from ${from} to ${status}`);
    }
    const note = typeof reviewNote === 'string' ? reviewNote.trim().slice(0, 1000) || null : null;
    const upd = await client.query(
      `UPDATE access_applications SET status = $2, review_note = COALESCE($3, review_note),
              reviewed_by = $4, reviewed_at = now(), updated_at = now() WHERE id = $1 RETURNING id, status, email, name, company`,
      [id, status, note, adminEmail]);
    await client.query(
      'INSERT INTO access_application_events (application_id, from_status, to_status, actor, note) VALUES ($1, $2, $3, $4, $5)',
      [id, from, status, adminEmail, note]);
    let entitlement = null;
    if (status === 'approved') entitlement = await issueEntitlement(client, id, adminEmail);
    if (status === 'expired') await client.query('UPDATE access_entitlements SET revoked_at = now() WHERE application_id = $1 AND revoked_at IS NULL', [id]);
    return { application: upd.rows[0], entitlement };
  });
}

async function reissueEntitlement(pool, id, adminEmail) {
  return inTx(pool, async (client) => {
    const cur = await client.query('SELECT status FROM access_applications WHERE id = $1 FOR UPDATE', [id]);
    if (!cur.rows[0]) throw new AccessError(404, 'Application not found');
    if (cur.rows[0].status !== 'approved') throw new AccessError(409, 'Only approved applications have a download link');
    const entitlement = await issueEntitlement(client, id, adminEmail);
    await client.query(
      'INSERT INTO access_application_events (application_id, from_status, to_status, actor, note) VALUES ($1, $2, $2, $3, $4)',
      [id, 'approved', adminEmail, 'download link re-issued; previous link revoked']);
    return entitlement;
  });
}

async function resolveEntitlement(pool, token) {
  if (!token) return null;
  const { rows } = await pool.query(
    `SELECT e.id, e.expires_at, a.company, a.name, a.status
       FROM access_entitlements e JOIN access_applications a ON a.id = e.application_id
      WHERE e.token_hash = $1 AND e.revoked_at IS NULL AND e.expires_at > now() AND a.status = 'approved'`,
    [sha256(token)]);
  return rows[0] || null;
}

async function recordDownload(pool, entitlementId, artifact, ip) {
  await pool.query('INSERT INTO access_download_events (entitlement_id, artifact, source_ip_hash) VALUES ($1, $2, $3)',
    [entitlementId, artifact, hashIp(ip)]);
}

async function hasApprovedApplication(pool, email) {
  const { rows } = await pool.query(`SELECT 1 FROM access_applications WHERE lower(email) = lower($1) AND status = 'approved'`, [email]);
  return rows.length > 0;
}

module.exports = {
  submitApplication, getStatusByToken, listApplications, getApplication, decide, reissueEntitlement,
  resolveEntitlement, recordDownload, hasApprovedApplication, AccessError, TRANSITIONS, sha256,
};
