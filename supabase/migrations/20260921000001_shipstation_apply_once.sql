-- =============================================================
-- ShipStation sale apply: the ledger follows the lines, exactly once
-- =============================================================
-- Finding 2026-09-21: rpc_apply_shipstation_sale deducted every RESOLVED
-- line as it looped, and only afterwards noticed an unknown code on the
-- order. With an unknown code it left inventory_applied_at NULL and
-- rolled nothing back, so every retry (reconcile, up to 6 tries; webhook,
-- uncapped) deducted the good lines AGAIN. Measured on the 117 orders
-- blocked that day: 116 units should have left stock once, the ledger
-- shows 688 (one line 12 times). The same trap sat behind
-- rpc_shipstation_unregister_sku_alias, which re-opens an already-applied
-- order on the (then false) premise that re-applying is safe.
--
-- Owner decision 2026-09-21: only the unknown line waits. The recognized
-- lines of an order deduct exactly once, straight away.
--
-- THE RULE (rev 2, 2026-09-23), implemented everywhere:
--   for every (order, sku) the ledger's net order_shipped quantity for
--   that order+sku equals the order's CURRENT resolved line quantity.
--   Lines say more than the ledger -> deduct the difference.
--   Lines say less (line reduced, removed, or re-pointed) -> credit the
--   difference back, never below net zero for the pair.
--   No lines to compare against -> stock is not touched.
--
-- A. rpc_apply_shipstation_sale — idempotent from the LEDGER.
--    Per (order, sku):
--      target  = units of that sku on the order (DISTINCT ON line-item id,
--                so a line re-ingested twice in the same second counts once;
--                seen in prod on 292321 / 292322, 2026-08-17)
--      already = SUM(-quantity) of this order's ledger rows for the sku
--                (transaction_type order_shipped, plus the bookkeeping
--                shipstation_ledger_rebase rows written once by section E)
--      delta   = target - already
--    delta > 0  -> deduct delta (rev-1 path, unchanged: oversell warning +
--                  negative-allowed policy, one order_shipped row).
--    delta < 0  -> credit |delta| back: warehouse_finished += |delta|, one
--                  POSITIVE order_shipped row, same reference, note
--                  'ShipStation order X: +N units (line reduced/removed)'.
--                  Orphan pairs (ledger rows for a sku with no current
--                  line) are visited the same way and credited in full.
--    delta = 0  -> nothing (already_deducted).
--    The ledger is the only safe memory: shipstation_order_items is
--    deleted + re-inserted on every re-ingest, inventory_transactions is
--    append-only (update/delete blocked by trigger).
--
--    Before classifying, the RPC RE-RESOLVES lines still carrying
--    sku_id NULL with the resolver's steps 1-2 (alias, then catalog, both
--    case-insensitive; a code registered non-inventory never resolves), so
--    a product added to the catalog or an alias registered by direct SQL
--    un-parks the order on the next reconcile without a re-ingest. The
--    prefix rule stays in the edge resolver only.
--
--    The lines are read in ONE statement (single snapshot) into a jsonb
--    value; classification and the pair loop work from that snapshot.
--
--    Zero item rows while raw_payload->'items' still holds a trackable
--    line (non-empty sku, quantity > 0, code not registered non-inventory)
--    means the ingest is incomplete: the order is parked with
--    'line items not ingested' and NOT stamped. Zero rows and nothing
--    trackable in the payload stamps as before (nothing to deduct).
--
--    Non-inventory codes match case-insensitively (lower(sku_code)).
--
--    Parked orders no longer bump inventory_apply_attempts on every run:
--    the error text carries the sorted unresolved code set, and the
--    counter (and the row) is only written when that text changes — i.e.
--    on the first parked run and whenever the unresolved set changes.
--    (~137 parked orders x 48 reconcile runs/day were 6.6k no-op updates.)
--
--    A NULL raw_payload with zero item rows is treated as "not ingested"
--    whenever the ledger still holds units for the order (park, never
--    credit on the strength of a missing payload).
--
--    CANCELLED orders (rev 3): target is 0 for every sku, so a call credits
--    whatever the ledger still holds for the order and never stamps it (a
--    restored + shipped order then applies through the normal gate and
--    deducts exactly its lines). The edge functions never call the RPC for
--    cancelled orders, so nothing changes automatically; this only makes a
--    direct call safe and coherent with section E's rule. Whether a
--    cancellation should credit stock back automatically is an open owner
--    decision (today: the deduction stays until a cycle count or a re-run
--    of the correction script).
--
--    Unchanged: pre-bootstrap skip, already_applied short-circuit, order-row
--    FOR UPDATE (serializes every applier of one order, so the ledger read
--    can never race), SECURITY DEFINER + search_path, return keys.
--    New return keys: already_deducted, oversells, credited, credited_units,
--    reresolved, attempts_bumped (and error when parked, cancelled when
--    the order is cancelled).
--
-- B. rpc_shipstation_unregister_sku_alias — credits under the same locks.
--    The lock set is every order carrying the code (any sku_id), taken
--    BEFORE the item reset, so an apply that resolves a NULL line through
--    the alias while we run is serialized and its result is seen. Then,
--    for every (order, old_sku) it un-resolves: target_remaining = lines on
--    that order still resolving to old_sku; if the ledger holds more, the
--    difference is credited right there (order row + level row locked, one
--    positive order_shipped row per pair, note '(alias X removed)'), so the
--    ledger is consistent even if no apply ever runs again. Only orders
--    whose items were actually reset are re-opened (inventory_applied_at
--    NULL, attempts 0) so the next reconcile deducts whatever the code
--    resolves to next. Absorbed-by-count orders (E2) carry rebase rows
--    that net their pairs to the lines, so a re-open never deducts them.
--
-- C. rpc_shipstation_register_sku_alias /
--    rpc_shipstation_register_non_inventory_sku — un-park the orders.
--    Both normalise p_sku_code to the exact spelling found on pending
--    items (case variants of the same code collapse to one handling row),
--    reset inventory_apply_attempts on the unapplied shipped /
--    awaiting_shipment orders carrying the code and report that count as
--    orders_requeued; the next reconcile run (<= 30 min) applies them.
--
-- D. Views shipstation_unresolved_skus / shipstation_unresolved_skus_pending
--    match the handling table case-insensitively and only show codes on
--    orders that can still apply (shipped / awaiting_shipment, not yet
--    applied), so codes living only on cancelled or applied orders leave
--    the queue.
--
-- E. One-time data steps (run inside this migration, no stock change):
--    E1. bulk re-resolution of NULL lines on unapplied orders (same rule
--        as A) so E2/E3 see the current picture;
--    E2. ABSORBED BY COUNT: unapplied, SHIPPED, post-bootstrap orders whose
--        lines are all resolved and whose ship date (order date if null)
--        precedes the most recent QUALIFYING warehouse_finished cycle count
--        of EVERY owed sku are stamped applied with one metadata row
--        (shipstation_absorbed_by_count) — the physical count already
--        reflects those units, deducting them now would double-count.
--        QUALIFYING = |count delta| >= c_min_reset_abs_delta, THE SAME KNOB
--        the owner approves for shipstation_overdeduct_correction.sql (the
--        two must agree; the constant sits at the top of the DO block and
--        the E2 NOTICE prints what the other knob would have absorbed).
--        Shipped only: an awaiting_shipment order's units are still on the
--        shelf when counted, so a count cannot have absorbed them.
--        Each absorbed (order, sku) pair also gets one NEGATIVE
--        shipstation_ledger_rebase row (quantity = -owed, metadata, stock
--        untouched) so the pair nets its lines: if an alias unregister ever
--        re-opens the order, rule A finds nothing to deduct.
--        Measured 2026-09-24 (rolled-back run), knob 1: 24 orders / 25
--        units, all LS01-BW20 / LS01-BW20DNA / LS01-BW68 / LS01-NB2 plus one
--        NB2 (287425); knob 5: 11 orders / 12 units (the 13 orders resting
--        on +1/+3 counts then apply normally on the first reconcile).
--        286361 (NB5, shipped 07-03) is NOT absorbed under either knob: the
--        last NB5 count (06-09) precedes its ship date.
--    E3. LEDGER REBASE: every (order, sku) pair whose ledger holds MORE than
--        the rule allows (lines for live orders, nothing for cancelled
--        orders) gets one metadata row (shipstation_ledger_rebase, positive
--        quantity, movement_kind metadata, so stock does not move) that
--        brings the pair's net to the rule. Without it, rule A would credit
--        ~598 units of pre-fix retry excess on the next reconcile — blind to
--        the cycle counts that already absorbed most of it, and on top of
--        the separate SKU-level correction (shipstation_overdeduct_correction,
--        owner-approved, count-aware). Measured 2026-09-23: 455 pairs /
--        1,484 units, all bookkeeping. The correction script ignores these
--        metadata rows. Cancelled orders whose pairs are rebased here are
--        also UN-STAMPED (inventory_applied_at NULL): the reconcile ignores
--        cancelled orders, so nothing churns, and a later restore + ship
--        applies through the normal gate and deducts exactly its lines
--        instead of short-circuiting on a stale stamp.
--
-- DEPLOY ORDER: apply this migration BEFORE deploying the uncapped
-- reconcile function (supabase/functions/shipstation-reconcile, Stage 3
-- `< 6` filter removed). The old RPC under uncapped retries would
-- re-deduct every parked order's recognized lines every run. The
-- migration is safe with the OLD reconcile still deployed (it simply
-- never retries orders past 6 attempts until the new build is live).
-- Deploy the reconcile function right after, then the webhook (rev 3:
-- it no longer replaces the line items of an applied order and fails the
-- event, for replay, when the item insert errors).
-- The E block holds FOR UPDATE on every unapplied order (~190 rows) for a
-- few seconds; push between reconcile runs (cron */30, each ~15-40 s at
-- :00 / :30).
--
-- Triage done by direct SQL (no RPC) no longer needs to touch item rows:
-- add the alias / product and the next reconcile re-resolves and applies.
-- =============================================================


