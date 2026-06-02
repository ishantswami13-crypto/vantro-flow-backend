# Phase 2C.12 — Owner Briefing RAG Evidence Contract

**Status:** PASSED
**Date:** 2026-06-02
**Builds on:** Phase 2C.11 (JWT rotation + staging hardened)

---

## Purpose

Owner Briefing must never show unsupported AI claims. Every claim displayed to the owner must be backed by verified, tenant-scoped evidence. This phase implements the Evidence Contract: a structured validation layer between the Rust sidecar output and the frontend display.

**Core rule: No evidence → no claim. Low confidence → block claim. Risky action → owner approval required.**

---

## Why the RAG Evidence Contract Exists

Atlas agents must not hallucinate. Every business claim — unpaid invoices, overdue amounts, customer risk, cashflow pressure — must be grounded in verified tenant-scoped data pulled from the live database.

The pipeline is:

```
Live DB (invoices, customers, payments, sales)
  → tenant-scoped Rust query (user_id = $1)
  → evidence array (EvidenceItem[])
  → enforceEvidenceContract() — Node validation layer
  → AgentClaim[] with safe_to_show_claim flags
  → policy guard (safe_to_auto_execute=false)
  → audit log (briefing_id, claim_count, blocked_count, evidence_ids)
  → frontend (shows only verified claims, blocks the rest)
```

RAG is not the brain. RAG is the evidence layer. The live DB is the source of truth.

---

## Evidence Contract Schema

### EvidenceItem
```typescript
{
  id: string;
  source_type: string;              // invoice | payment | sale | customer | ...
  source_id: string;                // real DB row ID
  label?: string;
  excerpt?: string;
  amount?: number;
  currency?: string;
  created_at?: string;
  updated_at?: string;
  confidence?: number;
  metadata?: Record<string, unknown>;
}
```

### AgentClaim
```typescript
{
  id: string;
  claim: string;
  claim_type: 'summary' | 'risk' | 'opportunity' | 'action' | 'warning';
  evidence_ids: string[];           // must reference real EvidenceItem.id values
  confidence: number;               // 0.0–1.0
  safe_to_show_claim: boolean;      // enforced by Node layer
  blocked_reason?: string;          // NO_VERIFIED_EVIDENCE | CLAIM_MISSING_EVIDENCE | LOW_CONFIDENCE
  risk_level?: 'low' | 'medium' | 'high' | 'critical';
}
```

### AgentRecommendation
```typescript
{
  id: string;
  title: string;
  description: string;
  action_type: string;
  evidence_ids: string[];
  confidence: number;
  requires_human_approval: boolean; // true for any customer-facing/financial/external action
  safe_to_auto_execute: false;      // always false — Phase 2C.12 policy
  risk_level: 'low' | 'medium' | 'high' | 'critical';
}
```

### OwnerBriefingEvidenceContract
```typescript
{
  briefing_id: string;              // unique per call, used in audit log
  generated_at: string;             // ISO timestamp
  agent: 'core.owner_briefing';
  user_id?: string;                 // from JWT, never from request body
  summary: string;                  // safe copy — fallback text if safe_to_show=false
  claims: AgentClaim[];
  recommendations: AgentRecommendation[];
  evidence: EvidenceItem[];
  confidence: number;               // overall 0.0–1.0
  safe_to_show: boolean;            // true only when: evidence.length>0 AND ≥1 safe claim AND confidence≥0.65
  blocked_claim_count: number;
  evidence_source_ids: string[];    // for audit log
  audit_id?: string;
  fallback_reason?: string;         // NO_VERIFIED_EVIDENCE | ALL_CLAIMS_BLOCKED | LOW_OVERALL_CONFIDENCE | RUST_UNAVAILABLE
  contract_version: '2c.12';
}
```

---

## Enforcement Rules

Enforced in `lib/services/rustAutomation/ownerBriefingAgentClient.js` → `enforceEvidenceContract()`:

| Rule | Condition | Effect |
|------|-----------|--------|
| NO_EVIDENCE_NO_CLAIM | `evidence.length === 0` | `safe_to_show=false`, all claims `safe_to_show_claim=false`, `blocked_reason="NO_VERIFIED_EVIDENCE"` |
| CLAIM_MISSING_EVIDENCE | `claim.evidence_ids.length === 0` | `claim.safe_to_show_claim=false`, `blocked_reason="CLAIM_MISSING_EVIDENCE"` |
| LOW_CONFIDENCE | `claim.confidence < 0.65` | `claim.safe_to_show_claim=false`, `blocked_reason="LOW_CONFIDENCE"` |
| RISKY_RECOMMENDATION | action_type/title contains message/send/call/whatsapp/payment/transfer/credit/external | `requires_human_approval=true` |
| ALWAYS_MANUAL | All recommendations | `safe_to_auto_execute=false` |
| SAFE_TO_SHOW | `evidence.length>0 AND safeClaimCount>0 AND confidence≥0.65` | `safe_to_show=true` |

