-- =============================================================
-- Audit quick wins (2026-07-02): retention purges + hot FK indexes
-- =============================================================
-- 1) Retention: shipstation_webhook_events grew to 18MB in 2 months and
--    was unbounded (full raw request bodies). Processed events older than
--    30 days have no operational value — the orders they produced live in
--    shipstation_orders. Same for shipstation_sync_runs older than 90 days
--    (run telemetry only). A daily pg_cron purge keeps both flat.
-- 2) Indexes: cover the two genuinely hot un-indexed FKs found in the
--    audit (join/lookup paths used by the reconciler + factory-order math).
--    The many cold audit-trail FKs (acknowledged_by etc.) are left alone —
--    at current row counts an index there is pure overhead.

CREATE OR REPLACE FUNCTION public.purge_ingest_telemetry()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM shipstation_webhook_events
  WHERE processed_at IS NOT NULL AND received_at < now() - interval '30 days';
  DELETE FROM shipstation_sync_runs
  WHERE started_at < now() - interval '90 days';
$$;

REVOKE ALL ON FUNCTION public.purge_ingest_telemetry() FROM public;

-- Hot FK indexes
CREATE INDEX IF NOT EXISTS idx_factory_order_items_sku
  ON public.factory_order_items (sku_id);
CREATE INDEX IF NOT EXISTS idx_webhook_events_resulting_order
  ON public.shipstation_webhook_events (resulting_order_id)
  WHERE resulting_order_id IS NOT NULL;