-- -------------------------------------------------------------
-- A0. helpers (internal — not callable through PostgREST)
-- -------------------------------------------------------------
-- Net units the ledger says this order took for this sku. Positive =
-- deducted. Includes the section-E rebase rows (bookkeeping, no stock
-- movement) so the rule compares against what the ledger has SETTLED.
CREATE OR REPLACE FUNCTION public.shipstation_pair_ledger_net(
  p_order_id UUID,
  p_sku_id   UUID
) RETURNS INTEGER
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT COALESCE(SUM(-x.quantity), 0)::int
    FROM public.inventory_transactions x
   WHERE x.reference_type   = 'shipstation_order'
     AND x.reference_id     = p_order_id
     AND x.sku_id           = p_sku_id
     AND x.transaction_type IN ('order_shipped', 'shipstation_ledger_rebase');
$$;
REVOKE ALL ON FUNCTION public.shipstation_pair_ledger_net(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.shipstation_pair_ledger_net(UUID, UUID) TO service_role;

-- Credit p_units back to warehouse_finished for one (order, sku) pair and
-- write the positive order_shipped row. Caller decides the amount (never
-- more than the pair's net) and holds the order-row lock.
CREATE OR REPLACE FUNCTION public.shipstation_credit_pair(
  p_order_id UUID,
  p_sku_id   UUID,
  p_units    INTEGER,
  p_notes    TEXT,
  p_actor    UUID
) RETURNS INTEGER
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_rows INTEGER;
BEGIN
  IF p_units IS NULL OR p_units <= 0 THEN
    RETURN 0;
  END IF;

  PERFORM 1 FROM public.inventory_levels WHERE sku_id = p_sku_id ORDER BY id FOR UPDATE;

  UPDATE public.inventory_levels
     SET warehouse_finished = COALESCE(warehouse_finished, 0) + p_units
   WHERE sku_id = p_sku_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'shipstation_credit_pair: expected 1 inventory_levels row for sku %, found %', p_sku_id, v_rows;
  END IF;

  INSERT INTO public.inventory_transactions (
    sku_id, transaction_type, quantity, field_affected,
    movement_kind, reference_id, reference_type, notes, performed_by
  ) VALUES (
    p_sku_id, 'order_shipped', p_units, 'warehouse_finished',
    'net_change', p_order_id, 'shipstation_order', p_notes, p_actor
  );
  RETURN p_units;
END;
$$;
REVOKE ALL ON FUNCTION public.shipstation_credit_pair(UUID, UUID, INTEGER, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.shipstation_credit_pair(UUID, UUID, INTEGER, TEXT, UUID) TO service_role;


-- -------------------------------------------------------------
-- A. rpc_apply_shipstation_sale
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_apply_shipstation_sale(
  p_order_id        UUID,
  p_system_actor_id UUID DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
  v_order             public.shipstation_orders%ROWTYPE;
  v_lines             JSONB;           -- single-snapshot line set
  v_pair              RECORD;
  v_available         INTEGER;
  v_delta             INTEGER;
  v_credit            INTEGER;
  v_applied           INTEGER := 0;    -- skus deducted by THIS call
  v_already_deducted  INTEGER := 0;    -- skus the ledger already covers
  v_credited          INTEGER := 0;    -- skus credited back by THIS call
  v_credited_units    INTEGER := 0;
  v_unresolved        INTEGER := 0;    -- unknown codes (these block the stamp)
  v_unresolved_codes  TEXT;
  v_skipped           INTEGER := 0;    -- non-inventory codes
  v_oversells         INTEGER := 0;
  v_reresolved        INTEGER := 0;    -- lines resolved by this call
  v_payload_trackable INTEGER := 0;
  v_new_error         TEXT;
  v_bumped            BOOLEAN := false;
  -- Bootstrap date — when this system started ingesting ShipStation
  -- orders. Anything older is skipped (migration 20260513000001).
  v_bootstrap_cutoff  DATE := '2026-05-05';
BEGIN
  -- The order-row lock serializes every applier of the same order, so the
  -- ledger read below can never race another apply of this order.
  SELECT * INTO v_order FROM public.shipstation_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'order not found');
  END IF;
  IF v_order.inventory_applied_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'already_applied', true);
  END IF;

  -- Pre-bootstrap cutoff. Mark the order as handled (so cron stops
  -- retrying it) but don't touch inventory. Single audit row records
  -- the skip with enough context to reconstruct what happened later.
  IF v_order.order_date::date < v_bootstrap_cutoff THEN
    UPDATE public.shipstation_orders
       SET inventory_applied_at      = now(),
           inventory_apply_attempts  = inventory_apply_attempts + 1,
           inventory_apply_error     = NULL
     WHERE id = p_order_id;

    INSERT INTO public.inventory_transactions (
      sku_id, transaction_type, quantity, field_affected,
      movement_kind, reference_id, reference_type, notes, performed_by
    ) VALUES (
      NULL, 'shipstation_pre_bootstrap_skip', 0, 'warehouse_finished',
      'metadata', p_order_id, 'shipstation_order',
      format(
        'ShipStation order %s (placed %s): skipped — predates system bootstrap (%s). Inventory was managed elsewhere at the time; deducting now would double-count.',
        v_order.order_number,
        v_order.order_date::date,
        v_bootstrap_cutoff
      ),
      p_system_actor_id
    );

    RETURN jsonb_build_object(
      'ok',                    true,
      'skipped_pre_bootstrap', true,
      'applied',               0,
      'unresolved',            0,
      'skipped',               0,
      'already_deducted',      0,
      'oversells',             0,
      'credited',              0,
      'credited_units',        0,
      'reresolved',            0,
      'attempts_bumped',       true
    );
  END IF;

  -- Re-resolve lines still unknown to the ingest: resolver steps 1-2
  -- (alias, then catalog), case-insensitive. A code registered
  -- non-inventory never resolves (same precedence as the edge resolver).
  -- Touches only rows that actually gain a sku_id.
  UPDATE public.shipstation_order_items i
     SET sku_id = COALESCE(
           (SELECT h.resolved_sku_id
              FROM public.shipstation_sku_handling h
             WHERE lower(h.sku_code) = lower(i.sku_code)
               AND NOT h.is_non_inventory
               AND h.resolved_sku_id IS NOT NULL
             ORDER BY (h.sku_code = i.sku_code) DESC, h.added_at DESC
             LIMIT 1),
           (SELECT ps.id
              FROM public.product_skus ps
             WHERE lower(ps.sku) = lower(i.sku_code)
             ORDER BY (ps.sku = i.sku_code) DESC, ps.sku
             LIMIT 1))
   WHERE i.shipstation_order_id = p_order_id
     AND i.sku_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.shipstation_sku_handling h
                      WHERE lower(h.sku_code) = lower(i.sku_code) AND h.is_non_inventory)
     AND (EXISTS (SELECT 1 FROM public.shipstation_sku_handling h
                   WHERE lower(h.sku_code) = lower(i.sku_code)
                     AND NOT h.is_non_inventory AND h.resolved_sku_id IS NOT NULL)
          OR EXISTS (SELECT 1 FROM public.product_skus ps
                      WHERE lower(ps.sku) = lower(i.sku_code)));
  GET DIAGNOSTICS v_reresolved = ROW_COUNT;

  -- ONE read of the lines (single snapshot). One row per ShipStation
  -- line-item id: see header, duplicate re-ingest.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'sku_id', l.sku_id, 'sku_code', l.sku_code, 'quantity', l.quantity)), '[]'::jsonb)
    INTO v_lines
    FROM (
      SELECT DISTINCT ON (COALESCE(i.shipstation_line_item_id::text, i.id::text))
             i.sku_id, i.sku_code, i.quantity
        FROM public.shipstation_order_items i
       WHERE i.shipstation_order_id = p_order_id
       ORDER BY COALESCE(i.shipstation_line_item_id::text, i.id::text),
                i.created_at DESC, i.id
    ) l;

  -- No item rows at all: only safe to stamp when the payload has nothing
  -- trackable either. Otherwise the ingest is incomplete — park, never
  -- stamp (a stamp would freeze the order with nothing deducted). A NULL
  -- payload says nothing either way: if the ledger still holds units for
  -- the order, park rather than credit them on a missing payload.
  -- A cancelled order owes nothing, so its (empty) lines are the answer.
  IF jsonb_array_length(v_lines) = 0 AND v_order.order_status <> 'cancelled' THEN
    IF v_order.raw_payload IS NULL THEN
      SELECT count(*) INTO v_payload_trackable
        FROM (SELECT x.sku_id
                FROM public.inventory_transactions x
               WHERE x.reference_type   = 'shipstation_order'
                 AND x.reference_id     = p_order_id
                 AND x.sku_id           IS NOT NULL
                 AND x.transaction_type IN ('order_shipped', 'shipstation_ledger_rebase')
               GROUP BY x.sku_id
              HAVING SUM(-x.quantity) > 0) held;
    ELSE
      SELECT count(*) INTO v_payload_trackable
        FROM jsonb_array_elements(
               CASE WHEN jsonb_typeof(v_order.raw_payload->'items') = 'array'
                    THEN v_order.raw_payload->'items' ELSE '[]'::jsonb END) it
       WHERE btrim(COALESCE(it->>'sku', '')) <> ''
         AND jsonb_typeof(it->'quantity') = 'number'
         AND (it->>'quantity')::numeric > 0
         AND NOT EXISTS (SELECT 1 FROM public.shipstation_sku_handling h
                          WHERE lower(h.sku_code) = lower(btrim(it->>'sku')) AND h.is_non_inventory);
    END IF;
    IF v_payload_trackable > 0 THEN
      v_new_error := 'line items not ingested';
      IF v_order.inventory_apply_error IS DISTINCT FROM v_new_error THEN
        UPDATE public.shipstation_orders
           SET inventory_apply_attempts = inventory_apply_attempts + 1,
               inventory_apply_error    = v_new_error
         WHERE id = p_order_id;
        v_bumped := true;
      END IF;
      RETURN jsonb_build_object(
        'ok',               false,
        'error',            v_new_error,
        'applied',          0,
        'unresolved',       0,
        'skipped',          0,
        'already_deducted', 0,
        'oversells',        0,
        'credited',         0,
        'credited_units',   0,
        'reresolved',       v_reresolved,
        'attempts_bumped',  v_bumped
      );
    END IF;
  END IF;

  -- Lines that cannot deduct: non-inventory codes are skipped, unknown
  -- codes block the order-level stamp (and nothing else).
  SELECT count(*) FILTER (WHERE h.sku_code IS NOT NULL),
         count(*) FILTER (WHERE h.sku_code IS NULL),
         left(string_agg(DISTINCT l.sku_code, ', ' ORDER BY l.sku_code)
                FILTER (WHERE h.sku_code IS NULL), 400)
    INTO v_skipped, v_unresolved, v_unresolved_codes
    FROM jsonb_to_recordset(v_lines) AS l(sku_id UUID, sku_code TEXT, quantity INTEGER)
    LEFT JOIN LATERAL (
      SELECT h.sku_code
        FROM public.shipstation_sku_handling h
       WHERE lower(h.sku_code) = lower(l.sku_code) AND h.is_non_inventory
       LIMIT 1
    ) h ON true
   WHERE l.sku_id IS NULL;

  -- A cancelled order has nothing to resolve: its target is 0 everywhere.
  IF v_order.order_status = 'cancelled' THEN
    v_unresolved := 0;
    v_unresolved_codes := NULL;
  END IF;

  -- Every (order, sku) pair the rule governs: skus on the lines UNION skus
  -- the ledger already holds for this order (orphans). One pass per sku,
  -- in sku_id order, so every applier takes its inventory_levels locks in
  -- the same order (no deadlocks).
  FOR v_pair IN
    WITH lines AS (
      SELECT * FROM jsonb_to_recordset(v_lines) AS l(sku_id UUID, sku_code TEXT, quantity INTEGER)
    ),
    targets AS (
      SELECT l.sku_id, SUM(l.quantity)::int AS target
        FROM lines l
       WHERE l.sku_id IS NOT NULL
         AND v_order.order_status <> 'cancelled'   -- cancelled: target 0 for every sku
       GROUP BY l.sku_id
    ),
    ledger AS (
      SELECT x.sku_id, SUM(-x.quantity)::int AS already
        FROM public.inventory_transactions x
       WHERE x.reference_type   = 'shipstation_order'
         AND x.reference_id     = p_order_id
         AND x.sku_id           IS NOT NULL
         AND x.transaction_type IN ('order_shipped', 'shipstation_ledger_rebase')
       GROUP BY x.sku_id
    )
    SELECT COALESCE(t.sku_id, g.sku_id) AS sku_id,
           COALESCE(t.target, 0)        AS target,
           COALESCE(g.already, 0)       AS already,
           ps.sku
      FROM targets t
      FULL OUTER JOIN ledger g ON g.sku_id = t.sku_id
      LEFT JOIN public.product_skus ps ON ps.id = COALESCE(t.sku_id, g.sku_id)
     ORDER BY 1
  LOOP
    v_delta := v_pair.target - v_pair.already;

    -- The ledger already covers this sku for this order exactly.
    IF v_delta = 0 THEN
      IF v_pair.target > 0 THEN
        v_already_deducted := v_already_deducted + 1;
      END IF;
      CONTINUE;
    END IF;

    -- Lines say LESS than the ledger (quantity reduced, line removed, or
    -- the code re-pointed to another sku): give the difference back.
    -- Never below net zero for the pair.
    IF v_delta < 0 THEN
      v_credit := LEAST(-v_delta, v_pair.already);
      IF v_credit > 0 THEN
        PERFORM public.shipstation_credit_pair(
          p_order_id, v_pair.sku_id, v_credit,
          format('ShipStation order %s: +%s units (line reduced/removed)', v_order.order_number, v_credit),
          p_system_actor_id);
        v_credited       := v_credited + 1;
        v_credited_units := v_credited_units + v_credit;
      END IF;
      CONTINUE;
    END IF;

    -- Lines say MORE than the ledger: deduct the difference (rev-1 path).
    PERFORM 1 FROM public.inventory_levels
      WHERE sku_id = v_pair.sku_id ORDER BY id FOR UPDATE;

    SELECT warehouse_finished INTO v_available
      FROM public.inventory_levels WHERE sku_id = v_pair.sku_id;

    IF COALESCE(v_available, 0) < v_delta THEN
      INSERT INTO public.inventory_transactions (
        sku_id, transaction_type, quantity, field_affected,
        movement_kind, notes, performed_by
      ) VALUES (
        v_pair.sku_id, 'shipstation_oversell_warning',
        -v_delta, 'warehouse_finished',
        'metadata',
        format('%s: oversold on ShipStation order %s — available %s, sold %s. Requires cycle-count correction.',
          v_pair.sku, v_order.order_number, COALESCE(v_available, 0), v_delta),
        p_system_actor_id
      );
      v_oversells := v_oversells + 1;
      -- intentional fallthrough: still decrement (negative-allowed policy)
    END IF;

    UPDATE public.inventory_levels
       SET warehouse_finished = warehouse_finished - v_delta
     WHERE sku_id = v_pair.sku_id;

    INSERT INTO public.inventory_transactions (
      sku_id, transaction_type, quantity, field_affected,
      movement_kind, reference_id, reference_type, notes, performed_by
    ) VALUES (
      v_pair.sku_id, 'order_shipped', -v_delta, 'warehouse_finished',
      'net_change', p_order_id, 'shipstation_order',
      format('ShipStation order %s: -%s units', v_order.order_number, v_delta)
        || CASE WHEN v_pair.already > 0
                THEN format(' (top-up: order has %s, %s already deducted)',
                            v_pair.target, v_pair.already)
                ELSE '' END,
      p_system_actor_id
    );
    v_applied := v_applied + 1;
  END LOOP;

  IF v_order.order_status = 'cancelled' THEN
    -- Never stamp a cancelled order: a restore + ship must apply through
    -- the normal gate (already = 0 after the credits above -> deducts the
    -- lines exactly once). The reconcile skips cancelled orders, so an
    -- un-stamped cancelled order causes no churn.
    NULL;
  ELSIF v_unresolved = 0 THEN
    UPDATE public.shipstation_orders
       SET inventory_applied_at      = now(),
           inventory_apply_error     = NULL,
           inventory_apply_attempts  = inventory_apply_attempts + 1
     WHERE id = p_order_id;
    v_bumped := true;
  ELSE
    -- Parked. The error text carries the sorted unresolved set; the row
    -- (and the attempts counter) is only written when that set changes.
    v_new_error := format('%s line item(s) have unresolved SKU codes: %s',
                          v_unresolved, v_unresolved_codes);
    IF v_order.inventory_apply_error IS DISTINCT FROM v_new_error THEN
      UPDATE public.shipstation_orders
         SET inventory_apply_attempts  = inventory_apply_attempts + 1,
             inventory_apply_error     = v_new_error
       WHERE id = p_order_id;
      v_bumped := true;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok',               v_unresolved = 0,
    'applied',          v_applied,
    'unresolved',       v_unresolved,
    'skipped',          v_skipped,
    'already_deducted', v_already_deducted,
    'oversells',        v_oversells,
    'credited',         v_credited,
    'credited_units',   v_credited_units,
    'reresolved',       v_reresolved,
    'attempts_bumped',  v_bumped
  ) || CASE WHEN v_unresolved = 0 THEN '{}'::jsonb
            ELSE jsonb_build_object('error', v_new_error) END
    || CASE WHEN v_order.order_status = 'cancelled' THEN jsonb_build_object('cancelled', true)
            ELSE '{}'::jsonb END;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ACL is deliberately unchanged (CREATE OR REPLACE keeps owner + grants;
-- this restates the explicit grants from the baseline so a rebuilt
-- environment matches prod).
GRANT EXECUTE ON FUNCTION public.rpc_apply_shipstation_sale(UUID, UUID)
  TO anon, authenticated, service_role;


