# Error Intelligence Rollout

## Overview
Vantro now features a centralized error tracking and classification system. 
Errors from both the backend (Node.js) and frontend (Next.js) are routed through a single taxonomy and taxonomy pipeline.

## Frontend Architecture
- **Global Error Boundary**: `app/global-error.tsx` catches fatal render/routing crashes.
- **Page Error Boundary**: `app/error.tsx` catches localized render crashes.
- **API Interceptor**: `lib/api.ts` safely parses 401/403/500 errors.
- **Client Error Endpoint**: UI errors send a payload to `POST /api/client-errors` for backend unification.

## Backend Architecture
- **Global Error Handler**: `app.use((err, req, res))` in `server.js` traps unhandled exceptions, sanitizes the message, hides the stack trace, and logs via `logErrorEvent`.
- **Taxonomy**: Errors are rigidly typed (e.g., `DATABASE_ERROR`, `PAYMENT_ERROR`).
- **Sanitization**: `redactSensitiveData()` recursively scrubs passwords, tokens, JWTs, and API keys before logging.
- **Database Storage**: Errors are optionally pushed to Supabase `error_events` table for admin UI analysis.
