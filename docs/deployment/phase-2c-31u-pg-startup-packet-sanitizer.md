# Phase 2C.31U — PG Startup-Packet Sanitizer

## Overview
This phase introduces a code-side configuration sanitizer to fix a persistent `ESTARTUPPACKETTOOLARGE` connection error on Railway staging using the Supabase PgBouncer pooler. 

## The Problem
The `pg` driver natively accepts a `connectionString` and injects raw URL query strings as Postgres startup parameters. When used with Supabase's transaction pooler (which has a strict 1024-byte startup packet limit), appending URL parameters pushes the total startup packet length beyond 1024 bytes, preventing connection.

## The Solution
We implemented a strict parsing helper `buildSanitizedPgConfig()` in `lib/db/pgConfig.js`. 
- This extracts ONLY the required fields (`host`, `port`, `database`, `user`, `password`) securely from `process.env.DATABASE_URL` using the native Node.js `URL` class.
- The helper explicitly drops any rogue query strings/startup parameters (`application_name`, `options`, `search`, etc.).
- It hardcodes the required `ssl: { rejectUnauthorized: false }` to maintain PgBouncer compatibility.
- It normalizes the `max` connections setting.
- `server.js` and `lib/db/pg.js` have been updated to instantiate their connection pools bypassing the native `connectionString` mechanism, completely resolving the packet size overflow.

## Safety & Gates
- **Deep Readiness**: `/api/health/deep` successfully uses the same shared pool without creating a false-green side channel.
- **Checker Script**: Added `scripts/phase-2c-31u-pg-startup-fix-check.js` to strictly enforce that the `connectionString:` attribute cannot be used anywhere in the core connection initializations, preventing future regressions.
- **Data Protection**: This phase enables NO data loads, touches NO databases manually, and does NOT approve Phase 2C.32.
