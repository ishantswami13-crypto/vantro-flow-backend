# Supabase Row Level Security (RLS) Rollout Plan

## 1. Goal
Currently, Vantro Flow relies solely on Backend Application-level Authorization (via `requireOwner` and user ID filtering). To achieve true defense-in-depth, we should enforce RLS at the database layer. 

**IMPORTANT**: Do not apply these SQL policies to production yet. They require rigorous testing to ensure background jobs and CRONs using the `service_role` key are not inadvertently broken.

## 2. Required RLS Policies

For all tables with a `user_id` column (e.g., `users`, `sales`, `purchases`, `invoices`, `bank_transactions`, `activity_logs`, etc.):

```sql
-- Enable RLS on the table
ALTER TABLE public.sales ENABLE ROW LEVEL SECURITY;

-- Create policy to restrict access to the owner
CREATE POLICY "Users can only view and modify their own sales"
ON public.sales
FOR ALL
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);
```

## 3. The `service_role` Exception
The backend currently uses the Supabase `service_role` key to interact with the database. **RLS policies are bypassed entirely when using the `service_role` key.**
To make RLS effective, the backend must switch from using the `service_role` key to using the `anon` key while injecting the user's JWT into the Supabase client context per-request:

```javascript
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  global: { headers: { Authorization: `Bearer ${userJwtToken}` } }
});
```

## 4. Rollout Strategy
1. Apply RLS policies to a staging database clone.
2. Refactor the backend to instantiate scoped Supabase clients per request using the user's JWT.
3. Test all API routes.
4. Execute migration on production during a scheduled maintenance window.
