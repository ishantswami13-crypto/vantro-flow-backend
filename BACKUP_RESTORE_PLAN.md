# Backup & Restore Plan

## 1. Supabase Point-in-Time Recovery (PITR)
- **Recommendation**: Upgrade the Supabase project to the Pro tier to enable PITR. This allows restoring the database to any minute within the last 7 days.
- **Why**: Prevents catastrophic data loss from accidental `DELETE` without `WHERE` clauses, or bad migrations.

## 2. Pre-Migration Backups
- Before executing any schema changes (e.g., adding RLS, dropping columns), a manual logical backup (`pg_dump`) must be taken.

## 3. Restore Playbook (Full Disaster)
1. Navigate to Supabase Dashboard -> Database -> Backups.
2. Select the PITR point right before the incident occurred.
3. Initiate restore.
4. Notify users of the downtime and data window lost.
