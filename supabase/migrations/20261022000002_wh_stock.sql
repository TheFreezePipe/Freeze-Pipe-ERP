-- =============================================================
-- Migration: Warehouse stock — containers, balances, movements and the
--            single writer (Phase 1, slice 1)
-- =============================================================
-- Design: docs/design/WAREHOUSE_MODULE_PHASE0_1.md §4.2, §4.3
-- (wh_containers incl. the §5.7 additions, wh_inventory_balances,
-- wh_inventory_movements), §4.4, §4.5, §5.1 ("one writer").
--
-- Finding: Phase 1 needs per-location, per-carton stock beside the
-- one-row-per-SKU inventory_levels, written by one function so the
-- container quantities, balances and the append-only movement log can
-- never disagree.
-- Decision:
--   * wh_containers: license plates. Codes C-<shipment>-<nnn>,
--     C-OB-<nnnn> (opening stock), <parent>R<n> (RTS relabel) and
--     C-MFG-<nnnn> (RTS without a parent), §5.7. label_stock white|green,
--     parent_container_id / superseded_by lineage, finished_by / _at.
--   * wh_inventory_balances: one row per (sku, location, container,
--     bucket), UNIQUE NULLS NOT DISTINCT; on_hand may go negative only
--     where the location allows it (UNLOCATED, MFG-LINE), copied on insert.
--   * wh_inventory_movements: append-only (block_wh_mutation); type list
--     includes 'relabel'. client_event_id is UNIQUE and is written on the
--     first movement of a phone call's group.
--   * wh_client_events (deviation, not in §4.3): the stored first result
--     of a phone RPC keyed by p_client_event_id, so a repeat can return
--     it with duplicate: true (§5.1 idempotency needs the result kept).
--   * _wh_post_movement: the only writer (§5.1). Locks both balances
--     FOR UPDATE in id order, refuses to take a non-negative balance
--     below zero (raises 'insufficient'), upserts the destination,
--     updates container qty/state/location, inserts the movement. Not
--     executable by clients. Two optional trailing arguments beyond the
--     §5.1 signature: p_client_event_id and p_ledger_tx_id.
--   * Ledger (§4.5): chk_inv_tx_reference_shape is re-created from its
--     live definition with 'wh_count_task' and 'wh_movement' appended,
--     so every existing value survives on any project.
--     inventory_transactions.transaction_type is plain text with no
--     CHECK or enum on staging (read 2026-10-22), so 'wh_count_adjust',
--     'wh_write_off' and 'wh_bucket_move' need no schema change.
--
-- Smoke after deploy:
--   SELECT public._wh_location_has_stock((SELECT id FROM public.wh_locations WHERE code = 'IN-01'));  -- false
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'chk_inv_tx_reference_shape'; -- lists wh_count_task, wh_movement
--   SELECT has_function_privilege('authenticated', 'public._wh_post_movement(uuid,text,uuid,text,integer,uuid,uuid,uuid,uuid,text,uuid,text,uuid,text,uuid,uuid)', 'EXECUTE'); -- false
-- =============================================================

BEGIN;

-- -------------------------------------------------------------
-- A. Append-only guard for warehouse logs
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.block_wh_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; % is not permitted.', TG_TABLE_NAME, TG_OP
    USING HINT = 'Post a new movement describing the correction instead.';
END;
$$;

