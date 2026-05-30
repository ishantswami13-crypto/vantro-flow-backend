# Vantro Code OS — Speed Tracks

## Purpose

Not every task needs a war room. Using a 14-agent escalation for fixing a typo wastes context and creates noise. This file defines three execution tracks based on risk score, so Claude Code matches effort to actual risk — fast when appropriate, thorough when necessary.

---

## Risk Score → Track Selection

Calculate risk score using `risk-matrix.md` before selecting a track.

| Risk Score | Track | Protocol |
|-----------|-------|---------|
| 0–25 | **FAST TRACK** | Lightweight: classify → inspect 1-2 files → implement → 1 proof gate |
| 26–60 | **STANDARD TRACK** | Normal: classify → agents → inspect → plan → implement → proof gates → report |
| 61+ | **ESCALATED TRACK** | Full: classify → all agents → deep inspect → safe plan → peer review → implement → all proof gates → escalation verdict |

---

## FAST TRACK

**Use for**: Low-risk, single-domain tasks with no financial/auth/tenant impact.

**Examples**:
- Fix a UI label or text
- Add a console.log for debugging
- Update a comment in code
- Add a loading.tsx to a page
- Update package.json description
- Fix a typo in an error message
- Add a new cortex-lab scenario (no code change)
- Update README or documentation
- Update repo-brain files (CLAUDE.md, AGENTS.md, .claude/)

**Protocol**:
```
1. Classify (10 seconds) — confirm this is truly low-risk
2. Announce: "Fast Track — [agent name]"
3. Inspect 1-2 relevant files
4. Implement (smallest safe change)
5. Run: node --check server.js OR relevant build check
6. Report: [file changed] — [what changed] — [check result]
```

**Agents active**: Domain lead only (e.g., `vantro-frontend-ux-engineer` for UI changes)

**Proof gates (minimum)**:
- `node --check server.js` (if any JS file changed)
- `npm run lint` in frontend (if frontend file changed)
- No Harness X required (unless file touches agents/orchestrator)

**Output format**:
```
FAST TRACK ⚡
Agent: [lead agent]
Change: [file:line — what changed]
Check: [command] — PASS / FAIL
Done.
```

---

## STANDARD TRACK

**Use for**: Medium-risk tasks with clear domain, non-financial, non-auth impact.

**Examples**:
- Add a new API route (non-auth, non-payment)
- Update a service function
- Add a new frontend page (non-auth)
- Update cashflow agent logic
- Add a new Harness X scenario
- Update a feature flag default
- Fix a bug in a non-critical service
- Add observability/logging
- Update a migration (non-destructive, non-RLS)

**Protocol**:
```
1. Classify — output full task-classifier.md template
2. Announce active agents (3-5 agents)
3. Inspect relevant files (2-5 files)
4. Produce safe plan
5. Implement
6. Run proof gates (2-3 commands)
7. Report (full format)
```

**Agents active**: Domain lead + 2-3 specialists (see agent-router.md)

**Proof gates (standard)**:
- `node --check server.js`
- `npm run cortex:test`
- `npm run security:secrets`
- Domain-specific (e.g., `npm run security:cross-user` for data queries)

**Output format**: Full classification + agents + safe plan + implementation + proof gates + final report

---

## ESCALATED TRACK

**Use for**: High/critical risk tasks. Any escalation-rules.md trigger. Any uncertainty about tenant isolation, financial integrity, or external message sending.

**Examples**:
- Any authentication change (JWT, cookies, middleware)
- Any database migration
- Any payment/invoice amount mutation
- Any Rust flag enablement
- Any external WhatsApp/Twilio send enablement
- Any RLS policy change
- Any deletion or cancellation logic
- Any secrets or env var change in production
- Any cross-user data access pattern
- Any task with risk score ≥ 61

**Protocol**:
```
1. Announce: "⚠️ ESCALATED TRACK — Risk: [score]"
2. Classify — full template + escalation trigger stated
3. Announce ALL relevant agents (may be 6-10)
4. Deep inspect (all affected files)
5. Peer review: Security Sentinel reviews plan before implementation
6. Produce escalation safe plan with rollback
7. Implement (only after peer review)
8. Run ALL proof gates
9. Output escalation verdict (from escalation-rules.md)
```

**Agents active**: All relevant specialists + mandatory: security-sentinel, harness-x-verifier, database-rls-guardian (if DB), compliance-risk-agent (if external messaging)

**Proof gates (all required)**:
- `node --check server.js`
- `npm run cortex:test` (must be 100/100)
- `npm run security:smoke`
- `npm run security:secrets`
- `npm run security:cross-user`
- Domain-specific (Rust tests, perf tests, etc.)

**Output format**: Full war-room output with escalation verdict

---

## Track Selection Examples

| Task | Risk Score | Track |
|------|-----------|-------|
| "Fix the typo in empty state on /today page" | 5 | FAST |
| "Add loading.tsx to /forecast page" | 5 | FAST |
| "Add console.log to cashflow agent" | 8 | FAST |
| "Update CLAUDE.md docs" | 0 | FAST |
| "Add GET /api/cashflow endpoint" | 30 | STANDARD |
| "Update collectionsAgent.js priority scoring" | 35 | STANDARD |
| "Add new cortex-lab scenario" | 15 | FAST |
| "Add observability to briefingAgent" | 20 | FAST |
| "Change JWT expiration from 7d to 1d" | 65 | ESCALATED |
| "Enable FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED" | 75 | ESCALATED |
| "Apply migration 006 (RLS)" | 80 | ESCALATED |
| "Enable RUST_AUTOMATION_API_ENABLED" | 70 | ESCALATED |
| "Add new Supabase migration (non-destructive)" | 55 | ESCALATED |
| "Mark invoice as paid via API" | 80 | ESCALATED |

---

## Track Override Rules

1. **User can upgrade a track**: "do this safely" or "full review" or `/invoke-war-room` → always ESCALATED regardless of score
2. **User cannot downgrade a track**: If risk score says ESCALATED, it stays ESCALATED
3. **Ambiguity upgrades**: If risk score cannot be calculated (insufficient info) → upgrade to STANDARD minimum
4. **Cross-domain tasks always upgrade**: Task touching 3+ domains → always STANDARD minimum

---

## Fast Track Guard

Before using FAST TRACK, Claude Code must confirm all of these:
- [ ] No auth or JWT code touched
- [ ] No payment or invoice amount touched
- [ ] No DB migration or schema change
- [ ] No RLS policy touched
- [ ] No cross-tenant data query
- [ ] No external messaging (Twilio/WhatsApp)
- [ ] No Rust flags touched
- [ ] No secrets or env vars changed
- [ ] No `.env`, `railway.toml`, `nixpacks.toml` changed

If ANY box is unchecked → STANDARD TRACK minimum. If 3+ boxes unchecked → ESCALATED TRACK.
