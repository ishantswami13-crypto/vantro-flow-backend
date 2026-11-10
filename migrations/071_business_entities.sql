-- 071_business_entities.sql — Spaces: several companies under one account.
--
-- An account (users.id) stays the tenant. A business entity is a company the
-- owner runs inside that account (for example a UK, a German and an Indian
-- company), with its own currency. Customers and suppliers are assigned to an
-- entity by name, so invoices and bills follow their customer or supplier
-- without rewriting any synced row: Tally, imports and the bridge keep
-- writing exactly what they write today.
--
-- Additive only. Every row carries user_id and every route scopes by the
-- verified JWT's user id.

CREATE TABLE IF NOT EXISTS business_entities (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  currency    TEXT CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),  -- ISO 4217; NULL = the business's own currency
  country     TEXT CHECK (country IS NULL OR country ~ '^[A-Z]{2}$'),    -- ISO 3166-1 alpha-2
  color       TEXT CHECK (color IS NULL OR color ~ '^#[0-9A-Fa-f]{6}$'),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_business_entities_user_name ON business_entities(user_id, lower(name));
CREATE INDEX IF NOT EXISTS idx_business_entities_user ON business_entities(user_id);

CREATE TABLE IF NOT EXISTS business_entity_members (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity_id   UUID NOT NULL REFERENCES business_entities(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('customer', 'supplier')),
  name        TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- A customer or supplier belongs to one entity at a time.
CREATE UNIQUE INDEX IF NOT EXISTS uq_business_entity_members_name ON business_entity_members(user_id, kind, lower(btrim(name)));
CREATE INDEX IF NOT EXISTS idx_business_entity_members_entity ON business_entity_members(entity_id);

COMMENT ON TABLE business_entities IS 'Companies an owner runs inside one account (Spaces). Tenant key is user_id.';
COMMENT ON TABLE business_entity_members IS 'Which entity each customer or supplier (by name) belongs to. Invoices and bills follow their counterparty.';
