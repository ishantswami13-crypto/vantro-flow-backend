// FILE: lib/access/artifacts.js
// What an approved applicant can download.
//
//   tally-bridge  — the real Starlane Tally bridge (tally-connector/tally-sync.mjs),
//                   served from this repository, with its SHA-256 so it can be
//                   verified. Requires Node.js 18+ on the Tally machine.
//   desktop-*     — the Starlane desktop app, per OS. Listed only as
//                   "not published" until a signed build URL is configured
//                   (DESKTOP_DOWNLOAD_URL_WINDOWS / _MACOS / _LINUX). We never
//                   point at a build that does not exist.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BRIDGE_PATH = path.join(__dirname, '..', '..', 'tally-connector', 'tally-sync.mjs');

let bridgeCache = null;
function bridgeFile() {
  if (!bridgeCache) {
    const content = fs.readFileSync(BRIDGE_PATH);
    bridgeCache = { content, sha256: crypto.createHash('sha256').update(content).digest('hex'), bytes: content.length };
  }
  return bridgeCache;
}

function listArtifacts() {
  const bridge = bridgeFile();
  const desktop = [
    ['desktop-windows', 'Starlane for Windows', 'windows', process.env.DESKTOP_DOWNLOAD_URL_WINDOWS],
    ['desktop-macos', 'Starlane for macOS', 'macos', process.env.DESKTOP_DOWNLOAD_URL_MACOS],
    ['desktop-linux', 'Starlane for Linux', 'linux', process.env.DESKTOP_DOWNLOAD_URL_LINUX],
  ].map(([id, name, os, url]) => ({
    id, name, os, kind: 'desktop',
    available: typeof url === 'string' && /^https:\/\//.test(url),
    note: url ? null : 'Not published yet. Starlane runs in the browser today; the Tally bridge covers the local connection.',
  }));
  return [
    {
      id: 'tally-bridge',
      name: 'Starlane Tally bridge',
      os: 'any',
      kind: 'bridge',
      available: true,
      filename: 'tally-sync.mjs',
      bytes: bridge.bytes,
      sha256: bridge.sha256,
      requirements: 'Node.js 18 or newer on the computer running TallyPrime.',
      note: null,
    },
    ...desktop,
  ];
}

function artifactPayload(id) {
  if (id === 'tally-bridge') {
    const b = bridgeFile();
    return { type: 'file', filename: 'tally-sync.mjs', contentType: 'text/javascript; charset=utf-8', content: b.content, sha256: b.sha256 };
  }
  const a = listArtifacts().find((x) => x.id === id);
  if (!a || !a.available) return null;
  const url = process.env[`DESKTOP_DOWNLOAD_URL_${a.os.toUpperCase()}`];
  return { type: 'redirect', url };
}

module.exports = { listArtifacts, artifactPayload };
