-- =============================================================
-- Migration: drop mkt_sales.status (status is now derived from dates)
-- =============================================================
-- Sales no longer carry a manual status. The running state — Upcoming / Live /
-- Ended — is derived from starts_at/ends_at at display time so it can never
-- drift out of sync. Unconfirmed or canceled sales aren't parked on the
-- calendar; they're simply deleted. The column (added hours ago in the Phase 1
-- schema) is a cosmetic label only, so dropping it loses no real data.
-- =============================================================

ALTER TABLE public.mkt_sales DROP COLUMN IF EXISTS status;

INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES
  ('20260618000003', 'drop_mkt_sales_status')
ON CONFLICT (version) DO NOTHING;
