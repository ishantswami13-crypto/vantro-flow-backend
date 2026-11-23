'use strict';
// lib/connectors/feeds/sftp.js — read the newest export file from a folder
// on an SFTP server.
//
// Many ERPs, warehouse systems and distributor portals drop a scheduled
// export (CSV or Excel) into an SFTP folder. A feed points at the server,
// the folder and a file name pattern; each run downloads the newest matching
// file and hands it to the same checked import as an upload.
//
// Safety:
//   - The host is resolved once, every address is checked against the same
//     private/internal ranges safeHttp refuses, and the connection goes to
//     that checked address (a DNS answer cannot change in between).
//   - The server's host key is pinned on the first successful read
//     (fingerprint stored on the feed). A different key later is refused and
//     the feed asks the owner, as an ssh client would.
//   - Read only: the session lists one folder and reads one file. It never
//     writes, renames or deletes, so a file is never "consumed".
//   - Files over 15 MB are refused; every step has a time limit.
//   - The password or private key is passed in already decrypted and never
//     logged or returned.

const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const { addressBlocked } = require('../safeHttp');
const { feedError } = require('./tabular');

const HOST_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const USER_RE = /^[A-Za-z0-9._@+-]{1,100}$/;
const PATTERN_RE = /^[\p{L}\p{N} ._*?()[\]&+@#,-]{1,120}$/u;
const MAX_BYTES = 15 * 1024 * 1024;
const TIMEOUT_MS = 45000;

let testOptions = null;
/** Tests reach a local SFTP server. Production never calls it. */
function __setTestSftp(o) { testOptions = o; }

/** Pure: checks the non-secret SFTP settings. */
function checkSftpConfig(src = {}) {
  const host = String(src.host || '').trim().toLowerCase();
  if (!HOST_RE.test(host) && !net.isIP(host)) throw feedError('Enter the SFTP server name, for example sftp.example.com (no sftp:// and no folder).');
  const port = src.port === undefined || src.port === null || src.port === '' ? 22 : Number(src.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw feedError('The port is a number from 1 to 65535 (usually 22).');
  const username = String(src.username || '').trim();
  if (!USER_RE.test(username)) throw feedError('Enter the SFTP user name.');
  let folder = String(src.folder || '/').trim() || '/';
  if (!folder.startsWith('/')) folder = `/${folder}`;
  if (folder.length > 300 || /[\0\r\n]|(^|\/)\.\.(\/|$)/.test(folder)) throw feedError('Enter the folder as a path such as /exports/orders.');
  const pattern = String(src.pattern || '*.csv').trim();
  if (!PATTERN_RE.test(pattern) || pattern.includes('/')) throw feedError('Enter a file name or pattern such as orders-*.csv (no folders).');
  return { host, port, username, folder: folder.replace(/\/+$/, '') || '/', pattern };
}

/** Pure: checks the secret part. Either a password, or a private key (with an optional passphrase). */
function checkSftpSecret(s = {}) {
  const password = s.password ? String(s.password) : '';
  const privateKey = s.privateKey ? String(s.privateKey).trim() : '';
  if (!password && !privateKey) throw feedError('Enter the password, or paste the private key.');
  if (password && password.length > 500) throw feedError('The password is too long.');
  if (privateKey && (privateKey.length > 20000 || !/^-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(privateKey))) throw feedError('Paste the whole private key, starting with -----BEGIN … PRIVATE KEY-----.');
  return privateKey ? { privateKey, ...(s.passphrase ? { passphrase: String(s.passphrase).slice(0, 500) } : {}) } : { password };
}

/** Pure: a file name pattern (* and ?) as a case-insensitive whole-name test. */
function patternTest(pattern) {
  const re = new RegExp(`^${String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
  return (name) => re.test(name);
}

/** Pure: the newest regular file whose name matches, from readdir entries. */
function pickNewest(entries, pattern) {
  const test = patternTest(pattern);
  return entries
    .filter((e) => e && e.filename && !e.filename.startsWith('.') && test(e.filename) && (e.attrs?.isFile ? e.attrs.isFile() : ((e.attrs?.mode ?? 0o100000) & 0o170000) === 0o100000))
    .sort((a, b) => (b.attrs?.mtime || 0) - (a.attrs?.mtime || 0) || a.filename.localeCompare(b.filename))[0] || null;
}

const fingerprint = (key) => `SHA256:${crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;

async function checkedAddress(host) {
  if (testOptions?.allowPrivate) return net.isIP(host) ? host : (await dns.lookup(host)).address;
  if (net.isIP(host)) {
    if (addressBlocked(host)) throw feedError('That address is private or internal; Starlane only connects to public servers.');
    return host;
  }
  let addrs;
  try { addrs = await dns.lookup(host, { all: true, verbatim: true }); } catch { throw feedError(`The server name ${host} could not be found.`, 502); }
  const ok = addrs.filter((a) => !addressBlocked(a.address));
  if (!ok.length || ok.length !== addrs.length) throw feedError('That server name points to a private or internal address; Starlane only connects to public servers.');
  return ok[0].address;
}

/**
 * Downloads the newest matching file. `knownHostKey` is the pinned
 * fingerprint, if any. Returns { bytes, filename, modifiedAt, hostKey } or
 * { bytes: null, note } when no file matches.
 */
async function readSftp(config, secret, { knownHostKey = null } = {}) {
  const { Client } = require('ssh2');
  const c = checkSftpConfig(config);
  if (!secret) throw feedError('The saved SFTP password or key cannot be read on this server. Edit the feed and enter it again.', 503);
  const address = await checkedAddress(c.host);
  const conn = new Client();
  let seenKey = null;
  let keyRefused = false;
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { conn.end(); reject(feedError('The SFTP server did not answer in time.', 504)); }, testOptions?.timeoutMs || TIMEOUT_MS);
    const fail = (err) => { clearTimeout(timer); conn.end(); reject(err); };
    conn.on('error', (err) => {
      if (keyRefused) return fail(Object.assign(feedError(`The SFTP server's identity changed (host key ${seenKey}, expected ${knownHostKey}). If the server was really replaced, delete this feed and add it again.`, 409), { needsOwner: true }));
      if (err.level === 'client-authentication') return fail(feedError('The SFTP server refused the user name, password or key.', 401));
      fail(feedError(`Could not connect to the SFTP server: ${String(err.message).slice(0, 120)}`, 502));
    });
    conn.on('ready', () => {
      conn.sftp((err, sftp) => {
        if (err) return fail(feedError('The server accepted the sign-in but does not offer SFTP.', 502));
        sftp.readdir(c.folder, (e2, list) => {
          if (e2) return fail(feedError(e2.code === 2 ? `The folder ${c.folder} does not exist on the server.` : e2.code === 3 ? `The user cannot read the folder ${c.folder}.` : `Could not list ${c.folder}.`, 400));
          const file = pickNewest(list || [], c.pattern);
          if (!file) { clearTimeout(timer); conn.end(); return resolve({ bytes: null, hostKey: seenKey, note: `No file in ${c.folder} matches ${c.pattern}.` }); }
          if ((file.attrs?.size || 0) > MAX_BYTES) return fail(feedError(`${file.filename} is larger than 15 MB. Export fewer rows per file.`, 413));
          const path = `${c.folder === '/' ? '' : c.folder}/${file.filename}`;
          const chunks = [];
          let size = 0;
          const stream = sftp.createReadStream(path);
          stream.on('data', (d) => {
            size += d.length;
            if (size > MAX_BYTES) { stream.destroy(); fail(feedError(`${file.filename} is larger than 15 MB.`, 413)); } else chunks.push(d);
          });
          stream.on('error', () => fail(feedError(`Could not read ${file.filename}.`, 502)));
          stream.on('end', () => {
            clearTimeout(timer);
            conn.end();
            resolve({ bytes: Buffer.concat(chunks), filename: file.filename, modifiedAt: file.attrs?.mtime ? new Date(file.attrs.mtime * 1000).toISOString() : null, hostKey: seenKey });
          });
        });
      });
    });
  });
  conn.connect({
    host: address, port: c.port, username: c.username, ...secret,
    readyTimeout: 20000, keepaliveInterval: 0, tryKeyboard: false,
    hostVerifier: (key) => {
      seenKey = fingerprint(key);
      if (knownHostKey && seenKey !== knownHostKey) { keyRefused = true; return false; }
      return true;
    },
  });
  return done;
}

module.exports = { readSftp, checkSftpConfig, checkSftpSecret, patternTest, pickNewest, fingerprint, __setTestSftp, MAX_BYTES };
