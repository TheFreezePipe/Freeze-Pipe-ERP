-- =============================================================
-- One of One markdown — steps are no longer weeks
-- =============================================================
-- From 2026-11-03 the markdown step is every 4 days (OOO_STEP_DAYS,
-- default 4 in pricing.ts) instead of every 7. The audit column that
-- counted "full weeks since clock start" now counts full steps; rename it
-- so the log reads honestly, and record the step length and days elapsed
-- per row so old (7-day) and new (4-day) rows stay interpretable.
-- Idempotent.
-- =============================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'one_of_one_markdown_log' AND column_name = 'weeks') THEN
    ALTER TABLE public.one_of_one_markdown_log RENAME COLUMN weeks TO steps;
  END IF;
END $$;

ALTER TABLE public.one_of_one_markdown_log
  ADD COLUMN IF NOT EXISTS step_days int NOT NULL DEFAULT 7,   -- rows before this migration were 7-day steps
  ADD COLUMN IF NOT EXISTS days_unsold int;

ALTER TABLE public.one_of_one_markdown_log ALTER COLUMN step_days DROP DEFAULT;

COMMENT ON COLUMN public.one_of_one_markdown_log.steps IS 'Full markdown steps since the piece''s clock start (step length in step_days).';
COMMENT ON COLUMN public.one_of_one_markdown_log.step_days IS 'Length of one markdown step in days at the time of the run (7 until 2026-11-03, then 4).';
COMMENT ON COLUMN public.one_of_one_markdown_log.days_unsold IS 'Full days since the piece''s clock start at the time of the run.';
