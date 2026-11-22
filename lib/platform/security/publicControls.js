'use strict';
// What the public Security page lists. Every line describes code in this
// repository; nothing here is a certification or an audit result. Keep it in
// step with posture.js (the per-organization, live version) and
// docs/SECURITY_GAP_REPORT.md. If a control is removed or switched off by
// default, change this file in the same commit.

const STATEMENT = 'Starlane is designed around SOC 2 and ISO/IEC 27001 controls. It is not certified, and no independent auditor has assessed it yet.';

const CONTROLS = [
  { area: 'Sign-in', name: 'Single sign-on', detail: 'SAML 2.0 and OpenID Connect per organization (Okta, Microsoft Entra ID, Google Workspace and others). Email domains are proven by DNS, a test sign-in is required before use, and an organization can make it the only way in.' },
  { area: 'Sign-in', name: 'Two-step sign-in', detail: 'Authenticator-app codes with single-use recovery codes, or passkeys (WebAuthn) with fingerprint, face or device PIN. Organizations can require it for admins or for everyone.' },
  { area: 'Sign-in', name: 'Passkeys', detail: 'Sign in without a password using a phone, laptop or security key. Only the public key is stored; a cloned key is detected by its signature counter.' },
  { area: 'Sign-in', name: 'Sessions you can end', detail: 'See every device signed in to your account and end any of them. Signing out everywhere and changing your password end every other session. Organizations can set a maximum session length.' },
  { area: 'Sign-in', name: 'Brute-force limits', detail: 'Sign-in, code and password-reset attempts are rate limited, and repeated wrong two-step codes lock the second step for 15 minutes.' },
  { area: 'Access', name: 'Roles per organization', detail: 'Owner, Admin, Member and Viewer. Every workspace request checks the caller’s membership and role on the server; the organization is never taken from the request.' },
  { area: 'Access', name: 'Human approval for AI actions', detail: 'An agent action that changes another system waits for a person to approve the exact request. Test runs never write.' },
  { area: 'Data', name: 'Encrypted credentials', detail: 'API keys, OAuth tokens and identity provider secrets are encrypted with AES-256-GCM before storage and never returned by the API. Keys can be rotated.' },
  { area: 'Data', name: 'Encryption in transit', detail: 'HTTPS only, with HTTP Strict Transport Security for one year.' },
  { area: 'Data', name: 'Retention you control', detail: 'Each organization sets how long call logs, webhook payloads and agent step data are kept.' },
  { area: 'Data', name: 'Export your data', detail: 'Any member can download everything Starlane stores about them; owners can export the whole organization. Secrets are withheld from exports.' },
  { area: 'Accountability', name: 'Tamper-evident audit log', detail: 'Administrative changes, sign-in settings, approvals and changes made in connected apps are written to an append-only log whose entries are chained by SHA-256 hashes. Admins can verify the chain and export it for an auditor.' },
  { area: 'Platform', name: 'Safe outbound requests', detail: 'Calls to connected apps and identity providers go only to public HTTPS addresses; private networks, cloud metadata addresses and redirects are blocked.' },
  { area: 'Platform', name: 'Browser protections', detail: 'Clickjacking and MIME-sniffing protection headers on every API response, and CSRF tokens for cookie sessions.' },
  { area: 'Development', name: 'Security checks on every change', detail: 'Automated tests for sign-in, SSO, passkeys and tenant isolation, plus secret scanning and a dependency vulnerability audit in CI.' },
];

const NOT_YET = [
  'Independent audit or certification (SOC 2 report, ISO/IEC 27001 certificate)',
  'Third-party penetration test',
  'SCIM provisioning from identity providers',
  'Database row-level security as a second line of tenant isolation',
  'Scheduled backup restore tests',
  'Account deletion runs only after a legal review of record-keeping duties (requests are accepted and kept)',
];

module.exports = { STATEMENT, CONTROLS, NOT_YET };
