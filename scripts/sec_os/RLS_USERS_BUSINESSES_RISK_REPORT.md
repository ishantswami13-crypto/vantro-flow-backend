# Risk Report

- **Tables Covered**: `users`.
- **Tables Excluded**: `businesses` (does not exist as standalone table), `invoices`, `sales`, `payments`, etc.
- **Risk Level**: LOW. 
- **Justification**: Vantro's backend uses `SUPABASE_SERVICE_ROLE_KEY` and custom JWTs. The backend bypasses RLS natively. The only risk is if the backend was inadvertently relying on `anon` keys, which source code analysis confirms it is not.