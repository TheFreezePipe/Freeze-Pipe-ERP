-- Adds fields needed to track ETA drift over time as carrier tracking updates flow in.
--
--   eta_original          frozen at first carrier check; used to display drift
--   eta_last_checked_at   ISO timestamp of the last successful tracking poll
--
-- The polling loop itself runs as a Supabase Edge Function on pg_cron, hitting
-- per-carrier APIs (Maersk, FedEx, DHL, etc.) and writing reconciled ETAs back
-- into freight_shipments.

ALTER TABLE freight_shipments
  ADD COLUMN IF NOT EXISTS eta_original date,
  ADD COLUMN IF NOT EXISTS eta_last_checked_at timestamptz;

-- Backfill: any existing shipment uses its current ETA as its baseline.
UPDATE freight_shipments
   SET eta_original = eta
 WHERE eta_original IS NULL
   AND eta IS NOT NULL;

COMMENT ON COLUMN freight_shipments.eta_original IS
  'Original ETA captured before any carrier-driven drift. Immutable after the first tracking check.';
COMMENT ON COLUMN freight_shipments.eta_last_checked_at IS
  'Timestamp of the last successful carrier tracking check. NULL means never checked.';
