-- =============================================================
-- YouTube video summaries — Charley T channel watcher
-- =============================================================
-- Tracks every video seen on Professor Charley T's channel
-- (@CTtheDisrupter, UC3kl2OhNRZ1rH_4bnd0Ap7g) and what happened to it.
-- The edge function `youtube-summary` does the work (feed poll -> Supadata
-- transcript -> Claude summary -> Resend email); pg_cron fires it hourly
-- via public.fire_youtube_summary().
--
-- Status machine (claim-before-send + Resend idempotency keys — designed
-- so a video can never be emailed twice; see the edge function header for
-- the full transitions):
--   seeded        - in the feed when the watcher launched; never emailed
--   processing    - claimed by a run (attempt counted); summary in progress
--   sending       - payload durably stored; Resend call in flight
--   sent          - summarized and emailed
--   pending_retry - a step failed; retried with backoff
--   gave_up       - retry budget exhausted
-- =============================================================

CREATE TABLE public.youtube_video_summaries (
  video_id     text PRIMARY KEY,
  title        text NOT NULL,
  channel_name text NOT NULL DEFAULT 'Professor Charley T',
  video_url    text NOT NULL,
  published_at timestamptz,
  status       text NOT NULL CHECK (status IN
    ('seeded', 'processing', 'sending', 'sent', 'pending_retry', 'gave_up')),
  attempts     int  NOT NULL DEFAULT 0,
  transcript_chars int,
  summary      jsonb,          -- { summary, tips[], action_items[] } as sent
  email_to     text[],
  resend_id    text,
  error        text,           -- last failure reason
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_attempt_at timestamptz, -- drives retry backoff + stale-claim sweeps
  processed_at timestamptz
);

ALTER TABLE public.youtube_video_summaries ENABLE ROW LEVEL SECURITY;

-- Read-only visibility in the app for admins/managers; all writes go
-- through the edge function with the service role (bypasses RLS).
CREATE POLICY "Admins can view video summaries" ON public.youtube_video_summaries
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.profiles
    WHERE profiles.id = auth.uid()
      AND profiles.role = ANY (ARRAY['admin'::text, 'manager'::text])
  ));

-- Fired hourly by pg_cron (job scheduled at deploy time, same as the
-- daily report):
--   SELECT cron.schedule('youtube-summary-hourly', '7 * * * *',
--                        $cron$SELECT public.fire_youtube_summary()$cron$);
-- No hour guard needed - the edge function is idempotent (claims each
-- video before working on it) and a run with nothing new is a cheap no-op.
CREATE OR REPLACE FUNCTION public.fire_youtube_summary()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM net.http_post(
    url := 'https://pnqujtugddxusllkikje.supabase.co/functions/v1/youtube-summary',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_jwt')
    ),
    body := '{}'::jsonb
  );
END;
$$;

-- Supabase's default privileges grant EXECUTE on new public functions
-- directly to anon/authenticated (not via the PUBLIC pseudo-role), which
-- would expose this as a PostgREST RPC anyone with the anon key could
-- spam. Revoke all three; pg_cron runs as postgres and is unaffected.
REVOKE ALL ON FUNCTION public.fire_youtube_summary() FROM PUBLIC, anon, authenticated;

-- Same hardening for the daily report's fire helper, which shipped with
-- only the PUBLIC revoke (anon could trigger report sends via /rest/v1/rpc).
REVOKE ALL ON FUNCTION public.fire_daily_report() FROM PUBLIC, anon, authenticated;
