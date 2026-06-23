-- =============================================================
-- Migration: freight_shipments.china_customs_delay flag
-- =============================================================
-- Adds a boolean marker set by the "China Customs Inspection" action on the
-- shipment detail page (which also pushes the ETA out by 7 days). Purely
-- additive; defaults false.
-- =============================================================

ALTER TABLE public.freight_shipments
  ADD COLUMN IF NOT EXISTS china_customs_delay boolean NOT NULL DEFAULT false;

INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES
  ('20260623000001', 'freight_china_customs_delay')
ON CONFLICT (version) DO NOTHING;