-- -------------------------------------------------------------
-- B. rpc_shipstation_unregister_sku_alias — credit back, then re-open
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_shipstation_unregister_sku_alias(
  p_sku_code TEXT
) RETURNS JSONB AS $$
DECLARE
  v_actor           UUID := auth.uid();
  v_role            TEXT;
  v_existing        public.shipstation_sku_handling%ROWTYPE;
  v_reset_rows      INT := 0;
  v_orders          UUID[];
  v_reset_orders    UUID[];
  v_oid             UUID;
  v_o               public.shipstation_orders%ROWTYPE;
  v_target          INT;
  v_already         INT;
  v_credit          INT;
  v_orders_reopened INT := 0;
  v_orders_credited INT := 0;
  v_units_credited  INT := 0;
BEGIN
  SELECT role INTO v_role FROM public.profiles WHERE id = v_actor;
  IF v_role IS DISTINCT FROM 'admin' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'admin role required');
  END IF;

  SELECT * INTO v_existing
    FROM public.shipstation_sku_handling
   WHERE sku_code = p_sku_code;
  IF NOT FOUND THEN
    -- The UI passes the stored spelling; direct callers may not.
    SELECT * INTO v_existing
      FROM public.shipstation_sku_handling
     WHERE lower(sku_code) = lower(p_sku_code)
     ORDER BY sku_code
     LIMIT 1;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'error', 'sku_code not found in handling table');
    END IF;
  END IF;
  IF v_existing.is_non_inventory THEN
    -- Don't quietly nuke a non-inventory entry through the alias path.
    -- If the operator wants to retract a non-inventory designation,
    -- they should call the explicit rpc for that (or we add one later).
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'this code is registered as non-inventory, not an alias'
    );
  END IF;

  DELETE FROM public.shipstation_sku_handling WHERE sku_code = v_existing.sku_code;

  -- Every order carrying the code, whatever its lines currently resolve
  -- to. Lock their order rows FIRST (same order as the apply RPC: order
  -- row, then item rows, then level rows) so an apply running on one of
  -- them serializes with us — including one that is resolving a NULL
  -- line through this alias right now: after the lock we see its result.
  SELECT array_agg(DISTINCT i.shipstation_order_id ORDER BY i.shipstation_order_id)
    INTO v_orders
    FROM public.shipstation_order_items i
   WHERE lower(i.sku_code) = lower(v_existing.sku_code);
  v_orders := COALESCE(v_orders, '{}'::uuid[]);

  PERFORM 1 FROM public.shipstation_orders
    WHERE id = ANY (v_orders) ORDER BY id FOR UPDATE;

  -- Reset the items pinned to the removed alias back to NULL so they
  -- re-block. We can't tell after the fact which items were resolved
  -- *through* this alias vs. matched directly on product_skus.sku, so we
  -- only reset items whose code matches AND whose current sku_id matches
  -- the alias's resolved sku. Only the orders that actually lost a
  -- resolution are re-opened below.
  WITH upd AS (
    UPDATE public.shipstation_order_items
       SET sku_id = NULL
     WHERE lower(sku_code) = lower(v_existing.sku_code)
       AND sku_id = v_existing.resolved_sku_id
    RETURNING shipstation_order_id
  )
  SELECT count(*)::int, COALESCE(array_agg(DISTINCT shipstation_order_id), '{}'::uuid[])
    INTO v_reset_rows, v_reset_orders
    FROM upd;

  -- Per affected (order, old sku): the ledger may now hold more than the
  -- lines still resolving to old sku. Credit the difference back HERE,
  -- under the locks, so the ledger is consistent even if no apply ever
  -- runs again for the order. Never below net zero for the pair.
  FOREACH v_oid IN ARRAY v_orders LOOP
    SELECT * INTO v_o FROM public.shipstation_orders WHERE id = v_oid;

    SELECT COALESCE(SUM(l.quantity), 0)::int INTO v_target
      FROM (
        SELECT DISTINCT ON (COALESCE(i.shipstation_line_item_id::text, i.id::text))
               i.sku_id, i.quantity
          FROM public.shipstation_order_items i
         WHERE i.shipstation_order_id = v_oid
         ORDER BY COALESCE(i.shipstation_line_item_id::text, i.id::text),
                  i.created_at DESC, i.id
      ) l
     WHERE l.sku_id = v_existing.resolved_sku_id;

    v_already := public.shipstation_pair_ledger_net(v_oid, v_existing.resolved_sku_id);
    v_credit  := LEAST(v_already - v_target, v_already);
    IF v_credit > 0 THEN
      PERFORM public.shipstation_credit_pair(
        v_oid, v_existing.resolved_sku_id, v_credit,
        format('ShipStation order %s: +%s units (alias %s removed)',
               v_o.order_number, v_credit, v_existing.sku_code),
        v_actor);
      v_orders_credited := v_orders_credited + 1;
      v_units_credited  := v_units_credited + v_credit;
    END IF;

    -- Re-open applied orders that lost a resolution so the next reconcile
    -- deducts whatever the code resolves to next (rule A, ledger-
    -- idempotent). Orders that carry the code but resolved it elsewhere
    -- (catalog match, another alias) are left alone.
    IF v_o.inventory_applied_at IS NOT NULL AND v_oid = ANY (v_reset_orders) THEN
      UPDATE public.shipstation_orders
         SET inventory_applied_at     = NULL,
             inventory_apply_error    = format('alias %s removed; re-triage required', v_existing.sku_code),
             inventory_apply_attempts = 0
       WHERE id = v_oid;
      v_orders_reopened := v_orders_reopened + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'sku_code', v_existing.sku_code,
    'items_reset', v_reset_rows,
    'orders_reopened', v_orders_reopened,
    'orders_credited', v_orders_credited,
    'units_credited', v_units_credited
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.rpc_shipstation_unregister_sku_alias(TEXT)
  TO anon, authenticated, service_role;


