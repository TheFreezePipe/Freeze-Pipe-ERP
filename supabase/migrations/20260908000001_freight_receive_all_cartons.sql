-- =============================================================
-- Freight: receive-all keeps carton plans consistent + repair history
-- =============================================================
-- Finding 2026-09-08: every receipt since go-live (55 across 27 shipments)
-- was a unit posting from the Shipments-list "Receive all remaining"
-- button (rpc_apply_freight_delivery), never a carton tap — including 5 sea
-- and 7 air shipments that had carton plans, which now read 0 cartons
-- received despite being fully received. The list button no longer offers
-- receive-all for carton-planned shipments (it routes to carton check-in);
-- this migration makes the RPC square the carton counters whenever it does
-- run, and repairs the 12 already-confirmed shipments.

CREATE OR REPLACE FUNCTION public.rpc_apply_freight_delivery(p_shipment_id uuid, p_actor_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_shipment freight_shipments%ROWTYPE;
  v_entries jsonb;
  v_result jsonb;
  v_lines int;
  v_non_catalog int;
BEGIN
  SELECT * INTO v_shipment FROM freight_shipments WHERE id = p_shipment_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'shipment not found');
  END IF;
  IF v_shipment.receipt_confirmed_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'already_confirmed', true,
                              'confirmed_at', v_shipment.receipt_confirmed_at);
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('line_item_id', id, 'units', quantity - quantity_received)), '[]'::jsonb),
         count(*)
    INTO v_entries, v_lines
    FROM freight_line_items
   WHERE freight_shipment_id = p_shipment_id AND sku_id IS NOT NULL
     AND quantity_received < quantity;

  SELECT count(*) INTO v_non_catalog
    FROM freight_line_items
   WHERE freight_shipment_id = p_shipment_id AND sku_id IS NULL;

  IF v_lines = 0 THEN
    -- nothing left to credit; just stamp confirmation (and square the carton plan)
    UPDATE freight_carton_groups
       SET received_cartons = carton_qty, updated_at = now()
     WHERE freight_shipment_id = p_shipment_id AND received_cartons < carton_qty;
    UPDATE freight_shipments
       SET status = 'delivered',
           actual_arrival_date = COALESCE(actual_arrival_date, CURRENT_DATE),
           receipt_confirmed_at = now(), receipt_confirmed_by = p_actor_id
     WHERE id = p_shipment_id;
    RETURN jsonb_build_object('ok', true, 'line_items_processed', 0,
                              'non_catalog_skipped', v_non_catalog, 'confirmed_at', now());
  END IF;

  v_result := rpc_record_freight_receipt(p_shipment_id, v_entries, p_actor_id);
  IF NOT COALESCE((v_result->>'ok')::boolean, false) THEN
    RETURN v_result;
  END IF;
  -- Receive-all credits by line; keep the carton plan consistent so
  -- carton counts never read 0 on a fully received shipment.
  UPDATE freight_carton_groups
     SET received_cartons = carton_qty, updated_at = now()
   WHERE freight_shipment_id = p_shipment_id AND received_cartons < carton_qty;
  RETURN jsonb_build_object('ok', true, 'line_items_processed', v_lines,
                            'non_catalog_skipped', v_non_catalog, 'confirmed_at', now());
END;
$function$;

-- Repair: confirmed shipments whose lines are fully received but whose
-- carton plan still reads 0 — the receipts happened through receive-all.
UPDATE freight_carton_groups g
   SET received_cartons = g.carton_qty, updated_at = now()
  FROM freight_shipments fs
 WHERE fs.id = g.freight_shipment_id
   AND fs.receipt_confirmed_at IS NOT NULL
   AND g.received_cartons < g.carton_qty
   AND NOT EXISTS (
     SELECT 1 FROM freight_line_items li
      WHERE li.freight_shipment_id = fs.id AND li.sku_id IS NOT NULL
        AND li.quantity_received < li.quantity
   );
