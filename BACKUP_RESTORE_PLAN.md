# Backup And Restore Plan

Status: plan only. No production backup settings were changed by this document.

## Backup Objectives

- Protect customer, supplier, invoice, purchase, sale, ledger, bank transaction, inventory, and audit-log data.
- Support point-in-time recovery for accidental deletes, bad deploys, security incidents, and failed migrations.
- Keep backups encrypted and access-controlled.

## Recommended Supabase/Postgres Setup

- Enable daily automated backups at minimum.
- Enable point-in-time recovery before onboarding real customers.
- Take a manual backup before any schema migration, RLS rollout, auth migration, or financial reconciliation change.
- Keep separate development, staging, and production projects/databases.
- Restrict backup access to owners/admins only.

## Critical Data To Verify

- `users`
- `invoices`
- `bills`
- `sales`
- `purchases`
- `products`
- `stock_movements`
- `transactions`
- `bank_accounts`
- `bank_transactions`
- `customers` and `suppliers` if present
- `activity_logs`
- `notifications`
- `payment_plans`
- `disputes`
- integration settings stored on `users`

## Restore Drill

1. Restore production backup into a staging database.
2. Point a staging backend to the restored database.
3. Run smoke checks:
   - login
   - `/api/auth/me`
   - inventory
   - sales
   - purchases
   - ledger
   - analytics
   - public signed bill link
4. Run cross-user tests.
5. Verify financial totals against pre-incident snapshots.

## Before Migration Checklist

- Confirm latest backup exists.
- Export migration SQL.
- Confirm rollback SQL exists.
- Run migration on staging.
- Run cross-user tests on staging.
- Schedule production migration during low-traffic window.

## Rollback Strategy

- For code-only issues: redeploy previous Git commit.
- For schema issues: apply rollback SQL only if reviewed and tested.
- For data corruption: restore to staging, inspect, then plan targeted repair or full restore.

## Access Control

- Backup access should be limited to production owners.
- Backup downloads should be encrypted at rest.
- No backups should be committed to GitHub, shared by chat, or stored on developer desktops long-term.