**Enforcement point:** Node proxy layer — applies to both Rust live responses and fallback paths.

**Confidence threshold:** `0.65` (constant `CONFIDENCE_THRESHOLD` in `ownerBriefingAgentClient.js`)

---

## Tenant-Scoped Retrieval Safety

All evidence data originates from Rust queries scoped to `user_id = $1` (from JWT). The Node proxy sources `userId` exclusively from `req.user.id` (JWT payload) — never from request body or query params.

Cross-tenant retrieval is structurally impossible:
- Rust: `WHERE user_id = $1` on all invoice/customer/payment queries
- Node: `userId = req.user?.id` passed to `evaluateOwnerBriefingRust(input, token, userId)`
- Evidence contract: `user_id` in contract comes from JWT, not from Rust response body

---

## Audit Log Fields (Phase 2C.12 Enhancement)

`action: 'AGENT_PREVIEW'` in `audit_logs` now includes:

| Field | Description |
|-------|-------------|
| `agent_name` | `core.owner_briefing` |
| `briefing_id` | Unique ID per call (from evidence contract) |
| `claim_count` | Total claims returned |
| `safe_claim_count` | Claims with `safe_to_show_claim=true` |
| `blocked_claim_count` | Claims blocked by enforcement |
| `evidence_count` | Evidence items returned |
| `evidence_source_ids` | Array of source IDs (for traceability) |
| `confidence` | Overall contract confidence |
| `safe_to_show` | Whether contract passed safety gates |
| `fallback_reason` | Why contract was blocked (if applicable) |
| `blocked_reasons` | Array of per-claim blocked reasons |
| `contract_version` | `2c.12` |

No secrets, JWT tokens, or full customer records are logged.

---

## Frontend UI Behavior

| State | Trigger | Display |
|-------|---------|---------|
| Loading | `ownerBriefingLoading=true` | Animated dots |
| Error | Network/5xx | "Could not load business signals" |
| Unavailable | `status=unavailable` or `audit_context=fallback_empty_briefing` | "AI engine temporarily offline" |
| **No evidence** | `evidence_contract.safe_to_show=false` | **"No verified evidence yet. Add invoices, customers, payments, sales, or business activity so Atlas can generate a safe briefing."** |
| **Success with contract** | `evidence_contract.safe_to_show=true` | Evidence contract panel: summary, verified claims, confidence indicator, evidence count, recommendations with approval badges |
| Success without contract | No `evidence_contract` field (legacy) | Legacy cash summary + top actions |
| Hidden | 404 (flag disabled) | Card not rendered |
| Demo mode | `isDemoMode()=true` | Card not rendered |

**Fake data policy:** No hallucinated claims, no fabricated evidence, no placeholder insights. The "no evidence" state is explicit and safe.

---

## Harness X Scenarios (Phase 2C.12)

5 new static-mode scenarios added to `cortex-lab/scenarios/owner-briefing/`:

| File | Rule | Mode |
|------|------|------|
| `no-evidence-blocks-claims.json` | `NO_EVIDENCE_NO_CLAIM` — empty evidence forces `safe_to_show=false` | static |
| `claim-without-evidence-blocked.json` | `CLAIM_MISSING_EVIDENCE` — claim with `evidence_ids=[]` is blocked | static |
| `low-confidence-claim-blocked.json` | `LOW_CONFIDENCE` — confidence < 0.65 blocks claim | static |
| `verified-evidence-allows-claim.json` | `VERIFIED_EVIDENCE_ALLOWS_CLAIM` — valid evidence+ids+confidence allows claim | static |
| `risky-recommendation-requires-approval.json` | `RISKY_RECOMMENDATION_APPROVAL_GATE` — customer-facing/external/financial requires approval | static |

Total owner-briefing scenarios: **20** (15 pre-existing + 5 new)

---

## Files Changed

