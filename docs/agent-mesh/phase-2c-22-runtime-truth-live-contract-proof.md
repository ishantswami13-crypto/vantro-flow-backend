# Phase 2C.22 — Runtime Truth Live Contract Proof

> **Status:** Implemented (proof script + doc), uncommitted, awaiting Codex review + Ishant approval
> **Branch:** `phase-2c-22-runtime-truth-live-contract`
> **Base:** `c9931e4` (origin/performance-bootstrap-cortex-fix-v1, with Phase 2C.21 merged)
> **Scope:** Backend only. No production / Railway / env / frontend / main / DB / deploy.

---

## 1. Scope

Phase 2C.21 shipped the Runtime Truth API and a 14-gate *static* checker. Phase
2C.22 adds a **live contract proof**: it stands the endpoint up over **real HTTP**
in a local/staging-safe process and proves the served behaviour matches the static
contract — without ever booting the `server.js` monolith.

**One new script, one doc. No source changes:**

| Artifact | Path |
|----------|------|
| Proof script | `scripts/phase-2c-22-runtime-truth-live-contract-check.js` |
| This doc | `docs/agent-mesh/phase-2c-22-runtime-truth-live-contract-proof.md` |

## 2. Why not boot `server.js`

`server.js` runs `validateSecurityEnvironment()` (which `process.exit(1)`s without
`JWT_SECRET`), binds `PORT`, and calls `runAutoMigrations()` — all at module load,
with **no `require.main === module` guard**. Requiring it would open a DB
connection and is not local/staging-safe. So the harness instead:

- Stands up a tiny HTTP server on an **ephemeral `127.0.0.1` port** using only Node
  built-ins (`http` + `crypto`).
- **Auth:** a faithful **HS256 mirror** of `server.js`'s `authMiddleware` /
  `verifyJWT` (Bearer token; missing → 401 `Missing token`; bad signature → 401
  `Invalid or expired token`). The mirror matches the repo's default `jsonwebtoken`
  HS256 algorithm. A throwaway local test secret is used and is **never printed**.
- **Flag gate + payload:** the **REAL production modules** — `lib/featureFlags.js`
  (`isEnabled`) and `lib/services/runtimeTruth.service.js` (`buildRuntimeTruth`).
  No business logic is reimplemented.
- **Static cross-check:** asserts `server.js`'s real route uses the same
  `authMiddleware`, the same `runtime_truth_api_enabled` flag gate (returning 404),
  and `buildRuntimeTruth` — so the harness faithfully represents production wiring.

The in-process `FEATURE_RUNTIME_TRUTH_API_ENABLED` toggle is flipped in memory only
(with a `require`-cache reload of the real flags module); **no env file is written.**

## 3. What was proven (all gates green)

**OFF behaviour** (flag absent/false):
- Authenticated `GET /api/atlas/runtime-truth` → **HTTP 404** with generic body
  `{ "error": "Not found" }` (single key).
- The disabled response **leaks no runtime-truth details** (no `platform`,
  `summary`, `packs`, `agents`, `workflows`, `launch_claims`, `truth_version`).

**Auth behaviour** (independent of flag):
- No token → **401** `Missing token`.
- Invalid token → **401** `Invalid or expired token`.
- No token while flag OFF → **401** (auth runs **before** the flag gate; missing
  token short-circuits before any 404).

**ON behaviour** (flag set in-process, staging-safe):
- Authenticated request → **HTTP 200** with the JSON truth contract
  (`platform: "atlas"`, populated `summary`, `packs[]`).

**Served payload == pure builder output (no drift):**
- The served JSON **byte-equals** `buildRuntimeTruth({ generatedAt: <served.generated_at> })`
  (`drift_field: null`) — same counts, same status classifications, same
  allowed/blocked claims.

**Payload invariants:**
- `environment === "safe_redacted"`.
- No forbidden keys (`DATABASE_URL` / `JWT_SECRET` / `SUPABASE` / `RAILWAY` /
  `PASSWORD` / `SECRET` / `TOKEN`) and no value shaped like a DB URL, JWT, bearer
  token, email, phone, or Stripe/Razorpay live key.
- No overclaim phrase in `launch_claims.allowed`.
- `live_proven === 0`; exactly two `live_limited` — `core.owner_briefing` and
  `workflow.owner_briefing_preview`.
- `workflow.neon_to_cortex_sync` → `blocked`; `workflow.external_message_send` →
  `blocked`; `execution_enabled` / `external_send_enabled` /
  `production_sync_enabled` all `false`.

**HTTP status matrix proven:** OFF=404, ON=200, no-token=401, bad-token=401,
OFF+no-token=401. **Served summary:** `live_proven 0, live_limited 2, planned 11,
blocked 2`.

## 4. Safety / no-PII result

- No production DB connection; no external network call; no monolith boot
  (`booted_real_server_monolith: false`).
- No Railway, no deploy, no env-file write, no frontend, no `main`.
- Payload deep-scan clean (`no_forbidden_keys`, `no_pii_values`).
- A **SHA-256 mutation guard** proves the script + this doc are unchanged by the run.
- Output is counts/booleans only — the test token and test secret are never printed.

## 5. How to run

```bash
node scripts/phase-2c-22-runtime-truth-live-contract-check.js   # exit 0 = pass
```

Fail-closed: any missing/odd result fails its gate and the overall verdict (exit 1).

## 6. Remaining blockers before any production canary (unchanged)

This phase proves the **contract**, not production capability. Still required and
explicitly **out of scope** here: real tenant map, production connectivity proof,
schema parity, canary scope, and explicit owner approval. No production sync, no
external sending, no production deploy, no merge to `main`.

Atlas status labels remain **proof labels, not marketing labels**.
