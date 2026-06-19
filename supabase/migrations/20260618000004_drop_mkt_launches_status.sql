-- =============================================================
-- Migration: drop mkt_launches.status (launch state is derived)
-- =============================================================
-- Like sales, launches no longer carry a manual status. The pill is derived:
--   * Upcoming  — launch_date is in the future
--   * Launched  — launch_date is today or past
--   * Sold out  — launched AND the linked SKU has zero stock on hand
--                 (read live from inventory, not stored)
-- Canceled launches are deleted, not parked. The column (added in the Phase 1
-- schema hours ago) is a cosmetic label only.
-- =============================================================

ALTER TABLE public.mkt_launches DROP COLUMN IF EXISTS status;

INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES
  ('20260618000004', 'drop_mkt_launches_status')
ON CONFLICT (version) DO NOTHING;
