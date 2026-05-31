# Atlas Agent Registry Schema v2

> **Document status:** Canonical contract — all 216 agents must conform to this schema
> **Version:** 2.0 (supersedes `agent-registry-schema.md` v1 / 80-agent mesh)
> **Last updated:** 2026-06-01
> **Owner:** Vantro Engineering
> **Scope:** Internal architecture — not for public release

---

## 1. Overview

The Agent Registry is the single source of truth for every agent in the Atlas Agent Mesh 216. It is:

- Stored in PostgreSQL (`agent_registry` table)
- Cached in Redis (30-minute TTL, invalidated on update)
- Loaded at startup by Cortex Core RS (Rust)
- Versioned via semver on each agent definition
- Enforced by a schema validator on every write

Every agent that runs inside Atlas must have a complete, validated registry entry. An agent without a registry entry cannot execute. Cortex Core RS rejects any execution request for an unregistered agent.

---

## 2. Complete Agent Definition Schema

### 2.1 Core Identity Fields

```yaml
agent_id:
  type: string
  format: "domain.agent_name"  # e.g. cashops.collections_priority
  pattern: "^[a-z_]+\\.[a-z_]+$"
  required: true
  immutable: true  # Cannot change after creation

name:
  type: string
  max_length: 100
  required: true

version:
  type: string
  format: semver  # e.g. "1.0.0"
  required: true

layer:
  type: integer
  enum: [1, 2, 3, 4, 5, 6]
  required: true

squad:
  type: string
  required: true

status:
  type: string
  enum:
    - planned      # Defined in registry, not implemented
    - registry     # Schema complete, awaiting harness
    - dry-run      # Static harness passed
    - staging      # Dry-run + red-team passed, in staging env
    - production   # All harness gates passed, live for tenants
    - deprecated   # Replaced or retired
  required: true
  default: planned

public_claim_status:
  type: string
  enum:
    - hidden        # Internal only — never mentioned publicly
    - core_public   # On public website as core agent
    - future_public # Will be public after proof gates met
  required: true
```

### 2.2 Mission and Function Fields

```yaml
mission:
  type: string
  max_length: 200
  description: "One-sentence mission statement — what this agent does"
  required: true

business_function:
  type: string
  max_length: 500
  description: "The business problem this agent solves"
  required: true

trigger_events:
  type: array
  items: string
  min_items: 1
  description: "Events that trigger this agent (e.g. invoice.overdue, payment.received)"
  required: true
```

### 2.3 Input / Output Schema Fields

```yaml
input_schema:
  type: object
  properties:
    required:
      type: array
      items: string
      description: "Required input fields"
    optional:
      type: array
      items: string
      description: "Optional input fields"
    field_definitions:
      type: object
      description: "JSON Schema definitions for each field"
  required: true

output_schema:
  type: object
  properties:
    type:
      type: string
      description: "Top-level output type (e.g. recommendation, proposal, report)"
    fields:
      type: array
      items: string
    schema:
      type: object
      description: "Full JSON Schema of output object"
  required: true

tools_required:
  type: array
  items: string
  description: "Tool IDs this agent needs access to"
  required: true
  min_items: 1  # Every agent must use at least one tool
```

### 2.4 Risk and Policy Fields

```yaml
risk_level:
  type: string
  enum: [low, medium, high, critical]
  required: true
  description: |
    low: read-only insights, summaries, internal explanations
    medium: recommendations, draft messages, rankings, forecasts
    high: customer communication drafts, credit-limit suggestions, supplier payment priority
    critical: payment changes, record deletion, external sends, legal wording, tenant access

policy_rules:
  type: array
  items:
    type: object
    properties:
      rule_id:
        type: string
      description:
        type: string
      condition:
        type: string
      action:
        type: string
        enum: [allow, deny, require_approval, flag_for_review, add_disclaimer]
      priority:
        type: integer
  min_items: 1
  required: true

approval_required:
  type: boolean
  required: true

approval_type:
  type: string
  enum: [none, owner, manager, admin, board]
  required: true
  # Critical agents must be owner or admin

approval_timeout_minutes:
  type: integer
  default: 1440  # 24 hours
  description: "Time before approval request expires and action is cancelled"
```

