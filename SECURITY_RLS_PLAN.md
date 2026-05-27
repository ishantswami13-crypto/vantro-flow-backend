# Supabase RLS Security Plan

## Current Model

The backend uses Supabase from server-side Node.js and enforces JWT authentication, route ownership checks, and `user_id` filters in application code. If the backend uses a Supabase service role key, Supabase Row Level Security can be bypassed by the backend, so backend authorization remains mandatory even after RLS is enabled.

## Service Role Posture

The code reads `SUPABASE_URL` and `SUPABASE_KEY` from backend environment variables. The exact key type must be verified in Railway/Supabase before production RLS rollout. A service role key must only exist in backend environment variables and must never be exposed through `NEXT_PUBLIC_*`.

## Tables That Need RLS

- `users`
- `businesses` if present
- `customers` / `khata_customers` if present
- `suppliers`
- `sales`
- `purchases`
- `invoices`
- `bills`
- `payments` if present
- `bank_transactions`
- `bank_accounts`
- `products`
- `stock_movements`
- `activity_logs`
- `notifications`
- `automation_rules` / `dunning_rules`
- `documents` if present
- `orders`
- `workers`
- `team_members`

## Required Columns

Every tenant-owned table should have at least one of:

- `user_id uuid not null`
- `business_id uuid not null`
- `owner_id uuid not null` for team-owned resources

Long term, `business_id` should become the primary tenant boundary. Today, many routes use `user_id`, so RLS can start with `user_id = auth.uid()` policies after Supabase auth mapping is confirmed.

## Example Policies

Do not apply these until schema, auth.uid mapping, service-role usage, and staging tests are confirmed.

```sql
alter table public.sales enable row level security;
create policy sales_owner_select on public.sales
  for select using (user_id = auth.uid());
create policy sales_owner_insert on public.sales
  for insert with check (user_id = auth.uid());
create policy sales_owner_update on public.sales
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy sales_owner_delete on public.sales
  for delete using (user_id = auth.uid());

alter table public.purchases enable row level security;
create policy purchases_owner_all on public.purchases
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

alter table public.invoices enable row level security;
create policy invoices_owner_all on public.invoices
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

alter table public.bank_transactions enable row level security;
create policy bank_transactions_owner_all on public.bank_transactions
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

alter table public.products enable row level security;
create policy products_owner_all on public.products
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

alter table public.stock_movements enable row level security;
create policy stock_movements_owner_all on public.stock_movements
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
```

Repeat the same pattern for `customers`, `suppliers`, `bills`, `activity_logs`, `notifications`, and other tenant-owned tables.

## Rollback Plan

1. Disable RLS on affected tables in staging first if application access fails.
2. Keep a migration file that drops policies by name.
3. Preserve backend route-level checks regardless of RLS status.
4. Do not disable production RLS without incident notes and owner approval once enabled.

## Testing Plan

1. Create two staging users.
2. Seed minimal staging-only records for each user.
3. Verify User A cannot select/update/delete User B records through Supabase client.
4. Verify backend routes still return only authenticated user data.
5. Verify admin and webhook flows use backend ownership checks.

## Risk Level

High impact, medium migration risk. RLS is required before real fintech customers, but it must be staged because service-role backend queries and legacy records may need schema cleanup first.

## Steps Before Production Enablement

1. Confirm key type used by backend.
2. Confirm frontend does not expose service role key.
3. Inventory all tables and owner columns.
4. Backfill missing `user_id` or `business_id` in staging.
5. Apply policies in staging.
6. Run cross-user test matrix.
7. Schedule production migration window.
