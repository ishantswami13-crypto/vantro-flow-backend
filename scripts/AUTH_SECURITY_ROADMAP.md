# Auth & Session Security Roadmap
## Current Status
- JWT via localStorage, auth/me endpoint secured.
## Roadmap
- Suspicious login logging (implemented)
- Failed login rate limits (to be verified)
- Session Revocation (pending database migration for session tokens)
- Refresh token rotation (pending)
- Cookie-auth rollout (Feature-flagged, do not deploy without approval)
