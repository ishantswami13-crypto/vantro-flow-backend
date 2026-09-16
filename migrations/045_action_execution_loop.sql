-- ============================================================
-- VANTRO STARLANE — Migration 045: close the SENSE->ACT->VERIFY loop
-- ============================================================
-- Additive only. Extends the EXISTING ai_actions/execution_records
-- infrastructure (audited before writing this migration — see
-- lib/domain/intelligence/supplyChainOrchestrator.js,
-- lib/domain/automation/supplyChainExecutionAdapter.js,
-- lib/domain/intelligence/outcomeVerification.js) rather than building a
-- second action system. Nothing here replaces an existing table/column.

-- ── 1. Widen ai_actions.status: real terminal/in-flight states ────────────
-- Previous CHECK: pending|approved|rejected|done|expired|system_blocked.
-- Missing states this mission requires: EXECUTING (in flight — matters once
-- an adapter call is genuinely async, not just for the current synchronous
-- demo adapter), FAILED (execution definitively did not happen), and
-- EXECUTION_UNKNOWN (the external system's result could not be determined
-- safely — e.g. a timeout after the request was sent). Before this, a
-- failed execution left status stuck at 'approved' forever with no honest
-- terminal state (server.js only ever recorded last_execution_error/
-- execution_attempts, never transitioned status on failure — a real bug,
-- fixed alongside this migration in server.js's approve-and-execute route).
-- Same widen-a-CHECK-constraint pattern as migration 019.
ALTER TABLE ai_actions DROP CONSTRAINT IF EXISTS ai_actions_status_check;
ALTER TABLE ai_actions ADD CONSTRAINT ai_actions_status_check
  CHECK (status IN ('pending','approved','rejected','done','expired','system_blocked',
                     'executing','failed','execution_unknown','cancelled'));

-- ── 2. Structured, frozen execution payload ────────────────────────────────
-- reason_json already carries rationale (componentId, rankedOptions) but is
-- not a contract for "exactly what will execute" — mission requires the
-- user to see, and the system to execute, one exact structured payload that
-- cannot silently drift between approval and execution. parameters is
-- written once at proposal time and never updated by any route after
-- creation (verified: no existing route does `UPDATE ai_actions SET
-- reason_json/parameters`) — that immutability IS the freeze mechanism,
-- not a separate versioning table, since nothing here supports in-place
-- edits to a proposed action in the first place.
ALTER TABLE ai_actions ADD COLUMN IF NOT EXISTS parameters JSONB;
COMMENT ON COLUMN ai_actions.parameters IS 'Exact structured execution payload shown to the user before approval (supplier, products, quantities, price if known, currency, delivery target, notes for a PO; recipient/channel/exact message for a message action). Written once at proposal time, never updated after creation — this immutability is what "frozen payload" means for this table. If a recomputed recommendation differs materially, code must create a NEW ai_actions row, never mutate this one.';

-- ── 3. Expected effect, recorded BEFORE execution ──────────────────────────
-- Mission: "record the expected effect... then after verification compare
-- EXPECTED vs OBSERVED." Distinct from parameters (what will be done) and
-- from reason_json (why) — this is what the action is predicted to achieve.
ALTER TABLE ai_actions ADD COLUMN IF NOT EXISTS expected_effect JSONB;
COMMENT ON COLUMN ai_actions.expected_effect IS 'What this action is predicted to accomplish, recorded at proposal time, e.g. {"metric":"open_demand_shortfall_units","expected_value":0,"baseline_value":75}. Compared against action_outcomes.observed_value after verification — never edited after creation.';

-- ── 4. Idempotency at the PROPOSAL level (not just execution) ─────────────
-- execution_records already has UNIQUE(user_id, ai_action_id, idempotency_key)
-- for double-click-safe EXECUTION. There was no equivalent guard against a
-- repeated signal recalculation creating N duplicate PROPOSED actions for
-- the same real-world fact — confirmed live: createRecommendedActions() had
-- no dedup check at all before this migration. fingerprint is a stable hash
-- of the facts that make two proposals "the same recommendation" (action
-- type, target entity, and the structured parameters that would result) —
-- computed in application code (lib/domain/intelligence/supplyChainOrchestrator.js),
-- not in SQL, since Postgres has no built-in stable JSON-canonicalizing hash.
-- Partial unique index: only ACTIVE actions block a duplicate — a rejected,
-- expired, or completed action must never block a legitimately new
-- recommendation for the same target once circumstances change.
ALTER TABLE ai_actions ADD COLUMN IF NOT EXISTS idempotency_fingerprint TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_actions_active_fingerprint
  ON ai_actions(user_id, action_type, related_entity_type, related_entity_id, idempotency_fingerprint)
  WHERE status IN ('pending','approved','executing') AND idempotency_fingerprint IS NOT NULL;

-- ── 5. Structured expected-vs-observed outcome model ───────────────────────
-- outcomeVerification.js today collapses verification into a single
-- ai_actions.outcome TEXT ('effective'|'ineffective') — exactly the
-- "one text string" this mission prohibits. ai_actions.outcome/outcome_at/
-- outcome_notes are left in place unmodified (other code reads them; this
-- is additive, not a replacement) — but the new table is the real record
-- an owner (or a future learning-loop) should read for "what exactly did
-- we expect, and what exactly happened."
CREATE TABLE IF NOT EXISTS action_outcomes (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action_id         UUID NOT NULL REFERENCES ai_actions(id) ON DELETE CASCADE,
  verification_type TEXT NOT NULL,   -- e.g. 'stockout_within_horizon', 'po_exists_in_erp'
  expected_metric   TEXT NOT NULL,
  expected_value    NUMERIC,
  observed_metric   TEXT,
  observed_value    NUMERIC,
  status            TEXT NOT NULL DEFAULT 'PENDING'
                      CHECK (status IN ('PENDING','MET','NOT_MET','INCONCLUSIVE')),
  evidence          JSONB,
  verified_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_action_outcomes_user ON action_outcomes(user_id);
CREATE INDEX IF NOT EXISTS idx_action_outcomes_action ON action_outcomes(action_id);
COMMENT ON TABLE action_outcomes IS 'Structured expected-vs-observed record per verification check on an ai_actions row. One action may have multiple rows (e.g. one per horizon or per metric) — never collapsed into a single pass/fail string.';

-- ── 6. Execution audit fields already mostly exist (execution_attempts,
-- last_execution_error on ai_actions from migration 005; execution_records
-- is already channel-agnostic per migration 041) — nothing to add there.
