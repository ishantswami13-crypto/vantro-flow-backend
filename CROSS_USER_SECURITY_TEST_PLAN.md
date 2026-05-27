# Cross-User Security Test Plan

## Purpose

Verify User A cannot read, update, delete, or trigger actions against User B resources.

Do not create test users or fake production data without approval. Run this in staging first.

## Required Setup

- User A token
- User B token
- User A userId
- User B userId
- One record per target table for each user

Keep tokens local. Never paste them into chat or commits.

## Test Matrix

1. User A token against `GET /api/sales/:userId` with User B id should return 403.
2. User A token against `GET /api/purchases` should return only User A purchases.
3. User A token against `GET /api/inventory/:userId` with User B id should return 403.
4. User A token against `GET /api/transactions/:userId` with User B id should return 403.
5. User A token against `GET /api/analytics/:userId` with User B id should return 403.
6. User A token against `GET /api/cash-forecast/:userId` with User B id should return 403.
7. User A token trying to update/delete User B product should return 404 or 403.
8. User A token trying to mark User B invoice paid should not modify the invoice.
9. User A token trying to access User B supplier/customer should return no data.
10. Non-admin token against migration/backfill/admin routes should return 403.
11. Public bill access should require a signed expiring token after enforcement is enabled.

## Local Command Template

```bash
API="https://vantro-flow-backend-production.up.railway.app"
TOKEN_A="keep-local-only"
USER_B="other-user-id"

curl -i "$API/api/inventory/$USER_B" -H "Authorization: Bearer $TOKEN_A"
curl -i "$API/api/analytics/$USER_B" -H "Authorization: Bearer $TOKEN_A"
curl -i "$API/api/cash-forecast/$USER_B" -H "Authorization: Bearer $TOKEN_A"
curl -i "$API/api/transactions/$USER_B" -H "Authorization: Bearer $TOKEN_A"
```

Expected result for mismatched `:userId` routes: `403 Forbidden`.