-- -------------------------------------------------------------
-- B. wh_containers (license plates)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.wh_containers (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                 text NOT NULL,
  barcode_value        text GENERATED ALWAYS AS ('%' || code) STORED,
  kind                 text NOT NULL DEFAULT 'carton',
  sku_id               uuid REFERENCES public.product_skus(id),
  qty_initial          integer NOT NULL DEFAULT 0,
  qty                  integer NOT NULL DEFAULT 0,
  state                text NOT NULL DEFAULT 'sealed',
  location_id          uuid REFERENCES public.wh_locations(id),
  source               text NOT NULL,
  freight_shipment_id  uuid REFERENCES public.freight_shipments(id),
  carton_group_id      uuid REFERENCES public.freight_carton_groups(id),
  freight_receipt_id   uuid REFERENCES public.freight_receipts(id),
  carton_seq           integer,
  printed_at           timestamptz,
  print_count          integer NOT NULL DEFAULT 0,
  opened_at            timestamptz,
  emptied_at           timestamptz,
  created_by           uuid REFERENCES public.profiles(id),
  label_stock          text NOT NULL DEFAULT 'white',
  parent_container_id  uuid REFERENCES public.wh_containers(id),
  superseded_by        uuid REFERENCES public.wh_containers(id),
  finished_by          uuid REFERENCES public.profiles(id),
  finished_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  row_version          integer NOT NULL DEFAULT 1,
  CONSTRAINT wh_containers_code_key UNIQUE (code),
  CONSTRAINT wh_containers_barcode_value_key UNIQUE (barcode_value),
  CONSTRAINT chk_wh_containers_code CHECK (code ~ '^C-[A-Za-z0-9]+(-[A-Za-z0-9]+)*$'),
  CONSTRAINT chk_wh_containers_kind CHECK (kind IN ('carton')),
  CONSTRAINT chk_wh_containers_qty CHECK (qty >= 0 AND qty_initial >= 0 AND print_count >= 0),
  CONSTRAINT chk_wh_containers_state CHECK (state IN ('sealed', 'open', 'empty', 'void')),
  CONSTRAINT chk_wh_containers_location CHECK (state IN ('empty', 'void') OR location_id IS NOT NULL),
  CONSTRAINT chk_wh_containers_source CHECK (source IN ('freight', 'opening_balance', 'manual', 'manufacturing')),
  CONSTRAINT chk_wh_containers_label_stock CHECK (label_stock IN ('white', 'green')),
  CONSTRAINT chk_wh_containers_superseded CHECK (superseded_by IS NULL OR state = 'void')
);

CREATE INDEX IF NOT EXISTS wh_containers_location_live_idx ON public.wh_containers (location_id) WHERE state IN ('sealed', 'open');
CREATE INDEX IF NOT EXISTS wh_containers_sku_idx ON public.wh_containers (sku_id);
CREATE INDEX IF NOT EXISTS wh_containers_carton_group_idx ON public.wh_containers (carton_group_id);
CREATE INDEX IF NOT EXISTS wh_containers_parent_idx ON public.wh_containers (parent_container_id);
CREATE INDEX IF NOT EXISTS wh_containers_code_upper_idx ON public.wh_containers (upper(code));

-- -------------------------------------------------------------
-- C. wh_inventory_balances
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.wh_inventory_balances (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku_id            uuid NOT NULL REFERENCES public.product_skus(id),
  location_id       uuid NOT NULL REFERENCES public.wh_locations(id),
  container_id      uuid REFERENCES public.wh_containers(id),
  bucket            text NOT NULL,
  on_hand           integer NOT NULL DEFAULT 0,
  allocated         integer NOT NULL DEFAULT 0,
  available         integer GENERATED ALWAYS AS (on_hand - allocated) STORED,
  allow_negative    boolean NOT NULL,
  last_movement_at  timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  row_version       integer NOT NULL DEFAULT 1,
  CONSTRAINT wh_inventory_balances_key UNIQUE NULLS NOT DISTINCT (sku_id, location_id, container_id, bucket),
  CONSTRAINT chk_wh_balances_bucket CHECK (bucket IN ('raw', 'prefilled_raw', 'in_production', 'finished', 'other')),
  CONSTRAINT chk_wh_balances_on_hand CHECK (on_hand >= 0 OR allow_negative),
  CONSTRAINT chk_wh_balances_allocated CHECK (allocated >= 0)
);

