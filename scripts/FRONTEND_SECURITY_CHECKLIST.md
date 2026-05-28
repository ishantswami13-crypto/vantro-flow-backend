# Frontend Browser Security
- Secrets: No backend secrets in bundle.
- Errors: Error boundary masks stack traces, exposes Request ID.
- XSS: React auto-escapes.
- LocalStorage: JWT stored here. Future roadmap to HttpOnly cookies.
