'use strict';
// lib/connectors/safeHttp.js — outbound HTTP to a URL a tenant typed in.
//
// A workflow that calls "any software" sends a request to an address the
// owner chose, from inside our network. This is the one place that does it,
// and it refuses what would turn that into a way into our infrastructure
// (server-side request forgery):
//   - https only (http is allowed for tests through an explicit option);
//   - the host is resolved once and the connection is pinned to that address
//     (the check runs inside the socket's DNS lookup, so a DNS answer cannot
//     change between the check and the connect);
//   - loopback, private, link-local (cloud metadata), CGNAT, multicast and
//     reserved ranges are refused, for IPv4 and IPv6;
//   - no redirects are followed; a 3xx comes back as the response;
//   - a timeout, and a cap on the response size.
// Response bodies are returned as text (JSON parsed when it is JSON).

const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');

const MAX_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 15000;

function ipv4Blocked(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return true;
  const [a, b] = p;
  if (a === 0 || a === 10 || a === 127) return true;               // this network, private, loopback
  if (a === 100 && b >= 64 && b <= 127) return true;               // CGNAT
  if (a === 169 && b === 254) return true;                         // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;                // private
  if (a === 192 && b === 168) return true;                         // private
  if (a === 192 && b === 0 && p[2] === 0) return true;             // IETF protocol assignments
  if (a === 192 && b === 0 && p[2] === 2) return true;             // documentation
  if (a === 198 && (b === 18 || b === 19)) return true;            // benchmarking
  if (a === 198 && b === 51 && p[2] === 100) return true;          // documentation
  if (a === 203 && b === 0 && p[2] === 113) return true;           // documentation
  if (a >= 224) return true;                                       // multicast, reserved, broadcast
  return false;
}

function ipv6Blocked(ip) {
  const s = ip.toLowerCase().split('%')[0];
  if (s === '::' || s === '::1') return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (mapped) return ipv4Blocked(mapped[1]);
  if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(s)) return true;  // mapped, hex form: refuse rather than decode
  const first = parseInt(s.split(':')[0] || '0', 16);
  if ((first & 0xfe00) === 0xfc00) return true;                    // unique local fc00::/7
  if ((first & 0xffc0) === 0xfe80) return true;                    // link-local fe80::/10
  if ((first & 0xff00) === 0xff00) return true;                    // multicast
  if (s.startsWith('64:ff9b:')) return true;                       // NAT64 can reach IPv4 private space
  if (s.startsWith('2001:db8:') || s.startsWith('2001:0db8:')) return true; // documentation
  return false;
}

function addressBlocked(ip) {
  const v = net.isIP(ip);
  if (v === 4) return ipv4Blocked(ip);
  if (v === 6) return ipv6Blocked(ip);
  return true;
}

function urlError(message) {
  return Object.assign(new Error(message), { status: 400, code: 'URL_REFUSED' });
}

/** Parses and checks a URL a tenant entered. Throws with a plain reason. */
function checkUrl(raw, { allowHttp = false, allowPrivate = false } = {}) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { throw urlError('Enter a full web address, starting with https://'); }
  if (u.protocol !== 'https:' && !(allowHttp && u.protocol === 'http:')) throw urlError('Only https:// addresses are allowed.');
  if (u.username || u.password) throw urlError('Put credentials in the connection’s secret, not in the address.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (allowPrivate) return u;
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) throw urlError('That address points inside a private network.');
  if (net.isIP(host) && addressBlocked(host)) throw urlError('That address points inside a private network.');
  return u;
}

function pinnedLookup(allowPrivate) {
  return (hostname, options, cb) => {
    dns.lookup(hostname, { all: true, verbatim: true }, (err, addrs) => {
      if (err) return cb(err);
      const list = Array.isArray(addrs) ? addrs : [{ address: addrs, family: net.isIP(addrs) }];
      const ok = list.filter((a) => allowPrivate || !addressBlocked(a.address));
      if (!ok.length) return cb(Object.assign(new Error('That address resolves inside a private network.'), { code: 'URL_REFUSED' }));
      if (options && options.all) return cb(null, ok);
      return cb(null, ok[0].address, ok[0].family);
    });
  };
}

/**
 * Sends one request. Returns { status, headers, body, json }.
 * Never follows redirects. Throws { code: 'URL_REFUSED' | 'TIMEOUT' | 'NETWORK' | 'TOO_LARGE' }.
 */
function safeRequest(rawUrl, { method = 'GET', headers = {}, body = null, timeoutMs = DEFAULT_TIMEOUT_MS, allowHttp = false, allowPrivate = false, maxBytes = MAX_RESPONSE_BYTES } = {}) {
  const u = checkUrl(rawUrl, { allowHttp, allowPrivate });
  const lib = u.protocol === 'https:' ? https : http;
  const payload = body === null || body === undefined ? null : (typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = lib.request(u, {
      method,
      headers: { 'User-Agent': 'Starlane-Workflows/1.0', ...headers, ...(payload !== null ? { 'Content-Length': Buffer.byteLength(payload) } : {}) },
      lookup: pinnedLookup(allowPrivate),
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) { req.destroy(Object.assign(new Error('The response was too large.'), { code: 'TOO_LARGE' })); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        if (/json/i.test(String(res.headers['content-type'] || ''))) { try { json = JSON.parse(text); } catch { json = null; } }
        resolve({ status: res.statusCode, headers: res.headers, body: text, json });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('The request timed out.'), { code: 'TIMEOUT' })));
    req.on('error', (err) => reject(err.code === 'URL_REFUSED' || err.code === 'TIMEOUT' || err.code === 'TOO_LARGE'
      ? err : Object.assign(new Error(`Could not reach ${u.hostname}: ${err.code || err.message}`), { code: 'NETWORK' })));
    if (payload !== null) req.write(payload);
    req.end();
  });
}

module.exports = { safeRequest, checkUrl, addressBlocked, ipv4Blocked, ipv6Blocked, MAX_RESPONSE_BYTES };
