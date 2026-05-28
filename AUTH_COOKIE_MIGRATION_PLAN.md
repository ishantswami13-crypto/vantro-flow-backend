# HttpOnly Cookie Auth Migration Plan

## Current Risk

The frontend stores the JWT in `localStorage` and mirrors it into a readable cookie for middleware navigation. This is convenient, but any XSS can read the token and use it until expiry.

## Target Architecture

- Access token stored in an HttpOnly, Secure, SameSite cookie.
- Refresh token stored server-side or in a separate HttpOnly Secure cookie with rotation.
- Backend reads cookies and supports `Authorization: Bearer` during migration.
- Frontend never reads raw session tokens after migration.

## CSRF Plan

If cookie auth is used, add CSRF protection for state-changing requests:

- SameSite=Lax or Strict where possible.
- CSRF token for unsafe methods: POST, PATCH, PUT, DELETE.
- Validate `Origin` and `Referer` on sensitive routes.
- Keep CORS allowlist strict.

## Refresh Token Rotation

1. Short-lived access token.
2. Long-lived refresh token with rotation on each use.
3. Store refresh token family/session id server-side.
4. Reuse detection invalidates the session family.
5. Logout revokes current refresh session.

## Logout and Invalidation

- Clear HttpOnly cookies server-side.
- Delete/revoke refresh session in DB.
- Keep a short access-token lifetime to limit exposure.
- Add optional server-side token version for emergency invalidation.

## Backward Compatibility

1. Continue accepting `Authorization: Bearer` while new cookie mode rolls out.
2. Login returns cookies plus legacy token during transition.
3. Frontend switches API wrapper to cookie credentials.
4. Remove localStorage token only after production validation.

## Frontend Changes Needed

- Use `credentials: "include"` in API requests.
- Stop reading JWT from `localStorage`.
- Store only non-sensitive user profile/cache data locally.
- Update logout to call backend logout endpoint.

## Backend Changes Needed

- Cookie parser middleware.
- Login/signup set HttpOnly cookies.
- Refresh endpoint with token rotation.
- Logout endpoint that clears cookies and revokes session.
- CSRF validation for unsafe methods.

## Migration Steps

1. Add backend dual-mode auth.
2. Add cookie-setting login response.
3. Update frontend API wrapper.
4. Test staging with old and new sessions.
5. Enable cookie mode in production.
6. Remove legacy localStorage token after a deprecation window.

## Rollback Plan

Keep Bearer-token support until cookie sessions are stable. If cookie auth fails, revert frontend API wrapper to Authorization header and keep backend dual-mode auth.

## Risk Level

Medium implementation risk, high security value. Do not attempt as an emergency patch without staging.

## Implementation Status

The backend now has optional dual-mode auth behind `ENABLE_AUTH_COOKIES=true`.

- Login and OTP verification can set an HttpOnly access-token cookie.
- A readable CSRF cookie is issued for double-submit CSRF protection.
- Auth middleware accepts Bearer tokens first, then the cookie token when cookie auth is enabled.
- Unsafe cookie-auth requests require `x-csrf-token`.
- `/api/auth/logout` clears the auth cookies.
- Production should use `SameSite=None; Secure` while Vercel and Railway are on different domains.

Frontend migration is still required before enabling cookie auth broadly in production.
