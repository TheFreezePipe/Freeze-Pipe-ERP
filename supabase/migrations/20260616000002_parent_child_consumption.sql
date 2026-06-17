-- =============================================================
-- Migration: parent->child component consumption coupling
-- =============================================================
-- For assembled goods (product_boms: a finished bong = a body + a coil,
-- "produced" at Nancy), the coil is ordered as a linked CHILD factory
-- order. When the PARENT (finished good) ships, the coils it consumed
-- should drop off the child's on-order — previously done by hand
-- (e.g. BW21-Revolver manually set to 24 to match 24 BW63 shipped).
--
-- This automates it for exactly the BoM items:
--   * new column factory_order_items.quantity_consumed_by_parent — units
--     of this component absorbed by shipped parents. Auto-maintained;
--     separate from quantity_shipped_manual so the two never stack.
--   * consumed(child line) = LEAST(ordered,
--       Σ over parent lines whose SKU has a BoM for this component of
--         units_per_parent × (freight_shipped + manual_shipped))
--   * recomputed when parent freight changes, when parent manual-shipped
--     changes (progress RPC), and when a parent/child link changes.
--   * on-order nets it out (client-side, inventory-aggregates).
--   * the progress RPC blocks manual edits on auto-managed component
--     lines so consumption is the single source of truth there.
-- Scope is naturally limited to BoM items: non-component lines compute 0.
-- =============================================================

ALTER TABLE public.factory_order_items
  ADD COLUMN IF NOT EXISTS quantity_consumed_by_parent integer NOT NULL DEFAULT 0;

ALTER TABLE public.factory_order_items
  DROP CONSTRAINT IF EXISTS chk_foi_consumed_nonneg;
ALTER TABLE public.factory_order_items
  ADD CONSTRAINT chk_foi_consumed_nonneg CHECK (quantity_consumed_by_parent >= 0);

