# Outbound engine

Starlane's outbound email pipeline: targets → verification → drafts → review →
queue → rate-limited send → bounces and replies → follow-ups → learnings.
Code: `lib/domain/outbound/`, API: `lib/routes/outreach.js` (`/api/outreach`),
schema: `migrations/062_outbound_engine.sql` (additive, re-runnable).

## Safety model

| Guard | Where |
|---|---|
| Nothing leaves in SHADOW (sink provider) | `providers.js` sinkAdapter, `controls.modeGate` |
| TEST sends only to `OUTBOUND_TEST_RECIPIENTS` | `controls.isTestRecipient`, checked per job |
| TEST and LIVE need `FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED=true` (Hard Rule 7) | `controls.modeGate`, preflight SENDING MODE |
| LIVE start needs the typed confirmation `SEND TO REAL PROSPECTS` | `POST /start` |
| START refuses unless every critical preflight check passes | `engine.startOutreach` |
| One send per job, even under races and crashes | idempotency key, `FOR UPDATE SKIP LOCKED`, SENDING committed before the provider call, AMBIGUOUS reconciliation via deterministic Message-ID |
| Suppression re-checked inside the send transaction | `eligibility.js` |
| Hard bounces, invalid recipients, opt-outs never retried | `worker.recordFailure`, `events.ingestEvent/ingestReply` |
| Six-level rate limits (global ∩ provider ∩ account ∩ tenant ∩ campaign ∩ domain), all-or-nothing | `rateLimiter.acquire` |
| Warm-up and adaptive throttling | `rateLimiter.warmupCap`, `circuit.js` |
| Circuit breakers pause campaigns and accounts | `circuit.evaluateCampaign`, `circuit.onProviderError` |
| Local-time windows (Mon–Fri 09:00–17:00 recipient time) | `localTime.js` |
| STOP ALL OUTBOUND (tenant) and a global stop (env or DB) | `/stop-all`, `/admin/global-stop`, `STARLANE_GLOBAL_STOP` |
| Tenant isolation: every query filters by the JWT user | all modules; tested over HTTP |
| Provider tokens encrypted at rest (AES-256-GCM) | `credentials.js`, `OUTBOUND_CREDENTIALS_KEY` |

## Configuration (backend service)

| Variable | Needed for | Default |
|---|---|---|
| `OUTBOUND_ENGINE_ENABLED=true` | runs scheduler, workers, mailbox poller in the backend process | off |
| `OUTBOUND_CREDENTIALS_KEY` | storing Gmail tokens (32+ random chars) | unset: Gmail connect refused |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI` | Connect Gmail (scopes `gmail.send`, `gmail.readonly`) | unset |
| `FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED=true` | TEST and LIVE modes | off |
| `OUTBOUND_TEST_RECIPIENTS` | TEST mode allow-list (addresses or `@domain`) | empty |
| `OUTBOUND_WORKER_CONCURRENCY` | worker slots per instance | 2 |
| `OUTBOUND_RATE_DEFAULTS` | JSON override of default limits | code defaults |
| `STARLANE_GLOBAL_STOP=true` | emergency stop for every tenant | off |

The redirect URI is `https://<backend>/api/outreach/providers/gmail/callback`.

## Commands

```bash
npm run outreach:preflight                      # read-only; safe on production
npm run outreach:preflight -- --user <uuid>     # adds the tenant's Gmail and targeting checks
npm run outreach:preflight -- --exercise        # local DB only: runs the whole pipeline on fixtures
npm run test:outbound                           # unit + engine + HTTP suites
npm run pilot:readiness                         # now includes an OUTREACH check
```

## Migration and reconciliation

`062_outbound_engine.sql` only creates `outbound_*` tables and indexes and
references `users(id)`. It does not touch any existing table and can be
applied twice. It is numbered after the reconciliation work in the
golden-loop thread and must be applied after that lands, through the same
migration runner so `starlane_migrations` records it. It has not been
applied to production.

## Going live, step by step

1. Apply 062 on production (after the reconciliation migrations), then run
   `npm run outreach:preflight` from a machine that can reach production.
   DATABASE, MIGRATIONS, QUEUE, TENANCY should be PASS.
2. On the backend service set `OUTBOUND_CREDENTIALS_KEY`, the three Google
   OAuth variables, and `OUTBOUND_ENGINE_ENABLED=true`. Redeploy. Preflight
   SCHEDULER and WORKERS turn PASS within a minute.
3. In the app open Outreach, Connect Gmail, create the campaign, import
   verified targets, generate drafts and approve them.
4. Press START in SHADOW. Watch the queue drain to the sink; nothing is sent.
5. Set `FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED=true` and
   `OUTBOUND_TEST_RECIPIENTS` to internal addresses; run a TEST campaign whose
   targets are those internal addresses; check the Gmail Sent folder,
   threading and the unsubscribe line.
6. Only then START in LIVE, typing `SEND TO REAL PROSPECTS`. STOP ALL
   OUTBOUND stops everything at once.
