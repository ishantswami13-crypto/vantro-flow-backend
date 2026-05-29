# Production Rollout

1. Coordinate 5-minute maintenance window.
2. Execute staging test plan.
3. Verify backend metrics for 500s.
4. If stable, apply `supabase-rls-users-businesses-staging.sql` to Production via Supabase UI.
5. Verify `SELECT count(*) FROM users;` still returns data in the admin dashboard.
6. Keep rollback script on hand.