CREATE INDEX IF NOT EXISTS wh_balances_location_idx ON public.wh_inventory_balances (location_id);
CREATE INDEX IF NOT EXISTS wh_balances_sku_bucket_idx ON public.wh_inventory_balances (sku_id, bucket);
CREATE INDEX IF NOT EXISTS wh_balances_container_idx ON public.wh_inventory_balances (container_id);

-- -------------------------------------------------------------
-- D. wh_inventory_movements (append-only)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.wh_inventory_movements (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq                bigint GENERATED ALWAYS AS IDENTITY,
  movement_group_id  uuid NOT NULL,
  client_event_id    uuid,
  type               text NOT NULL,
  sku_id             uuid NOT NULL REFERENCES public.product_skus(id),
  bucket             text NOT NULL,
  to_bucket          text,
  qty                integer NOT NULL,
  from_location_id   uuid REFERENCES public.wh_locations(id),
  to_location_id     uuid REFERENCES public.wh_locations(id),
  from_container_id  uuid REFERENCES public.wh_containers(id),
  to_container_id    uuid REFERENCES public.wh_containers(id),
  actor_id           uuid NOT NULL REFERENCES public.profiles(id),
  reference_type     text,
  reference_id       uuid,
  ledger_tx_id       uuid REFERENCES public.inventory_transactions(id),
  note               text,
  device             text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wh_inventory_movements_client_event_key UNIQUE (client_event_id),
  CONSTRAINT chk_wh_movements_type CHECK (type IN ('receive', 'void_receipt', 'putaway', 'move', 'open_container', 'count_adjust',
                                                   'write_off', 'bucket_convert', 'mfg_mirror', 'ledger_mirror', 'ship_settle',
                                                   'opening_balance', 'relabel')),
  CONSTRAINT chk_wh_movements_bucket CHECK (bucket IN ('raw', 'prefilled_raw', 'in_production', 'finished', 'other')),
  CONSTRAINT chk_wh_movements_to_bucket CHECK (to_bucket IS NULL OR to_bucket IN ('raw', 'prefilled_raw', 'in_production', 'finished', 'other')),
  CONSTRAINT chk_wh_movements_qty CHECK (qty > 0),
  CONSTRAINT chk_wh_movements_location CHECK (from_location_id IS NOT NULL OR to_location_id IS NOT NULL),
  CONSTRAINT chk_wh_movements_reference CHECK (
    (reference_type IS NULL AND reference_id IS NULL) OR
    (reference_type IN ('freight_receipt', 'freight_shipment', 'wh_move', 'wh_count_task', 'shipstation_order',
                        'task_log', 'inventory_transaction', 'wh_import'))),
  CONSTRAINT chk_wh_movements_note_len CHECK (note IS NULL OR length(note) <= 2000)
);

CREATE INDEX IF NOT EXISTS wh_movements_sku_created_idx ON public.wh_inventory_movements (sku_id, created_at);
CREATE INDEX IF NOT EXISTS wh_movements_from_loc_created_idx ON public.wh_inventory_movements (from_location_id, created_at);
CREATE INDEX IF NOT EXISTS wh_movements_to_loc_created_idx ON public.wh_inventory_movements (to_location_id, created_at);
CREATE INDEX IF NOT EXISTS wh_movements_reference_idx ON public.wh_inventory_movements (reference_type, reference_id);
CREATE INDEX IF NOT EXISTS wh_movements_group_idx ON public.wh_inventory_movements (movement_group_id);

DROP TRIGGER IF EXISTS trg_block_wh_movements_mutation ON public.wh_inventory_movements;
CREATE TRIGGER trg_block_wh_movements_mutation
  BEFORE UPDATE OR DELETE ON public.wh_inventory_movements
  FOR EACH ROW EXECUTE FUNCTION public.block_wh_mutation();

