# Phase 2C.35 — Backend Launch-Hardening Audit

> Static, read-only launch-hardening audit of the Vantro Flow backend. **No production was touched, no deploy/Railway/DB write/migration/external send was performed.** This document and `scripts/phase-2c-35-backend-launch-hardening-check.js` are the only artifacts.

| | |
|---|---|
| **Date** | 2026-06-21 (Sunday) |
| **Phase** | 2C.35-P0A — Backend Launch-Hardening Execution |
| **Repo** | `I:/Vantro/vantro-flow-backend` (`ishantswami13-crypto/vantro-flow-backend`) |
| **Integration branch** | `performance-bootstrap-cortex-fix-v1` |
| **Audited HEAD** | `881bee6` (`feat(db): add runtime pg startup packet proof`) |
| **Working branch** | `phase-2c-35-backend-launch-hardening` (isolated, from `881bee6`) |
| **Method** | 11-dimension parallel static audit + per-finding adversarial verification (33 agents), corroborated by direct source reads. |
| **Authorization honored** | audit + safe checker/docs + local commit only. No push, no PR, no DB write, no migration, no Railway, no deploy, no external send. |

## Verdict (launch stances)

| Question | Stance |
|---|---|
| Safe for first **private partner demo** | **Yes — only if** the staging no-go gate stays green **and** no provider send-credential (Interakt/WATI/Twilio WhatsApp/Twilio voice) is set in the demo environment (the external-send kill-switch is not enforced in code — see BLOCKER-1). |
| Safe for **public launch** | **No.** |
| Safe for **production DB migration** | **No** until blockers clear and owner approves; RLS-006 needs the auth bridge; the import schema (2C.32) needs `user_id` + RLS; the bootstrap schema-drift must be reconciled. |
| Safe to **enable external sends** | **No.** The kill-switch (`FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED`) is dead config — wiring it is a prerequisite. |
| **Required next action** | Hand this report to Codex for adversarial review, then owner triage of the 3 root blockers. |

## Finding counts

Workflow raw severities (pre-verification): **BLOCKER 9 · HIGH 13 · MEDIUM 8 · LOW 9** (39 findings).
After adversarial verification (1 refuted, several re-graded):

| Severity | Count (post-verification) | Distinct root causes |
|---|---|---|
| **BLOCKER** | 7 finding-sites | **3 root blockers** (the external-send kill-switch accounts for several sites) |
| **HIGH** | 9 | public-bill PII, briefing attribution, overdue-₹0 / schema drift, OTP+message logs, ai-action approval, voice calls, secondary crons, Rust overdue |
| **MEDIUM** | ~12 | error/PII logging hygiene, redaction gaps, policyGuard-bypass create(), advisory evidence contract, TLS verify, jwt alg pin |
| **LOW** | ~10 | token lifetime/revocation, comment drift, defense-in-depth scoping, dead flags |
| **REFUTED** | 1 | `import_errors` no-`user_id` — no code path exists (false positive) |

---

## Launch-blocker table (BLOCKER + HIGH)

### 🔴 BLOCKER-1 — External-send kill-switch is dead config (every send path ignores it)
- **Where:** `lib/featureFlags.js:51` (flag defined, default OFF) · `server.js:848-904` `sendWhatsAppMessage()` · all 21 send call-sites · voice `calls.create` at `6589/7440/8589` · `webpush.sendNotification` `7515`.
- **What:** `FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED` / `external_message_sending_enabled` is referenced **0×** in `server.js`. It is only *reported* (`runtimeTruth.service.js`), never *enforced*. The send choke point dispatches to Interakt → WATI → Twilio purely on credential presence. The cortex-lab red-team scenario `external-message-without-approval.json` asserts `blocked:true` but the static harness never invokes the send path — a **false-green**.
- **Impact:** No working global kill-switch. The moment any provider credential exists (per-user BYOK Interakt/WATI key, or `TWILIO_WHATSAPP_NUMBER`/Twilio voice creds), live customer messages/calls fire — including from **unattended crons** (BLOCKER-1c) and a **data import** (BLOCKER-1d). Violates Hard Rules #3/#7/#10.
- **High-risk manifestations (same root):**
  - **1a** Manual/route sends: `/api/whatsapp/send` (10340, arbitrary phone+body), `/api/collections/bulk-remind` (6106, fan-out), per-invoice `send-reminder` (6047).
  - **1b** AI-action send `/api/ai-actions/:id/send-whatsapp` (10980) — also never checks `action.status==='approved'` (see HIGH-5).
  - **1c** Daily dunning cron `runDunningCycle` (`cron '30 3 * * *'`, 6742 → WhatsApp 6721 / voice 6718) — unattended, recurring, all tenants.
  - **1d** `/api/import/manual` day-0 loop (1740) — importing a customer list blasts WhatsApp.
