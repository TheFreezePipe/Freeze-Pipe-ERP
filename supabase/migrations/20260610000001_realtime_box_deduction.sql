-- =============================================================
-- Migration: near-real-time box deductions
-- =============================================================
-- Boxes were deducted once nightly (03:35 cron). During busy season
-- (700+ boxes/day) that makes intraday box counts useless. Two changes:
--
--   1. TRIGGER: the moment an order row becomes status='shipped'
--      (webhook delivery OR api reconcile), deduct its box immediately.
--      Failures are swallowed so ingestion is never blocked —
--      box_applied_at stays NULL and the nightly sweep retries.
--   2. INTRADAY SYNC: schedule the shipstation-reconcile edge function
--      every 30 minutes (rolling 24h modifyDate window, idempotent), so
--      shipped orders the webhook misses land within ~30 min instead of
--      at 03:15. The trigger then deducts on arrival. (Side benefit:
--      finished-goods deductions + oversell warnings also surface
--      intraday.) The nightly 03:15 job is left in place; the 03:35 box
--      sweep remains as the catch-all for trigger failures.
--
-- The per-order logic is extracted from rpc_apply_shipstation_boxes into
-- _apply_box_for_shipped_order so the trigger, the sweep RPC, and any
-- manual call share one implementation.
-- =============================================================

-- 1. Per-order box apply. Returns what happened:
--    'decremented' | 'no_dims' | 'no_match' | 'already' | 'skipped'
CREATE OR REPLACE FUNCTION public._apply_box_for_shipped_order(p_order_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_order   RECORD;
  v_l int; v_w int; v_h int;
  v_dims    int[];
  v_box_id  uuid;
BEGIN
  SELECT id, order_number, order_status, box_applied_at, raw_payload
    INTO v_order
    FROM public.shipstation_orders
   WHERE id = p_order_id
   FOR UPDATE;

  IF NOT FOUND OR v_order.order_status <> 'shipped' OR v_order.box_applied_at IS NOT NULL THEN
    RETURN 'skipped';
  END IF;

  v_l := NULL; v_w := NULL; v_h := NULL;
  IF v_order.raw_payload ? 'dimensions'
     AND v_order.raw_payload->'dimensions'->>'length' IS NOT NULL
     AND v_order.raw_payload->'dimensions'->>'width'  IS NOT NULL
     AND v_order.raw_payload->'dimensions'->>'height' IS NOT NULL THEN
    v_l := round((v_order.raw_payload->'dimensions'->>'length')::numeric)::int;
    v_w := round((v_order.raw_payload->'dimensions'->>'width')::numeric)::int;
    v_h := round((v_order.raw_payload->'dimensions'->>'height')::numeric)::int;
  END IF;

  IF v_l IS NULL OR v_w IS NULL OR v_h IS NULL OR v_l <= 0 OR v_w <= 0 OR v_h <= 0 THEN
    UPDATE public.shipstation_orders SET box_applied_at = now() WHERE id = p_order_id;
    RETURN 'no_dims';
  END IF;

  v_dims := ARRAY(SELECT d FROM unnest(ARRAY[v_l, v_w, v_h]) AS d ORDER BY d DESC);

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

  IF v_box_id IS NULL THEN
    UPDATE public.shipstation_orders SET box_applied_at = now() WHERE id = p_order_id;
    RETURN 'no_match';
  END IF;

  -- Never decrement twice for the same order.
  IF EXISTS (
    SELECT 1 FROM public.material_transactions mt
     WHERE mt.reference_type = 'shipstation_order'
       AND mt.reference_id = p_order_id
       AND mt.transaction_type = 'shipstation_box'
  ) THEN
    UPDATE public.shipstation_orders SET box_applied_at = now() WHERE id = p_order_id;
    RETURN 'already';
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
    'shipstation_order', p_order_id,
    format('Box used on ShipStation order %s (%sx%sx%s in)',
           v_order.order_number, v_l, v_w, v_h),
    '00000000-0000-0000-0000-000000000001'::uuid
  );

  UPDATE public.shipstation_orders SET box_applied_at = now() WHERE id = p_order_id;
  RETURN 'decremented';
END;
$function$;

REVOKE ALL ON FUNCTION public._apply_box_for_shipped_order(uuid) FROM PUBLIC;

-- 2. Batch sweep RPC, now a thin loop over the helper. Kept for the
--    nightly catch-all cron and manual runs.
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
  v_id          uuid;
  v_result      text;
  v_processed   int := 0;
  v_decremented int := 0;
  v_no_dims     int := 0;
  v_no_match    int := 0;
BEGIN
  FOR v_id IN
    SELECT id FROM public.shipstation_orders
     WHERE order_status = 'shipped' AND box_applied_at IS NULL
     ORDER BY ship_date NULLS LAST
     LIMIT GREATEST(p_limit, 1)
  LOOP
    BEGIN
      v_processed := v_processed + 1;
      v_result := public._apply_box_for_shipped_order(v_id);
      IF v_result = 'decremented' THEN v_decremented := v_decremented + 1;
      ELSIF v_result = 'no_dims' THEN v_no_dims := v_no_dims + 1;
      ELSIF v_result = 'no_match' THEN v_no_match := v_no_match + 1;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      -- One bad order shouldn't abort the batch; retried next run.
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

-- 3. Trigger: deduct the box the moment an order becomes shipped.
CREATE OR REPLACE FUNCTION public.trg_apply_box_on_shipped()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  BEGIN
    PERFORM public._apply_box_for_shipped_order(NEW.id);
  EXCEPTION WHEN OTHERS THEN
    -- Never block webhook/reconcile ingestion over a box deduction;
    -- box_applied_at stays NULL so the nightly sweep retries.
    NULL;
  END;
  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS apply_box_on_shipped ON public.shipstation_orders;
CREATE TRIGGER apply_box_on_shipped
AFTER INSERT OR UPDATE OF order_status ON public.shipstation_orders
FOR EACH ROW
WHEN (NEW.order_status = 'shipped' AND NEW.box_applied_at IS NULL)
EXECUTE FUNCTION public.trg_apply_box_on_shipped();

-- 4. Intraday ShipStation sync — every 30 minutes. Same body as the
--    nightly job (rolling 24h window, fully idempotent). Nightly job and
--    the 03:35 box sweep stay as catch-alls.
DO $$
BEGIN
  PERFORM cron.unschedule('shipstation-reconcile-intraday');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule(
  'shipstation-reconcile-intraday',
  '*/30 * * * *',
  $$
    SELECT net.http_post(
      url := 'https://pnqujtugddxusllkikje.supabase.co/functions/v1/shipstation-reconcile',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_jwt'),
        'Content-Type', 'application/json'
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 600000
    );
  $$
);
