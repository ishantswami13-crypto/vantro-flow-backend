// SAML 2.0 single sign-on against a mock identity provider that signs real
// assertions (xml-crypto, RSA-SHA256, a throwaway openssl certificate).
// Covers: metadata import, SP metadata, the test sign-in that activates the
// connection, a sign-in through the HTTP ACS route (single-use code in the
// fragment), and the attacks a SAML service provider must refuse: unsigned
// or tampered assertions, another IdP's key, signature wrapping, wrong
// issuer / audience / recipient, expired assertions, replays, a response to
// another request, IdP-initiated responses and SHA-1 signatures.
// Needs DATABASE_URL with migrations 072 to 077, and openssl on PATH.
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeChecker, openPool, seedUser, deleteUsers } from './helpers/httpHarness.mjs';

const require = createRequire(import.meta.url);
const express = require('express');
const jwt = require('jsonwebtoken');
const { SignedXml } = require('xml-crypto');
const sso = require('../lib/auth/sso');
const saml = require('../lib/auth/saml');
const { accountSecurityRouter } = require('../lib/routes/accountSecurity');
const { ensureOwnOrganization } = require('../lib/platform/context');

const { check, done } = makeChecker();
const pool = openPool();
const ready = await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'platform_sso_connections' AND column_name = 'saml'`);
if (!ready.rows[0]) { console.log('SKIP migration 077 not applied'); await pool.end(); process.exit(0); }

// ── Mock IdP keys ────────────────────────────────────────────────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saml-test-'));
function makeCert(name) {
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, `${name}.key`), '-out', path.join(dir, `${name}.crt`), '-days', '30', '-subj', `/CN=${name}`], { stdio: 'ignore' });
  } catch { console.log('SKIP openssl not available'); process.exit(0); }
  return { key: fs.readFileSync(path.join(dir, `${name}.key`), 'utf8'), cert: fs.readFileSync(path.join(dir, `${name}.crt`), 'utf8') };
}
const idpKeys = makeCert('mock-idp');
const rogueKeys = makeCert('rogue-idp');
fs.rmSync(dir, { recursive: true, force: true });
const certBody = (pem) => pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');

const IDP_ENTITY = 'https://idp.mock.test/saml';
const IDP_SSO = 'https://idp.mock.test/saml/sso';
const redirectUri = 'https://api.starlane.test/api/auth/sso/callback';
const sp = saml.spUrls(redirectUri);

function assertionXml({ id, email, inResponseTo, issuer = IDP_ENTITY, audience = sp.entityId, recipient = sp.acsUrl, notBefore, notOnOrAfter }) {
  const now = Date.now();
  const nb = new Date(notBefore ?? now - 60_000).toISOString();
  const na = new Date(notOnOrAfter ?? now + 5 * 60_000).toISOString();
  return `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id}" Version="2.0" IssueInstant="${new Date(now).toISOString()}">`
    + `<saml:Issuer>${issuer}</saml:Issuer>`
    + `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${email}</saml:NameID>`
    + `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${inResponseTo}" NotOnOrAfter="${na}" Recipient="${recipient}"/></saml:SubjectConfirmation></saml:Subject>`
    + `<saml:Conditions NotBefore="${nb}" NotOnOrAfter="${na}"><saml:AudienceRestriction><saml:Audience>${audience}</saml:Audience></saml:AudienceRestriction></saml:Conditions>`
    + `<saml:AuthnStatement AuthnInstant="${new Date(now).toISOString()}" SessionIndex="${id}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>`
    + `<saml:AttributeStatement><saml:Attribute Name="displayName"><saml:AttributeValue>Mock Person</saml:AttributeValue></saml:Attribute></saml:AttributeStatement>`
    + `</saml:Assertion>`;
}

function signAssertion(xml, { keys = idpKeys, sha1 = false } = {}) {
  const sig = new SignedXml({
    privateKey: keys.key, publicCert: keys.cert,
    signatureAlgorithm: sha1 ? 'http://www.w3.org/2000/09/xmldsig#rsa-sha1' : 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
    canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
  });
  sig.addReference({
    xpath: "//*[local-name(.)='Assertion']",
    digestAlgorithm: sha1 ? 'http://www.w3.org/2000/09/xmldsig#sha1' : 'http://www.w3.org/2001/04/xmlenc#sha256',
    transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'],
  });
  sig.computeSignature(xml, { location: { reference: "//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']", action: 'after' } });
  return sig.getSignedXml();
}

