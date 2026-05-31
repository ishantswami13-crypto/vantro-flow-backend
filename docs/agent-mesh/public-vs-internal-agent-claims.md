# Atlas Agent Mesh — Public vs Internal Claims Policy

> **Document status:** Binding policy — marketing, product, engineering, legal
> **Version:** 2.0
> **Last updated:** 2026-06-01
> **Owner:** Vantro Leadership
> **Enforcement:** Any team member publishing Atlas claims must verify against this document

---

## 1. Current Public Claims — Approved for Immediate Use

The following claims are approved for use on the public website, marketing materials, sales demos, press releases, and all external communications.

### Approved Claims

| Claim | Exact Language | Usage Context |
|-------|---------------|--------------|
| Agent count | "12 core specialized agents" | Website, demos, press |
| Architecture | "Expandable Agent Mesh architecture" | Website, demos, press |
| Orchestration | "Cortex Orchestrator — intelligent workflow coordination" | Technical audiences |
| Testing | "Harness X verified workflows — every agent tested before deployment" | Technical + business |
| Governance | "Owner-approved automation — no critical action without your sign-off" | Business audiences |
| Positioning | "AI Business Automation OS for every business" | All audiences |
| Initial wedge | "CashOps, collections, receivables, and cashflow intelligence" | All audiences |

### Approved Descriptions (Longer Form)

**For website hero section:**
> "Atlas gives every business 12 core specialized agents — purpose-built for collections, cashflow, credit risk, inventory, payables, and daily business intelligence. Built on an expandable Agent Mesh architecture with Harness X verified workflows and owner-approved automation."

**For technical audiences:**
> "Atlas is powered by Cortex Core RS, a Rust-based deterministic orchestration engine, with a React-first operator experience, LLM-routing intelligence, and Harness X — a proof-gated validation system that every agent must pass before production deployment."

**For business audiences:**
> "Atlas is not a dashboard. It is an operating intelligence layer that tells you who owes money, who broke their promise, what your cash gap is, and what to do today — with your approval required before any critical action is taken."

### Where Approved Claims May Appear
- Public website (vantro.in or atlas domain)
- Product landing pages
- Marketing materials (brochures, presentations, social media)
- Sales demos and product walkthroughs
- Press releases and media communications
- Investor communications (general)
- Job postings and technical recruiting materials

---

## 2. Internal Architecture Claims — Never Public Yet

The following claims describe the complete internal architecture. They are accurate and real but not yet proven at production scale.

### Internal-Only Claims

| Claim | Internal Language | Why Not Public Yet |
|-------|-----------------|-------------------|
| Agent count | "Atlas Agent Mesh 216" | 216 designed, 12 in production |
| Full mesh | "216 planned specialized agents across 6 layers" | Planned, not yet implemented |
| Layer structure | "Business, Cortex, Security, Harness, Infrastructure, Cost, Support, Enterprise" | Internal architecture design |
| Full stack | "React + Cortex Core RS + full parallel execution + memory platform + queue orchestration" | Some components in development |

### Where Internal Claims May Appear
- Internal architecture documents (docs/agent-mesh/)
- Engineering specifications
- Internal team presentations and planning documents
- Board-level technical reporting (with context that these are planned)
- Investor technical due diligence (with NDA and clear "roadmap" framing)
- Engineering hiring materials (framed as "what we're building toward")

### Internal Claims Require Context
When used with investors or potential hires, internal claims must be framed as:
> "We have designed a 216-agent architecture as our product roadmap. Currently 12 core agents are in production. The full mesh represents our 18-24 month build plan."

Never present internal claims as current production reality.

---

## 3. Future Public Claims — Unlockable Only After Proof

The following claims are approved for future use ONLY after all specified proof gates are met.

### Tier 1 Future Claim: "50+ specialized agents"

**Unlock condition:** Phases 1-3 complete
- 50+ agents in `production` status
- All in registry with full metadata
- All tool-wired and policy-guarded
- All Harness X verified
- All production-monitored

### Tier 2 Future Claim: "100+ specialized agents"

**Unlock condition:** Phases 1-4 complete
- 100+ agents in `production` status
- All above requirements met at 100+ scale

### Tier 3 Future Claim: "200+ specialized automation agents"

**Exact approved language:** "200+ specialized automation agents — Harness X verified"

**Full proof gate checklist (ALL required):**
```
[ ] Agent registry is live in production PostgreSQL
[ ] 200+ agents are in production status (not planned/staging)
[ ] Every agent is implemented — real code, not skeleton
[ ] Every agent has at least 1 connected tool (no mocked tools)
[ ] Every agent's policy rules are enforced by the running policy engine
[ ] Every agent generates audit trail entries in production
[ ] Every agent's cost is tracked per execution in production
[ ] Every agent has passed ALL required Harness X types for its risk level
[ ] Every agent has production monitoring (Grafana dashboard, alerting)
[ ] The registry is maintained and current (no stale entries)
[ ] Engineering VP sign-off: confirmed all above criteria met
[ ] Legal review: claim language meets regulatory standards
[ ] Product leadership approval
[ ] Documentation of proof prepared for public reference
```

**Process to unlock:**
1. Engineering team runs full audit against checklist
2. Results documented in internal proof report
3. Legal review of claim language
4. Product leadership review
5. CEO final approval
6. Marketing updates website with approved language
7. Proof checklist result stored in docs/agent-mesh/ for reference

