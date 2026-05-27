# Dependency Security Mitigation Plan

## Backend Audit Summary

Known backend risks:

- `xlsx`: high severity advisories, no safe upstream fix available.
- `node-cron` -> `uuid`: moderate advisory; fix requires a breaking `node-cron` major upgrade.

## xlsx Exposure

`xlsx` is used for import/export/report workflows. Server-side parsing of untrusted spreadsheets is higher risk because malicious files can trigger parser bugs or denial-of-service paths.

Immediate mitigations:

- Keep upload size limit strict.
- Restrict upload routes with endpoint-specific rate limits.
- Reject unsupported file types where practical.
- Avoid parsing spreadsheets from public unauthenticated routes.
- Prefer authenticated/admin-only imports for sensitive bulk ingestion.
- Monitor memory and request duration on import endpoints.

Long-term fix:

- Evaluate replacing `xlsx` with a maintained parser or splitting export and import paths.
- Add fixture-based regression tests before replacement.

## Frontend Audit Summary

Frontend audit reports high severity Next.js findings and a PostCSS moderate issue. Fixing likely requires a major Next.js upgrade and full UI/build regression testing.

Immediate mitigations:

- Keep Vercel on managed platform patches where applicable.
- Avoid self-hosted Next image optimizer exposure if not needed.
- Keep CSP and security headers active.

Long-term fix:

- Plan a Next.js upgrade in staging.
- Run `npm run build`.
- Smoke test login, dashboard, inventory, collections, sales, purchases, ledger, and reports.

## node-cron / uuid

Current risk is transitive and moderate. A forced fix upgrades `node-cron` to a breaking major version. Do not run `npm audit fix --force` directly in production branches.

Safe path:

1. Create staging branch.
2. Upgrade `node-cron`.
3. Verify scheduled dunning, scorecard, and briefing jobs.
4. Deploy after soak testing.

## Immediate Risk Level

- `xlsx`: high risk, bounded by auth, upload limits, and route throttles.
- Next.js: high reported risk, upgrade requires careful frontend testing.
- `node-cron`/`uuid`: moderate risk, not worth blind breaking upgrade.