### 2.5 Audit and Compliance Fields

```yaml
audit_events:
  type: array
  items: string
  description: "Audit event types logged for this agent"
  required: true
  min_items: 1

data_classification:
  type: string
  enum: [public, internal, confidential, restricted]
  required: true

compliance_tags:
  type: array
  items:
    type: string
    enum:
      - DPDP
      - collections_ethics
      - financial_accuracy
      - data_retention
      - consent_required
      - legal_wording_check
      - cross_border_data
      - pii_present
```

### 2.6 Performance and Cost Fields

```yaml
success_metric:
  type: object
  properties:
    metric_name:
      type: string
    target_value:
      type: string
    measurement_method:
      type: string
  required: true

cost_budget:
  type: object
  properties:
    max_tokens_per_run:
      type: integer
    max_cost_usd_per_run:
      type: number
    monthly_budget_usd:
      type: number
  required: true

sla_target_ms:
  type: integer
  description: "Target execution time in milliseconds"
  default: 5000
```

### 2.7 Testing Fields

```yaml
harness_scenarios:
  type: array
  items:
    type: object
    properties:
      scenario_id:
        type: string
      type:
        type: string
        enum: [static, dry_run, red_team, live]
      description:
        type: string
      expected_result:
        type: string
      pass_criteria:
        type: string
  min_items: 1
  required: true

feature_flag:
  type: string
  pattern: "^atlas_[a-z_]+_enabled$"
  description: "Feature flag name in featureFlags.js controlling agent activation"
  required: true

rollback_path:
  type: string
  description: "How to disable or reverse this agent if it causes issues"
  required: true

fallback_behavior:
  type: string
  description: "What Atlas does if this agent fails or times out"
  required: true
```

### 2.8 React UI Metadata (Optional)

```yaml
react_dashboard_section:
  type: string
  enum:
    - agent_registry
    - workflow_console
    - approval_center
    - audit_explorer
    - governance_dashboard
    - harness_monitoring
    - cost_intelligence
    - memory_explorer

react_permissions_scope:
  type: array
  items: string
  description: "React permission strings required to view/interact with this agent"

react_visualization_type:
  type: string
  enum: [table, chart, timeline, gauge, heatmap, dag, card, none]

react_action_panel:
  type: array
  items: string
  description: "Available action buttons in the React UI for this agent"
```

### 2.9 Backend Runtime Metadata

```yaml
rust_execution_engine:
  type: string
  enum:
    - cortex_core    # Run via Cortex Core RS (Rust binary)
    - direct         # Run directly in Node.js
    - queue          # Queue via Redis/BullMQ
    - scheduled      # Cron-scheduled execution
  required: true

parallel_execution_allowed:
  type: boolean
  required: true
  description: "Can this agent run concurrently with other instances?"

queue_execution_supported:
  type: boolean
  required: true

cache_strategy:
  type: object
  properties:
    enabled:
      type: boolean
    ttl_seconds:
      type: integer
    cache_key_pattern:
      type: string
  required: true

memory_retrieval_required:
  type: boolean
  required: true
  description: "Does this agent need business memory/vector retrieval?"

llm_routing_policy:
  type: string
  enum:
    - haiku_first     # Use Claude Haiku (cheap), fall back to Sonnet
    - sonnet_default  # Use Claude Sonnet (default)
    - opus_critical   # Use Claude Opus (critical decisions only)
    - no_llm          # Deterministic — no LLM needed
    - adaptive        # Cost router decides based on complexity
  required: true

tool_execution_mode:
  type: string
  enum: [sequential, parallel, conditional]
  required: true

cost_engine_tracking:
  type: boolean
  required: true
  default: true

harness_x_required:
  type: boolean
  required: true
  # Must be true for all risk_level: high and critical agents
```

---

## 3. PostgreSQL Table Schema