-- -------------------------------------------------------------
-- E. wh_client_events (phone idempotency: the first result per event)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.wh_client_events (
  client_event_id  uuid PRIMARY KEY,
  rpc              text NOT NULL,
  actor_id         uuid REFERENCES public.profiles(id),
  result           jsonb NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_block_wh_client_events_update ON public.wh_client_events;
CREATE TRIGGER trg_block_wh_client_events_update
  BEFORE UPDATE ON public.wh_client_events
  FOR EACH ROW EXECUTE FUNCTION public.block_wh_mutation();

-- -------------------------------------------------------------
-- F. Triggers, RLS, grants
-- -------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['wh_containers', 'wh_inventory_balances'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', t || '_updated_at', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.update_updated_at()', t || '_updated_at', t);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', t || '_row_version', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.bump_row_version()', t || '_row_version', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['wh_containers', 'wh_inventory_balances', 'wh_inventory_movements', 'wh_client_events'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_select_internal', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.jwt_is_internal())', t || '_select_internal', t);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON TABLE public.%I TO authenticated', t);
    EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', t);
  END LOOP;
END $$;

-- -------------------------------------------------------------
-- G. Location stock test (replaces the 20261022000001 stub)
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._wh_location_has_stock(p_location_id uuid)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.wh_inventory_balances b WHERE b.location_id = p_location_id AND b.on_hand <> 0)
      OR EXISTS (SELECT 1 FROM public.wh_containers c WHERE c.location_id = p_location_id AND c.state IN ('sealed', 'open'));
$$;
REVOKE ALL ON FUNCTION public._wh_location_has_stock(uuid) FROM PUBLIC, anon, authenticated;

