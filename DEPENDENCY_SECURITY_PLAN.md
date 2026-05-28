# Dependency Security Plan

## 1. Goal
Maintain a secure supply chain by tracking vulnerabilities and safely upgrading node modules.

## 2. Current Known Vulnerabilities
- **xlsx**: The `xlsx` package is known to have potential prototype pollution or denial-of-service vectors if used to parse untrusted client files.
- **Next.js**: Occasional high-severity advisories related to image optimization or edge routing.

## 3. Mitigation Strategies
- **xlsx**: Vantro Flow currently implements file size limits (5MB) and strict MIME type checking before `xlsx` processes the file. We should evaluate migrating to `exceljs` or `papaparse` for spreadsheet imports if they are exclusively CSV/XLSX without complex macros.
- **Dependabot**: Enable GitHub Dependabot to automatically open PRs for vulnerable packages.

## 4. Upgrade Policy
- **No Blind Upgrades**: Never blindly run `npm audit fix --force` on production code.
- **Breaking Changes**: Major version upgrades must be accompanied by full integration tests to ensure business logic (e.g., invoice generation, auth) does not break.