---

## 4. Claims That Are NEVER Allowed

These claims are prohibited at any time, in any context, with any audience:

### Prohibited Claims

| Prohibited Claim | Why Prohibited |
|-----------------|---------------|
| "216 live agents" | False until all 216 are confirmed in production |
| "All 216 agents are running" | Same as above |
| "Fully autonomous finance operations" | Misleading — owner approval required for critical actions |
| "AI manages your finances automatically" | Misleading — oversimplifies and creates false expectations |
| "Guaranteed recovery rate of X%" | Cannot guarantee outcomes — creates liability |
| "Bank-grade security" | Requires formal certification (e.g., ISO 27001, SOC 2) — not yet certified |
| "Military-grade encryption" | Undefined marketing language — misleading |
| "Superintelligence" | Not accurate, creates unrealistic expectations |
| "AI replaces your finance team" | Creates workforce anxiety and is not accurate |
| "Never makes mistakes" | All AI systems have error rates |
| "100% accurate financial forecasts" | Impossible to guarantee |
| "Better than [competitor] at everything" | Unverifiable, legally risky |
| "Trusted by thousands of businesses" | Only if verifiably true with customer consent to cite |

### Why These Are Prohibited

**Liability:** Guaranteeing outcomes in financial software creates legal liability if outcomes differ.

**Misrepresentation:** Claiming live capabilities that don't yet exist is misrepresentation that can void contracts, attract regulatory scrutiny, and damage brand trust.

**Customer expectations:** Overpromising leads to customer disappointment, churn, and negative word-of-mouth — the worst outcome for a B2B product.

**Regulatory compliance:** Financial services claims in India are subject to RBI guidance, SEBI rules (if securities are involved), and consumer protection laws. Guaranteed recovery claims could attract regulatory action.

**Trust:** Atlas is built on owner trust. The moment we overstate capabilities, we undermine the foundation of the product.

---

## 5. Claim Review Process

Before any new public claim about Atlas agent capabilities:

**Step 1 — Engineering sign-off**
- Claim must match actual production capability
- Engineering VP confirms with written sign-off
- Evidence: production monitoring data, harness results

**Step 2 — Legal/compliance review**
- Legal team reviews claim for regulatory compliance
- Checks: financial services regulations, data protection laws, advertising standards
- Approves or flags for modification

**Step 3 — Product leadership review**
- Product team confirms claim is accurate, clear, and not misleading
- Reviews for competitive implications
- Approves final language

**Step 4 — Documentation**
- Approved claim added to this document with approval date
- Old claims updated or removed if replaced

**Step 5 — Marketing implementation**
- Marketing uses only approved language
- No ad-hoc claims without going through this process

**Timeline:** Allow 5-7 business days for the full review process for new claims.

---

## 6. Feature Announcement Ladder

How Atlas announces expanding agent capabilities to the market:

### Stage 1 — Launch (Current)
**When:** Phase 1 complete
**Language:** "12 core specialized agents for CashOps, collections, and cashflow intelligence"
**Tone:** Focused, specific, honest about scope

### Stage 2 — Growth (Post-Phase 3)
**When:** 50+ agents in production
**Language:** "Atlas has expanded to 50+ specialized business agents covering finance, inventory, sales, and customer operations"
**Tone:** Building momentum, specific categories

### Stage 3 — Scale (Post-Phase 5)
**When:** 100+ agents in production
**Language:** "Atlas now powers 100+ specialized agents across every dimension of business operations"
**Tone:** Market leadership signal

### Stage 4 — Full Mesh (Post-Phase 8)
**When:** All 200+ proof gates met
**Language:** "Atlas Agent Mesh: 200+ specialized automation agents — every agent Harness X verified, every critical action owner-approved"
**Tone:** Definitive, proven, trustworthy

---

## 7. Competitive Claims Policy

### What We May Say About Competitors
- Factual, verifiable comparisons: "Atlas is designed for WhatsApp-first India MSME owners; most enterprise tools require email-first processes"
- Category positioning: "Atlas is an owner-operated automation OS; enterprise solutions like HighRadius are finance-team-operated platforms"
- Pricing positioning (only when verified): "Atlas pricing is designed for ₹2,000-5,000/month, targeting MSMEs"

### What We May NOT Say About Competitors
- Specific claims about competitor performance we cannot verify
- Security vulnerability claims without published CVE or public evidence
- Claims that could constitute defamation
- Claims that another product "doesn't work" without specific, verifiable evidence

---

## 8. Regulatory Notes

### India
- Financial automation claims should include appropriate disclaimers about business outcomes not being guaranteed
- Collections-related claims should reference compliance with applicable consumer protection laws
- WhatsApp Business API usage subject to Meta policies — no claims implying exclusive relationships

### Export / International Markets
- Claims targeting EU audiences should reference GDPR compliance approach (not "compliance" unless formally audited)
- Claims targeting US audiences should be reviewed against FTC guidelines on AI marketing
- "Bank-grade" requires actual certification in all markets

---

## 9. Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-05-01 | Initial claims policy |
| 2.0 | 2026-06-01 | Expanded with tiered future claims; added feature announcement ladder; added regulatory notes; added competitive claims policy |

---

*End of Public vs Internal Agent Claims Policy*
*Approved by: Vantro Engineering + Product Leadership*
*Next review: 2026-09-01 or when Phase 3 completes*
