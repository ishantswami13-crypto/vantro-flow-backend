# Secret Manager Roadmap

Currently, secrets are managed natively via **Railway** and **Vercel** environment variables.

## Comparison

| Solution | Pros | Cons |
|----------|------|------|
| **Railway/Vercel (Current MVP)** | Zero cost, native integration, fast to deploy | Hard to track rotation history, no granular RBAC for specific keys |
| **Doppler / Infisical** | Excellent DevEx, syncs directly to Vercel/Railway, robust RBAC | Paid per seat, adds an external dependency |
| **AWS Secrets Manager** | Enterprise-grade, native auto-rotation lambdas | High complexity, requires AWS account/VPC peering |
| **HashiCorp Vault** | Gold standard for security | Overkill for our scale, high maintenance |

## Recommendation (MVP to Scale)
1. **Current (Phase 1)**: Keep Railway/Vercel natively but add strict `check-secret-rotation.js` checks in CI/CD, and `_CURRENT` / `_PREVIOUS` pattern in code.
2. **Next Step (Phase 2)**: Migrate to **Infisical** or **Doppler** for centralized secret injection. It natively syncs to Vercel/Railway and provides a unified dashboard for age tracking and audit logs, resolving the visibility issues of native env variables without requiring AWS infrastructure.
