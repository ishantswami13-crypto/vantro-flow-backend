-- Migration 023: entity_state_history (Global Context, Part E -- Temporal Primitive)
--
-- Design decision (documented per Part E instructions): we did NOT extend
-- `business_events` (migration 001). Reasoning:
--   `business_events` stores one `payload_json` blob per event with no
--   structured "changed fields" shape -- it is a generic append-only log,
--   fine for narrative events, but callers would have to invent their own
--   ad-hoc payload_json convention for "what changed" per entity_type,
--   which is exactly the kind of inconsistency Part E's changed-field-delta
--   requirement is meant to avoid. `world_event_revisions` (Phase 1 World
--   Intelligence) DOES already do field-level {previous,new} deltas, but it
--   is scoped to `world_events` (external, global events) via a hard
--   `event_id` FK -- reusing it for internal business-entity state changes
--   would conflate two conceptually different timelines (external world
--   facts vs. this tenant's own invoices/payments), which section 4 of
--   STARLANE_GLOBAL_MULTIDIMENSIONAL_ARCHITECTURE.md explicitly flags as
--   still-separate today ("two separate event logs"). A small, purpose-built
--   table that mirrors world_event_revisions' proven {previous,new} delta
--   shape -- but scoped to internal entities via (entity_type, entity_id)
--   the same loose typed-reference convention business_exposure already
--   uses -- is the smallest correct reusable mechanism, consistent with
--   both existing patterns rather than inventing a third shape.
--
-- Never duplicates full rows: changed_fields only contains the fields that
-- actually changed, as {field: {previous, new}}.

CREATE TABLE IF NOT EXISTS entity_state_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN (
    'invoice', 'payment', 'sale', 'purchase', 'inventory', 'supplier', 'customer'
  )),
  entity_id TEXT NOT NULL,
  event_type TEXT NOT NULL, -- e.g. invoice_created / invoice_status_changed / invoice_due_date_changed / payment_received / sale_updated / purchase_status_changed / inventory_adjusted -- extensible, not a CHECK enum (new event types are pure data, no migration needed)
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  changed_fields JSONB NOT NULL DEFAULT '{}'::jsonb, -- { field: { previous, new } } -- only actually-changed fields
  source TEXT, -- e.g. 'server.js:invoice-update', 'paymentAllocation.service'
  actor TEXT,  -- nullable -- which user/agent caused this change
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Part M -- performance: index the two likely query patterns explicitly
-- named in the mission (entity_type+entity_id lookups, and user_id+time
-- range scans), so both stay index-backed rather than sequential scans as
-- the table grows.
CREATE INDEX IF NOT EXISTS idx_entity_state_history_entity ON entity_state_history(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_state_history_user_time ON entity_state_history(user_id, observed_at DESC);

COMMENT ON TABLE entity_state_history IS
  'Append-only changed-field deltas for internal business entities (invoices/payments/sales/purchases/inventory/suppliers/customers). Never duplicates full rows. Mirrors world_event_revisions'' proven {previous,new} delta shape, scoped to this tenant''s own entities via loosely-typed (entity_type, entity_id) references, the same convention business_exposure already uses.';
