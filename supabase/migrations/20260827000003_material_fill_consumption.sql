-- =============================================================
-- Recipe-driven material consumption on fill tasks ("Phase 6")
-- =============================================================
-- sku_material_consumption was created 2026-05-26 with its deduction
-- engine deferred; until now nothing read it — glycerin recipes were
-- write-only. Warehouse glycerin is consumed when the crew fills+caps
-- raw units, so the engine hooks task_logs:
--
--   filling_capping task for SKU S → for every recipe row (S, M):
--     ledger  : material_transactions -(units × quantity_per_unit)
--               (type 'task_consumption', reference the task_log)
--     balance : material_inventory_levels floored at 0 — the ledger
--               records true consumption, but a crew task submission
--               must never fail on chk_material_inv_nonneg; a floored
--               balance means "cycle count me".
--
-- emptying / rtsing / prefilled_rtsing / breakage don't consume
-- warehouse materials (factory-prefilled units used factory glycerin).
--
-- Backfill (owner decision 2026-08-27): replay fills logged after each
-- material's last cycle count (glycerin: 2026-05-27), backdating the
-- ledger rows to the task dates so usage-rate math sees real history.
-- Idempotent via the task_log reference.

-- ---- 1. Trigger --------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_consume_materials_on_fill()
RETURNS trigger
-- SECURITY DEFINER: crew accounts insert task_logs but have no write
-- access to the materials tables.
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  r     record;
  v_qty numeric;
BEGIN
  IF NEW.task_type <> 'filling_capping' THEN RETURN NEW; END IF;
  FOR r IN
    SELECT smc.material_id, smc.quantity_per_unit
    FROM sku_material_consumption smc
    WHERE smc.sku_id = NEW.sku_id
  LOOP
    v_qty := round(NEW.quantity_processed * r.quantity_per_unit, 4);
    IF v_qty <= 0 THEN CONTINUE; END IF;
    INSERT INTO material_transactions
      (material_id, transaction_type, quantity_change, reference_type, reference_id, notes, performed_by)
    VALUES
      (r.material_id, 'task_consumption', -v_qty, 'task_log', NEW.id,
       format('%s units filled', NEW.quantity_processed), NEW.employee_id);
    UPDATE material_inventory_levels
       SET on_hand_qty = GREATEST(on_hand_qty - v_qty, 0), updated_at = now()
     WHERE material_id = r.material_id;
    IF NOT FOUND THEN
      INSERT INTO material_inventory_levels (material_id, on_hand_qty)
      VALUES (r.material_id, 0);
    END IF;
  END LOOP;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_consume_materials_on_fill ON public.task_logs;
CREATE TRIGGER trg_consume_materials_on_fill
AFTER INSERT ON public.task_logs
FOR EACH ROW EXECUTE FUNCTION public.fn_consume_materials_on_fill();

-- ---- 2. Usage-rate RPC learns the new consumption type -----------------

CREATE OR REPLACE FUNCTION public.rpc_material_usage_rates(p_days integer DEFAULT 30)
 RETURNS TABLE(
   material_id uuid,
   units_consumed numeric,
   daily_usage numeric,
   data_points integer
 )
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH params AS (
    SELECT GREATEST(LEAST(COALESCE(p_days, 30), 365), 1) AS n
  ),
  consumption AS (
    SELECT
      mt.material_id,
      SUM(-mt.quantity_change) AS units,
      COUNT(*)                 AS pts,
      MIN(mt.created_at)       AS first_at
    FROM public.material_transactions mt
    CROSS JOIN params
    WHERE mt.transaction_type IN ('shipstation_box', 'task_consumption')
      AND mt.quantity_change < 0
      AND mt.created_at >= now() - make_interval(days => (SELECT n FROM params))
    GROUP BY mt.material_id
  )
  SELECT
    c.material_id,
    c.units AS units_consumed,
    ROUND(
      c.units / GREATEST(
        1,
        LEAST(
          (SELECT n FROM params),
          CEIL(EXTRACT(EPOCH FROM (now() - c.first_at)) / 86400.0)::int
        )
      )::numeric,
      4
    ) AS daily_usage,
    c.pts::int AS data_points
  FROM consumption c
  WHERE c.units > 0;
$function$;

-- ---- 3. Backfill: fills since each material's last cycle count ---------

WITH fills AS (
  SELECT tl.id, tl.quantity_processed, tl.created_at,
         smc.material_id,
         round(tl.quantity_processed * smc.quantity_per_unit, 4) AS qty
  FROM task_logs tl
  JOIN sku_material_consumption smc ON smc.sku_id = tl.sku_id
  JOIN material_inventory_levels mil ON mil.material_id = smc.material_id
  WHERE tl.task_type = 'filling_capping'
    AND mil.last_counted_at IS NOT NULL
    AND tl.created_at > mil.last_counted_at
),
ins AS (
  INSERT INTO material_transactions
    (material_id, transaction_type, quantity_change, reference_type, reference_id, notes, performed_by, created_at)
  SELECT f.material_id, 'task_consumption', -f.qty, 'task_log', f.id,
         format('Backfilled 2026-08-27: %s units filled %s', f.quantity_processed, to_char(f.created_at, 'YYYY-MM-DD')),
         '00000000-0000-0000-0000-000000000001'::uuid,
         f.created_at
  FROM fills f
  WHERE f.qty > 0
    AND NOT EXISTS (
      SELECT 1 FROM material_transactions mt
      WHERE mt.reference_type = 'task_log' AND mt.reference_id = f.id AND mt.material_id = f.material_id
    )
  RETURNING material_id, quantity_change
)
UPDATE material_inventory_levels mil
   SET on_hand_qty = GREATEST(mil.on_hand_qty + agg.delta, 0), updated_at = now()
  FROM (SELECT material_id, SUM(quantity_change) AS delta FROM ins GROUP BY material_id) agg
 WHERE mil.material_id = agg.material_id;
