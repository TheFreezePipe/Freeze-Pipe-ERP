-- =============================================================
-- Migration 058: rpc_factory_order_component_status_batch
-- =============================================================
-- The single-order RPC (migration 057) is sufficient for the order
-- detail pages, but the FactoryOrders list pages need component
-- status across N orders to render per-SKU warning icons inline.
-- N parallel single-order RPC calls would mean N round trips per
-- list render — wasteful at staging, painful at scale.
--
-- This migration adds a batch variant. Authorization rules match
-- the single-order RPC:
--   - internal staff sees any parent order's status
--   - suppliers see only orders they own (supplier_id ∈ scope)
-- Parents the caller can't see are silently omitted from the
-- response — we don't error on a partial-permission set, since
-- the typical use is "give me status for everything I'm currently
-- showing on screen" and a forbidden order would just be one the
-- caller already shouldn't be displaying.
--
-- Returns: JSONB object keyed by parent factory_order_id (string).
-- Each value is the same shape as rpc_factory_order_component_status:
--   { expected_components: [...], child_orders: [...] }
-- Empty objects when the parent has no BoM components — this lets
-- callers render "no warning" without a special-case branch.
-- =============================================================

CREATE OR REPLACE FUNCTION rpc_factory_order_component_status_batch(
  p_parent_order_ids UUID[]
) RETURNS JSONB AS $$
DECLARE
  v_is_internal BOOLEAN;
  v_supplier_scope UUID[];
  v_visible UUID[];
  v_result JSONB := '{}'::JSONB;
  v_parent_id UUID;
BEGIN
  IF p_parent_order_ids IS NULL OR cardinality(p_parent_order_ids) = 0 THEN
    RETURN '{}'::JSONB;
  END IF;

  -- Filter the requested ids down to ones the caller can see.
  v_is_internal := jwt_is_internal();
  IF v_is_internal THEN
    v_visible := p_parent_order_ids;
  ELSE
    v_supplier_scope := jwt_supplier_scope();
    SELECT array_agg(fo.id)
      INTO v_visible
      FROM factory_orders fo
     WHERE fo.id = ANY(p_parent_order_ids)
       AND fo.supplier_id = ANY(v_supplier_scope);
    IF v_visible IS NULL THEN
      RETURN '{}'::JSONB;
    END IF;
  END IF;

  -- Compose the result object. For each visible parent, pull the
  -- BoM-derived expected components and any child orders. Both
  -- subqueries are correlated via v_parent_id; the outer FOREACH
  -- loop walks the visible-id set explicitly so the result keys
  -- stay aligned with what the caller asked for (and missing
  -- entries are silently absent rather than nulled out).
  FOREACH v_parent_id IN ARRAY v_visible LOOP
    v_result := v_result || jsonb_build_object(
      v_parent_id::TEXT,
      jsonb_build_object(
        'expected_components', (
          SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'component_sku_id', t.component_sku_id,
            'component_sku',    t.sku,
            'quantity_needed',  t.quantity_needed
          )), '[]'::JSONB)
          FROM (
            SELECT b.component_sku_id,
                   sk.sku,
                   SUM(foi.quantity_ordered * b.units_per_parent)::INTEGER AS quantity_needed
              FROM factory_order_items foi
              JOIN product_boms b
                ON b.parent_sku_id = foi.sku_id
               AND b.component_type = 'produced'
               AND b.effective_until IS NULL
              JOIN product_skus sk ON sk.id = b.component_sku_id
             WHERE foi.factory_order_id = v_parent_id
             GROUP BY b.component_sku_id, sk.sku
          ) t
        ),
        'child_orders', (
          SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'id',                  c.id,
            'order_number',        c.order_number,
            'supplier_id',         c.supplier_id,
            'supplier_code',       s.code,
            'supplier_name',       s.name,
            'status',              c.status,
            'order_date',          c.order_date,
            'expected_completion', c.expected_completion,
            'components', (
              SELECT COALESCE(jsonb_agg(jsonb_build_object(
                'sku_id',            ci.sku_id,
                'sku',               sk.sku,
                'quantity_ordered',  ci.quantity_ordered,
                'quantity_finished', ci.quantity_finished
              )), '[]'::JSONB)
              FROM factory_order_items ci
              JOIN product_skus sk ON sk.id = ci.sku_id
              WHERE ci.factory_order_id = c.id
            )
          )), '[]'::JSONB)
          FROM factory_orders c
          JOIN suppliers s ON s.id = c.supplier_id
          WHERE c.parent_factory_order_id = v_parent_id
        )
      )
    );
  END LOOP;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION rpc_factory_order_component_status_batch(UUID[]) TO authenticated;

COMMENT ON FUNCTION rpc_factory_order_component_status_batch IS
  'Batch variant of rpc_factory_order_component_status. Takes an array of parent factory_order_ids, returns JSONB map keyed by id with {expected_components, child_orders} per parent. Used by the FactoryOrders list pages (admin + supplier portal) to render per-SKU missing-component warning icons in one round trip. Forbidden orders (caller does not own) are silently omitted, not errored — the typical use is "status for everything I''m showing," so partial-permission sets degrade gracefully.';

-- Sanity guard
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'rpc_factory_order_component_status_batch'
      AND p.prosecdef = true
      AND 'search_path=public' = ANY(p.proconfig)
  ) THEN
    RAISE EXCEPTION 'Migration 058: rpc_factory_order_component_status_batch did not land hardened';
  END IF;
END$$;
