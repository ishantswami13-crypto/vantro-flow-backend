'use strict';
// SAML 2.0 service provider for organization single sign-on (Okta, Microsoft
// Entra ID, Google Workspace, OneLogin, JumpCloud, ADFS, PingFederate …).
//
// XML signature checking is done by @node-saml/node-saml (xml-crypto), not by
// hand: hand-written XML-DSig checks are a classic source of sign-in bypasses
// (signature wrapping, comment injection). Settings used:
//   - the assertion itself must be signed by one of the organization's IdP
//     certificates (wantAssertionsSigned); a signed response wrapping an
//     unsigned assertion is refused
//   - Issuer must equal the IdP entity ID the admin saved (idpIssuer)
//   - Audience must be Starlane's SP entity ID
//   - InResponseTo must name the request this server made for this sign-in
//     (validateInResponseTo: always). The request ID lives in the single-use
//     state row, so a response is accepted once, and IdP-initiated sign-in
//     (no request) is refused
//   - NotBefore / NotOnOrAfter are enforced with 60 seconds of clock skew
// and two checks node-saml 5 only warns about, done here on the verified
// assertion: a bearer SubjectConfirmation's Recipient must be the ACS URL,
// and the assertion signature must not use SHA-1.
// Encrypted assertions are not supported (TLS protects them in transit).

const crypto = require('crypto');
const { DOMParser } = require('@xmldom/xmldom');
const { SAML } = require('@node-saml/node-saml');
const { checkUrl } = require('../connectors/safeHttp');
const { badRequest } = require('../platform/errors');

