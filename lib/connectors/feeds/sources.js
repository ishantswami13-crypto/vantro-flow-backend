'use strict';
// lib/connectors/feeds/sources.js — read a feed's source into one file.
//
//   sheet_link  a Google Sheet tab, downloaded as CSV (lib/connectors/sheetLink.js)
//   file_url    any https address that serves CSV, TSV, Excel or JSON: an
//               ERP's scheduled export, a report URL, a shared file link
//               (Dropbox and Google Drive share links are turned into their
//               download links). Optional request header for a token.
//   app         a connected app's records, through its adapter's feedRows()
//   push        rows another tool sent (handled by the push route; here only
//               converted)
//   tally       Tally XML the Starlane bridge sent (lib/connectors/feeds/tallyOps.js)
//   sftp        the newest matching file in an SFTP folder (./sftp.js)
//   email       the newest report attachment in the owner's Gmail (./emailDrop.js)
//
// Every outbound request goes through safeHttp: https only, private and
// internal addresses refused (checked again on each redirect hop), size and
// time limits. A request header is never sent to another host after a
// redirect. Returns { buffer, filename, rowsReceived, truncated, currency }.

const { safeRequest } = require('../safeHttp');
const { fetchSheetCsv } = require('../sheetLink');
const { provider, isLive } = require('../apps');
const accounts = require('../apps/accounts');
const { rowsFromJson, rowsToCsv, feedError } = require('./tabular');
const { readSftp } = require('./sftp');
const { readEmailDrop } = require('./emailDrop');
const { tallyFeedRows } = require('./tallyOps');

const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,60}$/;
// Never let a tenant set these on our outbound request.
const FORBIDDEN_HEADERS = new Set(['host', 'content-length', 'transfer-encoding', 'connection', 'cookie', 'proxy-authorization', 'te', 'upgrade']);

let requestImpl = safeRequest;
let requestOptions = {};
/** Tests point outbound requests at a local server. Production never calls it. */
function __setTestRequest(fn, options = {}) {
  requestImpl = fn || safeRequest;
  requestOptions = options;
}

/** Pure: checks and normalises a file address; share links become download links. */
function normalizeFileUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { throw feedError('Enter the full address of the file, starting with https://.'); }
  if (u.protocol !== 'https:' && !(requestOptions.allowHttp && u.protocol === 'http:')) throw feedError('Only https:// addresses can be read.');
  if (u.username || u.password) throw feedError('Put a token in the request header field, not in the address.');
  if (u.hostname === 'docs.google.com' && /^\/spreadsheets\//.test(u.pathname)) throw feedError('For a Google Sheet, choose "Google Sheet" as the source and paste its share link.');
  if (/(^|\.)dropbox\.com$/.test(u.hostname)) { u.searchParams.delete('dl'); u.searchParams.set('dl', '1'); }
  const drive = u.hostname === 'drive.google.com' && /^\/file\/d\/([A-Za-z0-9_-]{10,100})/.exec(u.pathname);
  if (drive) return `https://drive.google.com/uc?export=download&id=${drive[1]}`;
  return u.toString();
}

/** Pure: checks an optional request header ({ name, value }). */
function checkHeader(h) {
  if (!h || (!h.name && !h.value)) return null;
  const name = String(h.name || '').trim();
  const value = String(h.value || '');
  if (!HEADER_NAME_RE.test(name) || FORBIDDEN_HEADERS.has(name.toLowerCase())) throw feedError('The header name may use letters, digits and dashes (for example Authorization or X-Api-Key).');
  if (!value || value.length > 2000 || /[\r\n]/.test(value)) throw feedError('Enter the header value on one line (at most 2,000 characters).');
  return { name, value };
}

/** Pure: what kind of file these bytes are. */
function sniff(bytes, contentType = '', url = '') {
  const ct = String(contentType).toLowerCase();
  const path = (() => { try { return new URL(url).pathname.toLowerCase(); } catch { return ''; } })();
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) return 'xlsx';
  if (/json/.test(ct) || /\.json$/.test(path)) return 'json';
  const head = bytes.subarray(0, 200).toString('utf8').replace(/^﻿/, '').trimStart();
  if (head.startsWith('[') || head.startsWith('{')) return 'json';
  if (/<html|<!doctype/i.test(head)) return 'html';
  return 'csv';
}

