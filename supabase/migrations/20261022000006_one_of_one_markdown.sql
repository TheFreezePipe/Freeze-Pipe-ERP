-- =============================================================
-- One of One markdown — audit log + daily cron fire helper
-- =============================================================
-- The Shopify product "One of One Drops" holds unique single-unit pieces.
-- The edge function `one-of-one-markdown` steps each unsold variant's price
-- down $10 per full week since its clock started, floored at 50% of the
-- original price, and emails the owners when a piece first hits the floor.
-- The rule's STATE (original price, clock start, alert sent) lives on the
-- variant as Shopify metafields (namespace one_of_one) so the owners can see
-- and edit it in admin. This table is only the audit trail: one row per
-- unsold variant per run, saying what the run saw and did.
--
-- Cron (scheduled at deploy time, same as the daily report — pg_cron is not
-- available locally):
--   SELECT cron.schedule('one-of-one-markdown-daily', '30 10 * * *',
--                        $cron$SELECT public.fire_one_of_one_markdown()$cron$);
-- 10:30 UTC = 6:30am EDT / 5:30am EST. Daily, not weekly: each piece steps
-- on its own weekly anniversary, and the job is idempotent (a run that
-- finds nothing due is a no-op), so daily just means markdowns land the
-- morning they fall due.
-- =============================================================

CREATE TABLE public.one_of_one_markdown_log (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id           uuid        NOT NULL,
  run_at           timestamptz NOT NULL,
  variant_id       text        NOT NULL,   -- gid://shopify/ProductVariant/...
  sku              text        NOT NULL DEFAULT '',
  piece            text        NOT NULL,
  theme            text        NOT NULL DEFAULT '',
  weeks            int         NOT NULL,   -- full weeks since the piece's clock start
  original_price   numeric(10,2) NOT NULL,
  old_price        numeric(10,2) NOT NULL, -- live price before the run
  new_price        numeric(10,2) NOT NULL, -- price after the run (= old when held)
  floor_price      numeric(10,2) NOT NULL,
  at_floor         boolean     NOT NULL,
  action           text        NOT NULL CHECK (action IN ('markdown', 'hold')),
  floor_alert_sent boolean     NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX one_of_one_markdown_log_run_idx ON public.one_of_one_markdown_log (run_at DESC);
CREATE INDEX one_of_one_markdown_log_variant_idx ON public.one_of_one_markdown_log (variant_id, run_at DESC);

ALTER TABLE public.one_of_one_markdown_log ENABLE ROW LEVEL SECURITY;

-- Read-only in the app for admins/managers; writes come from the edge
-- function with the service role (bypasses RLS).
CREATE POLICY "Admins can view one of one markdown log" ON public.one_of_one_markdown_log
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.profiles
    WHERE profiles.id = auth.uid()
      AND profiles.role = ANY (ARRAY['admin'::text, 'manager'::text])
  ));

CREATE OR REPLACE FUNCTION public.fire_one_of_one_markdown()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM net.http_post(
    url := 'https://pnqujtugddxusllkikje.supabase.co/functions/v1/one-of-one-markdown',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_jwt')
    ),
    body := '{}'::jsonb
  );
END;
$$;

-- Supabase's default privileges grant EXECUTE on new public functions to
-- anon/authenticated directly; without this revoke anyone with the anon key
-- could trigger markdown runs via /rest/v1/rpc. pg_cron runs as postgres.
REVOKE ALL ON FUNCTION public.fire_one_of_one_markdown() FROM PUBLIC, anon, authenticated;
