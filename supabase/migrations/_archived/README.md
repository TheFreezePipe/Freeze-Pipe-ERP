# Archived migrations — do not apply

These 59 files are the original incremental dev migrations. They were
squashed into `../20260504000001_baseline_schema_from_staging.sql` when
production was bootstrapped (2026-05-04) and are kept ONLY as an audit
trail — e.g. migration 016 documents the original cron-job scheduling SQL.

Never re-apply them: they predate the baseline, carry cumulative
compatibility fixes that the baseline already contains, and will conflict
with the live schema. `supabase migration` commands ignore this folder
(leading underscore); keep it that way.