-- Fully-shipped now counts consumed-by-parent: a component order is done
-- when its units have been freight-shipped, manually-shipped, broken, OR
-- consumed into shipped parents.
CREATE OR REPLACE FUNCTION public._factory_order_fully_shipped(p_order_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $fos$
  SELECT EXISTS (SELECT 1 FROM factory_order_items WHERE factory_order_id = p_order_id)
     AND NOT EXISTS (
       SELECT 1 FROM factory_order_items foi
        WHERE foi.factory_order_id = p_order_id
          AND (
            COALESCE((SELECT SUM(fl.quantity) FROM freight_line_items fl
                       WHERE fl.source_factory_order_item_id = foi.id), 0)
            + foi.quantity_shipped_manual
            + foi.quantity_consumed_by_parent
            + foi.quantity_breakage
          ) < foi.quantity_ordered
     );
$fos$;

-- Recompute consumed-by-parent for every component line on children linked
-- to p_parent_order_id. Non-component lines resolve to 0.
CREATE OR REPLACE FUNCTION public._recompute_consumption_for_parent(p_parent_order_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_child uuid;
BEGIN
  UPDATE public.factory_order_items child
     SET quantity_consumed_by_parent = LEAST(
       child.quantity_ordered,
       COALESCE((
         SELECT SUM(
           b.units_per_parent * (
             COALESCE((SELECT SUM(fl.quantity) FROM public.freight_line_items fl
                        WHERE fl.source_factory_order_item_id = pl.id), 0)
             + pl.quantity_shipped_manual
           )
         )
         FROM public.product_boms b
         JOIN public.factory_order_items pl
           ON pl.factory_order_id = p_parent_order_id AND pl.sku_id = b.parent_sku_id
         WHERE b.component_sku_id = child.sku_id
       ), 0)
     )
   FROM public.factory_orders co
  WHERE child.factory_order_id = co.id
    AND co.parent_factory_order_id = p_parent_order_id
    AND child.quantity_consumed_by_parent IS DISTINCT FROM LEAST(
       child.quantity_ordered,
       COALESCE((
         SELECT SUM(
           b.units_per_parent * (
             COALESCE((SELECT SUM(fl.quantity) FROM public.freight_line_items fl
                        WHERE fl.source_factory_order_item_id = pl.id), 0)
             + pl.quantity_shipped_manual
           )
         )
         FROM public.product_boms b
         JOIN public.factory_order_items pl
           ON pl.factory_order_id = p_parent_order_id AND pl.sku_id = b.parent_sku_id
         WHERE b.component_sku_id = child.sku_id
       ), 0)
     );

  -- A child whose components are now fully consumed may itself complete.
  FOR v_child IN
    SELECT id FROM public.factory_orders WHERE parent_factory_order_id = p_parent_order_id
  LOOP
    BEGIN
      PERFORM public._recompute_factory_order_status(v_child, '00000000-0000-0000-0000-000000000001'::uuid);
    EXCEPTION WHEN OTHERS THEN NULL; END;
  END LOOP;
END;
$function$;

-- Extend the freight trigger: after recomputing the affected order's own
-- completion, also recompute consumption for it AS A PARENT (no-op if it
-- has no linked children).
CREATE OR REPLACE FUNCTION public.trg_freight_line_recompute_fo()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_new_order uuid;
  v_old_order uuid;
BEGIN
  IF TG_OP <> 'DELETE' AND NEW.source_factory_order_item_id IS NOT NULL THEN
    SELECT factory_order_id INTO v_new_order FROM factory_order_items WHERE id = NEW.source_factory_order_item_id;
  END IF;
  IF TG_OP <> 'INSERT' AND OLD.source_factory_order_item_id IS NOT NULL THEN
    SELECT factory_order_id INTO v_old_order FROM factory_order_items WHERE id = OLD.source_factory_order_item_id;
  END IF;

  IF v_new_order IS NOT NULL THEN
    BEGIN PERFORM public._recompute_factory_order_status(v_new_order, '00000000-0000-0000-0000-000000000001'::uuid);
    EXCEPTION WHEN OTHERS THEN NULL; END;
    BEGIN PERFORM public._recompute_consumption_for_parent(v_new_order);
    EXCEPTION WHEN OTHERS THEN NULL; END;
  END IF;
  IF v_old_order IS NOT NULL AND v_old_order IS DISTINCT FROM v_new_order THEN
    BEGIN PERFORM public._recompute_factory_order_status(v_old_order, '00000000-0000-0000-0000-000000000001'::uuid);
    EXCEPTION WHEN OTHERS THEN NULL; END;
    BEGIN PERFORM public._recompute_consumption_for_parent(v_old_order);
    EXCEPTION WHEN OTHERS THEN NULL; END;
  END IF;
  RETURN NULL;
END;
$function$;

-- Recompute consumption when a parent/child link is created or removed.
CREATE OR REPLACE FUNCTION public.trg_factory_order_link_consumption()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.parent_factory_order_id IS NOT NULL THEN
    PERFORM public._recompute_consumption_for_parent(NEW.parent_factory_order_id);
  END IF;
  IF OLD.parent_factory_order_id IS NOT NULL
     AND OLD.parent_factory_order_id IS DISTINCT FROM NEW.parent_factory_order_id THEN
    -- Unlinked from old parent: this order's components are no longer consumed.
    UPDATE public.factory_order_items
       SET quantity_consumed_by_parent = 0
     WHERE factory_order_id = NEW.id AND quantity_consumed_by_parent <> 0;
  END IF;
  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS factory_order_link_consumption ON public.factory_orders;
CREATE TRIGGER factory_order_link_consumption
AFTER UPDATE OF parent_factory_order_id ON public.factory_orders
FOR EACH ROW EXECUTE FUNCTION public.trg_factory_order_link_consumption();

-- Progress RPC: recompute consumption after parent edits, and block manual
-- edits on auto-managed component lines (consumption owns those).
CREATE OR REPLACE FUNCTION public.rpc_admin_set_factory_order_progress(
  p_order_id uuid,
  p_expected_version integer,
  p_line_ops jsonb
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor        uuid := auth.uid();
  v_role         text;
  v_order        factory_orders%ROWTYPE;
  v_op           jsonb;
  v_line         factory_order_items%ROWTYPE;
  v_line_id      uuid;
  v_freight      int;
  v_new_finished int;
  v_new_manual   int;
  v_new_version  int;
  v_new_status   text;
BEGIN
  SELECT role INTO v_role FROM profiles WHERE id = v_actor;
  IF v_role IS NULL OR v_role NOT IN ('admin', 'manager') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'admin or manager role required');
  END IF;

  SELECT * INTO v_order FROM factory_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'order not found');
  END IF;
  IF v_order.row_version <> p_expected_version THEN
    RETURN jsonb_build_object('ok', false, 'error', 'version_conflict', 'current_version', v_order.row_version);
  END IF;
  IF v_order.status = 'canceled' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'cannot edit progress on a canceled order');
  END IF;

  FOR v_op IN SELECT * FROM jsonb_array_elements(COALESCE(p_line_ops, '[]'::jsonb))
  LOOP
    v_line_id := (v_op ->> 'line_id')::uuid;
    SELECT * INTO v_line FROM factory_order_items
     WHERE id = v_line_id AND factory_order_id = p_order_id;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'error', format('line %s is not on this order', v_line_id));
    END IF;

    v_new_finished := CASE WHEN v_op ? 'quantity_finished'
                           THEN (v_op ->> 'quantity_finished')::int
                           ELSE v_line.quantity_finished END;
    v_new_manual   := CASE WHEN v_op ? 'quantity_shipped_manual'
                           THEN (v_op ->> 'quantity_shipped_manual')::int
                           ELSE v_line.quantity_shipped_manual END;

    IF v_new_finished < 0 OR v_new_finished > v_line.quantity_ordered THEN
      RETURN jsonb_build_object('ok', false, 'error',
        format('finished must be between 0 and %s', v_line.quantity_ordered));
    END IF;
    IF v_new_manual < 0 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'manually-shipped cannot be negative');
    END IF;

    -- Block manual-shipped edits on auto-managed component lines (a child
    -- line whose SKU is a BoM component of a line on its linked parent).
    IF v_op ? 'quantity_shipped_manual' AND v_new_manual <> v_line.quantity_shipped_manual THEN
      IF EXISTS (
        SELECT 1
          FROM factory_orders co
          JOIN product_boms b ON b.component_sku_id = v_line.sku_id
          JOIN factory_order_items pl
            ON pl.factory_order_id = co.parent_factory_order_id AND pl.sku_id = b.parent_sku_id
         WHERE co.id = p_order_id AND co.parent_factory_order_id IS NOT NULL
      ) THEN
        RETURN jsonb_build_object('ok', false, 'error',
          format('%s is a component auto-managed by its parent order; its shipped count follows parent shipments', v_line.sku_id));
      END IF;
    END IF;

    v_freight := COALESCE((SELECT SUM(fl.quantity) FROM freight_line_items fl
                            WHERE fl.source_factory_order_item_id = v_line.id), 0);
    IF v_freight + v_new_manual > v_line.quantity_ordered THEN
      RETURN jsonb_build_object('ok', false, 'error',
        format('freight-shipped (%s) + manual (%s) exceeds ordered (%s)',
               v_freight, v_new_manual, v_line.quantity_ordered));
    END IF;

    UPDATE factory_order_items
       SET quantity_finished = v_new_finished,
           quantity_shipped_manual = v_new_manual
     WHERE id = v_line_id;
  END LOOP;

  -- If this order is a parent, its (possibly new) manual shipments may
  -- change what its children have consumed.
  PERFORM public._recompute_consumption_for_parent(p_order_id);

  -- May flip THIS order to 'shipped' (its own coverage).
  PERFORM public._recompute_factory_order_status(p_order_id, v_actor);

  UPDATE factory_orders SET updated_at = now() WHERE id = p_order_id;

  INSERT INTO audit_logs (actor_id, action, target_table, target_id, details)
  VALUES (v_actor, 'factory_order.admin_progress', 'factory_orders', p_order_id,
          jsonb_build_object('line_ops', p_line_ops));

  SELECT row_version, status INTO v_new_version, v_new_status
    FROM factory_orders WHERE id = p_order_id;
  RETURN jsonb_build_object('ok', true, 'new_version', v_new_version, 'status', v_new_status);
END;
$function$;

-- Backfill: the old manual workaround on BoM-component child lines moves to
-- the new auto-consumed dimension. First recompute consumption for every
-- linked parent, then zero the manual on component lines so the two don't
-- stack (e.g. BW21-Revolver: manual 24 -> consumed 24, manual reset to 0).
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT DISTINCT parent_factory_order_id AS pid
             FROM factory_orders WHERE parent_factory_order_id IS NOT NULL
  LOOP
    PERFORM public._recompute_consumption_for_parent(r.pid);
  END LOOP;

  UPDATE factory_order_items child
     SET quantity_shipped_manual = 0
   FROM factory_orders co
  WHERE child.factory_order_id = co.id
    AND co.parent_factory_order_id IS NOT NULL
    AND child.quantity_shipped_manual > 0
    AND EXISTS (
      SELECT 1 FROM product_boms b
      JOIN factory_order_items pl
        ON pl.factory_order_id = co.parent_factory_order_id AND pl.sku_id = b.parent_sku_id
      WHERE b.component_sku_id = child.sku_id
    );
END $$;