```sql
-- Agent registry: source of truth for all 216 agents
CREATE TABLE agent_registry (
  agent_id                    TEXT PRIMARY KEY,
  name                        TEXT NOT NULL,
  version                     TEXT NOT NULL DEFAULT '1.0.0',
  layer                       SMALLINT NOT NULL CHECK (layer BETWEEN 1 AND 6),
  squad                       TEXT NOT NULL,
  status                      TEXT NOT NULL DEFAULT 'planned'
                              CHECK (status IN ('planned','registry','dry-run','staging','production','deprecated')),
  public_claim_status         TEXT NOT NULL DEFAULT 'hidden'
                              CHECK (public_claim_status IN ('hidden','core_public','future_public')),
  mission                     TEXT NOT NULL,
  business_function           TEXT NOT NULL,
  trigger_events              JSONB NOT NULL DEFAULT '[]',
  input_schema                JSONB NOT NULL DEFAULT '{}',
  output_schema               JSONB NOT NULL DEFAULT '{}',
  tools_required              JSONB NOT NULL DEFAULT '[]',
  risk_level                  TEXT NOT NULL CHECK (risk_level IN ('low','medium','high','critical')),
  policy_rules                JSONB NOT NULL DEFAULT '[]',
  approval_required           BOOLEAN NOT NULL DEFAULT false,
  approval_type               TEXT NOT NULL DEFAULT 'none'
                              CHECK (approval_type IN ('none','owner','manager','admin','board')),
  approval_timeout_minutes    INTEGER NOT NULL DEFAULT 1440,
  audit_events                JSONB NOT NULL DEFAULT '[]',
  data_classification         TEXT NOT NULL DEFAULT 'internal'
                              CHECK (data_classification IN ('public','internal','confidential','restricted')),
  compliance_tags             JSONB NOT NULL DEFAULT '[]',
  success_metric              JSONB NOT NULL DEFAULT '{}',
  cost_budget                 JSONB NOT NULL DEFAULT '{}',
  sla_target_ms               INTEGER NOT NULL DEFAULT 5000,
  harness_scenarios           JSONB NOT NULL DEFAULT '[]',
  feature_flag                TEXT NOT NULL,
  rollback_path               TEXT NOT NULL,
  fallback_behavior           TEXT NOT NULL,
  react_dashboard_section     TEXT,
  react_permissions_scope     JSONB DEFAULT '[]',
  react_visualization_type    TEXT DEFAULT 'none',
  react_action_panel          JSONB DEFAULT '[]',
  rust_execution_engine       TEXT NOT NULL DEFAULT 'direct'
                              CHECK (rust_execution_engine IN ('cortex_core','direct','queue','scheduled')),
  parallel_execution_allowed  BOOLEAN NOT NULL DEFAULT true,
  queue_execution_supported   BOOLEAN NOT NULL DEFAULT false,
  cache_strategy              JSONB NOT NULL DEFAULT '{"enabled": false, "ttl_seconds": 300}',
  memory_retrieval_required   BOOLEAN NOT NULL DEFAULT false,
  llm_routing_policy          TEXT NOT NULL DEFAULT 'sonnet_default'
                              CHECK (llm_routing_policy IN ('haiku_first','sonnet_default','opus_critical','no_llm','adaptive')),
  tool_execution_mode         TEXT NOT NULL DEFAULT 'sequential'
                              CHECK (tool_execution_mode IN ('sequential','parallel','conditional')),
  cost_engine_tracking        BOOLEAN NOT NULL DEFAULT true,
  harness_x_required          BOOLEAN NOT NULL DEFAULT false,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Agent execution history
CREATE TABLE agent_executions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id            TEXT NOT NULL REFERENCES agent_registry(agent_id),
  business_id         TEXT NOT NULL,  -- tenant isolation
  user_id             TEXT NOT NULL,
  execution_mode      TEXT NOT NULL CHECK (execution_mode IN ('immediate','queue','dry_run','harness')),
  status              TEXT NOT NULL CHECK (status IN ('pending','running','completed','failed','cancelled','awaiting_approval')),
  input_data          JSONB,
  output_data         JSONB,
  error_message       TEXT,
  tokens_used         INTEGER,
  cost_usd            NUMERIC(10,6),
  llm_model_used      TEXT,
  execution_ms        INTEGER,
  harness_mode        BOOLEAN NOT NULL DEFAULT false,
  approval_id         UUID,
  started_at          TIMESTAMPTZ,
  completed_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Audit log: every significant agent event
CREATE TABLE agent_audit_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        TEXT NOT NULL,
  execution_id    UUID REFERENCES agent_executions(id),
  business_id     TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  event_type      TEXT NOT NULL,  -- e.g. agent.executed, agent.proposed, approval.requested
  event_data      JSONB,
  risk_level      TEXT,
  ip_address      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Approval queue: pending human approvals for critical agents
CREATE TABLE agent_approvals (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id        UUID NOT NULL REFERENCES agent_executions(id),
  agent_id            TEXT NOT NULL,
  business_id         TEXT NOT NULL,
  requested_by        TEXT NOT NULL,  -- user_id of requester
  approved_by         TEXT,           -- user_id of approver
  approval_type       TEXT NOT NULL CHECK (approval_type IN ('owner','manager','admin','board')),
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','approved','rejected','expired','cancelled')),
  proposal_data       JSONB NOT NULL,
  approval_reason     TEXT,
  rejection_reason    TEXT,
  expires_at          TIMESTAMPTZ NOT NULL,
  decided_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Harness X test results
CREATE TABLE agent_harness_results (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        TEXT NOT NULL REFERENCES agent_registry(agent_id),
  harness_type    TEXT NOT NULL CHECK (harness_type IN ('static','dry_run','red_team','live')),
  scenario_id     TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('pass','fail','skip','error')),
  execution_ms    INTEGER,
  result_data     JSONB,
  error_message   TEXT,
  git_sha         TEXT,
  run_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Workflow state: tracks multi-step agent workflows
CREATE TABLE workflow_state (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_type   TEXT NOT NULL,
  business_id     TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('pending','running','paused','completed','failed','cancelled')),
  current_step    INTEGER NOT NULL DEFAULT 0,
  total_steps     INTEGER NOT NULL,
  step_data       JSONB NOT NULL DEFAULT '{}',
  context         JSONB NOT NULL DEFAULT '{}',
  result          JSONB,
  error_message   TEXT,
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX idx_agent_executions_business ON agent_executions(business_id, created_at DESC);
CREATE INDEX idx_agent_executions_agent ON agent_executions(agent_id, created_at DESC);
CREATE INDEX idx_agent_audit_business ON agent_audit_log(business_id, created_at DESC);
CREATE INDEX idx_agent_approvals_business ON agent_approvals(business_id, status);
CREATE INDEX idx_workflow_state_business ON workflow_state(business_id, status);
CREATE INDEX idx_agent_registry_layer ON agent_registry(layer, status);
CREATE INDEX idx_agent_registry_squad ON agent_registry(squad);
```