- **Fix:** Add a **fail-closed guard inside `sendWhatsAppMessage()`** and before every `twilioClient.calls.create()` / `webpush.sendNotification()`: if `isEnabled('external_message_sending_enabled') !== true` → return a draft/no-op (`{ success:false, provider:'draft', reason:'sending_disabled' }`) and persist a draft, never call a provider. For customer-facing paths additionally require explicit owner approval. Keep default OFF.
- **Proof (safe):** `rg -n "external_message_sending|FEATURE_EXTERNAL_MESSAGE" server.js` → 0 matches; checker gate **G01**.

### 🔴 BLOCKER-2 — Pre-OTP `preVerify` token accepted as a full authenticated session
- **Where:** `server.js:1048` (mint, returned in signup response), `519-544` `authMiddleware`, `547-576` `requireOwner`, `6998-7019` inline `adminOnly`.
- **What:** Signup mints `jwt.sign({ userId, email, preVerify:true }, JWT_SECRET, '10m')`. The OTP routes reject *non*-preVerify tokens, but the session middlewares call `req.user = verifyJWT(token)` and **never inspect `decoded.preVerify`**. Because the token carries `userId`, every protected route treats an unverified, mid-signup user as fully authenticated for 10 minutes. `phone_verified`/`email_verified` are written on OTP success but never consulted by any auth path.
- **Impact:** OTP verification gate is bypassable; a leaked `pre_token` escalates from "resend/verify only" to a full tenant session.
- **Fix:** In `authMiddleware`, `requireOwner`, and `adminOnly`, after `verifyJWT`, add `if (req.user.preVerify) return res.status(401).json({ error:'Verification incomplete' });` — or require an explicit positive `scope:'session'` claim so a missing scope fails closed.
- **Proof (safe):** `grep -n preVerify server.js` → only mint (1048) + two OTP routes (1065,1088); no rejection in auth middlewares; checker gate **G02**.

### 🔴 BLOCKER-3 — Rust sidecar `x-user-id` tenant-impersonation, fail-open by default
- **Where:** `vantro-automation-rs/src/auth.rs:47-57` · `src/config.rs:58,62-64`. (Sidecar is **ON in prod+staging** per `RUST_AUTOMATION_API_ENABLED`.)
- **What:** The Axum `AuthUser` extractor accepts a plain `x-user-id` header (any UUID, no JWT) whenever `is_dev()`. `is_dev()` is true when `app_env ∈ {development,test}`, and `app_env = env::var("NODE_ENV").unwrap_or_else(|_| "development")` — so a **missing `NODE_ENV` defaults to development** and the bypass is LIVE. Unlike Node's `IS_PRODUCTION` (which also keys off `RAILWAY_*`), `config.rs` has **no Railway fail-safe**.
- **Impact:** If the prod/staging sidecar ever starts without `NODE_ENV` explicitly set (missing/mistyped var, new service, the documented shared-env-label confusion), any caller reaching the sidecar port can impersonate **any tenant** via `x-user-id: <uuid>` with no JWT — total tenant-isolation collapse. The bypass is gated at runtime, not compiled out of release builds.
- **Fix:** Fail-closed: require an explicit dedicated opt-in (e.g. `RUST_DEV_AUTH_BYPASS=true`) rather than inferring from `NODE_ENV`, **and/or** force `is_dev()=false` whenever any `RAILWAY_*` var is present. The `x-user-id` branch must be unreachable on any Railway deployment.
- **Proof (safe):** read `auth.rs:47-57`, `config.rs:58/62-64`; no `RAILWAY_` in `config.rs`; checker gate **G03**.

### 🟠 HIGH-1 — Public bill endpoint defaults open, leaks customer + seller PII by bill UUID
- **Where:** `server.js:9156-9179` `GET /api/bills/public/:id`. No auth middleware; `.eq('id', req.params.id)` with **no** `user_id` scope; signed token only required when `REQUIRE_SIGNED_PUBLIC_BILLS === 'true'` (default OFF). Response strips only `user_id`, leaving customer name/phone/email/GSTIN + seller business_address/GSTIN/owner_name. **Fix:** default to requiring the HMAC-signed token (`signPublicBillToken`/`verifyPublicBillToken` already exist); 403 unsigned. Gate **G07**.

