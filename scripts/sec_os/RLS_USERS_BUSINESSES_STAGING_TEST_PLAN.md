# RLS Staging Test Plan

1. **Backup First**: Take a logical backup of the staging database.
2. **Apply SQL**: Run `supabase-rls-users-businesses-staging.sql` in Supabase.
3. **Test Auth**: Verify existing login and new signup workflows.
4. **Verify Backend**: Ensure `/api/auth/me` returns user details (validating service_role bypass).
5. **Security Check**: Attempt to query `users` via client SDK anonymously (must fail).
6. **Rollback**: Run rollback SQL and ensure table remains intact.