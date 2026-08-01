# Connecting Frontend ↔ Backend ↔ Supabase

How the three pieces wire together, and how to point them at a fresh Supabase
project. Follow this top to bottom after creating a new Supabase project.

## How auth actually works

Login is **not** Supabase Auth. Supabase is used as the Postgres database only.

1. Frontend posts email + password to `POST /api/auth/login` on the backend.
2. Backend looks the user up in the `users` table and compares the bcrypt
   `password_hash`.
3. Backend signs its **own** JWT with `JWT_SECRET` and returns it.
4. Frontend stores that token and sends it as `Authorization: Bearer <token>`.

So the Supabase service-role key is a **backend-only** secret used to reach the
database. It is never sent to the browser.

## Where each value goes

Nothing below belongs in git. Set them in the hosting dashboards.

### Railway (backend)

| Variable | Where to get it |
| --- | --- |
| `SUPABASE_URL` | Supabase → Settings → API → Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Settings → API → `service_role` key |
| `DATABASE_URL` | Supabase → Settings → Database → Connection string (URI) |
| `JWT_SECRET` | Generate: `openssl rand -hex 32` |
| `ALLOWED_ORIGINS` | Your frontend origin, e.g. `https://your-app.vercel.app` |

`JWT_SECRET` signs every session token. Changing it logs everyone out.
The backend refuses to start without it.

`DATABASE_URL` is easy to skip because the backend starts and serves requests
without it — but it is not optional. `purchases`, `sales`, `khata_entries`,
`purchase_orders`, `notifications`, `inventory` and `prospect_notes` are also
created by `npm run setup:database` now (see
`migrations/006_boot_migration_promoted.sql`), so a fresh setup no longer
depends on `DATABASE_URL` for those tables to exist — but `POST
/api/invoices/migrate`, `GET /api/financial-summary/:userId` and `GET
/api/ai-financial-monitor/:userId` query Postgres directly through a
connection pool that is only opened when `DATABASE_URL` is set, and
`runAutoMigrations()` still runs at every boot to keep patching a
long-running deployment that hasn't re-run `setup:database` since. Without
`DATABASE_URL` those three endpoints 500 and schema drift over time goes
unpatched, even though the tables themselves exist from setup.
`npm run verify:connection` checks for both — configuration and whether the
tables actually exist — and `npm run security:schema-drift` lists exactly
which tables and columns depend on which path.

### Vercel (frontend)

| Variable | Value |
| --- | --- |
| `NEXT_PUBLIC_API_URL` | The Railway backend URL, no trailing slash |

This is read at **build time** and also feeds the CSP `connect-src` in
`next.config.js`. Redeploy after changing it — editing it in the Vercel
dashboard alone does not affect an already-built deployment.

## Setup order for a fresh Supabase project

```bash
# 1. Backend .env — fill SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
#    DATABASE_URL and JWT_SECRET first.
cp .env.example .env

# 2. Create the schema and the owner login (idempotent, safe to re-run)
npm run setup:database -- \
  --email owner@example.com \
  --password 'at-least-8-chars' \
  --business "Your Business" \
  --phone 91XXXXXXXXXX

# 3. Start the backend — it auto-creates the remaining tables on first boot
npm start

# 4. Confirm the whole chain works before touching the browser
npm run verify:connection -- \
  --api http://localhost:3001 \
  --origin http://localhost:3000 \
  --email owner@example.com \
  --password 'at-least-8-chars'
```

`verify:connection` checks env vars, Supabase reachability, the `users` table,
`/api/ready`, the CORS preflight for your frontend origin, and a real login
round-trip. It exits non-zero if any check fails.

## When login fails, check in this order

| Symptom | Cause | Fix |
| --- | --- | --- |
| Browser console: "Refused to connect ... violates CSP" | `NEXT_PUBLIC_API_URL` doesn't match the backend origin | Set it in Vercel and **redeploy** |
| Browser console: "blocked by CORS policy" | Frontend origin not allowed by backend | Add it to `ALLOWED_ORIGINS` on Railway |
| Preview deploys fail but production works | Vercel project was renamed | Set `VERCEL_PROJECT_SLUGS` to the new project name |
| `401 Invalid or expired token` right after logging in | `JWT_SECRET` changed between issuing and verifying | Log in again; keep the secret stable |
| `Invalid email or password` for a user you know exists | Account is in a different Supabase project | Re-run `npm run setup:database` against the current one |
| Backend exits on boot with `[FATAL] JWT_SECRET is missing` | Secret not set on Railway | Set `JWT_SECRET` |

## Cookie auth mode (not enabled)

The backend supports HttpOnly cookie auth behind `ENABLE_AUTH_COOKIES=true`.
It is **off**, and the frontend still uses the Bearer token path.

Do not switch it on without doing the frontend half first. Vercel and Railway
are different domains, so the auth cookie is a third-party cookie
(`SameSite=None`). Safari blocks those by default and Chrome is restricting
them. With cookie mode on, `saveAuth()` drops the localStorage token and relies
solely on that cookie — if the browser blocks it, every request 401s and the
app bounces back to `/login` in a loop.

See `AUTH_COOKIE_MIGRATION_PLAN.md` for the full migration.
