# Backup and Restore Drill (Runbook)

This document outlines the procedure to safely test Database backups and restore procedures.

## 1. Trigger Manual Backup
- If using Supabase, go to Database -> Backups and select "Backup Now".
- Alternatively, use `pg_dump`:
  ```bash
  pg_dump "$DATABASE_URL" -Fc > backup_$(date +%F).dump
  ```

## 2. Restore to Staging Environment
- Do NOT restore over production! Create a new isolated database.
- Use `pg_restore`:
  ```bash
  pg_restore -d "$STAGING_DATABASE_URL" backup_$(date +%F).dump
  ```

## 3. Verify Data Integrity
- Check record counts in `users`, `invoices`, `transactions`, `sales`, and `purchases`.
- Verify RLS policies are applied correctly in the staging database.
- Perform a simulated login (using staging JWT secrets).

## 4. Disaster Recovery (DR) Readiness
- Run this drill quarterly.
- Keep recovery times under 30 minutes (RTO).
- RPO (Recovery Point Objective) depends on PITR (Point in Time Recovery) settings (typically 1 hour to 1 day).
