# Phase 2C.6: Owner Briefing Agent

## Overview
The `core.owner_briefing` agent is a read-only preview agent that aggregates deterministic signals across business tables (`invoices`, `customers`, `promises`) into a unified briefing for the business owner. 

This serves as the foundational aggregation layer for Atlas, allowing the owner to see immediate, prioritized risks and actions without needing a complex dashboard.

## Implementation Details
1. **Rust Core (`core_owner_briefing.rs`)**: 
   - Uses `sqlx::query("SELECT...")` with bound parameters to avoid requiring a `.sqlx` cache rebuild while strictly ensuring user-scoped queries (`WHERE user_id = $1`).
   - Generates Cash/Receivables, Data Quality, and Promise broken signals.
   - Populates the top actions based on identified risks.
2. **Safe Fallback (`ownerBriefingAgentClient.js`)**:
   - If the Rust automation sidecar is unavailable, the Node wrapper returns a safe "unavailable" briefing, indicating system maintenance.
3. **Feature Gate (`FEATURE_OWNER_BRIEFING_AGENT_ENABLED`)**:
   - The endpoint `/api/agents/core.owner_briefing/preview` is fully gated.
   - Defaults OFF.

## Security & Guarantees
- **No Mutations**: Read-only access only.
- **Fail-Closed**: A failure in Rust yields a clearly marked unavailable state, preventing hallucinated data.
- **Authorization**: Protected by standard Vantro JWT auth middleware; every query includes `user_id` scope.
- **No LLM dependencies**: Purely deterministic logic ensures zero token spend and no latency issues.

## Testing
- Node fallback tests verify unavailable states.
- 4 Harness X Scenarios (under `cortex-lab/scenarios/owner-briefing/`) ensure correct behavior for static schema, overdue invoices, block logic, and unavailable fallbacks.