### 🟠 HIGH-2 — Owner-briefing preview uses bare `req.user?.id` → lost attribution + no audit log
- **Where:** `server.js:11794` (the **only** bare `req.user?.id` in server.js; JWT signs `userId`). `userId` is `undefined`, stamped as the evidence contract's `user_id` and passed to `auditService.log` which short-circuits on falsy `userId` → **no `audit_logs` row** for the production-canary briefing preview. No cross-tenant leak (Rust scopes by the forwarded JWT). **Fix:** `const userId = req.user?.userId || req.user?.id;`. Gate **G06**.

### 🟠 HIGH-3 — Overdue KPIs are structurally ₹0 (phantom status + schema drift)
- **Where:** `server.js:11524` (`.eq('payment_status','Overdue')`), `11572` (`=== 'Overdue'`); Rust `vantro-automation-rs/src/db/queries.rs:76,155`. No write path ever stores `'Overdue'` (all writes are `'Pending'`/`'Paid'`); the canonical overdue predicate elsewhere is `payment_status==='Pending' && days_overdue>0` (e.g. `server.js:10788`, `scoring.service.js:50`, `queries.rs:226`).
- **Plus schema drift:** the two `/api/v1/.../bootstrap` endpoints (and Rust `/api/v2/*`) query `total_amount` / `amount_paid`, which **do not exist** on `invoices` in the canonical `supabase-schema.sql` (only in `db/supabase-staging-base.sql` / test/seed schemas). On the canonical/prod schema, `todaySales` / `totalReceivables` compute null/NaN and `overdueInvoicesCount` / `overdueAmount` are 0.
- **Impact:** The owner's primary dashboard + collections summary show **₹0 / 0 regardless of real data** — fabricated-looking "all clear" (Hard Rule #4), demo-fatal for the Chacha acceptance test.
- **Fix:** Use the canonical columns (`invoice_amount`/`payment_amount`) and the canonical overdue predicate in both Node (`server.js:11505-11588`) and Rust (`queries.rs:76,155`). One source of truth for "overdue". Gate **G04**.

### 🟠 HIGH-4 — Plaintext OTP and full message body written to logs
- **Where:** `server.js:971` `console.log('[EMAIL OTP DEV] To: <email> | Code: ' + otp)` (when `RESEND_API_KEY` unset — the branch that actually runs today, since external send is off); `server.js:898/851` `[WA MOCK]` logs full phone + full message body (OTP, payment links flow through the same helper). Bypasses `safeLog`; `redactKeys` omits `otp`/`phone`. **Impact:** account-takeover-grade secret + PII in Railway/Loki logs (requires log access). **Fix:** never log OTP/message bodies; route through `safeLog` with values omitted/masked; add `otp`,`code`,`phone` to denylists. Gate **G05**.

### 🟠 HIGH-5 — AI-action send route does not require the action to be approved
- **Where:** `server.js:10956-10993` `POST /api/ai-actions/:id/send-whatsapp` sends then marks `done`, checking only the `ai_message_drafts` flag + credential presence — never `action.status==='approved'` / `requires_approval`, never the external-send flag. **Fix:** require `status==='approved'` (409 otherwise) **and** `isEnabled('external_message_sending_enabled')` before sending.

### 🟠 HIGH-6 — Rust sidecar overdue queries mirror the same `'Overdue'` mismatch
- Folded into HIGH-3 (`queries.rs:76,155`). Switching to the Rust engine does **not** fix the false-zero and risks divergent numbers vs Node.

---

## STEP 4 — External-send kill-switch inventory

`yes/no/unknown` = state **in code** (env credentials are a separate, fragile gate).

