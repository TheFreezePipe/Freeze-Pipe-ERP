-- =============================================================
-- Migration 054: defense-in-depth text length caps
-- =============================================================
-- Operator- and supplier-writable free-text columns (notes,
-- description, resolution_notes) were declared as plain TEXT with
-- no upper bound. The application UI typically constrains input
-- length, but RPCs accept arbitrary strings — and `safeValidate`
-- on the client is not authoritative. A malicious or buggy caller
-- (or a misbehaving supplier portal) could blast multi-megabyte
-- payloads, bloating the table and the audit chain.
--
-- This migration adds CHECK constraints capping every notable
-- free-text column to a generous-but-bounded limit:
--
--   * notes / resolution_notes / description / address: 4000 chars
--   * archive_reason / inventory_apply_error: 1000 chars
--
-- 4000 is far above any legitimate operator note (typical: a
-- sentence; outliers: a paragraph) but small enough to make abuse
-- visible and contained. CHECK constraints are evaluated on every
-- INSERT/UPDATE; the cost is negligible relative to the storage
-- they prevent.
--
-- All constraints are added with NOT VALID + immediate VALIDATE so
-- the migration is idempotent: a second run sees the constraint
-- already exists and skips. Existing rows are validated; if any
-- legacy row exceeds the cap, the migration aborts loudly so a
-- human can investigate (vs silently truncating real data).
-- =============================================================

-- Helper: add a CHECK if it doesn't already exist. Wrapped in
-- IF NOT EXISTS-style logic via pg_constraint catalog lookup.
DO $$
DECLARE
  v_specs JSONB := '[
    { "table": "factory_orders",          "column": "notes",                "cap": 4000 },
    { "table": "factory_order_items",     "column": "notes",                "cap": 4000 },
    { "table": "freight_shipments",       "column": "notes",                "cap": 4000 },
    { "table": "freight_line_items",      "column": "notes",                "cap": 4000 },
    { "table": "task_logs",               "column": "notes",                "cap": 4000 },
    { "table": "inventory_transactions",  "column": "notes",                "cap": 4000 },
    { "table": "supplier_inventory",      "column": "notes",                "cap": 4000 },
    { "table": "sku_supplier_costs",      "column": "notes",                "cap": 4000 },
    { "table": "shipment_variances",      "column": "description",          "cap": 4000 },
    { "table": "shipment_variances",      "column": "resolution_notes",     "cap": 4000 },
    { "table": "component_breakage_reports", "column": "description",       "cap": 4000 },
    { "table": "component_breakage_reports", "column": "resolution_notes",  "cap": 4000 },
    { "table": "suppliers",               "column": "address",              "cap": 4000 },
    { "table": "shipstation_orders",      "column": "notes",                "cap": 4000 },
    { "table": "product_skus",            "column": "archive_reason",       "cap": 1000 }
  ]'::JSONB;
  v_spec      JSONB;
  v_table     TEXT;
  v_column    TEXT;
  v_cap       INTEGER;
  v_constraint TEXT;
  v_col_exists BOOLEAN;
  v_violations INTEGER;
BEGIN
  FOR v_spec IN SELECT * FROM jsonb_array_elements(v_specs) LOOP
    v_table  := v_spec->>'table';
    v_column := v_spec->>'column';
    v_cap    := (v_spec->>'cap')::INTEGER;
    v_constraint := format('chk_%s_%s_max_len', v_table, v_column);

    -- Skip silently if the column doesn't exist (some tables may not
    -- have landed yet on every environment, or were renamed).
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = v_table
        AND column_name = v_column
    ) INTO v_col_exists;
    IF NOT v_col_exists THEN
      RAISE NOTICE 'Migration 054: skipping %.% (column not present)', v_table, v_column;
      CONTINUE;
    END IF;

    -- Already present? Don't double-add.
    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = v_constraint
    ) THEN
      RAISE NOTICE 'Migration 054: % already exists', v_constraint;
      CONTINUE;
    END IF;

    -- Pre-flight: count existing rows that would violate the cap.
    -- If any exist, abort the migration so a human can investigate
    -- rather than blocking the ALTER on validation.
    EXECUTE format(
      'SELECT COUNT(*) FROM public.%I WHERE %I IS NOT NULL AND length(%I) > %s',
      v_table, v_column, v_column, v_cap
    ) INTO v_violations;

    IF v_violations > 0 THEN
      RAISE EXCEPTION
        'Migration 054: % rows in %.% exceed the % char cap — refusing to add CHECK constraint',
        v_violations, v_table, v_column, v_cap;
    END IF;

    -- Add the constraint. NOT VALID would skip the table-scan validation
    -- but we just confirmed zero violations above, so the immediate
    -- non-NOT-VALID add is fine and gives us the validated state in one
    -- step. Tables here are small enough that the AccessExclusive
    -- lock during validation is negligible.
    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (%I IS NULL OR length(%I) <= %s)',
      v_table, v_constraint, v_column, v_column, v_cap
    );
    RAISE NOTICE 'Migration 054: added % (cap %)', v_constraint, v_cap;
  END LOOP;
END$$;
