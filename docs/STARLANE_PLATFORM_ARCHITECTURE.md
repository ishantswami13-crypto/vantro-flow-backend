# Starlane universal platform: architecture map and plan

Written 12 Nov 2026 from the code on `main` (backend 8186eb7, frontend 9aa5d7c).

## 1. What exists (audited)

| Area | Where it lives | Notes |
|---|---|---|
| Backend | Express monolith `server.js` (15k lines) + routers in `lib/routes/*` | Node 22, CommonJS, `pg` pool + a Supabase-shaped shim |
| Frontend | Next.js 15 app router, React 18, Tailwind, React Query | `lib/api.ts` request helpers, `components/v32/ui.tsx` design kit |
| Auth | JWT `{ userId, email }` (cookie or bearer, CSRF on cookie) via `authMiddleware` | The tenant key everywhere is `user_id = req.user.userId` |
| Organizations | `organizations` (migration 021), 1:1 with the owning user | No membership; `team_members` (owner_id) are contacts, they cannot sign in |
| Spaces | `business_entities` (071) | Several companies under one account, finance only |
| AI | `lib/ai/modelRouter.js`: six providers, failover, `ai_usage` ledger, daily token budget | Reused as the execution engine's model layer |
| Agents | `lib/domain/os/agents.js`: five fixed-code agents, runs in `agent_runs` (043) | No definitions, versions, tools or approvals |
| Workflows | `lib/domain/workflows/customWorkflows.js` (068/069): trigger + steps, approvals for email drafts | User scoped, fixed agents only |
| Monitors | `watches` (046) + `watchEvaluator` | Finance metrics |
| Approvals | `ai_actions` (finance actions), `starlane_workflow_approvals` (email drafts), decisions | Three separate finance-shaped queues |
| Knowledge | Vault = `file_import_batches` + invoices + agent outputs; `starlane_knowledge` typed facts | No documents, collections or search |
| Connections | `lib/connectors/registry.js` manifests + `state.js` live health; `starlane_connections` (webhooks, REST APIs) | Honest availability already modelled |
| Navigation | Static arrays in `frontend/lib/navigation.ts` | Every user sees the same finance apps |
| Command Center | `frontend/app/command/page.tsx` | A receivables dashboard |

Baseline before this work: backend `npm test` 80 passed / 0 failed on a local Postgres with all migrations; frontend `typecheck` 0 errors, `lint` 0 errors (8 warnings), `next build` passes.

## 2. Design decisions

1. **Organization becomes the platform tenant, without moving finance data.** New platform tables carry `organization_id` and every request resolves the caller's membership server side (`lib/platform/context.js`). Existing finance tables keep `user_id`; the org owner's `user_id` stays their key. A member who is not the owner never reads the owner's finance rows through the legacy routes, because those still key on the JWT user.
2. **Membership is real.** `organization_members` with roles owner / admin / member / viewer. The owner row is backfilled for every existing organization. A user can belong to several organizations; the client may name one with `X-Starlane-Org`, and the server checks membership before using it.
3. **Apps are rows, not code paths.** `organization_apps` records which applications an organization activated. Finance and Procurement are backfilled ON for every existing organization so no current user loses a screen. New organizations start with none and choose at setup.
4. **One agent engine.** `platform_agents` (mutable draft) + `platform_agent_versions` (immutable, checksummed) + `platform_agent_executions` (durable queue and lifecycle) + `platform_execution_steps` (trace). Templates are definitions run by the same engine.
5. **Tools are declared and enforced in the backend.** `lib/platform/tools.js` lists every tool with risk, input schema, required app or connection, and whether it is available. The engine refuses a call to a tool that is not granted, not available, disabled by org policy, or invalid. External and financial tools always require approval; no definition can turn that off.
6. **Approvals pause execution.** A protected tool call writes a `platform_approval_requests` row and the execution moves to `awaiting_approval` with its conversation state saved. Approve requeues it and the exact approved arguments run once (idempotent by step key); reject feeds the refusal back to the agent.
7. **Retrieved content is untrusted.** Tool results go back to the model wrapped as data, and nothing in them can widen tool grants, the org, or the identity a run executes as.
8. **Knowledge respects the caller.** Collections are personal, team or organization scoped. An agent's knowledge grants are intersected with what the person running it may read.
9. **No fabricated numbers.** Command Center reads executions, approvals and usage rows. Anything not measured is shown as not measured.
10. **Compatibility.** Every existing route keeps working. The old receivables Command Center moves to `/command/finance`; `/command` becomes the universal center.

## 3. Plan (phases)

- **A Foundation**: migration 072 (membership, apps, teams, policies, audit), org context middleware, role model, app catalog, `/api/platform/workspace`.
- **B Workspace**: server-built navigation, dynamic sidebar with a fallback to today's nav, app gate on finance pages, organization setup and settings.
- **C Agent Studio**: definitions, validation, natural-language drafting (model when configured, rules otherwise, labelled), templates, library, versions, duplicate, activate/deactivate/archive.
- **D Execution**: Postgres queue with `SKIP LOCKED` leases, worker, timeouts, cancellation, retries with backoff, idempotency keys, concurrency and daily limits, error classes, steps trace, approvals.
- **E Connected workspace**: Knowledge (collections, text documents, full-text search with citations), Connections overview from real state, Approvals inbox, triggers (manual, schedule, webhook), agent handoff, Command Center, Activity and Audit.
- **F Verification**: unit, API, isolation and engine integration tests on real Postgres; frontend typecheck, lint, build; three test organizations.
