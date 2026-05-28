-- supabase-rls-users-businesses-rollback.sql
DROP POLICY IF EXISTS "Service Role Full Access" ON users;
DROP POLICY IF EXISTS "Users can only read own profile" ON users;
DROP POLICY IF EXISTS "Anon cannot access users" ON users;

ALTER TABLE users DISABLE ROW LEVEL SECURITY;
