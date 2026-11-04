'use strict';
// lib/domain/outbound/eligibility.js
// The single gate every send passes, at scheduling time AND again inside
// the worker's transaction right before the provider is called.
//
// DO NOT SEND when any of these hold (reason codes in brackets):
//   hard suppression of the address or its domain       [SUPPRESSED:<reason>]
//   contact in a terminal state (bounced, blocked, opted out, declined, suppressed) [STATE:<state>]
//   malformed or generic inbox                            [INVALID_ADDRESS|GENERIC_INBOX]
//   email not verified, and no explicit approval          [UNVERIFIED_EMAIL]
//   role never verified or older than the allowed age     [ROLE_UNVERIFIED|ROLE_STALE]
//   no known timezone                                     [NO_TIMEZONE]
//   country not allowed by the campaign                   [COUNTRY_NOT_ALLOWED]
//   cold only: same address contacted within cooldown     [COOLDOWN]
//   cold only: same person under another address          [DUPLICATE_PERSON]
//   cold only: company already contacted/queued in window [COMPANY_RECENTLY_CONTACTED]
//   cold only: the person has an active conversation      [ACTIVE_THREAD]
//   follow-up only: they replied since our last send      [REPLIED_SINCE_LAST_SEND]
//   another open job for the same contact                 [OPEN_JOB_EXISTS]

const { checkSyntax, isGenericLocal } = require('./emailValidation');
const { resolveTimeZone } = require('./localTime');
const { TERMINAL } = require('./store');

const DAY = 86400000;

async function checkEligibility(db, userId, { contact, campaign, now = new Date(), kind = 'COLD', excludeJobId = null }) {
  const reasons = [];
  const warnings = [];
  const limits = campaign?.limits || {};

  const sup = await db.query(
    `SELECT reason FROM outbound_suppressions WHERE user_id = $1 AND (email_normalized = $2 OR (email_normalized IS NULL AND domain = $3))`,
    [userId, contact.email_normalized, contact.email_domain]
  );
  for (const s of sup.rows) reasons.push(`SUPPRESSED:${s.reason}`);
  if (TERMINAL.has(contact.state)) reasons.push(`STATE:${contact.state}`);

  const syn = checkSyntax(contact.email);
  if (!syn.ok) reasons.push('INVALID_ADDRESS');
  else if (isGenericLocal(syn.local)) reasons.push('GENERIC_INBOX');

  const approvedUnverified = !!(campaign?.allow_unverified && contact.unverified_approved_by);
  if (!contact.email_verified && !approvedUnverified) reasons.push('UNVERIFIED_EMAIL');
  const roleMaxAgeDays = Number(limits.roleMaxAgeDays || 180);
  if (!contact.role_verified_at) {
    if (!approvedUnverified) reasons.push('ROLE_UNVERIFIED');
  } else if (now.getTime() - new Date(contact.role_verified_at).getTime() > roleMaxAgeDays * DAY) {
    if (!approvedUnverified) reasons.push('ROLE_STALE');
    else warnings.push('ROLE_STALE_APPROVED');
  }

  const { tz } = resolveTimeZone(contact);
  if (!tz) reasons.push('NO_TIMEZONE');
  const allowed = (campaign?.allowed_countries || []).map((c) => String(c).toUpperCase());
  if (allowed.length && !allowed.includes(String(contact.country || '').toUpperCase())) reasons.push('COUNTRY_NOT_ALLOWED');

  const open = await db.query(
    `SELECT COUNT(*)::int AS n FROM outbound_send_jobs WHERE user_id = $1 AND contact_id = $2 AND status IN ('QUEUED','RESERVED','SENDING','RETRY_WAIT','AMBIGUOUS') AND ($3::uuid IS NULL OR id <> $3)`,
    [userId, contact.id, excludeJobId]
  );
  if (open.rows[0].n > 0) reasons.push('OPEN_JOB_EXISTS');

  if (kind === 'COLD') {
    const cooldownDays = Number(campaign?.cooldown_days ?? 90);
    const since = new Date(now.getTime() - cooldownDays * DAY);
    const recent = await db.query(
      `SELECT COUNT(*)::int AS n FROM outbound_send_jobs j JOIN outbound_contacts c ON c.id = j.contact_id AND c.user_id = j.user_id
        WHERE j.user_id = $1 AND c.email_normalized = $2 AND j.status = 'SENT' AND j.sent_at >= $3`,
      [userId, contact.email_normalized, since]
    );
    if (recent.rows[0].n > 0) reasons.push('COOLDOWN');

    const alias = await db.query(
      `SELECT COUNT(*)::int AS n FROM outbound_send_jobs j JOIN outbound_contacts c ON c.id = j.contact_id AND c.user_id = j.user_id
        WHERE j.user_id = $1 AND c.id <> $2 AND c.normalized_name = $3
          AND (c.email_domain = $4 OR ($5::uuid IS NOT NULL AND c.company_id = $5))
          AND (j.status IN ('QUEUED','RESERVED','SENDING','RETRY_WAIT','AMBIGUOUS') OR (j.status = 'SENT' AND j.sent_at >= $6))`,
      [userId, contact.id, contact.normalized_name, contact.email_domain, contact.company_id, since]
    );
    if (alias.rows[0].n > 0) reasons.push('DUPLICATE_PERSON');

    const companyDays = Number(campaign?.company_cooldown_days ?? 14);
    const maxPerCompany = Number(campaign?.max_per_company ?? 1);
    const co = await db.query(
      `SELECT COUNT(DISTINCT c.id)::int AS n FROM outbound_send_jobs j JOIN outbound_contacts c ON c.id = j.contact_id AND c.user_id = j.user_id
        JOIN outbound_messages m ON m.id = j.message_id AND m.step = 0
        WHERE j.user_id = $1 AND c.id <> $2
          AND (c.email_domain = $3 OR ($4::uuid IS NOT NULL AND c.company_id = $4))
          AND (j.status IN ('QUEUED','RESERVED','SENDING','RETRY_WAIT','AMBIGUOUS') OR (j.status = 'SENT' AND j.sent_at >= $5))
          AND ($6::uuid IS NULL OR j.id <> $6)`,
      [userId, contact.id, contact.email_domain, contact.company_id, new Date(now.getTime() - companyDays * DAY), excludeJobId]
    );
    if (co.rows[0].n >= maxPerCompany) reasons.push('COMPANY_RECENTLY_CONTACTED');

    const thread = await db.query(
      `SELECT COUNT(*)::int AS n FROM outbound_replies WHERE user_id = $1 AND contact_id = $2 AND classification <> 'AUTO_REPLY' AND received_at >= $3`,
      [userId, contact.id, new Date(now.getTime() - 90 * DAY)]
    );
    if (thread.rows[0].n > 0 || ['REPLIED', 'INTERESTED', 'MEETING'].includes(contact.state)) reasons.push('ACTIVE_THREAD');
  } else {
    const r = await db.query(
      `SELECT COUNT(*)::int AS n FROM outbound_replies r
        WHERE r.user_id = $1 AND r.contact_id = $2 AND r.classification <> 'AUTO_REPLY'
          AND r.received_at >= COALESCE((SELECT MAX(sent_at) FROM outbound_send_jobs WHERE user_id = $1 AND contact_id = $2 AND status = 'SENT'), 'epoch'::timestamptz)`,
      [userId, contact.id]
    );
    if (r.rows[0].n > 0) reasons.push('REPLIED_SINCE_LAST_SEND');
  }

  return { eligible: reasons.length === 0, reasons, warnings, timezone: tz };
}

module.exports = { checkEligibility };