function responseXml(inner, { inResponseTo, issuer = IDP_ENTITY }) {
  return `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r${crypto.randomBytes(8).toString('hex')}" Version="2.0" IssueInstant="${new Date().toISOString()}" Destination="${sp.acsUrl}" InResponseTo="${inResponseTo}">`
    + `<saml:Issuer>${issuer}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>${inner}</samlp:Response>`;
}

const b64 = (xml) => Buffer.from(xml).toString('base64');
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/** Starts a sign-in and returns { relay, requestId }. */
async function begin(orgId, mode = 'signin', startedBy = null) {
  const { authorizeUrl } = await sso.start(pool, { organizationId: orgId, mode, startedBy, redirectUri });
  const u = new URL(authorizeUrl);
  const relay = u.searchParams.get('RelayState');
  const row = (await pool.query('SELECT nonce FROM platform_sso_states WHERE state_hash = $1', [sha256(relay)])).rows[0];
  return { url: u, relay, requestId: row?.nonce };
}

/** A complete, validly signed response for a started sign-in. */
function goodResponse(requestId, email, overrides = {}) {
  const a = signAssertion(assertionXml({ id: `_a${crypto.randomBytes(8).toString('hex')}`, email, inResponseTo: requestId, ...overrides }), overrides.sign || {});
  return b64(responseXml(a, { inResponseTo: requestId }));
}

async function refused(fn) {
  try { await fn(); return null; } catch (e) { return e; }
}

// ── HTTP side (ACS route) ────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/api', accountSecurityRouter({
  pool, authMiddleware: (req, res, next) => { req.user = { userId: 'none' }; next(); }, jwtSecret: 'test-secret-test-secret-test-secret',
  signSession: async (res, user, claims) => ({ token: jwt.sign({ userId: user.id, ...claims }, 'x'), csrf_token: 'c' }),
  apiBase: () => 'https://api.starlane.test', appBase: () => 'https://app.starlane.test',
}));
const api = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const apiBase = `http://127.0.0.1:${api.address().port}`;
const postAcs = (fields) => fetch(`${apiBase}/api/auth/sso/saml/acs`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() });

