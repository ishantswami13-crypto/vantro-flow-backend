# API Security Matrix
## PUBLIC Routes
- health, webhooks (post-signature), public invoices
## AUTHENTICATED Routes
- dashboard, sales, purchases, inventory, ledger, analytics, forecast, AI chat
## ADMIN_ONLY Routes
- error-events admin, metrics
## Requirements per route:
- Valid JWT/Auth Context
- Business scoped
- Request ID, sanitized logging
