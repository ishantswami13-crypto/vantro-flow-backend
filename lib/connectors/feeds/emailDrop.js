'use strict';
// lib/connectors/feeds/emailDrop.js — a report that arrives by email.
//
// Plenty of software (an ERP, a distributor portal, a marketplace) can only
// email a daily or weekly report as an attachment. A feed of this kind reads
// the newest email from a given sender (and, optionally, with words in the
// subject) in the owner's connected Gmail, takes its CSV, Excel or JSON
// attachment, and imports it like an upload.
//
// It uses the Gmail access the owner already granted under Data sources
// (gmail.readonly; lib/connectors/gmailInbox.js). It only searches and
// reads; it never sends, labels, moves or deletes mail. The same message is
// not imported twice: its id is remembered, and the import's own dedup
// treats an identical file as unchanged anyway.

const { gmailAccount } = require('../gmailInbox');
const creds = require('../../domain/outbound/credentials');
const { adapterFor } = require('../../domain/outbound/providers');
const { feedError } = require('./tabular');
const { patternTest } = require('./sftp');

const SENDER_RE = /^(?:[A-Za-z0-9._%+-]{1,64}@)?(?:[A-Za-z0-9-]{1,63}\.)+[A-Za-z]{2,24}$/;
const SUBJECT_RE = /^[\p{L}\p{N} ._:#&()/,+-]{1,100}$/u;
const NAME_RE = /^[\p{L}\p{N} ._*?()&+@#,-]{1,120}$/u;
const FILE_EXT = /\.(csv|tsv|txt|xlsx|json)$/i;
const LOOKBACK_DAYS = 30;
const MAX_BYTES = 15 * 1024 * 1024;

let testFetch = null;
/** Tests point the Gmail adapter at a local stand-in. Production never calls it. */
function __setTestGmailFetch(fn) { testFetch = fn; }

/** Pure: checks the sender, subject words and attachment name pattern. */
function checkEmailConfig(src = {}) {
  const from = String(src.from || '').trim().toLowerCase();
  if (!SENDER_RE.test(from)) throw feedError('Enter the address the report comes from (reports@erp.example.com), or just its domain (erp.example.com).');
  const subject = String(src.subject || '').trim().replace(/\s+/g, ' ');
  if (subject && !SUBJECT_RE.test(subject)) throw feedError('Subject words may use letters, digits, spaces and simple punctuation (no quotes), up to 100 characters.');
  const filename = String(src.filename || '').trim();
  if (filename && !NAME_RE.test(filename)) throw feedError('Enter an attachment name or pattern such as stock-*.xlsx.');
  return { from, ...(subject ? { subject } : {}), ...(filename ? { filename } : {}) };
}

/** Pure: the Gmail search for this feed. Only checked characters reach it. */
function gmailQuery(c) {
  return [`from:${c.from}`, 'has:attachment', `newer_than:${LOOKBACK_DAYS}d`, c.subject ? `subject:"${c.subject}"` : null].filter(Boolean).join(' ');
}

/** Pure: whether an attachment is one the feed reads. */
function acceptAttachment(c) {
  const named = c.filename ? patternTest(c.filename) : null;
  return (name) => FILE_EXT.test(String(name || '')) && (!named || named(name));
}

/**
 * The newest matching attachment. Returns { bytes, filename, messageId,
 * receivedAt, subject } or { bytes: null, note }.
 */
async function readEmailDrop(pool, userId, config) {
  const c = checkEmailConfig(config);
  const account = await gmailAccount(pool, userId);
  if (!account) throw feedError('Connect Gmail under Data sources first; the report is read from that inbox.', 409);
  if (account.status === 'AUTH_REQUIRED') throw Object.assign(feedError(`Connect Gmail again: ${account.status_reason || 'its access was refused.'}`, 409), { kind: 'AUTH_EXPIRED' });
  const credentials = creds.decrypt(account.credentials_enc);
  if (!credentials) throw feedError('The Gmail sign-in cannot be read on this server. Connect Gmail again.', 503);
  const adapter = adapterFor(account, { credentials, ...(testFetch ? { fetchImpl: testFetch } : {}) });
  if (typeof adapter.latestAttachment !== 'function') throw feedError('This mailbox cannot be read for reports.', 409);
  let found;
  try {
    found = await adapter.latestAttachment({ query: gmailQuery(c), accept: acceptAttachment(c), maxBytes: MAX_BYTES });
  } catch (err) {
    if (err.status === 401 || err.status === 403) throw Object.assign(feedError('Gmail refused access. Connect Gmail again under Data sources.', 409), { kind: 'AUTH_EXPIRED' });
    throw feedError(`Could not read Gmail: ${creds.redact(String(err.message)).slice(0, 150)}`, 502);
  }
  if (!found) return { bytes: null, note: `No email from ${c.from}${c.subject ? ` with "${c.subject}" in the subject` : ''} with a CSV, Excel or JSON attachment in the last ${LOOKBACK_DAYS} days.` };
  if (found.tooLarge) throw feedError(`The attachment ${found.filename} is larger than 15 MB.`, 413);
  return { bytes: found.bytes, filename: found.filename, messageId: found.messageId, receivedAt: found.receivedAt, subject: found.subject };
}

module.exports = { readEmailDrop, checkEmailConfig, gmailQuery, acceptAttachment, __setTestGmailFetch, LOOKBACK_DAYS };