const users = [];
const domain = `samlco-${crypto.randomBytes(3).toString('hex')}.test`;
const txt = new Map();
sso.__setTestOptions({ txt: async (name) => { if (!txt.has(name)) throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' }); return [[txt.get(name)]]; } });

try {
  const owner = await seedUser(pool, 'saml-owner'); users.push(owner.id);
  const orgId = await ensureOwnOrganization(pool, owner.id);
  const org = { id: orgId, role: 'owner' };
  await sso.addDomain(pool, org, owner.id, domain);
  const rec = (await sso.view(pool, org, { redirectUri })).domains[0];
  txt.set(rec.dnsRecord.name, rec.dnsRecord.value);
  await sso.verifyDomain(pool, org, owner.id, domain);

  // SP metadata.
  const md = await fetch(`${apiBase}/api/auth/sso/saml/metadata`);
  const mdText = await md.text();
  check('SP metadata is served as SAML metadata XML', md.status === 200 && /samlmetadata\+xml/.test(md.headers.get('content-type')) && mdText.includes(`entityID="${sp.entityId}"`) && mdText.includes(sp.acsUrl) && mdText.includes('WantAssertionsSigned="true"'));

  // IdP configuration from metadata.
  const idpMetadata = `<?xml version="1.0"?><md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="${IDP_ENTITY}">`
    + `<md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"><md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${certBody(idpKeys.cert)}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>`
    + `<md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${IDP_SSO}"/></md:IDPSSODescriptor></md:EntityDescriptor>`;
  let e = await refused(() => sso.save(pool, org, owner.id, { protocol: 'saml', metadataXml: `<!DOCTYPE x [<!ENTITY a "b">]>${idpMetadata}` }));
  check('metadata with a DOCTYPE or entities is refused (XXE)', e?.status === 400, e?.message);
  e = await refused(() => sso.save(pool, org, owner.id, { protocol: 'saml', entityId: IDP_ENTITY, ssoUrl: 'http://169.254.169.254/sso', certificate: certBody(idpKeys.cert) }));
  check('a non-https or private sign-on URL is refused', e?.status === 400, e?.message);
  e = await refused(() => sso.save(pool, org, owner.id, { protocol: 'saml', entityId: IDP_ENTITY, ssoUrl: IDP_SSO, certificate: 'not-a-cert' }));
  check('an unreadable certificate is refused', e?.status === 400, e?.message);
  await sso.save(pool, org, owner.id, { protocol: 'saml', metadataXml: idpMetadata, jitRole: 'member' });
  let v = await sso.view(pool, org, { redirectUri });
  check('metadata import reads entity ID, sign-on URL and certificate', v.connection.protocol === 'saml' && v.connection.issuer === IDP_ENTITY && v.connection.saml.ssoUrl === IDP_SSO && v.connection.saml.certificates.length === 1 && v.connection.saml.certificates[0].subject.includes('mock-idp'), v.connection);
  check('the connection starts as a draft and shows the SP URLs to give the IdP', v.connection.status === 'draft' && v.serviceProvider.acsUrl === sp.acsUrl && v.serviceProvider.entityId === sp.entityId);
  check('the view says SAML is supported', v.supports.saml === true);

  // Test sign-in through the ACS route.
  let s = await begin(orgId, 'test', owner.id);
  check('the redirect goes to the IdP with a deflated SAMLRequest and a RelayState', s.url.origin + s.url.pathname === IDP_SSO && !!s.url.searchParams.get('SAMLRequest') && !!s.relay && /^_/.test(s.requestId || ''), s.url.toString());
  let r = await postAcs({ SAMLResponse: goodResponse(s.requestId, `admin@${domain}`), RelayState: s.relay });
  check('a valid test response returns to the settings page', r.status === 303 && r.headers.get('location') === 'https://app.starlane.test/security-center?tab=sso&sso=tested', r.headers.get('location'));
  v = await sso.view(pool, org, { redirectUri });
  check('after the test sign-in the connection is active', v.connection.status === 'active');

  // Real sign-in through the ACS route.
  s = await begin(orgId);
  const good = goodResponse(s.requestId, `New.Person@${domain.toUpperCase()}`);
  r = await postAcs({ SAMLResponse: good, RelayState: s.relay });
  const loc = r.headers.get('location') || '';
  check('a valid sign-in redirects with a single-use code in the fragment', r.status === 303 && /^https:\/\/app\.starlane\.test\/login\/sso#id=[\w-]+&code=[\w-]+$/.test(loc), loc);
  const frag = new URLSearchParams(loc.split('#')[1] || '');
  r = await fetch(`${apiBase}/api/auth/sso/exchange`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: frag.get('id'), code: frag.get('code') }) });
  const ex = await r.json();
  check('the code becomes a session marked with the organization', r.status === 200 && ex.organizationId === orgId && jwt.decode(ex.token).sso === orgId, ex);
  const created = (await pool.query('SELECT id FROM users WHERE lower(email) = $1', [`new.person@${domain}`])).rows[0];
  if (created) users.push(created.id);
  const mem = created && (await pool.query('SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2', [orgId, created.id])).rows[0];
  check('the account is created on first sign-in with the configured role', mem?.role === 'member', mem);

  r = await postAcs({ SAMLResponse: good, RelayState: s.relay });
  check('replaying the same response is refused', r.status === 303 && (r.headers.get('location') || '').includes('sso_error='), r.headers.get('location'));

  // Attacks, each against a freshly started sign-in.
  const attack = async (label, build, extra = {}) => {
    const st = await begin(orgId);
    const err = await refused(() => sso.completeSaml(pool, { SAMLResponse: build(st), RelayState: st.relay, redirectUri, ...extra }));
    check(label, err?.status === 400 || err?.status === 403, err ? err.message : 'accepted');
    return err;
  };
  await attack('an unsigned assertion is refused', (st) => b64(responseXml(assertionXml({ id: '_u1', email: `x@${domain}`, inResponseTo: st.requestId }), { inResponseTo: st.requestId })));
  await attack('an assertion signed by another key is refused', (st) => goodResponse(st.requestId, `x@${domain}`, { sign: { keys: rogueKeys } }));
  await attack('an assertion changed after signing is refused', (st) => {
    const signed = signAssertion(assertionXml({ id: '_t1', email: `legit@${domain}`, inResponseTo: st.requestId }));
    return b64(responseXml(signed.replace(`legit@${domain}`, `attacker@${domain}`), { inResponseTo: st.requestId }));
  });
  await attack('a comment inside the NameID does not change who signs in', (st) => {
    const signed = signAssertion(assertionXml({ id: '_c1', email: `attacker@${domain}.evil.test`, inResponseTo: st.requestId }));
    return b64(responseXml(signed.replace(`attacker@${domain}.evil.test`, `attacker@${domain}<!---->.evil.test`), { inResponseTo: st.requestId }));
  });
  {
    // Signature wrapping: a validly signed assertion for legit@ plus an injected unsigned one for attacker@.
    const st = await begin(orgId);
    const signed = signAssertion(assertionXml({ id: '_w1', email: `legit@${domain}`, inResponseTo: st.requestId }));
    const evil = assertionXml({ id: '_w2', email: `attacker@${domain}`, inResponseTo: st.requestId });
    const err = await refused(async () => {
      const out = await sso.completeSaml(pool, { SAMLResponse: b64(responseXml(evil + signed, { inResponseTo: st.requestId })), RelayState: st.relay, redirectUri });
      if (out.user.email.startsWith('attacker@')) throw Object.assign(new Error('WRAPPED'), { status: 999 });
      users.push(out.user.id);
    });
    check('signature wrapping cannot sign in the injected identity', !err || err.status !== 999, err?.message);
  }
  await attack('another issuer is refused', (st) => goodResponse(st.requestId, `x@${domain}`, { issuer: 'https://other-idp.test' }));
  await attack('another audience is refused', (st) => goodResponse(st.requestId, `x@${domain}`, { audience: 'https://other-sp.test' }));
  await attack('another recipient is refused', (st) => goodResponse(st.requestId, `x@${domain}`, { recipient: 'https://other-sp.test/acs' }));
  await attack('an expired assertion is refused', (st) => goodResponse(st.requestId, `x@${domain}`, { notBefore: Date.now() - 3_600_000, notOnOrAfter: Date.now() - 1_800_000 }));
  await attack('a response to another request is refused', () => goodResponse('_not-this-request', `x@${domain}`));
  await attack('a SHA-1 signature is refused', (st) => goodResponse(st.requestId, `x@${domain}`, { sign: { sha1: true } }));
  await attack('an email outside the verified domains is refused', (st) => goodResponse(st.requestId, 'someone@elsewhere.test'));
  e = await refused(() => sso.completeSaml(pool, { SAMLResponse: goodResponse('_x', `x@${domain}`), RelayState: '', redirectUri }));
  check('an IdP-initiated response (no RelayState from Starlane) is refused', e?.status === 400, e?.message);
  e = await refused(() => sso.completeSaml(pool, { SAMLResponse: goodResponse('_x', `x@${domain}`), RelayState: 'made-up-relay-state', redirectUri }));
  check('an unknown RelayState is refused', e?.status === 400, e?.message);

  // Enforcement and switching back.
  await sso.setEnforce(pool, org, owner.id, true);
  check('enforced SAML blocks other sign-in methods on the domain', !!(await sso.requiredFor(pool, `someone@${domain}`, null)));
  await sso.save(pool, org, owner.id, { protocol: 'saml', entityId: IDP_ENTITY, ssoUrl: IDP_SSO, certificate: certBody(rogueKeys.cert) });
  v = await sso.view(pool, org, { redirectUri });
  check('changing the IdP certificate puts the connection back to draft and drops enforcement', v.connection.status === 'draft' && v.connection.enforce === false, v.connection);
  const ev = await pool.query(`SELECT array_agg(DISTINCT action) AS a FROM platform_audit_events WHERE organization_id = $1 AND action LIKE 'sso.%'`, [orgId]);
  check('SAML configuration and sign-ins are audited', ['sso.configured', 'sso.tested', 'sso.signed_in'].every((x) => ev.rows[0].a.includes(x)), ev.rows[0].a);
} catch (err) {
  check('test ran without throwing', false, err.stack);
} finally {
  api.close();
  await deleteUsers(pool, users);
  await pool.end();
  done();
}