| Channel | Path / fn | Send-capable | Flag-gated | Approval-only | Staging-disabled (in code) | Severity |
|---|---|---|---|---|---|---|
| WhatsApp (Interakt/WATI/Twilio) | `sendWhatsAppMessage` 848-904 | **yes** | **no** | **no** | no (creds-only) | BLOCKER |
| WhatsApp manual | `/api/whatsapp/send` 10340 | yes | no | no | no | BLOCKER |
| WhatsApp bulk fan-out | `/api/collections/bulk-remind` 6106 | yes | no | no | no | BLOCKER |
| WhatsApp per-invoice | send-reminder 6047 | yes | no | no | no | BLOCKER |
| WhatsApp AI-action | `/api/ai-actions/:id/send-whatsapp` 10980 | yes | no | no (no status check) | creds-only | BLOCKER/HIGH |
| WhatsApp on import | `/api/import/manual` 1740 | yes | no | no (`automation_enabled` only) | no | BLOCKER |
| WhatsApp dunning cron | `runDunningCycle` 6721 (sched 6742) | yes | no | no | no | BLOCKER |
| WhatsApp owner crons | morning-brief 7820, weekly 10088 | yes (owner) | no | no | no | HIGH |
| WhatsApp event sends | day-0 1486, payment-plan 10119, celebration 1986, thank-you 7642 | yes | no | no | no | HIGH |
| Twilio voice (manual) | `/api/voice/call` 7440 | yes | no | no | creds-only | HIGH |
| Twilio voice (auto) | `makeAutoCall` 6589, worker 8589 | yes | no | no | creds-only | HIGH |
| Web push | `sendPushToUser` 7515 | yes (owner device) | no | n/a | VAPID-only | MEDIUM |
| Email (Resend OTP/reset) | `sendOTPEmail` | yes (transactional) | n/a | n/a | n/a | HIGH only via OTP-log (HIGH-4) |
| Agent/orchestrator tools | `toolRegistry.send_whatsapp_reminder` (throw-stub), `action.service`, `ownerBriefingAgentClient` | **no (draft-only)** | n/a | n/a | n/a | **SAFE** |
| AI-chat `send_whatsapp` tool | `executeTool` 5787 (wa.me deep-link only) | **no (link only)** | n/a | n/a | n/a | **SAFE** |

**Key takeaway:** the LLM/agent path is correctly draft-only. **The break is entirely in `server.js` HTTP routes + node-cron jobs.** Centralizing the guard inside `sendWhatsAppMessage()` + before each `calls.create()` neutralizes all WhatsApp/voice sites at once.

---

## STEP 5 — Tenant isolation & evidence audit

| Dimension | Confidence | Notes |
|---|---|---|
| **Tenant isolation** | **HIGH (strong)** | 421 supabase `.from()` + pg queries reviewed. `authMiddleware`/`requireOwner`/`adminOnly` force `req.body.user_id`/`userId`/`business_id` from the JWT and strip `role`/`plan`/`subscription`. Reads/updates/deletes carry `.eq('user_id', <token id>)`; inserts force `user_id`. `requireOwner` enforces `req.params.userId===token`. Direct pg is parameterized. **One HIGH gap:** public bill default-open (HIGH-1). Bare `req.user.id` = **0** except the briefing-preview `.id` (HIGH-2, attribution only). Cron fetch-by-id without redundant `user_id` = LOW (parent rows pre-scoped). |
| **Evidence authenticity** | **HIGH (no fabrication)** | `briefingAgent.js` derives every field from real user-scoped queries; empty data honestly surfaces as "all clear"; RAG contract fails closed (`safe_to_show=false` on empty/Rust-down). `atlasRuntimeTruth.js` is honest static data. **Gaps:** attribution (HIGH-2); `safe_to_show` is advisory — the preview ships raw ungated Rust `summary/sections/top_actions` at top level (`ownerBriefingAgentClient.js:221`, MEDIUM). |
| **Fake-evidence risk** | **LOW** | No invented customers/numbers in any Node briefing path. The **overdue-₹0** bug (HIGH-3) is the one place reality is understated to a false "all clear" — an evidence-*integrity* defect, not fabrication. |
| **Raw PII / secret risk** | **HIGH** | Public-bill PII (HIGH-1); OTP + phone + message bodies in logs (HIGH-4); raw pg error objects / `err.message` to client (MEDIUM). |
| **Readiness false-green** | **CLEAN** | `/api/health` `/api/live` = pure liveness; `/api/ready` reports DB presence-only (`database_connectivity:'not_checked'`); `/api/health/deep` returns `db:'fail'` on a real `SELECT 1` failure over the shared pool (not swallowed); `safe_to_load_data` hard-coded **false** in both paths. No probe leaks values/versions/hostnames. |

---

## STEP 6 — Production-migration precondition map

