-- =============================================================
-- Migration 016: Scheduled tracking reconciler
-- =============================================================
-- Moves the 12-hour carrier-tracking poll off the client and onto
-- pg_cron + the tracking-reconcile Edge Function (supabase/functions/).
--
-- Before this: the browser running the app polled carrier APIs every 12h
-- via useShipmentTracking. If nobody logged in over a weekend, tracking
-- never refreshed.
--
-- After this: the Edge Function runs on a fixed schedule regardless of
-- who's logged in, writes reconciled ETAs directly to freight_shipments,
-- and the client becomes a pure read view (polling replaced by Supabase
-- realtime subscription OR manual refresh button).

-- -------------------------------------------------------------
-- A. Enable pg_cron + pg_net (idempotent)
-- -------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- -------------------------------------------------------------
-- B. The cron job
-- -------------------------------------------------------------
-- Runs every 6 hours at :07 past — slightly offset from the hour to
-- avoid rush-hour scheduler contention with other jobs.
-- Sends a POST to the tracking-reconcile Edge Function using the
-- service_role JWT (stored in the `app.settings.service_role_jwt` GUC,
-- which must be set once at deploy time via SQL Editor).

-- First unschedule if it already exists (so this migration is idempotent).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'tracking-reconcile') THEN
    PERFORM cron.unschedule('tracking-reconcile');
  END IF;
END$$;

-- Note: the project URL and JWT are deployment-specific. At deploy time,
-- run in SQL Editor:
--
--   ALTER DATABASE postgres SET app.settings.project_url
--     TO 'https://<project-ref>.supabase.co';
--   ALTER DATABASE postgres SET app.settings.service_role_jwt
--     TO '<service-role-jwt>';
--
-- Then run this cron.schedule statement.
SELECT cron.schedule(
  'tracking-reconcile',
  '7 */6 * * *',  -- :07 every 6 hours — gives a full re-check window each half-day
  $$
    SELECT net.http_post(
      url := current_setting('app.settings.project_url') || '/functions/v1/tracking-reconcile',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || current_setting('app.settings.service_role_jwt'),
        'Content-Type', 'application/json'
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 60000
    );
  $$
);

-- -------------------------------------------------------------
-- C. Also schedule the ShipStation reconciler here since we're touching cron
-- -------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'shipstation-reconcile-nightly') THEN
    PERFORM cron.unschedule('shipstation-reconcile-nightly');
  END IF;
END$$;

SELECT cron.schedule(
  'shipstation-reconcile-nightly',
  '15 3 * * *',  -- 03:15 UTC nightly (23:15 ET)
  $$
    SELECT net.http_post(
      url := current_setting('app.settings.project_url') || '/functions/v1/shipstation-reconcile',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || current_setting('app.settings.service_role_jwt'),
        'Content-Type', 'application/json'
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 600000
    );
  $$
);

-- -------------------------------------------------------------
-- D. Also schedule a nightly audit-chain verification as a safety net
-- -------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'audit-chain-verify') THEN
    PERFORM cron.unschedule('audit-chain-verify');
  END IF;
END$$;

-- Verifies the previous 48 hours of audit entries daily. Much cheaper than
-- the full chain; catches any tampering within the detection window.
SELECT cron.schedule(
  'audit-chain-verify',
  '30 4 * * *',  -- 04:30 UTC nightly
  $$
    INSERT INTO inventory_transactions (
      sku_id, transaction_type, quantity, field_affected,
      movement_kind, notes, performed_by
    )
    SELECT
      NULL, 'audit_chain_alert', 0, 'row_hash',
      'metadata',
      format('Chain broken starting at %s: %s', first_broken_id, message),
      '00000000-0000-0000-0000-000000000001'::uuid
    FROM verify_audit_chain(now() - interval '48 hours')
    LIMIT 1;
  $$
);

COMMENT ON EXTENSION pg_cron IS
  'Scheduled jobs live here. Review with: SELECT * FROM cron.job;';
