# Starlane: the seven surfaces

Bridge, Scan, Watch, Simulate, Prepared, Missions and Memory are the whole
product. New capability goes inside one of them; there is no new top-level
navigation. This file maps the code to the surfaces and says honestly what
is built.

```
BRIDGE connect reality -> SCAN understand it -> WATCH observe it changing
-> SIMULATE possible futures -> PREPARED what needs a person
-> MISSIONS change reality -> MEMORY learn -> back to SCAN
```

## Map of the code

| Surface | Question | Backend | Frontend page |
|---|---|---|---|
| Bridge | What is connected? | `lib/domain/os/bridge.js` (connector contract READ/SEARCH/SUBSCRIBE/WRITE/EXECUTE, health, entity-resolution candidates, what is missing), `lib/domain/os/knowledge.js` (Teach Starlane), `lib/domain/decisions/ledgerImport.js` (CSV/Excel import), `lib/domain/automation/connectorCatalog.js`, Tally agent routes | `/bridge`, `/sources`, `/decisions/import` |
| Scan | What did Starlane discover? | `lib/domain/os/scan.js`, `processDiscovery.js` (invoice-to-payment reconstruction, bottleneck, documented vs actual), `automationDiscovery.js` (scored automation candidates, opportunities, constraint), `lib/domain/decisions/backtest.js` | `/scan` |
| Watch | What is changing? | `lib/domain/os/objectives.js` + `objectiveStore.js` (objectives, forecast, health, autopilot), `lib/routes/watches.js` (condition watches), decision discovery (`lib/domain/decisions/discovery.js`), `GET /api/os/watch/brief` | `/watch` |
| Simulate | What could happen? | `lib/domain/decisions/simulate.js` (routes incl. do nothing, P10/P50/P90, stress, sensitivity), `workflowLogic.replayWorkflow` (automation replay with no future leakage), experiment view in `workflows.outcomeSummary` | `/simulate`, `/decisions/[id]` |
| Prepared | What needs me? | decision inbox (`/api/decisions`), workflow proposals and approvals (`/api/os/workflows`, `/api/os/workflows/items`), `lib/routes/prepared.js` | `/prepared`, `/decisions` |
| Missions | What is being handled? | `lib/domain/os/missions.js` (every handled decision and deployed workflow as one mission with state PLANNING / WAITING_FOR_INFORMATION / WAITING_FOR_APPROVAL / RUNNING / BLOCKED / VERIFYING / COMPLETED / FAILED / STOPPED and outcome VERIFIED_SUCCESS / VERIFIED_FAILURE / OUTCOME_UNKNOWN, derived from existing rows), `POST /api/decisions/:id/handle` (Handle it), `lib/domain/os/workflows.js` (engine: trigger, conditions, steps, approvals, idempotent items, re-planning, retry then hand to a person, agent identity, permissions, budget, kill switches), `workflowTemplates.js` (manifest), `lib/domain/decisions/lifecycle.js` (decision execution) | `/missions` |
| Memory | What have we learned? | verified workflow outcomes and learned patterns (`workflows.verifyOutcomes`, `knowledge.recordLearnedPattern`), decision contracts and track record (`lib/domain/decisions/verification.js`), append-only `decision_events` | `/memory` |

`GET /api/os/surfaces` returns the same inventory with live counts for the
signed-in tenant.

Around the seven surfaces:

| Endpoint | What it is |
|---|---|
| `GET /api/os/today` | The few lines on Today ("1 decision needs you. 2 missions are being handled. Everything else is stable."), counted from real rows; an empty tenant is told to connect data |
| `GET /api/os/agents` | The four workers that actually run (Scan, Decision engine, Collections agent, Outcome verifier) with permissions, what they cannot do, runs, last activity, kill-switch state and measured performance; planned agents listed as not built |
| `GET /api/os/funnel` | First time each funnel step happened (connected, scanned, finding, decision opened, evidence inspected, simulation run, approved, mission, action, outcome verified) plus acceptance and false-positive rate |

## The automation loop that runs today

1. **Bridge**: a receivables file is imported (or Tally syncs). Bridge shows the
   connector health; stale data lowers confidence and stops workflows.
2. **Scan** rebuilds the invoice-to-payment process, finds the bottleneck
   (waiting after the due date), compares the stated terms with reality, and
   proposes the *overdue invoice follow-up* only if invoices go overdue at least
   3 times a month. Every score component is shown with its weight.
3. **Simulate** replays the proposed workflow week by week over the last 180
   days with the as-of snapshot (leakage asserted at every replay date) to show
   how often it would have fired and how often those customers paid on their own.
4. **Watch**: a collections autopilot objective (overdue share at most X%) is
   evaluated now and forecast forward with the Payment Behaviour Engine.
5. **Prepared** shows the proposal. A person chooses deploy in shadow (level 3),
   deploy with approval (level 4) or reject. Level 5 is never offered.
6. **Missions** runs it: one item per customer per set of overdue invoices, with
   an idempotency key, the draft built only from ledger facts, the agent's
   identity, the policy verdicts and the expected outcome.
7. A person approves each reminder. In shadow pilot mode approval records what
   would have been sent; in live mode the reminder is marked ready for a person
   to send. **Workflows never send.**
8. **Memory** verifies the outcome from the ledger (payment within 7 days, not
   "message sent"), compares it with the expected rate, and writes a learned
   pattern with its sample count.

## Not built yet

Document extraction, bank/CRM/ERP/world connectors, purchase/order/inventory
process discovery, replenishment, supplier-risk and order-exception workflows,
negotiation preparation, resource contention across missions, playbooks,
similar-decision retrieval, a model router, and sending from workflows. Each is
listed as `NOT_BUILT` in `GET /api/os/surfaces` rather than shown as a button.

## Safety

- Migration `061_operating_system.sql` is additive and **not applied** to any
  shared database.
- Every query is scoped by `user_id` from the JWT.
- Kill switches: tenant, agent, decision, action class, connector, workflow,
  objective autopilot (`POST /api/decisions/controls`).
- Knowledge people add is typed (observation, document claim, hypothesis),
  screened for prompt injection, and never inserted into drafts or policy.
- Money math, permissions, policy and state transitions are code, not models.

## Proof

```bash
npm run pilot:readiness -- --frontend-url http://localhost:3000   # the 17 named checks, fixture data, local DB only
npm run test:os                # pure tests, golden automation test, missions / Handle it / Today / Agents / funnel over HTTP
node scripts/os-golden-run.js  # answers the pilot questions on fixture data (local DB only)
node scripts/os-golden-run.js --file ledger.csv --options mapping.json   # same, on a real file, local, shadow
```
