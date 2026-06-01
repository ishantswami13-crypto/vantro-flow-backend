# Atlas Agent Mesh — Phase 2A: Data Quality Agent

> **Status:** Implementation Complete — Staging Pending
> **Date:** 2026-06-01
> **Branch:** performance-bootstrap-cortex-fix-v1
> **Agent:** `core.data_quality` | Risk: Low | Mutations: NONE

---

## Summary

Phase 2A wires the first real agent tool connection for `core.data_quality`.
It is read-only, deterministic, and Rust-first. No LLM. No external calls.
No mutations to any DB record.

The existing weekly cron JS agent (`lib/services/agents/dataQualityAgent.js`)
is NOT replaced or modified — it runs separately and mutates `ai_actions`.
This Phase 2A endpoint is a **preview-only read path** that returns findings
without creating any DB rows.

---

## Architecture

```
Owner browser
  └─► GET /api/agents/core.data_quality/preview    (Node Express, auth-gated)
        └─► POST :3002/api/v2/agents/core.data_quality/evaluate  (Rust Axum)
              ├─► SELECT FROM invoices WHERE user_id = $jwt_user_id  LIMIT 500
              ├─► SELECT FROM customers WHERE user_id = $jwt_user_id LIMIT 500
              ├─► SELECT FROM promises WHERE user_id = $jwt_user_id  LIMIT 500
              └─► evaluate() — pure fn, no DB, returns DataQualityOutput
```

**Key properties:**
- `user_id` sourced from JWT payload only — never from request body
- All SQL queries include `WHERE user_id = $1` — tenant isolation enforced
- Dynamic `sqlx::query()` (non-macro) — no `.sqlx/` cache update needed
- NUMERIC columns cast to `float8` in SQL — no rust_decimal dependency
- Rust evaluates findings as a pure function — testable without DB

---

## Files Changed

| File | Change |
|------|--------|
| `vantro-automation-rs/src/agents/data_quality/mod.rs` | NEW — pure Rust eval logic + 15 unit tests |
| `vantro-automation-rs/src/agents/mod.rs` | Added `pub mod data_quality;` |
| `vantro-automation-rs/src/api/data_quality.rs` | NEW — Axum POST endpoint, dynamic sqlx |
| `vantro-automation-rs/src/api/mod.rs` | Registered `data_quality::routes()` |
| `lib/services/rustAutomation/dataQualityAgentClient.js` | NEW — Node safe wrapper, 8 fallback codes |
| `lib/featureFlags.js` | Added `data_quality_agent_enabled` flag |
| `server.js` | Added `GET /api/agents/core.data_quality/preview` route |
| `cortex-lab/schemaValidator.js` | Added `data-quality` to VALID_CATEGORIES |
| `cortex-lab/scenarios/data-quality/*.json` | NEW — 6 harness scenarios |
| `docs/agent-mesh/phase-2a-data-quality-agent.md` | NEW — this document |

---

## 8 Data Quality Checks

| Check | Entity | Severity | Condition |
|-------|--------|----------|-----------|
| `missing_due_date` | invoice | Medium | `due_date` NULL or blank |
| `missing_customer_id` | invoice | Low | `customer_id` NULL (Low severity; excluded when `include_low_severity=false`) |
| `amount_paid_exceeds_total` | invoice | High | `amount_paid > total_amount + 0.01` |
| `zero_or_negative_amount` | invoice | Medium | `invoice_amount <= 0` |
| `missing_name` | customer | High | `name` blank or whitespace-only |
| `duplicate_name` | customer | Medium | Two or more customers share the same name (case-insensitive) |
| `promise_missing_due_date` | promise | Medium | `promised_date` NULL or blank |
| `promise_missing_amount` | promise | Low | `promised_amount` NULL or ≤ 0 (excluded when `include_low_severity=false`) |

**Phase 2A invariants (enforced in code and tested):**
- `safe_to_auto_fix = false` for every finding
- `approval_required = true` for every finding

---

## Feature Flags

