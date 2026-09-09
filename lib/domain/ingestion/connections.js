// FILE: lib/domain/ingestion/connections.js
// STARLANE — Data Connections domain module.
//
// Minimal read/write layer over the `data_connections` table (see
// migrations/031_data_connections.sql). Used by:
//   - GET  /api/connections           (frontend: show status per tenant)
//   - POST /api/connections/heartbeat (local Tally connector: report alive)

const { supabase } = require('../../config/supabaseClient');

const VALID_SOURCE_TYPES = ['TALLY', 'FILE_IMPORT', 'QUICKBOOKS', 'ZOHO_BOOKS', 'XERO'];
const VALID_STATUSES = ['NOT_CONNECTED', 'PENDING_PERMISSION', 'CONNECTED', 'ERROR', 'DISCONNECTED'];

/**
 * Return all connection records for a tenant.
 * @param {string} userId
 * @returns {Promise<Array>}
 */
async function getConnections(userId) {
  if (!userId) throw new Error('getConnections: userId required');
  const { data, error } = await supabase
    .from('data_connections')
    .select('*')
    .eq('user_id', userId);
  if (error) throw error;
  return data || [];
}

/**
 * Create-or-update the connection status for one (userId, sourceType) pair.
 * @param {string} userId
 * @param {string} sourceType - one of VALID_SOURCE_TYPES
 * @param {string} status - one of VALID_STATUSES
 * @param {{lastSyncAt?: string|Date, lastSyncError?: string|null}} [opts]
 */
async function upsertConnectionStatus(userId, sourceType, status, opts = {}) {
  if (!userId) throw new Error('upsertConnectionStatus: userId required');
  if (!VALID_SOURCE_TYPES.includes(sourceType)) {
    throw new Error(`upsertConnectionStatus: invalid sourceType "${sourceType}"`);
  }
  if (!VALID_STATUSES.includes(status)) {
    throw new Error(`upsertConnectionStatus: invalid status "${status}"`);
  }

  const { lastSyncAt, lastSyncError } = opts;
  const now = new Date();

  // Look up existing row for this tenant+source so we know whether to set
  // connected_at (only the first time a source becomes CONNECTED).
  const { data: existingRows, error: findError } = await supabase
    .from('data_connections')
    .select('*')
    .eq('user_id', userId)
    .eq('source_type', sourceType);
  if (findError) throw findError;
  const existing = (existingRows || [])[0];

  const patch = {
    user_id: userId,
    source_type: sourceType,
    status,
    updated_at: now,
  };
  if (lastSyncAt !== undefined) patch.last_sync_at = lastSyncAt;
  if (lastSyncError !== undefined) patch.last_sync_error = lastSyncError;
  if (status === 'CONNECTED' && !(existing && existing.connected_at)) {
    patch.connected_at = now;
  }

  if (existing) {
    const { data, error } = await supabase
      .from('data_connections')
      .update(patch)
      .eq('id', existing.id)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  const { data, error } = await supabase
    .from('data_connections')
    .insert([patch])
    .select()
    .single();
  if (error) throw error;
  return data;
}

module.exports = {
  getConnections,
  upsertConnectionStatus,
  VALID_SOURCE_TYPES,
  VALID_STATUSES,
};
