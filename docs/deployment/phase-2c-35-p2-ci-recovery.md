# Phase 2C.35-P2 — CI Recovery + Adversarial-Gap Closure

> Follow-up on PR #27. Makes CI green and closes the remaining adversarial gaps. **No production / Railway / DB write / migration / external send / merge.**

## CI failures — root cause + fix
Both failing jobs shared **one** root cause: the committed sqlx **offline cache** (`.sqlx/`) was stale after the P1 `queries.rs` overdue-predicate edit.
- `server-feature offline build (SQLX_OFFLINE=true)` failed: `queries.rs:74/154` "no cached data for this query".
- `live /api/v2 harness` builds `SQLX_OFFLINE=true` too (and runs `NODE_ENV=production` with **real JWT**, never the `x-user-id` bypass) — so it failed on the same cache miss, *not* on the auth change.

**Fix:** regenerated the two affected cache entries (`query-2640…→c6df10…`, `query-d318…→29b5476…`). The describe metadata is unchanged (only the WHERE/CASE predicate changed); each new entry was derived by the identical substring substitution applied to the source **and** independently cross-checked against the live `queries.rs` literal (`sha256(query)==filename==hash`). The "SQLx prepare" job (which regenerates its own cache vs an ephemeral Postgres) already proved the new SQL is valid. No Rust test references the bypass, so the fail-closed change breaks nothing.

## Adversarial-gap closures
| Gap | Fix |
|---|---|
| **G05/PII logs** | New `maskId()`/`maskPhone()` helpers. Removed raw call **transcript** (server.js:~8541 → length only), WhatsApp provider **phone digits** (Interakt/Wati/Twilio logs → masked), **OTP recipient email** (dropped), and masked **raw user/tenant IDs** in cache/auto-reconcile/event/order logs and **customer names** in dunning logs. Logger denylist already expanded in P1. |
| **G04/`status='unpaid'`** | The 3 `invoices.eq('status','unpaid')` reads (server.js ~8853/9007/9057) → `payment_status='Pending'` (invoices have no `status` column; `bills`/`orders` `status` left intact). |
| **G01/OTP+push policy** | Guard module now has 3 explicit policies: business sends gated by `FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED`; **auth OTP** via explicit `FEATURE_AUTH_OTP_SENDING_ENABLED` (default ON, documented exception — login must work); **web-push fail-closed** via `FEATURE_PUSH_NOTIFICATIONS_ENABLED` (default OFF) + `guardPush()` in `sendPushToUser`. Provider creds alone never enable a business send. |
| **G07/public bill PII** | Default external-safe payload drops seller `gstin` + `business_address` (now `users(business_name, city)` only); customer phone/email/GSTIN + owner name already removed in P1; signed token still required by default. |
| **G09/JWT alg** | `verifyJWT` pins `{ algorithms: ['HS256'] }` on both verify calls. |
| **G08/Postgres TLS** | **Documented MEDIUM — intentionally not changed in code.** The 2C.31V/W startup-packet gates assert the exact `ssl: { rejectUnauthorized: false }` shape, and flipping it without the Supabase CA would break the DB runtime. **Owner action:** supply the Supabase CA + enable verification via staging/production env (no code env mutation). |

## Checker
`scripts/phase-2c-35-backend-launch-hardening-check.js` updated: G07 now inspects the public-bill `.select(...)` field list; added **G10** (`invoices.status='unpaid'`), **G11** (direct `console.*` PII/message leaks), **G12** (OTP explicit-flag + web-push fail-closed); G08 reports MEDIUM with the explicit owner action; G09 now green.

**Result: BLOCKER 0 · HIGH 0 · MEDIUM 1 (G08 documented), exit 0.**

## Verification (safe, offline)
`node --check` (all changed JS) ✅ · checker exit 0 ✅ · `cargo fmt --check` ✅ · `cargo check -p vantro-automation-rs --offline` ✅ · all `.sqlx` entries `sha256(query)==filename==hash` ✅ · secret/PII scan on changed files ✅. Rust server-feature offline build + harness verified by **Linux CI** (local blocked by the Windows `dlltool` toolchain gap). No prod/Railway/DB/migration/external-send/cron.
