# Cowork prompt — confirm migration drift

Copy everything below the `---` into Cowork.

---

# Task: confirm migrations 020 + 021 on disk match what you deployed

Background: when you deployed migrations 020 + 021 you corrected several column names against the live schema before applying. The author has now patched the local migration files to match the renames you listed (product_name, carrier_name, quantity_ordered, freight_shipment_id, expected_completion, actual_arrival_date). We need to confirm zero drift remains, because a fresh clone + `supabase db reset` must reproduce exactly what's on the remote.

## Step 1 — Dump the deployed schema for the affected tables

Run in the SQL Editor and paste the full output back:

```sql
SELECT
  table_name,
  column_name,
  data_type,
  is_nullable,
  column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN (
    'suppliers',
    'profiles',
    'product_skus',
    'product_boms',
    'locations',
    'factory_orders',
    'factory_order_items',
    'freight_shipments',
    'freight_line_items',
    'shipment_variances',
    'component_breakage_reports'
  )
ORDER BY table_name, ordinal_position;
```

## Step 2 — Dump policies + triggers + functions

```sql
-- Policies
SELECT schemaname, tablename, policyname, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND policyname LIKE 'supplier_%'
ORDER BY tablename, policyname;

-- Triggers on the new/modified tables
SELECT event_object_table AS table_name, trigger_name, event_manipulation, action_statement
FROM information_schema.triggers
WHERE event_object_schema = 'public'
  AND event_object_table IN (
    'product_boms',
    'shipment_variances',
    'component_breakage_reports',
    'factory_orders',
    'factory_order_items',
    'freight_shipments',
    'freight_line_items',
    'suppliers'
  )
ORDER BY event_object_table, trigger_name;

-- Supplier-portal functions / RPCs
SELECT p.proname AS function_name, pg_get_function_identity_arguments(p.oid) AS args
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND (
    p.proname LIKE 'rpc_supplier_%'
    OR p.proname LIKE 'rpc_consolidator_%'
    OR p.proname LIKE 'rpc_file_%'
    OR p.proname LIKE 'rpc_acknowledge_%'
    OR p.proname LIKE 'rpc_resolve_%'
    OR p.proname LIKE 'rpc_promote_%'
    OR p.proname LIKE 'rpc_set_profile_%'
    OR p.proname IN ('jwt_supplier_id', 'jwt_supplier_scope', 'jwt_is_internal',
                     'validate_consolidates_for', 'check_bom_no_cycle',
                     'enforce_shipment_variance_append_only',
                     'enforce_breakage_report_append_only',
                     'enforce_breakage_reporter_consolidates',
                     'block_shipment_variance_delete',
                     'block_breakage_report_delete')
  )
ORDER BY p.proname;
```

## Step 3 — Paste the two corrected migration files

If you kept a copy of the exact SQL you ran (the version with column-name corrections applied), paste them back verbatim:

1. `supabase/migrations/20260101000020_supplier_portal_schema.sql`
2. `supabase/migrations/20260101000021_supplier_portal_rpcs.sql`

If you didn't keep a copy: skip step 3. Steps 1 + 2 are sufficient for me to diff against local.

## What NOT to do

- Do not re-run the migrations — they're already applied.
- Do not modify any deployed objects.
- Do not GRANT or REVOKE anything new.
- This is read-only reconnaissance.

## Report format

Three sections in your reply:

```
### Section 1: information_schema.columns output
<paste>

### Section 2: policies + triggers + functions output
<paste>

### Section 3: deployed migration file contents (if available)
<paste or "not retained">
```

One additional line at the end: any renames / corrections / additions you made that are NOT in the list the author already has (product_name, carrier_name, quantity_ordered, freight_shipment_id, expected_completion, actual_arrival_date, removed departed_at). Even small ones count — extra `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`, dropped constraints, anything.
