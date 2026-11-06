-- The checkout shipping rates were renamed on 2026-11-04: the day ranges were
-- dropped, so "Free Standard Shipping (5-8 Days)" became "Free Standard
-- Shipping". rpc_shipping_measure_input matched the old name exactly, so the
-- weekly shipping measurement would have stopped seeing new free-tier orders.
-- p_service is now the base name, and an order matches when its requested
-- service is that name alone or that name followed by a parenthesised suffix.
CREATE OR REPLACE FUNCTION public.rpc_shipping_measure_input(p_from date, p_to date, p_service text DEFAULT 'Free Standard Shipping'::text)
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'order_id', so.shipstation_order_id, 'order_number', so.order_number,
           'ship_date', sh.ship_date, 'weight_oz', sh.weight_oz, 'box', sh.box, 'cost', sh.cost,
           'sku_id', i.sku_id, 'sku', ps.sku, 'cat', ps.display_category, 'qty', i.quantity)), '[]'::jsonb)
  FROM shipstation_orders so
  JOIN (SELECT order_id, MAX(ship_date) ship_date, MAX(weight_oz) weight_oz, SUM(shipment_cost) cost,
               MAX(COALESCE(length_in::text, '?') || 'x' || COALESCE(width_in::text, '?') || 'x' || COALESCE(height_in::text, '?')) box
        FROM shipstation_shipments WHERE NOT voided
        GROUP BY order_id HAVING COUNT(*) = 1 AND SUM(shipment_cost) > 0 AND MAX(weight_oz) > 0) sh
    ON sh.order_id = so.shipstation_order_id
  JOIN shipstation_order_items i ON i.shipstation_order_id = so.id AND i.sku_id IS NOT NULL
  JOIN product_skus ps ON ps.id = i.sku_id
  WHERE so.order_status = 'shipped'
    AND so.store_id = 229438                      -- main Shopify store
    AND sh.ship_date >= p_from AND sh.ship_date < p_to
    AND (so.raw_payload->>'requestedShippingService' = p_service
         OR left(so.raw_payload->>'requestedShippingService', length(p_service) + 2) = p_service || ' (');
$function$;