---

## 4. Registry API Endpoints

```
GET    /api/v1/agents
       Query: layer, squad, status, risk_level, public_claim_status
       Returns: paginated list of agent definitions
       Auth: required (business-scoped)

GET    /api/v1/agents/:agent_id
       Returns: full agent definition from registry
       Auth: required

POST   /api/v1/agents/:agent_id/execute
       Body: { input: {...}, mode: "immediate" | "queue" | "dry_run" }
       Returns: { execution_id, status, output? }
       Auth: required — validates agent feature flag, risk level, policy rules
       Note: critical agents return proposal + approval_id, not execution output

GET    /api/v1/agents/:agent_id/executions
       Query: status, date_from, date_to, limit
       Returns: execution history for this agent (tenant-scoped)
       Auth: required

GET    /api/v1/agents/:agent_id/harness
       Returns: latest harness test results for each scenario
       Auth: required (admin/owner scope)

POST   /api/v1/agents/:agent_id/approve
       Body: { approval_id, decision: "approved" | "rejected", reason? }
       Returns: { status, execution_id? }
       Auth: requires approval_type role (owner/admin)
       Audit: logged unconditionally

GET    /api/v1/registry/stats
       Returns: {
         total_agents: 216,
         by_layer: { "1": 12, "2": 72, ... },
         by_status: { planned: N, registry: N, ... },
         by_risk: { low: N, medium: N, high: N, critical: N },
         total_executions_24h: N,
         total_cost_24h_usd: N,
         pending_approvals: N
       }
       Auth: required (admin scope)
```

---

## 5. Example Registry Entry — Collections Priority Agent

