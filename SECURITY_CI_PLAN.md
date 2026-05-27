# Security CI Baseline Plan

## Current Goal

Prevent broken or obviously unsafe code from reaching production while avoiding permanently failing CI due to known no-fix or breaking-upgrade dependency advisories.

## Backend Checks

Recommended baseline:

```yaml
npm ci
node --check server.js
npm audit --audit-level=high || echo "Audit has known advisories; review required"
```

Do not make backend audit a hard fail until `xlsx` and `node-cron` decisions are resolved.

## Frontend Checks

Recommended baseline:

```yaml
npm ci
npm run build
npm audit --audit-level=high || echo "Audit has known advisories; review required"
```

Do not make frontend audit a hard fail until the Next.js upgrade plan is executed.

## Secret Scanning

Enable in GitHub settings:

- Secret scanning
- Push protection
- Dependabot alerts
- Dependabot security updates
- Branch protection on `main`
- Required PR review before production branches

## Optional gitleaks

Add gitleaks as a non-blocking CI step first. Turn it into a blocking step after initial baseline cleanup.

## Risk

Low implementation risk if CI starts with syntax/build as blocking and audit/secret scanning as review-required. High value before adding payments, WhatsApp, or call integrations.
