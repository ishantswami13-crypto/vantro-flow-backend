---
phase: "2C.31"
title: "Founding Pilot Launch-Profile & Evidence Contract (Static)"
status: "contract_defined"
execution_allowed: false
external_sending_allowed: false
production_mutation_allowed: false
automatic_approval_allowed: false
pilot_readiness_claimed: false
data_loaded_by_this_phase: false
evaluator_enforced_by_this_phase: false
---

# Phase 2C.31 — Founding Pilot Launch-Profile & Evidence Contract (Static)

Phase 2C.31 defines a **static launch-profile and evidence-contract shape** for a
future pilot evaluation. It is a composition and contract definition only. It does
not connect data, does not enforce an evaluator, and provides no execution.

## What this phase IS

- A single launch profile, `swami_founding_pilot_v1`, **composed by reference** from
  the canonical Phase 2C.26 Pack Registry (by pack id only).
- Three **hook contracts** — Daily Owner Briefing, Collections Copilot, Smart Reorder —
  each mapped, only where the source registries prove it, to canonical Phase 2C.28
  agents, Phase 2C.27 workflows, and Phase 2C.30 action-approval classes.
- A read-only **evidence-contract shape** describing the output fields a future
  evaluation would have to produce (finding, evidence ids, provenance source ids,
  freshness, confidence, approval requirement, safe-to-show decision).

## What this phase explicitly is NOT

- **No pilot data is loaded by this phase.**
- **No hook computation is proven by this phase.**
- **No collections action is prepared or sent by this phase.**
- **No reorder or purchase action is prepared or committed by this phase.**
- **No evaluator service or route is added by this phase.**
- **No execution is enabled.**
- **No external sending is enabled.**
- **No production mutation is enabled.**
- **No acceptance readiness is claimed.**

This phase is a static profile and evidence-contract definition. It does not operate
as a live copilot, it does not connect a data source, and it does not enforce an
evaluator.

## Composition (canonical Pack ids, Phase 2C.26)

The `swami_founding_pilot_v1` profile references exactly these seven canonical packs
(by id; their status and permissions are owned by the Pack Registry and are not
changed here):

- `global_core`
- `trader_pack`
- `business_type_distributor`
- `business_size_smb`
- `industry_wholesale_distribution`
- `region_india`
- `role_owner`

## Hook contracts (truthful capability)

| Hook | Source agent (2C.28) | Implementation | Analysis class (2C.30) | Consequential action (2C.30) | Approval |
| --- | --- | --- | --- | --- | --- |
| Daily Owner Briefing | `core.owner_briefing` (live_limited, staging-proven, implemented) | implemented (read-only) | `read_only_analysis` | — | not required (read-only) |
| Collections Copilot | none implemented (`collections.priority_review` is roadmap) | not_implemented | `read_only_analysis` | `external_communication` (message preparation) | required for message preparation |
| Smart Reorder | none implemented (`purchase.supplier_review` is connector-required) | not_implemented | `read_only_analysis` | `financial_commitment` (purchase/reorder draft) | required for the draft |

Notes on truthfulness:

- The Daily Owner Briefing hook references `core.owner_briefing` only because the
  Phase 2C.28 Agent Registry confirms that agent is implemented and `live_limited`
  (staging-proven, read-only). The hook capability is not represented above that.
- The Collections Copilot and Smart Reorder hooks are **not implemented**: no
  implemented canonical agent supports them today. Their analysis "requires data",
  their consequential preparation/draft step is "not_implemented", and external
  sending / purchase commitment is "blocked".
- Collection-message preparation and the purchase/reorder draft are **consequential**
  actions: they map to canonical Phase 2C.30 action classes and **require explicit
  human approval**. They are never executable and never auto-approved here.

## Safety invariants

By defining this contract we record (and the checker independently re-derives):

1. `execution_allowed` is false.
2. `external_sending_allowed` is false.
3. `production_mutation_allowed` is false.
4. `automatic_approval_allowed` is false.

The evidence-contract shape additionally requires workspace/owner isolation, evidence
ids and provenance source ids for material findings, source freshness, and
**fail-closed** behaviour on missing or stale data (allowed only with an explicit
limitation).

## Relationship to prior phases

This profile composes the Pack/Agent/Workflow/Action-Approval truth from Phases
2C.26–2C.30 without modifying any of them, and does not modify Runtime Truth
(Phase 2C.21) or the legacy AI Action Center (`/api/ai-actions/*`, `ai_actions`).

## Next phase

**Phase 2C.32 must first define and prove data intake and dry-run validation** before
any hook can be said to compute, prepare, or evaluate anything. Until then no pilot
data is loaded, the evaluator shape is not enforced, and no acceptance readiness is
claimed.
