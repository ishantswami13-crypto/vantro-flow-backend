# Security Verification Commands

Use these against staging first. Do not paste real JWTs into chat.

```powershell
$base = "https://vantro-flow-backend-production.up.railway.app"
```

## Auth And Cache

Quick smoke runner:

```powershell
npm run security:smoke
```

```powershell
Invoke-WebRequest "$base/api/auth/me" -SkipHttpErrorCheck
Invoke-WebRequest "$base/api/auth/me" -Headers @{ Authorization = "Bearer invalid" } -SkipHttpErrorCheck
Invoke-WebRequest "$base/api/inventory" -Headers @{ Authorization = "Bearer invalid" } -SkipHttpErrorCheck
```

Expected:

- Missing token returns `401`.
- Invalid token returns `401`.
- Private API responses include `Cache-Control: no-store`.

## Cross-User Isolation

Requires two real staging users:

```powershell
$env:BACKEND_URL = $base
$env:USER_A_TOKEN = "<local-only-user-a-token>"
$env:USER_B_ID = "<user-b-id>"
npm run security:cross-user
```

Expected:

- User A accessing User B parameterized routes returns `403`.

## Webhooks

```powershell
Invoke-WebRequest "$base/api/payments/webhook" -Method Post -ContentType "application/json" -Body "{}" -SkipHttpErrorCheck
Invoke-WebRequest "$base/api/voice/status" -Method Post -ContentType "application/json" -Body "{}" -SkipHttpErrorCheck
```

Expected:

- Unsigned Razorpay webhook returns `400`.
- Unsigned voice webhook returns `403`.

## Upload Rejection

Use a staging token only:

```powershell
$headers = @{ Authorization = "Bearer <local-only-token>" }
$form = @{ file = Get-Item ".\server.js" }
Invoke-WebRequest "$base/api/upload-csv" -Method Post -Headers $headers -Form $form -SkipHttpErrorCheck
```

Expected:

- Unsupported file type returns `400`.

## Cookie CSRF Future Test

After `ENABLE_AUTH_COOKIES=true` and frontend cookie mode are enabled:

```powershell
Invoke-WebRequest "$base/api/settings" -Method Patch -ContentType "application/json" -Body "{}" -WebSession $session -SkipHttpErrorCheck
```

Expected:

- Cookie-auth unsafe request without `x-csrf-token` returns `403`.
- Same request with matching `x-csrf-token` succeeds only for authenticated user-owned data.