-- -------------------------------------------------------------
-- C1. rpc_shipstation_register_sku_alias — normalise spelling, un-park
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_shipstation_register_sku_alias(
  p_sku_code        TEXT,
  p_resolved_sku_id UUID,
  p_notes           TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
  v_actor        UUID := auth.uid();
  v_role         TEXT;
  v_code         TEXT;
  v_updated_rows INT;
  v_requeued     INT;
BEGIN
  SELECT role INTO v_role FROM public.profiles WHERE id = v_actor;
  IF v_role NOT IN ('admin', 'manager') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'admin or manager role required');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.product_skus WHERE id = p_resolved_sku_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'p_resolved_sku_id not found in product_skus');
  END IF;

  -- Spell the code exactly as the pending items do (most frequent
  -- spelling, then most recent), so the edge resolver's exact-match step
  -- also hits it on the next ingest. Case variants collapse to one row.
  SELECT i.sku_code INTO v_code
    FROM public.shipstation_order_items i
    JOIN public.shipstation_orders o ON o.id = i.shipstation_order_id
   WHERE i.sku_id IS NULL
     AND lower(i.sku_code) = lower(btrim(p_sku_code))
     AND o.inventory_applied_at IS NULL
     AND o.order_status IN ('shipped', 'awaiting_shipment')
   GROUP BY i.sku_code
   ORDER BY count(*) DESC, max(i.created_at) DESC
   LIMIT 1;
  v_code := COALESCE(v_code, btrim(p_sku_code));

  DELETE FROM public.shipstation_sku_handling
   WHERE lower(sku_code) = lower(v_code) AND sku_code <> v_code;

  INSERT INTO public.shipstation_sku_handling (
    sku_code, resolved_sku_id, is_non_inventory, added_by, notes
  ) VALUES (
    v_code, p_resolved_sku_id, false, v_actor, p_notes
  )
  ON CONFLICT (sku_code) DO UPDATE
    SET resolved_sku_id  = p_resolved_sku_id,
        is_non_inventory = false,
        added_by         = v_actor,
        added_at         = now(),
        notes            = COALESCE(EXCLUDED.notes, public.shipstation_sku_handling.notes);

  UPDATE public.shipstation_order_items
     SET sku_id = p_resolved_sku_id
   WHERE sku_id IS NULL AND lower(sku_code) = lower(v_code);
  GET DIAGNOSTICS v_updated_rows = ROW_COUNT;

  -- Un-park. Retrying is harmless (the apply is ledger-idempotent); the
  -- reset is the belt to the uncapped reconcile's suspender and the
  -- operator's confirmation number: these orders apply on the next run.
  SELECT count(*) INTO v_requeued
    FROM public.shipstation_orders o
   WHERE o.inventory_applied_at IS NULL
     AND o.order_status IN ('shipped', 'awaiting_shipment')
     AND EXISTS (
       SELECT 1 FROM public.shipstation_order_items i
        WHERE i.shipstation_order_id = o.id
          AND lower(i.sku_code) = lower(v_code)
     );

  UPDATE public.shipstation_orders o
     SET inventory_apply_attempts = 0
   WHERE o.inventory_applied_at IS NULL
     AND o.order_status IN ('shipped', 'awaiting_shipment')
     AND o.inventory_apply_attempts <> 0
     AND EXISTS (
       SELECT 1 FROM public.shipstation_order_items i
        WHERE i.shipstation_order_id = o.id
          AND lower(i.sku_code) = lower(v_code)
     );

  RETURN jsonb_build_object(
    'ok', true,
    'sku_code', v_code,
    'kind', 'alias',
    'resolved_sku_id', p_resolved_sku_id,
    'existing_items_updated', v_updated_rows,
    'orders_requeued', v_requeued
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.rpc_shipstation_register_sku_alias(TEXT, UUID, TEXT)
  TO anon, authenticated, service_role;


-- -------------------------------------------------------------
-- C2. rpc_shipstation_register_non_inventory_sku — normalise, un-park
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_shipstation_register_non_inventory_sku(
  p_sku_code TEXT,
  p_notes    TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
  v_actor    UUID := auth.uid();
  v_role     TEXT;
  v_code     TEXT;
  v_requeued INT;
BEGIN
  SELECT role INTO v_role FROM public.profiles WHERE id = v_actor;
  IF v_role IS DISTINCT FROM 'admin' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'admin role required');
  END IF;

  SELECT i.sku_code INTO v_code
    FROM public.shipstation_order_items i
    JOIN public.shipstation_orders o ON o.id = i.shipstation_order_id
   WHERE i.sku_id IS NULL
     AND lower(i.sku_code) = lower(btrim(p_sku_code))
     AND o.inventory_applied_at IS NULL
     AND o.order_status IN ('shipped', 'awaiting_shipment')
   GROUP BY i.sku_code
   ORDER BY count(*) DESC, max(i.created_at) DESC
   LIMIT 1;
  v_code := COALESCE(v_code, btrim(p_sku_code));

  DELETE FROM public.shipstation_sku_handling
   WHERE lower(sku_code) = lower(v_code) AND sku_code <> v_code;

  INSERT INTO public.shipstation_sku_handling (
    sku_code, is_non_inventory, added_by, notes
  ) VALUES (
    v_code, true, v_actor, p_notes
  )
  ON CONFLICT (sku_code) DO UPDATE
    SET is_non_inventory = true,
        resolved_sku_id  = NULL,
        added_by         = v_actor,
        added_at         = now(),
        notes            = COALESCE(EXCLUDED.notes, public.shipstation_sku_handling.notes);

  -- Un-park (same reason as the alias RPC). The items keep sku_id NULL;
  -- the apply RPC counts them as skipped now that the code is
  -- non-inventory, so the order can stamp on the next reconcile run.
  SELECT count(*) INTO v_requeued
    FROM public.shipstation_orders o
   WHERE o.inventory_applied_at IS NULL
     AND o.order_status IN ('shipped', 'awaiting_shipment')
     AND EXISTS (
       SELECT 1 FROM public.shipstation_order_items i
        WHERE i.shipstation_order_id = o.id
          AND lower(i.sku_code) = lower(v_code)
     );

  UPDATE public.shipstation_orders o
     SET inventory_apply_attempts = 0
   WHERE o.inventory_applied_at IS NULL
     AND o.order_status IN ('shipped', 'awaiting_shipment')
     AND o.inventory_apply_attempts <> 0
     AND EXISTS (
       SELECT 1 FROM public.shipstation_order_items i
        WHERE i.shipstation_order_id = o.id
          AND lower(i.sku_code) = lower(v_code)
     );

  RETURN jsonb_build_object(
    'ok', true,
    'sku_code', v_code,
    'kind', 'non_inventory',
    'orders_requeued', v_requeued
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.rpc_shipstation_register_non_inventory_sku(TEXT, TEXT)
  TO anon, authenticated, service_role;


-- -------------------------------------------------------------
-- D. Unresolved-queue views — case-insensitive, live orders only
-- -------------------------------------------------------------
-- Column lists and order are unchanged (CREATE OR REPLACE VIEW requires
-- it; ACLs are kept).
CREATE OR REPLACE VIEW public.shipstation_unresolved_skus AS
 SELECT i.sku_code,
        count(*)            AS line_item_count,
        sum(i.quantity)     AS total_units,
        min(o.order_date)   AS first_seen,
        max(o.order_date)   AS last_seen,
        count(DISTINCT o.id) AS distinct_orders
   FROM public.shipstation_order_items i
   JOIN public.shipstation_orders o ON o.id = i.shipstation_order_id
  WHERE i.sku_id IS NULL
    AND o.inventory_applied_at IS NULL
    AND o.order_status IN ('shipped', 'awaiting_shipment')
    AND NOT EXISTS (
      SELECT 1 FROM public.shipstation_sku_handling h
       WHERE lower(h.sku_code) = lower(i.sku_code) AND h.is_non_inventory)
  GROUP BY i.sku_code
  ORDER BY count(*) DESC;

CREATE OR REPLACE VIEW public.shipstation_unresolved_skus_pending AS
 SELECT i.sku_code,
        count(*)             AS line_item_count,
        sum(i.quantity)      AS total_units,
        count(DISTINCT o.id) AS distinct_orders,
        min(o.order_date)    AS first_seen,
        max(o.order_date)    AS last_seen
   FROM public.shipstation_order_items i
   JOIN public.shipstation_orders o ON o.id = i.shipstation_order_id
  WHERE i.sku_id IS NULL
    AND o.inventory_applied_at IS NULL
    AND o.order_status IN ('shipped', 'awaiting_shipment')
    AND NOT EXISTS (
      SELECT 1 FROM public.shipstation_sku_handling h
       WHERE lower(h.sku_code) = lower(i.sku_code))
  GROUP BY i.sku_code
  ORDER BY count(*) DESC;


-- -------------------------------------------------------------
-- E. One-time data steps (no stock movement)
-- -------------------------------------------------------------
DO $mig$
DECLARE
  c_actor   CONSTANT UUID := '00000000-0000-0000-0000-000000000001';
  c_cutoff  CONSTANT DATE := '2026-05-05';
  -- E2 knob: a warehouse_finished cycle_count counts as a reset only when
  -- |delta| >= this. MUST EQUAL c_min_reset_abs_delta in
  -- shipstation_overdeduct_correction.sql (owner decision: 1 = any count,
  -- 5 = ignore +1..+4 tweaks). The stamp E2 writes is permanent.
  c_min_reset_abs_delta CONSTANT INT := 1;
  c_other_knob          CONSTANT INT := CASE WHEN c_min_reset_abs_delta = 1 THEN 5 ELSE 1 END;
  r          RECORD;
  v_now      TIMESTAMPTZ := now();
  v_n        INT;
  v_orders   INT := 0;
  v_units    INT := 0;
  v_apairs   INT := 0;
  v_pairs    INT := 0;
  v_runits   INT := 0;
  v_unstamp  INT := 0;
  v_o_orders INT := 0;
  v_o_units  INT := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = c_actor) THEN
    RAISE EXCEPTION '20260921000001: system actor % not found in profiles', c_actor;
  END IF;

  -- Serialize with any apply/webhook running right now: the old RPC can
  -- only touch unapplied orders, so holding those rows makes the
  -- derivations below exact for everything it could reach.
  PERFORM 1 FROM public.shipstation_orders
    WHERE inventory_applied_at IS NULL ORDER BY id FOR UPDATE;

  ---------------------------------------------------------------
  -- E1. bulk re-resolution (same rule as the RPC), unapplied orders
  ---------------------------------------------------------------
  UPDATE public.shipstation_order_items i
     SET sku_id = COALESCE(
           (SELECT h.resolved_sku_id
              FROM public.shipstation_sku_handling h
             WHERE lower(h.sku_code) = lower(i.sku_code)
               AND NOT h.is_non_inventory
               AND h.resolved_sku_id IS NOT NULL
             ORDER BY (h.sku_code = i.sku_code) DESC, h.added_at DESC
             LIMIT 1),
           (SELECT ps.id
              FROM public.product_skus ps
             WHERE lower(ps.sku) = lower(i.sku_code)
             ORDER BY (ps.sku = i.sku_code) DESC, ps.sku
             LIMIT 1))
   WHERE i.sku_id IS NULL
     AND EXISTS (SELECT 1 FROM public.shipstation_orders o
                  WHERE o.id = i.shipstation_order_id AND o.inventory_applied_at IS NULL)
     AND NOT EXISTS (SELECT 1 FROM public.shipstation_sku_handling h
                      WHERE lower(h.sku_code) = lower(i.sku_code) AND h.is_non_inventory)
     AND (EXISTS (SELECT 1 FROM public.shipstation_sku_handling h
                   WHERE lower(h.sku_code) = lower(i.sku_code)
                     AND NOT h.is_non_inventory AND h.resolved_sku_id IS NOT NULL)
          OR EXISTS (SELECT 1 FROM public.product_skus ps
                      WHERE lower(ps.sku) = lower(i.sku_code)));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE '20260921000001 E1: % line(s) re-resolved on unapplied orders', v_n;

  ---------------------------------------------------------------
  -- shared derivation: one row per ShipStation line, per pair target,
  -- per pair ledger net (order_shipped + rebase rows)
  ---------------------------------------------------------------
  CREATE TEMP TABLE _ss_lines ON COMMIT DROP AS
    SELECT DISTINCT ON (i.shipstation_order_id, COALESCE(i.shipstation_line_item_id::text, i.id::text))
           i.shipstation_order_id AS order_id, i.sku_id, i.sku_code, i.quantity
      FROM public.shipstation_order_items i
     ORDER BY i.shipstation_order_id, COALESCE(i.shipstation_line_item_id::text, i.id::text),
              i.created_at DESC, i.id;

  CREATE TEMP TABLE _ss_target ON COMMIT DROP AS
    SELECT order_id, sku_id, SUM(quantity)::int AS target
      FROM _ss_lines WHERE sku_id IS NOT NULL GROUP BY 1, 2;

  CREATE TEMP TABLE _ss_ledger ON COMMIT DROP AS
    SELECT x.reference_id AS order_id, x.sku_id, SUM(-x.quantity)::int AS already
      FROM public.inventory_transactions x
     WHERE x.reference_type = 'shipstation_order'
       AND x.sku_id IS NOT NULL
       AND x.transaction_type IN ('order_shipped', 'shipstation_ledger_rebase')
     GROUP BY 1, 2;

  -- Last QUALIFYING warehouse_finished cycle count per sku, under the
  -- applied knob and the other one (for the NOTICE only).
  CREATE TEMP TABLE _ss_lastcc ON COMMIT DROP AS
    SELECT k.knob, t.sku_id, max(t.created_at) AS last_cc_at
      FROM (VALUES (c_min_reset_abs_delta), (c_other_knob)) k(knob)
      CROSS JOIN public.inventory_transactions t
     WHERE t.transaction_type = 'cycle_count'
       AND t.field_affected   = 'warehouse_finished'
       AND abs(t.quantity)   >= k.knob
     GROUP BY 1, 2;

  ---------------------------------------------------------------
  -- E2. absorbed by count
  ---------------------------------------------------------------
  -- Candidate orders and their owed pairs, per knob. An order is absorbed
  -- under a knob when EVERY owed sku has a qualifying count after the
  -- order's effective date.
  CREATE TEMP TABLE _ss_absorb_pairs ON COMMIT DROP AS
    WITH cand AS (
      SELECT o.id, o.order_number, COALESCE(o.ship_date, o.order_date) AS eff_date
        FROM public.shipstation_orders o
       WHERE o.inventory_applied_at IS NULL
         -- Only SHIPPED orders: a count can only have absorbed units that
         -- physically left. An awaiting_shipment / on_hold order's units are
         -- still on the shelf when it is counted, so stamping it here would
         -- suppress its legitimate deduction when it ships. (2026-09-24: every
         -- live unapplied order is shipped, so this changes nothing today.)
         AND o.order_status = 'shipped'
         AND o.order_date::date >= c_cutoff
         AND EXISTS (SELECT 1 FROM _ss_lines l WHERE l.order_id = o.id)
         AND NOT EXISTS (
           SELECT 1 FROM _ss_lines l
            WHERE l.order_id = o.id AND l.sku_id IS NULL
              AND NOT EXISTS (SELECT 1 FROM public.shipstation_sku_handling h
                               WHERE lower(h.sku_code) = lower(l.sku_code) AND h.is_non_inventory))
    ),
    owed AS (
      SELECT k.knob, c.id AS order_id, c.order_number, c.eff_date, t.sku_id, ps.sku,
             t.target - COALESCE(g.already, 0) AS owed, cc.last_cc_at
        FROM (VALUES (c_min_reset_abs_delta), (c_other_knob)) k(knob)
        CROSS JOIN cand c
        JOIN _ss_target t ON t.order_id = c.id
        LEFT JOIN _ss_ledger g ON g.order_id = c.id AND g.sku_id = t.sku_id
        JOIN public.product_skus ps ON ps.id = t.sku_id
        LEFT JOIN _ss_lastcc cc ON cc.knob = k.knob AND cc.sku_id = t.sku_id
       WHERE t.target > COALESCE(g.already, 0)
    )
    SELECT w.*
      FROM owed w
     WHERE (w.knob, w.order_id) IN (
       SELECT knob, order_id FROM owed
        GROUP BY knob, order_id
       HAVING bool_and(last_cc_at IS NOT NULL AND last_cc_at > eff_date));

  CREATE TEMP TABLE _ss_absorb ON COMMIT DROP AS
    SELECT w.knob, w.order_id AS id, w.order_number, w.eff_date,
           SUM(w.owed)::int AS units,
           string_agg(format('%s x%s (last warehouse_finished count with |delta| >= %s: %s)',
                             w.sku, w.owed, w.knob,
                             to_char(w.last_cc_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') || 'Z'),
                      '; ' ORDER BY w.sku) AS detail
      FROM _ss_absorb_pairs w
     GROUP BY w.knob, w.order_id, w.order_number, w.eff_date;

  FOR r IN
    SELECT * FROM _ss_absorb WHERE knob = c_min_reset_abs_delta ORDER BY order_number
  LOOP
    UPDATE public.shipstation_orders
       SET inventory_applied_at  = v_now,
           inventory_apply_error = NULL
     WHERE id = r.id;

    INSERT INTO public.inventory_transactions (
      sku_id, transaction_type, quantity, field_affected,
      movement_kind, reference_id, reference_type, notes, performed_by
    ) VALUES (
      NULL, 'shipstation_absorbed_by_count', 0, 'warehouse_finished',
      'metadata', r.id, 'shipstation_order',
      format('ShipStation order %s (shipped %s): %s unit(s) NOT deducted — a later warehouse_finished cycle count already reflects them, deducting now would double-count. Absorbed: %s. Order stamped applied by migration 20260921000001 (reset rule: |count delta| >= %s).',
             r.order_number, r.eff_date::date, r.units, r.detail, c_min_reset_abs_delta),
      c_actor
    );

    -- One NEGATIVE rebase row per absorbed pair so the pair nets its
    -- lines (already = target): a later re-open of this order (alias
    -- unregister) finds nothing to deduct. Metadata: stock untouched.
    INSERT INTO public.inventory_transactions (
      sku_id, transaction_type, quantity, field_affected,
      movement_kind, reference_id, reference_type, notes, performed_by
    )
    SELECT p.sku_id, 'shipstation_ledger_rebase', -p.owed, 'warehouse_finished',
           'metadata', p.order_id, 'shipstation_order',
           format('%s: ShipStation order %s ledger rebase -%s (bookkeeping only, stock unchanged). The order lists %s and nothing was ever deducted; the warehouse_finished cycle count of %s already reflects the unit(s). After this row the pair nets %s, so rpc_apply_shipstation_sale never deducts them even if the order is re-opened.',
                  p.sku, p.order_number, p.owed, p.owed,
                  to_char(p.last_cc_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') || 'Z', p.owed),
           c_actor
      FROM _ss_absorb_pairs p
     WHERE p.knob = c_min_reset_abs_delta AND p.order_id = r.id
     ORDER BY p.sku;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_apairs := v_apairs + v_n;

    v_orders := v_orders + 1;
    v_units  := v_units + r.units;
    RAISE NOTICE '20260921000001 E2: absorbed order % (shipped %): %', r.order_number, r.eff_date::date, r.detail;
  END LOOP;
  SELECT count(*), COALESCE(SUM(units), 0) INTO v_o_orders, v_o_units FROM _ss_absorb WHERE knob = c_other_knob;
  RAISE NOTICE '20260921000001 E2: % order(s) / % unit(s) / % pair(s) absorbed by cycle count under knob % (knob % would have absorbed % order(s) / % unit(s))',
    v_orders, v_units, v_apairs, c_min_reset_abs_delta, c_other_knob, v_o_orders, v_o_units;

  ---------------------------------------------------------------
  -- E3. ledger rebase for pairs the ledger holds MORE of than the rule
  --     allows (lines for live orders; nothing for cancelled orders).
  --     Metadata only: stock is untouched, the SKU-level correction
  --     script settles the units. Idempotent: rebase rows count in
  --     `already`, so a second run finds nothing.
  ---------------------------------------------------------------
  FOR r IN
    SELECT g.order_id, g.sku_id, g.already, ps.sku, o.order_number, o.order_status,
           COALESCE(t.target, 0) AS target,
           CASE WHEN o.order_status = 'cancelled' THEN 0 ELSE COALESCE(t.target, 0) END AS should
      FROM _ss_ledger g
      JOIN public.shipstation_orders o ON o.id = g.order_id
      JOIN public.product_skus ps ON ps.id = g.sku_id
      LEFT JOIN _ss_target t ON t.order_id = g.order_id AND t.sku_id = g.sku_id
     WHERE g.already > CASE WHEN o.order_status = 'cancelled' THEN 0 ELSE COALESCE(t.target, 0) END
     ORDER BY o.order_number, ps.sku
  LOOP
    INSERT INTO public.inventory_transactions (
      sku_id, transaction_type, quantity, field_affected,
      movement_kind, reference_id, reference_type, notes, performed_by
    ) VALUES (
      r.sku_id, 'shipstation_ledger_rebase', r.already - r.should, 'warehouse_finished',
      'metadata', r.order_id, 'shipstation_order',
      format('%s: ShipStation order %s ledger rebase +%s (bookkeeping only, stock unchanged). %s The ledger had deducted %s; %s After this row the pair nets %s, so rpc_apply_shipstation_sale neither re-deducts nor credits them.',
             r.sku, r.order_number, r.already - r.should,
             CASE WHEN r.order_status = 'cancelled'
                  THEN 'The order is cancelled and owes nothing.'
                  ELSE format('The order currently lists %s.', r.target) END,
             r.already,
             CASE WHEN r.order_status = 'cancelled'
                  THEN format('those %s unit(s) are returned by the separate SKU-level shipstation_overdeduct_correction unless a cycle count already absorbed them.', r.already - r.should)
                  ELSE format('the %s excess unit(s) came from the pre-2026-09-21 retry bug and are settled by the separate SKU-level shipstation_overdeduct_correction (or were already absorbed by a cycle count).', r.already - r.should) END,
             r.should),
      c_actor
    );
    v_pairs  := v_pairs + 1;
    v_runits := v_runits + (r.already - r.should);

    -- A cancelled order rebased to 0 must not keep a stale stamp: if
    -- ShipStation restores and ships it, the normal gate re-applies it
    -- (already = 0 -> deducts exactly its lines). The reconcile skips
    -- cancelled orders, so the un-stamp causes no churn.
    IF r.order_status = 'cancelled' THEN
      UPDATE public.shipstation_orders
         SET inventory_applied_at  = NULL,
             inventory_apply_error = 'cancelled; ledger rebased to 0 by migration 20260921000001 — re-applies if restored and shipped'
       WHERE id = r.order_id AND inventory_applied_at IS NOT NULL;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_unstamp := v_unstamp + v_n;
    END IF;
  END LOOP;
  RAISE NOTICE '20260921000001 E3: % pair(s) / % unit(s) rebased (metadata, no stock change); % cancelled order(s) un-stamped', v_pairs, v_runits, v_unstamp;
END
$mig$;
