# Starlane security and compliance gap report

Date: 22 November 2026. Scope: `vantro-flow-backend` with platform core (PR #86) and this change (migrations 075, 076 and 077), and `vantro-flow-frontend`.

## The short version

Starlane holds **no** certification, attestation or authorization today: not SOC 2, not ISO 27001 / 27701 / 42001, not AIUC-1, not FedRAMP. Those are granted by outside auditors after a period of evidence, and no code change can produce one. GDPR, CCPA and India's DPDP Act are laws, not certificates; the honest claim for them is "designed to align", meaning the controls below exist in the product.

The public Security page may say "Designed around SOC 2 and ISO/IEC 27001 controls" and list the controls in `lib/platform/security/publicControls.js`, because each of those describes code that exists. It must never show a certification badge or logo it does not hold. The trust page and the admin Security page both read their claims from `lib/platform/security/frameworks.js`, where every status is "Not certified", "No audit report yet", "Not authorized" or "Designed to align (not independently assessed)". Change a status only with a signed report in hand.

## Technical controls: what exists now

Status is what `GET /api/platform/security/posture` computes on a running server.

| Control | Status | Where |
|---|---|---|
| Credentials encrypted at rest (AES-256-GCM) | In place when `OUTBOUND_CREDENTIALS_KEY` is set | `lib/domain/outbound/credentials.js` |
| Encryption key rotation | In place (new) | `OUTBOUND_CREDENTIALS_KEY_PREVIOUS` + `scripts/rotate-credentials-key.js` |
| Encryption in transit | In place (HSTS; TLS at Railway / Vercel) | `server.js` security headers |
| Audit log | In place | `platform_audit_events` (072) |
| Tamper-evident audit log | In place (new): per-organization SHA-256 hash chain, append-only trigger, verify and export endpoints | migration 075, `lib/platform/security/auditChain.js` |
| Role-based access (Owner / Admin / Member / Viewer) | In place (PR #86), extended with connector, security, privacy and factory permissions | `lib/platform/roles.js` |
| Human approval for external and financial agent actions | In place; connected-app writes and every MCP tool always need approval | `lib/platform/engine.js`, `tools.js` |
| Safe outbound requests (no SSRF, https only, no redirects, size/time limits, per-connection rate limit, base-URL pinning) | In place | `lib/connectors/safeHttp.js`, `lib/platform/connectors/store.js` |
| Data export (GDPR Art. 15/20, CCPA right to know) | In place (new) | `GET /api/platform/privacy/export` |
| Account erasure (GDPR Art. 17, CCPA delete) | Partial (new): requests are scheduled with a 7-day grace period and cancellable, but only execute with `FEATURE_PRIVACY_ERASURE_ENABLED=true` | `lib/platform/security/privacy.js` |
| Data retention | Partial (new): per-organization policy and on-demand apply; the daily job runs only with `FEATURE_RETENTION_JOB_ENABLED=true` | `lib/platform/security/retention.js` |
| Agent versioning and test-before-publish | In place (PR #86) | `lib/platform/agents.js` |
| Prompt injection screening | In place (prompt guard on by default) | `promptGuard.service.js` |
| Secret scanning, dependency audit, tenant-isolation check in CI | In place | `.github/workflows/security.yml` |
| Tenant isolation | Partial: enforced in every application query; RLS is enabled on tables but the server role bypasses it and there are no policies, so the database is not a second line of defence | migration 006 not applied |
| Multi-factor sign-in | In place (new): authenticator app (TOTP) with 10 single-use recovery codes, or a passkey, after password, Google, Apple or phone sign-in; codes cannot be replayed; 5 wrong codes lock for 15 minutes; an organization can require it for admins or everyone; a password-only session cannot add or remove a second factor once the account has one. Not built: the desktop and mobile app sessions do not carry the second-factor mark yet | migrations 076 and 077, `lib/auth/mfa.js`, `lib/auth/passkeys.js`, `lib/platform/security/mfaPolicy.js` |
| Passkeys (WebAuthn) | In place (new): passwordless sign-in and second step; user verification required; single-use hashed challenges (5 minutes); origin and RP ID checked; signature counter refuses cloned keys; only public keys stored. Needs Node.js 20+ on the server (answers 503 otherwise) | migration 077, `lib/auth/passkeys.js`, `@simplewebauthn/server` 13.3.3 |
| Single sign-on | In place (new): **SAML 2.0** and OpenID Connect per organization (Okta, Entra ID, Google Workspace, OneLogin, ADFS, Auth0 and others), email domains proven by DNS TXT, a test sign-in before it can be used, optional enforcement with the owner exempt, accounts created on first sign-in. SAML: signed assertions required, issuer/audience/recipient/InResponseTo checked, service-provider initiated only, single-use requests, SHA-1 refused, metadata import (no DOCTYPE). **Not built: SCIM provisioning**, so removing someone from the IdP does not remove their membership | migrations 076 and 077, `lib/auth/sso.js`, `lib/auth/saml.js`, `@node-saml/node-saml` 5.2.0 |
| Session management | In place (new): each web sign-in is a session row; people can list and end sessions (web and app), sign out everywhere, and a password change or reset ends every other session; logout ends the token's session; an organization can cap session length (1 to 720 hours) for its workspace; only a /24 or /48 network prefix is stored, never a full IP | migration 077, `lib/auth/webSessions.js` |
| Dependency vulnerabilities | In place (new): CI fails on any unreviewed high or critical advisory in production dependencies. One reviewed exception: `xlsx` (no fixed version on npm; used only for signed-in spreadsheet imports; to replace). `yaml` and `qs` were upgraded to fixed versions | `scripts/security-dependency-audit.js` |
| Backups and restore drills | Outside the app: run by the database host; no recorded drill | `BACKUP_RESTORE_DRILL.md` is a plan |
| Penetration test | **Not done** | — |

## What each framework still needs

### SOC 2 Type II (attestation by a CPA firm)
1. MFA (authenticator app or passkey) is built and an organization can require it; switch the rule on for Starlane's own staff organization and keep the evidence. The second-factor mark for desktop and mobile app sessions, and SCIM so leavers are removed automatically, are still to build.
2. Written policies approved by management: information security, access control, change management, incident response, vendor management, business continuity, data classification, acceptable use.
3. Evidence processes: quarterly access reviews, onboarding / offboarding records, change approvals (PR reviews already give some of this), vendor reviews of Railway, Vercel, Supabase / Neon, model providers.
4. Backup restore drill on a schedule, with a record.
5. Third-party penetration test and fixes.
6. Security awareness training records for everyone with access.
7. A compliance automation tool (or a disciplined evidence folder), a readiness assessment, a Type I report, then a 3 to 12 month Type II observation window.
Realistic timeline from today: 6 to 12 months and an audit budget.

### ISO/IEC 27001 (certification)
ISMS scope, risk assessment and treatment plan, Statement of Applicability for Annex A, internal audit, management review, then Stage 1 and Stage 2 audits by an accredited body. The technical controls above cover a good part of Annex A's technological controls; the organizational, people and physical controls are not code.

### ISO/IEC 27701 (privacy extension)
Needs ISO 27001 first, plus records of processing, DPIAs, processor agreements with every subprocessor, and a privacy notice for the end customers whose data owners import.

### ISO/IEC 42001 and AIUC-1 (AI)
Built: human approval gates, tool risk classes that a definition or imported spec cannot lower, immutable agent versions, step traces, test runs that never write, prompt guard, per-run model and token records.
Missing: an AI policy and AI risk / impact assessments, adversarial testing of every agent (prompt injection through connected-app data is the main new risk this change introduces; the approval gate is the mitigation), production monitoring of agent behaviour, and the third-party audit.

### FedRAMP
Not applicable to Starlane's market (Indian and global MSMEs). It would need a US federal sponsor, FedRAMP-authorized US hosting, FIPS 140 validated cryptography, a NIST SP 800-53 System Security Plan and a 3PAO assessment. Recommend not pursuing.

### GDPR / CCPA / DPDP (laws)
Built: export, scheduled erasure with receipt, retention, encryption, audit, roles.
Missing: Data Processing Agreement and published subprocessor list; SCCs for EU data leaving the EU; a privacy notice that covers California and DPDP rights; identity verification for rights requests from people who are not account holders (an MSME's own customers); a grievance officer for DPDP; breach notification procedure. Before switching erasure on, decide with a lawyer which business records (invoices, GST records) must be kept for the statutory period; today erasure removes the whole account.

## New risks this change introduces, and their mitigations

| Risk | Mitigation in code |
|---|---|
| An imported spec or catalog entry points requests at internal infrastructure | `safeHttp` refuses private, loopback and metadata addresses and redirects; base URL and every token URL go through `checkUrl`; final URLs must stay under the connection's base path |
| A connected app's response carries a prompt injection that makes an agent act | Every write to another app and every MCP tool call waits for a person to approve the exact request; test runs never execute writes |
| A third-party MCP server mislabels a destructive tool as read-only | MCP tools are always treated as external; `readOnlyHint` is displayed, never trusted |
| Stolen OAuth state or code | PKCE (S256), single-use hashed state with a 10-minute expiry, client secret never leaves the server |
| Someone points another company's emails at their own identity provider | A domain counts for SSO only after a DNS TXT record proves control, a verified domain belongs to one organization, public mail domains cannot be claimed, and the ID token email must be on a verified domain |
| A broken identity provider locks an organization out | SSO cannot be required before a test sign-in passes; the owner keeps their other sign-in methods |
| A forged or replayed SAML response | Assertions must be signed by the organization's IdP certificate (verified by node-saml / xml-crypto, not hand-written code); signature wrapping, tampering, wrong issuer, audience or recipient, expiry, another request's response, IdP-initiated responses and SHA-1 are refused; each request is single-use. All covered by `tests/auth.saml.test.mjs` |
| A stolen password used to swap out the account's second factor | Adding or removing an authenticator or passkey needs a session that already passed the second step (or came from SSO) |
| A stolen or copied session token | Web sessions can be ended individually or everywhere and stop on the next request (15-second cache); password changes end them; organizations can cap session age |
| A cloned passkey | The signature counter must increase; a lower counter is refused |
| The MFA challenge token used as a session | It is signed with a separate derived key, so the normal session check rejects it; it expires in 5 minutes |
| Credential leak through logs or API | Credentials encrypted, never returned; call log stores no bodies or URLs; errors pass through `redact()` |
| Audit tampering by someone with database access | Hash chain detects edits and gaps; keep the `head` from `/security/audit/verify` outside Starlane to detect tail truncation |

## Rollout steps (operator)

1. Review and apply migrations 072 to 074 (PR #86), 075, 076 and 077 (this change) to staging, then production. 075 is additive except two triggers on `platform_audit_events`; 076 and 077 are additive. Rollback is in each migration header. Until 077 is applied, web sessions behave as before (30-day tokens without a revocation list), and SAML, passkeys and session limits answer that the migration is pending.
2. Confirm `OUTBOUND_CREDENTIALS_KEY` is set in production. MFA secrets and SSO client secrets are encrypted with it; without it neither can be turned on.
2a. Set `PUBLIC_API_URL` and `PUBLIC_APP_URL` so the SSO redirect URL (`<PUBLIC_API_URL>/api/auth/sso/callback`), the SAML ACS URL (`<PUBLIC_API_URL>/api/auth/sso/saml/acs`) and entity ID (`<PUBLIC_API_URL>/api/auth/sso/saml/metadata`), and the return to the app are right. Passkeys use the app's hostname as the relying party ID; set `WEBAUTHN_RP_ID` and `WEBAUTHN_ORIGINS` if the app is served from more than one origin. Changing the RP ID later makes existing passkeys stop working.
2b. Run the backend on Node.js 20 or newer (passkeys need it). Nixpacks reads `engines` in package.json (">=18"); set `NIXPACKS_NODE_VERSION=20` or 22 in Railway, or raise `engines`, before relying on passkeys.
3. Leave `FEATURE_PRIVACY_ERASURE_ENABLED` off until the legal retention review is done.
4. Turn on `FEATURE_RETENTION_JOB_ENABLED` once admins have reviewed the default periods (90 / 90 / 180 days).
5. `FEATURE_WORKFLOW_HTTP_ACTIONS_ENABLED` (existing) also gates agents changing other software (`apps.act`); reads work without it.
