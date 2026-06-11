# Phase 2C.23 — Owner Briefing GA Decision Gate

> **Status:** Implemented (decision doc + fail-closed checker), uncommitted, awaiting Codex review + Ishant approval
> **Branch:** `phase-2c-23-owner-briefing-ga-decision-gate`
> **Base:** `f948514` (origin/performance-bootstrap-cortex-fix-v1, with 2C.21 + 2C.22 merged)
> **Scope:** Backend only. No production / Railway / env / frontend / main / DB / deploy.

---

## 0. Machine-readable decision (parsed by the checker)

```
DECISION_MODEL_STATES: ga_ready | production_canary_ready | staging_proven_only | blocked
DECISION_STATE: staging_proven_only
GA_READY: no
PRODUCTION_CANARY_READY: no
STAGING_PROVEN: yes
CANARY_CLOSE_PROOF: absent
BLOCKER: real_tenant_map
BLOCKER: production_connectivity_proof
BLOCKER: production_schema_parity
BLOCKER: canary_scope
BLOCKER: explicit_owner_approval
BLOCKER: rollback_procedure
BLOCKER: observability_audit_proof
PROOF_GAP: no_canary_observation_artifacts
PROOF_GAP: confidence_gate_not_discriminating
PROOF_GAP: seeded_test_tenants_only
PROOF_GAP: flag_state_unprovable_from_repo
PROOF_GAP: evidence_data_source_unresolved
PROOF_GAP: harness_scores_not_committed
```

These markers are contract surface: `scripts/phase-2c-23-owner-briefing-ga-decision-check.js`
fails closed if the decision state is upgraded, a blocker is dropped, or a proof
gap is silently removed. Upgrading the decision requires a NEW phase that adds the
missing proof artifacts AND revises this gate deliberately.

---

## 1. Scope

Phases 2C.12–2C.22 built and proved the Owner Briefing safety machinery in
staging and static contexts, and (per the 2C.15–2C.17 doc records) deployed a
read-only production-canary preview.
Phase 2C.23 is the **honest GA/canary decision gate**: a strict four-state model,
a proof inventory that separates *proven* from *claimed-in-doc* from *missing*,
and a fail-closed checker that pins the decision to the weakest supported state.

**One new doc, one new checker. No source changes. No flag changes.**

| Artifact | Path |
|----------|------|
| This doc | `docs/agent-mesh/phase-2c-23-owner-briefing-ga-decision-gate.md` |
| Checker | `scripts/phase-2c-23-owner-briefing-ga-decision-check.js` |

## 2. Decision model

Exactly four allowed states. Rules are conjunctive — every requirement must hold.

| State | Requirements |
|-------|--------------|
| `ga_ready` | Production proof (a recorded clean canary close), rollback proven, observability proven, audit proven in production, tenant isolation proven in production, evidence integrity proven in production, and **zero** unresolved production blockers. |
| `production_canary_ready` | (For the next canary step — the Neon→Cortex evidence pipeline.) Explicit owner approval, real human-verified tenant map, production connectivity proof, production schema parity, canary scope decision, rollback staged, and the gating flag default-OFF. |
| `staging_proven_only` | The 2C.19 evidence-gate proof exists (staging) but production blockers remain. |
| `blocked` | Required proof missing or an unsafe claim detected. |

Status labels are **proof labels, not marketing labels** (2C.21 doctrine). Absence
of a recorded proof means UNKNOWN, and UNKNOWN never rounds up to PASS.

## 3. Decision: `staging_proven_only`

**Q1 — Ready for production canary (next step, evidence pipeline)?** **No.**
All five 2C.20 §4 blockers are open (see §5).

**Q2 — Ready for GA?** **No.** The only stated GA condition — ~24h of clean
production observation after the 2026-06-02 sidecar switch
(`phase-2c-17-staging-pair-decoupling-and-canary-close.md:89-91`) — has **no
recorded outcome**. Nine calendar days have elapsed, but the repo contains zero
production observation artifacts after 2026-06-02: no monitoring output, no
incident review, no clean-window attestation, no canary-close doc. *Time elapsed
is not proof.* "Clean for 9 days" is indistinguishable from "unobserved for
9 days", so the canary close is UNKNOWN, and UNKNOWN ≠ PASS.

**Nuance stated honestly:** a read-only preview production canary is *claimed* to
be running (flag ON per 2C.15/2C.17 doc prose; `core.owner_briefing` is
`live_limited` in the Runtime Truth registry). This phase does not dispute that
claim — but it cannot *prove* it from the repo, and a claimed-running canary with
no observation artifacts is not production proof. It therefore does not lift the
decision above `staging_proven_only`.

**Basis of the staging-proven marker:** the 2C.19 staging gate results are
themselves doc-recorded run records (no committed machine artifact of that gate's
output exists at this tip — the same evidence class as the Harness X scores in
proof gap 6). This gate accepts that basis explicitly and says so; if it were
rejected instead, the state would fall to `blocked` — strictly more restrictive,
never less. The asymmetry is acknowledged, conservative in direction, and closable
by committing the 2C.19 gate's machine output in a future phase.

## 4. Proof inventory

**Proven (artifact in repo, machine-checkable):**

