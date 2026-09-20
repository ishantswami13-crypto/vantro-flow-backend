// FILE: lib/services/actionApproval.service.js
// Signed, single-use "one-tap approval" links for ai_actions rows that need a
// real human decision before something with a real-world effect happens
// (sending a purchase order to a supplier, preparing a payables payout,
// placing an automated collections call).
//
// Deliberately a signed link (tap = GET request), not a WhatsApp free-text
// reply parser. server.js already has a loose regex-based reply parser
// (parseSnoozeIntent) for low-stakes "when will you pay" promises from
// customers -- that's fine for a snooze date, but parsing freeform replies
// to authorize a payment or a supplier order is a categorically worse idea.
// A signed, single-use, short-expiry link is unambiguous and mirrors the
// existing signPublicBillToken/verifyPublicBillToken pattern in server.js
// (same HMAC-over-base64url-payload approach), just generalised to any
// ai_actions row instead of only bill IDs.
const crypto = require('crypto');
const { supabase } = require('../config/supabaseClient');
const { safeLog } = require('../observability/logger');

const DEFAULT_EXPIRY_MS = 48 * 60 * 60 * 1000; // 48h — long enough for an owner to see a WhatsApp message, short enough to bound risk

function getSecret() {
  return process.env.ACTION_APPROVAL_SECRET || process.env.PUBLIC_LINK_SECRET || process.env.JWT_SECRET || '';
}

function timingSafeEqualString(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/**
 * Sign a token for one specific ai_actions row. `intent` distinguishes
 * approve vs reject links so a leaked "approve" link can't be replayed
 * against the reject path or vice versa.
 */
function signActionToken(actionId, intent = 'approve', expiresAtMs = Date.now() + DEFAULT_EXPIRY_MS) {
  const secret = getSecret();
  if (!secret) throw new Error('No secret configured for action approval tokens (set ACTION_APPROVAL_SECRET, PUBLIC_LINK_SECRET, or JWT_SECRET)');
  const payload = Buffer.from(JSON.stringify({ actionId: String(actionId), intent, exp: Number(expiresAtMs) }), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

/**
 * Verify a token against a specific ai_actions row id and intent. Does NOT
 * check whether the action has already been actioned -- callers must check
 * the row's current `status` themselves (this module only proves the link
 * hasn't been tampered with / hasn't expired; single-use enforcement is a
 * DB-state check, done by the route handler against ai_actions.status).
 */
function verifyActionToken(token, actionId, intent = 'approve') {
  if (!token || typeof token !== 'string') return false;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return false;
  const secret = getSecret();
  if (!secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  if (!timingSafeEqualString(sig, expected)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return String(data.actionId) === String(actionId) && data.intent === intent && Number(data.exp) > Date.now();
  } catch {
    return false;
  }
}

/**
 * Build the full approve/reject URLs for an ai_actions row, for embedding in
 * a WhatsApp message to the owner.
 */
function buildApprovalLinks(actionId, baseUrl) {
  const base = (baseUrl || process.env.RAILWAY_PUBLIC_URL || 'https://vantro-flow-backend-production.up.railway.app').replace(/\/$/, '');
  const approveToken = signActionToken(actionId, 'approve');
  const rejectToken = signActionToken(actionId, 'reject');
  return {
    approveUrl: `${base}/api/actions/${actionId}/approve?token=${encodeURIComponent(approveToken)}`,
    rejectUrl:  `${base}/api/actions/${actionId}/reject?token=${encodeURIComponent(rejectToken)}`,
  };
}

/**
 * Fetch an ai_actions row and confirm it's still awaiting a decision
 * (status === 'pending'). Returns { ok, action, reason }.
 */
async function loadPendingAction(actionId) {
  const { data: action, error } = await supabase.from('ai_actions').select('*').eq('id', actionId).maybeSingle();
  if (error) { safeLog('error', '[ActionApproval] load failed', { error: error.message, actionId }); return { ok: false, reason: 'lookup_failed' }; }
  if (!action) return { ok: false, reason: 'not_found' };
  if (action.status !== 'pending') return { ok: false, reason: 'already_actioned', action };
  return { ok: true, action };
}

module.exports = { signActionToken, verifyActionToken, buildApprovalLinks, loadPendingAction };
