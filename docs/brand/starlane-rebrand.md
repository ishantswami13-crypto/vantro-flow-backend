# Starlane Rebrand — Brand Truth Record

**Date:** 2026-06-19

## Brand Truth

| Key | Value |
|-----|-------|
| **Company** | Atlax |
| **Product / platform** | Starlane |
| **Previous product name** | Atlas |
| **Group name** | None — do not reference any group name in public copy |

## Rules

- All public and product-facing copy must use **Starlane** for the product.
- All company/legal/public copy must use **Atlax** for the company.
- Do not use "Vantro" as a company or product name in any public brand surface.
- Do not use "Auren", "VastFoundry", or any group name.
- Internal historical references (phase proof docs, commit history, internal technical identifiers) may remain as Atlas/Vantro and must NOT be renamed without a dedicated migration plan.
- When referring to the product's history: "Starlane, formerly Atlas" — acceptable in docs only, not in main UI.

## What Was Changed (2026-06-19)

### Public social copy
- `docs/brand/x-launch-assets.md` — X/Twitter profile bio, pinned tweet, and launch-day post sequence updated from Atlas → Starlane, Vantro → Atlax.

### Public product-facing text (server.js)
- OTP email HTML template: product name → Starlane, company footer → Atlax · Starlane.
- Password reset email: subject and body → Starlane.
- WhatsApp OTP messages → Starlane.
- WhatsApp test confirmation message → Starlane.
- Morning briefing push notification and WhatsApp → Starlane.
- Weekly scorecard WhatsApp message → Starlane.
- Payment celebration WhatsApp → Starlane.
- Worker voice notification script → Starlane.
- Voice call default greeting → Starlane.
- AI co-founder system prompt → Starlane.
- Debt collection AI prompt identity → Starlane AI.
- Bulk WhatsApp AI prompt identity → Starlane AI.
- Main brain AI system prompt → Starlane AI.
- Fallback business name in all customer-facing message paths → Starlane.
- Billing plan names → Starlane Starter / Starlane Growth / Starlane Pro.
- DB setup error instructions → Starlane.
- HTML report title and heading → Starlane.
- OpenRouter X-Title header → Starlane.

### Not changed (intentionally)
- **API routes** (`/api/atlas/...`) — runtime API contract; requires dedicated route migration.
- **Env var names** (`FEATURE_ATLAS_*`) — runtime contract; requires Railway + client update.
- **Cookie names** (`vantro_access_token`, `vantro_csrf`) — runtime contract; requires coordinated frontend migration.
- **Infrastructure URLs** (`vantro-flow-frontend.vercel.app`, `vantro-flow.vercel.app`, etc.) — live infrastructure; do not rename here.
- **VAPID email** (`hello@vantroflow.com`) — infrastructure credential.
- **UPI ID** (`vantro@upi`) — payment credential.
- **Webhook secret header** (`x-vantro-webhook-secret`) — API contract header.
- **Receipt ID format** (`vantro_${userId}`) — internal Razorpay ID.
- **Referral link URL** (`vantroflow.app`) — live URL; requires separate redirect/domain migration.
- **Internal code identifiers** (`atlasAgentRegistry`, `atlasPackRegistry`, etc.) — internal service identifiers; safe to alias later but not blindly renamed.
- **DB migrations** — never touched.
- **Historical phase proof docs** (`docs/agent-mesh/phase-2c-*.md`, `cortex-lab/reports/`) — historical records; Atlas = previous product name.
- **File names** containing `atlas` or `vantro` — internal identifiers.

## Logo / Visual Asset Status

| Asset | File | Status |
|-------|------|--------|
| Starlane product icon (square) | `docs/brand/starlane-icon.jpeg` | **Approved** — 4-pointed sparkle star with orbital arc and dot, white on black. |
| Starlane product wordmark (horizontal) | `docs/brand/starlane-wordmark.jpeg` | **Approved** — icon + STARLANE text, white on black. |
| Atlax company logo/wordmark | — | **Pending** — no approved final asset. TODO: design and commit. |
| X profile picture | — | TODO: update to `starlane-icon.jpeg` before launch. |
| X banner | — | TODO: update from Atlas banner to Starlane banner before launch. |

## Required Next Actions

1. ~~**Logo design**~~ — **DONE.** `starlane-icon.jpeg` and `starlane-wordmark.jpeg` approved and saved to `docs/brand/`.
2. **X profile assets** — upload `starlane-icon.jpeg` as DP. Design and upload Starlane banner (replaces Atlas banner).
3. **API route migration** — plan `/api/starlane/...` aliases for `/api/atlas/...` routes (non-breaking, additive).
4. **Env var migration** — plan `FEATURE_STARLANE_*` aliases for `FEATURE_ATLAS_*` vars in Railway.
5. **Cookie migration** — coordinate frontend + backend rename of `vantro_access_token` / `vantro_csrf`.
6. **Referral domain** — migrate `vantroflow.app` or set redirect to final Starlane domain.
7. **Frontend rebrand** — the `vantro-flow-frontend` project (Vercel) needs its own brand pass.