```yaml
agent_id: cashops.collections_priority
name: Collections Priority Agent
version: "1.0.0"
layer: 2
squad: CashOps / Collections
status: planned
public_claim_status: future_public

mission: "Rank overdue customers by collection priority using payment behavior, risk, and business impact."
business_function: "Eliminates guesswork in collections — tells the owner exactly which customer to contact first, second, and third, and why."

trigger_events:
  - invoice.overdue
  - daily.collections_run
  - owner.request_priority_list

input_schema:
  required:
    - business_id
    - overdue_invoices
    - customer_behavior_scores
  optional:
    - date_range
    - exclude_disputed
    - max_results
  field_definitions:
    business_id: { type: string }
    overdue_invoices: { type: array, items: { invoice_id: string, amount: number, days_overdue: integer } }
    customer_behavior_scores: { type: object, description: "Payment behavior scores from scoring engine" }

tools_required:
  - tool.collections_scorer
  - tool.customer_history_reader
  - tool.invoice_reader
  - tool.risk_calculator

output_schema:
  type: priority_list
  fields:
    - priority_rank
    - customer_id
    - customer_name
    - total_overdue_amount
    - days_overdue
    - priority_score
    - recommended_action
    - recommended_tone
    - reasoning
  schema:
    type: object
    properties:
      priority_list:
        type: array
        items:
          type: object
      generated_at: { type: string, format: datetime }
      total_overdue_value: { type: number }

risk_level: medium
policy_rules:
  - rule_id: PR001
    description: "Exclude disputed invoices from priority list"
    condition: "invoice.status == 'disputed'"
    action: deny
  - rule_id: PR002
    description: "Flag customers with active grievances"
    condition: "customer.has_active_grievance == true"
    action: flag_for_review

approval_required: false
approval_type: none
approval_timeout_minutes: 0

audit_events:
  - agent.priority_list_generated
  - agent.customer_ranked

data_classification: confidential
compliance_tags:
  - collections_ethics
  - financial_accuracy

success_metric:
  metric_name: "Collection success rate from priority list"
  target_value: "Top-3 list should result in payment within 7 days 60% of the time"
  measurement_method: "Track payment events for customers in top-3 of priority list over 30 days"

cost_budget:
  max_tokens_per_run: 2000
  max_cost_usd_per_run: 0.003
  monthly_budget_usd: 5.00

sla_target_ms: 3000

harness_scenarios:
  - scenario_id: CP001
    type: static
    description: "Validate output schema matches definition"
    expected_result: "All required output fields present"
    pass_criteria: "Schema validation passes 100%"
  - scenario_id: CP002
    type: dry_run
    description: "Run with 10 synthetic overdue invoices"
    expected_result: "Returns ranked list of 10 customers"
    pass_criteria: "Priority scores sum correctly, no disputed invoices included"
  - scenario_id: CP003
    type: red_team
    description: "Inject customer with active grievance — verify flagged, not silently included"
    expected_result: "Grievance customer flagged with flag_for_review status"
    pass_criteria: "Grievance customer never appears in top-3 without flag"

feature_flag: atlas_cashops_collections_priority_enabled
rollback_path: "Set feature flag to false in Railway env — agent stops executing, falls back to manual list"
fallback_behavior: "Return static overdue invoice list sorted by amount descending, no AI ranking"

react_dashboard_section: workflow_console
react_permissions_scope: [collections.read, customers.read]
react_visualization_type: table
react_action_panel: [view_customer, start_collection, export_list]

rust_execution_engine: cortex_core
parallel_execution_allowed: true
queue_execution_supported: true
cache_strategy:
  enabled: true
  ttl_seconds: 300
  cache_key_pattern: "collections_priority:{business_id}:{date}"
memory_retrieval_required: true
llm_routing_policy: haiku_first
tool_execution_mode: parallel
cost_engine_tracking: true
harness_x_required: true
```

---

## 6. Registry Validation Rules

### Status Advancement Rules

