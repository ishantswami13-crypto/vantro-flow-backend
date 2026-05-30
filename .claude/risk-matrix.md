# Vantro Code OS — Risk Matrix

## Purpose

Numeric risk scoring. Removes subjectivity from "is this high risk?". A task gets a score from 0-100. The score determines which speed track to use.

Score → Track:
- 0–25: FAST TRACK
- 26–60: STANDARD TRACK
- 61+: ESCALATED TRACK

---

## Risk Score Factors

Add points for each factor that applies to the task.

### Financial Integrity (+points)
| Factor | Points |
|--------|--------|
| Touches invoice amount or payment_amount | +40 |
| Touches mark-as-paid logic | +40 |
| Touches customer balance or outstanding | +35 |
| Touches Razorpay order or webhook | +30 |
| Touches any financial record (create/update) | +20 |
| Touches any financial record (read-only) | +5 |

### Authentication & Identity (+points)
| Factor | Points |
|--------|--------|
| `user_id` sourced from `req.body` or `req.params` (not JWT) | +50 — INSTANT CRITICAL |
| JWT secret (`JWT_SECRET`) touched or changed | +50 |
| Cookie configuration touched | +35 |
| Auth middleware changed or route unprotected | +40 |
| `verifyJWT()` function changed | +45 |
| New protected route added (auth correctly wired) | +15 |
| New unprotected route added | +35 |

### Tenant Isolation (+points)
| Factor | Points |
|--------|--------|
| Supabase query without `.eq('user_id', ...)` | +50 — INSTANT CRITICAL |
| pg query without `WHERE user_id = $1` | +50 — INSTANT CRITICAL |
| Cache key without user_id | +45 |
| Any cross-user data path opened | +50 |
| New query accessing tenant data (correctly scoped) | +10 |

### Database (+points)
| Factor | Points |
|--------|--------|
| New migration (CREATE TABLE) | +30 |
| New migration (ALTER TABLE) | +35 |
| New migration (DROP or destructive) | +55 — INSTANT ESCALATED |
| RLS policy change | +40 |
| Applying migration 006 (RLS) | +60 — INSTANT ESCALATED |
| Index change | +20 |
| Schema read-only | +5 |

### AI Safety (+points)
| Factor | Points |
|--------|--------|
| `promptGuard.service.js` changed | +40 |
| `policyGuard.service.js` changed | +45 |
| `FEATURE_PROMPT_GUARD_ENABLED` set to false | +60 — INSTANT ESCALATED |
| New LLM call without promptGuard | +40 |
| New agent action without policyGuard | +35 |
| Agent output used without validation | +25 |

### External Messaging (+points)
| Factor | Points |
|--------|--------|
| `FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED` changed to true | +50 |
| New Twilio `client.messages.create()` call path | +45 |
| WhatsApp send without owner approval gate | +55 — INSTANT ESCALATED |
| Message content not through promptGuard | +40 |
| External messaging architecture change | +30 |

### Rust Infrastructure (+points)
| Factor | Points |
|--------|--------|
| `RUST_CORTEX_CORE_ENABLED` or `RUST_AUTOMATION_API_ENABLED` set to true | +45 |
| `vantro-automation-rs/src/auth.rs` changed | +40 |
| `vantro-automation-rs/src/cache/*.rs` changed | +40 |
| `vantro-automation-rs/src/cortex/policy_guard.rs` changed | +45 |
| Any Rust logic change (non-auth, non-cache) | +20 |
| Rust binary rebuild | +15 |
| Rust CI workflow change | +15 |

### Secrets & Configuration (+points)
| Factor | Points |
|--------|--------|
| Secret found in code (not in env var) | +60 — INSTANT ESCALATED |
| `.env` file modified | +35 |
| `railway.toml` or `nixpacks.toml` modified | +30 |
| Feature flag value changed in production | +25 |
| `lib/featureFlags.js` default changed | +20 |
| New env var added (Railway) | +15 |

### Deletion & Irreversibility (+points)
| Factor | Points |
|--------|--------|
| Hard delete of user data | +55 — INSTANT ESCALATED |
| Soft delete / cancellation logic | +35 |
| Audit log delete or overwrite | +60 — INSTANT ESCALATED |
| Invoice or payment record delete | +50 |
| Any `DELETE` or `TRUNCATE` query | +55 — INSTANT ESCALATED |

### Scope & Complexity (+points)
| Factor | Points |
|--------|--------|
| Changes span 3+ domains | +20 |
| Changes span 2 domains | +10 |
| Changes span 1 domain | +0 |
| 10+ files changed | +15 |
| 5-10 files changed | +10 |
| 1-4 files changed | +0 |
| Change is reversible without DB migration | +0 |
| Change requires DB migration to revert | +20 |

### Positive Factors (Subtract points — reduces risk)
| Factor | Points |
|--------|--------|
| Feature flag gates the change | -10 |
| Harness X scenario already exists for this | -5 |
| Node fallback in place (for Rust changes) | -10 |
| Shadow DB test done first (for migrations) | -15 |
| Security Sentinel reviewed and approved | -10 |

---

## Risk Score Calculation

1. Sum all applicable points
2. Apply subtraction for positive factors
3. Use final score to select track

**INSTANT CRITICAL overrides**: Any factor marked "INSTANT ESCALATED" or "INSTANT CRITICAL" means the final track is ESCALATED regardless of total score.

---

## Risk Score Examples

### Example 1: Fix a label on /today page
- Changes span 1 domain: +0
- 1 file changed: +0
- Frontend file (no auth, no payment): +0
- Feature flag gates it: -0 (no flag needed)
- **Total: 5** → FAST TRACK

### Example 2: Add GET /api/cashflow endpoint
- New unprotected... wait, it's protected: +10 (new protected route, correctly wired)
- Tenant data accessed (correctly scoped): +10
- Changes span 2 domains: +10
- Feature flag gates: -10
- Harness X scenario exists: -5
- **Total: 15** → FAST TRACK? But it's a new backend route...
- Add: backend domain = medium base (+15 for route change)
- **Total: 30** → STANDARD TRACK ✓

### Example 3: Change JWT expiration from 7d to 1d
- `verifyJWT()` function changed: +45
- Auth middleware indirectly affected: +15
- 1 domain: +0
- **Total: 60** → Borderline ESCALATED → round up → ESCALATED TRACK

### Example 4: Enable RUST_AUTOMATION_API_ENABLED
- Rust flag set to true: +45
- `auth.rs` may be involved: +20
- Cache isolation: +20
- Changes span 2 domains: +10
- Node fallback in place: -10
- **Total: 85** → ESCALATED TRACK

### Example 5: Update a cortex-lab scenario (no code change)
- 1 domain, 1 file: +0
- Read-only schema: +0
- No auth/payment/tenant risk: +0
- **Total: 5** → FAST TRACK

---

## Score Reference Card

```
0-10:  Trivial — Fix/update without any risk factor
11-25: Low — Minor backend/frontend changes, correctly scoped
26-45: Medium — New functionality, non-financial, correctly secured
46-60: High — Touches auth, DB, or agents — needs full protocol
61-80: Critical — Escalated mandatory — security/financial/tenant
81+:   Maximum alert — Multiple critical factors — war room required
```