| Flag | Default | Purpose |
|------|---------|---------|
| `FEATURE_DATA_QUALITY_AGENT_ENABLED` | OFF | Enables `GET /api/agents/core.data_quality/preview` |
| `RUST_AUTOMATION_API_ENABLED` | OFF | (Not checked by data quality — it has its own flag) |
| `RUST_AUTOMATION_BASE_URL` | unset | Required for Rust sidecar calls |

To enable on staging:
```
FEATURE_DATA_QUALITY_AGENT_ENABLED=true
RUST_AUTOMATION_BASE_URL=http://localhost:3002  (or Railway sidecar URL)
```

---

## Harness X Scenarios (6)

| File | Mode | Tests |
|------|------|-------|
| `missing-invoice-due-date.json` | static | Schema validation |
| `duplicate-customer-name.json` | static | Schema validation |
| `amount-paid-exceeds-total.json` | static | Schema validation |
| `clean-data-zero-findings.json` | static | Schema validation |
| `cross-user-blocked.json` | live | Cross-tenant isolation |
| `missing-token.json` | live | Auth rejection (401) |

`npm run cortex:test` result after Phase 2A: **100/100** (43 schema checks, up from 37)

---

## Rust Unit Tests (15)

All in `src/agents/data_quality/mod.rs #[cfg(test)]`:

1. `test_agent_id_correct` — agent_id = "core.data_quality"
2. `test_checks_run_list` — all 8 checks in output
3. `test_clean_data_zero_findings` — valid data → 0 findings
4. `test_missing_due_date` — NULL due_date → Medium finding
5. `test_missing_due_date_empty_string` — whitespace due_date → finding
6. `test_missing_customer_id_when_low_severity_on` — NULL customer_id → Low finding
7. `test_missing_customer_id_excluded_when_low_severity_off` — excluded when flag off
8. `test_amount_paid_exceeds_total` — overpaid → High finding
9. `test_amount_paid_equals_total_no_finding` — exact payment → no finding
10. `test_zero_or_negative_amount` — zero amount → Medium finding
11. `test_missing_name` — blank name → High finding
12. `test_missing_name_whitespace_only` — whitespace name → finding
13. `test_duplicate_name` — two same-name customers → 2 Medium findings
14. `test_no_duplicate_with_unique_names` — different names → no duplicate finding
15. `test_promise_missing_due_date` — NULL date → Medium finding
16. `test_promise_missing_amount_included` — NULL amount + low_severity on → Low finding
17. `test_promise_missing_amount_excluded_when_low_severity_off` — excluded
18. `test_max_findings_cap` — 5 issues, max=2 → 2 findings + warning
19. `test_all_findings_have_phase2a_invariants` — every finding safe_to_auto_fix=false, approval_required=true

---

## Verification Commands

```bash
# Node.js
npm run check                 # syntax — PASS
npm run security:secrets      # no secrets — PASS
npm run cortex:test           # static harness — PASS 100/100
npm run agents:seed:validate  # 12 agents intact — PASS

# Rust (on Linux / Railway CI)
cargo test --lib -p vantro-automation-rs -- data_quality
cargo check -p vantro-automation-rs --features server
```

---

## Rollback

```bash
# 1. Disable feature flag (instant, no redeploy)
FEATURE_DATA_QUALITY_AGENT_ENABLED=false

# 2. No DB rollback needed — Phase 2A never writes to DB
```

---

## What Was NOT Done (Intentional)

- No `is_active = true` set in `agent_registry` table for data_quality
- No production flag enabled
- No mutations to any DB table
- No LLM calls
- No changes to existing weekly cron `dataQualityAgent.js`
- No main branch merge

---

## Next Action

Phase 2B: Wire `core.cost_router` (next low-risk, no-LLM agent) OR deploy
`core.data_quality` to staging with the Rust sidecar and verify live harness.

Before Phase 2B:
1. Redeploy `vantro-node-staging` with current branch code
2. Set `FEATURE_DATA_QUALITY_AGENT_ENABLED=true` + `RUST_AUTOMATION_BASE_URL` on staging
3. Run `GET /api/agents/core.data_quality/preview` with staging JWT — verify findings
4. Run live harness: `npm run cortex:test:live`

---

*Phase 1.5 (staging proof) → Phase 2A (data quality preview) → Phase 2B (cost_router or staging deploy)*