const MD = 'urn:oasis:names:tc:SAML:2.0:metadata';
const DS = 'http://www.w3.org/2000/09/xmldsig#';
const REDIRECT = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect';
const EMAIL_FORMAT = 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress';
const EMAIL_ATTRS = [
  'email', 'mail', 'emailaddress', 'Email', 'EmailAddress', 'User.Email',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
  'urn:oid:0.9.2342.19200300.100.1.3',
];
const NAME_ATTRS = ['displayName', 'name', 'http://schemas.microsoft.com/identity/claims/displayname', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name', 'urn:oid:2.16.840.1.113730.3.1.241'];

let testOptions = {};
function __setTestOptions(o = {}) { testOptions = o; }

/** Starlane's SP endpoints, derived from the OIDC callback URL's base. */
function spUrls(redirectUri) {
  const base = String(redirectUri || '').replace(/\/callback$/, '');
  return { entityId: `${base}/saml/metadata`, acsUrl: `${base}/saml/acs`, metadataUrl: `${base}/saml/metadata` };
}

function pemFromBase64(b64) {
  const body = String(b64 || '').replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/=]{100,}$/.test(body)) throw badRequest('The IdP certificate is not a base64 X.509 certificate.');
  const pem = `-----BEGIN CERTIFICATE-----\n${body.match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
  try { new crypto.X509Certificate(pem); } catch { throw badRequest('The IdP certificate could not be read.'); }
  return pem;
}

function describeCert(pem) {
  try {
    const c = new crypto.X509Certificate(pem);
    return { subject: c.subject.split('\n').find((l) => l.startsWith('CN=')) || c.subject.split('\n')[0], validTo: new Date(c.validTo).toISOString(), expired: new Date(c.validTo) < new Date(), sha256: c.fingerprint256 };
  } catch { return { subject: 'unreadable', validTo: null, expired: true, sha256: null }; }
}

function describe(cfg) {
  if (!cfg) return null;
  return { ssoUrl: cfg.ssoUrl, certificates: (cfg.certs || []).map(describeCert), emailAttribute: cfg.emailAttribute || null };
}

function parseMetadata(xml) {
  if (String(xml).length > 512 * 1024) throw badRequest('That metadata document is too large.');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw badRequest('Metadata with a DOCTYPE or entities is not accepted.');
  let doc;
  const errors = [];
  try {
    doc = new DOMParser({ onError: (level, msg) => { if (level !== 'warning') errors.push(msg); } }).parseFromString(String(xml), 'text/xml');
  } catch (err) { throw badRequest(`The metadata is not valid XML: ${String(err.message).slice(0, 120)}`); }
  if (errors.length || !doc || !doc.documentElement) throw badRequest('The metadata is not valid XML.');
  const ed = doc.documentElement.localName === 'EntityDescriptor' ? doc.documentElement : doc.getElementsByTagNameNS(MD, 'EntityDescriptor')[0];
  if (!ed) throw badRequest('No EntityDescriptor found in the metadata.');
  const idp = ed.getElementsByTagNameNS(MD, 'IDPSSODescriptor')[0];
  if (!idp) throw badRequest('The metadata has no IDPSSODescriptor; it may be service provider metadata.');
  const sso = Array.from(idp.getElementsByTagNameNS(MD, 'SingleSignOnService')).find((n) => n.getAttribute('Binding') === REDIRECT);
  if (!sso) throw badRequest('The metadata has no SingleSignOnService with the HTTP-Redirect binding.');
  const certs = Array.from(idp.getElementsByTagNameNS(MD, 'KeyDescriptor'))
    .filter((k) => !k.getAttribute('use') || k.getAttribute('use') === 'signing')
    .map((k) => k.getElementsByTagNameNS(DS, 'X509Certificate')[0]?.textContent)
    .filter(Boolean);
  return { entityId: ed.getAttribute('entityID'), ssoUrl: sso.getAttribute('Location'), certs };
}

/** Admin input (metadata XML, or the three values) -> validated config. */
function parseIdpInput(input = {}) {
  let { entityId, ssoUrl, certificate } = input;
  let certs = certificate ? [certificate] : [];
  if (input.metadataXml) {
    const md = parseMetadata(input.metadataXml);
    entityId = md.entityId; ssoUrl = md.ssoUrl; certs = md.certs;
  }
  entityId = String(entityId || '').trim();
  if (!entityId || entityId.length > 500) throw badRequest('Enter the identity provider entity ID (issuer).');
  try { ssoUrl = checkUrl(String(ssoUrl || '').trim(), testOptions.http || {}).toString(); } catch (err) { throw badRequest(`Sign-on URL: ${err.message}`); }
  if (!certs.length) throw badRequest('Add the identity provider signing certificate.');
  if (certs.length > 3) certs = certs.slice(0, 3);
  const pems = [...new Set(certs.map(pemFromBase64))];
  const emailAttribute = input.emailAttribute ? String(input.emailAttribute).trim().slice(0, 200) : null;
  return { entityId, ssoUrl, certs: pems, emailAttribute };
}

function client(conn, redirectUri, cacheProvider) {
  const sp = spUrls(redirectUri);
  return new SAML({
    issuer: sp.entityId,
    callbackUrl: sp.acsUrl,
    audience: sp.entityId,
    entryPoint: conn.saml.ssoUrl,
    idpIssuer: conn.issuer,
    idpCert: conn.saml.certs,
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: false,
    signatureAlgorithm: 'sha256',
    digestAlgorithm: 'sha256',
    identifierFormat: EMAIL_FORMAT,
    disableRequestedAuthnContext: true,
    validateInResponseTo: 'always',
    requestIdExpirationPeriodMs: 10 * 60 * 1000,
    acceptedClockSkewMs: 60 * 1000,
    cacheProvider,
  });
}

/** A redirect to the IdP plus the AuthnRequest ID to remember for this sign-in. */
async function authorizeUrl(conn, { relayState, redirectUri }) {
  let requestId = null;
  const capture = {
    saveAsync: async (key, value) => { requestId = key; return { value, createdAt: Date.now() }; },
    getAsync: async () => null,
    removeAsync: async () => null,
  };
  const url = await client(conn, redirectUri, capture).getAuthorizeUrlAsync(relayState, undefined, {});
  if (!requestId) throw new Error('SAML request ID was not generated');
  return { url, requestId };
}

/** Verifies a SAMLResponse against this connection and the one expected request. Returns the profile. */
async function validateResponse(conn, { SAMLResponse, requestId, redirectUri }) {
  let open = true;
  const instant = new Date().toISOString();
  const once = {
    saveAsync: async () => null,
    getAsync: async (key) => (open && key === requestId ? instant : null),
    removeAsync: async (key) => { if (key === requestId) open = false; return null; },
    consumeAsync: async (key) => { if (open && key === requestId) { open = false; return instant; } return null; },
  };
  refuseWeakAlgorithms(SAMLResponse);
  let result;
  try {
    result = await client(conn, redirectUri, once).validatePostResponseAsync({ SAMLResponse });
  } catch (err) {
    throw badRequest(`The SAML response was refused: ${String(err.message || err).replace(/\s+/g, ' ').slice(0, 160)}`);
  }
  if (!result || result.loggedOut || !result.profile) throw badRequest('The SAML response did not sign anyone in.');
  checkVerifiedAssertion(result.profile, spUrls(redirectUri).acsUrl);
  return result.profile;
}

const SAML_NS = 'urn:oasis:names:tc:SAML:2.0:assertion';
const WEAK_ALGS = new Set(['http://www.w3.org/2000/09/xmldsig#rsa-sha1', 'http://www.w3.org/2000/09/xmldsig#sha1', 'http://www.w3.org/2000/09/xmldsig#dsa-sha1']);

// The verified assertion comes back without its Signature element, so the
// algorithms are read from the response as received. Any SHA-1 anywhere is
// refused: an attacker can only make a response fail this way, never pass.
function refuseWeakAlgorithms(SAMLResponse) {
  const xml = Buffer.from(String(SAMLResponse), 'base64').toString('utf8');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw badRequest('A SAML response with a DOCTYPE is not accepted.');
  const doc = new DOMParser({ onError: () => {} }).parseFromString(xml, 'text/xml');
  for (const tag of ['SignatureMethod', 'DigestMethod']) {
    for (const n of Array.from(doc.getElementsByTagNameNS(DS, tag))) {
      if (WEAK_ALGS.has(n.getAttribute('Algorithm'))) throw badRequest('The SAML response is signed with SHA-1. Set the identity provider to SHA-256.');
    }
  }
}

function checkVerifiedAssertion(profile, acsUrl) {
  const xml = typeof profile.getAssertionXml === 'function' ? profile.getAssertionXml() : null;
  if (!xml) throw badRequest('The SAML assertion could not be read after verification.');
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const recipients = Array.from(doc.getElementsByTagNameNS(SAML_NS, 'SubjectConfirmation'))
    .filter((n) => n.getAttribute('Method') === 'urn:oasis:names:tc:SAML:2.0:cm:bearer')
    .flatMap((n) => Array.from(n.getElementsByTagNameNS(SAML_NS, 'SubjectConfirmationData')).map((d) => d.getAttribute('Recipient')));
  if (!recipients.length) throw badRequest('The SAML assertion has no bearer subject confirmation.');
  if (!recipients.some((r) => r === acsUrl)) throw badRequest(`The SAML assertion is addressed to another service (Recipient must be ${acsUrl}).`);
}

function first(v) { return Array.isArray(v) ? v[0] : v; }

function emailFrom(profile, cfg = {}) {
  const keys = cfg.emailAttribute ? [cfg.emailAttribute, ...EMAIL_ATTRS] : EMAIL_ATTRS;
  for (const k of keys) {
    const v = first(profile[k]);
    if (typeof v === 'string' && v.includes('@')) return v;
  }
  if (typeof profile.nameID === 'string' && profile.nameID.includes('@') && (!profile.nameIDFormat || /emailAddress|unspecified/.test(profile.nameIDFormat))) return profile.nameID;
  return null;
}

function nameFrom(profile) {
  for (const k of NAME_ATTRS) { const v = first(profile[k]); if (typeof v === 'string' && v.trim()) return v; }
  const given = first(profile.givenName || profile['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname']);
  const sur = first(profile.sn || profile.surname || profile['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname']);
  return [given, sur].filter((x) => typeof x === 'string').join(' ') || null;
}

/** SP metadata for admins to upload into their IdP. */
function metadata(redirectUri) {
  const sp = spUrls(redirectUri);
  const s = new SAML({ issuer: sp.entityId, callbackUrl: sp.acsUrl, idpCert: 'unused', identifierFormat: EMAIL_FORMAT, wantAssertionsSigned: true });
  return s.generateServiceProviderMetadata(null, null);
}

module.exports = { spUrls, parseIdpInput, parseMetadata, describe, authorizeUrl, validateResponse, emailFrom, nameFrom, metadata, __setTestOptions };