/** One downloaded file (any source) as what the import reads: CSV or XLSX bytes. */
function fileFromBytes(bytes, rawName, contentType = '', htmlMessage = 'That is a web page, not a file.') {
  const name = String(rawName || 'file').replace(/[\u0000-\u001f/\\]/g, '').slice(0, 150) || 'file';
  const type = sniff(bytes, contentType, `https://x/${encodeURIComponent(name)}`);
  if (type === 'html') throw feedError(htmlMessage, 502);
  if (type === 'xlsx') return { buffer: bytes, filename: /\.xlsx$/i.test(name) ? name : `${name}.xlsx`, rowsReceived: null };
  if (type === 'json') {
    let doc;
    try { doc = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); } catch { throw feedError(`${name} is JSON that could not be read.`, 502); }
    const rows = rowsFromJson(doc);
    return { buffer: rows.length ? rowsToCsv(rows) : Buffer.alloc(0), filename: `${name.replace(/\.json$/i, '')}.csv`, rowsReceived: rows.length };
  }
  return { buffer: bytes, filename: /\.(csv|tsv|txt)$/i.test(name) ? name.replace(/\.(tsv|txt)$/i, '.csv') : `${name}.csv`, rowsReceived: null };
}

async function fetchFileUrl(rawUrl, header = null) {
  let url = normalizeFileUrl(rawUrl);
  const origin = new URL(url).host;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const sameHost = new URL(url).host === origin;
    let r;
    try {
      r = await requestImpl(url, {
        method: 'GET', headers: { Accept: 'text/csv, application/json, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, */*', ...(header && sameHost ? { [header.name]: header.value } : {}) },
        maxBytes: MAX_FILE_BYTES, timeoutMs: 30000, ...requestOptions,
      });
    } catch (err) {
      if (err.code === 'TOO_LARGE') throw feedError('The file is larger than 15 MB. Export fewer rows per file.', 413);
      if (err.code === 'URL_REFUSED') throw feedError(err.message);
      throw feedError(`Could not read the file: ${err.message}`, 502);
    }
    if (r.status >= 300 && r.status < 400 && r.headers.location) {
      const next = new URL(r.headers.location, url);
      if (next.protocol !== 'https:' && !(requestOptions.allowHttp && next.protocol === 'http:')) throw feedError('The file address redirected to a non-https address; it was not followed.', 502);
      url = next.toString();
      continue;
    }
    if (r.status === 401 || r.status === 403) throw feedError(`The file address refused access (HTTP ${r.status}). Check the link is shared, or add the header your system needs.`, 502);
    if (r.status === 404) throw feedError('Nothing was found at that address (HTTP 404).', 502);
    if (r.status !== 200) throw feedError(`The file address answered HTTP ${r.status}.`, 502);
    const bytes = r.bytes || Buffer.from(r.body || '', 'utf8');
    const name = decodeURIComponent((new URL(url).pathname.split('/').pop() || 'file').slice(0, 120)) || 'file';
    return fileFromBytes(bytes, name, r.headers['content-type'], 'That address returned a web page, not a file. Use the direct download link (for a shared file, the link that downloads it).');
  }
  throw feedError('Too many redirects while reading the file.', 502);
}

/** A connected app's rows for one kind. */
async function fetchApp(pool, userId, { connectorId }, kind) {
  const p = provider(connectorId);
  if (!p || !p.feedKinds) throw feedError('That app cannot feed records.');
  if (!p.feedKinds.includes(kind)) throw feedError(`${connectorId.replace(/_/g, ' ')} cannot feed ${kind.replace(/_/g, ' ')}.`);
  if (!isLive(connectorId)) throw feedError(`${connectorId.replace(/_/g, ' ')} is not switched on on this server yet.`, 409);
  const account = await accounts.getAccount(pool, userId, connectorId);
  if (!account) throw feedError(`Connect ${connectorId.replace(/_/g, ' ')} under Sources first.`, 409);
  if (account.status === 'AUTH_REQUIRED') throw Object.assign(feedError(`Connect ${connectorId.replace(/_/g, ' ')} again: ${account.status_reason || 'its access was refused.'}`, 409), { kind: 'AUTH_EXPIRED' });
  const { get } = await accounts.clientFor(pool, account);
  const out = await p.feedRows(get, kind, account.config || {});
  return {
    buffer: out.rows.length ? rowsToCsv(out.rows) : Buffer.alloc(0),
    filename: `${account.account_label || connectorId} ${kind}.csv`.replace(/[^\p{L}\p{N} ._()-]/gu, '').slice(0, 150),
    rowsReceived: out.rows.length,
    truncated: !!out.truncated,
    currency: out.currency || null,
    label: account.account_label || connectorId,
  };
}

