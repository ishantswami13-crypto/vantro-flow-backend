-- supabase-rls-users-businesses-staging.sql
-- Enables RLS on the core 'users' table. 
-- Note: 'businesses' and 'memberships' are not discrete tables in the current schema; 
-- Business context is handled via the 'business_name' and 'plan' columns on the 'users' table.

-- 1. Enable RLS
ALTER TABLE users ENABLE ROW LEVEL SECURITY;

-- 2. Service Role Bypass
-- Supabase service_role bypasses RLS by default, but we add an explicit policy for clarity 
-- in case of Custom JWT usage in the future.
CREATE POLICY "Service Role Full Access"
ON users
FOR ALL
USING (auth.jwt() ->> 'role' = 'service_role' OR auth.jwt() ->> 'is_admin' = 'true');

-- 3. Client Isolation
-- Normal users cannot read or write global users directly via client SDK.
-- All requests route through the backend Node.js server which enforces custom JWT auth.
CREATE POLICY "Users can only read own profile"
ON users
FOR SELECT
TO authenticated
USING (auth.uid() = id);

-- 4. Reject Anon
CREATE POLICY "Anon cannot access users"
ON users
FOR ALL
TO anon
USING (false);
