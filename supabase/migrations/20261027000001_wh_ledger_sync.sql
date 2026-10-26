-- =============================================================
-- Migration: Warehouse ledger sync — ledger mirror, ship settlement,
--            explicit postings flag (Phase 1, slice 4E)
-- =============================================================
-- Design: docs/design/WAREHOUSE_MODULE_PHASE0_1.md §1 (Sales, Ledger),
-- §4.3 (wh_order_settlements), §5.6 (mirror, ship settlement, explicit
-- postings), §5.7 (the line draws from cartons taken to it), §11
-- (live_since).
--
-- Finding: the physical layer (wh_inventory_balances) only moves when a
-- warehouse RPC moves it. Stock Levels cycle counts, Workspace task logs,
-- receipts written outside the LPN path and ShipStation sales change
-- inventory_levels through the ledger and nothing physical follows, so the
-- nightly identity (§6) would break on every one of them.
-- Decision (all dormant until wh_settings.physical_layer.live_since is set
-- and has passed; rollback is clearing it):
--   * Ledger mirror: AFTER INSERT trigger wh_ledger_mirror on
--     inventory_transactions for cycle_count, task_logged,
--     freight_delivered and order_shipped rows, skipped while the
--     transaction-local flag wh.mirror_skip is 'on' and for rows whose
--     created_at is before live_since. It never fails the ledger insert:
--     an error is written to audit_logs as action 'wh.mirror_failed'
--     (target inventory_transactions/<row id>) and swallowed, the rule
--     trg_apply_box_on_shipped follows. Every mirror movement carries
--     ledger_tx_id = the ledger row, so a row is mirrored at most once.
--       - task_logged category moves (emptying raw→in_production, rtsing
--         in_production→finished, prefilled_rtsing prefilled_raw→finished)
--         post `bucket_convert` at MFG-LINE: first from the balances of
--         cartons currently at MFG-LINE in the source bucket, oldest
--         arrival at the line first, then from loose units there (which
--         may go negative: the cue that cartons were not scanned to the
--         line); the target bucket is credited loose at MFG-LINE. RTS
--         output therefore lands as loose finished units at the line for
--         rpc_wh_rts_relabel to box. filling_capping is a metadata row
--         (no bucket change) and posts nothing.
--       - task_logged breakage (movement_kind write_off) posts a
--         `write_off` of the units at UNLOCATED.
--       - cycle_count (Stock Levels) posts `ledger_mirror` at UNLOCATED,
--         in for a positive delta, out for a negative one.
--       - freight_delivered written by any path that did not set the flag
--         (minting off) posts `ledger_mirror` loose at IN-01 and keeps the
--         shipment's one open loose putaway task per SKU and bucket, as
--         the unit-mode receipt does; a negative row takes the units back
--         from IN-01 and whatever IN-01 no longer holds from UNLOCATED.
--       - order_shipped for an order already admitted to ship settlement
--         (below) and shipped settles it (the webhook writes the order
--         before calling the sale RPC).
--   * Ship settlement: _wh_settle_order(order) is ledger-derived like
--     rpc_apply_shipstation_sale. Per SKU, target = the order's net
--     order_shipped + shipstation_ledger_rebase units when the order is
--     shipped, else 0; settled = its net `ship_settle` movements; the
--     difference moves. Sources, finished bucket only: Phase 2 tote
--     contents (none yet); open cartons and loose units on active pickable
--     locations by pick_sequence; then sealed cartons there (the draw
--     opens them). Overflow and non-pickable locations are never drawn
--     (pickable excludes overflow by CHECK). A shortfall is posted at
--     UNLOCATED as a negative and opens a `reconcile` count on the SKU's
--     first pickable location. A target below what was settled (a line
--     reduced after shipping, or a label void back to awaiting_shipment)
--     returns the units to UNLOCATED. Cancelled orders are skipped:
--     cancellations stay deferred, no credit. One wh_order_settlements row
--     per order (method ship_settle, settled_units = net units settled,
--     shortfall_units cumulative, settled_at, last_error).
--   * Admission (proposed reading of "orders shipped at or after
--     live_since"): an order enters settlement when the trigger
--     wh_settle_on_shipped sees it BECOME shipped (an INSERT as shipped, or
--     an UPDATE from another status) while live, with a ship_date on or
--     after live_since's UTC day; that call creates its settlement row even
--     when nothing is owed yet. The mirror and the nightly sweep only touch
--     admitted orders, plus (sweep) shipped orders with no row whose
--     ship_date is after the go-live day (a missed trigger). An order that
--     shipped before go-live never settles: the go-live count already saw
--     its units leave. Re-ingesting an already-shipped order is not a
--     transition and admits nothing.
--   * _wh_settle_order_safe wraps a settlement for the trigger, the mirror
--     and the sweep: an error is stored in last_error and never fails the
--     caller; the nightly sweep retries it.
--   * Explicit postings (§5.6 part 3): count approvals, write-offs and
--     bucket locks write wh_count_adjust / wh_write_off / wh_bucket_move,
--     types the mirror never handles, so they cannot double post. Read
--     2026-10-26: _wh_ledger_post did not set wh.mirror_skip. It is
--     re-issued with the same body plus the flag set around each ledger
--     insert and restored after it, so the guarantee does not rest on the
--     type list alone. The LPN receipt (20261023000001) already sets it.
--   * rpc_wh_set_setting already accepts physical_layer.live_since as an
--     ISO timestamp or null (20261022000003, smoke below); unchanged.
--
-- Smoke after deploy (a validation envelope passes; a relation error fails):
--   SELECT public._wh_live_since();                                            -- null on staging (dormant)
--   SELECT public._wh_field_bucket('warehouse_prefilled_raw');                 -- prefilled_raw
--   SELECT public._wh_settle_order(gen_random_uuid());                         -- {ok:false, error:'order_not_found'}
--   SELECT public._wh_settle_order_safe(gen_random_uuid());                    -- {ok:false, error:'order_not_found'}
--   SELECT count(*) FROM public._wh_settlement_pairs();                        -- 0
--   SELECT public._wh_mirror_ledger_row(NULL::public.inventory_transactions);  -- {mirrored:false, reason:'no_sku'}
--   SELECT public._wh_open_count(gen_random_uuid(), 'reconcile', NULL, 'smoke', NULL, NULL, NULL);  -- {ok:false, error:'location_not_found'}
--   SELECT public.rpc_wh_set_setting('physical_layer', '{"live_since":"not a date"}'::jsonb);  -- {ok:false, error:'invalid_value'}
--   SELECT string_agg(tgname, ',' ORDER BY tgname) FROM pg_trigger WHERE tgname IN ('wh_ledger_mirror', 'wh_settle_on_shipped');  -- both
-- =============================================================

BEGIN;

-- -------------------------------------------------------------
-- A. Index: a mirrored ledger row is found by its ledger_tx_id
-- -------------------------------------------------------------
CREATE INDEX IF NOT EXISTS wh_movements_ledger_tx_idx
  ON public.wh_inventory_movements (ledger_tx_id) WHERE ledger_tx_id IS NOT NULL;

-- -------------------------------------------------------------
-- B. Small helpers (not executable by clients)
-- -------------------------------------------------------------
-- live_since as a timestamp; null while the physical layer is dormant.
CREATE OR REPLACE FUNCTION public._wh_live_since()
RETURNS timestamptz
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT (s.value->>'live_since')::timestamptz
    FROM public.wh_settings s
   WHERE s.key = 'physical_layer' AND jsonb_typeof(s.value->'live_since') = 'string';
$$;

-- 'warehouse_finished' → 'finished'; null for anything that is not a stock bucket.
CREATE OR REPLACE FUNCTION public._wh_field_bucket(p_field text)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE WHEN p_field IN ('warehouse_raw', 'warehouse_prefilled_raw', 'warehouse_in_production',
                               'warehouse_finished', 'warehouse_other')
              THEN substr(p_field, 11) END;
$$;

-- Open a count task on a location unless one is already open or counting
-- there (the partial unique index allows one). Returns {ok, id, created}.
CREATE OR REPLACE FUNCTION public._wh_open_count(
  p_location_id uuid, p_kind text, p_sku_id uuid, p_reason text,
  p_source_type text, p_source_id uuid, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.wh_locations WHERE id = p_location_id) THEN
    RETURN public._wh_err('location_not_found', 'That location does not exist.');
  END IF;
  SELECT id INTO v_id FROM public.wh_count_tasks
   WHERE location_id = p_location_id AND status IN ('open', 'counting')
   LIMIT 1;
  IF v_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'id', v_id, 'created', false);
  END IF;
  INSERT INTO public.wh_count_tasks (kind, status, location_id, sku_id, reason, due_date, source_type, source_id, created_by)
  VALUES (p_kind, 'open', p_location_id, p_sku_id, left(p_reason, 500), current_date, p_source_type, p_source_id,
          COALESCE(p_actor, '00000000-0000-0000-0000-000000000001'::uuid))
  ON CONFLICT (location_id) WHERE status IN ('open', 'counting') DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    SELECT id INTO v_id FROM public.wh_count_tasks
     WHERE location_id = p_location_id AND status IN ('open', 'counting')
     LIMIT 1;
    RETURN jsonb_build_object('ok', true, 'id', v_id, 'created', false);
  END IF;
  RETURN jsonb_build_object('ok', true, 'id', v_id, 'created', true);
