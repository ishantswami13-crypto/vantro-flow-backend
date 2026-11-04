# Decision: Starlane desktop app and local bridge

Status: accepted (2026-09-27) · Scope: how Starlane reaches software that only
exists on a customer's machine (TallyPrime first), and what the desktop app is.

## What exists today (and works end to end)

| Piece | Where | State |
|---|---|---|
| Tally bridge | `tally-connector/tally-sync.mjs` | Zero-dependency Node 18+ program. Reads vouchers + stock from Tally's local XML port, read-only. `--watch` syncs every 30 min. |
| Pairing | `POST /api/connectors/tally/pairing` → `POST /api/connectors/tally/claim` | One-time code (10 min TTL, claim-once via conditional UPDATE), exchanged for a per-device credential. |
| Device credential | `connector_devices` (migration 047) | `VantroDevice <id>.<secret>`; only SHA-256(secret) stored; `last_seen_at` on every auth; revocable from Sources. Stored on the PC in `.vantro-device-credentials.json` (mode 0600) with the API base. |
| Scope limits | `authorizeHeartbeat`, `/api/import/tally` | A device can only report on / import into the source it was paired for, for its own tenant. |
| Distribution | `/download` (access entitlement) and `GET /api/connectors/tally/bridge` (signed-in) | Served with its SHA-256; downloads recorded. |
| Proof | `tests/goldenPath.test.mjs`, `scripts/e2e/golden-path.mjs` (frontend) | Pairs by running the exact command the UI shows, from a folder holding only the downloaded file. |

There is **no desktop app yet**. The download page says so ("Not published
yet") until `DESKTOP_DOWNLOAD_URL_*` points at a real signed build.

## Decision

1. **The desktop app, when built, is Tauri — not Electron.** The team already
   ships Rust (`cortex-core-rs`, `vantro-automation-rs`); Tauri produces small
   signed installers, uses the OS webview, and has a signed updater. The app
   is a thin shell around the existing web product plus a native bridge host;
   it does not fork the UI.
2. **The bridge protocol does not change.** The desktop app hosts the same
   bridge logic (ported to Rust or embedded) and pairs through the same
   pairing → claim → device-credential flow. One server contract, two clients.
3. **Consent is per source and explicit.** The app never scans for or opens
   local software on its own. The owner picks a source; the app shows what it
   will read (from the connector manifest's `access` list) before pairing.

## Gaps to close before the desktop app ships (in order)

1. **Credential at rest:** move the device secret from a 0600 file to the OS
   keychain (Windows Credential Manager / macOS Keychain / libsecret).
2. **Short-lived tokens:** exchange the long-lived device secret for a
   ~15-minute access token per sync, so a leaked request log cannot replay
   indefinitely. Revocation already works; this narrows exposure between
   compromise and revocation.
3. **Signed builds + updater:** code-signing certificates (Windows EV,
   Apple Developer ID + notarisation) and Tauri updater keys. These are
   owner-held credentials — see the production report.
4. **Local surface:** if the app needs a local HTTP surface, bind 127.0.0.1
   only, random port, per-launch bearer, `Origin` check. No listening socket
   otherwise.
5. **Heartbeat without data:** a lightweight authenticated ping so Sources can
   distinguish "PC off" from "Tally XML server off" (today both read as
   "stale").

## Not doing

- Scraping application databases or screens. Tally is read through its
  documented XML interface; other local software gets a connector only when a
  documented, consented interface exists.
- Auto-connecting anything on install.