```
planned → registry:
  - All required fields present and non-empty
  - input_schema and output_schema are valid JSON schemas
  - tools_required references real tool IDs
  - policy_rules has at least 1 rule
  - harness_scenarios has at least 1 scenario
  - feature_flag matches pattern atlas_*_enabled
  - rollback_path non-empty
  - fallback_behavior non-empty

registry → dry-run:
  - Static harness passed (all static scenarios in agent_harness_results)
  - Feature flag created in featureFlags.js
  - Audit events defined and wired

dry-run → staging:
  - Dry-run harness passed
  - HIGH/CRITICAL agents: red-team harness passed
  - Cost budget defined and tracked
  - Approval workflow tested (for approval_required: true agents)

staging → production:
  - Live harness passed
  - Performance harness passed (sla_target_ms met under load)
  - Owner/admin approval obtained
  - All audit events firing correctly in staging
  - Rollback tested and confirmed working

production → deprecated:
  - Replacement agent in staging or production
  - Rollback path confirmed
  - All pending executions drained
  - Audit records preserved
```

### Integrity Rules

```
RULE: Critical agents must have approval
  IF risk_level == 'critical' THEN approval_required MUST be true
  IF risk_level == 'critical' THEN approval_type MUST be 'owner' or 'admin'

RULE: Critical agents must have harness
  IF risk_level == 'critical' THEN harness_x_required MUST be true

RULE: High-risk agents must have red-team scenario
  IF risk_level IN ('high', 'critical') THEN
    harness_scenarios MUST contain at least one item with type == 'red_team'

RULE: No production without all harness types
  IF status == 'production' THEN
    agent_harness_results MUST have at least one PASS record for:
      - static
      - dry_run
      - live (for risk_level: high, critical: also red_team)

RULE: Every agent must have a tool
  tools_required MUST have at least 1 item

RULE: Cost budget required
  cost_budget MUST have max_tokens_per_run > 0 and max_cost_usd_per_run > 0
```

---

## 7. Cortex Core RS Integration

### Registry Loading at Startup

```rust
// Cortex Core RS loads all production agents at startup
// Cached in memory as HashMap<AgentId, AgentDefinition>
// Refreshed every 30 minutes or on SIGUSR1

pub struct AgentRegistry {
    agents: HashMap<String, AgentDefinition>,
    last_loaded: Instant,
    cache_ttl: Duration,
}

impl AgentRegistry {
    pub async fn load_from_db(&mut self, pool: &PgPool) -> Result<(), RegistryError> {
        // Load only production-status agents
        // Apply feature flag filter
        // Validate schema integrity
        // Cache in Redis with 30-minute TTL
    }

    pub fn get_agent(&self, agent_id: &str) -> Option<&AgentDefinition> {
        self.agents.get(agent_id)
    }

    pub fn validate_execution_request(
        &self,
        agent_id: &str,
        input: &Value,
        context: &ExecutionContext,
    ) -> Result<(), ValidationError> {
        // Check agent exists and is production status
        // Check feature flag is enabled
        // Validate input against input_schema
        // Check policy rules
        // Verify user has required permissions
    }
}
```

### Registry Metrics

The Cortex Core RS emits the following metrics on each registry operation:
- `atlas_registry_load_duration_ms` — time to load registry from DB
- `atlas_registry_agents_total{status}` — count of agents per status
- `atlas_agent_execution_total{agent_id, status}` — execution counts
- `atlas_agent_cost_usd_total{agent_id}` — cumulative cost per agent
- `atlas_registry_cache_hit_ratio` — cache efficiency

---

## 8. Registry Management Operations

### Adding a New Agent

1. Insert into `agent_registry` with status: `planned`
2. Schema validator runs automatically
3. Create feature flag in `lib/featureFlags.js` (default: false)
4. Write harness scenarios in `cortex-lab/scenarios/`
5. Run static harness: `npm run cortex:test`
6. Advance status to `registry` after static pass

### Disabling an Agent

```bash
# Immediate disable — set feature flag off in Railway
ATLAS_<AGENT_FLAG>_ENABLED=false

# Graceful deprecation — advance status to deprecated
UPDATE agent_registry SET status = 'deprecated' WHERE agent_id = 'domain.agent_name';
```

### Registry Health Check

```bash
GET /api/v1/registry/stats
# Returns full registry status
# Alert if: pending_approvals > 10, any production agent has recent harness failures
```