| Proof | Artifact |
|-------|----------|
| Evidence contract enforced, fail-closed (5 rules, threshold 0.65, contract `2c.12`) | `lib/services/rustAutomation/ownerBriefingAgentClient.js:8-119` |
| 2C.19 evidence gate imports the AUTHORITATIVE contract (not a copy) | `scripts/phase-2c-19-owner-briefing-evidence-gate.js:68` |
| Preview endpoint: auth before flag gate, 404 when OFF, `req.user.id` tenant scoping, audit action `AGENT_PREVIEW` | `server.js:11744-11795` |
| Owner Briefing flag default-OFF in code (`=== 'true'`) | `lib/featureFlags.js` |
| External sending flag default-OFF; only `prompt_guard` defaults ON | `lib/featureFlags.js` |
| Runtime Truth conservative: `live_proven=0`, owner briefing `live_limited` and explicitly "NOT GA", Neon→Cortex `blocked` (reason `production_canary`), external send `blocked` | `lib/config/atlasRuntimeTruth.js` + 14/14 (2C.21) + 23/23 (2C.22) checker gates |
| 2C.20 production-readiness machinery: 12/12 static invariants | `scripts/phase-2c-20-production-readiness-check.js` + doc |
| Rust agent emits ID-only evidence (`source_type:source_id`, no raw customer ids) | `vantro-automation-rs/src/agents/owner_briefing/core_owner_briefing.rs` |

**Claimed-in-doc only (prose; no machine artifact in repo):**

- Flag ON in production since 2C.15; dedicated prod sidecar since 2C.16 — deployment claims recorded in docs; the repo proves only the code default (OFF).
- Live Harness X staging run (3 of 6 live categories, small test counts) — recorded as tables inside 2C.16/2C.17 docs; `cortex-lab/reports/latest.md` and `cortex-lab/results/latest.json` are not committed at this tip.
- Production canary "running clean" — no observation artifact exists either way.

**Missing entirely (required for GA, does not exist):**

- Any production observation artifact after 2026-06-02 (the canary-close proof).
- Automated monitoring for the six 2C.17 rollback triggers — detection today is manual; the endpoint's audit write is fire-and-forget with errors swallowed (`server.js:11788`), and no artifact proves `AGENT_PREVIEW` audit rows are being written in production.
- Any production validation with a **real** tenant — the only recorded production checks used seeded test tenants.
- A quantitative definition of the rollback triggers (e.g. what counts as a 5xx spike, and the minimum traffic that makes an observation window meaningful).

## 5. Production blockers (all open)

The five 2C.20 §4 blockers, plus two this gate adds. Marker names match §0.

1. `real_tenant_map` — Neon org email/gst are NULL; binding must be a recorded human decision (2C.20 §4.1).
2. `production_connectivity_proof` — IPv4-reachable production Cortex path + least-privilege read-only production Neon credential (2C.20 §4.2).
3. `production_schema_parity` — `sync_batches` ledger + provenance columns + partial-unique indexes in production Cortex (2C.20 §4.3).
4. `canary_scope` — one consenting tenant, single batch, batch-rollback staged, flag OFF by default (2C.20 §4.4).
5. `explicit_owner_approval` — a logged owner decision; never implied by a gate passing (2C.20 §4.5).
6. `rollback_procedure` — rollback = flag OFF is documented (2C.17), but the batch-rollback path has never been executed in production; staging-only proof.
7. `observability_audit_proof` — no artifact proves production audit rows are written or that anything watches the rollback triggers (see §4 missing list).

## 6. Proof gaps this gate pins (cannot be silently dropped)

1. `no_canary_observation_artifacts` — zero production observation artifacts after 2026-06-02; the GA window is time-expired but evidentially empty.
2. `confidence_gate_not_discriminating` — Rust emits no structured claims yet; confidence is hardcoded (0.9 with evidence_ids / 0.5 without / 0.0 when empty) in `ownerBriefingAgentClient.js:62-78`, so the 0.65 threshold currently cannot reject a real claim. Every recorded "confidence=0.9" is this constant, not a measured signal.
3. `seeded_test_tenants_only` — all recorded production-canary validation used seeded test tenants; no real tenant has exercised the path.
4. `flag_state_unprovable_from_repo` — production flag values are env state; the repo proves defaults only. The Runtime Truth API could attest live state but is itself default-OFF with no captured production response artifact.
5. `evidence_data_source_unresolved` — three sources disagree on what the prod sidecar queries: "staging Cortex" (`lib/config/atlasRuntimeTruth.js:159`), a shared Railway Postgres reference (2C.16 doc), and the hard-blocked production Supabase Cortex (2C.19 doc). Must be resolved and documented before any GA claim.
6. `harness_scores_not_committed` — all Harness X scores (static 100/100 and the staging live run) rest on doc prose; the result artifacts are absent from the tree despite `.gitignore` un-ignoring them.

## 7. Safest next move before any production touch

In order, all backend-only, none touching production:

1. **Commit this gate** (after Codex + Ishant), pinning the honest state.
2. **Resolve `evidence_data_source_unresolved` on paper first** — one doc stating which DB `vantro-automation-prod` actually queries, reconciling the three accounts. This is a documentation task; if it requires looking at live config, it needs owner approval and read-only access, and its OUTPUT is still just a doc.
3. **Define the canary observation protocol** as a committed artifact: quantitative rollback-trigger definitions, minimum observation traffic, what artifact a "clean 24h" produces, and who signs it. Without this, no future canary close can ever be proven.
4. Only then, with explicit owner approval: capture production observation artifacts (read-only) and run the protocol. That work is a NEW phase; it is out of scope here and not authorized by this gate.

No production sync, no external sending, no deploy, no flag change, no merge to
`main` is authorized by this phase. Atlas status labels remain proof labels.

## 8. How to run

```bash
node scripts/phase-2c-23-owner-briefing-ga-decision-check.js   # exit 0 = pass
```

Fail-closed: a missing artifact, an upgraded decision state, a dropped blocker or
proof gap, an overclaim, or any secret/PII shape in this phase's files fails the
run (exit 1). A SHA-256 mutation guard proves the checker changed nothing on disk.
