-- FILE: migrations/041_execution_records_supply_chain_channel.sql
-- execution_records was scoped to message-sending channels only
-- ('whatsapp', 'test'). The 2xA supply-chain execution adapter reuses this
-- same table (rather than inventing a parallel execution-log table) to
-- record non-message executions (a demo/local ERP write, and — once built —
-- a real Odoo write). Additive: widens the existing channel check
-- constraint only, no data loss, no column changes.
ALTER TABLE execution_records DROP CONSTRAINT IF EXISTS execution_records_channel_check;
ALTER TABLE execution_records ADD CONSTRAINT execution_records_channel_check
  CHECK (channel = ANY (ARRAY['whatsapp'::text, 'test'::text, 'demo_erp_adapter'::text, 'live_odoo'::text]));

-- Non-message channels complete synchronously (a DB write either succeeds or
-- fails), unlike message sends which pass through queued/sent/delivered
-- states — 'completed' covers that synchronous case without overloading
-- 'delivered' (which implies a delivery receipt from a messaging provider).
ALTER TABLE execution_records DROP CONSTRAINT IF EXISTS execution_records_status_check;
ALTER TABLE execution_records ADD CONSTRAINT execution_records_status_check
  CHECK (status = ANY (ARRAY['queued'::text, 'sent'::text, 'delivered'::text, 'failed'::text, 'read'::text, 'completed'::text]));
