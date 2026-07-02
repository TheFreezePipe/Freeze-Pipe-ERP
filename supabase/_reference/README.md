# Reference-only SQL — never apply

`all_migrations_combined.sql` is a historical snapshot: the first ~18 dev
migrations concatenated into one file during early development (pre-baseline).
It is NOT part of the migration sequence and must never be fed to
`supabase db push` or psql — the real schema lineage is:

1. `supabase/migrations/20260504000001_baseline_schema_from_staging.sql`
   (squashed baseline, replaces the 59 originals archived in
   `supabase/migrations/_archived/`)
2. Every timestamped migration after it.

Kept only as an audit-trail artifact. Safe to delete if never referenced.
