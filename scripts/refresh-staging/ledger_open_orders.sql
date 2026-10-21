-- =============================================================
-- ledger_open_orders.sql - ledger rows for orders not yet shipped (design 3.1)
-- =============================================================
-- Why: the refresh copies no inventory_transactions (52k hash-chained rows),
-- so on staging the ledger says nothing about open orders and the nightly
-- identity "physical on-hand - open-order deductions = warehouse_finished"
-- would read a zero open-order term. inventory_levels IS copied (already
-- net of those deductions), so the ledger rows that explain the deductions
-- of orders still awaiting shipment, on hold or cancelled are copied too.
--
-- Three sections, run by refresh.py in this order:
--   stg_order_ids : STAGING. The copied orders whose status is not 'shipped',
--                   as copied (so the set matches the rows on staging even if
--                   production moved on while the copy ran).
--   prod_rows     : PRODUCTION, read only, paged, in seq order. Every
--                   inventory_transactions row with reference_type
--                   'shipstation_order' for those orders. Today the apply
--                   RPC writes only order_shipped and shipstation_ledger_rebase
--                   with that reference type. seq, row_hash, prev_hash,
--                   actor_ip and actor_user_agent are NOT carried over;
--                   a note containing an @ sign is replaced.
--   stg_insert    : STAGING. Inserts the page in seq order (the `ord` field
--                   refresh.py adds). seq is an identity column and
--                   trg_audit_hash_chain recomputes prev_hash and row_hash on
--                   insert, so staging gets a clean new chain. Re-running is
--                   safe: ON CONFLICT (id) DO NOTHING.
--
-- Placeholders (SQL literals made by refresh.py):
--   {{ORDER_IDS}} text literal holding a JSON array of order uuids
--   {{LIMIT}} {{OFFSET}} integers
--   {{ROWS_JSON}} text literal holding a JSON array of ledger rows
--   {{SYSTEM_ACTOR_ID}} text literal; used when performed_by has no profile

-- @@ stg_order_ids stg
SELECT coalesce(jsonb_agg(o.id ORDER BY o.id), '[]'::jsonb) AS v
  FROM public.shipstation_orders o
 WHERE o.order_status <> 'shipped';

-- @@ prod_rows prod
SELECT jsonb_build_object(
         'id', t.id,
         'sku_id', t.sku_id,
         'transaction_type', t.transaction_type,
         'quantity', t.quantity,
         'field_affected', t.field_affected,
         'reference_id', t.reference_id,
         'reference_type', t.reference_type,
         'notes', CASE WHEN t.notes LIKE '%@%' THEN '[scrubbed]' ELSE t.notes END,
         'performed_by', t.performed_by,
         'created_at', t.created_at,
         'movement_kind', t.movement_kind,
         'from_field', t.from_field,
         'to_field', t.to_field) AS r
  FROM public.inventory_transactions t
 WHERE t.reference_type = 'shipstation_order'
   AND t.reference_id IN (SELECT e::uuid FROM jsonb_array_elements_text({{ORDER_IDS}}::jsonb) AS e)
 ORDER BY t.seq
 LIMIT {{LIMIT}} OFFSET {{OFFSET}};

-- @@ stg_insert stg
INSERT INTO public.inventory_transactions
       (id, sku_id, transaction_type, quantity, field_affected, reference_id, reference_type,
        notes, performed_by, created_at, movement_kind, from_field, to_field)
SELECT r.id, r.sku_id, r.transaction_type, r.quantity, r.field_affected, r.reference_id, r.reference_type,
       r.notes,
       CASE WHEN EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = r.performed_by)
            THEN r.performed_by ELSE {{SYSTEM_ACTOR_ID}}::uuid END,
       r.created_at, r.movement_kind, r.from_field, r.to_field
  FROM jsonb_to_recordset({{ROWS_JSON}}::jsonb)
       AS r(ord int, id uuid, sku_id uuid, transaction_type text, quantity int, field_affected text,
            reference_id uuid, reference_type text, notes text, performed_by uuid,
            created_at timestamptz, movement_kind text, from_field text, to_field text)
 ORDER BY r.ord
ON CONFLICT (id) DO NOTHING;
