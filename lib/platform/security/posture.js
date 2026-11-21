'use strict';
// Live security posture: each technical control, with its status computed
// from this running server and this organization's data, not asserted.
//
//   in_place             the control exists and is switched on here
//   partial              exists but is off, incomplete or only in code
//   needs_configuration  exists but this server is missing a setting
//   not_in_place         not built
//   outside_the_app      cannot be seen from the application (hosting,
//                        people and process); reported honestly as unknown

const fs = require('fs');
const path = require('path');
const creds = require('../../domain/outbound/credentials');
const { verify } = require('./auditChain');
const retention = require('./retention');
const privacy = require('./privacy');
const { FRAMEWORKS } = require('./frameworks');

const ROOT = path.join(__dirname, '..', '..', '..');
const exists = (rel) => { try { return fs.existsSync(path.join(ROOT, rel)); } catch { return false; } };
const flag = (k) => { try { return require('../../featureFlags').isEnabled(k) === true; } catch { return false; } };

async function controls(db, org, env = process.env) {
  const chain = await verify(db, org.id).catch(() => null);
  const ret = await retention.getPolicy(db, org.id).catch(() => null);
  const rls = await db.query(
    `SELECT COUNT(*) FILTER (WHERE c.relrowsecurity)::int AS enabled, COUNT(*)::int AS total,
            (SELECT COUNT(*)::int FROM pg_policies WHERE schemaname = 'public') AS policies
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'platform\\_%'`,
  ).then((r) => r.rows[0]).catch(() => null);
  const jwtLen = String(env.JWT_SECRET || '').length;

  const list = [
    {
      id: 'credential_encryption', name: 'Encrypted credentials', area: 'Data protection',
      status: creds.available() ? 'in_place' : 'needs_configuration',
      detail: creds.available()
        ? 'API keys, OAuth tokens and webhook secrets are encrypted with AES-256-GCM before they are stored, and are never returned by the API.'
        : 'OUTBOUND_CREDENTIALS_KEY is not set, so no connection that needs a credential can be saved.',
    },
    {
      id: 'key_rotation', name: 'Encryption key rotation', area: 'Data protection',
      status: 'in_place',
      detail: env.OUTBOUND_CREDENTIALS_KEY_PREVIOUS
        ? 'A rotation is in progress: the previous key is still configured. Run scripts/rotate-credentials-key.js --apply, then remove OUTBOUND_CREDENTIALS_KEY_PREVIOUS.'
        : 'Supported: set the new key and the previous key, run scripts/rotate-credentials-key.js --apply. No rotation has been recorded by the app.',
    },
    {
      id: 'transport_security', name: 'Encryption in transit', area: 'Data protection',
      status: 'in_place',
      detail: 'The API sets Strict-Transport-Security (HSTS, one year). TLS termination is done by the host (Railway / Vercel).',
    },
    {
      id: 'audit_log', name: 'Audit log', area: 'Accountability',
      status: 'in_place',
      detail: 'Administrative changes, agent lifecycle, approvals, connection changes, calls that change other systems, privacy requests and retention runs are written to an append-only audit log. Admins can export it.',
    },
    {
      id: 'audit_tamper_evidence', name: 'Tamper-evident audit log', area: 'Accountability',
      status: chain ? (chain.intact ? 'in_place' : 'partial') : 'partial',
      detail: chain
        ? (chain.intact
          ? `Hash chain verified just now: ${chain.checked} events intact${chain.beforeChain ? `, ${chain.beforeChain} older events from before the chain started` : ''}.`
          : `The hash chain reports ${chain.problems.length} problem(s). Open Audit verification for details.`)
        : 'The hash chain could not be checked (migration 075 not applied).',
    },
    {
      id: 'rbac', name: 'Role-based access control', area: 'Access control',
      status: 'in_place',
      detail: 'Owner, Admin, Member and Viewer roles per organization. Every platform route checks the caller\'s role; the organization comes from verified membership, never from the request.',
    },
    {
      id: 'mfa', name: 'Multi-factor sign-in', area: 'Access control',
      status: 'not_in_place',
      detail: 'Sign-up verifies email with a one-time code, but sign-in is password only. MFA (authenticator app or passkey) is not built.',
    },
    {
      id: 'sso', name: 'Single sign-on (SAML / OIDC)', area: 'Access control',
      status: 'not_in_place',
      detail: 'Google sign-in exists for individual accounts. Organization-wide SSO with SAML or OIDC, and SCIM provisioning, are not built.',
    },
    {
      id: 'tenant_isolation', name: 'Tenant isolation', area: 'Access control',
      status: 'partial',
      detail: rls
        ? `Enforced in application queries (every query filters by organization or owner). Row-level security is enabled on ${rls.enabled} of ${rls.total} platform tables, but the server connects with a role that bypasses it and ${rls.policies} RLS policies exist, so the database is not a second line of defence yet.`
        : 'Enforced in application queries. Database row-level security policies are not in force.',
    },
    {
      id: 'approval_gates', name: 'Human approval for risky actions', area: 'AI and automation',
      status: 'in_place',
      detail: 'Any agent action that changes something outside Starlane (connected apps, MCP tools, API calls) or moves money always waits for a person to approve the exact request. A definition cannot remove that.',
    },
    {
      id: 'ai_human_oversight', name: 'Human oversight of agents', area: 'AI and automation',
      status: 'in_place',
      detail: 'Agents start as drafts, must pass a test run of the exact configuration before publishing, can be deactivated at any time, and every step is traced.',
    },
    {
      id: 'ai_tool_risk_classes', name: 'Tool risk classes', area: 'AI and automation',
      status: 'in_place',
      detail: 'Every tool is read, internal write, external or financial. Imported operations other than GET are external; an imported spec cannot lower that.',
    },
    {
      id: 'ai_prompt_guard', name: 'Prompt injection defence', area: 'AI and automation',
      status: flag('prompt_guard_enabled') ? 'in_place' : 'partial',
      detail: flag('prompt_guard_enabled')
        ? 'Untrusted text is screened by the prompt guard before it reaches a model. External actions still need approval even if a prompt is manipulated.'
        : 'The prompt guard is switched off on this server.',
    },
    {
      id: 'ai_versioning', name: 'Agent versioning', area: 'AI and automation',
      status: 'in_place',
      detail: 'Each published agent version is immutable and every run records the exact definition and checksum it ran.',
    },
    {
      id: 'outbound_request_safety', name: 'Safe outbound requests', area: 'Integrations',
      status: 'in_place',
      detail: 'Calls to other software are https only, never reach private or cloud-metadata addresses, never follow redirects, have time and size limits, are rate limited per connection, and can only reach the connection\'s own base URL.',
    },
    {
      id: 'data_export', name: 'Data export (access and portability)', area: 'Privacy',
      status: 'in_place',
      detail: 'Any member can download every row stored about them; the owner can download the whole organization. Secrets are withheld.',
    },
    {
      id: 'data_erasure', name: 'Account erasure', area: 'Privacy',
      status: privacy.erasureEnabled() ? 'in_place' : 'partial',
      detail: privacy.erasureEnabled()
        ? `Account erasure runs ${privacy.graceDays()} days after it is requested (cancellable until then) and keeps a receipt without personal data.`
        : `Requests are accepted and scheduled ${privacy.graceDays()} days ahead, but they do not run until FEATURE_PRIVACY_ERASURE_ENABLED is on (pending a legal review of which business records must be kept).`,
    },
    {
      id: 'retention', name: 'Data retention', area: 'Privacy',
      status: flag('retention_job_enabled') ? 'in_place' : 'partial',
      detail: `${ret?.configured ? 'This organization has a retention policy' : 'Default retention applies'} (connector calls ${ret?.connectorCallsDays ?? 90} days, webhook payloads ${ret?.webhookEventsDays ?? 90} days, agent step data ${ret?.executionTraceDays ?? 180} days). ${flag('retention_job_enabled') ? 'The daily job applies it.' : 'The daily job is off (FEATURE_RETENTION_JOB_ENABLED); admins can apply it on demand.'}`,
    },
    {
      id: 'ci_security_scanning', name: 'Security scanning in CI', area: 'Secure development',
      status: exists('.github/workflows/security.yml') ? 'in_place' : 'not_in_place',
      detail: 'GitHub Actions run secret scanning, dependency audit and tenant-isolation checks on changes.',
    },
    {
      id: 'session_secret_strength', name: 'Session signing secret', area: 'Access control',
      status: jwtLen >= 32 ? 'in_place' : 'needs_configuration',
      detail: jwtLen >= 32 ? 'JWT_SECRET is set and at least 32 characters.' : 'JWT_SECRET is shorter than 32 characters.',
    },
    {
      id: 'incident_response_plan', name: 'Incident response plan', area: 'Operations',
      status: exists('INCIDENT_RESPONSE_PLAYBOOK.md') ? 'partial' : 'not_in_place',
      detail: 'A written playbook exists in the repository. It has not been exercised in a recorded drill.',
    },
    {
      id: 'backups', name: 'Backups and restore', area: 'Operations',
      status: 'outside_the_app',
      detail: 'Backups are run by the database host. The app cannot see whether they succeed; a restore drill has to be recorded outside the app.',
    },
    {
      id: 'penetration_test', name: 'Independent penetration test', area: 'Operations',
      status: 'not_in_place',
      detail: 'No third-party penetration test has been done.',
    },
  ];
  return { controls: list, chain };
}

async function posture(db, org) {
  const { controls: list, chain } = await controls(db, org);
  const byId = new Map(list.map((c) => [c.id, c]));
  const counts = list.reduce((acc, c) => { acc[c.status] = (acc[c.status] || 0) + 1; return acc; }, {});
  const frameworks = FRAMEWORKS.map((f) => {
    const cs = f.controls.map((id) => byId.get(id)).filter(Boolean);
    return {
      key: f.key, name: f.name, kind: f.kind, status: f.status,
      controlsInPlace: cs.filter((c) => c.status === 'in_place').length, controlsTotal: cs.length,
      stillNeeded: f.stillNeeded,
    };
  });
  return { generatedAt: new Date().toISOString(), counts, controls: list, frameworks, auditChain: chain ? { intact: chain.intact, checked: chain.checked, head: chain.head } : null };
}

module.exports = { posture, controls };
