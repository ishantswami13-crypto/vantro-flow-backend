'use strict';
// lib/connectors/sheetLink.js — import a Google Sheet from its share link.
//
// The owner shares the sheet as "Anyone with the link can view" and pastes
// the link. Starlane downloads that one tab as CSV and hands it to the same
// ledger import as an uploaded file (preview, confirmed mapping, commit), so
// a sheet gets exactly the checks a file gets. No Google account access is
// needed or requested.
//
// Only docs.google.com links are accepted, and only redirects to Google's
// own download hosts are followed.

const { safeRequest } = require('./safeHttp');

const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED_REDIRECT_HOST = /(^|\.)googleusercontent\.com$|^docs\.google\.com$/;

function sheetError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

/** Pure: a share link → { id, gid, csvUrl }. */
function parseSheetUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { throw sheetError('Paste the link to a Google Sheet (https://docs.google.com/spreadsheets/…).'); }
  if (u.protocol !== 'https:' || u.hostname !== 'docs.google.com') throw sheetError('Paste the link to a Google Sheet (https://docs.google.com/spreadsheets/…).');
  const m = /^\/spreadsheets\/d\/([A-Za-z0-9_-]{20,100})/.exec(u.pathname);
  if (!m) throw sheetError('That link is not to a Google Sheet.');
  const gidMatch = /(?:^|[#&?])gid=(\d{1,12})/.exec(`${u.search}${u.hash}`);
  const gid = gidMatch ? gidMatch[1] : '0';
  return { id: m[1], gid, csvUrl: `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv&gid=${gid}` };
}

/** Downloads the tab as CSV. Returns { buffer, filename, sheetId, gid }. */
async function fetchSheetCsv(raw, { request = safeRequest } = {}) {
  const { id, gid, csvUrl } = parseSheetUrl(raw);
  let url = csvUrl;
  for (let hop = 0; hop < 4; hop++) {
    const r = await request(url, { method: 'GET', headers: { Accept: 'text/csv' }, maxBytes: MAX_BYTES, timeoutMs: 20000 });
    if (r.status >= 300 && r.status < 400 && r.headers.location) {
      const next = new URL(r.headers.location, url);
      if (next.protocol !== 'https:' || !ALLOWED_REDIRECT_HOST.test(next.hostname)) throw sheetError('Google sent the download somewhere unexpected; the import was stopped.', 502);
      url = next.toString();
      continue;
    }
    if (r.status === 401 || r.status === 403 || r.status === 404 || /accounts\.google\.com/.test(String(r.headers.location || ''))
      || /<html/i.test(r.body.slice(0, 200))) {
      throw sheetError('Starlane could not open that sheet. In Google Sheets choose Share › General access › Anyone with the link (Viewer), then try again.');
    }
    if (r.status !== 200) throw sheetError(`Google answered HTTP ${r.status} for that sheet.`, 502);
    if (!r.body.trim()) throw sheetError('That tab of the sheet is empty.');
    return { buffer: Buffer.from(r.body, 'utf8'), filename: `Google Sheet (${id.slice(0, 8)}, tab ${gid}).csv`, sheetId: id, gid };
  }
  throw sheetError('Too many redirects while downloading the sheet.', 502);
}

module.exports = { parseSheetUrl, fetchSheetCsv };