### Backend
| File | Change |
|------|--------|
| `lib/services/rustAutomation/ownerBriefingAgentClient.js` | Added `enforceEvidenceContract()`, updated `evaluateOwnerBriefingRust()` to accept `userId`, always attach `evidence_contract` |
| `server.js` (line ~11737) | Pass `userId` to `evaluateOwnerBriefingRust`, extend audit log with 12 evidence contract fields |
| `cortex-lab/scenarios/owner-briefing/no-evidence-blocks-claims.json` | New scenario |
| `cortex-lab/scenarios/owner-briefing/claim-without-evidence-blocked.json` | New scenario |
| `cortex-lab/scenarios/owner-briefing/low-confidence-claim-blocked.json` | New scenario |
| `cortex-lab/scenarios/owner-briefing/verified-evidence-allows-claim.json` | New scenario |
| `cortex-lab/scenarios/owner-briefing/risky-recommendation-requires-approval.json` | New scenario |

### Frontend
| File | Change |
|------|--------|
| `lib/api.ts` | Added `EvidenceItem`, `AgentClaim`, `AgentRecommendation`, `OwnerBriefingEvidenceContract` types; added `evidence_contract?: OwnerBriefingEvidenceContract` to `OwnerBriefingResponse` |
| `components/agents/OwnerBriefingCard.tsx` | Added evidence contract panel, "no verified evidence" state, claim confidence display, recommendation approval badges, evidence source count |

---

## Test Results

| Test | Result |
|------|--------|
| `server.js` syntax check | ✅ PASS |
| `ownerBriefingAgentClient.js` syntax check | ✅ PASS |
| Harness X static (`npm run cortex:test`) | ✅ 100/100 |
| Harness X live (`npm run cortex:test:live`) | ✅ 100/100 (confirmed post-2C.12) |
| Frontend TypeScript (`npx tsc --noEmit`) | ✅ 0 new errors (1 pre-existing error in `app/admin/errors/page.tsx` — unrelated, existed before this phase) |

---

## Acceptance Criteria — Status

| Criteria | Status |
|----------|--------|
| No unsupported claim can be shown | ✅ `safe_to_show_claim=false` enforcement in Node layer |
| Every displayed claim has evidence IDs | ✅ `CLAIM_MISSING_EVIDENCE` rule blocks claims without evidence_ids |
| Empty evidence forces safe fallback | ✅ `NO_EVIDENCE_NO_CLAIM` rule + fallback summary copy |
| Low confidence blocks claim | ✅ `LOW_CONFIDENCE` rule at threshold 0.65 |
| Risky recommendations require approval | ✅ `isRiskyRecommendation()` check + `requires_human_approval=true` |
| UI shows evidence/confidence | ✅ `EvidenceContractPanel` with confidence bar + evidence count |
| UI shows "no evidence" safe state | ✅ Explicit state when `ec.safe_to_show=false` |
| Harness X proves the contract | ✅ 5 new static scenarios + live harness passes |
| No secrets exposed | ✅ No JWT/secrets in any committed file |
| Phase 2C.11 security status intact | ✅ Live harness 100/100 confirmed |

---

## Remaining Gaps

| Gap | Severity | Phase |
|-----|----------|-------|
| Rust sidecar does not yet return `evidence[]` array in response | Medium | 2C.13 — Rust sidecar evidence output |
| Without Rust evidence, `enforceEvidenceContract` correctly shows "no evidence" state | ✅ Safe | By design |
| Live DB-level evidence assertion (test Supabase) | Low | 2C.13 |
| `event_audit_completeness` harness category (needs test Supabase) | Low | 2C.13 |

**Note:** The enforcement layer is production-safe today. When Rust begins returning `evidence[]`, it will immediately flow through the contract without any Node proxy changes needed.

---

## Launch Impact

- **launch_blocker = false**
- Owner Briefing is now evidence-contract-enforced end to end
- The "no evidence" safe state prevents any display of hallucinated data
- All existing Phase 2C.11 security guarantees remain intact
- Production flag `FEATURE_OWNER_BRIEFING_AGENT_ENABLED` remains `false`

---

## Next Phase: 2C.13 — Rust Evidence Output + Live Evidence Contract Proof

1. Add `evidence: Vec<EvidenceItem>` to Rust `OwnerBriefingOutput` struct
2. Populate evidence items from real invoice/customer DB queries (already scoped by `user_id`)
3. Validate end-to-end: Rust → Node enforcement → frontend evidence panel
4. Add live Harness X scenarios with test Supabase for `event_audit_completeness`
5. Run full live harness and confirm safe claims appear in frontend
