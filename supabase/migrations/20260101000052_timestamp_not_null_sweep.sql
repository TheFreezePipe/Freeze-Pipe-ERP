-- =============================================================
-- Migration 052: created_at / updated_at NOT NULL sweep
-- =============================================================
-- The initial schema (migration 001) declared every timestamp as
-- `TIMESTAMPTZ DEFAULT now()` — defaulted, but nullable. Migrations
-- 011+ flipped to `TIMESTAMPTZ NOT NULL DEFAULT now()` for new
-- tables, leaving the original-schema tables with the looser shape.
-- The drift surfaces in the generated TypeScript types as
-- `created_at: string | null` for the old tables vs `string` for
-- newer ones, and forces every consumer to handle a "what if it's
-- null" branch that has been impossible since day one (DEFAULT now()
-- fires on every INSERT that omits the column).
--
-- This migration:
--   1. Defensively backfills any NULL created_at / updated_at values
--      on the affected tables. Should be a no-op against prod (the
--      DEFAULT has always fired), but a pre-NOT-NULL safety net.
--   2. Walks information_schema and ALTER COLUMN ... SET NOT NULL on
--      every public BASE TABLE where created_at / updated_at exists
--      and is currently nullable. Idempotent — re-running flips zero
--      columns the second time.
--
-- IMPORTANT: filter to BASE TABLE only.
-- `information_schema.columns` includes both base tables AND views.
-- Views (e.g. `inventory_levels_default`, `product_skus_active`,
-- the `supplier_portal_*` family) inherit nullability from their
-- underlying tables — UPDATE-ing or ALTER-ing them directly fails
-- (Postgres rejects "cannot update view" / "ALTER TABLE on view").
-- The first pass of this migration on staging tripped immediately
-- on `inventory_levels_default`. We add a base-table filter to the
-- candidate query so views are skipped; once the underlying base
-- columns are tightened, the views' columns automatically report
-- NOT NULL too via Postgres' inferred-nullability propagation.
--
-- Re-run `supabase gen types typescript ...` after this lands so
-- the generated types tighten to `string` (no more `| null`).
-- =============================================================

-- -------------------------------------------------------------
-- Phase 1: defensive backfill on base tables only.
-- -------------------------------------------------------------
DO $$
DECLARE
  r          RECORD;
  v_updated  INTEGER;
BEGIN
  FOR r IN
    SELECT c.table_name, c.column_name
      FROM information_schema.columns c
     WHERE c.table_schema = 'public'
       AND c.column_name IN ('created_at', 'updated_at', 'last_synced_at')
       AND c.is_nullable = 'YES'
       AND c.data_type = 'timestamp with time zone'
       AND EXISTS (
         SELECT 1 FROM information_schema.tables t
          WHERE t.table_schema = c.table_schema
            AND t.table_name   = c.table_name
            AND t.table_type   = 'BASE TABLE'
       )
  LOOP
    EXECUTE format(
      'UPDATE public.%I SET %I = now() WHERE %I IS NULL',
      r.table_name, r.column_name, r.column_name
    );
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated > 0 THEN
      RAISE NOTICE 'Migration 052 backfill: % rows on %.%',
        v_updated, r.table_name, r.column_name;
    END IF;
  END LOOP;
END$$;

-- -------------------------------------------------------------
-- Phase 2: flip nullable → NOT NULL on every matching base-table
-- column. Same base-table filter as Phase 1.
-- -------------------------------------------------------------
DO $$
DECLARE
  r RECORD;
  v_count INTEGER := 0;
BEGIN
  FOR r IN
    SELECT c.table_name, c.column_name
      FROM information_schema.columns c
     WHERE c.table_schema = 'public'
       AND c.column_name IN ('created_at', 'updated_at', 'last_synced_at')
       AND c.is_nullable = 'YES'
       AND c.data_type = 'timestamp with time zone'
       AND EXISTS (
         SELECT 1 FROM information_schema.tables t
          WHERE t.table_schema = c.table_schema
            AND t.table_name   = c.table_name
            AND t.table_type   = 'BASE TABLE'
       )
  LOOP
    EXECUTE format(
      'ALTER TABLE public.%I ALTER COLUMN %I SET NOT NULL',
      r.table_name, r.column_name
    );
    RAISE NOTICE 'Migration 052: SET NOT NULL on %.%', r.table_name, r.column_name;
    v_count := v_count + 1;
  END LOOP;
  RAISE NOTICE 'Migration 052: tightened % timestamp column(s)', v_count;
END$$;

-- -------------------------------------------------------------
-- Sanity guard: zero matching base-table columns may remain
-- nullable. Views are intentionally excluded from this check
-- because their nullability is inferred from the underlying base
-- columns — once the base column is NOT NULL, the view column is
-- too. Including views here would re-introduce the false positive
-- this migration was rewritten to avoid.
-- -------------------------------------------------------------
DO $$
DECLARE
  v_remaining INTEGER;
  v_names     TEXT;
BEGIN
  SELECT COUNT(*),
         string_agg(c.table_name || '.' || c.column_name, ', ')
    INTO v_remaining, v_names
    FROM information_schema.columns c
   WHERE c.table_schema = 'public'
     AND c.column_name IN ('created_at', 'updated_at', 'last_synced_at')
     AND c.is_nullable = 'YES'
     AND c.data_type = 'timestamp with time zone'
     AND EXISTS (
       SELECT 1 FROM information_schema.tables t
        WHERE t.table_schema = c.table_schema
          AND t.table_name   = c.table_name
          AND t.table_type   = 'BASE TABLE'
     );

  IF v_remaining > 0 THEN
    RAISE EXCEPTION
      'Migration 052: % base-table timestamp column(s) still nullable: %',
      v_remaining, v_names;
  END IF;
END$$;
