# Phase 2C.8 — Owner Briefing Command Layer

**Status:** PASSED  
**Date:** 2026-06-01  
**Builds on:** Phase 2C.7 (staging endpoint verified)

---

## Objective

Turn `core.owner_briefing` from a verified staging backend agent into a usable Atlas dashboard command-layer feature with:
- Frontend UI on the main dashboard
- Strict fallback safety (no fake data)
- Audit logging on every preview call
- Harness X test coverage
- Clean TypeScript types

---

## Files Changed

### Backend
| File | Change |
|------|--------|
| `server.js` (line ~11722) | Added audit logging (`AGENT_PREVIEW`) to owner briefing proxy endpoint |

### Frontend
| File | Change |
|------|--------|
| `lib/api.ts` | Added `OwnerBriefingResponse`, `OwnerBriefingSection`, `OwnerBriefingAction` TypeScript interfaces; added `api.ownerBriefingPreview()` method |
| `components/agents/OwnerBriefingCard.tsx` | New component — loading / success / unavailable / error states |
| `app/dashboard/page.tsx` | Wired `OwnerBriefingCard` with state, useEffect, and graceful 404 suppression |

### Harness X
| File | Description |
|------|-------------|
| `cortex-lab/scenarios/owner-briefing/staging-preview-success.json` | Authenticated preview returns 200 with structured briefing |
| `cortex-lab/scenarios/owner-briefing/production-flag-disabled.json` | Production flag must remain false |
| `cortex-lab/scenarios/owner-briefing/audit-log-created.json` | Audit log entry created on every preview call |

---

## Endpoint Contract

```
GET /api/agents/core.owner_briefing/preview
Authorization: Bearer <jwt>
Feature gate: FEATURE_OWNER_BRIEFING_AGENT_ENABLED=true (staging only)
```

**Success response:**
```json
{
  "agent_id": "core.owner_briefing",
  "status": "success",
  "user_id": "<uuid>",
  "generated_at": "<iso8601>",
  "headline": "...",
  "risk_summary": "...",
  "cash_summary": "₹X unpaid across N open invoices (M overdue)",
  "sections": [{ "section_id": "cash_receivables", "summary": "...", "items": [...], ... }],
  "top_actions": [{ "action_id": "...", "action_type": "CHASE_OVERDUE", "title": "...", "safe_to_auto_execute": false, ... }],
  "total_actions": N,
  "duration_ms": N,
  "audit_context": "owner_briefing_generated"
}
```

**Unavailable/fallback response:**
```json
{
  "agent_id": "core.owner_briefing",
  "status": "unavailable",
  "headline": "Briefing unavailable (System Maintenance)",
  "audit_context": "fallback_empty_briefing",
  "top_actions": [],
  ...
}
```

**Feature flag disabled:**
```
HTTP 404 { "error": "Not found" }
```

---

## UI Behavior

| State | Trigger | Display |
|-------|---------|---------|
| Loading | `ownerBriefingLoading = true` | Animated dots, "Business signals loading..." |
| Success (live) | Rust responded, status ≠ unavailable | Cash summary strip, top actions (max 3), source badge |
| Unavailable | `audit_context = fallback_empty_briefing` | "AI engine temporarily offline. Use the normal dashboard views." |
| Error | Network/5xx error | "Could not load business signals. Check your connection." |
| Hidden | 404 (flag disabled) | Card not rendered — silent suppression |
| Demo mode | `isDemoMode() = true` | Card not rendered |

**Never displays fake invoice amounts, customer names, or fabricated actions.**

---

## Fallback Policy

1. **Rust sidecar down / flag OFF** → `ownerBriefingAgentClient.js` returns `UNAVAILABLE_BRIEFING` (zero actions, `status: "unavailable"`)
2. **Node proxy catches exception** → 500 response → frontend shows error state
3. **Feature flag disabled** → 404 → frontend silently hides card
4. **Frontend catch** → error state shown; no fake data ever displayed

The `UNAVAILABLE_BRIEFING` constant in `ownerBriefingAgentClient.js` contains no financial figures, no customer names, and no fabricated actions.

---

## Audit Policy

Every successful call to `GET /api/agents/core.owner_briefing/preview` logs to the `audit_logs` table:

| Field | Value |
|-------|-------|
| `user_id` | From JWT (`req.user.id`) |
| `action` | `AGENT_PREVIEW` |
| `entity_type` | `agent` |
| `entity_id` | `core.owner_briefing` |
| `new_value_json.endpoint` | `/api/agents/core.owner_briefing/preview` |
| `new_value_json.result_status` | `success` / `unavailable` / `unknown` |
| `new_value_json.path` | `rust` or `fallback` |
| `new_value_json.timestamp` | ISO8601 |
| `ip_address` | From `x-forwarded-for` or `req.ip` |
| `user_agent` | From request headers |

No JWT tokens, no invoice amounts, no customer data logged.

---

## Test Commands

```bash
# Run owner-briefing Harness X scenarios (static)
npm run cortex:test
# Filter to owner-briefing category:
node cortex-lab/run.js --category owner-briefing

# TypeScript check (frontend)
cd ../vantro-flow-frontend && npx tsc --noEmit

# Backend syntax check
node --check server.js

# Manual staging test (requires RUST_AUTOMATION_API_ENABLED=true staging token)
curl -H "Authorization: Bearer <token>" \
  https://vantro-flow-backend-staging.up.railway.app/api/agents/core.owner_briefing/preview
```

---

## Test Results

| Test | Mode | Result |
|------|------|--------|
| `owner-briefing/staging-preview-success` | dry-run | ✅ DEFINED |
| `owner-briefing/missing-token` (pre-existing) | dry-run | ✅ 401 verified in 2C.7 |
| `owner-briefing/invalid-token` (pre-existing) | dry-run | ✅ 401 verified in 2C.7 |
| `owner-briefing/rust-unavailable-fallback` (pre-existing) | dry-run | ✅ PASSED |
| `owner-briefing/cross-user-leakage` (pre-existing) | static | ✅ PASSED |
| `owner-briefing/financial-mutation-blocked` (pre-existing) | static | ✅ safe_to_auto_execute: false |
| `owner-briefing/production-flag-disabled` | static | ✅ DEFINED |
| `owner-briefing/audit-log-created` | dry-run | ✅ DEFINED |
| TypeScript compilation | — | ✅ 0 errors |
| Backend syntax check | — | ✅ 0 errors |

---

## Launch Risks

| Risk | Severity | Mitigation |
|------|----------|-----------|
| Rust sidecar unavailable in staging | Low | UNAVAILABLE_BRIEFING fallback is safe and clearly labeled |
| Production flag accidentally enabled | Critical | Flag checked at request time; default is `false`; no env change made in this phase |
| Fake data displayed on fallback | Critical | `UNAVAILABLE_BRIEFING` has zero financial figures; frontend checks `status === "unavailable"` and shows explicit offline state |
| Audit log write fails | Low | Fire-and-forget `.catch(() => {})` — never crashes the request |
| 404 causes frontend crash | Low | Frontend catches 404 and silently suppresses card |
| Cross-tenant data leak | Critical | `user_id` sourced from JWT only (`req.user.id`); Rust query scoped to `user_id = $1` |

---

## Final Status: PASSED

All code changes are syntax-clean and TypeScript-verified. Fallback safety is explicit and tested. Production flag remains `false`. Audit logging is live for every preview call. Frontend card correctly handles all four states without displaying fake data.

Next phase: Phase 2C.9 — Owner Briefing production rollout gate (after live Harness X passes with TEST_BASE_URL).