END;
$$;

-- -------------------------------------------------------------
-- C. _wh_ledger_post re-issued: the 20261022000004 body, plus
--    wh.mirror_skip 'on' around each ledger insert (restored after)
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._wh_ledger_post(
  p_sku uuid, p_type text, p_bucket text, p_to_bucket text, p_qty integer,
  p_ref_type text, p_ref_id uuid, p_actor uuid, p_note text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_field text := 'warehouse_' || p_bucket;
  v_to    text := CASE WHEN p_to_bucket IS NOT NULL THEN 'warehouse_' || p_to_bucket END;
  v_sku   text;
  v_cur   integer;
  v_qty   integer := p_qty;
  v_tx    uuid;
  v_skip  text := current_setting('wh.mirror_skip', true);
BEGIN
  IF p_type NOT IN ('wh_count_adjust', 'wh_write_off', 'wh_bucket_move') THEN
    RAISE EXCEPTION '_wh_ledger_post: unknown type %', p_type;
  END IF;
  IF p_bucket NOT IN ('raw', 'prefilled_raw', 'in_production', 'finished', 'other') THEN
    RAISE EXCEPTION '_wh_ledger_post: unknown bucket %', p_bucket;
  END IF;
  SELECT sku INTO v_sku FROM public.product_skus WHERE id = p_sku;

  PERFORM 1 FROM public.inventory_levels WHERE sku_id = p_sku FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO public.inventory_levels (sku_id, location_id) VALUES (p_sku, public._default_location_id())
    ON CONFLICT DO NOTHING;
    PERFORM 1 FROM public.inventory_levels WHERE sku_id = p_sku FOR UPDATE;
  END IF;
  EXECUTE format('SELECT COALESCE(%I, 0) FROM public.inventory_levels WHERE sku_id = $1', v_field) INTO v_cur USING p_sku;

  IF p_type = 'wh_count_adjust' THEN
    IF v_field <> 'warehouse_finished' AND v_cur + v_qty < 0 THEN
      v_qty := -v_cur;
    END IF;
    IF v_qty = 0 THEN
      RETURN jsonb_build_object('tx_id', NULL, 'delta', 0, 'requested', p_qty, 'clamped', p_qty <> 0);
    END IF;
    EXECUTE format('UPDATE public.inventory_levels SET %I = COALESCE(%I, 0) + $1 WHERE sku_id = $2', v_field, v_field)
      USING v_qty, p_sku;
    PERFORM set_config('wh.mirror_skip', 'on', true);
    INSERT INTO public.inventory_transactions (sku_id, transaction_type, quantity, field_affected, movement_kind,
                                               reference_id, reference_type, notes, performed_by)
    VALUES (p_sku, p_type, v_qty, v_field, 'net_change', p_ref_id, p_ref_type,
            format('%s: %s%s on %s (%s)', v_sku, CASE WHEN v_qty > 0 THEN '+' ELSE '' END, v_qty, v_field, COALESCE(p_note, 'warehouse count')),
            p_actor)
    RETURNING id INTO v_tx;
    PERFORM set_config('wh.mirror_skip', COALESCE(v_skip, ''), true);
    RETURN jsonb_build_object('tx_id', v_tx, 'delta', v_qty, 'requested', p_qty, 'clamped', v_qty <> p_qty);

  ELSIF p_type = 'wh_write_off' THEN
    IF p_qty IS NULL OR p_qty <= 0 THEN
      RAISE EXCEPTION '_wh_ledger_post: write-off quantity must be positive';
    END IF;
    IF v_field <> 'warehouse_finished' THEN
      v_qty := LEAST(p_qty, GREATEST(v_cur, 0));
    END IF;
    IF v_qty = 0 THEN
      RETURN jsonb_build_object('tx_id', NULL, 'delta', 0, 'requested', -p_qty, 'clamped', true);
    END IF;
    EXECUTE format('UPDATE public.inventory_levels SET %I = COALESCE(%I, 0) - $1 WHERE sku_id = $2', v_field, v_field)
      USING v_qty, p_sku;
    PERFORM set_config('wh.mirror_skip', 'on', true);
    INSERT INTO public.inventory_transactions (sku_id, transaction_type, quantity, field_affected, movement_kind,
                                               from_field, to_field, reference_id, reference_type, notes, performed_by)
    VALUES (p_sku, p_type, v_qty, v_field, 'write_off', v_field, NULL, p_ref_id, p_ref_type,
            format('%s: write-off of %s units from %s (%s)', v_sku, v_qty, v_field, COALESCE(p_note, 'warehouse write-off')),
            p_actor)
    RETURNING id INTO v_tx;
    PERFORM set_config('wh.mirror_skip', COALESCE(v_skip, ''), true);
    RETURN jsonb_build_object('tx_id', v_tx, 'delta', -v_qty, 'requested', -p_qty, 'clamped', v_qty <> p_qty);

  ELSE
    IF p_qty IS NULL OR p_qty <= 0 OR v_to IS NULL OR v_to = v_field THEN
      RAISE EXCEPTION '_wh_ledger_post: a bucket move needs a positive quantity and two different buckets';
    END IF;
    IF v_field <> 'warehouse_finished' THEN
      v_qty := LEAST(p_qty, GREATEST(v_cur, 0));
    END IF;
    IF v_qty = 0 THEN
      RETURN jsonb_build_object('tx_id', NULL, 'delta', 0, 'moved', 0, 'requested', p_qty, 'clamped', true);
    END IF;
    EXECUTE format('UPDATE public.inventory_levels SET %I = COALESCE(%I, 0) - $1, %I = COALESCE(%I, 0) + $1 WHERE sku_id = $2',
                   v_field, v_field, v_to, v_to)
      USING v_qty, p_sku;
    PERFORM set_config('wh.mirror_skip', 'on', true);
    INSERT INTO public.inventory_transactions (sku_id, transaction_type, quantity, field_affected, movement_kind,
                                               from_field, to_field, reference_id, reference_type, notes, performed_by)
    VALUES (p_sku, p_type, v_qty, v_to, 'category_move', v_field, v_to, p_ref_id, p_ref_type,
            format('%s: %s units %s → %s (%s)', v_sku, v_qty, v_field, v_to, COALESCE(p_note, 'warehouse bucket lock')),
            p_actor)
    RETURNING id INTO v_tx;
    PERFORM set_config('wh.mirror_skip', COALESCE(v_skip, ''), true);
    RETURN jsonb_build_object('tx_id', v_tx, 'delta', 0, 'moved', v_qty, 'requested', p_qty, 'clamped', v_qty <> p_qty);
  END IF;
END;
$$;

-- -------------------------------------------------------------
-- D. Ship settlement (§5.6 part 2)
-- -------------------------------------------------------------
-- Per (admitted order, SKU): what the ledger says left (target) and what
-- ship_settle movements took (settled). Used by the sweep and the §6 S term.
CREATE OR REPLACE FUNCTION public._wh_settlement_pairs()
RETURNS TABLE (order_id uuid, order_status text, sku_id uuid, target integer, settled integer)
LANGUAGE sql STABLE
SET search_path = public
AS $$
  WITH adm AS (
    SELECT s.shipstation_order_id AS order_id, o.order_status
      FROM public.wh_order_settlements s
      JOIN public.shipstation_orders o ON o.id = s.shipstation_order_id
     WHERE s.method = 'ship_settle'
  ),
  led AS (
    SELECT x.reference_id AS order_id, x.sku_id, SUM(-x.quantity)::int AS net
      FROM public.inventory_transactions x
      JOIN adm a ON a.order_id = x.reference_id
     WHERE x.reference_type = 'shipstation_order' AND x.sku_id IS NOT NULL
       AND x.transaction_type IN ('order_shipped', 'shipstation_ledger_rebase')
     GROUP BY 1, 2
  ),
  setl AS (
    SELECT m.reference_id AS order_id, m.sku_id,
           SUM(CASE WHEN m.from_location_id IS NOT NULL THEN m.qty ELSE -m.qty END)::int AS settled
      FROM public.wh_inventory_movements m
      JOIN adm a ON a.order_id = m.reference_id
     WHERE m.type = 'ship_settle' AND m.reference_type = 'shipstation_order'
     GROUP BY 1, 2
  )
  SELECT a.order_id, a.order_status, k.sku_id,
         CASE WHEN a.order_status = 'shipped' THEN GREATEST(COALESCE(l.net, 0), 0) ELSE 0 END,
         COALESCE(s.settled, 0)
    FROM adm a
    JOIN (SELECT led.order_id, led.sku_id FROM led UNION SELECT setl.order_id, setl.sku_id FROM setl) k ON k.order_id = a.order_id
    LEFT JOIN led l ON l.order_id = k.order_id AND l.sku_id = k.sku_id
    LEFT JOIN setl s ON s.order_id = k.order_id AND s.sku_id = k.sku_id;
$$;

CREATE OR REPLACE FUNCTION public._wh_settle_order(p_order_id uuid, p_actor uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_order    public.shipstation_orders%ROWTYPE;
  v_row      public.wh_order_settlements%ROWTYPE;
  v_actor    uuid := COALESCE(p_actor, '00000000-0000-0000-0000-000000000001'::uuid);
  v_unloc    uuid := public._wh_loc_id('UNLOCATED');
  v_group    uuid := gen_random_uuid();
  v_pair     record;
  v_src      record;
  v_need     integer;
  v_have     integer;
  v_take     integer;
  v_drawn    integer := 0;
  v_short    integer := 0;
  v_back     integer := 0;
  v_loc      uuid;
  v_cnt      jsonb;
  v_counts   uuid[] := '{}';
  v_total    integer;
  v_note     text;
BEGIN
  -- the order-row lock serializes this with rpc_apply_shipstation_sale
  SELECT * INTO v_order FROM public.shipstation_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN public._wh_err('order_not_found', 'That ShipStation order does not exist.');
  END IF;
  SELECT * INTO v_row FROM public.wh_order_settlements WHERE shipstation_order_id = p_order_id FOR UPDATE;
  IF FOUND AND v_row.method <> 'ship_settle' THEN
    RETURN jsonb_build_object('ok', true, 'order_id', p_order_id, 'skipped', 'picked');   -- Phase 2 pick confirm owns it
  END IF;
  IF v_order.order_status = 'cancelled' THEN
    RETURN jsonb_build_object('ok', true, 'order_id', p_order_id, 'skipped', 'cancelled'); -- cancellations stay deferred
  END IF;
  IF v_unloc IS NULL THEN
    RAISE EXCEPTION 'The UNLOCATED location is missing; ship settlement cannot record a shortfall.';
  END IF;

  FOR v_pair IN
    WITH led AS (
      SELECT x.sku_id, SUM(-x.quantity)::int AS net
        FROM public.inventory_transactions x
       WHERE x.reference_type = 'shipstation_order' AND x.reference_id = p_order_id AND x.sku_id IS NOT NULL
         AND x.transaction_type IN ('order_shipped', 'shipstation_ledger_rebase')
       GROUP BY x.sku_id
    ),
    done AS (
      SELECT m.sku_id, SUM(CASE WHEN m.from_location_id IS NOT NULL THEN m.qty ELSE -m.qty END)::int AS settled
        FROM public.wh_inventory_movements m
       WHERE m.type = 'ship_settle' AND m.reference_type = 'shipstation_order' AND m.reference_id = p_order_id
       GROUP BY m.sku_id
    )
    SELECT COALESCE(l.sku_id, d.sku_id) AS sku_id, ps.sku,
           CASE WHEN v_order.order_status = 'shipped' THEN GREATEST(COALESCE(l.net, 0), 0) ELSE 0 END AS target,
           COALESCE(d.settled, 0) AS settled
      FROM led l
      FULL JOIN done d ON d.sku_id = l.sku_id
      LEFT JOIN public.product_skus ps ON ps.id = COALESCE(l.sku_id, d.sku_id)
     ORDER BY 1
  LOOP
    v_need := v_pair.target - v_pair.settled;
    CONTINUE WHEN v_need = 0;

    IF v_need < 0 THEN
      -- the order owes fewer units than were taken: they come back as unexplained stock
      PERFORM public._wh_post_movement(v_group, 'ship_settle', v_pair.sku_id, 'finished', -v_need,
                                       NULL, NULL, v_unloc, NULL, NULL, v_actor, 'shipstation_order', p_order_id,
                                       format('Order %s now owes %s fewer; returned to UNLOCATED', v_order.order_number, -v_need));
      v_back := v_back - v_need;
      CONTINUE;
    END IF;

    v_note := 'Shipped on order ' || v_order.order_number;
    -- Phase 2: tote contents first (none in Phase 1). Then open cartons and
    -- loose units on pickable locations by pick_sequence, then sealed cartons.
    FOR v_src IN
      SELECT b.id, b.location_id, b.container_id
        FROM public.wh_inventory_balances b
        JOIN public.wh_locations l ON l.id = b.location_id
        LEFT JOIN public.wh_containers c ON c.id = b.container_id
       WHERE b.sku_id = v_pair.sku_id AND b.bucket = 'finished' AND b.on_hand > 0
         AND l.active AND l.pickable AND NOT l.is_overflow
         AND (b.container_id IS NULL OR c.state IN ('open', 'sealed'))
       ORDER BY CASE WHEN b.container_id IS NULL OR c.state = 'open' THEN 0 ELSE 1 END,
                l.pick_sequence NULLS LAST, l.code,
                (b.container_id IS NOT NULL), c.opened_at NULLS LAST, c.created_at, c.code
    LOOP
      EXIT WHEN v_need <= 0;
      SELECT on_hand INTO v_have FROM public.wh_inventory_balances WHERE id = v_src.id FOR UPDATE;
      v_take := LEAST(v_need, GREATEST(COALESCE(v_have, 0), 0));
      CONTINUE WHEN v_take <= 0;
      PERFORM public._wh_post_movement(v_group, 'ship_settle', v_pair.sku_id, 'finished', v_take,
                                       v_src.location_id, v_src.container_id, NULL, NULL, NULL, v_actor,
                                       'shipstation_order', p_order_id, v_note);
      v_need := v_need - v_take;
      v_drawn := v_drawn + v_take;
    END LOOP;

    IF v_need > 0 THEN
      PERFORM public._wh_post_movement(v_group, 'ship_settle', v_pair.sku_id, 'finished', v_need,
                                       v_unloc, NULL, NULL, NULL, NULL, v_actor, 'shipstation_order', p_order_id,
                                       v_note || ': not found on a pickable shelf (shortfall)');
      v_short := v_short + v_need;
      SELECT l.id INTO v_loc
        FROM public.wh_locations l
       WHERE l.active AND l.pickable
         AND EXISTS (SELECT 1 FROM public.wh_inventory_balances b
                      WHERE b.location_id = l.id AND b.sku_id = v_pair.sku_id AND b.bucket = 'finished')
       ORDER BY l.pick_sequence NULLS LAST, l.code
       LIMIT 1;
      IF v_loc IS NOT NULL THEN
        v_cnt := public._wh_open_count(v_loc, 'reconcile', v_pair.sku_id,
                                       format('Ship settlement %s: %s short %s on order %s', current_date,
                                              COALESCE(v_pair.sku, 'SKU'), v_need, v_order.order_number),
                                       'shipstation_order', p_order_id, v_actor);
        IF (v_cnt->>'id') IS NOT NULL THEN
          v_counts := v_counts || (v_cnt->>'id')::uuid;
        END IF;
      END IF;
    END IF;
  END LOOP;

  SELECT COALESCE(SUM(CASE WHEN m.from_location_id IS NOT NULL THEN m.qty ELSE -m.qty END), 0)::int INTO v_total
    FROM public.wh_inventory_movements m
   WHERE m.type = 'ship_settle' AND m.reference_type = 'shipstation_order' AND m.reference_id = p_order_id;

  IF v_row.shipstation_order_id IS NULL THEN
    INSERT INTO public.wh_order_settlements (shipstation_order_id, method, settled_units, shortfall_units, settled_at, last_error)
    VALUES (p_order_id, 'ship_settle', GREATEST(v_total, 0), v_short, now(), NULL);
  ELSIF v_drawn + v_short + v_back > 0 OR v_row.last_error IS NOT NULL OR v_row.settled_at IS NULL
        OR v_row.settled_units IS DISTINCT FROM GREATEST(v_total, 0) THEN
    UPDATE public.wh_order_settlements
       SET settled_units = GREATEST(v_total, 0),
           shortfall_units = shortfall_units + v_short,
           settled_at = now(),
           last_error = NULL
     WHERE shipstation_order_id = p_order_id;
  END IF;

  RETURN jsonb_build_object('ok', true, 'order_id', p_order_id, 'order_number', v_order.order_number,
                            'settled_units', GREATEST(v_total, 0), 'drawn', v_drawn, 'shortfall', v_short,
                            'returned', v_back, 'count_task_ids', to_jsonb(v_counts),
                            'movement_group_id', CASE WHEN v_drawn + v_short + v_back > 0 THEN v_group END);
END;
$$;

-- The settlement as its callers use it: never raises; an error is kept in
-- wh_order_settlements.last_error for the nightly sweep to retry.
CREATE OR REPLACE FUNCTION public._wh_settle_order_safe(p_order_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_err text;
BEGIN
  BEGIN
    RETURN public._wh_settle_order(p_order_id);
  EXCEPTION WHEN OTHERS THEN
    v_err := left(SQLERRM, 500);
  END;
  BEGIN
    INSERT INTO public.wh_order_settlements (shipstation_order_id, method, last_error)
    VALUES (p_order_id, 'ship_settle', v_err)
    ON CONFLICT (shipstation_order_id) DO UPDATE SET last_error = EXCLUDED.last_error
     WHERE public.wh_order_settlements.method = 'ship_settle';
  EXCEPTION WHEN OTHERS THEN
    NULL;  -- the order row is gone; nothing to record against
  END;
  RETURN public._wh_err('settle_failed', 'Ship settlement failed: ' || v_err);
END;
$$;

-- -------------------------------------------------------------
-- E. The ledger mirror (§5.6 part 1)
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._wh_mirror_ledger_row(p_tx public.inventory_transactions)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_actor  uuid := COALESCE(p_tx.performed_by, '00000000-0000-0000-0000-000000000001'::uuid);
  v_group  uuid := gen_random_uuid();
  v_field  text := public._wh_field_bucket(p_tx.field_affected);
  v_from   text := public._wh_field_bucket(p_tx.from_field);
  v_to     text := public._wh_field_bucket(p_tx.to_field);
  v_qty    integer := p_tx.quantity;
  v_tmp    text;
  v_sku    text;
  v_mfg    uuid;
  v_unloc  uuid;
  v_in01   uuid;
  v_ref_t  text;
  v_ref_id uuid;
  v_note   text;
  v_src    record;
  v_need   integer;
  v_have   integer;
  v_take   integer;
  v_cart   integer := 0;
  v_task   uuid;
  v_tqty   integer;
  v_sug    jsonb;
BEGIN
  IF p_tx.sku_id IS NULL THEN
    RETURN jsonb_build_object('mirrored', false, 'reason', 'no_sku');
  END IF;

  -- a sale row for an order ship settlement already admitted
  IF p_tx.transaction_type = 'order_shipped' THEN
    IF p_tx.reference_type = 'shipstation_order' AND p_tx.reference_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.wh_order_settlements s
                     JOIN public.shipstation_orders o ON o.id = s.shipstation_order_id
                    WHERE s.shipstation_order_id = p_tx.reference_id AND s.method = 'ship_settle'
                      AND o.order_status = 'shipped') THEN
      RETURN jsonb_build_object('mirrored', true, 'kind', 'ship_settle',
                                'settlement', public._wh_settle_order_safe(p_tx.reference_id));
    END IF;
    RETURN jsonb_build_object('mirrored', false, 'reason', 'order_not_admitted');
  END IF;

  IF EXISTS (SELECT 1 FROM public.wh_inventory_movements WHERE ledger_tx_id = p_tx.id) THEN
    RETURN jsonb_build_object('mirrored', false, 'reason', 'already_mirrored');
  END IF;
  SELECT sku INTO v_sku FROM public.product_skus WHERE id = p_tx.sku_id;

  -- ---------- manufacturing: a bucket conversion at the line ----------
  IF p_tx.transaction_type = 'task_logged' AND p_tx.movement_kind = 'category_move' THEN
    IF v_from IS NULL OR v_to IS NULL OR v_from = v_to OR COALESCE(v_qty, 0) = 0 THEN
      RETURN jsonb_build_object('mirrored', false, 'reason', 'not_a_bucket_move');
    END IF;
    IF v_qty < 0 THEN
      v_tmp := v_from; v_from := v_to; v_to := v_tmp; v_qty := -v_qty;
    END IF;
    v_mfg := public._wh_loc_id('MFG-LINE');
    IF v_mfg IS NULL THEN
      RAISE EXCEPTION 'The MFG-LINE location is missing.';
    END IF;
    IF p_tx.reference_type = 'task_log' AND p_tx.reference_id IS NOT NULL THEN
      v_ref_t := 'task_log'; v_ref_id := p_tx.reference_id;
    ELSE
      v_ref_t := 'inventory_transaction'; v_ref_id := p_tx.id;
    END IF;
    v_note := format('%s %s → %s at the line (ledger mirror)', COALESCE(v_sku, 'SKU'), v_from, v_to);
    v_need := v_qty;
    -- cartons taken to the line first, the one that arrived first first
    FOR v_src IN
      SELECT b.id, b.container_id
        FROM public.wh_inventory_balances b
        JOIN public.wh_containers c ON c.id = b.container_id
        LEFT JOIN LATERAL (
          SELECT max(m.created_at) AS arrived
            FROM public.wh_inventory_movements m
           WHERE m.to_container_id = c.id AND m.to_location_id = v_mfg) a ON true
       WHERE b.location_id = v_mfg AND b.sku_id = p_tx.sku_id AND b.bucket = v_from AND b.on_hand > 0
         AND c.location_id = v_mfg AND c.state IN ('sealed', 'open')
       ORDER BY a.arrived NULLS LAST, c.created_at, c.code
    LOOP
      EXIT WHEN v_need <= 0;
      SELECT on_hand INTO v_have FROM public.wh_inventory_balances WHERE id = v_src.id FOR UPDATE;
      v_take := LEAST(v_need, GREATEST(COALESCE(v_have, 0), 0));
      CONTINUE WHEN v_take <= 0;
      PERFORM public._wh_post_movement(v_group, 'bucket_convert', p_tx.sku_id, v_from, v_take,
                                       v_mfg, v_src.container_id, v_mfg, NULL, v_to, v_actor, v_ref_t, v_ref_id,
                                       v_note, NULL, p_tx.id);
      v_need := v_need - v_take;
      v_cart := v_cart + v_take;
    END LOOP;
    -- then loose units at the line (MFG-LINE may go negative)
    IF v_need > 0 THEN
      PERFORM public._wh_post_movement(v_group, 'bucket_convert', p_tx.sku_id, v_from, v_need,
                                       v_mfg, NULL, v_mfg, NULL, v_to, v_actor, v_ref_t, v_ref_id,
                                       v_note, NULL, p_tx.id);
    END IF;
    RETURN jsonb_build_object('mirrored', true, 'kind', 'bucket_convert', 'from', v_from, 'to', v_to,
                              'from_cartons', v_cart, 'loose', v_need, 'movement_group_id', v_group);
  END IF;

  -- ---------- breakage write-off: unexplained loss at UNLOCATED ----------
  IF p_tx.transaction_type = 'task_logged' AND p_tx.movement_kind = 'write_off' THEN
    v_tmp := COALESCE(v_from, v_field);
    IF v_tmp IS NULL OR COALESCE(v_qty, 0) = 0 THEN
      RETURN jsonb_build_object('mirrored', false, 'reason', 'not_a_stock_write_off');
    END IF;
    v_unloc := public._wh_loc_id('UNLOCATED');
    IF v_unloc IS NULL THEN
      RAISE EXCEPTION 'The UNLOCATED location is missing.';
    END IF;
    PERFORM public._wh_post_movement(v_group, 'write_off', p_tx.sku_id, v_tmp, abs(v_qty),
                                     v_unloc, NULL, NULL, NULL, NULL, v_actor, 'inventory_transaction', p_tx.id,
                                     format('%s breakage of %s (ledger mirror)', COALESCE(v_sku, 'SKU'), abs(v_qty)),
                                     NULL, p_tx.id);
    RETURN jsonb_build_object('mirrored', true, 'kind', 'write_off', 'bucket', v_tmp, 'qty', abs(v_qty));
  END IF;

  IF p_tx.transaction_type = 'task_logged' THEN
    RETURN jsonb_build_object('mirrored', false, 'reason', 'no_stock_change');   -- filling_capping (metadata)
  END IF;

  -- ---------- Stock Levels cycle count: at UNLOCATED ----------
  IF p_tx.transaction_type = 'cycle_count' THEN
    IF p_tx.movement_kind <> 'net_change' OR v_field IS NULL OR COALESCE(v_qty, 0) = 0 THEN
      RETURN jsonb_build_object('mirrored', false, 'reason', 'not_a_stock_count');
    END IF;
    v_unloc := public._wh_loc_id('UNLOCATED');
    IF v_unloc IS NULL THEN
      RAISE EXCEPTION 'The UNLOCATED location is missing.';
    END IF;
    v_note := format('%s Stock Levels count %s%s on %s (ledger mirror)', COALESCE(v_sku, 'SKU'),
                     CASE WHEN v_qty > 0 THEN '+' ELSE '' END, v_qty, v_field);
    IF v_qty > 0 THEN
      PERFORM public._wh_post_movement(v_group, 'ledger_mirror', p_tx.sku_id, v_field, v_qty,
                                       NULL, NULL, v_unloc, NULL, NULL, v_actor, 'inventory_transaction', p_tx.id,
                                       v_note, NULL, p_tx.id);
    ELSE
      PERFORM public._wh_post_movement(v_group, 'ledger_mirror', p_tx.sku_id, v_field, -v_qty,
                                       v_unloc, NULL, NULL, NULL, NULL, v_actor, 'inventory_transaction', p_tx.id,
                                       v_note, NULL, p_tx.id);
    END IF;
    RETURN jsonb_build_object('mirrored', true, 'kind', 'ledger_mirror', 'location', 'UNLOCATED', 'bucket', v_field, 'qty', v_qty);
  END IF;

  -- ---------- a receipt that skipped the LPN path: loose at IN-01 ----------
  IF p_tx.transaction_type = 'freight_delivered' THEN
    IF p_tx.movement_kind <> 'net_change' OR v_field IS NULL OR COALESCE(v_qty, 0) = 0 THEN
      RETURN jsonb_build_object('mirrored', false, 'reason', 'not_a_stock_receipt');
    END IF;
    v_in01 := public._wh_loc_id('IN-01');
    v_unloc := public._wh_loc_id('UNLOCATED');
    IF v_in01 IS NULL OR v_unloc IS NULL THEN
      RAISE EXCEPTION 'The IN-01 or UNLOCATED location is missing.';
    END IF;
    IF p_tx.reference_type = 'freight_shipment' AND p_tx.reference_id IS NOT NULL THEN
      v_ref_t := 'freight_shipment'; v_ref_id := p_tx.reference_id;
    ELSE
      v_ref_t := 'inventory_transaction'; v_ref_id := p_tx.id;
    END IF;
    SELECT id, qty INTO v_task, v_tqty FROM public.wh_moves
     WHERE kind = 'putaway' AND origin = 'receipt' AND status = 'open' AND container_id IS NULL
       AND sku_id = p_tx.sku_id AND bucket = v_field AND from_location_id = v_in01
       AND source_type IS NOT DISTINCT FROM (CASE WHEN v_ref_t = 'freight_shipment' THEN 'freight_shipment' END)
       AND source_id IS NOT DISTINCT FROM (CASE WHEN v_ref_t = 'freight_shipment' THEN v_ref_id END)
     ORDER BY created_at, id
     LIMIT 1
     FOR UPDATE;

    IF v_qty > 0 THEN
      PERFORM public._wh_post_movement(v_group, 'ledger_mirror', p_tx.sku_id, v_field, v_qty,
                                       NULL, NULL, v_in01, NULL, NULL, v_actor, v_ref_t, v_ref_id,
                                       format('%s receipt of %s loose at IN-01 (ledger mirror)', COALESCE(v_sku, 'SKU'), v_qty),
                                       NULL, p_tx.id);
      IF v_task IS NOT NULL THEN
        UPDATE public.wh_moves SET qty = qty + v_qty WHERE id = v_task;
      ELSE
        v_sug := public._wh_suggest_putaway(NULL, '{}', p_tx.sku_id, v_field, 'receipt');
        INSERT INTO public.wh_moves (kind, origin, status, sku_id, qty, bucket, from_location_id, suggested_location_id,
                                     suggestion_reason, source_type, source_id, created_by)
        VALUES ('putaway', 'receipt', 'open', p_tx.sku_id, v_qty, v_field, v_in01, (v_sug->>'location_id')::uuid,
                v_sug->>'reason', CASE WHEN v_ref_t = 'freight_shipment' THEN 'freight_shipment' END,
                CASE WHEN v_ref_t = 'freight_shipment' THEN v_ref_id END, v_actor)
        RETURNING id INTO v_task;
      END IF;
      RETURN jsonb_build_object('mirrored', true, 'kind', 'ledger_mirror', 'location', 'IN-01', 'bucket', v_field,
                                'qty', v_qty, 'putaway_task', v_task);
    END IF;

    -- a reversal: from IN-01 while it still holds the units, the rest from UNLOCATED
    v_need := -v_qty;
    SELECT on_hand INTO v_have FROM public.wh_inventory_balances
     WHERE sku_id = p_tx.sku_id AND location_id = v_in01 AND container_id IS NULL AND bucket = v_field
     FOR UPDATE;
    v_take := LEAST(v_need, GREATEST(COALESCE(v_have, 0), 0));
    IF v_take > 0 THEN
      PERFORM public._wh_post_movement(v_group, 'ledger_mirror', p_tx.sku_id, v_field, v_take,
                                       v_in01, NULL, NULL, NULL, NULL, v_actor, v_ref_t, v_ref_id,
                                       format('%s receipt reversed: %s from IN-01 (ledger mirror)', COALESCE(v_sku, 'SKU'), v_take),
                                       NULL, p_tx.id);
    END IF;
    IF v_need - v_take > 0 THEN
      PERFORM public._wh_post_movement(v_group, 'ledger_mirror', p_tx.sku_id, v_field, v_need - v_take,
                                       v_unloc, NULL, NULL, NULL, NULL, v_actor, v_ref_t, v_ref_id,
                                       format('%s receipt reversed: %s no longer at IN-01 (ledger mirror)', COALESCE(v_sku, 'SKU'), v_need - v_take),
                                       NULL, p_tx.id);
    END IF;
    IF v_task IS NOT NULL AND v_take > 0 THEN
      IF v_tqty - v_take > 0 THEN
        UPDATE public.wh_moves SET qty = qty - v_take WHERE id = v_task;
      ELSE
        UPDATE public.wh_moves SET status = 'cancelled', completed_by = v_actor, completed_at = now() WHERE id = v_task;
      END IF;
    END IF;
    RETURN jsonb_build_object('mirrored', true, 'kind', 'ledger_mirror', 'location', 'IN-01', 'bucket', v_field,
                              'qty', v_qty, 'from_in01', v_take, 'from_unlocated', v_need - v_take);
  END IF;

  RETURN jsonb_build_object('mirrored', false, 'reason', 'type_not_mirrored');
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_wh_ledger_mirror()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_raw   text;
  v_since timestamptz;
BEGIN
  IF COALESCE(current_setting('wh.mirror_skip', true), '') = 'on' THEN
    RETURN NULL;   -- the writer posted the physical twin itself
  END IF;
  SELECT value->>'live_since' INTO v_raw FROM public.wh_settings WHERE key = 'physical_layer';
  IF v_raw IS NULL THEN
    RETURN NULL;   -- dormant
  END IF;
  BEGIN
    v_since := v_raw::timestamptz;
    IF v_since <= now() AND NEW.created_at >= v_since THEN
      PERFORM public._wh_mirror_ledger_row(NEW);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- never fail the ledger insert; leave a trace for the reconcile to explain
    BEGIN
      INSERT INTO public.audit_logs (actor_id, action, target_table, target_id, details)
      VALUES (NEW.performed_by, 'wh.mirror_failed', 'inventory_transactions', NEW.id,
              jsonb_build_object('error', left(SQLERRM, 500), 'sqlstate', SQLSTATE,
                                 'transaction_type', NEW.transaction_type, 'sku_id', NEW.sku_id,
                                 'quantity', NEW.quantity, 'field_affected', NEW.field_affected,
                                 'reference_type', NEW.reference_type, 'reference_id', NEW.reference_id));
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS wh_ledger_mirror ON public.inventory_transactions;
CREATE TRIGGER wh_ledger_mirror
  AFTER INSERT ON public.inventory_transactions
  FOR EACH ROW
  WHEN (NEW.transaction_type IN ('cycle_count', 'task_logged', 'freight_delivered', 'order_shipped'))
  EXECUTE FUNCTION public.trg_wh_ledger_mirror();

-- -------------------------------------------------------------
-- F. Settlement trigger: an order BECOMES shipped while live
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_wh_settle_on_shipped()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_raw   text;
  v_since timestamptz;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.order_status = 'shipped' THEN
      RETURN NULL; -- a re-ingest of a shipped order is not a transition
    END IF;
  END IF;
  SELECT value->>'live_since' INTO v_raw FROM public.wh_settings WHERE key = 'physical_layer';
  IF v_raw IS NULL THEN
    RETURN NULL;   -- dormant
  END IF;
  BEGIN
    v_since := v_raw::timestamptz;
    IF v_since <= now() AND COALESCE(NEW.ship_date, now()) >= date_trunc('day', v_since AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' THEN
      PERFORM public._wh_settle_order_safe(NEW.id);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;          -- never block ShipStation ingestion; the nightly sweep retries
  END;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS wh_settle_on_shipped ON public.shipstation_orders;
CREATE TRIGGER wh_settle_on_shipped
  AFTER INSERT OR UPDATE OF order_status ON public.shipstation_orders
  FOR EACH ROW
  WHEN (NEW.order_status = 'shipped')
  EXECUTE FUNCTION public.trg_wh_settle_on_shipped();

-- -------------------------------------------------------------
-- G. Grants: every function here is private
-- -------------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public._wh_live_since()', 'public._wh_field_bucket(text)',
    'public._wh_open_count(uuid, text, uuid, text, text, uuid, uuid)',
    'public._wh_ledger_post(uuid, text, text, text, integer, text, uuid, uuid, text)',
    'public._wh_settlement_pairs()', 'public._wh_settle_order(uuid, uuid)', 'public._wh_settle_order_safe(uuid)',
    'public._wh_mirror_ledger_row(public.inventory_transactions)',
    'public.trg_wh_ledger_mirror()', 'public.trg_wh_settle_on_shipped()'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
  END LOOP;
END $$;

COMMENT ON FUNCTION public._wh_settle_order(uuid, uuid) IS
  'Ship settlement (design §5.6): moves the finished units the ledger says left with a shipped order off pickable shelves; shortfall to UNLOCATED with a reconcile count.';
COMMENT ON FUNCTION public.trg_wh_ledger_mirror() IS
  'Ledger mirror (design §5.6): posts the physical twin of cycle_count, task_logged and freight_delivered rows and settles admitted orders on order_shipped. Dormant until physical_layer.live_since; skipped under wh.mirror_skip; never fails the ledger insert.';

COMMIT;