-- -------------------------------------------------------------
-- H. _wh_post_movement — the single writer (§5.1)
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._wh_post_movement(
  p_group uuid, p_type text, p_sku uuid, p_bucket text, p_qty integer,
  p_from_loc uuid, p_from_ctr uuid, p_to_loc uuid, p_to_ctr uuid, p_to_bucket text,
  p_actor uuid, p_ref_type text, p_ref_id uuid, p_note text,
  p_client_event_id uuid DEFAULT NULL, p_ledger_tx_id uuid DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_to_bucket text := COALESCE(p_to_bucket, p_bucket);
  v_src_id    uuid;
  v_dst_id    uuid;
  v_neg       boolean;
  v_on_hand   integer;
  v_src_neg   boolean;
  v_id        uuid;
BEGIN
  IF p_qty IS NULL OR p_qty <= 0 THEN
    RAISE EXCEPTION 'wh_post_movement: qty must be positive (got %)', p_qty;
  END IF;
  IF p_from_loc IS NULL AND p_to_loc IS NULL THEN
    RAISE EXCEPTION 'wh_post_movement: a movement needs a source or a destination location';
  END IF;
  IF p_group IS NULL OR p_actor IS NULL OR p_sku IS NULL OR p_bucket IS NULL THEN
    RAISE EXCEPTION 'wh_post_movement: group, actor, sku and bucket are required';
  END IF;

  -- source balance (created at zero only where the location allows negatives)
  IF p_from_loc IS NOT NULL THEN
    SELECT id INTO v_src_id FROM public.wh_inventory_balances
     WHERE sku_id = p_sku AND location_id = p_from_loc AND container_id IS NOT DISTINCT FROM p_from_ctr AND bucket = p_bucket;
    IF v_src_id IS NULL THEN
      SELECT allow_negative INTO v_neg FROM public.wh_locations WHERE id = p_from_loc;
      IF NOT COALESCE(v_neg, false) THEN
        RAISE EXCEPTION 'insufficient: no % balance of this SKU at the source', p_bucket USING ERRCODE = 'P0001';
      END IF;
      INSERT INTO public.wh_inventory_balances (sku_id, location_id, container_id, bucket, on_hand, allow_negative)
      VALUES (p_sku, p_from_loc, p_from_ctr, p_bucket, 0, true)
      ON CONFLICT ON CONSTRAINT wh_inventory_balances_key DO NOTHING
      RETURNING id INTO v_src_id;
      IF v_src_id IS NULL THEN
        SELECT id INTO v_src_id FROM public.wh_inventory_balances
         WHERE sku_id = p_sku AND location_id = p_from_loc AND container_id IS NOT DISTINCT FROM p_from_ctr AND bucket = p_bucket;
      END IF;
    END IF;
  END IF;

  -- destination balance (upsert; allow_negative copied from the location)
  IF p_to_loc IS NOT NULL THEN
    SELECT id INTO v_dst_id FROM public.wh_inventory_balances
     WHERE sku_id = p_sku AND location_id = p_to_loc AND container_id IS NOT DISTINCT FROM p_to_ctr AND bucket = v_to_bucket;
    IF v_dst_id IS NULL THEN
      INSERT INTO public.wh_inventory_balances (sku_id, location_id, container_id, bucket, on_hand, allow_negative)
      SELECT p_sku, p_to_loc, p_to_ctr, v_to_bucket, 0, l.allow_negative FROM public.wh_locations l WHERE l.id = p_to_loc
      ON CONFLICT ON CONSTRAINT wh_inventory_balances_key DO NOTHING
      RETURNING id INTO v_dst_id;
      IF v_dst_id IS NULL THEN
        SELECT id INTO v_dst_id FROM public.wh_inventory_balances
         WHERE sku_id = p_sku AND location_id = p_to_loc AND container_id IS NOT DISTINCT FROM p_to_ctr AND bucket = v_to_bucket;
      END IF;
      IF v_dst_id IS NULL THEN
        RAISE EXCEPTION 'wh_post_movement: destination location % not found', p_to_loc;
      END IF;
    END IF;
  END IF;

  IF v_src_id IS NOT NULL AND v_src_id = v_dst_id THEN
    RAISE EXCEPTION 'wh_post_movement: source and destination are the same balance';
  END IF;

  -- lock both rows in id order so two phones never deadlock
  PERFORM 1 FROM public.wh_inventory_balances
   WHERE id IN (v_src_id, v_dst_id)
   ORDER BY id
   FOR UPDATE;

  IF v_src_id IS NOT NULL THEN
    SELECT on_hand, allow_negative INTO v_on_hand, v_src_neg FROM public.wh_inventory_balances WHERE id = v_src_id;
    IF NOT v_src_neg AND v_on_hand - p_qty < 0 THEN
      RAISE EXCEPTION 'insufficient: % on hand, % requested', v_on_hand, p_qty USING ERRCODE = 'P0001';
    END IF;
    UPDATE public.wh_inventory_balances
       SET on_hand = on_hand - p_qty, last_movement_at = now()
     WHERE id = v_src_id;
  END IF;
  IF v_dst_id IS NOT NULL THEN
    UPDATE public.wh_inventory_balances
       SET on_hand = on_hand + p_qty, last_movement_at = now()
     WHERE id = v_dst_id;
  END IF;

  -- containers
  IF p_from_ctr IS NOT NULL AND p_from_ctr IS DISTINCT FROM p_to_ctr THEN
    -- units leave the carton: a draw opens a sealed carton, zero empties it
    UPDATE public.wh_containers
       SET qty        = GREATEST(qty - p_qty, 0),
           state      = CASE WHEN qty - p_qty <= 0 AND state IN ('sealed', 'open') THEN 'empty'
                             WHEN state = 'sealed' THEN 'open' ELSE state END,
           opened_at  = CASE WHEN state = 'sealed' THEN COALESCE(opened_at, now()) ELSE opened_at END,
           emptied_at = CASE WHEN qty - p_qty <= 0 AND state IN ('sealed', 'open') THEN now() ELSE emptied_at END
     WHERE id = p_from_ctr;
  END IF;
  IF p_to_ctr IS NOT NULL AND p_to_ctr IS DISTINCT FROM p_from_ctr THEN
    -- units enter the carton, which is where the destination is
    UPDATE public.wh_containers
       SET qty         = qty + p_qty,
           location_id = COALESCE(p_to_loc, location_id),
           state       = CASE WHEN state = 'empty' THEN 'open' ELSE state END,
           emptied_at  = CASE WHEN state = 'empty' THEN NULL ELSE emptied_at END
     WHERE id = p_to_ctr;
  END IF;
  IF p_from_ctr IS NOT NULL AND p_from_ctr = p_to_ctr AND p_to_loc IS NOT NULL THEN
    -- the carton travels with its contents
    UPDATE public.wh_containers SET location_id = p_to_loc WHERE id = p_from_ctr AND location_id IS DISTINCT FROM p_to_loc;
  END IF;

  INSERT INTO public.wh_inventory_movements (
    movement_group_id, client_event_id, type, sku_id, bucket, to_bucket, qty,
    from_location_id, to_location_id, from_container_id, to_container_id,
    actor_id, reference_type, reference_id, ledger_tx_id, note)
  VALUES (
    p_group, p_client_event_id, p_type, p_sku, p_bucket, NULLIF(v_to_bucket, p_bucket), p_qty,
    p_from_loc, p_to_loc, p_from_ctr, p_to_ctr,
    p_actor, p_ref_type, p_ref_id, p_ledger_tx_id, p_note)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public._wh_post_movement(uuid, text, uuid, text, integer, uuid, uuid, uuid, uuid, text, uuid, text, uuid, text, uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public._wh_post_movement(uuid, text, uuid, text, integer, uuid, uuid, uuid, uuid, text, uuid, text, uuid, text, uuid, uuid) IS
  'The single writer of wh_inventory_balances, container qty/state and wh_inventory_movements (design §5.1). Not executable by clients.';

-- -------------------------------------------------------------
-- I. Ledger: reference types for count approvals and bucket moves (§4.5)
-- -------------------------------------------------------------
DO $$
DECLARE
  v_def    text;
  v_values text[];
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def
    FROM pg_constraint
   WHERE conrelid = 'public.inventory_transactions'::regclass AND conname = 'chk_inv_tx_reference_shape';

  IF v_def IS NOT NULL THEN
    -- ARRAY['a'::text, ...] form, or the '{a,b}'::text[] form
    SELECT array_agg(DISTINCT v ORDER BY v) INTO v_values
      FROM (
        SELECT m[1] AS v FROM regexp_matches(v_def, '''([a-z_]+)''::text', 'g') AS m
        UNION
        SELECT btrim(x) FROM regexp_matches(v_def, '''\{([^}]*)\}''::text\[\]', 'g') AS a,
             LATERAL unnest(string_to_array(a[1], ',')) AS x
      ) s
     WHERE v ~ '^[a-z_]+$';
  END IF;
  v_values := COALESCE(v_values, ARRAY['product_sku', 'task_log', 'freight_shipment', 'factory_order', 'shipstation_order', 'profile']);
  IF NOT 'wh_count_task' = ANY (v_values) THEN v_values := v_values || 'wh_count_task'::text; END IF;
  IF NOT 'wh_movement' = ANY (v_values) THEN v_values := v_values || 'wh_movement'::text; END IF;

  ALTER TABLE public.inventory_transactions DROP CONSTRAINT IF EXISTS chk_inv_tx_reference_shape;
  EXECUTE
    'ALTER TABLE public.inventory_transactions ADD CONSTRAINT chk_inv_tx_reference_shape CHECK ('
    || '(reference_id IS NULL AND reference_type IS NULL) OR '
    || '(reference_id IS NOT NULL AND reference_type IS NOT NULL AND reference_type = ANY (ARRAY['
    || (SELECT string_agg(quote_literal(v), ', ') FROM unnest(v_values) AS v) || ']::text[])))';
END $$;

COMMIT;
