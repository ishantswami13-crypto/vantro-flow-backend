# Rollback Plan

If the RLS migration blocks legitimate backend queries:
1. Open Supabase SQL Editor.
2. Execute `supabase-rls-users-businesses-rollback.sql`.
3. This will drop the 3 policies and DISABLE row level security on the `users` table.
4. Data will NOT be truncated.