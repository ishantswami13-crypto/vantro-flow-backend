# Starlane security and compliance gap report

Date: 21 November 2026. Scope: `vantro-flow-backend` with platform core (PR #86) and this change (migration 075), and `vantro-flow-frontend`.

## The short version

Starlane holds **no** certification, attestation or authorization today: not SOC 2, not ISO 27001 / 27701 / 42001, not AIUC-1, not FedRAMP. Those are granted by outside auditors after a period of evidence, and no code change can produce one. GDPR, CCPA and India's DPDP Act are laws, not certificates; the honest claim for them is "designed to align", meaning the controls below exist in the product.

The product must never show a certification badge it does not hold. The trust page and the admin Security page both read their claims from `lib/platform/security/frameworks.js`, where every status is "Not certified", "No audit report yet", "Not authorized" or "Designed to align (not independently assessed)". Change a status only with a signed report in hand.

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
| Multi-factor sign-in | **Not built**: sign-up verifies email with a code; sign-in is password only | — |
| SSO (SAML / OIDC) and SCIM | **Not built**: Google sign-in exists for individuals only | — |
| Backups and restore drills | Outside the app: run by the database host; no recorded drill | `BACKUP_RESTORE_DRILL.md` is a plan |
| Penetration test | **Not done** | — |

## What each framework still needs

### SOC 2 Type II (attestation by a CPA firm)
1. MFA for every user, enforced for admins (engineering, about 1 week).
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
| Credential leak through logs or API | Credentials encrypted, never returned; call log stores no bodies or URLs; errors pass through `redact()` |
| Audit tampering by someone with database access | Hash chain detects edits and gaps; keep the `head` from `/security/audit/verify` outside Starlane to detect tail truncation |

## Rollout steps (operator)

1. Review and apply migrations 072 to 074 (PR #86) and 075 (this change) to staging, then production. 075 is additive except two triggers on `platform_audit_events`; rollback is in the migration header.
2. Confirm `OUTBOUND_CREDENTIALS_KEY` is set in production.
3. Leave `FEATURE_PRIVACY_ERASURE_ENABLED` off until the legal retention review is done.
4. Turn on `FEATURE_RETENTION_JOB_ENABLED` once admins have reviewed the default periods (90 / 90 / 180 days).
5. `FEATURE_WORKFLOW_HTTP_ACTIONS_ENABLED` (existing) also gates agents changing other software (`apps.act`); reads work without it.
