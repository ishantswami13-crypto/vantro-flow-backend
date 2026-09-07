// FILE: lib/domain/globalContext/organization.js
// STARLANE Global Context + Temporal Foundation -- Part A.
//
// `organizations` (migration 021) is an ADDITIVE contextual layer over the
// existing `user_id` tenant key. This file is the ONLY place existing code
// needs to call to get org context -- nothing existing is forced to use it.
// `owner_user_id` is the explicit bridge back to `users.id`.
const { getPool } = require('../../db/pg');

/**
 * Returns the organization row for a given userId, creating one (with all
 * context fields NULL except a display_name inherited from the user's real
 * existing business_name/industry if present) if none exists yet.
 * Never guesses/infers country or currency -- those stay NULL until a real
 * fact is recorded via updateOrganizationContext().
 */
async function getOrCreateOrganizationContext(userId) {
  if (!userId) throw new Error('getOrCreateOrganizationContext: userId is required');
  const pool = getPool();

  const existing = await pool.query(`SELECT * FROM organizations WHERE owner_user_id = $1`, [userId]);
  if (existing.rows.length > 0) return existing.rows[0];

  // Only pull real, already-recorded facts from `users` (business_name,
  // industry) -- never infer country/currency from them.
  const userRes = await pool.query(
    `SELECT business_name, industry FROM users WHERE id = $1`,
    [userId]
  );
  const user = userRes.rows[0] || {};

  const inserted = await pool.query(
    `INSERT INTO organizations (owner_user_id, display_name, industry)
     VALUES ($1, $2, $3)
     ON CONFLICT (owner_user_id) DO UPDATE SET updated_at = NOW()
     RETURNING *`,
    [userId, user.business_name || null, user.industry || null]
  );
  return inserted.rows[0];
}

/**
 * Explicit, separate update path for recording real organization-level
 * facts (home_country/base_currency/timezone/legal_name/display_name).
 * Never called automatically/inferentially -- only when a caller has an
 * actual fact to record.
 */
async function updateOrganizationContext(userId, fields = {}) {
  if (!userId) throw new Error('updateOrganizationContext: userId is required');
  const allowed = ['legal_name', 'display_name', 'home_country', 'base_currency', 'timezone', 'industry'];
  const setClauses = [];
  const params = [userId];
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      params.push(fields[key]);
      setClauses.push(`${key} = $${params.length}`);
    }
  }
  if (setClauses.length === 0) return getOrCreateOrganizationContext(userId);

  await getOrCreateOrganizationContext(userId); // ensure row exists first
  const pool = getPool();
  const res = await pool.query(
    `UPDATE organizations SET ${setClauses.join(', ')}, updated_at = NOW() WHERE owner_user_id = $1 RETURNING *`,
    params
  );
  return res.rows[0];
}

module.exports = { getOrCreateOrganizationContext, updateOrganizationContext };
