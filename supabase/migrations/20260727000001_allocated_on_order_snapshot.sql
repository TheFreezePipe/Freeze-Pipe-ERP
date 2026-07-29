-- ============================================================================
-- Allocated components: on-order valuation reserves at LINK time
-- ============================================================================
-- Mirror of the frontend change (src/lib/allocation.ts): a child order's
-- component units claimed by its linked parent reserve
--   GREATEST(realized consumption, planned allocation)
-- where planned = LEAST(child qty, Σ BOM units_per_parent × parent qty
-- ordered). Previously only ship-time consumption was subtracted, so the
-- nightly retail snapshot valued allocated components as loose incoming
-- stock for the whole production window. Terminology: "allocated"
-- (owner decision 2026-07-27).

CREATE OR REPLACE FUNCTION public.rpc_snapshot_inventory_retail_value()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_day       date := (now() AT TIME ZONE 'America/New_York')::date;
  v_warehouse numeric(14,2);
  v_transit   numeric(14,2);
  v_onorder   numeric(14,2);
BEGIN
  SELECT COALESCE(SUM(
           ( COALESCE(il.warehouse_raw,0)
           + COALESCE(il.warehouse_prefilled_raw,0)
           + COALESCE(il.warehouse_in_production,0)
           + COALESCE(il.warehouse_finished,0)
           + COALESCE(il.warehouse_other,0) ) * COALESCE(ps.retail_price,0)
         ), 0)
    INTO v_warehouse
    FROM public.inventory_levels il
    JOIN public.product_skus ps ON ps.id = il.sku_id;

  SELECT COALESCE(SUM(GREATEST(fl.quantity - fl.quantity_received, 0) * COALESCE(ps.retail_price,0)), 0)
    INTO v_transit
    FROM public.freight_line_items fl
    JOIN public.product_skus ps ON ps.id = fl.sku_id
   WHERE fl.sku_id IS NOT NULL;

  WITH foiship AS (
    SELECT source_factory_order_item_id AS foi_id, SUM(quantity) AS q
      FROM public.freight_line_items
     WHERE source_factory_order_item_id IS NOT NULL
     GROUP BY source_factory_order_item_id
  ),
  planned AS (
    -- Day-one allocation per linked child item: BOM × parent ordered qty,
    -- capped at the child's own quantity.
    SELECT ci.id AS foi_id,
           LEAST(ci.quantity_ordered,
                 COALESCE(SUM(b.units_per_parent * pi.quantity_ordered), 0))::int AS planned
      FROM public.factory_order_items ci
      JOIN public.factory_orders co ON co.id = ci.factory_order_id
                                   AND co.parent_factory_order_id IS NOT NULL
      JOIN public.factory_order_items pi ON pi.factory_order_id = co.parent_factory_order_id
      JOIN public.product_boms b ON b.parent_sku_id = pi.sku_id
                                AND b.component_sku_id = ci.sku_id
     GROUP BY ci.id, ci.quantity_ordered
  )
  SELECT COALESCE(SUM(
           GREATEST(
             COALESCE(foi.quantity_ordered,0)
             - COALESCE(foi.quantity_breakage,0)
             - COALESCE(foi.quantity_shipped_manual,0)
             - GREATEST(COALESCE(foi.quantity_consumed_by_parent,0), COALESCE(pl.planned,0))
             - COALESCE(fsh.q,0)
           , 0) * COALESCE(ps.retail_price,0)
         ), 0)
    INTO v_onorder
    FROM public.factory_order_items foi
    JOIN public.factory_orders o ON o.id = foi.factory_order_id
    JOIN public.product_skus ps ON ps.id = foi.sku_id
    LEFT JOIN foiship fsh ON fsh.foi_id = foi.id
    LEFT JOIN planned pl ON pl.foi_id = foi.id
   WHERE o.status IN ('ordered','in_production','finished');

  INSERT INTO public.inventory_retail_value_daily
    (snapshot_date, warehouse_retail, transit_retail, onorder_retail, source, updated_at)
  VALUES (v_day, v_warehouse, v_transit, v_onorder, 'snapshot', now())
  ON CONFLICT (snapshot_date) DO UPDATE
    SET warehouse_retail = EXCLUDED.warehouse_retail,
        transit_retail   = EXCLUDED.transit_retail,
        onorder_retail   = EXCLUDED.onorder_retail,
        source           = 'snapshot',
        updated_at       = now();
END;
$function$;
