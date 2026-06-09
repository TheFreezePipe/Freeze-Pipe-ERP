-- =============================================================
-- Migration: decrement box stock from ShipStation shipments
-- =============================================================
-- When an order ships, ShipStation records the package dimensions (the
-- packageCode is always the generic "package", but `dimensions` carries the
-- real box size — present on ~99% of shipped orders). We match those
-- dimensions to a box material by SORTED L×W×H (axis order doesn't matter)
-- and decrement that box by 1, with a material_transactions audit row.
--
-- Design choices (per product decision):
--   * Forward-only: all CURRENTLY-shipped orders are seeded as handled so
--     history isn't back-decremented. Only shipments going forward consume.
--     (Orders still awaiting_shipment are left unseeded, so they decrement
--     a box when they later ship.)
--   * Unmatched dims / missing dims: mark handled (no decrement, no retry)
--     and surface the size in shipstation_unmatched_boxes for review — add a
--     matching box to the catalog and future shipments auto-match.
--   * Isolated from rpc_apply_shipstation_sale (the sensitive sale path is
--     left untouched). Idempotent via box_applied_at + a per-order guard.
--   * Negative allowed (consistent with the SKU oversell policy) — a
--     negative box count just flags "needs a cycle count".
-- =============================================================

-- 1. Idempotency marker.
ALTER TABLE public.shipstation_orders
  ADD COLUMN IF NOT EXISTS box_applied_at timestamptz;

-- 2. Forward-only seed: mark every already-shipped order as box-handled so
--    the first run doesn't retroactively decrement thousands of boxes.
UPDATE public.shipstation_orders
   SET box_applied_at = now()
 WHERE box_applied_at IS NULL
   AND order_status = 'shipped';

-- 3. The apply RPC.
CREATE OR REPLACE FUNCTION public.rpc_apply_shipstation_boxes(
  p_system_actor_id uuid DEFAULT '00000000-0000-0000-0000-000000000001'::uuid,
  p_limit integer DEFAULT 2000
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_order       RECORD;
  v_l int; v_w int; v_h int;
  v_dims        int[];
  v_box_id      uuid;
  v_processed   int := 0;
  v_decremented int := 0;
  v_no_dims     int := 0;
  v_no_match    int := 0;
BEGIN
  FOR v_order IN
    SELECT id, order_number, raw_payload
      FROM public.shipstation_orders
     WHERE order_status = 'shipped' AND box_applied_at IS NULL
     ORDER BY ship_date NULLS LAST
     LIMIT GREATEST(p_limit, 1)
  LOOP
    BEGIN
      v_processed := v_processed + 1;

      v_l := NULL; v_w := NULL; v_h := NULL;
      IF v_order.raw_payload ? 'dimensions'
         AND v_order.raw_payload->'dimensions'->>'length' IS NOT NULL
         AND v_order.raw_payload->'dimensions'->>'width'  IS NOT NULL
         AND v_order.raw_payload->'dimensions'->>'height' IS NOT NULL THEN
        v_l := round((v_order.raw_payload->'dimensions'->>'length')::numeric)::int;
        v_w := round((v_order.raw_payload->'dimensions'->>'width')::numeric)::int;
        v_h := round((v_order.raw_payload->'dimensions'->>'height')::numeric)::int;
      END IF;

      -- No usable dimensions → handled, no decrement.
      IF v_l IS NULL OR v_w IS NULL OR v_h IS NULL OR v_l <= 0 OR v_w <= 0 OR v_h <= 0 THEN
        v_no_dims := v_no_dims + 1;
        UPDATE public.shipstation_orders SET box_applied_at = now() WHERE id = v_order.id;
        CONTINUE;
      END IF;

      v_dims := ARRAY(SELECT d FROM unnest(ARRAY[v_l, v_w, v_h]) AS d ORDER BY d DESC);

      -- Match a box by sorted dimensions (boxes are the materials with dims).
      SELECT m.id INTO v_box_id
        FROM public.materials m
       WHERE m.dim_length_in IS NOT NULL
         AND m.dim_width_in  IS NOT NULL
         AND m.dim_height_in IS NOT NULL
         AND ARRAY(
               SELECT d FROM unnest(ARRAY[
                 round(m.dim_length_in)::int,
                 round(m.dim_width_in)::int,
                 round(m.dim_height_in)::int
               ]) AS d ORDER BY d DESC
             ) = v_dims
       ORDER BY m.is_active DESC
       LIMIT 1;

      -- No catalog box for these dims → handled, surfaced for review.
      IF v_box_id IS NULL THEN
        v_no_match := v_no_match + 1;
        UPDATE public.shipstation_orders SET box_applied_at = now() WHERE id = v_order.id;
        CONTINUE;
      END IF;

      -- Double-safe idempotency: never decrement twice for the same order.
      IF EXISTS (
        SELECT 1 FROM public.material_transactions mt
         WHERE mt.reference_type = 'shipstation_order'
           AND mt.reference_id = v_order.id
           AND mt.transaction_type = 'shipstation_box'
      ) THEN
        UPDATE public.shipstation_orders SET box_applied_at = now() WHERE id = v_order.id;
        CONTINUE;
      END IF;

      UPDATE public.material_inventory_levels
         SET on_hand_qty = on_hand_qty - 1, updated_at = now()
       WHERE material_id = v_box_id;
      IF NOT FOUND THEN
        INSERT INTO public.material_inventory_levels (material_id, on_hand_qty)
        VALUES (v_box_id, -1);
      END IF;

      INSERT INTO public.material_transactions (
        material_id, transaction_type, quantity_change,
        reference_type, reference_id, notes, performed_by
      ) VALUES (
        v_box_id, 'shipstation_box', -1,
        'shipstation_order', v_order.id,
        format('Box used on ShipStation order %s (%sx%sx%s in)',
               v_order.order_number, v_l, v_w, v_h),
        p_system_actor_id
      );

      UPDATE public.shipstation_orders SET box_applied_at = now() WHERE id = v_order.id;
      v_decremented := v_decremented + 1;

    EXCEPTION WHEN OTHERS THEN
      -- One bad order shouldn't abort the batch. Its subtransaction rolled
      -- back (box_applied_at not set), so it'll be retried next run.
      NULL;
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'processed', v_processed,
    'decremented', v_decremented,
    'no_dims', v_no_dims,
    'no_match', v_no_match
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.rpc_apply_shipstation_boxes(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_apply_shipstation_boxes(uuid, integer) TO authenticated;

-- 4. Review surface: shipped-forward orders whose dims matched no box.
--    Gated to go-live (2026-06-09) so the seeded history doesn't appear.
CREATE OR REPLACE VIEW public.shipstation_unmatched_boxes AS
SELECT
  k.dims_key,
  count(*)            AS shipments,
  max(s.ship_date)    AS last_shipped
FROM (
  SELECT
    o.id,
    o.ship_date,
    round((o.raw_payload->'dimensions'->>'length')::numeric)::int AS l,
    round((o.raw_payload->'dimensions'->>'width')::numeric)::int  AS w,
    round((o.raw_payload->'dimensions'->>'height')::numeric)::int AS h
  FROM public.shipstation_orders o
  WHERE o.order_status = 'shipped'
    AND o.box_applied_at IS NOT NULL
    AND o.raw_payload->'dimensions'->>'length' IS NOT NULL
    AND o.raw_payload->'dimensions'->>'width'  IS NOT NULL
    AND o.raw_payload->'dimensions'->>'height' IS NOT NULL
    AND COALESCE(o.ship_date, o.order_date) >= DATE '2026-06-09'
    AND NOT EXISTS (
      SELECT 1 FROM public.material_transactions mt
       WHERE mt.reference_type = 'shipstation_order'
         AND mt.reference_id = o.id
         AND mt.transaction_type = 'shipstation_box'
    )
) s
CROSS JOIN LATERAL (
  SELECT array_to_string(
    ARRAY(SELECT d FROM unnest(ARRAY[s.l, s.w, s.h]) AS d ORDER BY d DESC), 'x'
  ) AS dims_key
) k
GROUP BY k.dims_key
ORDER BY count(*) DESC;

GRANT SELECT ON public.shipstation_unmatched_boxes TO authenticated;

-- 5. Nightly cron, just after the ShipStation sync (03:15) so newly-shipped
--    orders are present. Re-create idempotently.
DO $$
BEGIN
  PERFORM cron.unschedule('shipstation-box-apply');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule(
  'shipstation-box-apply',
  '35 3 * * *',
  $$SELECT public.rpc_apply_shipstation_boxes();$$
);
