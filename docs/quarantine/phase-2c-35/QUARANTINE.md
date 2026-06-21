# ⛔ Phase 2C.35 — Quarantine Record (DO NOT RUN)

Three **untracked** working-tree artifacts were present at audit/fix time. They are
**unreviewed, are NOT part of this PR, and must NOT be run, applied, or committed**
until the owner explicitly reviews them. They are left in place (not moved/staged)
to avoid committing private/unreviewed content; this record documents the exact risk.

| File | Risk | Disposition |
|---|---|---|
| `run-schema.js` | **HIGH — runnable.** A standalone script that connects to a database and applies SQL. Running it would execute a migration/DDL against whatever `DATABASE_URL` is set — a DB write the current mission explicitly forbids. Not imported by `server.js`. | DO NOT RUN. Owner review required. Not committed. |
| `supabase-phase2c32-schema.sql` | **HIGH — schema.** Defines the Phase 2C.32 import pipeline tables (`import_batches`, `import_errors`, …). Per the P0A audit it ships with **RLS disabled** and `import_errors` has **no `user_id`** column (cross-tenant leak shape once a read path exists). Applying it is a migration. | DO NOT APPLY. Needs `user_id` + RLS + dry-run/approval gate before any real data load. Not committed. |
| `starlane_x_growth_log_today.md` | **LOW — content.** An unreviewed growth/marketing log. No execution risk, but out of scope for backend hardening and unreviewed. | Leave untouched. Not committed. |

## Hard rules for these artifacts
- Do **not** execute `run-schema.js` (it writes to a DB).
- Do **not** apply `supabase-phase2c32-schema.sql` (migration; unsafe table shape).
- Do **not** `git add` any of them in this lane.
- Loading Phase 2C.32 staging data remains **blocked** pending owner approval and the import-table fixes above.

> This record is the explicit "blocker" disposition permitted by the mission (STEP 11): the files are
> left untouched and their risk is recorded, rather than moved/staged.
