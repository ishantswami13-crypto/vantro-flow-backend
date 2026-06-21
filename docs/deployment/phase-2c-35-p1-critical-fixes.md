# Phase 2C.35-P1 — Critical Launch-Blocker Hardening

> Code fixes for the blockers found in the P0A audit (`docs/deployment/phase-2c-35-backend-launch-hardening.md`).
> **No production / Railway / DB / migration / external send was touched. Review-only PR — DO NOT MERGE until Codex pass.**

Base: `phase-2c-35-backend-launch-hardening` @ `aad369a`. Branch: `phase-2c-35-p1-critical-launch-hardening`.

## Fixes

| # | Blocker | Fix | Files |
|---|---|---|---|
| 1 | External-send kill switch not globally enforced | New fail-closed guard `guardExternalSend()` enforced at the **lowest boundary**: inside `sendWhatsAppMessage()` (covers all 21 call-sites incl. crons/import) and before every Twilio `calls.create` (3 voice sites). Flag OFF ⇒ returns a safe blocked result, contacts no provider. | `lib/safety/externalSend.js` (new), `server.js` |
| 2 | Background jobs auto-send | Dunning cron, briefing/scorecard crons, import day-0 loop, event/thank-you sends all route through the now-guarded `sendWhatsAppMessage`/voice guards ⇒ fail-closed automatically when the flag is off. | `server.js` |
| 3 | `preVerify` token = full session | `authMiddleware`, `requireOwner`, `adminOnly` now reject `decoded.preVerify` with 401. OTP verify/resend decode the token themselves and are unaffected. | `server.js` |
| 4 | Rust `x-user-id` fail-open | `app_env` defaults to **production** (was development). New `dev_auth_bypass` = explicit `RUST_DEV_AUTH_BYPASS=true` **AND** not on Railway **AND** not production (pure, unit-tested `compute_dev_auth_bypass`). `auth.rs` gates the header on `dev_auth_bypass`. | `vantro-automation-rs/src/config.rs`, `auth.rs` |
| 5 | Owner-briefing preview `req.user?.id` | Use `authenticatedUserId(req)` + fail-closed 401 if absent ⇒ correct attribution + audit row. | `server.js` |
| 6 | Public bill PII default-open | Signed token **required by default** (disable only with `REQUIRE_SIGNED_PUBLIC_BILLS=false`); customer phone/email/GSTIN and owner name dropped from the public payload. | `server.js` |
| 7 | Invoice/payment status inconsistency | Node bootstrap + collections use canonical columns (`invoice_amount`/`payment_amount`) and the real overdue rule (`payment_status='Pending' AND days_overdue>0`); Rust `queries.rs` overdue count/amount aligned to the same predicate (mirrors the already-compiling `queries.rs:226`). | `server.js`, `vantro-automation-rs/src/db/queries.rs` |
| 8 | AI-action send without approval | `/api/ai-actions/:id/send-whatsapp` now requires `action.status === 'approved'` (409 otherwise) before sending. | `server.js` |
| 9 | Logs leak OTP/phone/message/PII | Removed plaintext OTP log; mock-WhatsApp + inbound-WhatsApp no longer log phone/message/name; logger redaction expanded (phone, email, otp, gstin, transcript, message bodies, customer/tenant/workspace/evidence IDs). | `server.js`, `lib/observability/logger.js` |
| — | Unsafe untracked 2C.32 artifacts | Quarantine record (files left untouched, NOT staged). DO-NOT-RUN. | `docs/quarantine/phase-2c-35/QUARANTINE.md` (new) |

## Key design decision — transactional OTP exemption
The kill switch gates **customer/collections** sends. **Owner-authentication OTP delivery** (email + WhatsApp to the owner's own contact) passes `{ transactional: true }` and is **not** gated — otherwise login breaks when the flag is OFF (the staging default). This is the only exemption; every customer-facing path is gated.

## Deferred / out of scope (recorded, not changed)
- **MEDIUM (checker G08/G09):** Postgres TLS `rejectUnauthorized:false` and `jwt.verify` algorithm pin — defense-in-depth, not in the 9 blockers; left as backlog (checker reports them, non-blocking).
- **Schema drift (no migration now):** Rust `queries.rs` still `COALESCE(total_amount, invoice_amount, …)` — `total_amount`/`amount_paid` exist in staging/test schema but not canonical `supabase-schema.sql`. Reconciling needs either code (done on the Node side) or a migration (NOT run; recorded as a precondition in the P0A doc).

## Verification (all safe, offline)
- `node --check` ✅ on every changed JS file (`server.js`, `externalSend.js`, `logger.js`, checker).
- Hardening checker ✅ `node scripts/phase-2c-35-backend-launch-hardening-check.js` → **BLOCKER 0 / HIGH 0**, exit 0 (G01–G07 GREEN; G08/G09 MEDIUM backlog).
- Rust ✅ `cargo check -p vantro-automation-rs --offline` (lib type-check) + `cargo fmt --check`.
- Rust unit tests (incl. new `compute_dev_auth_bypass` fail-closed cases): **Linux CI authoritative** — local `cargo test` blocked by a Windows toolchain dep (`dlltool.exe` missing in `parking_lot_core`), not by these changes. `queries.rs` SQL is verified by `rust-sqlx-validation.yml` (ephemeral Postgres).
- No production / Railway / DB / migration / external send / cron run.