| Item | Current state | Precondition before production |
|---|---|---|
| Boot auto-migrate (`server.js:11316-11502`) | Inline **additive idempotent DDL only** (`suppliers`/`khata`/`purchases` + `ADD COLUMN IF NOT EXISTS`), non-fatal, **no RLS, no destructive op**. Does **not** run `migrations/*.sql`. | Safe to run. Ensure `DATABASE_URL` = IPv4 Supabase pooler; credential size <1024B (2C.31W ESTARTUPPACKETTOOLARGE owner ENV fix still pending). |
| `migrations/001-005, 007` | Cortex foundation/extension/eval/repair/x-ext + agent registry. Applied manually (not by boot auto-migrator). | Confirm applied in target DB; no new action. |
| `migrations/006_cortex_rls.sql` (16 RLS/policy stmts) | **NOT applied**; needs auth bridge. | Do **not** apply to prod without the auth bridge (set `app.current_user_id` from JWT). Service-role bypasses RLS, so app-layer scoping stays the live control. Known tracked gap. |
| `supabase-phase2c32-schema.sql` (import tables, **untracked** WIP) | NOT applied; ships **RLS disabled**; `import_errors` has no `user_id`. | Before any real tenant data: add `user_id` to `import_errors`, enable RLS with owner-scoped policy, wire a dry-run/approval gate. **Do NOT load staging data** (Phase 2C.32 gate). |
| **Schema drift** — `invoices.total_amount` / `amount_paid` | Used by bootstrap routes (`server.js:11505/11548`) + Rust `queries.rs`, but **absent** from canonical `supabase-schema.sql` (present only in staging/test schemas). `'Overdue'` never written. | Reconcile **before** prod serves `/api/v1/*/bootstrap` + `/api/v2/*`: fix code to `invoice_amount`/`payment_amount` + canonical overdue predicate (no migration needed). Adding columns instead = migration **+ backfill**. |

---

## MEDIUM / LOW hardening backlog (post-launch unless cheap)

**MEDIUM:** raw error/pg objects logged bypassing redaction (~26 sites); ~30 HTTP 500 return `err.message` (incl. infra hint at `8013`); redaction denylist omits `otp/phone/email/user_id`; inbound-WA handler logs customer name (`7759`); direct `action.service.create()` bypasses policyGuard (`10866/11023/11241` + toolRegistry); preview ships raw ungated Rust fields (`ownerBriefingAgentClient.js:221`); Postgres TLS `rejectUnauthorized:false` (`pgConfig.js:98`, gate **G08**); `jwt.verify` no `algorithms` allowlist (gate **G09**); import dry-run/approval gate unwired (latent — pipeline unbuilt).

**LOW:** 30-day tokens with no server-side revocation (logout clears cookie only); signup comment/lifetime drift; cron fetch-by-id without redundant `user_id` (parent pre-scoped); import tables RLS disabled (matches the known RLS-006 gap, no live code path); auto-migration logs `err.message` (username only); `SalesService 'Partial'` dead branch; Node `IS_PRODUCTION` default-off `_debug` (only on non-Railway hosts); `FEATURE_CORTEX_LAB_ENABLED` dead flag.

**Refuted (false positive):** `import_errors` missing `user_id` as a *vulnerability* — no read/write code path for `import_errors` exists anywhere; it is a forward-looking schema note, not an exploitable bug.

---

## Checker — `scripts/phase-2c-35-backend-launch-hardening-check.js`

Safe, read-only, offline static gate (no `require`/execute, no DB/network/send, no secret/PII printed). Fail-closed: exits non-zero while any BLOCKER/HIGH gate is RED.

```bash
node scripts/phase-2c-35-backend-launch-hardening-check.js            # full gate (exit 1 until fixes land)
node scripts/phase-2c-35-backend-launch-hardening-check.js --warn-high # HIGH = warning
node scripts/phase-2c-35-backend-launch-hardening-check.js --json      # machine-readable
```

**Current state at `881bee6`: RED — BLOCKER 3 (G01 kill-switch, G02 preVerify, G03 Rust x-user-id), HIGH 4 (G04 overdue, G05 OTP/message logs, G06 bare `req.user.id`, G07 public-bill PII), MEDIUM 2 (G08 TLS verify, G09 jwt alg).** Each RED gate documents an open item and turns green only when its fix lands.

## Required next action

1. Give this report + checker to **Codex** for adversarial review.
2. Owner triage of the 3 root blockers (kill-switch wiring, preVerify rejection, Rust `x-user-id` fail-closed) before any private demo with send-credentials present.
3. Do **not** load staging data, apply migrations, mutate Railway, or enable external sends without separate owner approval.
