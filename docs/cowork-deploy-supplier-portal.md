# Cowork prompt — Deploy supplier portal migrations 020 + 021

Copy the block below into Cowork. Self-contained: it lists what you're deploying, exactly the commands to run, the failure modes to watch for, and what to do if something goes wrong.

---

## Prompt

You are deploying two new Supabase migrations for the Freeze Pipe ERP: supplier portal schema (020) and supplier portal RPCs (021). These are large, coupled migrations that add a new user class (`supplier`) with its own RLS-scoped data surface. Migration 020 has no write paths — it's schema + RLS only, so after it applies the database is still quiet. Migration 021 adds the SECURITY DEFINER RPCs that suppliers call to mutate state.

### Files you are deploying

- `supabase/migrations/20260101000020_supplier_portal_schema.sql`
- `supabase/migrations/20260101000021_supplier_portal_rpcs.sql`
- `supabase/tests/supplier_portal_rls.test.sql` (test file, not applied as migration)

### Preflight checks (do these first — DO NOT skip)

1. Confirm you're pointed at the right project:
   ```
   supabase projects list
   ```
   The active project should be the staging project. **Do NOT run these commands against prod.**

2. Confirm migration 019 is already applied on the remote:
   ```
   supabase migration list
   ```
   Expect: `20260101000019_line_items_versioning_and_task_logs_append_only` is in both "Local" and "Remote" columns. 020 and 021 should appear in "Local" only.

3. Take a backup / snapshot via the Supabase dashboard BEFORE pushing. These migrations touch existing tables (`suppliers`, `profiles`, `factory_orders`, `factory_order_items`, `freight_shipments`, `freight_line_items`, `locations`) via `ALTER TABLE`. Rollback is painful without a snapshot.

### Deploy steps

1. Push migrations to remote:
   ```
   supabase db push
   ```
   Expected output: two migrations applied. If you see errors about `ALTER TABLE` failing, **stop and read the error** — do NOT retry blindly. The most likely cause is a CHECK constraint violation on existing data, which means a backfill step was missed. Paste the error back to me; do not attempt to fix with ad-hoc SQL.

2. Run the RLS test suite:
   ```
   supabase test db
   ```
   Expected: 18 tests passing. If any fail, capture the full output. The most likely failure is around auth.users seeding — the test file inserts directly into `auth.users` which may require superuser. If pgTAP reports "function does not exist," confirm the test DB is running and pgTAP is enabled (`CREATE EXTENSION IF NOT EXISTS pgtap`).

3. Regenerate TypeScript types so the frontend sees the new schema:
   ```
   supabase gen types typescript --linked > src/lib/database.types.ts
   ```
   After this, run `bun run typecheck` in the repo root. There will almost certainly be new type errors in the existing hooks (the generated `Database` type now includes new tables and new columns). **Do not fix those type errors — just collect them.** I'll wire up the supplier hooks in a follow-up task that depends on this deploy being clean.

4. Sanity-check RLS helpers are callable as `authenticated`:
   ```sql
   -- in the SQL Editor, logged in as anon/authenticated simulation:
   SELECT jwt_supplier_id();  -- should return NULL (no JWT)
   SELECT jwt_supplier_scope();  -- should return {} (empty array)
   SELECT jwt_is_internal();  -- should return false
   ```

### Rollback plan if something goes wrong mid-push

If `supabase db push` fails partway (020 applied, 021 didn't, or vice versa), **do not rerun push**. Instead:

1. Report the exact error output back to me.
2. Check `supabase migration list` to see what's applied on the remote.
3. If only 020 applied: we can either repair forward (fix 021, push again) or roll back 020. Rolling back 020 requires running the reverse DDL manually (drop tables/columns/policies in reverse order). I'll write that reverse script if needed — do not attempt to author it yourself.
4. Never use `supabase db reset` on the remote.

### What NOT to do

- Do NOT edit the migration files during deploy. If you spot a bug, report it — we'll write a forward-fix migration 022.
- Do NOT run `db push` with `--dry-run` as a proxy for testing — a dry run doesn't catch RLS policy logic errors.
- Do NOT proceed to regenerate types until `supabase test db` is green. Types without tested RLS is worse than no types.
- Do NOT grant additional permissions on any RPC. If a call path is missing, flag it — I'll write the addition.

### Report back

When done, report:

1. ✅/❌ Migrations applied (both)
2. ✅/❌ Test suite (N of 18 passing, full output if any failures)
3. ✅/❌ Types regenerated
4. List of new TypeScript errors from `bun run typecheck` (paste verbatim — I need them to plan the hook wiring task)
5. Output of the three `jwt_*` sanity checks
6. Any warnings printed during push (look especially for "deprecated" or "implicit" in the output)

---

## Context for you (Claude session author), not Cowork

Migrations 020 + 021 are the first deployment that touches every existing supplier-adjacent table. The failure modes I'm most worried about:

- **Existing `factory_orders` with no `supplier_id`**: the base schema is supposed to make supplier_id NOT NULL, but if there are legacy rows that slipped in NULL (unlikely but check), the RLS insert policy won't break them — but the advance RPC's `supplier_id != v_supplier_id` comparison against NULL will silently fail. If Cowork reports any weird behavior, ask for `SELECT count(*) FROM factory_orders WHERE supplier_id IS NULL;`.

- **`profiles_role_check` DROP + ADD**: if the existing constraint name is different (I assumed `profiles_role_check` from migration 001), the DROP will error with "constraint does not exist". Fix: use `pg_constraint` query to find the real name. Pre-flight: `SELECT conname FROM pg_constraint WHERE conrelid = 'profiles'::regclass AND contype = 'c';`.

- **pgTAP may not be enabled** on the project. `supabase test db` installs it per-run, but if the project's local config has `[db.pooler]` issues it can fail. Fallback: run the test SQL manually in the SQL Editor and eyeball the output.

When Cowork reports back, review the typecheck errors — those are my roadmap for the next task (wiring hooks).
