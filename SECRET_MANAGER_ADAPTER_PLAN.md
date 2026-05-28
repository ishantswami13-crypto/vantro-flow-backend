# Secret Manager Adapter Plan

## 1. Current State
All backend secrets are accessed via the `getSecret(name)` abstraction function in `server.js`. Currently, this function reads directly from `process.env`.

## 2. Future Integrations
To achieve higher security, compliance (SOC2/PCI-DSS), and automated rotation, Vantro Flow should migrate to an external Secret Manager. 

### Recommended Provider: AWS Secrets Manager
- **Why**: Native integration with Node.js via AWS SDK. Supports automatic key rotation lambdas.
- **Implementation**:
  ```javascript
  const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");
  // ... Initialize client
  // ... Update getSecret() to fetch dynamically and cache in memory for 5 minutes.
  ```

### Alternative: HashiCorp Vault
- **Why**: Cloud-agnostic, excellent dynamic secrets (e.g., generating temporary database credentials that expire).
- **Implementation**: Requires deploying a Vault server or using HCP Vault.

## 3. Migration Steps
1. Provision the external secret manager.
2. Inject only the authentication token (e.g., AWS IAM Role / Vault Token) into the Railway environment.
3. Update `getSecret()` to block synchronously on startup to fetch secrets and populate an in-memory cache.
4. Ensure `safeLog()` redaction keys are dynamically updated based on the fetched secrets.
