-- Vantro Supabase RLS rollout plan.
-- Review in staging first. Do not run directly in production without backup,
-- service-role backend verification, and cross-user test completion.

-- The backend currently uses server-side JWT auth and service-role Supabase
-- access. Service-role bypasses RLS, so backend ownership filters remain
-- mandatory even after these policies are enabled.

-- Helper notes:
-- - Supabase client JWT auth.uid() only protects direct browser Supabase usage.
-- - Vantro's custom JWT userId must continue to be enforced by Express routes.
-- - Apply table by table, then run CROSS_USER_SECURITY_TEST_PLAN.md checks.

begin;

alter table public.users enable row level security;
alter table public.invoices enable row level security;
alter table public.call_logs enable row level security;
alter table public.products enable row level security;
alter table public.stock_movements enable row level security;
alter table public.prospects enable row level security;
alter table public.dunning_rules enable row level security;
alter table public.billing_records enable row level security;
alter table public.payment_plans enable row level security;
alter table public.disputes enable row level security;
alter table public.team_members enable row level security;
alter table public.transactions enable row level security;
alter table public.bank_accounts enable row level security;
alter table public.bank_transactions enable row level security;

drop policy if exists users_own_row on public.users;
create policy users_own_row on public.users
  for all using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists invoices_own_rows on public.invoices;
create policy invoices_own_rows on public.invoices
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists call_logs_own_rows on public.call_logs;
create policy call_logs_own_rows on public.call_logs
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists products_own_rows on public.products;
create policy products_own_rows on public.products
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists stock_movements_own_rows on public.stock_movements;
create policy stock_movements_own_rows on public.stock_movements
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists prospects_own_rows on public.prospects;
create policy prospects_own_rows on public.prospects
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists dunning_rules_own_rows on public.dunning_rules;
create policy dunning_rules_own_rows on public.dunning_rules
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists billing_records_own_rows on public.billing_records;
create policy billing_records_own_rows on public.billing_records
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists payment_plans_own_rows on public.payment_plans;
create policy payment_plans_own_rows on public.payment_plans
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists disputes_own_rows on public.disputes;
create policy disputes_own_rows on public.disputes
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists team_members_owner_rows on public.team_members;
create policy team_members_owner_rows on public.team_members
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

drop policy if exists transactions_own_rows on public.transactions;
create policy transactions_own_rows on public.transactions
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists bank_accounts_own_rows on public.bank_accounts;
create policy bank_accounts_own_rows on public.bank_accounts
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists bank_transactions_own_rows on public.bank_transactions;
create policy bank_transactions_own_rows on public.bank_transactions
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

commit;

-- Rollback if staging verification fails:
-- alter table public.users disable row level security;
-- alter table public.invoices disable row level security;
-- alter table public.call_logs disable row level security;
-- alter table public.products disable row level security;
-- alter table public.stock_movements disable row level security;
-- alter table public.prospects disable row level security;
-- alter table public.dunning_rules disable row level security;
-- alter table public.billing_records disable row level security;
-- alter table public.payment_plans disable row level security;
-- alter table public.disputes disable row level security;
-- alter table public.team_members disable row level security;
-- alter table public.transactions disable row level security;
-- alter table public.bank_accounts disable row level security;
-- alter table public.bank_transactions disable row level security;
