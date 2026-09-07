-- ============================================================
-- VANTRO STARLANE — Migration 016: seed world_transmission_channels
-- ============================================================
-- Additive only. Seeds the mission's own worked examples as real rows (not
-- documentation-only), so business_signals has real channels to reference
-- from day one. ON CONFLICT DO NOTHING keyed on the UNIQUE(event_category,
-- affected_dimension, mechanism) constraint from migration 015 — safe to
-- re-run.
INSERT INTO world_transmission_channels
  (event_category, affected_dimension, direction, mechanism, applicability_conditions, default_confidence)
VALUES
  ('COMMODITIES', 'transport_cost', 'increase',
   'A spike in crude oil price raises fuel costs for freight/shipping/trucking, which carriers pass through as higher transport rates.',
   'Applies when the tenant relies on road/sea/air freight for inbound or outbound goods; effect lags the price move by days-to-weeks depending on contract terms.',
   0.700),

  ('LOGISTICS', 'lead_time', 'increase',
   'Closure or major disruption of a port/airport/route forces rerouting via slower or more distant alternatives, extending delivery lead time.',
   'Applies when the tenant''s supplier or customer shipments transit the affected port/route; magnitude depends on availability of alternate routes.',
   0.750),

  ('NATURAL_HAZARD', 'supplier_cost', 'variable',
   'A flood (or other natural hazard) damages a supplier''s facilities or interrupts their operations, which can raise the supplier''s costs (passed through) or halt supply entirely.',
   'Applies when a known supplier operates in or sources from the affected region; direction depends on whether the supplier absorbs the cost or halts fulfilment.',
   0.550),

  ('MONETARY_POLICY', 'borrowing_cost', 'increase',
   'A central bank policy rate hike raises the cost of variable-rate loans, credit lines, and working-capital financing for businesses.',
   'Applies when the tenant carries variable-rate debt or draws on credit facilities denominated in the affected currency/jurisdiction.',
   0.800),

  ('FINANCIAL_MARKETS', 'fx_exposure', 'variable',
   'A material move in an exchange rate changes the local-currency cost of imported goods/services or the value of foreign-currency receivables/payables.',
   'Applies when the tenant imports/exports or holds invoices denominated in a foreign currency; direction depends on which side of the trade the tenant is on.',
   0.700),

  ('TRADE', 'landed_cost', 'increase',
   'A new or increased tariff raises the landed cost of imported goods subject to that tariff line.',
   'Applies when the tenant imports goods classified under the affected tariff schedule/country pair.',
   0.750)
ON CONFLICT (event_category, affected_dimension, mechanism) DO NOTHING;

SELECT 'Migration 016_world_transmission_channels_seed complete' AS status;