/** Pushed rows (JSON value or CSV text) → file. */
function fromPush(body, contentType = '') {
  if (Buffer.isBuffer(body) || typeof body === 'string') {
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
    const type = sniff(bytes, contentType);
    if (type === 'json') {
      let doc;
      try { doc = JSON.parse(bytes.toString('utf8').replace(/^﻿/, '')); } catch { throw feedError('The body is not valid JSON.'); }
      return fromPush(doc);
    }
    if (type === 'xlsx') return { buffer: bytes, filename: 'pushed.xlsx', rowsReceived: null };
    if (type === 'html') throw feedError('Send CSV, JSON or an Excel file.');
    return { buffer: bytes, filename: 'pushed.csv', rowsReceived: null };
  }
  const rows = rowsFromJson(body);
  return { buffer: rows.length ? rowsToCsv(rows) : Buffer.alloc(0), filename: 'pushed.csv', rowsReceived: rows.length };
}

/** Tally rows the bridge sent (raw Tally XML export) → file. */
function fromTally(delivery, kind) {
  const out = tallyFeedRows(kind, delivery || {});
  return { buffer: out.rows.length ? rowsToCsv(out.rows) : Buffer.alloc(0), filename: `Tally ${kind}.csv`, rowsReceived: out.rows.length, currency: null, label: 'Tally' };
}

/**
 * Reads a feed's source. `secret` is the decrypted file_url header or SFTP
 * password/key. `state` is what the source remembered last time; a returned
 * `state` replaces it (SFTP host key, last file or email read).
 */
async function readSource(pool, userId, { sourceType, source, kind, secret = null, state = {} }) {
  if (sourceType === 'sftp') {
    const got = await readSftp(source, secret, { knownHostKey: state.hostKey || null });
    const nextState = { ...state, hostKey: state.hostKey || got.hostKey || null };
    if (!got.bytes) return { buffer: Buffer.alloc(0), filename: null, rowsReceived: 0, note: got.note, state: nextState };
    return { ...fileFromBytes(got.bytes, got.filename), state: { ...nextState, lastFile: got.filename, lastFileModifiedAt: got.modifiedAt }, origin: `${got.filename}${got.modifiedAt ? `, changed ${got.modifiedAt.slice(0, 16).replace('T', ' ')} UTC` : ''}` };
  }
  if (sourceType === 'email') {
    const got = await readEmailDrop(pool, userId, source);
    if (!got.bytes) return { buffer: Buffer.alloc(0), filename: null, rowsReceived: 0, note: got.note, state };
    return { ...fileFromBytes(got.bytes, got.filename), state: { ...state, lastMessageId: got.messageId, lastReceivedAt: got.receivedAt }, origin: `${got.filename} from the email "${String(got.subject || '').slice(0, 80)}"${got.receivedAt ? ` (${got.receivedAt.slice(0, 16).replace('T', ' ')} UTC)` : ''}` };
  }
  if (sourceType === 'tally') throw feedError('Tally records arrive from the Starlane bridge on the computer running Tally; there is nothing to read from here. Run the bridge, or wait for its next sync.', 409);
  if (sourceType === 'sheet_link') {
    const s = await fetchSheetCsv(source.url, requestImpl === safeRequest ? {} : { request: (u, o) => requestImpl(u, { ...o, ...requestOptions }) });
    return { buffer: s.buffer, filename: s.filename, rowsReceived: null };
  }
  if (sourceType === 'file_url') return fetchFileUrl(source.url, secret);
  if (sourceType === 'app') return fetchApp(pool, userId, source, kind);
  throw feedError('This feed receives pushed rows; there is nothing to read.');
}

module.exports = { readSource, fetchFileUrl, fetchApp, fromPush, fromTally, fileFromBytes, normalizeFileUrl, checkHeader, sniff, __setTestRequest, MAX_FILE_BYTES };
